/**
 * 千问办公账号库：几条 token 并存的落盘形态。
 *
 * 以前这份文件（~\.dsh/get-it-for-free/qwenwork.json）只存模型黑名单，凭据单独
 * 躺在 ~\.dsh/qwenwork-desktop.json 里一份，所以面板上永远只有一个账号。多账号
 * 的做法跟豆包那条一样——上游只认 token，不认「哪个账号」，想用几个就有几条：
 *
 *   { version: 2, accounts: [...], activeAccountId, disabledModels, updatedAt }
 *
 * 向后兼容：读到旧格式（没有 accounts 字段）时，把那份单份凭据接成第一条，
 * 顺手把 version 抬到 2 并落盘。抬过版本之后就不再回头看旧文件——否则用户把
 * 账号全删了，那份旧文件又会把上一个账号「复活」出来。
 *
 * 文件 0600，写盘走 tmp + rename，崩在中间不会留下半个 JSON。
 *
 * @module src/qwenwork/account-store.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { readLocalCredential } from './local-credentials.js'
import { resolveDshHome } from '../store.js'

/** 2 = 有 accounts；1（或没有 version）= 只有 disabledModels 的老文件。 */
export const STORE_VERSION = 2

/** 提前量：和 local-credentials.js 一致，别把一次请求赌在过期边界上。 */
export const EXPIRY_SKEW_MS = 120_000

/** 状态文件路径。 */
export function storePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'qwenwork.json')
}

/**
 * 时间归一化。
 *
 * 同一份状态里 expiresAt 可能来自三处：旧文件（ISO 字符串）、JWT 的 exp
 * （秒级数字）、device flow 结果（ISO 字符串）。**必须先归一化成 Date 再用
 * getTime()**，否则就是那条真实踩过的
 * `creds.expiresAt.getTime is not a function`。
 *
 * @param {unknown} value - 任意来源的时间值
 * @returns {Date | null} 认不出来就是 null（当作「不知道」）
 */
export function parseDate(value) {
  if (value === undefined || value === null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 秒级时间戳（JWT 的 exp）和毫秒级（Date.now）差三个数量级。
    const ms = value > 1e12 ? value : value * 1000
    const fromNumber = new Date(ms)
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** 账号的过期时刻（毫秒）；0 表示不知道。 */
export function expiresAtMs(account) {
  const date = parseDate(account?.expiresAt)
  return date === null ? 0 : date.getTime()
}

/** 是否已过期（含提前量）。**expiresAt 缺失时不算过期**，跟旧行为一致。 */
export function isAccountExpired(account, skewMs = EXPIRY_SKEW_MS, now = Date.now()) {
  const at = expiresAtMs(account)
  if (at === 0) return false
  return at - skewMs <= now
}

/** 新账号 id：短、可读、和用户自己起的名字无关。 */
export function mintAccountId() {
  return 'qw-' + crypto.randomBytes(4).toString('hex')
}

/** 昵称：显式字段 > 凭据里的用户名/邮箱 > 兜底。 */
export function nicknameOf(row, fallback = '千问办公') {
  const direct = typeof row?.nickname === 'string' ? row.nickname.trim() : ''
  if (direct !== '') return direct.slice(0, 64)
  const user = row?.user ?? {}
  for (const candidate of [user.name, user.username, user.email]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 64)
  }
  return fallback
}

/**
 * 把文件里的一行收拾成账号条目。token 为空的行直接丢掉（那就是一条废记录）。
 *
 * @param {any} row
 * @returns {any | null}
 */
export function normalizeAccount(row) {
  if (row === null || typeof row !== 'object') return null
  const token = typeof row.token === 'string' ? row.token.trim() : ''
  if (token === '') return null
  const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : mintAccountId()
  const expires = parseDate(row.expiresAt)
  return {
    id,
    nickname: nicknameOf(row, '千问办公 ' + id),
    token,
    refreshToken: typeof row.refreshToken === 'string' ? row.refreshToken : '',
    // 统一存 ISO 字符串：JSON 里 Date 本来也会变字符串，读回时两种都吃。
    expiresAt: expires === null ? '' : expires.toISOString(),
    user: row.user !== null && typeof row.user === 'object' ? row.user : null,
    // 签名要它（COSY 的 Cosy-MachineId 必须和登录时一致），不能丢。
    loginDeviceId: typeof row.loginDeviceId === 'string' ? row.loginDeviceId : '',
    enabled: row.enabled !== false,
    addedAt: Number(row.addedAt) || Date.now(),
    lastUsedAt: Number(row.lastUsedAt) || 0,
  }
}

/** 模型黑名单：只留非空字符串，去重。 */
function normalizeDisabled(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (id !== '' && id.length <= 64) seen.add(id)
  }
  return [...seen]
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

/** 旧版那份单份凭据 → 一条账号记录。读不到就是 null。 */
function legacyAccount() {
  const held = readLocalCredential()
  if (held === undefined) return null
  return normalizeAccount({
    id: 'qwenwork',
    token: held.token,
    refreshToken: held.refreshToken,
    expiresAt: held.expiresAt,
    user: held.user,
    loginDeviceId: held.loginDeviceId,
    enabled: true,
    addedAt: Date.now(),
  })
}

/**
 * 读状态文件（纯读，不写盘）。
 *
 * `migrated: true` 表示这次是**内存里**把旧格式接成了新格式，调用方
 * （`loadStore`）负责落一次盘。`managed: true` 表示这台机器已经进过多账号
 * 形态，之后即使账号删空也不再回退旧文件。
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
  const disabledModels = normalizeDisabled(parsed?.disabledModels)
  const version = Number(parsed?.version) || 1
  const hasAccountsField = Array.isArray(parsed?.accounts)

  if (version >= STORE_VERSION || hasAccountsField) {
    const accounts = hasAccountsField ? parsed.accounts.map(normalizeAccount).filter(row => row !== null) : []
    return {
      version: STORE_VERSION,
      accounts,
      activeAccountId: pickActiveId(accounts, parsed?.activeAccountId),
      disabledModels,
      managed: true,
      migrated: false,
    }
  }

  // 旧格式：只有 disabledModels，凭据在另一个文件里。接成第一条账号。
  const legacy = legacyAccount()
  const accounts = legacy === null ? [] : [legacy]
  return {
    version: STORE_VERSION,
    accounts,
    activeAccountId: legacy === null ? '' : legacy.id,
    disabledModels,
    managed: false,
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
    disabledModels: normalizeDisabled(store?.disabledModels),
    updatedAt: Date.now(),
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, store: next }
  } catch {
    // 写不下去也不闹：内存里那份还能用，下次再试。
    return { ok: false, store: next }
  }
}

/**
 * 读状态；旧格式顺手落一次盘（只迁移一次）。
 *
 * @param {string} [file]
 */
export function loadStore(file = storePath()) {
  const store = readStore(file)
  if (store.migrated !== true) return store
  if (store.accounts.length === 0) {
    // 旧文件里没有凭据可接（这台机器可能只用过 Windows 桌面端那一路），
    // 那就**不落盘**：留着 managed=false，让 provider 还能去问接缝。
    return store
  }
  const written = writeStore(store, file)
  return { ...(written.ok ? written.store : store), managed: true, migrated: true }
}

/**
 * 账号条目 → 上游那一套要的凭据形态（token / user / loginDeviceId）。
 *
 * chat-shim 的 signer-session 只认这个形状，别在这里裁字段。
 *
 * @param {any} account
 */
export function accountCredential(account) {
  if (account === null || account === undefined) return undefined
  const expiresDate = parseDate(account.expiresAt)
  return {
    token: account.token,
    refreshToken: account.refreshToken,
    expiresAt: expiresDate,
    user: account.user ?? {},
    loginDeviceId: account.loginDeviceId,
    loginMethod: 'device-flow',
    source: 'account-store',
    accountId: account.id,
  }
}

/**
 * 把一次刷新结果写回指定账号（纯数据，不落盘）。
 *
 * @param {any} store
 * @param {string} accountId
 * @param {{ token: string, refreshToken?: string | null, expiresAt?: Date | null }} refreshed
 * @returns {{ store: any, account: any | null }}
 */
export function applyRefreshed(store, accountId, refreshed) {
  const accounts = (Array.isArray(store?.accounts) ? store.accounts : []).slice()
  const index = accounts.findIndex(row => row.id === accountId)
  if (index === -1) return { store, account: null }
  const previous = accounts[index]
  const nextExpires = parseDate(refreshed?.expiresAt ?? previous.expiresAt)
  const updated = normalizeAccount({
    ...previous,
    token: typeof refreshed?.token === 'string' && refreshed.token !== '' ? refreshed.token : previous.token,
    refreshToken: typeof refreshed?.refreshToken === 'string' && refreshed.refreshToken !== ''
      ? refreshed.refreshToken
      : previous.refreshToken,
    expiresAt: nextExpires === null ? '' : nextExpires.toISOString(),
    lastUsedAt: Date.now(),
  })
  accounts[index] = updated
  return { store: { ...store, accounts }, account: updated }
}

/**
 * 给卡片看的账号行：**不含 token**（status 会整个发给前端）。
 *
 * @param {any} account
 * @param {string} activeAccountId
 */
export function publicAccount(account, activeAccountId) {
  const at = expiresAtMs(account)
  return {
    id: account.id,
    nickname: account.nickname,
    enabled: account.enabled !== false,
    active: account.id === activeAccountId,
    expiresAt: at,
    refreshable: typeof account.refreshToken === 'string' && account.refreshToken !== '',
    addedAt: Number(account.addedAt) || 0,
    lastUsedAt: Number(account.lastUsedAt) || 0,
    email: typeof account.user?.email === 'string' ? account.user.email : '',
  }
}
