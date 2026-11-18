/**
 * 秒悟（meoo）额度积分。
 *
 * 这条渠道跟别的不同：它不提供模型，提供的是「一键上线」的算力与部署额度。
 * 所以这里没有适配器、也不往模型选择器里投放任何东西 —— 它只是一张卡，
 * 把用户自己的积分、部署用量、计划等级摆出来，免得每次都要开终端敲 meoo。
 *
 * 一切数据都从官方 CLI 读（`meoo account --json`），理由有三：
 *   1. 额度只有一个真源，插件自己拼 HTTP 等于把官方的字段契约抄一份到本地养着；
 *   2. oauth 的 401 自动刷新由 CLI 负责，插件自己去刷会把 refreshToken 用废 ——
 *      那是一个「用一次就废一个」的令牌，谁抢着刷谁把用户的登录弄丢；
 *   3. CLI 未登录时会明确回 NOT_LOGGED_IN，这个状态要原样透出去，
 *      而不是变成一个 500 让人以为插件挂了。
 *
 * 没装 CLI / 没登录 / 网络断，三种都不是异常，是三种可显示的状态。
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDshHome } from '../store.js'

/** 官方 CLI 的最低可用版本：低于它就按「该升级了」显示，但不拦着用。 */
export const MIN_CLI_VERSION = '0.5.8'

/** 秒悟技能的落地目录：~/.dsh/skills 是 DSH 认的技能根，目录名就是技能名。 */
export const SKILL_NAME = 'meoo-cli'

const STATUS_TTL_MS = 60_000
const CLI_TIMEOUT_MS = 20_000

/** 跑一次 CLI，永远不抛：超时、非零退码、装都没装，都变成返回结构里的字段。 */
function runCli(bin, args) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : (typeof error?.code === 'number' ? error.code : 1),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        timedOut: error?.killed === true,
      })
    })
  })
}

/** 从输出里捞一个 JSON 对象：CLI 偶尔会在前面打一行提示，直接 JSON.parse 会炸。 */
function parseJson(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  try { return JSON.parse(raw) } catch { /* 继续往下切 */ }
  const from = raw.indexOf('{')
  const to = raw.lastIndexOf('}')
  if (from >= 0 && to > from) {
    try { return JSON.parse(raw.slice(from, to + 1)) } catch { /* 真的不是 JSON */ }
  }
  return null
}

/** 在 PATH 里找可执行文件：不认 shell alias，只认真文件。 */
function whichBin() {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  // 家目录里的 npm 全局 bin 常常不在宿主进程的 PATH 里（App 从 Finder 起来就有这个坑）。
  const fallback = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.npm-global', 'bin'),
  ]
  for (const dir of [...dirs, ...fallback]) {
    for (const ext of exts) {
      const full = path.join(dir, `meoo${ext}`)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch { /* 没这个文件 */ }
    }
  }
  return ''
}

/** 版本比较只做「差多少」：够不够用看主次版本，补丁号变了不影响。 */
function isOlder(version, min) {
  const a = String(version ?? '').split('.').map(part => Number.parseInt(part, 10))
  const b = String(min ?? '').split('.').map(part => Number.parseInt(part, 10))
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = Number.isFinite(a[i]) ? a[i] : 0
    const y = Number.isFinite(b[i]) ? b[i] : 0
    if (x !== y) return x < y
  }
  return false
}

/** 凭证文件只读「是谁、什么类型」，token 一个字都不往外带。 */
function readCredential() {
  const file = path.join(os.homedir(), '.meoo', 'credentials.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      present: true,
      credentialType: typeof parsed?.credentialType === 'string' ? parsed.credentialType : '',
      edition: typeof parsed?.edition === 'string' ? parsed.edition : '',
      username: typeof parsed?.username === 'string' ? parsed.username : '',
      userId: typeof parsed?.userId === 'string' ? parsed.userId : '',
      expiresAt: typeof parsed?.accessTokenExpiresAt === 'string' ? parsed.accessTokenExpiresAt : '',
    }
  } catch {
    return { present: false, credentialType: '', edition: '', username: '', userId: '', expiresAt: '' }
  }
}

/** 插件自己的开关状态（停用后不查额度、不碰 CLI），不写进 ~/.meoo。 */
function statePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'meoo.json')
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return { enabled: parsed?.enabled !== false, cliEnabled: parsed?.cliEnabled !== false }
  } catch {
    return { enabled: true, cliEnabled: true }
  }
}

function writeState(next) {
  try {
    const file = statePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** 读凭据里的令牌：只用来发只读 GET，绝不拿它去刷新（刷新归 CLI）。 */
function meooToken() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.meoo', 'credentials.json'), 'utf8'))
    const token = typeof parsed?.accessToken === 'string' ? parsed.accessToken : ''
    if (token !== '') return token
    return typeof parsed?.apiKey === 'string' ? parsed.apiKey : ''
  } catch {
    return ''
  }
}

/**
 * 一次只读 GET：/open/v1/cli-compat/account/points。
 *
 * 为什么不用 CLI：CLI 没有 points 子命令，而 account --json 只给三个汇总数，
 * 拿不到「今天这笔登录积分到没到账」。这个 GET 不刷新令牌、不改任何状态。
 */
async function fetchPoints(token) {
  if (typeof fetch !== 'function' || token === '') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch('https://meoo.com/open/v1/cli-compat/account/points', {
      headers: {
        authorization: 'Bearer ' + token,
        'x-meoo-client': 'cli',
        'x-meoo-cli-version': MIN_CLI_VERSION,
      },
      signal: controller.signal,
    })
    if (response.ok !== true) return null
    const payload = await response.json()
    const data = payload?.data ?? null
    const account = data?.account ?? null
    const num = value => (Number.isFinite(value) ? value : null)
    const grants = Array.isArray(data?.activeGrants) ? data.activeGrants : []
    const daily = grants.find(row => row?.sourceType === 'DAILY_LOGIN') ?? null
    const details = Array.isArray(daily?.grantDetails) ? daily.grantDetails : []
    const stillValid = details.filter(row => {
      const at = Date.parse(String(row?.expiresDate ?? ''))
      return Number.isFinite(at) && at > Date.now()
    })
    const amount = stillValid.reduce((sum, row) => sum + (Number.isFinite(row?.remainingAmount) ? row.remainingAmount : 0), 0)
    return {
      availableBalance: num(account?.availableBalance),
      totalGranted: num(account?.totalGranted),
      totalConsumed: num(account?.totalConsumed),
      daily: daily === null
        ? { granted: false, amount: null, expiresAt: '' }
        : {
          granted: stillValid.length > 0,
          amount: stillValid.length > 0 ? amount : null,
          expiresAt: typeof stillValid[0]?.expiresDate === 'string' ? stillValid[0].expiresDate : '',
        },
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function skillPath() {
  return path.join(resolveDshHome(), 'skills', SKILL_NAME)
}

function skillInstalled() {
  try {
    return fs.statSync(path.join(skillPath(), 'SKILL.md')).isFile()
  } catch {
    return false
  }
}

/** `meoo account --json` 的 points 是三个数，全 0 和「没读到」必须分开。 */
function readPoints(data) {
  const points = data?.points ?? null
  if (points === null || typeof points !== 'object') return null
  const num = value => (Number.isFinite(value) ? value : null)
  const available = num(points.availableBalance)
  const granted = num(points.totalGranted)
  const consumed = num(points.totalConsumed)
  return {
    availableBalance: available,
    totalGranted: granted,
    totalConsumed: consumed,
    usedRatio: Number.isFinite(available) && Number.isFinite(granted) && granted > 0
      ? Math.min(1, Math.max(0, (granted - available) / granted))
      : null,
  }
}

/** 部署额度：limit 为 -1 表示不限额，别渲染成「剩余 -1」。 */
function readDeployQuota(data) {
  const raw = data?.deployQuota ?? null
  if (raw === null || typeof raw !== 'object') return null
  const one = row => {
    if (row === null || typeof row !== 'object') return null
    const used = Number.isFinite(row.used) ? row.used : null
    const limit = Number.isFinite(row.limit) ? row.limit : null
    return { used, limit, unlimited: limit === -1 }
  }
  const stat = one(raw.static)
  const image = one(raw.image)
  if (stat === null && image === null) return null
  return { static: stat, image }
}

/**
 * 一条 meoo 通道。
 *
 * @param {{logger?: {info?: Function, warn?: Function}, now?: () => number}} [options]
 */
export function createMeoo(options = {}) {
  const logger = options.logger ?? null
  const now = typeof options.now === 'function' ? options.now : Date.now
  let memo = null
  /** 正在跑的那一个 `meoo login`：占着它的回调端口，不能开第二份。 */
  let loginChild = null

  /** 读一次全量状态。force 为真时跳过 60 秒缓存。 */
  async function status({ force = false } = {}) {
    if (force !== true && memo !== null && now() - memo.at < STATUS_TTL_MS) {
      return { ...memo.value, cached: true }
    }

    const bin = whichBin()
    const credential = readCredential()
    const skill = { installed: skillInstalled(), target: skillPath(), fileCount: 0 }
    const fetchedAt = new Date(now()).toISOString()

    if (bin === '') {
      const value = {
        cli: { installed: false, path: '', version: '', minRequired: MIN_CLI_VERSION, outdated: false },
        auth: { loggedIn: false, credentialType: credential.credentialType, edition: credential.edition, username: credential.username, reason: '没找到 meoo 命令', code: 'CLI_MISSING' },
        plan: null,
        points: null,
        deployQuota: null,
        team: null,
        skill,
        partial: false,
        warnings: ['装一条命令就有：npm i -g @aliyun-meoo/cli@latest'],
        fetchedAt,
        cached: false,
      }
      memo = { at: now(), value }
      return value
    }

    const versionRun = await runCli(bin, ['--version'])
    const version = (versionRun.stdout.match(/\d+\.\d+\.\d+/g) ?? [''])[0]
    const cli = {
      installed: true,
      path: bin,
      version,
      minRequired: MIN_CLI_VERSION,
      outdated: version !== '' && isOlder(version, MIN_CLI_VERSION),
    }

    const accountRun = await runCli(bin, ['account', '--json'])
    const payload = parseJson(accountRun.stdout)
    const failed = accountRun.code !== 0 || payload === null
    const errorCode = typeof payload?.error?.code === 'string' ? payload.error.code : ''
    const errorMessage = typeof payload?.error?.message === 'string' ? payload.error.message : ''
    const errorHint = typeof payload?.error?.hint === 'string' ? payload.error.hint : ''
    const notLoggedIn = errorCode === 'NOT_LOGGED_IN'

    // 未登录不是故障：CLI 回 NOT_LOGGED_IN 就是它本来的回答，
    // 卡片照实写「还没登录」，别把日志刷成一条警告。
    if (failed) {
      const value = {
        cli,
        auth: {
          loggedIn: false,
          credentialType: credential.credentialType,
          edition: credential.edition,
          username: credential.username,
          reason: notLoggedIn ? '还没登录秒悟' : (errorMessage === '' ? (accountRun.timedOut ? 'meoo account 超时' : `meoo 退出码 ${accountRun.code}`) : errorMessage),
          code: errorCode === '' ? (accountRun.timedOut ? 'TIMEOUT' : 'CLI_FAILED') : errorCode,
          hint: errorHint,
        },
        plan: null,
        points: null,
        deployQuota: null,
        team: null,
        skill,
        partial: true,
        warnings: notLoggedIn ? ['在终端里跑一次 meoo login，凭证由 CLI 自己保管。'] : [],
        fetchedAt,
        cached: false,
      }
      memo = { at: now(), value }
      return value
    }

    const data = payload?.data ?? payload
    const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(row => typeof row === 'string') : []
    const plan = data?.plan !== null && typeof data?.plan === 'object'
      ? {
        code: typeof data.plan.planCode === 'string' ? data.plan.planCode : '',
        name: typeof data.plan.planName === 'string' ? data.plan.planName : '',
        benefits: data.plan.benefits !== null && typeof data.plan.benefits === 'object' ? data.plan.benefits : null,
      }
      : null
    const user = data?.user !== null && typeof data?.user === 'object' ? data.user : null
    const value = {
      cli,
      auth: {
        loggedIn: credential.present || user !== null,
        credentialType: credential.credentialType === '' && typeof data?.viewMode === 'string' ? data.viewMode : credential.credentialType,
        edition: credential.edition,
        username: credential.username !== '' ? credential.username : (typeof user?.username === 'string' ? user.username : ''),
        reason: '',
        code: '',
        hint: '',
      },
      plan,
      points: readPoints(data),
      deployQuota: readDeployQuota(data),
      team: data?.team !== null && typeof data?.team === 'object' ? data.team : null,
      skill,
      partial: data?.partial === true,
      warnings,
      // 停用只是插件这边不再使用它：凭据、CLI、账号都原样留着，随时能开回来。
      disabled: readState().enabled === false,
      // CLI 车道单独一个开关：关掉只是这条车道不干活，额度那张卡照常能看。
      cliDisabled: readState().cliEnabled === false,
      // 卡片上的「积分 / 今日签到」靠这一份实时数（account --json 只有汇总）。
      live: await fetchPoints(meooToken()),
      fetchedAt,
      cached: false,
    }
    if (value.cli.outdated) value.warnings = [...value.warnings, `CLI ${cli.version} 低于 ${MIN_CLI_VERSION}，建议 npm i -g @aliyun-meoo/cli@latest`]
    memo = { at: now(), value }
    return value
  }

  /** 登录这一步只能人来做（要开浏览器授权）。这里只给一句能照抄的话。 */
  function login() {
    const bin = whichBin('meoo')
    if (!bin) {
      return { pending: false, started: false, error: 'CLI_MISSING', hint: '先装 CLI：npm i -g @aliyun-meoo/cli@latest' }
    }
    // CLI 自己会开浏览器（输出「正在打开浏览器…」并打印 authorize 链接），所以
    // 插件这边只要把它跑起来，授权页就出来了。不 detach、不接管它的回调端口：
    // 那个 127.0.0.1:随机端口的本地 server 是 CLI 自己起的，插手只会弄坏它。
    if (loginChild !== null) {
      return { pending: true, started: true, running: true, hint: '授权页应该已经开着，去浏览器点「授权」。' }
    }
    try {
      const child = spawn(bin, ['login'], { stdio: 'ignore' })
      loginChild = child
      child.on('exit', () => { loginChild = null; memo = null })
      child.on('error', () => { loginChild = null })
      return {
        pending: true,
        started: true,
        command: bin + ' login',
        hint: '浏览器会自己打开 Meoo 授权页；点「授权」，这一格会自己亮。',
      }
    } catch (error) {
      return { pending: false, started: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * 升级 CLI 本体。只调官方 upgrade 命令，插件不自己下二进制、不自己比版本。
   */
  async function upgrade() {
    const bin = whichBin()
    if (bin === '') return { ok: false, error: '没找到 meoo 命令：npm i -g @aliyun-meoo/cli@latest' }
    const run = await runCli(bin, ['upgrade'])
    memo = null
    if (run.code !== 0) {
      const message = run.stderr.trim().slice(0, 300) || run.stdout.trim().slice(0, 300) || `退出码 ${run.code}`
      logger?.warn?.(`get-it-for-free: 秒悟 CLI 升级失败（${message}）`)
      return { ok: false, error: message }
    }
    return { ok: true, output: (run.stdout || run.stderr).trim().slice(0, 2000), ...(await status({ force: true })) }
  }

  /** 卡片上的「测试」：跑一次 whoami，量一个耗时出来。 */
  async function test() {
    const bin = whichBin()
    if (bin === '') return { ok: false, ms: 0, message: '没找到 meoo 命令：npm i -g @aliyun-meoo/cli@latest' }
    const startedAt = now()
    const run = await runCli(bin, ['whoami', '--json'])
    const ms = now() - startedAt
    const payload = parseJson(run.stdout)
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : ''
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : (run.stderr.trim().slice(0, 200) || '')
    if (run.code === 0 && payload?.success !== false) {
      const name = payload?.data?.username ?? payload?.data?.user?.username ?? readCredential().username
      return { ok: true, ms, message: `登录态正常${name === '' ? '' : `（${name}）`}`, live: await fetchPoints(meooToken()) }
    }
    return { ok: false, ms, message: code === 'NOT_LOGGED_IN' ? '还没登录' : (message === '' ? `退出码 ${run.code}` : message) }
  }

  /** 卡片上的「续期」：重新走一次授权（凭证是 CLI 自己保管的，插件只负责触发）。 */
  function renew() {
    return login()
  }

  /** 卡片上的「移除」：调官方 logout 清掉本机凭证，不删任何远端数据。 */
  async function logout() {
    const bin = whichBin()
    if (bin === '') return { ok: false, error: '没找到 meoo 命令' }
    const run = await runCli(bin, ['logout'])
    memo = null
    if (run.code !== 0) return { ok: false, error: run.stderr.trim().slice(0, 300) || `退出码 ${run.code}` }
    return { ok: true, ...(await status({ force: true })) }
  }

  /** 卡片上的「停用 / 启用」：只写插件自己的开关。 */
  async function setEnabled(enabled) {
    const state = readState()
    const ok = writeState({ ...state, enabled: enabled !== false })
    memo = null
    return { ok, enabled: enabled !== false, ...(await status({ force: true })) }
  }

  /** CLI 车道自己的开关（对应卡片上的停用/启用）。 */
  async function setCliEnabled(enabled) {
    const state = readState()
    const ok = writeState({ ...state, cliEnabled: enabled !== false })
    memo = null
    return { ok, cliEnabled: enabled !== false, ...(await status({ force: true })) }
  }

  /**
   * 卡片上的「签到」。
   *
   * 秒悟没有独立的签到接口：实测 /open/v1/cli-compat 下的 daily-login、
   * checkin、check-in、benefits/daily_login/claim 全是 404。每日登录积分是
   * 登录那一刻由服务端发的（points 里 DAILY_LOGIN 这条 grant 就是它）。
   * 所以这里只做两件事：已经发了就说「今天已领」；还没发就把授权流程再走一次。
   */
  async function claim() {
    const token = meooToken()
    if (token === '') return { ok: false, code: 'NOT_LOGGED_IN', hint: '先点「添加账号」登录。' }
    const live = await fetchPoints(token)
    if (live === null) return { ok: false, code: 'UNAVAILABLE', hint: '读不到积分：网络不通或平台抽风，稍后再试。', ...login() }
    if (live.daily?.granted === true) {
      return { ok: true, already: true, amount: live.daily.amount, expiresAt: live.daily.expiresAt, live, hint: '今天的登录积分已经到账。' }
    }
    return {
      ok: false,
      code: 'NEEDS_LOGIN',
      hint: '今天的登录积分还没发：点一次「添加账号」重新授权，服务端会补发。',
      ...login(),
    }
  }

  return { status, login, upgrade, test, renew, logout, setEnabled, setCliEnabled, claim, dispose() { memo = null } }
}
