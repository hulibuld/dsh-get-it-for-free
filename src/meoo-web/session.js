/**
 * 秒悟网页（meoo.com）会话层。
 *
 * 这条通道用**用户自己在浏览器里的登录态**，不自己造账号、不自己刷令牌：
 *
 *   1. 插件自己的凭据文件 `~/.dsh/get-it-for-free/meoo-web.json`（可能是用户贴的，
 *      也可能是 `adoptBrowserCookie()` 自动从本机 Chrome 抄来的）；
 *   2. 其次 `~/.meoo/credentials.json` 里的 `accessToken`（官方 CLI 登录后落盘的
 *      那份，只读，不写回去）。
 *
 * 没有任何凭据时，`provider.js` 会先调一次 `adoptBrowserCookie()`：直接去本机
 * Chrome / Edge / Brave 的 cookie 库里把 meoo.com 的登录态端过来，用户不必再手贴
 * Cookie。终归读不到（没装浏览器、没登过、解密不出来）就安静退回粘贴流程。
 *
 * 401/403 一律**直接**报 NEED_LOGIN 给用户，不静默重试、不自动刷新：网页的
 * 刷新令牌是单代际的，插件抢着刷会把用户浏览器里的那份用废，用户下次打开
 * meoo.com 就得重新登录。宁可让用户重贴一次 Cookie。
 *
 * 上游三个端点（从网页 bundle 反出来的真路径）：
 *   - `GET  /api/v1/agent/models`           模型目录
 *   - `POST /api/agent/start`               发起一轮（正文是单条 `message`）
 *   - `GET  /api/agent/query?projectId=…`   该项目的 SSE 事件流
 *
 * @module dsh-get-it-for-free/meoo-web/session
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { browserCookieSnapshot, serializeJar } from '../doubao/chromecookie.js'
import { resolveDshHome } from '../store.js'
import {
  accountSecret,
  loadStore,
  mintAccountId,
  nicknameOf,
  pickActiveId,
  pickUsableAccount,
  publicAccount,
  sessionIdOf,
  writeStore,
} from './account-store.js'
import { userIdOf } from './login.js'

/** 网页站点的 origin。 */
export const MEEO_WEB_ORIGIN = 'https://meoo.com'

/** 浏览器里找哪个站点的 cookie。 */
export const MEEO_WEB_DOMAIN_HINT = 'meoo.com'

/**
 * 一个 profile 里必须同时有这两个，才算「这台机器的浏览器登过秒悟」。
 *
 * 秒悟网页的整套请求都是 `credentials: "include"`（bundle 里没有任何 Authorization
 * 分支），登录态就落在这对令牌上：`oneday_sid` 是会话 id，`login_oneday_ticket` 是
 * 续期票据，两个 `.sig` 是它们的签名（跟着 jar 一起发出去）。实测：把这对删掉之后
 * `/api/v1/project/ensure` 立刻回 401 NEED_LOGIN。
 *
 * 注意它只证明「浏览器里有登录记录」，不证明「这份还能用」——有效期由 probeAuth 判。
 */
export const MEEO_WEB_REQUIRED_COOKIES = ['login_oneday_ticket', 'oneday_sid']

/** 上游端点。 */
export const MEEO_WEB_APIS = {
  models: '/api/v1/agent/models',
  // 探针：匿名回 200 但 data 是 null，登录态才给用户对象。项目列表匿名叫也 200、
  // 形状一模一样，ensure 在应用不存在时回 403，两者都不能当探针。
  userMe: '/api/v1/user/me',
  start: '/api/agent/start',
  stop: '/api/agent/stop',
  query: '/api/agent/query',
  projectList: '/api/v1/project/list',
  // 建项目：POST {name} → data.{id,url_id}。旧的 /api/v1/project/ensure 现在 404。
  projectCreate: '/api/v1/project',
  // 额度不在这套 /api/v1 下面：网页自己走 monetization 服务的 /api/mc，
  // 余额在 data.userPointInfo.account.availableBalance（实测 65728 积分），
  // 套餐期内配额在 data.benefits[typeCode='model_credits'].{quota,used}。
  // `/api/mc/entitlement/member/credits` 对个人版回 403「当前版本不支持此接口」。
  entitlement: '/api/mc/entitlement/get',
}

/**
 * 出网 UA。
 *
 * 网页自己的接口挑 UA：拿 axios 那种一眼是脚本的标识去问 `/api/v1/agent/models`，
 * 多数站点会先给一页 HTML 再说。这里用桌面 Chrome 的常规标识，不带任何来源信息。
 */
export const MEEO_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 请求超时（毫秒）。模型目录与项目接口都是秒回的东西。 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 需要用户重新登录。
 *
 * 单独一个类是为了让上层能区分「凭据没了」和「上游坏了」：前者要在卡片上写
 * 一句可执行的提示，后者写原因就够。
 */
export class NeedLoginError extends Error {
  constructor(message = '秒悟网页的登录态失效了（NEED_LOGIN），请重新贴一次 Cookie') {
    super(message)
    this.name = 'NeedLoginError'
    this.code = 'NEED_LOGIN'
  }
}

/** 插件自己的凭据落盘位置（现在由 account-store 统一管，这里只是别名）。 */
export function statePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'meoo-web.json')
}

/**
 * 读「当前账号」那份凭据。
 *
 * 落盘已经升级成多账号（见 `account-store.js`），但对外仍保留这个老形状：
 * `{token, cookie, savedAt, source}` —— provider 与自检脚本都按它读，改成数组
 * 会让所有调用点一起改，收益为零。想看全部账号用 `accountList()`。
 *
 * @returns {{token: string, cookie: string, savedAt: number, source: string}} 缺失的字段是空串。
 */
export function readStored() {
  const account = pickUsableAccount(loadStore())
  if (account === null) return { token: '', cookie: '', savedAt: 0, source: 'user' }
  return {
    token: typeof account.token === 'string' ? account.token : '',
    cookie: typeof account.cookie === 'string' ? account.cookie : '',
    savedAt: Number(account.lastUsedAt) || Number(account.addedAt) || 0,
    source: account.source === 'browser' ? 'browser' : account.source === 'cli' ? 'cli' : 'user',
  }
}

/**
 * 覆盖写入「当前账号」的凭据（目录不存在就建）。
 *
 * 没有当前账号时新建一条并设为 active —— 用户第一次贴 Cookie 走的就是这条路。
 *
 * @param next - `{token, cookie, source}`；两个都空等于清空。
 */
export function writeStored(next) {
  const token = typeof next?.token === 'string' ? next.token.trim() : ''
  const cookie = typeof next?.cookie === 'string' ? next.cookie.trim() : ''
  if (token === '' && cookie === '') {
    clearStored()
    return
  }
  const store = loadStore()
  const active = pickUsableAccount(store)
  const source = next?.source === 'browser' ? 'browser' : next?.source === 'cli' ? 'cli' : 'user'
  if (active === null) {
    const fresh = {
      id: mintAccountId(),
      nickname: '秒悟',
      cookie,
      token,
      source,
      user: null,
      enabled: true,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
    }
    writeStore({ ...store, accounts: [...store.accounts, fresh], activeAccountId: fresh.id })
    return
  }
  const accounts = store.accounts.map(row => (row.id === active.id
    ? { ...row, cookie, token, source, lastUsedAt: Date.now() }
    : row))
  writeStore({ ...store, accounts, activeAccountId: active.id })
}

/** 删掉当前账号（没有就什么都不做）。 */
export function clearStored() {
  const store = loadStore()
  const active = pickUsableAccount(store)
  if (active === null) return
  const accounts = store.accounts.filter(row => row.id !== active.id)
  writeStore({ ...store, accounts, activeAccountId: pickActiveId(accounts, '') })
}

/**
 * 卡片上的账号列表。
 *
 * @returns {{accounts: Array<any>, activeAccountId: string}} 行里不含 cookie/token。
 */
export function accountList() {
  const store = loadStore()
  const active = pickUsableAccount(store)
  return {
    accounts: store.accounts.map(row => publicAccount(row, active?.id ?? '')),
    activeAccountId: active?.id ?? '',
  }
}

/**
 * 在一堆账号里找出「同一份登录态」。
 *
 * 判据分两层：cookie 认 `oneday_sid`（`.sig` 会随请求滚动，整串比永远不相等）；
 * bare token 认全文。两者交叉认：新贴的是 cookie，就拿它的 sid 跟已有 cookie 比；
 * 新贴的是 token，就跟已有 token 比。
 *
 * @param {{accounts: Array<any>}} store
 * @param {{cookie?: string, token?: string}} next
 * @returns {any | null}
 */
function findDuplicateAccount(store, next) {
  const list = Array.isArray(store?.accounts) ? store.accounts : []
  const sid = sessionIdOf(next?.cookie ?? '')
  const token = typeof next?.token === 'string' ? next.token.trim() : ''
  const userId = typeof next?.userId === 'string' ? next.userId.trim() : ''
  for (const row of list) {
    if (sid !== '' && sessionIdOf(row.cookie ?? '') === sid) return row
    if (token !== '' && typeof row.token === 'string' && row.token.trim() === token) return row
    if (userId !== '' && typeof row.userId === 'string' && row.userId === userId) return row
  }
  return null
}

/**
 * 问一句「这份登录态在库里是哪一条」。
 *
 * 登录窗在**动 profile 目录之前**要用它先判断：是老号就原地更新、staging 丢弃；
 * 是新号才把 staging 迁移成该号的分区。判重必须发生在写入之前，否则迁移失败时
 * 库里会多出一条没有 profile 的账号。
 *
 * @param {{accounts: Array<any>}} store
 * @param {{cookie?: string, token?: string, userId?: string}} next
 * @returns {any | null}
 */
export function findExistingAccount(store, next) {
  return findDuplicateAccount(store, next)
}

/**
 * 把一份从登录窗里读回来的登录态入库。
 *
 * 与 `accountCreate()` 的差别只有两点，但两点都重要：
 *   1. **不切 active**：用户添加第二个账号时，聊天用的还该是原来那个；
 *   2. 认得上游的 `user_id`：同一 sid 已在库里就原地更新（cookie 轮换过、昵称变过），
 *      而不是多一行。返回 `created` 让上层知道要不要迁移 profile 目录。
 *
 * @param {{cookie: string, token?: string, user?: any, userId?: string,
 *          source?: 'browser'|'user', nickname?: string, id?: string}} input
 * @returns {{ok: boolean, created: boolean, account?: any, error?: string,
 *            accounts: Array<any>, activeAccountId: string}}
 */
export function accountCapture(input = {}) {
  const cookie = typeof input?.cookie === 'string' ? input.cookie.trim() : ''
  const token = typeof input?.token === 'string' ? input.token.trim() : ''
  if (cookie === '' && token === '') {
    return { ok: false, created: false, error: '登录窗里没读到 meoo.com 的登录态', ...accountList() }
  }
  const store = loadStore()
  const user = input?.user !== null && typeof input?.user === 'object' ? input.user : null
  // user_id 由调用方（登录窗）探过就带上；没给从 user 里挖，还挖不到就留空。
  const userId = typeof input?.userId === 'string' && input.userId.trim() !== ''
    ? input.userId.trim()
    : userIdOf(user)
  // 指定 id：登录窗在迁移 profile 之前就把新号 id 定好了（目录名要跟它对上），
  // 「重登此账号」也靠它指到具体那一行 —— 重新登录会换掉 oneday_sid，靠 sid
  // 是认不出老号的。
  const wantedId = typeof input?.id === 'string' ? input.id.trim() : ''
  const same = (wantedId === '' ? null : store.accounts.find(row => row.id === wantedId) ?? null)
    ?? findDuplicateAccount(store, { cookie, token, userId })
  if (same !== null) {
    // 老号：只把登录态与身份刷新一遍，昵称/启停/active 这些用户设定一律不动。
    const accounts = store.accounts.map(row => (row.id === same.id
      ? {
        ...row,
        cookie: cookie === '' ? row.cookie : cookie,
        token: token === '' ? row.token : token,
        user: user ?? row.user,
        userId: userId === '' ? row.userId : userId,
        source: input?.source === 'browser' ? 'browser' : row.source,
        // 重新登录过：之前那条「失效」的红标要摘掉。
        dead: false,
        deadReason: '',
        lastUsedAt: Date.now(),
      }
      : row))
    const written = writeStore({ ...store, accounts, activeAccountId: store.activeAccountId })
    const saved = written.store.accounts.find(row => row.id === same.id) ?? same
    return { ok: written.ok, created: false, account: publicAccount(saved, store.activeAccountId), ...accountList() }
  }
  const fresh = {
    // 登录窗已经按这个 id 建好 profile 目录了，这里必须沿用，否则目录与账号对不上。
    id: wantedId === '' ? mintAccountId() : wantedId,
    nickname: typeof input?.nickname === 'string' && input.nickname.trim() !== ''
      ? input.nickname.trim().slice(0, 64)
      : nicknameOf({ user }, '秒悟'),
    cookie,
    token,
    source: input?.source === 'browser' ? 'browser' : 'user',
    user,
    userId,
    enabled: true,
    dead: false,
    deadReason: '',
    addedAt: Date.now(),
    lastUsedAt: 0,
  }
  const written = writeStore({
    ...store,
    accounts: [...store.accounts, fresh],
    // 第一条账号才顺手设为 active；之后添加的都不抢当前。
    activeAccountId: store.accounts.length === 0 ? fresh.id : store.activeAccountId,
  })
  const saved = written.store.accounts.find(row => row.id === fresh.id) ?? fresh
  return { ok: written.ok, created: true, account: publicAccount(saved, written.store.activeAccountId), ...accountList() }
}

/**
 * 给某条账号挂上 / 摘掉失效标记。
 *
 * 只有授权类失败（401 / NEED_LOGIN）才该置位 —— 断网、超时、5xx 都不是「这份
 * 登录态没了」，把它们算进去会让卡片在飞机上满屏标红。
 *
 * @param {string} accountId
 * @param {{dead: boolean, reason?: string}} state
 */
export function markAccountDead(accountId, state = {}) {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  if (id === '') return { ok: false, error: '没有这条账号', ...accountList() }
  const store = loadStore()
  if (!store.accounts.some(row => row.id === id)) return { ok: false, error: '没有这条账号', ...accountList() }
  const dead = state?.dead === true
  const reason = dead ? String(state?.reason ?? '').trim().slice(0, 160) : ''
  const accounts = store.accounts.map(row => (row.id === id ? { ...row, dead, deadReason: reason } : row))
  const written = writeStore({ ...store, accounts, activeAccountId: store.activeAccountId })
  return { ok: written.ok, ...accountList() }
}

/**
 * 新建一条账号并设为当前。
 *
 * @param {{text: string, source?: 'user'|'cli', nickname?: string, user?: any}} input
 * @returns {{ok: boolean, account?: any, error?: string, accounts: Array<any>, activeAccountId: string}}
 */
export function accountCreate(input = {}) {
  const parsed = parsePasted(input?.text)
  if (parsed.token === '' && parsed.cookie === '') {
    return { ok: false, error: '没读到内容：贴 meoo.com 的 Cookie（形如 `k=v; k2=v2`）或一个 access token。', ...accountList() }
  }
  const store = loadStore()
  // 同一份登录态只该占一行。重复贴进来时如实告诉用户「已经是某某了」，
  // 而不是凭空多出一条点开必然同号的卡片。
  const same = findDuplicateAccount(store, { cookie: parsed.cookie, token: parsed.token })
  if (same !== null) {
    return { ok: false, duplicate: same.id, error: '这份登录态已经是账号「' + nicknameOf(same) + '」了', ...accountList() }
  }
  const fresh = {
    id: mintAccountId(),
    nickname: typeof input?.nickname === 'string' && input.nickname.trim() !== '' ? input.nickname.trim() : '秒悟',
    cookie: parsed.cookie,
    token: parsed.token,
    source: input?.source === 'cli' ? 'cli' : 'user',
    user: input?.user ?? null,
    enabled: true,
    addedAt: Date.now(),
    lastUsedAt: 0,
  }
  const written = writeStore({ ...store, accounts: [...store.accounts, fresh], activeAccountId: fresh.id })
  const saved = written.store.accounts.find(row => row.id === fresh.id) ?? fresh
  return { ok: written.ok, account: publicAccount(saved, fresh.id), ...accountList() }
}

/**
 * 切换当前账号。
 *
 * @param {string} accountId
 * @returns {{ok: boolean, error?: string, accounts: Array<any>, activeAccountId: string}}
 */
export function accountUse(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  const store = loadStore()
  const row = store.accounts.find(entry => entry.id === id)
  if (row === undefined) return { ok: false, error: '没有这条账号', ...accountList() }
  if (row.enabled === false) return { ok: false, error: '这条账号已停用，先启用再切换', ...accountList() }
  const accounts = store.accounts.map(entry => (entry.id === id ? { ...entry, lastUsedAt: Date.now() } : entry))
  writeStore({ ...store, accounts, activeAccountId: id })
  return { ok: true, ...accountList() }
}

/**
 * 改昵称 / 启停。停用的若是当前账号，active 自己退到下一条。
 *
 * @param {{accountId: string, patch: {nickname?: string, enabled?: boolean}}}
 * @returns {{ok: boolean, error?: string, accounts: Array<any>, activeAccountId: string}}
 */
export function accountUpdate(input = {}) {
  const id = typeof input?.accountId === 'string' ? input.accountId.trim() : ''
  const store = loadStore()
  const row = store.accounts.find(entry => entry.id === id)
  if (row === undefined) return { ok: false, error: '没有这条账号', ...accountList() }
  const patch = input?.patch !== null && typeof input?.patch === 'object' ? input.patch : {}
  const next = { ...row }
  if (typeof patch.nickname === 'string' && patch.nickname.trim() !== '') next.nickname = patch.nickname.trim().slice(0, 64)
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  const accounts = store.accounts.map(entry => (entry.id === id ? next : entry))
  writeStore({ ...store, accounts, activeAccountId: pickActiveId(accounts, store.activeAccountId) })
  return { ok: true, ...accountList() }
}

/**
 * 删一条账号。删掉的若是当前账号，active 自己退到下一条。
 *
 * @param {string} accountId
 * @returns {{ok: boolean, error?: string, accounts: Array<any>, activeAccountId: string}}
 */
export function accountDelete(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  const store = loadStore()
  if (!store.accounts.some(entry => entry.id === id)) return { ok: false, error: '没有这条账号', ...accountList() }
  const accounts = store.accounts.filter(entry => entry.id !== id)
  writeStore({ ...store, accounts, activeAccountId: pickActiveId(accounts, store.activeAccountId === id ? '' : store.activeAccountId) })
  return { ok: true, ...accountList() }
}

/** 把一次探测到的用户信息回填到某条账号（昵称跟着走）。 */
export function rememberAccountUser(accountId, user) {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  if (id === '' || user === null || typeof user !== 'object') return
  const store = loadStore()
  const row = store.accounts.find(entry => entry.id === id)
  if (row === undefined) return
  const nickname = typeof user.username === 'string' && user.username.trim() !== ''
    ? user.username.trim().slice(0, 64)
    : row.nickname
  const accounts = store.accounts.map(entry => (entry.id === id ? { ...entry, user, nickname } : entry))
  writeStore({ ...store, accounts, activeAccountId: store.activeAccountId })
}

/**
 * 读官方 CLI 的 accessToken（只读）。
 *
 * @returns token 字符串，或空串。
 */
export function readCliAccessToken() {
  try {
    const file = path.join(os.homedir(), '.meoo', 'credentials.json')
    const body = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const value of [body?.accessToken, body?.tokens?.accessToken, body?.credentials?.accessToken]) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 把用户贴进来的一段文字拆成 token 或 cookie。
 *
 * 认三种写法：`Cookie: k=v; k2=v2`、裸 cookie（含 `=`）、裸 token（JWT / sk-…）。
 * 换行一律剔掉 —— 它是 HTTP 头注入最省事的入口，而且贴多行 cookie 的人本来就
 * 只想贴一条。
 *
 * @param text - 用户贴的原文。
 * @returns {{token: string, cookie: string}}
 */
export function parsePasted(text) {
  const raw = String(text ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/^cookie:\s*/i, '')
  if (raw === '') return { token: '', cookie: '' }
  if (/^bearer\s+/i.test(raw)) return { token: raw.replace(/^bearer\s+/i, '').trim(), cookie: '' }
  if (raw.includes('=')) {
    const parts = raw.split(';').map(part => part.trim()).filter(part => part !== '' && part.includes('='))
    return { token: '', cookie: parts.join('; ') }
  }
  return { token: raw, cookie: '' }
}

/**
 * 当前可用的凭据。
 *
 * source 只有三个取值：'browser'（自动从本机浏览器读的）、'stored'（用户自己贴的）、
 * 'cli'（官方 CLI 的 token）。卡片上照这个写来源，用户才知道要不要自己动手。
 *
 * @returns {{kind: 'token'|'cookie', value: string, source: 'browser'|'stored'|'cli'}|null}
 */
export function resolveSecret() {
  const account = pickUsableAccount(loadStore())
  const secret = accountSecret(account)
  if (secret !== null) {
    return {
      kind: secret.kind,
      value: secret.value,
      // 对外仍旧只有三档来源：browser / stored / cli。
      source: secret.source === 'browser' ? 'browser' : secret.source === 'cli' ? 'cli' : 'stored',
      // 新增：这份凭据属于哪条账号。切账号/删账号要靠它认人。
      accountId: secret.accountId,
    }
  }
  const cli = readCliAccessToken()
  if (cli !== '') return { kind: 'token', value: cli, source: 'cli', accountId: '' }
  return null
}

/**
 * 秒悟登录态真正承载值的那几个 cookie（令牌 + 它们的签名）。
 *
 * 只有它们变了才算「浏览器里换了一份登录」，语言、cna、isg 这种偏好项变了不值得一提。
 */
const MEEO_WEB_TOKEN_COOKIES = [
  'oneday_sid',
  'oneday_sid.sig',
  'login_oneday_ticket',
  'login_oneday_ticket.sig',
]

/** 把 cookie 头拆成 Map（同名以最后一次为准）。 */
function cookiePairs(header) {
  const jar = new Map()
  for (const part of String(header ?? '').split(';')) {
    const row = part.trim()
    if (row === '') continue
    const index = row.indexOf('=')
    if (index <= 0) continue
    jar.set(row.slice(0, index), row.slice(index + 1))
  }
  return jar
}

/**
 * 把浏览器里当前那份秒悟 cookie 并进已存的那份。
 *
 * 不复用 chromecookie.js 的 `mergeCookie`：那把新鲜度尺子是按豆包的 `s_v_web_id`
 * 与 `sid_guard` 校准的，拿来量秒悟只会得出 stored-is-fresh（秒悟没有这两项）。
 * 这里用秒悟自己的判据：登录令牌那几项跟浏览器对不上就整体以浏览器为准（其余
 * 偏好项沿用已存的那份，不为语言/主题去覆盖用户设置）。
 *
 * @param stored - 已存的 cookie 头（可能是空串）。
 * @param snapshot - `browserCookieSnapshot()` 的返回值。
 * @returns `{cookieHeader, changed, reason}`。
 */
export function mergeBrowserCookie(stored, snapshot) {
  const text = String(stored ?? '').trim()
  if (snapshot === null || snapshot === undefined || snapshot.jar === undefined) {
    return { cookieHeader: text, changed: false, reason: 'no-browser' }
  }
  if (text === '') return { cookieHeader: serializeJar(snapshot.jar), changed: true, reason: 'no-stored' }
  const current = cookiePairs(text)
  const stale = MEEO_WEB_TOKEN_COOKIES.some(name => snapshot.jar.has(name) && current.get(name) !== snapshot.jar.get(name))
  if (!stale) return { cookieHeader: text, changed: false, reason: 'stored-is-fresh' }
  // 只换登录令牌那几项（含签名），用户自己的语言/主题偏好一律留着。
  const next = new Map(current)
  for (const name of MEEO_WEB_TOKEN_COOKIES) {
    if (snapshot.jar.has(name)) next.set(name, snapshot.jar.get(name))
  }
  return { cookieHeader: serializeJar(next), changed: true, reason: 'browser-newer' }
}

/**
 * 从本机浏览器里捞一份秒悟的登录态，写进插件的凭据文件。
 *
 * 只在「当前没有凭据」或「已存的凭据已经失效」时调用（节流在 provider 里），
 * 平时不碰浏览器库 —— 每读一次都要解密整个 cookie 库，状态页会明显变慢。
 *
 * 任何失败都安静返回：没装 Chrome、没登过秒悟、解密不出来（App-Bound）、Windows，
 * 都只是「没捞到」，不能因此让渠道卡片变成 error。
 *
 * @returns `{adopted, reason, browser?, profile?}`。
 */
export async function adoptBrowserCookie({ force = false } = {}) {
  const stored = readStored()
  // 防串号：当前账号是哪一份登录态，就只认浏览器里同 sid 的那一份。
  // 不做这一步的话，用户日常 Chrome 里登着 B 号、插件里是 A 号时，A 号的卡片
  // 会被 B 号的 cookie 顶上 —— 界面上看不出来，请求却全发到 B 号去了。
  const preferSessionId = sessionIdOf(stored.cookie)
  let snapshot = null
  try {
    snapshot = await browserCookieSnapshot({
      domainHint: MEEO_WEB_DOMAIN_HINT,
      requireCookies: MEEO_WEB_REQUIRED_COOKIES,
      sessionCookie: 'oneday_sid',
      preferSessionId,
    })
  } catch {
    return { adopted: false, reason: 'browser-read-failed' }
  }
  if (snapshot === null) return { adopted: false, reason: 'no-browser-cookie' }
  // 浏览器里这几份登录态，没有一份跟当前账号同 sid：那就别动。宁可让用户重贴
  // 或走登录窗重登，也不能悄悄把账号换成浏览器里那个。
  // 唯一例外：当前账号本来就是「从浏览器抄来的」且浏览器里只有一份 —— 这时它
  // 八成就是那份，允许跟着刷新（自愈路径要靠它）。
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : []
  if (preferSessionId !== '' && snapshot.jar.get('oneday_sid') !== preferSessionId) {
    const onlyOne = stored.source === 'browser' && candidates.length === 1
    if (!onlyOne) return { adopted: false, reason: 'no-matching-profile' }
  }
  const merged = mergeBrowserCookie(stored.cookie, snapshot)
  // force：文件里那份被上游判死了。此时「浏览器和文件里看起来一样」不能当作
  // 「没得救」—— 用户可能刚在 Chrome 里重新登录（换了整瓶），也可能文件被截断过。
  // 整瓶重抄一次再问一遍，比让用户手贴强；非 force 时维持原判据。
  if (!merged.changed && force !== true) return { adopted: false, reason: merged.reason }
  const cookieHeader = force === true ? serializeJar(snapshot.jar) : merged.cookieHeader
  const reason = force === true ? 'forced-resync' : merged.reason
  try {
    // token 原样留着：用户手贴过 token 的话，换回 token 那条路还得用它。
    // 写进「当前账号」；一条账号都没有时 writeStored 会新建一条 source='browser'。
    writeStored({ token: stored.token, cookie: cookieHeader, source: 'browser' })
  } catch {
    return { adopted: false, reason: 'write-failed' }
  }
  return { adopted: true, reason, browser: snapshot.browser, profile: snapshot.profile }
}

/** 凭据的非密描述：只给来源和长度，永远不回显值。 */
export function describeSecret(secret) {
  if (secret === null || secret === undefined) return null
  return {
    kind: secret.kind,
    source: secret.source,
    length: secret.value.length,
    // 只留头 4 位，够用户认出「贴的是哪一份」，不够拿来用。
    head: secret.value.slice(0, 4),
  }
}

/**
 * 从模型目录响应里挖出模型行。
 *
 * 上游形状没保证过（包了一层 `data`、或者直接把数组当 body 都见过），所以按
 * 「常见容器 → 兜底遍历对象」的顺序找。认不出来就返回空数组，由上层如实报错。
 *
 * @param body - 解析后的 JSON。
 * @returns {Array<{id: string, name: string}>}
 */
export function modelRows(body) {
  const found = findModelArray(body, 0)
  if (found === null) return []
  const rows = []
  const seen = new Set()
  for (const row of found) {
    if (row === null || typeof row !== 'object') continue
    const id = pickString(row, ['id', 'model', 'modelId', 'model_id', 'key', 'name'])
    if (id === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    const name = pickString(row, ['name', 'displayName', 'display_name', 'label', 'title'])
    rows.push({ id, name: name === '' ? id : name })
  }
  return rows
}

/**
 * 在响应体里找一个「看起来是模型列表」的数组。
 *
 * @param value - 任意 JSON 值。
 * @param depth - 递归深度（上游嵌套最多三四层，别再往下钻）。
 * @returns 数组，或 null。
 */
function findModelArray(value, depth) {
  if (depth > 4 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    // 数组里是对象、且对象上有 id/model/name 这种键，就当模型行。
    const looksLikeRows = value.length === 0 || value.some(row => row !== null && typeof row === 'object'
      && pickString(row, ['id', 'model', 'modelId', 'model_id', 'key', 'name']) !== '')
    return looksLikeRows ? value : null
  }
  for (const key of ['models', 'data', 'result', 'list', 'items', 'rows']) {
    const inner = value[key]
    if (inner === undefined) continue
    const found = findModelArray(inner, depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * 取第一个非空字符串字段。
 *
 * @param row - 对象。
 * @param keys - 字段名候选，按顺序试。
 * @returns 值，或空串。
 */
function pickString(row, keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 从响应里挖一个 projectId。
 *
 * @param body - 解析后的 JSON。
 * @returns id，或空串。
 */
export function projectIdOf(body) {
  const queue = [{ value: body, depth: 0 }]
  while (queue.length > 0) {
    const { value, depth } = queue.shift()
    if (depth > 4 || value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 })
      continue
    }
    // 只认 url_id：agent 侧（/api/agent/start、/api/agent/query、/api/v1/project/<x>）
    // 全都要这个短串。数字 id（"541309"）传过去一律回 403 应用不存在，实测。
    for (const key of ['url_id', 'urlId', 'urlID']) {
      const id = value[key]
      if (typeof id === 'string' && id.trim() !== '') return id.trim()
    }
    for (const key of ['data', 'result', 'project', 'projects', 'list']) {
      if (value[key] !== undefined) queue.push({ value: value[key], depth: depth + 1 })
    }
  }
  return ''
}

/**
 * 从额度响应里认出「还剩多少」。
 *
 * 两处都可能带数字，优先用户级余额（`userPointInfo.account`，含冻结/已用/已过期），
 * 缺了再退回套餐配额差（`benefits[typeCode='model_credits']` 的 `quota - used`）。
 * 两处都认不出来就抛 —— 让卡片显示「上游形状变了」，而不是显示一个假 0。
 *
 * @param body - `/api/mc/entitlement/get` 的 JSON。
 * @returns 归一化后的额度；认不出来抛 Error。
 */
export function quotaOf(body) {
  const data = body?.data
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new Error('秒悟没有返回额度数据（/api/mc/entitlement/get 的形状变了）')
  }
  const point = data.userPointInfo?.account ?? null
  const benefits = Array.isArray(data.benefits) ? data.benefits : []
  const credit = benefits.find(row => row?.typeCode === 'model_credits') ?? null
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

  let remaining = num(point?.availableBalance)
  if (remaining === null) {
    const quota = num(credit?.quota)
    if (quota === null) throw new Error('秒悟的额度响应里没有可用数字（userPointInfo / benefits 都认不出来）')
    remaining = quota - (num(credit?.used) ?? 0)
  }

  // 套餐结束时间 9999-12-31 是「永不过期」，换成 0 让卡片不显示倒计时。
  const ended = Date.parse(String(data.activatedEndTime ?? ''))
  const expiresAt = Number.isFinite(ended) && new Date(ended).getFullYear() < 9000 ? ended : 0

  return {
    remaining,
    total: num(point?.totalGranted) ?? num(credit?.quota) ?? remaining,
    used: num(point?.totalConsumed) ?? num(credit?.used) ?? 0,
    frozen: num(point?.frozenBalance) ?? 0,
    // 秒悟自己的说法就是「积分」；卡片标签用渠道能力位决定，这里只表明单位。
    unit: '积分',
    planCode: typeof data.planCode === 'string' ? data.planCode : '',
    planName: typeof data.planName === 'string' ? data.planName : '',
    expiresAt,
    at: Date.now(),
  }
}

/**
 * 一条秒悟网页会话。
 *
 * 一个实例绑一份凭据；凭据换了就换实例（provider 负责重建），这样 401 之后
 * 没有任何「半新半旧」的中间态。
 */
export class MeooWebSession {
  #secret
  #origin
  #fetchImpl
  #projectId

  /**
   * @param options - 依赖。
   * @param options.secret - `resolveSecret()` 的返回值；null 表示没登录。
   * @param options.origin - 站点 origin（测试用）。
   * @param options.fetch - fetch 实现（测试用）。
   */
  constructor(options = {}) {
    this.#secret = options.secret ?? null
    this.#origin = typeof options.origin === 'string' && options.origin !== '' ? options.origin.replace(/\/+$/, '') : MEEO_WEB_ORIGIN
    this.#fetchImpl = options.fetch ?? globalThis.fetch
    this.#projectId = ''
  }

  /** 有没有凭据。 */
  get signedIn() {
    return this.#secret !== null
  }

  /** 当前凭据的非密描述。 */
  get secret() {
    return this.#secret
  }

  /** 已经解析出来的 projectId（没有就是空串）。 */
  get projectId() {
    return this.#projectId
  }

  /**
   * 组请求头。
   *
   * @param extra - 额外头。
   * @param hasBody - 是否带 JSON 正文。
   * @returns 头对象。
   */
  #headers(extra, hasBody) {
    const headers = {
      'user-agent': MEEO_WEB_USER_AGENT,
      accept: 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      origin: this.#origin,
      referer: `${this.#origin}/`,
      ...extra,
    }
    if (hasBody) headers['content-type'] = 'application/json'
    if (this.#secret?.kind === 'cookie') headers.cookie = this.#secret.value
    else if (this.#secret?.kind === 'token') headers.authorization = `Bearer ${this.#secret.value}`
    return headers
  }

  /**
   * 发一个请求。
   *
   * @param pathOrUrl - 站内路径或完整 URL。
   * @param options - `{method, body, headers, signal, timeoutMs}`。
   * @returns fetch 的 Response。
   */
  async request(pathOrUrl, options = {}) {
    if (this.#secret === null) throw new NeedLoginError()
    const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : `${this.#origin}${pathOrUrl}`
    const method = String(options.method ?? 'GET').toUpperCase()
    const hasBody = options.body !== undefined
    const body = hasBody ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined

    const controller = new AbortController()
    // 一个请求一个 deadline：卡住的连接不能让整轮对话永远停在「思考中」。
    const timer = setTimeout(() => controller.abort(new Error('秒悟网页请求超时')), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    const outer = options.signal
    const relay = () => controller.abort(outer?.reason)
    if (outer !== undefined) {
      if (outer.aborted === true) controller.abort(outer.reason)
      else outer.addEventListener('abort', relay, { once: true })
    }
    try {
      return await this.#fetchImpl(url, {
        method,
        headers: this.#headers(options.headers ?? {}, hasBody),
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      if (outer !== undefined && typeof outer.removeEventListener === 'function') outer.removeEventListener('abort', relay)
    }
  }

  /**
   * 发请求并解析 JSON。
   *
   * 三种失败分得很清楚：401/403 或「回来一页 HTML」是登录态没了；非 2xx 是上游
   * 拒绝；解析不了是上游改形状了。上层按 message 直接写进卡片。
   *
   * @param pathOrUrl - 路径。
   * @param options - 同 `request`。
   * @returns 解析后的 JSON。
   */
  async json(pathOrUrl, options = {}) {
    const response = await this.request(pathOrUrl, options)
    const text = await response.text()
    const contentType = String(response.headers?.get?.('content-type') ?? '')
    const trimmed = text.trim()
    // 401 一定是登录态没了。403 要看内容：应用不存在 / 无权限也回 403，
    // 把它当成「凭据过期」会把好 cookie 判死（用户看到的就是一直让他重贴）。
    if (response.status === 401 || /NEED_LOGIN|LOGIN_INVALID/.test(trimmed)) {
      throw new NeedLoginError(`秒悟网页拒绝了这份凭据（HTTP ${response.status} NEED_LOGIN），请重新贴一次 Cookie`)
    }
    if (contentType.includes('text/html') || trimmed.startsWith('<')) {
      throw new NeedLoginError('秒悟返回的是网页而不是接口数据（登录态多半已经没了），请重新贴一次 Cookie')
    }
    if (response.ok !== true) {
      throw new Error(`秒悟接口 HTTP ${response.status}${trimmed === '' ? '' : `：${trimmed.slice(0, 160)}`}`)
    }
    if (trimmed === '') return undefined
    try {
      return JSON.parse(trimmed)
    } catch {
      throw new Error(`秒悟返回了不是 JSON 的东西（HTTP ${response.status}）：${trimmed.slice(0, 160)}`)
    }
  }

  /**
   * 拉模型目录。
   *
   * @param options - `{signal}`。
   * @returns `[{id, name}]`。
   */
  async models(options = {}) {
    const body = await this.json(MEEO_WEB_APIS.models, { signal: options.signal })
    return modelRows(body)
  }

  /**
   * 查一次额度（积分余额）。
   *
   * 形状跟 `models()` 一样：认出来的结构交出去，认不出来就抛错由上层写进卡片。
   * 鉴权语义也跟 `json()` 一致 —— 401 / 回来一页 HTML 抛 NeedLoginError。
   *
   * @param options - `{signal}`。
   * @returns {{remaining: number, total: number, used: number, frozen: number, unit: string,
   *            planCode: string, planName: string, expiresAt: number, at: number}}
   */
  async quota(options = {}) {
    const body = await this.json(MEEO_WEB_APIS.entitlement, { signal: options.signal, timeoutMs: 15_000 })
    return quotaOf(body)
  }

  /**
   * 验一次「这份凭据到底还能不能用」。
   *
   * 模型目录是公开的（不带头也回 200），拿它当探针会假绿：token 早过期了也一样
   * 列得出 16 个模型。项目列表同样是软的（实测匿名也回 200，形状一模一样），也
   * 不能当探针。真正会拒的是 `project/ensure`：匿名和过期凭据都回 401 NEED_LOGIN，
   * 所以用它（GET，不建项目）。
   *
   * 它偶尔会因为边缘节点回 404/405 之类的非鉴权错误 —— 那些不算「凭据坏了」，
   * 这次探不明白就当没事，别把可用的凭据误判成过期（真正的失败留给发消息那一步报）。
   *
   * @param options - `{signal}`。
   * @returns 用户对象（`data`，形如 `{username, user_id, phone, email}`）；探不明白时返回 null；
   *          凭据不可用时抛 NeedLoginError。
   */
  async probeAuth(options = {}) {
    let body
    try {
      body = await this.json(MEEO_WEB_APIS.userMe, { signal: options.signal, timeoutMs: 15_000 })
    } catch (error) {
      if (error instanceof NeedLoginError) throw error
      // 不是鉴权问题（边缘 404、限流、超时……）：这次探不明白，别拿它判死刑。
      return null
    }
    // 匿名的 /api/v1/user/me 也是 HTTP 200，只是 data 为 null 外加一个 redirectUrl
    // —— 状态码看不出来，只能看形状。这才是真正的「凭据还能不能用」。
    const user = body?.data
    if (user === null || user === undefined || typeof user !== 'object') {
      throw new NeedLoginError('秒悟网页的登录态失效了（/api/v1/user/me 回的是未登录），请重新贴一次 Cookie')
    }
    return user
  }

  /**
   * 拿到一个可以往里发消息的 projectId。
   *
   * 先问列表（用户已经有项目就直接用第一个），没有就建一个。秒悟的对话是挂在
   * 项目底下的，没有 projectId 的话 `/api/agent/start` 什么都不做。
   *
   * @param options - `{signal}`。
   * @returns projectId。
   */
  async ensureProject(options = {}) {
    if (this.#projectId !== '') return this.#projectId
    let listed
    try {
      listed = await this.json(MEEO_WEB_APIS.projectList, { signal: options.signal })
    } catch (error) {
      // 登录态问题要原样往上抛；列表接口换个形状不值得挡住整条链路。
      if (error instanceof NeedLoginError) throw error
      listed = undefined
    }
    const existing = projectIdOf(listed)
    if (existing !== '') {
      this.#projectId = existing
      return existing
    }
    const created = await this.json(MEEO_WEB_APIS.projectCreate, {
      method: 'POST',
      body: { name: 'DSH' },
      signal: options.signal,
    })
    const id = projectIdOf(created)
    if (id === '') throw new Error('秒悟：拿不到 projectId（/api/v1/project 没回 url_id），这条通道暂时发不出消息')
    this.#projectId = id
    return id
  }

  /**
   * 发起一轮并拿到事件流。
   *
   * 顺序：先把 `query` 的流挂上，再 POST `start`。两种顺序实测都可用（2026-11-20
   * 诊断时正反各跑一轮，帧数一致），保留先挂订阅只是为了让首字更早到 —— 别把
   * 「反过来会丢首帧」当结论，那一条实测不成立。
   *
   * @param options - `{model, message, signal}`。
   * @returns SSE 的 Response（`body` 可直接交给 `sseEvents`）。
   */
  async openChat(options = {}) {
    const projectId = await this.ensureProject({ signal: options.signal })
    const queryUrl = `${MEEO_WEB_APIS.query}?projectId=${encodeURIComponent(projectId)}`

    const controller = new AbortController()
    const relay = () => controller.abort(options.signal?.reason)
    if (options.signal !== undefined) {
      if (options.signal.aborted === true) controller.abort(options.signal.reason)
      else options.signal.addEventListener('abort', relay, { once: true })
    }

    const queryPromise = this.request(queryUrl, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })

    try {
      await this.json(MEEO_WEB_APIS.start, {
        method: 'POST',
        body: {
          projectId,
          model: options.model,
          message: options.message,
          mode: 'chat',
          // 网页把模型同时塞进 extraParams.llmMode：只给 model 时上游会回默认模型。
          extraParams: { llmMode: options.model },
        },
        signal: controller.signal,
      })
    } catch (error) {
      controller.abort(error)
      try { await queryPromise } catch { /* 已经在收尾了 */ }
      throw error
    }

    const response = await queryPromise
    if (response.ok !== true) {
      const text = await response.text().catch(() => '')
      // 同 json()：403 也可能是「应用不存在」，别当凭据过期。
      if (response.status === 401 || /NEED_LOGIN|LOGIN_INVALID/.test(text)) {
        throw new NeedLoginError(`秒悟的事件流拒绝了这份凭据（HTTP ${response.status} NEED_LOGIN）`)
      }
      throw new Error(`秒悟的事件流没有建立（HTTP ${response.status}）：${text.slice(0, 160)}`)
    }
    const contentType = String(response.headers?.get?.('content-type') ?? '')
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text().catch(() => '')
      throw new Error(`秒悟没有给事件流（content-type=${contentType || '空'}）：${text.slice(0, 160)}`)
    }
    return response
  }

  /** 让上游停掉当前这一轮（尽力而为，失败不抛）。 */
  async stop(signal) {
    if (this.#projectId === '') return
    try {
      const response = await this.request(MEEO_WEB_APIS.stop, {
        method: 'POST',
        body: { projectId: this.#projectId },
        signal,
        timeoutMs: 8_000,
      })
      await response.arrayBuffer().catch(() => {})
    } catch { /* 用户已经不要这一轮了，停不掉也无所谓 */ }
  }

  /** 非密会话摘要（诊断用）。 */
  describe() {
    return { signedIn: this.signedIn, origin: this.#origin, projectId: this.#projectId, secret: describeSecret(this.#secret) }
  }
}
