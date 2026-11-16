/**
 * WorkBuddy / CodeBuddy 桌面端登录态发现。
 *
 * 结论先写在这里：WorkBuddy 的登录态不是「问」出来的，是桌面端自己写进
 * <app data>/CodeBuddyExtension/Data/Public/auth 下的 JSON，我们只读它。
 * 没有 OAuth、没有注册表、没有 cookie 库、没有环回端口。所以这一层的全部
 * 复杂度都在「扫哪几个目录、认哪几个文件名、信哪个时间戳」。
 *
 * 只读：桌面端的文件一个字节都不改，写只写插件自己的账号库。
 *
 * @module src/workbuddy/discover
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readAccounts, writeAccounts } from './store.js'

/**
 * 探测顺序即优先级。`[0]` 是规范写入名，其余是同目录同 payload 的别名。
 *
 * 不能收成 Set：5.7.x 的 Windows 版把 workbuddy-desktop.info 改名成了
 * workbuddy-desktop-ai.info，两份同时存在时我们必须知道「哪个是正名」，
 * 否则写入端和展示端会各挑一个，看起来就像账号丢了一半。
 */
const LIVE_FILENAMES = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info']

/** CodeBuddyExtension 下面那段固定尾巴，三个平台一致。 */
const AUTH_TAIL = ['CodeBuddyExtension', 'Data', 'Public', 'auth']

/**
 * 一次扫描的结果被 1 秒内的多次调用共享。
 *
 * 面板上「账号 / 模型 / 用量」几个区域各自会问一次登录态，六次扫描读同一批
 * 文件纯属浪费；但用户的显式动作（重扫、导入）永远不能被这个窗口拖住，
 * 所以写入后直接失效缓存。
 */
const SCAN_SHARE_WINDOW_MS = 1000

/**
 * 超过一天没刷新就算陈旧。
 *
 * 只拿 lastRefreshAtMs 判、且只在它存在时判：桌面端只要活着就每天至少刷一次，
 * 而一个死掉的备份可以声称比 live 文件更晚过期（expiresAt 常年不动），
 * 所以 expiresAtMs 在这条链路上根本不读。
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function homeOf(env) {
  const home = typeof env?.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME.trim() : ''
  if (home !== '') return home
  const profile = typeof env?.USERPROFILE === 'string' ? env.USERPROFILE.trim() : ''
  return profile !== '' ? profile : os.homedir()
}

function envText(env, key) {
  const value = env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 桌面端 auth 目录，按探测顺序。
 *
 * Windows 的 LOCALAPPDATA/APPDATA 缺省值回落成 AppData\Local|Roaming：被
 * OneDrive 之流重定向过的 profile 里这两个变量可能不在 process.env 上，
 * 而文件其实还在原处。
 *
 * Linux 两套 XDG 目录里 .config 排在 .local/share 前面 —— 老版本桌面端先写
 * 的是 .config，顺序反了会让同一台机器上的老登录态永远排在新登录态后面。
 */
function desktopAuthDirs(platform, env) {
  const home = homeOf(env)
  if (platform === 'darwin') {
    return home === '' ? [] : [path.join(home, 'Library', 'Application Support', ...AUTH_TAIL)]
  }
  if (platform === 'win32') {
    const local = envText(env, 'LOCALAPPDATA') || (home === '' ? '' : path.join(home, 'AppData', 'Local'))
    const roaming = envText(env, 'APPDATA') || (home === '' ? '' : path.join(home, 'AppData', 'Roaming'))
    return [local, roaming].filter(Boolean).map(root => path.join(root, ...AUTH_TAIL))
  }
  if (platform === 'linux') {
    const config = envText(env, 'XDG_CONFIG_HOME') || (home === '' ? '' : path.join(home, '.config'))
    const data = envText(env, 'XDG_DATA_HOME') || (home === '' ? '' : path.join(home, '.local', 'share'))
    return [config, data].filter(Boolean).map(root => path.join(root, ...AUTH_TAIL))
  }
  return []
}

function platformOf(options, env) {
  const explicit = typeof options?.platform === 'string' ? options.platform : ''
  if (explicit !== '') return explicit
  // 测试要能在任何宿主上跑：真机 platform 不可注入，所以留一个环境变量口子。
  const fromEnv = envText(env, 'WORKBUDDY_DESKTOP_PLATFORM')
  return fromEnv !== '' ? fromEnv : process.platform
}

/** 毫秒时间戳，容忍秒级数字与 ISO 字符串 —— 上游三种写法都出现过。 */
function toMs(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number === 'number' && Number.isFinite(number) && number > 0) {
    // 1e11 毫秒只到 1973 年，1e11 秒要到公元 5138 年，所以小于它就是秒。
    return number < 1e11 ? Math.round(number * 1000) : Math.round(number)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function text(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' ? value.trim() : ''
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * 一份 auth 文件 → 一条账号。
 *
 * 嵌套的 `auth` 子对象是桌面端自己包的一层（`auth.lastRefreshTime` 就在里面）；
 * token 有时在外层有时在内层，两处都认，因为两种形状都在真实文件里见过。
 *
 * @returns 账号，或 null（没有 accessToken 的文件的唯一用途是报告给 errors）。
 */
function parseAuthPayload(payload, authFile) {
  if (payload === null || typeof payload !== 'object') return null
  const auth = payload.auth !== null && typeof payload.auth === 'object' ? payload.auth : {}

  const accessToken = text(payload.accessToken) || text(payload.access_token) || text(auth.accessToken)
  if (accessToken === '') return null
  const refreshToken = text(payload.refreshToken) || text(payload.refresh_token) || text(auth.refreshToken)

  const uin = text(payload.uin) || text(auth.uin)
  const uid = text(payload.uid) || text(auth.uid)
  // uin 是账号的天然主键；uid 是退路；两个都没有时用 token 摘要兜底 ——
  // 至少「同一个 token 扫两次」还是同一条账号，不会在账号库里堆出重复行。
  const id = uin !== '' ? uin : uid !== '' ? uid : `wb-${digest(accessToken)}`

  // uin/uid 不能当展示名：它们是内部数字，界面上要的是昵称。
  const nickname = text(payload.nickname) || text(payload.nickName) || text(payload.nick)
    || text(payload.name) || text(payload.displayName) || text(auth.nickname)

  const lastRefreshAtMs = toMs(payload.lastRefreshAtMs)
    || toMs(payload.lastRefreshTime)
    || toMs(auth.lastRefreshAtMs)
    || toMs(auth.lastRefreshTime)

  // 落在哪一侧（CodeBuddy 中国版 copilot.tencent.com / WorkBuddy 国际版
  // www.workbuddy.ai）只能从凭据里读：同名的 auth 文件两个产品都会写，
  // 而渠道包会按 domain 与产品配置比对，失配的账号会被当成「旧版凭据」清掉。
  const domain = text(payload.domain) || text(payload.apiDomain) || text(auth.domain) || text(payload.endpoint)

  return {
    id,
    nickname: nickname !== '' ? nickname : `WorkBuddy ${id}`,
    authFile,
    uin: uin !== '' ? uin : uid,
    accessToken,
    refreshToken,
    domain,
    lastRefreshAtMs,
  }
}

/** 缓存与单飞：`key` 是「这次要扫哪些路径」，换了环境就不复用别人的结果。 */
let cache
let inflight

/** 写入后调用：读后写永远重新扫，写在扫描中间时后续读者加入同一趟扫描。 */
function invalidateScan() {
  cache = undefined
  inflight = undefined
}

/** 调用方给的 logger 可能是函数，也可能是 { warn, info, debug } 这类对象。 */
function logLine(logger, message) {
  if (typeof logger === 'function') {
    logger(message)
    return
  }
  // 扫描诊断只走 debug：面板一打开就调 status，而「文件在但还没登录」「这份读不了」
  // 都是常态，逐条 warn 只会把宿主的日志刷满。真正的失败由返回值的 errors 带出去。
  if (typeof logger?.debug === 'function') logger.debug(message)
  else if (typeof logger?.info === 'function') logger.info(message)
}

function candidatePlan(platform, env) {
  const dirs = desktopAuthDirs(platform, env)
  const override = envText(env, 'WORKBUDDY_AUTH_FILE')
  const files = []
  const searched = []
  // 显式指定优先：用户设了这个变量就是在说「别处扫到的不算」，把它排在
  // 平台目录前面比「全部落空才用它」更符合他按下按钮时的预期。
  if (override !== '') {
    files.push(override)
    searched.push(override)
  }
  for (const dir of dirs) {
    searched.push(dir)
    for (const name of LIVE_FILENAMES) files.push(path.join(dir, name))
  }
  return { files, searched, key: [platform, ...searched].join('\u0000') }
}

async function scanOnce(plan, logger) {
  const credentials = []
  const errors = []
  const rank = new Map()

  for (const file of plan.files) {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      // 不存在是常态（用户没装桌面端），只有「存在但读不了」才算错。
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      errors.push(`${file}: ${error?.message ?? error}`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      errors.push(`${file}: ${error?.message ?? error}`)
      continue
    }
    const account = parseAuthPayload(parsed, file)
    if (account === null) {
      errors.push(`${file}: 没有 accessToken`)
      continue
    }
    credentials.push(account)
    rank.set(account, rank.size)
  }

  // 同一账号会命中多份文件（两个别名、两个 APPDATA、以及 env 指定的那份）。
  // 取「刷新时间最新」的那条；一样新时取探测顺序靠前的，也就是规范名那份。
  const byId = new Map()
  for (const account of credentials) {
    const previous = byId.get(account.id)
    if (previous === undefined
      || account.lastRefreshAtMs > previous.lastRefreshAtMs
      || (account.lastRefreshAtMs === previous.lastRefreshAtMs && rank.get(account) < rank.get(previous))) {
      byId.set(account.id, account)
    }
  }

  for (const message of errors) logLine(logger, message)

  return { credentials: [...byId.values()], searched: plan.searched, errors }
}

async function scanCredentials({ env = process.env, logger, platform } = {}) {
  const plan = candidatePlan(platformOf({ platform }, env), env)
  const now = Date.now()
  if (cache !== undefined && cache.key === plan.key && now - cache.at < SCAN_SHARE_WINDOW_MS) {
    return cache.value
  }
  // 扫描进行中时后来者加入同一趟，而不是各自再读一遍同一批文件。
  if (inflight !== undefined && inflight.key === plan.key) return inflight.promise

  const promise = scanOnce(plan, logger)
  inflight = { key: plan.key, promise }
  try {
    const value = await promise
    cache = { key: plan.key, at: Date.now(), value }
    return value
  } finally {
    if (inflight !== undefined && inflight.promise === promise) inflight = undefined
  }
}

/**
 * 扫一遍本机登录态。
 *
 * 返回的 `found` 只带调用方需要的字段 —— refreshToken 不进这一层，因为它会
 * 被一路传到设置页/日志里，而真正需要它的只有 importAccounts。
 *
 * @param {{ env?: NodeJS.ProcessEnv, logger?: Function, platform?: string }} [options]
 * @returns {Promise<{ found: Array<{ id: string, nickname: string, authFile: string,
 *   lastRefreshAtMs: number, stale: boolean, accessToken: string }>,
 *   searched: string[], errors: string[] }>}
 */
export async function discoverWorkBuddy(options = {}) {
  const value = await scanCredentials(options)
  const now = Date.now()
  return {
    found: value.credentials.map(account => ({
      id: account.id,
      nickname: account.nickname,
      authFile: account.authFile,
      lastRefreshAtMs: account.lastRefreshAtMs,
      // 没有刷新时间就不下结论：宁可当成新鲜的让用户点一次，也不要凭空白说它死了。
      stale: account.lastRefreshAtMs > 0 && now - account.lastRefreshAtMs > STALE_AFTER_MS,
      accessToken: account.accessToken,
    })),
    searched: [...value.searched],
    errors: [...value.errors],
  }
}

/**
 * 完整凭据（含 refreshToken / domain），只给「写进渠道包」这一步用。
 *
 * 故意和 discoverWorkBuddy 分开：那份会被面板一路带到日志和界面上，
 * refreshToken 留在这一层，谁要它谁自己来拿（index.js 的 buddyImport 就只要这一份）。
 */
export async function discoverCredentialDetails(options = {}) {
  const value = await scanCredentials(options)
  return value.credentials.map(account => ({ ...account }))
}

/**
 * 把扫到的账号落进插件自己的账号库，同 id 覆盖。
 *
 * 内容一字未变的不重复写：同一个按钮点两下应该只有第一次算「导入」，
 * 否则每次刷新都写一次盘，用户看不出这按钮到底干了什么。
 *
 * @param {{ env?: NodeJS.ProcessEnv, logger?: Function, platform?: string }} [options]
 * @returns {Promise<{ imported: string[], skipped: string[] }>}
 */
export async function importAccounts(options = {}) {
  const { env = process.env } = options
  const value = await scanCredentials(options)
  const existing = await readAccounts(env)
  const byId = new Map(existing.map(row => [row.id, row]))
  const imported = []
  const skipped = []
  let changed = false

  for (const account of value.credentials) {
    const previous = byId.get(account.id)
    if (previous !== undefined
      && previous.accessToken === account.accessToken
      && previous.refreshToken === account.refreshToken
      && previous.authFile === account.authFile) {
      skipped.push(account.id)
      continue
    }
    byId.set(account.id, {
      id: account.id,
      nickname: account.nickname,
      authFile: account.authFile,
      uin: account.uin,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      savedAt: Date.now(),
    })
    imported.push(account.id)
    changed = true
  }

  if (changed) {
    await writeAccounts(env, [...byId.values()])
    // 写过了：下一次读必须重新扫，缓存里那份是写之前的本机状态。
    invalidateScan()
  }
  return { imported, skipped }
}

/**
 * 面板用的一行状态。
 *
 * `discovered` 是「此刻本机看得见几条」，`imported` 是「库里存了几条」，
 * 两个数不一样正是「扫到了但还没导入」这个状态。
 *
 * @param {{ env?: NodeJS.ProcessEnv, logger?: Function, platform?: string }} [options]
 * @returns {Promise<{ discovered: number, imported: number, searched: string[] }>}
 */
export async function status(options = {}) {
  const { env = process.env } = options
  const value = await scanCredentials(options)
  const stored = await readAccounts(env)
  return {
    discovered: value.credentials.length,
    imported: stored.length,
    searched: [...value.searched],
  }
}
