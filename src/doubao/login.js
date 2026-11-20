// 豆包登录：点一下就开一个干净的浏览器，你在里面扫码/输密码，
// 插件在旁边通过 CDP 把 cookie 读走，读到就关窗、存账号。
//
// 为什么不像 MiMo 那样直接读桌面客户端的库：豆包工作的 Cookies 是加密的
// （macOS 上每一行都是 encrypted_value），钥匙挂在系统钥匙串里；而且客户端
// 运行时会独占那个库。这种「开自己的浏览器、登完就抓」的做法不需要解任何密，
// 抓到的就是刚登录的那一份，天然一个账号一份凭据——和 dsh-connect-doubao
// 后来改走的路子一样。
//
// 只用 Node 自带的 WebSocket（Node 22+ 全局可用），不引依赖。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { hasSession, uidFromCookie } from './client.js'

const LOGIN_URL = 'https://www.doubao.com/chat/'
const POLL_MS = 1_500
const START_TIMEOUT_MS = 20_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
// 这些 cookie 只跟飞书套件有关，又长又没用，不塞进请求头
const SKIP_COOKIE = /^LARK_SUITE_|^feishu_dpop_keypair$/

function browserCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork',
      '/Applications/豆包工作.app/Contents/MacOS/DoubaoWork',
    ]
  }
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]
    return roots
      .filter(Boolean)
      .flatMap(root => [
        path.join(root, 'Google/Chrome/Application/chrome.exe'),
        path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
        path.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      ])
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

export function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

// 一个极小的 CDP 客户端：只发请求、等同 id 的回复，事件一律丢弃。
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
      try {
        socket.close()
      } catch {}
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
          try {
            socket.close()
          } catch {}
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

function headerFromCookies(cookies, domain) {
  return cookies
    .filter(cookie => String(cookie?.domain ?? '').includes(domain))
    .filter(cookie => !SKIP_COOKIE.test(String(cookie?.name ?? '')))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

/**
 * 开一个干净浏览器、让用户登进去、再用 CDP 把 cookie 抓走。
 *
 * 默认那套参数是豆包的；秒悟网页版（meoo.com）这类「登录态就是 cookie」的站点
 * 换 loginUrl / domain / isSignedIn 就能复用同一套流程。
 */
export function createLoginFlow({
  logger,
  addAccount,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  loginUrl = LOGIN_URL,
  domain = 'doubao.com',
  isSignedIn = hasSession,
} = {}) {
  let state = { status: 'idle', at: 0, account: null, error: null, browser: '', steps: [] }
  let running = null
  const hostPattern = new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // 豆包能从 sessionid 里解出 uid；别的站点没有这个字段，解不出来就不写
  function cookieUid(header) {
    try { return uidFromCookie(header) } catch { return '' }
  }

  function snapshot() {
    return { ...state, steps: [...state.steps] }
  }

  async function waitForPage(port, child, pattern = /doubao\.com/) {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('浏览器启动后立刻退出了')
      const targets = await readJson(`http://127.0.0.1:${port}/json/list`)
      if (Array.isArray(targets)) {
        const page = targets.find(row => row.type === 'page' && pattern.test(String(row.url ?? ''))) ??
          targets.find(row => row.type === 'page')
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      }
      await sleep(300)
    }
    throw new Error('浏览器起来了但没找到页面（可能在等首启提示）')
  }

  async function loop(child, profileDir) {
    const portFile = path.join(profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + START_TIMEOUT_MS
    let port = 0
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(portFile, 'utf8')
        const first = raw.split('\n')[0]?.trim() ?? ''
        if (/^\d+$/.test(first)) {
          port = Number(first)
          break
        }
      } catch {}
      if (child.exitCode !== null) throw new Error('浏览器启动失败（可能是 profile 目录被占用）')
      await sleep(200)
    }
    if (port === 0) throw new Error('浏览器没有开放调试端口')
    state.steps.push({ step: 'browser', port })

    const wsUrl = await waitForPage(port, child, hostPattern)
    const client = await connect(wsUrl)
    state.steps.push({ step: 'cdp', url: loginUrl })
    try {
      const deadline2 = Date.now() + timeoutMs
      while (Date.now() < deadline2) {
        if (state.status === 'canceled') return null
        if (child.exitCode !== null) throw new Error('浏览器被关掉了')
        const { cookies } = await client.send('Network.getAllCookies', {})
        const header = headerFromCookies(Array.isArray(cookies) ? cookies : [], domain)
        if (header !== '' && isSignedIn(header)) {
          state.steps.push({ step: 'cookie', uid: cookieUid(header) })
          return header
        }
        await sleep(POLL_MS)
      }
      throw new Error('等了五分钟还没登录上，重开一次就行')
    } finally {
      client.close()
    }
  }

  async function start() {
    if (running) return snapshot()
    state = { status: 'waiting', at: Date.now(), account: null, error: null, browser: '', steps: [] }
    running = (async () => {
      let child = null
      let profileDir = ''
      try {
        const browser = findBrowser()
        if (browser === '') throw new Error('没找到 Chrome / Edge / Brave / 豆包工作，改成手动粘贴')
        state.browser = browser
        profileDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-doubao-login-'))
        child = spawn(
          browser,
          [
            `--user-data-dir=${profileDir}`,
            '--remote-debugging-port=0',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate,MediaRouter',
            loginUrl,
          ],
          { stdio: 'ignore' },
        )
        const header = await loop(child, profileDir)
        if (header === null) {
          state = { ...state, status: state.status === 'canceled' ? 'canceled' : 'idle', error: null }
          return
        }
        const saved = await addAccount({ cookie: header, name: '' })
        state = { ...state, status: 'done', account: saved?.account ?? null, error: null }
        logger?.info?.(`[doubao] 登录完成，账号 ${saved?.account?.id ?? '?'}`)
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 200)
        logger?.warn?.(`[doubao] 登录失败：${message}`)
        state = { ...state, status: 'error', error: message }
      } finally {
        if (child !== null && child.exitCode === null) {
          try {
            child.kill('SIGTERM')
          } catch {}
        }
        if (profileDir !== '') {
          // 让浏览器把锁放开再删；删不掉就留着，系统临时目录会自己清
          setTimeout(() => {
            void rm(profileDir, { recursive: true, force: true }).catch(() => {})
          }, 3_000)
        }
        running = null
      }
    })()
    return snapshot()
  }

  function cancel() {
    if (running === null) return snapshot()
    state = { ...state, status: 'canceled' }
    return snapshot()
  }

  return { start, status: snapshot, cancel, get busy() { return running !== null } }
}
