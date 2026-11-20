/**
 * 秒悟登录窗：一账号一个持久浏览器分区，登录完用 CDP 把 cookie 读走。
 *
 * 为什么不再从用户日常 Chrome 的 cookie 库里抄：抄回来的是「用户浏览器里现在
 * 登着的那个号」，插件说了不算 —— 于是 A 号的卡片可能被 B 号的登录态顶上，
 * 也就是串号。这里改成给账号开它自己的 profile 目录：
 *
 *   <DSH_HOME>/get-it-for-free/meoo-profiles/<accountId>/
 *
 * 窗口打开时就是该账号自己的登录态；「添加新账号」用固定的 `_staging/` 分区并
 * 每次先清空，所以弹出的永远是干净登录页。分区物理隔离之后，串号不可能发生。
 *
 * 三个细节都是踩出来的：
 *   1. `--remote-debugging-port=0` 让系统分配端口（硬编码在 Windows 会撞保留
 *      区间），真端口写在 `<profile>/DevToolsActivePort` 第一行；
 *   2. 读 cookie 用 `Storage.getCookies`，httpOnly 的 `login_oneday_ticket` /
 *      `oneday_sid` 及两个 `.sig` 一次全拿到，不必解 Keychain；
 *   3. 迁移/清理 profile 目录前必须等子进程真的退出：Windows 上 lockfile 还占
 *      着，rename 必 EBUSY。
 *
 * 只用 Node 自带的 WebSocket（22+ 全局可用），不引依赖。
 *
 * @module dsh-get-it-for-free/meoo-web/login
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { resolveDshHome } from '../store.js'

/** 登录页。 */
export const MEEO_WEB_LOGIN_URL = 'https://meoo.com/'

/** profile 根目录名（挂在 DSH_HOME/get-it-for-free 下面）。 */
const PROFILE_DIR_NAME = 'meoo-profiles'

/** 「添加新账号」用的固定分区：每次打开前清空。 */
export const STAGING_PROFILE = '_staging'

/** 出网 UA：和 session.js 用的是同一个桌面 Chrome 标识。 */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const POLL_MS = 1_500
const PORT_TIMEOUT_MS = 20_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** profile 根目录。 */
export function profileRoot() {
  return path.join(resolveDshHome(), 'get-it-for-free', PROFILE_DIR_NAME)
}

/** 账号 id → 目录名：只留安全字符，去前导点，截 80 字符。 */
export function sanitizeProfileName(accountId) {
  return String(accountId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
}

/** 某个账号自己的 profile 目录。 */
export function profileDirFor(accountId) {
  const name = sanitizeProfileName(accountId)
  return name === '' ? '' : path.join(profileRoot(), name)
}

/** staging 分区目录。 */
export function stagingProfileDir() {
  return path.join(profileRoot(), STAGING_PROFILE)
}

function browserCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]
    return roots
      .filter(Boolean)
      .flatMap(root => [
        path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
        path.join(root, 'Google/Chrome/Application/chrome.exe'),
        path.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      ])
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

/** 找一台能开窗口的系统浏览器；一个都没有时返回空串（调用方退回手贴 Cookie）。 */
export function findSystemBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * 启动参数。
 *
 * 登录窗**不吃** `--no-sandbox`：那个只该给 headless 用，登录窗要加载真实页面
 * 并输密码，沙箱关掉等于把用户密码暴露在没有隔离的进程里。
 *
 * @param {{profileDir: string, headless?: boolean, url?: string}} options
 */
export function buildBrowserArgs({ profileDir, headless = false, url = MEEO_WEB_LOGIN_URL }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
  ]
  if (headless === true) args.push('--headless=new')
  if (url !== '') args.push(url)
  return args
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 一个极小的 CDP 客户端：只发请求、等同 id 的回复，事件一律丢弃。 */
export function connect(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('这个 Node 版本没有内置 WebSocket（需要 22 以上）'))
      return
    }
    const socket = new WebSocket(url)
    const pending = new Map()
    let counter = 0
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* 已经关了 */ }
      reject(new Error('连不上调试端口'))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params) {
          counter += 1
          const id = counter
          return new Promise((done, fail) => {
            const failTimer = setTimeout(() => {
              pending.delete(id)
              fail(new Error(`${method} 超时`))
            }, timeoutMs)
            pending.set(id, { done, fail, failTimer })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          try { socket.close() } catch { /* 已经关了 */ }
        },
      })
    })
    socket.addEventListener('message', event => {
      let payload = null
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      const row = payload?.id !== undefined ? pending.get(payload.id) : undefined
      if (!row) return
      pending.delete(payload.id)
      clearTimeout(row.failTimer)
      if (payload.error) row.fail(new Error(payload.error.message ?? 'CDP 调用失败'))
      else row.done(payload.result ?? {})
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('调试端口拒绝连接'))
    })
  })
}

async function readJson(url, timeoutMs = 2_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 等子进程真的退出（迁移目录之前必须做，Windows 上否则 EBUSY）。 */
async function awaitExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child === null || child === undefined) return true
    if (child.exitCode !== null || child.signalCode !== null) return true
    await sleep(100)
  }
  return false
}

/** 收掉登录窗：先 SIGTERM，不肯走就 SIGKILL；返回有没有等它真退出。 */
export async function closeBrowser(child) {
  if (child === null || child === undefined) return true
  if (child.exitCode !== null || child.signalCode !== null) return true
  try { child.kill('SIGTERM') } catch { /* 已经没了 */ }
  if (await awaitExit(child, 5_000)) return true
  try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
  return awaitExit(child, 2_000)
}

/** 等浏览器把真实调试端口写进 DevToolsActivePort 第一行。 */
async function readDevtoolsPort(profileDir, child) {
  const file = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + PORT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child !== null && child !== undefined && child.exitCode !== null) {
      throw new Error('浏览器启动后立刻退出了（profile 目录可能被另一个进程占着）')
    }
    try {
      const first = String(await readFile(file, 'utf8')).split('\n')[0].trim()
      if (/^\d+$/.test(first)) return Number(first)
    } catch { /* 还没写出来 */ }
    await sleep(200)
  }
  throw new Error('等不到调试端口（浏览器没起来，或 profile 目录被占用）')
}

/** 在已启动的浏览器里找那个能发 CDP 的页面。 */
async function waitForPage(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child !== null && child !== undefined && child.exitCode !== null) {
      throw new Error('浏览器启动后立刻退出了')
    }
    const rows = await readJson(`http://127.0.0.1:${port}/json/list`)
    if (Array.isArray(rows)) {
      const page = rows.find(row => row?.type === 'page' && typeof row.webSocketDebuggerUrl === 'string' && row.webSocketDebuggerUrl !== '')
      if (page !== undefined) return page.webSocketDebuggerUrl
    }
    await sleep(300)
  }
  throw new Error('浏览器起来了，但没有可操作的页面')
}

/** 读全套 cookie（含 httpOnly）。Storage 域优先，老内核退 Network 域。 */
async function readAllCookies(client) {
  try {
    const result = await client.send('Storage.getCookies', {})
    if (Array.isArray(result?.cookies)) return result.cookies
  } catch { /* 换下一个域 */ }
  const result = await client.send('Network.getAllCookies', {})
  return Array.isArray(result?.cookies) ? result.cookies : []
}

/** cookie 数组 → 只留某个站点的请求头。 */
export function cookieHeaderFor(cookies, domain = 'meoo.com') {
  return (Array.isArray(cookies) ? cookies : [])
    .filter(cookie => String(cookie?.domain ?? '').includes(domain))
    .filter(cookie => typeof cookie?.name === 'string' && cookie.name !== '')
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

/** 请求头里是否已经带齐了那几个必需的 cookie。 */
function hasCookies(header, names) {
  const want = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name !== '') : []
  if (want.length === 0) return header !== ''
  const have = new Set(String(header).split(';').map(part => part.split('=')[0].trim()))
  return want.every(name => have.has(name))
}

/**
 * 打开一个浏览器分区，等用户在里面登录完，把 cookie 头读回来。
 *
 * 用户中途关窗（进程退出）不算成功：收尾时把已经读到的 cookie 之外的一切都
 * 交给调用方判断，这里只负责「读到了就返回」。
 *
 * @param {string} profileDir
 * @param {{headless?: boolean, timeoutMs?: number, requireCookies?: Array<string>,
 *          domain?: string, url?: string, browser?: string}} options
 * @returns {Promise<{cookieHeader: string, browser: string, cookies: number}>}
 */
export async function collectViaBrowser(profileDir, options = {}) {
  const browser = typeof options?.browser === 'string' && options.browser !== ''
    ? options.browser
    : findSystemBrowser()
  if (browser === '') throw new Error('这台机器上没有找到可用的 Chrome / Edge，改用手贴 Cookie 吧')
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const domain = typeof options?.domain === 'string' && options.domain !== '' ? options.domain : 'meoo.com'
  await mkdir(profileDir, { recursive: true })

  let child = null
  let client = null
  try {
    child = spawn(browser, buildBrowserArgs({ profileDir, headless: options?.headless === true, url: options?.url ?? MEEO_WEB_LOGIN_URL }), { stdio: 'ignore' })
    const port = await readDevtoolsPort(profileDir, child)
    const wsUrl = await waitForPage(port, child)
    client = await connect(wsUrl)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child !== null && child.exitCode !== null) break
      const cookies = await readAllCookies(client)
      const header = cookieHeaderFor(cookies, domain)
      if (hasCookies(header, options?.requireCookies)) {
        return { cookieHeader: header, browser, cookies: cookies.length }
      }
      await sleep(POLL_MS)
    }
    throw new Error('等登录超时了：窗口里完成 meoo.com 的登录再试，或直接手贴 Cookie')
  } finally {
    if (client !== null) client.close()
    // 先收进程再返回：调用方紧接着要迁移/清理这个目录。
    await closeBrowser(child)
  }
}

/**
 * 清掉一个 profile 目录（「添加新账号」每次打开登录窗之前都要做）。
 *
 * @param {string} profileDir
 */
export async function resetProfile(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return false
  try {
    await rm(profileDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 把 staging 分区迁移成账号自己的分区。
 *
 * rename 在同一块盘上是原子的，跨盘会 EXDEV；两种情况都退化到
 * 「复制 → 校验 → 删源」。任何一步失败都**不**动调用方的账号库。
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{ok: boolean, error?: string, method?: 'rename'|'copy'}>}
 */
export async function migrateProfile(from, to) {
  if (from === '' || to === '') return { ok: false, error: 'profile 路径无效' }
  if (from === to) return { ok: true, method: 'rename' }
  try {
    await rm(to, { recursive: true, force: true })
    const { rename } = await import('node:fs/promises')
    await rename(from, to)
    return { ok: true, method: 'rename' }
  } catch { /* EXDEV / 占用：退化成复制 */ }
  try {
    await cp(from, to, { recursive: true, force: true, errorOnExist: false })
    // 校验：目标目录里得有东西，空目录等于没迁过来。
    const rows = await readdir(to)
    if (rows.length === 0) return { ok: false, error: '复制后目标目录是空的' }
    await rm(from, { recursive: true, force: true })
    return { ok: true, method: 'copy' }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 160) }
  }
}

/**
 * 探一次身份：`/api/v1/user/me`。
 *
 * 只有 401/403 才算「这份登录态死了」；断网、超时、5xx、429 一律回
 * `{dead: false, user: null}` —— 那些是上游或网络的事，不该把账号判死。
 *
 * @param {string} cookieHeader
 * @returns {Promise<{dead: boolean, status: number, user: any|null, userId: string, error?: string}>}
 */
export async function probeMeooUser(cookieHeader, options = {}) {
  const header = typeof cookieHeader === 'string' ? cookieHeader.trim() : ''
  if (header === '') return { dead: true, status: 0, user: null, userId: '', error: '没有 cookie' }
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://meoo.com/api/v1/user/me', {
      headers: { cookie: header, 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { dead: true, status: response.status, user: null, userId: '' }
    }
    if (!response.ok) return { dead: false, status: response.status, user: null, userId: '' }
    const body = await response.json().catch(() => null)
    const data = body?.data
    if (data === null || typeof data !== 'object') {
      // 200 但 data 是 null：网页对未登录态就是这么回的，等同于授权失败。
      return { dead: true, status: response.status, user: null, userId: '' }
    }
    return { dead: false, status: response.status, user: data, userId: userIdOf(data) }
  } catch (error) {
    return { dead: false, status: 0, user: null, userId: '', error: String(error?.message ?? error).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/** 从 /user/me 的返回里挑 user_id（字段名各家写法不一，都认）。 */
export function userIdOf(user) {
  if (user === null || typeof user !== 'object') return ''
  for (const key of ['id', 'userId', 'user_id', 'uid']) {
    const value = user[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}
