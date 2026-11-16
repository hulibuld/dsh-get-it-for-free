/**
 * Qoder 账号层：多账号 PAT 保险库 + 来源合并 + 联网验证。
 *
 * 这一层只做账号，不做推理：
 *   - 不做 cosy 签名（聊天 / 模型目录要走 `gateway.*`，必须签名会话，见 docs-merge/qoder.md F2）
 *   - 不做每日签到（那一层要 jt- 令牌，属另一个模块）
 *
 * 装配层要「能真的发请求的 PAT」时，直接 import 本文件的 `./store.js`
 * 用 `resolveAccounts()`：它对同一个 id 给出明文 `pat`。`createQoder()` 返回的
 * 面子 API 一律打码——面板、日志、报错里都不该出现完整令牌。
 *
 * @module src/qoder/index.js
 */

import {
  REGION_IDS,
  REGIONS,
  SOURCE_ORDER,
  isQoderAccountId,
  maskPat,
  qoderAccountId,
  readVault,
  requireRegion,
  resolveAccounts,
  resolveDshHome,
  writeVault,
} from './store.js'

// 装配层要明文 PAT 时从这里取（`resolveAccounts` 对同 id 只给一条）；
// 面子 API 只给打码值。
export { REGIONS, REGION_IDS, maskPat, qoderAccountId, resolveAccounts } from './store.js'

/**
 * PAT → jobToken。上游（qoder2api 的 `qoder_auth.py`）用的是
 * `auth_base + '/algo/api/v3/user/jobToken?Encode=1'`，请求体要 cosy 编码并签名。
 */
const JOB_TOKEN_PATH = '/algo/api/v3/user/jobToken?Encode=1'

/**
 * 「这张 PAT 有没有效」的判定端点。
 *
 * 为什么不拿 sash 系列（`/sash/api/v2/me/usage`）当判据：实测一张完全正常的
 * PAT 直连只回 401 `TOKEN_EXPIRE`，它拒绝的是「PAT 直连」而不是这张令牌
 * （docs-merge/qoder.md F4）。拿它当判据会把好令牌判成坏令牌。
 * `cloud/agents` 是实测会为有效令牌回 200 的那一个。
 */
const PROBE_PATH = '/api/v1/cloud/agents'

const VERIFY_TIMEOUT_MS = 15_000
const SNIPPET_LENGTH = 180

/**
 * 清洗 PAT 入参。
 *
 * @param {unknown} pat
 * @returns {string}
 */
function normalizePat(pat) {
  const token = typeof pat === 'string' ? pat.trim() : ''
  if (token === '') {
    throw Object.assign(new Error('PAT 不能为空：Qoder 个人访问令牌以 pt- 开头'), { code: 'PAT_REQUIRED' })
  }
  if (token.length > 512) {
    throw Object.assign(new Error('PAT 过长（超过 512 字符），看起来不是一张令牌'), { code: 'PAT_INVALID' })
  }
  if (/[^\x21-\x7e]/.test(token)) {
    throw Object.assign(new Error('PAT 里混进了空白或不可见字符，重新复制一遍再试'), { code: 'PAT_INVALID' })
  }
  return token
}

/**
 * @param {string} text
 * @returns {string}
 */
function snippet(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat
}

/**
 * 从一次响应里找 jobToken。
 *
 * 只是「万一上游认了裸请求」的兜底读取：真换到就以它为准，换不到绝不编一个。
 *
 * @param {string} text
 * @returns {string}
 */
function readJobToken(text) {
  const raw = String(text ?? '')
  for (const key of ['securityOauthToken', 'jobToken', 'jwtToken']) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{8,})"`).exec(raw)
    if (match !== null) return match[1]
  }
  const loose = /\bjt-[A-Za-z0-9._-]{8,}/.exec(raw)
  return loose === null ? '' : loose[0]
}

/**
 * 记录一次网络探测的结果，失败也返回而不是抛：`verify()` 的职责是把上游
 * 的原话带回来，调用方不该为了「网络不通」再去 catch 一种异常。
 *
 * @param {string} step
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {RequestInit} init
 */
async function probe(step, url, fetchImpl, init) {
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout ? AbortSignal.timeout(VERIFY_TIMEOUT_MS) : undefined,
    })
    const text = await response.text().catch(() => '')
    return {
      step,
      url,
      status: response.status,
      ok: response.ok === true,
      ms: Date.now() - startedAt,
      message: snippet(text),
      text,
    }
  } catch (error) {
    return {
      step,
      url,
      status: 0,
      ok: false,
      ms: Date.now() - startedAt,
      message: snippet(/** @type {{message?: unknown}} */ (error)?.message ?? error),
      text: '',
    }
  }
}

/**
 * 创建 Qoder 账号层。
 *
 * @param {object} [options]
 * @param {string} [options.home] - DSH home；缺省 `$DSH_HOME` 或 `~/.dsh`
 * @param {{warn?: (message: string) => void, info?: (message: string) => void}} [options.logger]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {unknown} [options.settings] - 设置卡片里的 PAT 字段（对象或取配置的函数），优先级最高
 * @param {typeof fetch} [options.fetch] - 测试注入用，缺省全局 fetch
 */
export function createQoder({ home, logger, env = process.env, settings, fetch: injectedFetch } = {}) {
  const dir = typeof home === 'string' && home.trim() !== '' ? home.trim() : resolveDshHome(env)
  // 显式传进来的 fetch 优先（测试注入）；`undefined` 才回落到全局那个。
  // 传 null / 别的类型视为「调用方说错了」，直接报错而不是偷偷用全局的。
  const fetchImpl = injectedFetch === undefined ? globalThis.fetch : injectedFetch
  const log = {
    warn: message => logger?.warn?.(`[qoder] ${message}`),
    info: message => logger?.info?.(`[qoder] ${message}`),
  }

  if (typeof fetchImpl !== 'function') {
    // 没有 fetch 就没法验证；明确说出来，而不是等第一次 add() 才炸在别处
    throw Object.assign(new Error('当前运行环境没有 fetch，Qoder 账号无法联网验证'), { code: 'NO_FETCH' })
  }

  /**
   * 尝试 PAT → jobToken 交换。
   *
   * 本模块不做 cosy 签名，所以这次请求注定会被网关拒绝（`Signature invalid`
   * 一类）。仍然发它，是因为「网关怎么拒绝的」本身就是有用的事实：
   * 报告里能写清「jobToken 没换到，因为它要签名」，而不是含糊地说验证过了。
   *
   * @param {'cn'|'global'} region
   * @param {string} pat
   */
  async function exchangeJobToken(region, pat) {
    const base = REGIONS[region].authBase
    const body = JSON.stringify({
      personalToken: pat,
      securityOauthToken: '',
      refreshToken: '',
      needRefresh: false,
      authInfo: {},
    })
    const result = await probe('jobToken', `${base}${JOB_TOKEN_PATH}`, fetchImpl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Qoder' },
      body,
    })
    const token = result.ok ? readJobToken(result.text) : ''
    return {
      ...result,
      token,
      note: token !== '' ? 'PAT 已换到 jobToken' : '没有换到 jobToken（该端点要求 cosy 签名）',
    }
  }

  /**
   * 用 Bearer PAT 打一次真实接口，拿 HTTP 状态说话。
   *
   * @param {'cn'|'global'} region
   * @param {string} pat
   */
  async function probeBearer(region, pat) {
    const url = `${REGIONS[region].apiBase}${PROBE_PATH}`
    return probe('bearer', url, fetchImpl, {
      method: 'GET',
      headers: { authorization: `Bearer ${pat}`, accept: 'application/json', 'user-agent': 'Qoder' },
    })
  }

  /**
   * 一行对外展示的账号（PAT 已打码）。
   *
   * @param {{id: string, region: 'cn'|'global', pat: string, label: string, addedAt: number, source: string, sources: string[]}} account
   */
  function publicRow(account) {
    return {
      id: account.id,
      region: account.region,
      label: account.label,
      pat: maskPat(account.pat),
      addedAt: account.addedAt,
      source: account.source,
      sources: [...account.sources],
    }
  }

  /**
   * 三路来源合并后的账号表（打码）。
   *
   * @param {'cn'|'global'|undefined} region
   */
  async function listRows(region) {
    const regions = region === undefined ? REGION_IDS : [requireRegion(region)]
    const accounts = []
    const byRegion = {}
    for (const id of regions) {
      const resolved = await resolveAccounts({ home: dir, env, settings, region: id })
      byRegion[id] = resolved.accounts.length
      for (const account of resolved.accounts) accounts.push(publicRow(account))
    }
    return { accounts, byRegion }
  }

  /**
   * 列出账号（跨区域，或只看一个区域）。
   *
   * @param {{region?: 'cn'|'global'}} [options]
   */
  async function list({ region } = {}) {
    const { accounts, byRegion } = await listRows(region)
    return { home: dir, count: accounts.length, byRegion, accounts }
  }

  /**
   * 验证一张 PAT：先试 jobToken 交换，换不到就退化为 Bearer 探测，如实报告。
   *
   * `ok` 只在「确实拿到 jobToken」或「确实拿到 200」时为真。401/403 判无效；
   * 网络不通、5xx、404 一律 `PAT_UNVERIFIED` —— 不知道就是不知道。
   *
   * @param {{pat?: string, region?: 'cn'|'global'}} [input]
   */
  async function verify({ pat, region } = {}) {
    const target = requireRegion(region)
    const token = normalizePat(pat)
    const masked = maskPat(token)
    /** @type {object[]} */
    const steps = []

    const exchange = await exchangeJobToken(target, token)
    steps.push({
      step: exchange.step,
      url: exchange.url,
      status: exchange.status,
      ok: exchange.ok,
      ms: exchange.ms,
      message: exchange.message,
      note: exchange.note,
    })
    if (exchange.token !== '') {
      return {
        ok: true,
        verified: true,
        region: target,
        pat: masked,
        method: 'jobToken',
        code: 'OK',
        status: exchange.status,
        message: 'PAT 已换到 jobToken，令牌有效',
        steps,
      }
    }

    const bearer = await probeBearer(target, token)
    steps.push({
      step: bearer.step,
      url: bearer.url,
      status: bearer.status,
      ok: bearer.ok,
      ms: bearer.ms,
      message: bearer.message,
    })

    if (bearer.status >= 200 && bearer.status < 300) {
      return {
        ok: true,
        verified: true,
        region: target,
        pat: masked,
        method: 'bearer-probe',
        code: 'OK',
        status: bearer.status,
        message: `jobToken 没换到（端点要 cosy 签名），但 PAT 直连 ${PROBE_PATH} 回 200：令牌有效`,
        steps,
      }
    }
    if (bearer.status === 401 || bearer.status === 403) {
      return {
        ok: false,
        verified: false,
        region: target,
        pat: masked,
        method: 'bearer-probe',
        code: 'PAT_INVALID',
        status: bearer.status,
        message: `PAT 被上游拒绝（HTTP ${bearer.status}）：${bearer.message || '无正文'}`,
        steps,
      }
    }
    if (bearer.status === 0) {
      return {
        ok: false,
        verified: false,
        region: target,
        pat: masked,
        method: 'bearer-probe',
        code: 'NETWORK',
        status: 0,
        message: `连不上 ${REGIONS[target].apiBase}：${bearer.message || '无错误信息'}（这张 PAT 有效与否未判定）`,
        steps,
      }
    }
    return {
      ok: false,
      verified: false,
      region: target,
      pat: masked,
      method: 'bearer-probe',
      code: 'PAT_UNVERIFIED',
      status: bearer.status,
      message: `上游回 HTTP ${bearer.status}，既不是 200 也不是 401/403，无法判定这张 PAT：${bearer.message || '无正文'}`,
      steps,
    }
  }

  /**
   * 加一个账号：先联网验证，通过了才落盘。
   *
   * 验证失败一律抛错、且一个字节都不写 —— 存进去的每一张 PAT 都必须是
   * 「刚刚被上游认过」的那一张，否则面板会长期显示一个永远失败的账号。
   *
   * @param {{pat?: string, region?: 'cn'|'global', label?: string}} [input]
   */
  async function add({ pat, region, label } = {}) {
    const target = requireRegion(region)
    const token = normalizePat(pat)
    const accountId = qoderAccountId(token)
    if (!token.startsWith('pt-')) log.warn(`PAT 不以 pt- 开头（${maskPat(token)}），仍按令牌去验证`)

    const verification = await verify({ pat: token, region: target })
    if (!verification.ok) {
      throw Object.assign(new Error(verification.message), {
        code: verification.code,
        region: target,
        status: verification.status,
        verification,
      })
    }

    const vault = await readVault(dir, target)
    const existing = vault.accounts.find(row => row.id === accountId)
    const trimmedLabel = typeof label === 'string' ? label.trim().slice(0, 64) : ''
    const saved = {
      id: accountId,
      // 上游能给的显示名要等 jobToken 交换，本模块拿不到，所以 label 允许为空
      label: trimmedLabel !== '' ? trimmedLabel : (existing?.label ?? ''),
      pat: token,
      addedAt: existing?.addedAt || Date.now(),
    }
    const next = await writeVault(dir, target, [...vault.accounts.filter(row => row.id !== accountId), saved])
    log.info(`${existing ? '更新' : '新增'} Qoder ${target} 账号 ${accountId}（${maskPat(token)}）`)

    return {
      added: existing === undefined,
      region: target,
      account: publicRow({ ...saved, region: target, source: 'vault', sources: ['vault'] }),
      count: next.accounts.length,
      verification,
    }
  }

  /**
   * 删一个账号。
   *
   * `region` 可省：省略时两个区域都查（面板上点了「删」，不该因为不知道
   * 它在哪个区域而删不掉）。`id` 也接受直接给 PAT，统一折算成派生 id。
   *
   * @param {string} id
   * @param {'cn'|'global'} [region]
   */
  async function remove(id, region) {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') throw Object.assign(new Error('要删的账号 id 不能为空'), { code: 'ID_REQUIRED' })
    const accountId = isQoderAccountId(key) ? key : qoderAccountId(key)
    const regions = region === undefined ? REGION_IDS : [requireRegion(region)]

    const touched = {}
    for (const target of regions) {
      const vault = await readVault(dir, target)
      const kept = vault.accounts.filter(row => row.id !== accountId)
      if (kept.length === vault.accounts.length) {
        touched[target] = { removed: false, count: vault.accounts.length }
        continue
      }
      const next = await writeVault(dir, target, kept)
      touched[target] = { removed: true, count: next.accounts.length }
      log.info(`删除 Qoder ${target} 账号 ${accountId}`)
    }

    return {
      id: accountId,
      removed: Object.values(touched).some(row => row.removed === true),
      regions: touched,
      count: (await listRows()).accounts.length,
    }
  }

  /**
   * 每个区域有多少个账号、分别从哪儿来。
   *
   * `sources` 是「去重后由某个来源作为 primary 的账号数」；`present` 给出
   * 哪些来源在这个区域里出现过（真实来源可能同时命中两个，见 `list()` 的
   * 每账号 `sources`）。面板上「保险库 2 / 环境变量 1 / 设置 0」就是这张表。
   */
  async function status() {
    const regions = {}
    for (const target of REGION_IDS) {
      const resolved = await resolveAccounts({ home: dir, env, settings, region: target })
      const sources = { settings: 0, env: 0, vault: 0 }
      const present = new Set()
      for (const account of resolved.accounts) {
        sources[account.source] += 1
        for (const source of account.sources) present.add(source)
      }
      regions[target] = {
        count: resolved.accounts.length,
        sources,
        present: SOURCE_ORDER.filter(source => present.has(source)),
        envVar: REGIONS[target].envName,
        vault: resolved.file,
        damaged: resolved.damaged === true,
        vaultError: resolved.damaged === true ? resolved.error : '',
      }
    }
    return { home: dir, regions }
  }

  return { list, add, remove, verify, status }
}
