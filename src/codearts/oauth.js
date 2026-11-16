/**
 * 华为云 CodeArts 内置 OAuth2（PKCE + DPoP）登录。
 *
 * 这条路不读本机任何已有登录态：起一个 127.0.0.1 上的环回 server，把授权页交给
 * 宿主打开的浏览器，华为带着 code 回到这个 server，我们用 code + verifier 去 STS
 * 换一对临时 AK/SK 和一个 security_token。换来的东西才是后面签名调用的凭据。
 *
 * 三个容易抄错的点，改了就会「偶尔登录不上」：
 *   1. 授权 URL 里 `code_challenge_method` 是字面量 'SHA-256'，不是规范的 'S256'。
 *      华为的授权页按这个字面量分支，换成 S256 它就不认。PKCE 摘要算法两处都是 SHA-256。
 *   2. DPoP 私钥每次登录新生成、随账号落盘，续期必须复用同一把。
 *   3. 端口每次由内核分配（listen 0），授权 URL 与 redirect_uri 里的 port 是同一个值，
 *      所以 start() 必须先 listen 再拼 URL。
 *
 * 错误处理口径：start() 允许抛（端口都绑不上时根本没有可展示的登录页），
 * 其余一切网络/解析失败都收敛进 status() 的 `{ state: 'error', error }`，
 * 不让一个后台 Promise 把宿主拖进 unhandledRejection。getToken() 是同步取凭据的
 * 调用点，拿不到就必须抛——它抛的是已经归类过的错误（带 code），不是原始网络异常。
 *
 * @module src/codearts/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { isDPoPPrivateJWK, newDPoPPrivateJWK, publicJwkOf, signDpopProof } from './dpop.js'
import { readAccounts, resolveHome, writeAccounts } from './store.js'

/** 华为给 CodeArts Agent 这个客户端定的 id；授权页靠它判断回跳协议。 */
export const CLIENT_ID = 'codearts-agent'
export const PLUGIN_NAME = 'snap_AIIDE'
export const PLUGIN_VERSION = '5.2.0'

/** 授权入口（portal）与 token 端点（STS）。两者域名不同，别拼成一个。 */
export const PORTAL_BASE = 'https://codearts.huaweicloud.com/portal'
export const STS_BASE = 'https://sts.cn-north-4.myhuaweicloud.com'

/** 回跳路径：环回 server 只认这一个路径，其它一律 404。 */
export const REDIRECT_PATH = '/oauth/callback'

/**
 * 授权页要求的算法字面量。
 *
 * 不是 'S256'。上游 dsh-codearts 的 pkce() 返回的 method 是 'S256'，但拼 URL 时
 * 用的是这个硬编码字面量——两个值不一致是华为那边的现状，抄的时候别「修正」。
 */
export const CODE_CHALLENGE_METHOD = 'SHA-256'

/** 等回调的上限。超过就当这次登录失败，免得环回 server 一直挂着。 */
const CALLBACK_TIMEOUT_MS = 5 * 60_000

/** 续期请求与换取请求的超时。STS 慢到这种程度基本等于失败。 */
const TOKEN_TIMEOUT_MS = 20_000

/** 提前多久算「快过期」：在 token 正好死在请求中途之前先续掉。 */
const EXPIRY_SKEW_MS = 60_000

const CALLBACK_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>CodeArts 登录</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .card{text-align:center;padding:32px 40px}
  h1{margin:0 0 8px;font-size:18px;font-weight:600}
  p{margin:0;color:#9aa3b2}
</style></head>
<body><div class="card"><h1>CodeArts 登录成功</h1><p id="hint">正在关闭本页…</p></div>
<script>
  setTimeout(function () { window.close() }, 300)
  setTimeout(function () {
    var el = document.getElementById('hint')
    if (el) el.textContent = 'CodeArts 登录成功，本页可关闭，请回到 DeepSeek。'
  }, 1200)
</script></body></html>`

/**
 * @param {number} bytes
 * @returns {string}
 */
function randomHex(bytes) {
  return randomBytes(bytes).toString('hex')
}

/**
 * PKCE：verifier 是 64 字节随机数（base64url 后 86 字符），challenge 是它的 SHA-256。
 *
 * @param {Uint8Array} [seed] - 仅测试注入；生产路径永远走随机
 * @returns {{verifier: string, challenge: string}}
 */
export function pkce(seed) {
  const verifier = Buffer.from(seed ?? randomBytes(64)).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  return { verifier, challenge }
}

/**
 * 拼授权页 URL。
 *
 * 参数名里的 `plugin-name` / `plugin-version` 带连字符，不能用对象字面量点号写，
 * 所以整张参数表交给 URLSearchParams 编码，避免手拼时漏编码。
 *
 * @param {{portal: string, port: number, challenge: string, ticketId: string}} options
 * @returns {string}
 */
export function buildAuthorizeUrl({ portal, port, challenge, ticketId }) {
  const params = new URLSearchParams({
    theme: '2',
    locale: 'zh-cn',
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(port),
    code_challenge: challenge,
    code_challenge_method: CODE_CHALLENGE_METHOD,
    ticket_id: ticketId,
    'plugin-name': PLUGIN_NAME,
    'plugin-version': PLUGIN_VERSION,
  })
  return `${portal}/authorize?${params.toString()}`
}

/**
 * 拼一个带 code 的错误对象：调用方要按 code 分支，而不是去 match 中文文案。
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {Error & {code: string}}
 */
function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra ?? {})
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return String(/** @type {{message?: unknown}} */ (error)?.message ?? error).slice(0, 240)
}

/**
 * 表单 POST。只用 node:http(s)，因为要显式禁 redirect、显式超时：
 * 一个 30x 会让 fetch 静默跟到别的主机，把 DPoP proof（绑定了 htu）发错地方。
 *
 * @param {{url: string, headers?: Record<string, string>, body: string, timeoutMs?: number}} options
 * @returns {Promise<{status: number, text: string}>}
 */
function postForm({ url, headers, body, timeoutMs = TOKEN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const payload = Buffer.from(body, 'utf8')
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': payload.length,
          ...(headers ?? {}),
        },
      },
      response => {
        /** @type {Buffer[]} */
        const chunks = []
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`STS 请求超时（${timeoutMs}ms）`)))
    request.on('error', reject)
    request.end(payload)
  })
}

/**
 * STS 的令牌响应。
 *
 * 两种大小写都吃：同一套 STS 在不同版本/不同网关上分别返回 camelCase 与 PascalCase
 * （credentials.access_key_id 与 credentials.AccessKeyID 都在线上见过），
 * 只认一种的表现是「同一个账号时好时坏」。
 *
 * @param {any} json
 * @param {{partial?: boolean}} [options] - partial 为真时不做「三件套齐全」校验（续期用）
 * @returns {{accessKeyId: string, secretAccessKey: string, securityToken: string, expiration: string, refreshToken: string, userId: string, userName: string, domainId: string}}
 */
export function parseTokenResponse(json, options = {}) {
  const credentials = json?.credentials ?? {}
  const pick = (...values) => {
    for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value.trim()
    return ''
  }
  const parsed = {
    accessKeyId: pick(credentials.access_key_id, credentials.AccessKeyID, credentials.accessKeyId),
    secretAccessKey: pick(credentials.secret_access_key, credentials.SecretAccessKey, credentials.secretAccessKey),
    securityToken: pick(credentials.security_token, credentials.SecurityToken, credentials.securityToken),
    expiration: pick(credentials.expiration, credentials.Expiration),
    // 身份与 refresh_token 到底落在 credentials 里还是响应顶层，线上两种都出现过；
    // 只认一层的话，续期会「成功」但把旧 refresh_token 原样写回去。
    refreshToken: pick(json?.refresh_token, json?.RefreshToken, json?.refreshToken,
      credentials.refresh_token, credentials.RefreshToken, credentials.refreshToken),
    userId: pick(json?.user_id, json?.UserId, json?.userId,
      credentials.user_id, credentials.UserId, credentials.userId),
    userName: pick(json?.user_name, json?.UserName, json?.userName,
      credentials.user_name, credentials.UserName, credentials.userName),
    domainId: pick(json?.domain_id, json?.DomainId, json?.domainId,
      credentials.domain_id, credentials.DomainId, credentials.domainId),
  }
  if (options.partial !== true && (parsed.accessKeyId === '' || parsed.secretAccessKey === '' || parsed.securityToken === '')) {
    // 少了三件套里的任何一件，这个账号既签不了名也发不了请求；留着只会让面板显示
    // 一个点不动的账号。宁可让这次登录失败并说清缺什么。
    //
    // 只有登录路径能这么严：续期时 STS 只回 security_token 也算成功，旧 AK/SK 仍然可用，
    // 这里硬抛会被上层包成 REFRESH_FAILED 并把账号误标 stale（等同逼用户重登）。
    const missing = [
      parsed.accessKeyId === '' ? 'access_key_id' : '',
      parsed.secretAccessKey === '' ? 'secret_access_key' : '',
      parsed.securityToken === '' ? 'security_token' : '',
    ].filter(Boolean)
    throw fail('TOKEN_SHAPE', `STS 响应缺少 ${missing.join(' / ')}`)
  }
  return parsed
}

/**
 * 过期判定。
 *
 * 没有 expiration 或解析不出来时：能续期就先续（`refreshToken !== ''`），
 * 不能续期就只能拿去用——此时报「已过期」也帮不上忙，用户唯一的选择是重新登录。
 *
 * @param {string} expiration
 * @param {string} refreshToken
 * @param {number} [now]
 * @returns {boolean}
 */
export function isExpired(expiration, refreshToken, now = Date.now()) {
  const at = Date.parse(String(expiration ?? ''))
  if (!Number.isFinite(at)) return String(refreshToken ?? '') !== ''
  return at - EXPIRY_SKEW_MS <= now
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '')
}

/**
 * 创建 OAuth 门面。返回值就是这一层的全部对外 API（不多不少），
 * 内部状态只通过 status() 暴露，避免面板去读私有字段。
 *
 * @param {{home?: string, logger?: {info?: Function, warn?: Function}, env?: Record<string, string|undefined>}} [options]
 */
export function createCodeArtsOAuth({ home, logger, env = process.env } = {}) {
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : resolveHome(env)
  // 端点可用环境变量覆盖：联调 STS 与本地回放测试都需要，生产路径不设置即走默认。
  const portal = trimSlash(env?.CODEARTS_PORTAL_URL) || PORTAL_BASE
  const stsBase = trimSlash(env?.CODEARTS_STS_URL) || STS_BASE
  const tokenUrl = `${stsBase}/v1/oauth2/tokens`

  /** @type {{state: 'idle'|'waiting'|'done'|'error', loginUrl: string, port: number, error: string, at: number, account: null|ReturnType<typeof summaryOf>}} */
  let state = { state: 'idle', loginUrl: '', port: 0, error: '', at: Date.now(), account: null }

  /** @type {null | {ticketId: string, port: number, loginUrl: string, verifier: string, dpopJwk: any, server: http.Server, timer: NodeJS.Timeout, settled: boolean}} */
  let session = null
  let disposed = false

  /** @type {Map<string, Promise<any>>} */
  const refreshing = new Map()

  /**
   * 账号摘要（status/list 的形状）。token 本体绝不出现在这里：
   * 面板只需要知道「有没有这个号、过没过期」，凭据只在 getToken() 出口。
   *
   * @param {any} account
   */
  function summaryOf(account) {
    return {
      id: String(account.userId ?? ''),
      userName: String(account.userName ?? ''),
      userId: String(account.userId ?? ''),
      domainId: String(account.domainId ?? ''),
      label: String(account.label ?? ''),
      expiration: String(account.expiration ?? ''),
      stale: account.stale === true,
      // 键不是上游 userId（用了临时/推导键）时为真：面板据此提示「可能重复」，
      // 而不是让用户以为凭空多出一个账号。
      staleHint: account.staleHint === true,
    }
  }

  /**
   * @param {'idle'|'waiting'|'done'|'error'} next
   * @param {Partial<{loginUrl: string, port: number, error: string, account: null|any}>} patch
   */
  function setState(next, patch = {}) {
    state = {
      state: next,
      loginUrl: patch.loginUrl ?? state.loginUrl,
      port: patch.port ?? state.port,
      error: patch.error ?? '',
      at: Date.now(),
      account: patch.account === undefined ? state.account : patch.account,
    }
  }

  function status() {
    return {
      state: state.state,
      loginUrl: state.loginUrl,
      port: state.port,
      error: state.error,
      at: state.at,
      account: state.account === null ? null : { ...state.account },
    }
  }

  /** 环回 server + 超时定时器一起收掉：任何一条出口（成功/失败/取消/超时）都走这里。 */
  function closeSession() {
    if (session === null) return
    const closing = session
    session = null
    clearTimeout(closing.timer)
    try {
      closing.server.close()
    } catch {}
  }

  /**
   * @param {string} body
   * @param {string} dpopProof
   * @returns {Promise<any>}
   */
  async function tokenCall(body, dpopProof) {
    const response = await postForm({
      url: tokenUrl,
      headers: { DPoP: dpopProof, 'plugin-name': PLUGIN_NAME, 'plugin-version': PLUGIN_VERSION },
      body,
    })
    if (response.status < 200 || response.status >= 300) {
      // 把 STS 的原文带出来：InvalidDPoPHeader / invalid_grant 这类判断只能从正文里看，
      // 只报状态码等于让用户去猜是「网络」还是「钥匙不对」。
      throw fail('STS_HTTP', `STS 返回 ${response.status}：${response.text.slice(0, 300)}`)
    }
    try {
      return JSON.parse(response.text)
    } catch {
      throw fail('STS_JSON', `STS 返回的不是 JSON：${response.text.slice(0, 200)}`)
    }
  }

  /** @type {Promise<unknown>} */
  let writeChain = Promise.resolve()

  /**
   * 写账号库的串行队列。
   *
   * 为什么需要：后台续期写回和一次新登录可能同时发生。read → 改 → write 三步交错时，
   * 后写的那份把「它读到的旧快照」整份覆盖回去，先写进去的账号就消失了
   * —— store 里的原子写只保证文件不半截，管不了这种跨调用丢更新。
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function mutate(task) {
    const run = writeChain.then(task)
    // 队列不能被一次失败卡死：错误交给调用方，链上留 resolved 继续排下一个。
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 落一条账号（登录与续期共用）。
   *
   * requireClean 为真时遇到读坏的文件直接拒绝：续期路径不能拿一份「读出来是空的」
   * 文档覆盖回去，否则同一个文件里另外几个账号会跟着没。
   *
   * @param {any} account
   * @param {{requireClean?: boolean}} [options]
   * @returns {Promise<void>}
   */
  function saveAccount(account, options = {}) {
    return mutate(async () => {
      const doc = await readAccounts(base)
      if (doc.damaged) {
        if (options.requireClean === true) throw fail('ACCOUNTS_DAMAGED', `账号库读不动，拒绝覆盖：${doc.error}`)
        // 登录路径相反：用户刚在浏览器里授权完，这时候报错等于让他白走一趟；
        // 坏文件本来也救不回来，重建比失败有意义。
        logger?.warn?.(`[codearts] 账号库读不动，按空库重建：${doc.error}`)
      }
      if (doc.skipped > 0) {
        // 残缺行本来不可用，不拦登录；但整份写回就等于把它们删了，得留一句。
        logger?.warn?.(`[codearts] 账号库有 ${doc.skipped} 行字段不全，本次写回会丢弃：${doc.file}`)
      }
      const accounts = { ...doc.accounts, [account.userId]: account }
      const order = doc.order.includes(account.userId) ? doc.order : [...doc.order, account.userId]
      await writeAccounts(base, { order, accounts })
    })
  }

  /**
   * 账号键。正常情况下就是上游 user_id；缺了才走兜底。
   *
   * 为什么不能再用 accessKeyId 兜底：STS 临时 AK 每次续期都换一把，
   * 拿它派生键的结果是「同一账号重新授权一次就多出一条记录」——面板里两个同名账号，
   * 旧的那条永远 stale，而用户根本没有第二个号。所以按稳定性排：
   *   1. user_id —— 唯一权威；
   *   2. refresh_token 指纹 —— 同一账号稳定，换号必变；
   *   3. code_verifier + 本次 DPoP 公钥的指纹 —— 只在这一次 flow 内稳定，跨登录会变，
   *      目的只是「别把两个不同账号硬撞到同一个键上」；
   *   4. 随机临时键 + staleHint：什么都没有时宁可留个能登录的账号，
   *      并在摘要里标记「键不稳定」，让面板提示用户可能重复，而不是伪造一个像 userId 的键。
   *
   * @param {ReturnType<typeof parseTokenResponse>} tokens
   * @param {any} dpopJwk
   * @param {{verifier?: string}} [context]
   */
  function accountKeyOf(tokens, dpopJwk, context = {}) {
    if (tokens.userId !== '') return { userId: tokens.userId, staleHint: false }
    const hash = value => createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16)
    if (tokens.refreshToken !== '') return { userId: `rt-${hash(tokens.refreshToken)}`, staleHint: false }
    const verifier = String(context.verifier ?? '')
    if (verifier !== '') {
      // 公钥而不是私钥参与指纹：私钥要落盘，指纹进键名，混在一起没必要。
      const jwk = publicJwkOf(dpopJwk)
      return { userId: `fp-${hash(`${verifier}|${jwk.x}|${jwk.y}`)}`, staleHint: false }
    }
    return { userId: `tmp-${randomHex(8)}`, staleHint: true }
  }

  /**
   * 把 token 响应落成一个账号，形状与 store.normalizeAccount 对齐。
   *
   * @param {ReturnType<typeof parseTokenResponse>} tokens
   * @param {any} dpopJwk
   * @param {{verifier?: string}} [context]
   */
  function accountFromTokens(tokens, dpopJwk, context = {}) {
    const { userId, staleHint } = accountKeyOf(tokens, dpopJwk, context)
    return {
      userId,
      userName: tokens.userName,
      domainId: tokens.domainId,
      label: tokens.userName || userId,
      token: tokens.securityToken,
      accessKeyId: tokens.accessKeyId,
      secretAccessKey: tokens.secretAccessKey,
      expiration: tokens.expiration,
      refreshToken: tokens.refreshToken,
      dpopPrivateKey: dpopJwk,
      clientId: CLIENT_ID,
      storedAt: Date.now(),
      stale: false,
      ...(staleHint ? { staleHint: true } : {}),
    }
  }

  /**
   * 用回调里的 code 换凭据并落库。失败只改 state，不往上抛。
   *
   * @param {string} code
   */
  async function completeLogin(code) {
    const current = session
    if (current === null) return
    try {
      const proof = signDpopProof(current.dpopJwk, tokenUrl)
      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        code_verifier: current.verifier,
        grant_type: 'authorization_code',
        redirect_uri: `http://127.0.0.1:${current.port}${REDIRECT_PATH}`,
      }).toString()
      const tokens = parseTokenResponse(await tokenCall(body, proof))
      const account = accountFromTokens(tokens, current.dpopJwk, { verifier: current.verifier })
      await saveAccount(account)
      // 端口已经关了，别再把手里的 URL 留在 state 里：面板可能拿它渲染「继续登录」，
      // 而那是个拒绝连接的地址。
      setState('done', { account: summaryOf(account), error: '', loginUrl: '', port: 0 })
      logger?.info?.(`[codearts] 登录完成，账号 ${account.userId}`)
    } catch (error) {
      setState('error', { error: messageOf(error) })
      logger?.warn?.(`[codearts] 登录失败：${messageOf(error)}`)
    } finally {
      closeSession()
    }
  }

  /**
   * 回调请求处理。GET 与 POST 两种都吃，因为华为的授权页在不同分支上分别用
   * 302（GET query）和表单 POST 送回 code。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  function onRequest(req, res) {
    const current = session
    const url = new URL(String(req.url ?? '/'), `http://127.0.0.1:${current?.port ?? 0}`)
    if (url.pathname !== REDIRECT_PATH || current === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }

    const finish = (code) => {
      if (current.settled) return
      if (code === '') {
        // 没有 code 多半是用户直接访问了这个路径；保持流程继续等真正的那次回调。
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('missing code')
        return
      }
      current.settled = true
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(CALLBACK_HTML)
      void completeLogin(code)
    }

    /**
     * 拿到 code / redirect 之后的统一出口。GET 与 POST 都走这里，
     * 否则两个分支的行为会慢慢漂移（上游是「有 redirect 没 code 就 307 透传」，
     * 只对 GET 做的话，POST 表单回跳的用户会停在 400 错误页）。
     *
     * @param {string} code
     * @param {string} redirect
     */
    const settle = (code, redirect) => {
      if (code === '' && redirect !== '') {
        // 授权页有时把错误/二次跳转交给我们透传；不跟过去，也不当成登录失败。
        res.writeHead(307, { Location: redirect }).end()
        return
      }
      finish(code)
    }

    if (req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => {
        body += chunk
        if (body.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        settle(form.get('code') ?? '', form.get('redirect') ?? '')
      })
      return
    }

    settle(url.searchParams.get('code') ?? '', url.searchParams.get('redirect') ?? '')
  }

  /**
   * 启动一次登录。返回时环回 server 已经在监听，所以 loginUrl 里的 port 是真的。
   *
   * 已经有一次在等回调时直接返回那一次：同时起两个 flow 会让两个 server 各自等
   * 同一个回调，后到的那次永远拿不到 code。
   */
  async function start() {
    if (disposed) throw fail('DISPOSED', 'OAuth 门面已释放，请重新创建')
    if (session !== null) return { loginUrl: session.loginUrl, port: session.port, ticketId: session.ticketId }

    const ticketId = randomHex(16)
    const { verifier, challenge } = pkce()
    const dpopJwk = newDPoPPrivateJWK()
    const server = http.createServer(onRequest)

    const port = await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('环回 server 没有拿到端口'))
          return
        }
        resolve(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })

    const loginUrl = buildAuthorizeUrl({ portal, port, challenge, ticketId })
    const timer = setTimeout(() => {
      // 超时不是「等等再看」：授权页已经被用户关掉或者浏览器把回跳吞了，
      // 留着 server 只会让下一次 start() 直接返回一个已死的 URL。
      if (session === null) return
      // 和 done/cancel 一致：server 马上就要 close，loginUrl 会指向一个死端口。
      setState('error', { error: '五分钟内没有收到授权回调，请重新发起登录', loginUrl: '', port: 0 })
      logger?.warn?.('[codearts] 等待授权回调超时')
      closeSession()
    }, CALLBACK_TIMEOUT_MS)
    timer.unref?.()

    session = { ticketId, port, loginUrl, verifier, dpopJwk, server, timer, settled: false }
    setState('waiting', { loginUrl, port, error: '', account: state.account })
    logger?.info?.(`[codearts] 等待浏览器授权：127.0.0.1:${port}${REDIRECT_PATH}`)
    return { loginUrl, port, ticketId }
  }

  /** 取消等待中的登录。已经完成的登录不受影响（账号已经落库了）。 */
  function cancel() {
    if (session === null) return status()
    // 端口已经关掉了，loginUrl 指向的地址不会再有人应答；留着它只会让面板
    // 把用户送去一个连不上的环回地址。
    setState('idle', { error: '', loginUrl: '', port: 0 })
    closeSession()
    return status()
  }

  /**
   * 账号列表。读坏了就返回空表并记一条日志：面板要能照常渲染，
   * 而不是因为一个坏 JSON 整个设置页白屏。
   *
   * @returns {Promise<ReturnType<typeof summaryOf>[]>}
   */
  async function list() {
    let doc
    try {
      doc = await readAccounts(base)
    } catch (error) {
      logger?.warn?.(`[codearts] 读账号库失败：${messageOf(error)}`)
      return []
    }
    if (doc.damaged) logger?.warn?.(`[codearts] 账号库损坏：${doc.error}`)
    const ids = [...doc.order, ...Object.keys(doc.accounts).filter(id => !doc.order.includes(id))]
    return ids.map(id => doc.accounts[id]).filter(Boolean).map(summaryOf)
  }

  /**
   * 删一个账号。返回是否真的删掉了：面板按这个值决定要不要提示「已经没有这个号了」。
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function remove(id) {
    const target = String(id ?? '')
    if (target === '') return false
    // 删除同样走串行队列：否则一次同时到达的续期写回会把刚删掉的账号写回来。
    const removed = await mutate(async () => {
      const doc = await readAccounts(base)
      if (doc.damaged) throw fail('ACCOUNTS_DAMAGED', `账号库读不动，拒绝覆盖：${doc.error}`)
      if (!Object.hasOwn(doc.accounts, target)) return false
      if (doc.skipped > 0) {
        // 删除也整份写回，残行一样会被带走；口径与 saveAccount 保持一致。
        logger?.warn?.(`[codearts] 账号库有 ${doc.skipped} 行字段不全，本次写回会丢弃：${doc.file}`)
      }
      const accounts = { ...doc.accounts }
      delete accounts[target]
      await writeAccounts(base, { order: doc.order.filter(value => value !== target), accounts })
      return true
    })
    if (!removed) return false
    if (state.account !== null && state.account.id === target) setState(state.state, { account: null })
    logger?.info?.(`[codearts] 已删除账号 ${target}`)
    return true
  }

  /**
   * 续期。refresh 请求必须带首次登录落盘的那把 DPoP 私钥——换了钥匙 STS 会回
   * InvalidDPoPHeader，所以这里在本地先拦一道，给出能看懂的原因。
   *
   * @param {any} account
   * @returns {Promise<any>} 续期后的账号（已落库）
   */
  async function refresh(account) {
    if (String(account.refreshToken ?? '') === '') {
      throw fail('NO_REFRESH_TOKEN', '这个账号没有 refresh_token，只能重新登录')
    }
    if (!isDPoPPrivateJWK(account.dpopPrivateKey)) {
      throw fail(
        'DPOP_KEY_MISSING',
        '缺少首次登录时落盘的 DPoP 私钥（dpopPrivateKey），STS 会回 InvalidDPoPHeader；只能重新登录',
      )
    }
    const proof = signDpopProof(account.dpopPrivateKey, tokenUrl)
    const body = new URLSearchParams({
      client_id: account.clientId || CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
    }).toString()

    let tokens
    try {
      // 宽松档：续期只要求「有东西可更新」。STS 换版或网关裁剪字段时只回
      // security_token 也算成功，旧 AK/SK 继续用——硬抛会变成 REFRESH_FAILED + stale，
      // 等于把一个还能用的账号判死，逼用户重走一遍浏览器授权。
      tokens = parseTokenResponse(await tokenCall(body, proof), { partial: true })
      if (tokens.securityToken === '' && tokens.accessKeyId === '' && tokens.expiration === '') {
        // 一个可更新字段都没有的 200 不能当成功：账号会停在过期状态，
        // 之后每次取 token 都要再打一次 STS。
        throw fail('TOKEN_SHAPE', 'STS 续期响应没有 security_token / access_key_id / expiration')
      }
    } catch (error) {
      // 续期失败要把 stale 写回文件：面板据此提示「重新登录」，
      // 而不是每次刷新都再打一次注定失败的 STS。
      await markStale(account).catch(() => {})
      throw fail('REFRESH_FAILED', messageOf(error), { cause: error })
    }

    const next = {
      ...account,
      token: tokens.securityToken || account.token,
      // AK/SK 缺就沿用旧值（旧值仍能签名），不能写成空串——那会让账号直接不可用。
      accessKeyId: tokens.accessKeyId || account.accessKeyId,
      secretAccessKey: tokens.secretAccessKey || account.secretAccessKey,
      expiration: tokens.expiration || account.expiration,
      // 有的 STS 刷新不返回新的 refresh_token；此时沿用旧的，而不是把账号弄成不可续期。
      refreshToken: tokens.refreshToken || account.refreshToken,
      userName: tokens.userName || account.userName,
      domainId: tokens.domainId || account.domainId,
      label: tokens.userName || account.label,
      storedAt: Date.now(),
      stale: false,
    }
    try {
      // requireClean：读到坏文件就放弃写回。续期路径宁可下次再试，
      // 也不能拿一份「读出来是空的」文档把同一个文件里别的账号抹掉。
      await saveAccount(next, { requireClean: true })
    } catch (error) {
      // 落库失败不能吞：下一次调用会拿旧 token 再续一次，而 STS 对同一 refresh_token
      // 的重复使用有窗口限制。这里的凭据仍然可用，所以先返回，但要让调用方看见。
      logger?.warn?.(`[codearts] 续期成功但落库失败：${messageOf(error)}`)
    }
    if (state.account !== null && state.account.id === next.userId) setState(state.state, { account: summaryOf(next) })
    return next
  }

  /**
   * @param {any} account
   */
  async function markStale(account) {
    // 内联读改写（不调 saveAccount）——它自己的队列里再排一次会自己等自己。
    await mutate(async () => {
      const doc = await readAccounts(base)
      if (doc.damaged || !Object.hasOwn(doc.accounts, account.userId)) return
      const accounts = {
        ...doc.accounts,
        [account.userId]: { ...doc.accounts[account.userId], stale: true },
      }
      await writeAccounts(base, { order: doc.order, accounts })
    })
    if (state.account !== null && state.account.id === account.userId) {
      setState(state.state, { account: { ...state.account, stale: true } })
    }
  }

  /**
   * 取一份能直接拿去签名的凭据；快过期时先续期。
   *
   * 抛出的错误都带 code：ACCOUNT_NOT_FOUND / NO_REFRESH_TOKEN / DPOP_KEY_MISSING /
   * REFRESH_FAILED / ACCOUNTS_DAMAGED。调用方按 code 决定是重登还是换号。
   *
   * @param {string} id - 账号 id（即上游 userId）
   * @returns {Promise<{accessKeyId: string, secretAccessKey: string, securityToken: string, expiration: string}>}
   */
  async function getToken(id) {
    const target = String(id ?? '')
    const doc = await readAccounts(base)
    if (doc.damaged) throw fail('ACCOUNTS_DAMAGED', `账号库读不动：${doc.error}`)
    const account = doc.accounts[target]
    if (account === undefined) throw fail('ACCOUNT_NOT_FOUND', `没有这个账号：${target}`)
    if (!isExpired(account.expiration, account.refreshToken)) {
      return {
        accessKeyId: account.accessKeyId,
        secretAccessKey: account.secretAccessKey,
        securityToken: account.token,
        expiration: account.expiration,
      }
    }

    // 同一个账号并发取 token 时共用一次续期：STS 对同一 refresh_token 的并行使用
    // 会让其中一个拿到 invalid_grant，而那个失败会被误判成「账号失效」。
    let pending = refreshing.get(target)
    if (pending === undefined) {
      pending = refresh(account).finally(() => refreshing.delete(target))
      refreshing.set(target, pending)
    }
    const next = await pending
    return {
      accessKeyId: next.accessKeyId,
      secretAccessKey: next.secretAccessKey,
      securityToken: next.token,
      expiration: next.expiration,
    }
  }

  /** 释放：关掉等待中的环回 server 与定时器。之后 start() 直接报错。 */
  function dispose() {
    disposed = true
    cancel()
    refreshing.clear()
  }

  return { start, status, cancel, list, remove, getToken, dispose }
}
