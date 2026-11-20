// 豆包的 cookie 会自己烂掉，而且烂得很安静。
//
// 上游认的不是「这个账号」，是 cookie 里当前那一份 sessionid + s_v_web_id：
// 网页端每开一次页面都会重铸 s_v_web_id，登录态续期时还会换 sessionid。
// 插件里存的那份过几小时就成了旧号，请求能通、HTTP 200，但首帧就是
// 710022004（shark_admin / verify / semantic_reasoning），用户看到的是
// 「该内容涉嫌违反豆包使用规范」。实测：同一台机器、同一账号，把 cookie
// 换成浏览器里当前那份，立刻正常出流；换回去立刻就拦 —— 也就是说这跟
// 内容、跟指纹参数、跟设备 id 都无关，纯粹是那份 cookie 过期了。
//
// 所以这里干一件事：从本机浏览器的 cookie 库里把豆包那一份读出来。读得到
// 就用来对齐账号里的 cookie，读不到（没装浏览器 / App-Bound 加密 / 没授权）
// 就安静地返回空，交给上层维持原样。

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DOMAIN_HINT = 'doubao'
// 这些字段决定上游认不认这次请求，同步时以浏览器为准。
const KEY_COOKIES = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 's_v_web_id', 'ttwid', 'uid_tt', 'uid_tt_ss']
// 一个 profile 里必须同时有这些，才算「这个站点登过」；缺一个就当没登。
const REQUIRED_COOKIES = ['s_v_web_id', 'sessionid']
// 多账号配对时用的那个字段名：值唯一，能认人。
const IDENTITY_COOKIE = 'sessionid'

function run(file, args, timeoutMs = 4_000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? '').trim())
    })
  })
}

// macOS 的 key 在钥匙串，Chromium 用 PBKDF2-SHA1(salt='saltysalt', 1003 轮)；
// Linux 是写死的 'peanuts' + 1 轮。Windows 走 DPAPI，这条路先不碰。
async function deriveKey(safeStorageService) {
  if (process.platform === 'darwin') {
    const password = await run('security', ['find-generic-password', '-w', '-s', safeStorageService])
    if (password === '') return null
    return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  }
  if (process.platform === 'linux') {
    return pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
  }
  return null
}

function decryptValue(key, buffer) {
  if (!buffer || buffer.length === 0) return ''
  const head = buffer.subarray(0, 3).toString('latin1')
  // v20 = App-Bound Encryption：密钥绑在浏览器进程上，进程外解不开。
  if (head === 'v20') return ''
  if (head !== 'v10') return buffer.toString('utf8')
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    let out = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()])
    // Chrome 130 起在明文前塞了 32 字节的域名 SHA256，去掉才是值。
    if (out.length > 32) out = out.subarray(32)
    return out.toString('utf8')
  } catch {
    return ''
  }
}

// doubaoOnly 的两个是豆包自家的桌面端（Chromium 内核、同一套 v10 加密）：
// 豆包 App 与「豆包工作」是两个独立软件，谁登着都算有效来源。它们只可能存豆包的
// cookie，别的渠道（秒悟/MiMo）扫它们纯属浪费钥匙串调用，所以按 domainHint 关掉。
const BROWSERS = [
  { id: 'chrome', darwin: ['Library/Application Support/Google/Chrome', 'Chrome Safe Storage'], linux: ['.config/google-chrome', ''] },
  { id: 'edge', darwin: ['Library/Application Support/Microsoft Edge', 'Microsoft Edge Safe Storage'], linux: ['.config/microsoft-edge', ''] },
  { id: 'brave', darwin: ['Library/Application Support/BraveSoftware/Brave-Browser', 'Brave Safe Storage'], linux: ['.config/BraveSoftware/Brave-Browser', ''] },
  { id: 'chromium', darwin: ['Library/Application Support/Chromium', 'Chromium Safe Storage'], linux: ['.config/chromium', ''] },
  // 实测（scripts/probes/archive/_db-work-cookie.mjs）：豆包桌面端的钥匙串项名是
  // "Doubao Browser Safe Storage"，"Doubao Safe Storage" 解不开；聊天主数据在
  // Profile 3 而不是 Default。
  { id: 'doubao-desktop', darwin: ['Library/Application Support/Doubao', 'Doubao Browser Safe Storage'], linux: ['.config/Doubao', 'Doubao Browser Safe Storage'], doubaoOnly: true },
  { id: 'doubao-work', darwin: ['Library/Application Support/DoubaoWork', 'DoubaoWork Browser Safe Storage'], linux: ['.config/DoubaoWork', 'DoubaoWork Browser Safe Storage'], doubaoOnly: true },
]

async function profileDirs(root) {
  const out = []
  const names = ['Default', ...Array.from({ length: 20 }, (_, index) => `Profile ${index + 1}`)]
  for (const name of names) out.push(path.join(root, name))
  return out
}

/** 复制一份 cookie 库出来再读（不锁用户正在用的库），取出某个站点的 cookie。 */
async function readCookiesFile(source, key, domainHint) {
  let dir = ''
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-doubao-ck-'))
    await copyFile(source, path.join(dir, 'Cookies'))
    // WAL 里可能有比主库更新的行，一起带上；没有就算了。
    for (const suffix of ['-wal', '-shm']) {
      await copyFile(source + suffix, path.join(dir, `Cookies${suffix}`)).catch(() => {})
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(dir, 'Cookies'))
    let rows = []
    try {
      rows = db.prepare("SELECT name, encrypted_value, value FROM cookies WHERE host_key LIKE ?").all(`%${domainHint}%`)
    } finally {
      db.close?.()
    }
    const jar = new Map()
    for (const row of rows) {
      const raw = row.value || decryptValue(key, Buffer.from(row.encrypted_value ?? []))
      if (typeof raw === 'string' && raw !== '') jar.set(String(row.name), raw)
    }
    return jar
  } catch {
    return null
  } finally {
    if (dir !== '') await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 从一个 profile 目录里取豆包 cookie。
 *
 * Chromium 从 96 起把库挪到了 `<profile>/Network/Cookies`：Chrome/Edge 现在走的
 * 都是新路径，豆包、豆包工作这两个桌面端同样是新路径。先按老路径试，读不到再退
 * 到新路径 —— 两个路径可能同时存在，优先老路径不影响任何现役浏览器。
 *
 * 导出是为了离线探针（scripts/probes/t11_db_ui.mjs）能用 mock 库验证来源解析：
 * 上层 browserCookieSnapshot 要过钥匙串，测试里解不开，只能从这一层验。
 */
export async function readProfileCookies(profile, key, domainHint) {
  for (const relative of ['Cookies', path.join('Network', 'Cookies')]) {
    const jar = await readCookiesFile(path.join(profile, relative), key, domainHint)
    if (jar !== null && jar.size > 0) return jar
  }
  return null
}

/** sid_guard = "<sessionid>|<签发时间>|<有效期>|<到期时间>"；浏览器库里是 %7C 编码的。 */
function issuedAt(jar) {
  const guard = decodeURIComponent(jar.get('sid_guard') ?? '')
  const [, issued] = guard.split('|')
  const value = Number(issued)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 从本机浏览器里捞当前那份 cookie。
 * domainHint 换个站点就能复用（豆包默认；秒悟网页版传 'meoo.com'）。
 * 返回 { cookieHeader, jar, browser }；捞不到返回 null。
 */
export async function browserCookieSnapshot({
  preferSessionId = '',
  domainHint = DOMAIN_HINT,
  requireCookies = REQUIRED_COOKIES,
  sessionCookie = IDENTITY_COOKIE,
  // 上次命中的那个 profile 目录（绝对路径）。给了就先只读它，命中就收工：
  // healAccount 每次都要解 4 个浏览器的钥匙串、扫 21 个目录，太贵。
  // 没登过 / 解不开 / 不是要找的那个号，就照旧全扫 —— 向后兼容，不传等于没有。
  preferredProfile = '',
} = {}) {
  if (process.platform === 'win32') return null
  const home = os.homedir()
  const roots = []
  for (const browser of BROWSERS) {
    // 桌面端只可能存豆包 cookie：非豆包场景（秒悟 'meoo.com' 等）跳过，
    // 省掉两次钥匙串调用。
    if (browser.doubaoOnly === true && domainHint !== DOMAIN_HINT) continue
    const [relative, service] = process.platform === 'darwin' ? browser.darwin : browser.linux
    roots.push({ id: browser.id, root: path.join(home, relative), service })
  }

  /** 读一个 profile；这个站点没登过就返回 null。 */
  async function readOne(browserId, profile, key) {
    const jar = await readProfileCookies(profile, key, domainHint)
    if (!jar || jar.size === 0) return null
    if (!requireCookies.every(name => jar.has(name))) return null
    return { jar, stamp: issuedAt(jar), browser: browserId, profile }
  }

  const found = []
  const wanted = typeof preferredProfile === 'string' ? preferredProfile : ''
  // ① 先试上次命中的那个 profile。多账号时只有 sessionid 也对得上才算数：
  //    把 B 号的 cookie 盖到 A 号上会直接换人，宁可多扫一遍。
  if (wanted !== '') {
    const owner = roots.find(row => wanted.startsWith(row.root + path.sep))
    if (owner) {
      const key = await deriveKey(owner.service)
      const hit = key === null ? null : await readOne(owner.id, wanted, key)
      if (hit !== null && (preferSessionId === '' || hit.jar.get(sessionCookie) === preferSessionId)) found.push(hit)
    }
  }
  // ② 没命中（或者要换号）才全扫；刚才读过的那一个目录跳过。
  if (found.length === 0) {
    for (const row of roots) {
      const key = await deriveKey(row.service)
      if (key === null) continue
      for (const profile of await profileDirs(row.root)) {
        if (profile === wanted) continue
        const hit = await readOne(row.id, profile, key)
        if (hit !== null) found.push(hit)
      }
    }
  }
  if (found.length === 0) return null
  // 多账号时按 sessionid 配对：把 B 账号的浏览器 cookie 盖到 A 账号上会直接换号。
  const exact = preferSessionId === '' ? null : found.find(row => row.jar.get(sessionCookie) === preferSessionId)
  const best = exact ?? found.reduce((a, b) => (b.stamp > a.stamp ? b : a))
  const parts = []
  for (const [name, value] of best.jar) parts.push(`${name}=${value}`)
  const candidates = found.map(row => ({
    browser: row.browser,
    profile: row.profile,
    issuedAt: row.stamp,
    cookieHeader: [...row.jar].map(([name, value]) => `${name}=${value}`).join('; '),
  }))
  return {
    browser: best.browser,
    profile: best.profile,
    jar: best.jar,
    issuedAt: best.stamp,
    cookieHeader: parts.join('; '),
    candidates,
  }
}

function parseJar(cookieHeader) {
  const jar = new Map()
  for (const part of String(cookieHeader ?? '').split(';')) {
    const row = part.trim()
    if (row === '') continue
    const index = row.indexOf('=')
    if (index <= 0) continue
    jar.set(row.slice(0, index), row.slice(index + 1))
  }
  return jar
}

export function serializeJar(jar) {
  const parts = []
  for (const [name, value] of jar) parts.push(`${name}=${value}`)
  return parts.join('; ')
}

/**
 * 把浏览器那份并进账号里存的 cookie。
 * 只有真正更「新」才覆盖：浏览器里 s_v_web_id 不同、或 sid_guard 的签发时间更晚。
 * 返回 { cookieHeader, changed, reason }。
 */
export function mergeCookie(stored, snapshot) {
  const current = parseJar(stored)
  if (!snapshot) return { cookieHeader: String(stored ?? ''), changed: false, reason: 'no-browser' }
  const incoming = snapshot.jar
  const storedFp = current.get('s_v_web_id') ?? ''
  const liveFp = incoming.get('s_v_web_id') ?? ''
  const storedIssued = issuedAt(current)
  const newer = storedFp !== liveFp || snapshot.issuedAt > storedIssued
  if (!newer) return { cookieHeader: String(stored ?? ''), changed: false, reason: 'stored-is-fresh' }

  const next = new Map(current)
  // 整体以浏览器为准：先补齐账号里缺的，再用浏览器的关键字段盖掉旧的。
  for (const [name, value] of incoming) if (!next.has(name)) next.set(name, value)
  for (const name of KEY_COOKIES) if (incoming.has(name)) next.set(name, incoming.get(name))
  // 其余同名项（主题、语言之类的偏好）保留账号里的，不值得为了它们覆盖用户设置。
  return {
    cookieHeader: serializeJar(next),
    changed: true,
    reason: storedFp !== liveFp ? 'fresh-fingerprint' : 'fresh-session',
  }
}
