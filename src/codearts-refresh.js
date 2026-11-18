/**
 * CodeArts（华为云）STS 令牌续期。
 *
 * 为什么插件要自己干这件事：渠道包只在 **401** 时触发续期，而华为这里
 * 令牌过期返回的是 `400 + APIG.0602 "the security token has expired"`，
 * 于是凭据一过 expires_at 就再没有人去换，面板上账号还显示"已启用"，
 * 但每次调用模型都"操作失败"。这里按 expires_at 提前续，堵住那个空窗。
 *
 * 协议与渠道包 `vendor/channel-pack/pack.js` 内 oauth.ts 完全一致：
 *   POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 *   DPoP: ES256 JWS（payload 里 htm/htu/iat/jti，header 带公钥 JWK）
 *   body: client_id=codearts-agent & code_verifier & grant_type=refresh_token & refresh_token
 * 华为 STS 每签发一次，旧的 refresh_token 立刻作废，所以同一份凭据
 * 不能并发续期 —— 本模块用 ref 级串行队列保证这一点。
 */

import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto'

const STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const CLIENT_ID = 'codearts-agent'
const GRANT_REFRESH_TOKEN = 'refresh_token'
const TIMEOUT_MS = 20000
/** 提前 30 分钟续，别等真的过期再动手。 */
export const EARLY_MS = 30 * 60 * 1000

const b64url = value => Buffer.from(value).toString('base64url')

/** node 的 ECDSA 签名是 DER，JWS 要 R||S 定长拼接。 */
function derToJose(der, size = 32) {
  let off = 0
  if (der[off++] !== 0x30) throw new Error('bad DER signature')
  if (der[off] & 0x80) off += 1 + (der[off] & 0x7f)
  else off += 1
  const readInt = () => {
    if (der[off++] !== 0x02) throw new Error('bad DER int')
    let length = der[off++]
    let start = off
    if (length & 0x80) {
      const count = length & 0x7f
      length = 0
      for (let i = 0; i < count; i++) length = (length << 8) | der[off++]
      start = off
    }
    let end = start + length
    while (end - start > size) start++
    const out = Buffer.alloc(size)
    der.copy(out, size - (end - start), start, end)
    off = end
    return out
  }
  const r = readInt()
  const s = readInt()
  return Buffer.concat([r, s])
}

/** 生成 DPoP 证明（ES256）。 */
export function signDpop(jwk, htm, htu) {
  const key = createPrivateKey({ key: jwk, format: 'jwk' })
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
  const payload = { htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomBytes(32).toString('hex') }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const der = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'der' })
  return `${signingInput}.${b64url(derToJose(der))}`
}

export function hasRefreshMaterial(credential) {
  return Boolean(credential?.refresh_token && credential?.code_verifier && credential?.dpop_private_key_jwk)
}

/** 距过期还有多少毫秒；没有 expires_at 时返回 null。 */
export function msUntilExpiry(credential, now = Date.now()) {
  const parsed = credential?.expires_at ? Date.parse(credential.expires_at) : Number.NaN
  return Number.isFinite(parsed) ? parsed - now : null
}

export function needsRefresh(credential, { now = Date.now(), earlyMs = EARLY_MS } = {}) {
  if (!hasRefreshMaterial(credential)) return false
  const left = msUntilExpiry(credential, now)
  // 没有 expires_at 的凭据按需续：宁愿多换一次，也别让它静悄悄过期。
  if (left === null) return true
  return left <= earlyMs
}

/**
 * 拿一份新凭据。失败时抛错，`error.terminal === true` 表示
 * refresh_token 本身没了（只能重新登录），非终态失败下一轮还能再试。
 */
export async function refreshCredential(credential, { fetchImpl = fetch } = {}) {
  const dpop = signDpop(credential.dpop_private_key_jwk, 'POST', STS_TOKEN_ENDPOINT)
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code_verifier: credential.code_verifier,
    grant_type: GRANT_REFRESH_TOKEN,
    refresh_token: credential.refresh_token,
  }).toString()
  let response
  try {
    response = await fetchImpl(STS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { DPoP: dpop, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const wrapped = new Error(`network: ${String(error?.message ?? error)}`)
    wrapped.terminal = false
    throw wrapped
  }
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || !data?.credentials) {
    const error = new Error(`STS ${response.status}${data ? ` ${JSON.stringify(data)}` : ''}`)
    const code = String(data?.error_code ?? '')
    // 华为把"这份 refresh_token 已经被用过/已失效"回成 STS5.1806 / invalid_grant，
    // 两种都意味着这条账号只能重新登录。
    error.terminal = data?.error === 'invalid_grant'
      || /ExpiredRefreshToken/.test(code)
      || /STS5\.1806|has been used|invalid refresh token/i.test(String(data?.error_msg ?? ''))
    throw error
  }
  return {
    access_key_id: data.credentials.access_key_id ?? '',
    secret_access_key: data.credentials.secret_access_key ?? '',
    security_token: data.credentials.security_token ?? '',
    expires_at: data.credentials.expiration ?? '',
    refresh_token: data.refresh_token,
    code_verifier: credential.code_verifier,
    dpop_private_key_jwk: credential.dpop_private_key_jwk,
  }
}

/** 两份凭据是不是同一代令牌（refresh_token + security_token 都没变就是同一代）。 */
function isSameCredential(a, b) {
  return a?.refresh_token === b?.refresh_token && a?.security_token === b?.security_token
}

/**
 * 判终态之前先重读凭据。
 *
 * 华为 STS 每签发一次，旧 refresh_token 立刻作废。而同一个华为身份在本机可能
 * 同时被三处续期：渠道包内部（401 自续）、另一个 dsh 进程、以及本模块。谁先换成
 * 谁赢，输的那一方手里就是 `STS5.1806 "the refresh token has been used"` ——
 * 这**不代表账号死了**，只代表我们手里这份是旧的。盘上的值要是已经换了代，
 * 直接采纳新值，别把还活着的账号判成「需要重新登录」。
 *
 * 返回轮换后的凭据；盘上没变（确实是死令牌）或读不出来时返回 null。
 */
async function adoptRotatedCredential({ credential, ref, read }) {
  let latest
  try {
    const resolved = await read(ref)
    if (!resolved?.value) return null
    latest = JSON.parse(resolved.value)
  } catch {
    return null
  }
  if (isSameCredential(latest, credential)) return null
  return latest
}

/**
 * 一次性扫描所有 codearts 账号。
 *
 * @param {object} options
 * @param {(ref: string) => Promise<{value?: string} | undefined>} options.read  读凭据
 * @param {(ref: string, value: string) => Promise<void>} options.write           写凭据
 * @param {() => Promise<Array<{ id: string, credentialRef: string, nickname?: string }>>} options.accounts
 * @param {(line: string) => void} [options.log]
 * @param {boolean} [options.force]        不管是否快过期都换
 * @param {number} [options.now]
 */
export async function sweepCodeArts({ read, write, accounts, log, force = false, fetchImpl = fetch, now = Date.now() }) {
  const rows = await accounts()
  const result = { at: new Date(now).toISOString(), checked: 0, refreshed: 0, skipped: 0, failed: 0, accounts: [] }
  // ref 级串行：华为每签发一次旧 refresh_token 立刻作废，
  // 同一个 ref 并发续期必然是一成一败。
  const chains = new Map()
  for (const row of rows) {
    if (typeof row?.credentialRef !== 'string' || row.credentialRef === '') continue
    const previous = chains.get(row.credentialRef) ?? Promise.resolve()
    const current = previous.then(async () => {
      const entry = { id: row.id, ref: row.credentialRef, action: 'skipped' }
      result.checked++
      let credential
      try {
        const resolved = await read(row.credentialRef)
        if (!resolved?.value) {
          entry.action = 'missing'
          result.skipped++
          result.accounts.push(entry)
          return
        }
        credential = JSON.parse(resolved.value)
      } catch (error) {
        entry.action = 'unreadable'
        entry.error = String(error?.message ?? error).slice(0, 200)
        result.failed++
        result.accounts.push(entry)
        return
      }
      entry.expiresAt = credential?.expires_at ?? null
      const left = msUntilExpiry(credential, now)
      entry.minutesLeft = left === null ? null : Math.round(left / 60000)
      if (!hasRefreshMaterial(credential)) {
        entry.action = 'no-refresh-material'
        result.skipped++
        result.accounts.push(entry)
        return
      }
      if (!force && !needsRefresh(credential, { now })) {
        entry.action = 'fresh'
        result.skipped++
        result.accounts.push(entry)
        return
      }
      try {
        const next = await refreshCredential(credential, { fetchImpl })
        await write(row.credentialRef, JSON.stringify(next))
        entry.action = 'refreshed'
        entry.newExpiresAt = next.expires_at
        result.refreshed++
      } catch (error) {
        // 终态失败（令牌已被别处作废）先重读一次：他处续期成功就采纳，不再判死。
        const rotated = error?.terminal
          ? await adoptRotatedCredential({ credential, ref: row.credentialRef, read })
          : null
        if (rotated !== null) {
          entry.action = 'refreshed-externally'
          entry.newExpiresAt = rotated.expires_at ?? null
          result.refreshed++
        } else {
          entry.action = 'failed'
          entry.error = String(error?.message ?? error).slice(0, 300)
          entry.terminal = Boolean(error?.terminal)
          entry.needsRelogin = Boolean(error?.terminal)
          result.failed++
        }
      }
      result.accounts.push(entry)
    })
    chains.set(row.credentialRef, current)
  }
  await Promise.all(chains.values())
  for (const entry of result.accounts) {
    if (entry.action === 'failed') {
      log?.(`codearts ${entry.id}: 续期失败${entry.terminal ? '（refresh_token 已失效，需要重新登录）' : ''} — ${entry.error}`)
    } else if (entry.action === 'refreshed') {
      log?.(`codearts ${entry.id}: 已续期至 ${entry.newExpiresAt}`)
    } else if (entry.action === 'refreshed-externally') {
      log?.(`codearts ${entry.id}: 令牌已由他处续期，采纳新值（至 ${entry.newExpiresAt}）`)
    }
  }
  return result
}
