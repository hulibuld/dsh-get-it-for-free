/**
 * 秒悟网页（meoo.com）账号库：几份登录态并存的落盘形态。
 *
 * 以前 `~/.dsh/get-it-for-free/meoo-web.json` 只有一份 `{token, cookie}`，
 * 面板上永远只有一个账号、也没有「切换」这个动作。秒悟上游只认 cookie/token，
 * 不认「哪个账号」，所以想用几个就有几条：
 *
 *   { version: 2, accounts: [...], activeAccountId, updatedAt }
 *
 * 向后兼容：读到旧格式（没有 accounts 字段、但顶层有 cookie/token）时，把那份
 * 单份凭据接成第一条，顺手把 version 抬到 2 并落盘。抬过版本之后就不再回头看
 * 旧形状——否则用户把账号全删了，旧字段又会把上一个账号「复活」出来。
 *
 * 文件 0600，写盘走 tmp + rename，崩在中间不会留下半个 JSON。
 *
 * @module src/meoo-web/account-store.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveDshHome } from '../store.js'

/** 2 = 有 accounts；1（或没有 version）= 只有单份 cookie/token 的老文件。 */
export const STORE_VERSION = 2

/** 凭据来源的三档，和卡片上写的来源标签一一对应。 */
export const ACCOUNT_SOURCES = ['browser', 'user', 'cli']

/** 状态文件路径（沿用旧文件，靠 version 做迁移）。 */
export function storePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'meoo-web.json')
}

/** 新账号 id：短、可读、和用户自己起的名字无关。 */
export function mintAccountId() {
  return 'mw-' + crypto.randomBytes(4).toString('hex')
}

/** 昵称：显式字段 > 凭据里的用户名/手机/邮箱 > 兜底。 */
export function nicknameOf(row, fallback = '秒悟') {
  const direct = typeof row?.nickname === 'string' ? row.nickname.trim() : ''
  if (direct !== '') return direct.slice(0, 64)
  const user = row?.user ?? {}
  for (const candidate of [user.username, user.nickname, user.name, user.phone, user.email]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 64)
  }
  return fallback
}

/**
 * 一份 cookie 里的会话 id（`oneday_sid`）。
 *
 * 秒悟的整套登录态挂在它上面：同一个 `oneday_sid` 就是同一个登录态，换了就是
 * 换了一份。去重、防串号、profile 归属都按它判，而不是按整串 cookie（`.sig`
 * 会随请求滚动，整串比永远不相等）。
 *
 * @param {string} cookieHeader
 * @returns {string} 取不到时是空串
 */
export function sessionIdOf(cookieHeader) {
  const text = typeof cookieHeader === 'string' ? cookieHeader : ''
  if (text === '') return ''
  for (const part of text.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== 'oneday_sid') continue
    return part.slice(at + 1).trim()
  }
  return ''
}

/**
 * 把文件里的一行收拾成账号条目。
 *
 * cookie 与 token 都空的行直接丢掉——那就是一条废记录，留在文件里只会让卡片
 * 多出一个点了必然 401 的账号。
 *
 * @param {any} row
 * @returns {any | null}
 */
export function normalizeAccount(row) {
  if (row === null || typeof row !== 'object') return null
  const cookie = typeof row.cookie === 'string' ? row.cookie.trim() : ''
  const token = typeof row.token === 'string' ? row.token.trim() : ''
  if (cookie === '' && token === '') return null
  const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : mintAccountId()
  const source = ACCOUNT_SOURCES.includes(row.source) ? row.source : 'user'
  return {
    id,
    nickname: nicknameOf(row, '秒悟 ' + id),
    cookie,
    token,
    source,
    user: row.user !== null && typeof row.user === 'object' ? row.user : null,
    enabled: row.enabled !== false,
    addedAt: Number(row.addedAt) || Date.now(),
    lastUsedAt: Number(row.lastUsedAt) || 0,
    // 上游给的 user_id：去重与防串号都按它认人（cookie 会轮换，这个不会）。
    userId: typeof row.userId === 'string' ? row.userId.trim() : '',
    // 失效标记：只有授权类失败（401/NEED_LOGIN）才置位，卡片据此标红。
    dead: row.dead === true,
    deadReason: typeof row.deadReason === 'string' ? row.deadReason.trim().slice(0, 160) : '',
  }
}

/**
 * 挑一个该用的账号：active 优先，其次第一条启用的。
 *
 * @param {Array<any>} accounts
 * @param {unknown} wanted - 期望的 activeAccountId
 * @returns {string} 空串表示没有可用账号
 */
export function pickActiveId(accounts, wanted) {
  const list = Array.isArray(accounts) ? accounts : []
  const id = typeof wanted === 'string' ? wanted.trim() : ''
  if (id !== '' && list.some(row => row.id === id && row.enabled !== false)) return id
  const first = list.find(row => row.enabled !== false)
  return first === undefined ? '' : first.id
}

/**
 * 按 active 找账号；active 被停用/删掉时退到第一条启用的。
 *
 * @param {{ accounts: Array<any>, activeAccountId: string }} store
 * @returns {any | null}
 */
export function pickUsableAccount(store) {
  const list = Array.isArray(store?.accounts) ? store.accounts : []
  const id = pickActiveId(list, store?.activeAccountId)
  if (id === '') return null
  return list.find(row => row.id === id) ?? null
}

/**
 * 读状态文件（纯读，不写盘）。
 *
 * `migrated: true` 表示这次是**内存里**把旧格式接成了新格式，调用方
 * （`loadStore`）负责落一次盘。
 *
 * @param {string} [file]
 */
export function readStore(file = storePath()) {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    parsed = null
  }
  const version = Number(parsed?.version) || 1
  const hasAccountsField = Array.isArray(parsed?.accounts)

  if (version >= STORE_VERSION || hasAccountsField) {
    const accounts = hasAccountsField ? parsed.accounts.map(normalizeAccount).filter(row => row !== null) : []
    return {
      version: STORE_VERSION,
      accounts,
      activeAccountId: pickActiveId(accounts, parsed?.activeAccountId),
      migrated: false,
    }
  }

  // 旧格式：顶层就是那份单份凭据。接成第一条。
  const legacy = normalizeAccount({
    id: 'meoo-web',
    cookie: parsed?.cookie,
    token: parsed?.token,
    source: parsed?.source === 'browser' ? 'browser' : 'user',
    addedAt: Number(parsed?.savedAt) || Date.now(),
    enabled: true,
  })
  const accounts = legacy === null ? [] : [legacy]
  return {
    version: STORE_VERSION,
    accounts,
    activeAccountId: legacy === null ? '' : legacy.id,
    migrated: true,
  }
}

/**
 * 落盘。字段先过一遍 normalize，别让半截数据进文件。
 *
 * @param {any} store
 * @param {string} [file]
 * @returns {{ ok: boolean, store: any }}
 */
export function writeStore(store, file = storePath()) {
  const accounts = (Array.isArray(store?.accounts) ? store.accounts : [])
    .map(normalizeAccount)
    .filter(row => row !== null)
  const next = {
    version: STORE_VERSION,
    accounts,
    activeAccountId: pickActiveId(accounts, store?.activeAccountId),
    updatedAt: Date.now(),
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* 非 POSIX 文件系统不管权限 */ }
    return { ok: true, store: next }
  } catch {
    // 写不下去也不闹：内存里那份还能用，下次再试。
    return { ok: false, store: next }
  }
}

/** 读状态；旧格式顺手落一次盘（只迁移一次）。 */
export function loadStore(file = storePath()) {
  const store = readStore(file)
  if (store.migrated !== true) return store
  if (store.accounts.length === 0) return store
  const written = writeStore(store, file)
  return { ...(written.ok ? written.store : store), migrated: true }
}

/**
 * 账号条目 → `resolveSecret()` 认的那份凭据形态。
 *
 * cookie 优先：秒悟网页自己的请求全是 `credentials: "include"`，cookie 是唯一
 * 真正被站点认的形态；token 那条路只在用户自己贴了 access token 时才走。
 *
 * @param {any} account
 * @returns {{kind: 'cookie'|'token', value: string, source: string, accountId: string}|null}
 */
export function accountSecret(account) {
  if (account === null || account === undefined) return null
  const source = ACCOUNT_SOURCES.includes(account.source) ? account.source : 'user'
  if (typeof account.cookie === 'string' && account.cookie.trim() !== '') {
    return { kind: 'cookie', value: account.cookie.trim(), source, accountId: account.id }
  }
  if (typeof account.token === 'string' && account.token.trim() !== '') {
    return { kind: 'token', value: account.token.trim(), source, accountId: account.id }
  }
  return null
}

/**
 * 给卡片看的账号行：**不含 cookie/token**（status 会整个发给前端）。
 *
 * @param {any} account
 * @param {string} activeAccountId
 */
export function publicAccount(account, activeAccountId) {
  return {
    id: account.id,
    nickname: account.nickname,
    enabled: account.enabled !== false,
    active: account.id === activeAccountId,
    // 秒悟的 cookie 没有可读的过期时刻：refreshable 恒 false，卡片就不显示
    // 「待续期」那种角标；expiresAt 用 0 表示「不知道」。
    expiresAt: 0,
    refreshable: false,
    addedAt: Number(account.addedAt) || 0,
    lastUsedAt: Number(account.lastUsedAt) || 0,
    email: typeof account.user?.email === 'string' ? account.user.email : '',
    source: ACCOUNT_SOURCES.includes(account.source) ? account.source : 'user',
    // 卡片据此把这一行标红并给出「重登此账号」。
    dead: account.dead === true,
    deadReason: typeof account.deadReason === 'string' ? account.deadReason : '',
    userId: typeof account.userId === 'string' ? account.userId : '',
  }
}
