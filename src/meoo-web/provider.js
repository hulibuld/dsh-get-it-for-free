/**
 * 秒悟 · 网页版（meoo.com）通道。
 *
 * 与同仓库另一条秒悟卡（`src/meoo`，只读 CLI 的积分/部署额度）不同：这条是**模型
 * 通道**，把网页版自己的 agent 会话包装成一个结构性 LLM 适配器，于是秒悟的额度
 * 能直接出现在模型选择器里，跟别的渠道一样用。
 *
 * 三段式：
 *   1. `session.js` —— 凭据（CLI 的 accessToken 或用户贴的 Cookie）+ HTTP，401 直接
 *      报 NEED_LOGIN，不静默重试、不自己刷令牌；
 *   2. `sse.js` —— 上游 `ui_event` 流翻成 OpenAI chunk（`readStream('chat')` 只认这个）；
 *   3. 本文件 —— adapter 契约 + 卡片的 status/login/logout/models。
 *
 * 上游没有工具调用通道，所以这里只出纯文本；关掉的模型不进目录也不进选择器。
 *
 * @module dsh-get-it-for-free/meoo-web/provider
 */

import fs from 'node:fs'
import path from 'node:path'

import { createChannel } from '../channel.js'
import { toChatMessages } from '../messages.js'
import { resolveDshHome } from '../store.js'
import { finishReason, readStream } from '../stream.js'
import {
  MeooWebSession,
  MEEO_WEB_REQUIRED_COOKIES,
  NeedLoginError,
  accountCapture,
  accountCreate,
  accountDelete,
  accountList,
  accountUpdate,
  accountUse,
  adoptBrowserCookie,
  describeSecret,
  markAccountDead,
  modelRows,
  parsePasted,
  readStored,
  rememberAccountUser,
  resolveSecret,
  findExistingAccount,
  writeStored,
} from './session.js'
import {
  collectViaBrowser,
  findSystemBrowser,
  migrateProfile,
  probeMeooUser,
  profileDirFor,
  resetProfile,
  stagingProfileDir,
} from './login.js'
import { MeooSseTranslator, sseEvents } from './sse.js'
import { accountSecret, loadStore, mintAccountId, nicknameOf, pickUsableAccount } from './account-store.js'

export const MEEO_WEB_PROVIDER = 'meoo-web'
export const MEEO_WEB_DISPLAY_NAME = '秒悟 · 网页版'

/** 卡片上「这份凭据从哪来」的说法。 */
const SOURCE_LABELS = {
  browser: '本机浏览器登录态',
  cli: 'CLI 登录态',
  stored: '手动凭据',
}

/** 秒悟网页的上下文窗口：它的项目级会话能塞很长，按 200K 报，保守一点。 */
export const MEEO_WEB_CONTEXT_WINDOW = 200_000

/** 单轮输出上限。 */
export const MEEO_WEB_MAX_OUTPUT_TOKENS = 8_192

/** 模型目录的缓存时长：网页很少上新，但也不该每个回合都问一次。 */
const CATALOG_TTL_MS = 5 * 60 * 1000

/** 模型开关与凭据分开落盘：凭据文件只管凭据，读它的人不该顺带读到偏好。 */
export function statePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'meoo-web-state.json')
}

/**
 * 上游帧的落盘位置（诊断用）。
 *
 * `MEOO_DEBUG=1` 时把每一帧原样记下来：秒悟改事件名的时候，「整轮没输出」只能靠
 * 这些原始帧看出到底发了什么。和状态文件同目录，卸载时一起清。
 */
export function framesLogPath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'meoo-web-frames.log')
}

/** 帧日志只留最后这么多行：诊断要的是「刚才发了什么」，不是历史。 */
const FRAMES_LOG_LIMIT = 200

/** 这一进程里已经记过的子类型：同一轮里重复的只写一次。 */
const loggedUnknown = new Set()

/**
 * 追加一段帧日志，并裁到 `FRAMES_LOG_LIMIT` 行。
 *
 * 环形裁剪按行做：读回来切尾巴再整份写。文件本来就不大（每行一帧），这点开销
 * 比维护另一个索引文件省事。写不了就算了 —— 诊断不该把主流程带崩。
 *
 * @param line - 一行文本（已经带好时间戳）。
 */
function appendFramesLog(line) {
  const file = framesLogPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let rows = []
    try {
      rows = fs.readFileSync(file, 'utf8').split('\n').filter(row => row !== '')
    } catch { /* 还没有文件：从空开始 */ }
    rows.push(line)
    if (rows.length > FRAMES_LOG_LIMIT) rows = rows.slice(rows.length - FRAMES_LOG_LIMIT)
    fs.writeFileSync(file, `${rows.join('\n')}\n`)
  } catch { /* 写不了就算了，诊断不是主流程 */ }
}

/** 帧日志要不要开：环境变量每次现读，改了不用重启宿主。 */
function framesDebug() {
  const value = process.env?.MEOO_DEBUG
  return value === '1' || value === 'true'
}

/**
 * 记一帧上游原始事件。
 *
 * 只在 debug 开时动手；正文会截断，避免把整段回答写进日志。
 *
 * @param payload - SSE 帧里的 JSON。
 */
function logFrame(payload) {
  if (!framesDebug()) return
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '[unserializable]'
  }
  if (body.length > 600) body = `${body.slice(0, 600)}…(${body.length})`
  appendFramesLog(`${new Date().toISOString()} ${body}`)
}

/**
 * 记一条「认不出来的上游事件」。
 *
 * 只在 debug 开时落盘，但同一进程里同类只记一次：真正的线索是「出现了哪个新类型」，
 * 不是它重复了多少遍。
 *
 * @param inner - 上游子类型名。
 */
function noteUnknownFrame(inner) {
  if (!framesDebug()) return
  if (loggedUnknown.has(inner)) return
  loggedUnknown.add(inner)
  appendFramesLog(`${new Date().toISOString()} [unknown] ${inner}`)
}

/** 读偏好（目前只有一份模型黑名单）。 */
function readState() {
  try {
    const body = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return {
      disabledModels: Array.isArray(body?.disabledModels) ? body.disabledModels.filter(id => typeof id === 'string') : [],
      // 用户点过「退出登录」就置 false：否则下一次开卡片又会从浏览器里把登录态捡回来，
      // 看起来像退出登录没生效。只有他自己再贴一次凭据、或者点「刷新模型」才恢复。
      browserAuto: body?.browserAuto !== false,
    }
  } catch {
    return { disabledModels: [], browserAuto: true }
  }
}

/** 写偏好。 */
function writeState(next) {
  const file = statePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ ...readState(), ...next }, null, 2)}\n`)
  } catch { /* 写不了就算了，开关只影响这一台机器 */ }
}

/**
 * 把宿主的一串消息压成秒悟要的单条 `message`。
 *
 * 秒悟的 agent 会话只有一个输入框，没有多轮角色结构。所以：
 *   - 只有一条用户消息、没有 system 时，原样发；
 *   - 否则按「系统 / 用户 / 助手 / 工具结果」拼成一份带角色标记的文本 —— 这样多轮
 *     历史不会丢，模型也看得出哪句是谁说的。
 *
 * @param messages - 宿主的消息数组。
 * @returns 单条 prompt 文本。
 */
export function flattenPrompt(messages) {
  const wire = toChatMessages(messages, undefined, [])
  const rows = []
  for (const message of wire) {
    const text = contentText(message?.content)
    if (text === '') continue
    const role = message?.role
    const label = role === 'system' ? '系统'
      : role === 'assistant' ? '助手'
        : role === 'tool' ? '工具结果' : '用户'
    rows.push({ role, label, text })
  }
  if (rows.length === 0) return ''
  if (rows.length === 1 && rows[0].role === 'user') return rows[0].text
  return rows.map(row => `【${row.label}】\n${row.text}`).join('\n\n')
}

/**
 * 取内容里的纯文本（数组形状里只挑 text 段，图片丢弃）。
 *
 * @param content - 字符串或段数组。
 * @returns 文本，或空串。
 */
function contentText(content) {
  if (typeof content === 'string') return content.trim() === '' ? '' : content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') { if (part !== '') parts.push(part); continue }
    if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * 建立这条通道。
 *
 * @param options - `{logger}`。
 * @returns `{adapter, status, models, refresh, login, logout, test, setModelDisabled, setAllModelsDisabled, describe, dispose}`。
 */
export function createMeooWeb(options = {}) {
  const logger = options?.logger
  const onTopology = typeof options?.onTopology === 'function' ? options.onTopology : () => {}

  /** 上一次请求失败的原因（卡片要写出来，不能空着）。 */
  let lastError = ''
  /** 上一次成功拿到的模型目录。 */
  let catalog = []
  /** 目录的取得时间。 */
  let catalogAt = 0
  /** 当前会话；凭据换了就置空重建。 */
  let session = null

  /**
   * 读浏览器库这件事要节流。
   *
   * 每读一次都要解密整个 cookie 库（几十毫秒到几百毫秒），挂在状态页上会让卡片
   * 明显变慢；而且它只在两种时刻才有意义 —— 现在根本没凭据，或者手里这份刚被
   * 上游判死。
   */
  const BROWSER_RETRY_MS = 30_000
  let browserAt = 0
  /** 节流窗口内复用的结论：上一次有没有捞到登录态。 */
  let browserOk = false
  /** 上一次失败是不是「凭据不被承认」。只有它才值得去浏览器里换一份。 */
  let authDead = false

  /**
   * 去本机浏览器里补一次秒悟的登录态。
   *
   * 失败一律当成「没捞到」：没装浏览器、没登过秒悟、解密不出来、Windows，都只是
   * 安静地回到原流程，绝不能让卡片变成 error。
   *
   * @param explicit - 用户自己点的（「刷新模型」），连「退出登录」的抑制也一起绕过。
   * @returns 有没有换成一份新凭据。
   */
  async function healFromBrowser({ explicit = false, force = false } = {}) {
    if (!explicit && readState().browserAuto === false) return false
    // 手上那份是用户自己贴的（或 CLI 的），就别拿浏览器的去盖掉它：他贴错了要看得到
    // 自己的那份和报错，而不是被悄悄换成另一份、看起来「贴什么都没用」。
    // 只有两种情况该动手：现在根本没有凭据，或者那份是我们自己从浏览器抄来的。
    const current = resolveSecret()
    if (current !== null && current.source !== 'browser') return false
    if (Date.now() - browserAt < BROWSER_RETRY_MS) return browserOk
    browserAt = Date.now()
    browserOk = false
    // force：手上这份是浏览器抄来的、却被上游判死了。此时「浏览器和文件里一样」
    // 不能当作「没得救」——用户的 Chrome 可能刚重新登录过（换了整瓶 cookie），
    // 也可能文件里那份被别的东西截断过。整瓶重抄一次再问一遍，比让用户手贴强。
    const result = await adoptBrowserCookie({ force })
    if (result.adopted !== true) return false
    // 凭据换了，会话必须重建：旧实例绑的还是上一份 cookie。
    session = null
    catalog = []
    catalogAt = 0
    lastError = ''
    browserOk = true
    authDead = false
    logger?.info?.('get-it-for-free: 秒悟网页已接上本机 ' + result.browser + ' 的登录态（' + result.reason + '）')
    return true
  }

  /** 拿到（必要时重建）会话。 */
  function currentSession() {
    if (session !== null) return session
    session = new MeooWebSession({ secret: resolveSecret() })
    return session
  }

  /* ── 登录窗 ──────────────────────────────────────────────────────── */

  /** 同时只允许开一个登录窗：两个进程抢同一个 profile 会互相把对方的 cookie 写坏。 */
  let loginBusy = false

  /** 这台机器能不能开登录窗（有没有系统浏览器）。 */
  function loginWindowAvailable() {
    return { available: findSystemBrowser() !== '', staging: stagingProfileDir() }
  }

  /**
   * 开一次登录窗把登录态收回来。
   *
   * 两种用法，差别只在「开哪个分区、要不要清」：
   *   - 添加新账号：开固定的 `_staging/`，**每次先清空**，所以永远弹干净登录页；
   *   - 重登某个账号：开它自己的 `<accountId>/`，**不清**（里面本来就是它的登录态，
   *     清掉等于让它重新输密码）。
   *
   * 收尾顺序是踩出来的：先等浏览器子进程真的退出（collectViaBrowser 的 finally 里
   * 已经等过），再动目录 —— Windows 上进程没退干净时 lockfile 还占着，rename 必
   * EBUSY。迁移失败就不写账号库，如实回报，绝不留下「有账号没有分区」的半截状态。
   */
  async function runLoginWindow({ accountId = '', clear = true } = {}) {
    if (loginBusy) return { ok: false, error: '登录窗已经开着了，先在那边完成或关掉它' }
    const probe = loginWindowAvailable()
    if (!probe.available) {
      return { ok: false, error: '这台机器上没有找到 Chrome / Edge，请先安装其中一个再试', available: false }
    }
    const target = typeof accountId === 'string' ? accountId.trim() : ''
    const adding = target === ''
    const dir = adding ? stagingProfileDir() : profileDirFor(target)
    if (dir === '') return { ok: false, error: '账号 id 不合法，开不了登录窗' }
    loginBusy = true
    try {
      // 添加新账号：清掉上一次留下的 staging，弹出的才是干净登录页。
      if (clear) await resetProfile(dir)
      const got = await collectViaBrowser(dir, {
        requireCookies: MEEO_WEB_REQUIRED_COOKIES,
        domain: 'meoo.com',
      })
      const cookieHeader = got.cookieHeader
      // 认人：user_id 不随 cookie 轮换而变，是判「是不是同一个号」最稳的那个。
      const seen = await probeMeooUser(cookieHeader)
      if (seen.dead === true) {
        if (adding) await resetProfile(dir)
        return { ok: false, error: '读到的那份登录态上游不认（可能刚过期），再登一次吧' }
      }
      const store = loadStore()
      const known = target === ''
        ? findExistingAccount(store, { cookie: cookieHeader, userId: seen.userId })
        : store.accounts.find(row => row.id === target) ?? null
      if (known !== null) {
        // 老号：原地更新登录态，staging 那份没用了直接丢。
        if (adding) await resetProfile(stagingProfileDir())
        const updated = accountCapture({
          cookie: cookieHeader,
          user: seen.user,
          userId: seen.userId,
          source: 'browser',
          id: known.id,
        })
        return await settleLogin(updated, { created: false, accountId: known.id })
      }
      // 新号：先把 id 定下来，再把 staging 迁成它自己的分区；迁移失败就不入库。
      const newId = mintAccountId()
      if (adding) {
        const moved = await migrateProfile(stagingProfileDir(), profileDirFor(newId))
        if (moved.ok !== true) {
          return { ok: false, error: '登录成功了，但登录态没能存到账号目录：' + (moved.error ?? '未知原因') }
        }
      }
      const created = accountCapture({
        cookie: cookieHeader,
        user: seen.user,
        userId: seen.userId,
        source: 'browser',
        id: newId,
      })
      return await settleLogin(created, { created: true, accountId: newId })
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) }
    } finally {
      loginBusy = false
    }
  }

  /** 收完登录态之后的共同收尾：换凭据、重建会话、验一次、回状态。 */
  async function settleLogin(captured, meta = {}) {
    if (captured?.ok !== true) {
      return { ok: false, error: captured?.error ?? '账号没写进去', ...accountList() }
    }
    writeState({ browserAuto: true })
    session = null
    catalog = []
    catalogAt = 0
    let error = ''
    try {
      await refresh()
    } catch (issue) {
      error = fail(issue)
    }
    onTopology()
    return {
      ok: error === '',
      error,
      created: meta.created === true,
      accountId: meta.accountId ?? '',
      account: captured.account ?? null,
      status: await status(),
      ...accountList(),
    }
  }

  /** 模型黑名单的集合视图。 */
  function disabledSet() {
    return new Set(readState().disabledModels)
  }

  /** 记一条失败原因，同时保证日志里看得见。 */
  function fail(error) {
    lastError = String(error?.message ?? error ?? '未知原因')
    authDead = error instanceof NeedLoginError
    if (!(error instanceof NeedLoginError)) logger?.warn?.(`get-it-for-free: 秒悟网页 ${lastError}`)
    // 判死时给账号挂个红标：卡片据此把这一行标出来并给「重登此账号」。
    // 只有授权类失败才挂 —— 断网、超时、5xx 都不是「这份登录态没了」。
    if (authDead) {
      const accountId = resolveSecret()?.accountId ?? ''
      if (accountId !== '') markAccountDead(accountId, { dead: true, reason: lastError })
    }
    return lastError
  }

  /**
   * 重拉模型目录。
   *
   * @param options - `{force}`：用户自己点了「刷新模型」。
   * @returns 目录行 `[{id, name}]`。
   *
   * 手里那份凭据被上游判死时，浏览器里往往已经有一份新的（用户在 Chrome 里
   * 重新登录过）。这里整瓶重抄一次再问一遍 —— 否则「判死 → 让你贴 Cookie」
   * 就是死循环，用户明明浏览器里好好的。
   */
  async function refresh(options = {}) {
    const explicit = options?.force === true
    // 完全没有凭据时先去本机浏览器里捞一次：这里就是用户点了「刷新模型」。
    // 标 explicit：这是用户的明确动作，连「退出登录」的抑制也一起绕过。
    // explicit 也要能穿透节流：用户连点两次刷新时，第二次若只读到 30 秒内的
    // 缓存结论，会拿到「登录态失效」而不是真实原因。
    if (resolveSecret() === null) {
      browserAt = 0
      await healFromBrowser({ explicit: true })
    }
    try {
      return await refreshOnce()
    } catch (error) {
      if (!(error instanceof NeedLoginError)) throw error
      if (explicit) browserAt = 0
      // force：文件里那份跟浏览器看起来一样也算数，用户可能刚整瓶换过登录。
      if (!(await healFromBrowser({ explicit, force: true }))) throw error
      return await refreshOnce()
    }
  }

  /** 真去问一次目录与身份。凭据判死时抛 NeedLoginError，由 refresh 决定换不换凭据。 */
  async function refreshOnce() {
    const active = currentSession()
    if (!active.signedIn) {
      catalog = []
      catalogAt = 0
      throw new NeedLoginError()
    }
    const rows = await active.models()
    if (rows.length === 0) throw new Error('秒悟没有返回任何模型（/api/v1/agent/models 的形状认不出来）')
    // 目录本身是公开的，不带头也回 200；所以再问一次项目列表确认凭据还活着，
    // 否则过期的 token 会在卡片上显示成「16 个模型，一切正常」，一对话就 401。
    const user = await active.probeAuth()
    // 顺手认人：/api/v1/user/me 会回 username，拿它当昵称，卡片上就不用看
    // 「秒悟 1 / 秒悟 2」这种自己起的名。
    if (user !== null && typeof user === 'object' && typeof user.username === 'string' && user.username.trim() !== '') {
      rememberAccountUser(resolveSecret()?.accountId ?? '', user)
    }
    catalog = rows
    catalogAt = Date.now()
    lastError = ''
    authDead = false
    return rows
  }

  /** 目录不在缓存里就先拉一次；失败不抛（细节进 lastError）。 */
  async function ensureCatalog(force = false) {
    if (!force && catalog.length > 0 && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog
    try {
      return await refresh()
    } catch (error) {
      fail(error)
      // 凭据失效时把目录清掉：留着旧目录会让选择器继续投放一个必然 401 的渠道。
      if (error instanceof NeedLoginError) {
        catalog = []
        catalogAt = 0
      }
      return catalog
    }
  }

  /**
   * 卡片要的状态。
   *
   * `signedIn` 只说明「本机有凭据」，`models` 说明「这份凭据现在真的能用」——
   * 两者分开写，用户才分得清「没登录」和「登录了但过期了」。
   *
   * @param attempt - 内部重试用；已经被上游判死后换过一份浏览器凭据再问一次。
   * @returns 状态对象。
   */
  async function status(attempt = 0) {
    let secret = resolveSecret()
    // 手上没有凭据：先问一次本机浏览器（内部节流，读不到就安静返回）。
    // 「打开秒悟卡片就自动接上 Chrome 登录态」就是这一步做到的。
    if (secret === null && (await healFromBrowser())) secret = resolveSecret()
    if (secret === null) {
      const list = accountList()
      return {
        provider: MEEO_WEB_PROVIDER,
        displayName: MEEO_WEB_DISPLAY_NAME,
        signedIn: false,
        account: null,
        accounts: list.accounts,
        activeAccountId: list.activeAccountId,
        models: 0,
        modelNames: [],
        modelList: [],
        disabledModels: readState().disabledModels,
        secret: null,
        login: { mode: 'paste', autoBrowser: readState().browserAuto !== false },
        error: readState().browserAuto === false
          ? 'NEED_LOGIN：已经退出登录，自动读取本机浏览器也关掉了。贴一个 meoo.com 的 Cookie，或点「刷新模型」重新从浏览器读取。'
          : 'NEED_LOGIN：本机浏览器里也没有找到可用的 meoo.com 登录态。先在 Chrome 里登录 meoo.com，或直接贴一个 Cookie。',
      }
    }
    const rows = await ensureCatalog()
    // 这份凭据被上游判死了：可能用户刚在浏览器里重新登录过，换一份再问一次。
    // 只重试一次，避免「两边都失效」时来回打转。这里用 force：文件里那份和浏览器
    // 看起来一样也要重抄 —— 上一版不 force，于是「判死 → 请贴 Cookie」变成死循环，
    // 用户浏览器里明明是登录着的。
    if (rows.length === 0 && authDead && attempt === 0 && (await healFromBrowser({ force: true }))) {
      return status(1)
    }
    const disabled = disabledSet()
    const list = accountList()
    const activeRow = list.accounts.find(row => row.active === true)
    return {
      provider: MEEO_WEB_PROVIDER,
      displayName: MEEO_WEB_DISPLAY_NAME,
      signedIn: true,
      // 卡片标题优先写昵称（钱禹舟），拿不到才退回来源说明。
      account: { name: activeRow?.nickname || `秒悟 · ${SOURCE_LABELS[secret.source] ?? '手动凭据'}`, id: list.activeAccountId },
      accounts: list.accounts,
      activeAccountId: list.activeAccountId,
      models: rows.length,
      modelNames: rows.map(row => row.name),
      modelList: rows.map(row => ({ id: row.id, name: row.name, disabled: disabled.has(row.id), dead: false })),
      disabledModels: [...disabled],
      secret: describeSecret(secret),
      login: { mode: 'paste', autoBrowser: readState().browserAuto !== false },
      error: lastError,
    }
  }

  /**
   * 贴一份凭据（Cookie 或 token）。
   *
   * 先落盘再验：验不过也留着，用户可以在卡片上看到具体原因，而不是贴了三次都被
   * 悄悄丢掉。
   *
   * @param text - 用户贴的原文。
   * @returns `{ok, stored, error, status}`。
   */
  async function login(text) {
    const parsed = parsePasted(text)
    if (parsed.token === '' && parsed.cookie === '') {
      return { ok: false, stored: false, error: '没读到内容：贴 meoo.com 的 Cookie（形如 `k=v; k2=v2`）或一个 access token。' }
    }
    // 贴一份 = 新增一条账号并切过去，不再覆盖手上那条。
    const created = accountCreate({ text })
    if (created.ok !== true) {
      return { ok: false, stored: false, error: created.error ?? '账号没写进去', status: await status() }
    }
    // 用户亲手贴了凭据：把「退出登录」按下的闸重新放开。
    writeState({ browserAuto: true })
    session = null
    catalog = []
    catalogAt = 0
    let error = ''
    try {
      await refresh()
    } catch (issue) {
      error = fail(issue)
    }
    onTopology()
    return { ok: error === '', stored: true, error, status: await status() }
  }

  /**
   * 删掉「当前账号」（不动 CLI 自己的登录态，也不动别的账号）。
   *
   * 早先这里是「忘掉这份凭据」，多账号之后那个语义会一次清空所有登录态，
   * 所以收窄成只删当前这条 —— 想清空就把账号一条条删掉。
   */
  async function logout() {
    const current = resolveSecret()
    if (current !== null && current.accountId !== '') accountDelete(current.accountId)
    // 一条都不剩时才关掉自动补充，否则下一次开卡片又从浏览器里捡回来了。
    if (accountList().accounts.length === 0) writeState({ browserAuto: false })
    browserAt = 0
    browserOk = false
    authDead = false
    session = null
    catalog = []
    catalogAt = 0
    lastError = ''
    onTopology()
    return { signedIn: resolveSecret() !== null, removed: true }
  }

  /** 卡片上的账号列表（行里不含 cookie/token）。 */
  function listAccounts() {
    return accountList()
  }

  /**
   * 卡片「刷新余额」：按账号逐条查一次积分余额。
   *
   * 额度只在服务端（`/api/mc/entitlement/get`），本机没有副本，所以每次点都要
   * 真的问一次。多账号之后额度是每一条各自的：**每条用自己的 cookie 建一个临时
   * `MeooWebSession`**，不动当前 `session` 缓存 —— 否则问出来的永远是当前那个号，
   * 卡片上就会张冠李戴（千问办公那边踩过同一个坑）。
   *
   * 失败也要带上 accountId 与可读原因：卡片按账号分行显示，出错那行得能对上号。
   */
  async function credits() {
    const store = loadStore()
    const rows = Array.isArray(store.accounts) ? store.accounts : []
    const active = pickUsableAccount(store)
    if (rows.length === 0) {
      // 还没进多账号形态（可能只有 CLI token 或单份凭据）：回一条合成行，
      // id 与卡片侧 account.list 合成的那行保持一致，卡片才对得上号。
      const secret = resolveSecret()
      if (secret === null) return { accounts: [], activeAccountId: '' }
      return { accounts: [await creditOf(secret, 'meoo-web', MEEO_WEB_DISPLAY_NAME)], activeAccountId: 'meoo-web' }
    }
    // 停用的账号不查：查了也只是多一条红字。
    const usable = rows.filter(row => row.enabled !== false)
    const settled = await Promise.all(usable.map(row => creditOf(accountSecret(row), row.id, nicknameOf(row))))
    return { accounts: settled, activeAccountId: active?.id ?? '' }
  }

  /** 单条账号的一次额度查询；任何失败都折成一条可读原因。 */
  async function creditOf(secret, accountId, nickname) {
    const named = typeof nickname === 'string' && nickname !== '' ? nickname : '秒悟'
    if (secret === null) return { accountId, nickname: named, balance: null, error: '这条账号没有可用凭据' }
    try {
      // 临时实例：不写回 session 缓存，也不影响正在跑的对话。
      const probe = new MeooWebSession({ secret })
      const value = await probe.quota()
      return {
        accountId,
        nickname: named,
        // 卡片读 balance.total，不是顶层 total —— 少包一层整张卡就显示「未返回余额数据」。
        balance: { total: value.remaining, unit: value.unit },
        total: value.total,
        used: value.used,
        frozen: value.frozen,
        plan: { code: value.planCode, name: value.planName },
        expiresAt: value.expiresAt,
        error: '',
      }
    } catch (error) {
      return { accountId, nickname: named, balance: null, error: String(error?.message ?? error).slice(0, 160) }
    }
  }

  /** 新增一条账号并切过去；成功与否都回最新 status。 */
  async function addAccount(text) {
    const created = accountCreate({ text })
    if (created.ok !== true) {
      return { ok: false, error: created.error ?? '账号没写进去', account: null, status: await status(), ...accountList() }
    }
    writeState({ browserAuto: true })
    session = null
    catalog = []
    catalogAt = 0
    let error = ''
    try {
      await refresh()
    } catch (issue) {
      error = fail(issue)
    }
    onTopology()
    return { ok: error === '', error, account: created.account ?? null, status: await status(), ...accountList() }
  }

  /**
   * 切换当前账号。
   *
   * 会话和目录都要一起丢掉：旧实例绑的是上一份 cookie，目录也是按上一份凭据
   * 拉的。不重启 DSH 就能切，靠的就是这三行。
   */
  function switchAccount(accountId) {
    const used = accountUse(accountId)
    if (used.ok !== true) return { ok: false, error: used.error ?? '切不过去', ...accountList() }
    session = null
    catalog = []
    catalogAt = 0
    lastError = ''
    authDead = false
    onTopology()
    return { ok: true, ...accountList() }
  }

  /** 改昵称 / 启停。停用的若是当前账号，active 自己退到下一条。 */
  function patchAccount(accountId, patch) {
    const done = accountUpdate({ accountId, patch })
    if (done.ok !== true) return { ok: false, error: done.error ?? '改不动', ...accountList() }
    // 停用了当前账号：凭据换了，会话必须重建。
    session = null
    catalog = []
    catalogAt = 0
    onTopology()
    return { ok: true, ...accountList() }
  }

  /** 删一条账号。删的是当前账号时 active 自动退位，会话跟着重建。 */
  function removeAccount(accountId) {
    const current = resolveSecret()
    const done = accountDelete(accountId)
    if (done.ok !== true) return { ok: false, error: done.error ?? '删不掉', ...accountList() }
    if (current !== null && current.accountId === accountId) {
      session = null
      catalog = []
      catalogAt = 0
      lastError = ''
      authDead = false
    }
    onTopology()
    return { ok: true, ...accountList() }
  }

  /**
   * 卡片「测试」：真问一次模型目录，量一下往返。
   *
   * @returns `{ok, ms, message, models}`。
   */
  async function test() {
    const startedAt = Date.now()
    try {
      const rows = await refresh()
      return { ok: true, ms: Date.now() - startedAt, message: `${rows.length} 个模型`, models: rows.length }
    } catch (error) {
      return { ok: false, ms: Date.now() - startedAt, message: fail(error), models: catalog.length }
    }
  }

  /** 关掉 / 打开一个模型。 */
  function setModelDisabled(modelId, disabled = true) {
    const id = String(modelId ?? '').trim()
    if (id === '') return { disabledModels: readState().disabledModels }
    const current = new Set(readState().disabledModels)
    if (disabled === true) current.add(id)
    else current.delete(id)
    writeState({ disabledModels: [...current] })
    onTopology()
    return { disabledModels: [...current] }
  }

  /** 一键全关 / 全开。 */
  function setAllModelsDisabled(disabled = true) {
    const current = new Set(readState().disabledModels)
    if (disabled === true) {
      for (const row of catalog) current.add(row.id)
    } else {
      for (const row of catalog) current.delete(row.id)
    }
    writeState({ disabledModels: [...current] })
    onTopology()
    return { disabledModels: [...current] }
  }

  /** 目录为空时选一个能用的模型 id：优先第一个没被关掉的。 */
  function pickModel() {
    const disabled = disabledSet()
    const row = catalog.find(entry => !disabled.has(entry.id))
    return row?.id ?? ''
  }

  async function resolveModel(provider, model) {
    const id = String(model ?? '')
    const entry = catalog.find(row => row.id === id)
    return {
      provider,
      id,
      name: entry === undefined ? id : entry.name,
      inputModalities: ['text'],
      context: { contextWindow: MEEO_WEB_CONTEXT_WINDOW },
      defaultMaxTokens: MEEO_WEB_MAX_OUTPUT_TOKENS,
    }
  }

  /**
   * 一次真实的流式回合。
   *
   * 上游给的是 agent 事件流，宿主只吃 OpenAI chunk，所以中间放一层翻译器；
   * 翻译器自己负责「快照只补差集」，这里只管把 chunk 推进管道。
   *
   * @param options - 宿主的流式请求。
   * @param modelId - 选中的模型 id。
   * @yields 宿主认识的事件。
   */
  async function* stream(options, modelId) {
    if (resolveSecret() === null) await healFromBrowser()
    if (resolveSecret() === null) throw new NeedLoginError()
    if (catalog.length === 0) await ensureCatalog()
    const chosen = modelId !== '' ? modelId : pickModel()
    if (chosen === '') throw new Error('秒悟网页：这个渠道还没有可用模型（先去卡片上点「刷新模型」）')

    const prompt = flattenPrompt(options?.messages)
    if (prompt === '') throw new Error('秒悟网页：这一轮没有可发送的正文')

    const active = currentSession()
    const channel = createChannel()
    const controller = new AbortController()
    const outer = options?.signal
    if (outer !== undefined && outer !== null) {
      // 取消要同时办两件事：本地这条 fetch 立刻断（用户马上不想等了），以及
      // 让上游把任务停掉（否则它在后台跑完，额度照烧）。`stop()` 自己吞掉一切
      // 失败并带 8 秒超时，这里不用等它。
      const onAbort = () => {
        controller.abort(outer.reason)
        void active.stop()
      }
      if (outer.aborted === true) onAbort()
      else outer.addEventListener('abort', onAbort, { once: true })
    }

    void (async () => {
      const translator = new MeooSseTranslator({
        // 认不出来的事件不能就这么丢：秒悟改事件名的症状恰好是「能发、正常
        // 结束、一个字没有」。记一份清单，空流时写进报错里给人看。
        onUnknown: inner => {
          noteUnknownFrame(inner)
          logger?.warn?.(`get-it-for-free: 秒悟网页出现没见过的上游事件 ${inner}（开 MEOO_DEBUG=1 可看原始帧）`)
        },
      })
      try {
        const response = await active.openChat({ model: chosen, message: prompt, signal: controller.signal })
        for await (const payload of sseEvents(response.body, controller.signal)) {
          logFrame(payload)
          for (const chunk of translator.handle(payload)) channel.push(chunk)
          // 收尾 chunk 发出去之后不再立刻断开：`ui:agent_task_end` 只代表 agent
          // 这一轮结束，上游后面还会发 `task_complete`（带终稿正文），早断就把
          // 终稿的差额一起丢了。真出错时上游也不会再发正文，直接收工。
          if (translator.closed && (payload?.type === 'task_complete' || payload?.type === 'error' || payload?.type === 'server_error')) break
        }
        if (translator.text === '') {
          // 一条正文都没发：这不是「空回答」，是上游没给东西（事件名漂移、任务没
          // 跑起来、或者被拦了）。以前这里补一个 finish 收尾，等于把「无输出」
          // 伪装成「正常结束」—— 用户看到的就是一句空气，还没有任何线索。
          const unknown = translator.unknownTypes
          const hint = unknown.length === 0
            ? ''
            : `（已记录 ${unknown.length} 个没见过的上游事件：${unknown.slice(0, 5).join('、')}；开 MEOO_DEBUG=1 可看原始帧）`
          channel.push(new Error(`秒悟网页：上游没有返回任何内容${hint}`))
          return
        }
        if (!translator.closed) {
          // 流断了但上游没发终稿：补一个收尾，别让这一轮永远挂在「生成中」。
          for (const chunk of translator.handle({ type: 'task_complete' })) channel.push(chunk)
        }
        channel.push(undefined)
      } catch (error) {
        channel.push(error instanceof Error ? error : new Error(String(error)))
      }
    })()

    // readStream 只把上游的 finish 记进快照，不产出 finish 块 —— 而宿主的块协议
    // 靠 finish 块收尾。以前这里直接结束，网关于是判定「流没结束就断了」，
    // 统一回 502 incomplete_stream（即使正文已经正常吐完）。
    const outcome = yield* readStream(channel.read(), 'chat', new Map(), () => Date.now(), {})
    if (outcome.sawUsage === true) yield { type: 'usage', usage: outcome.usage }
    yield { type: 'finish', reason: outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish) }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: MEEO_WEB_DISPLAY_NAME }
    },

    // 这几个宿主会无守卫地调用：缺一个就是 TypeError，路由整体挂不上。
    providerRetryPolicy() {
      return undefined
    },

    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(provider, model, image) {
      return { width: image.width, height: image.height }
    },

    async listModels(provider) {
      // 没凭据时先去本机浏览器捞一次（节流），捞不到就一条都不投放：
      // 选择器里看不到这条渠道，别的渠道不受影响。
      if (resolveSecret() === null) await healFromBrowser()
      if (resolveSecret() === null) return []
      const rows = await ensureCatalog()
      const disabled = disabledSet()
      return rows
        .filter(row => !disabled.has(row.id))
        .map(row => ({
          provider,
          id: row.id,
          name: row.name,
          description: '秒悟 · 网页版',
          inputModalities: ['text'],
        }))
    },

    resolveModel,

    stream(options) {
      return stream(options, String(options?.model ?? ''))
    },

    async prepareCall(provider, model) {
      return {
        model: await resolveModel(provider, model),
        stream: options => stream(options, model),
      }
    },
  }

  return {
    adapter,
    status,
    login,
    logout,
    accounts: listAccounts,
    accountCreate: addAccount,
    accountUse: switchAccount,
    accountUpdate: patchAccount,
    accountRemove: removeAccount,
    /**
     * 开登录窗。不传 accountId = 添加新账号（staging 分区，先清空）。
     * 传 accountId = 重登那条账号（它自己的分区，不清；除非已经判死）。
     */
    loginWindow: options => runLoginWindow({
      accountId: typeof options?.accountId === 'string' ? options.accountId : '',
      clear: options?.clear !== false,
    }),
    loginWindowAvailable,
    refresh,
    models: async () => {
      const rows = await refresh()
      return { models: rows.map(row => ({ id: row.id, name: row.name })) }
    },
    test,
    setModelDisabled,
    setAllModelsDisabled,
    credits,
    describe: () => ({ provider: MEEO_WEB_PROVIDER, signedIn: resolveSecret() !== null, secret: describeSecret(resolveSecret()), projectId: session?.projectId ?? '' }),
    dispose: () => { session = null },
  }
}

/** 备用：给外部（例如自检脚本）用的模型行解析，避免重复实现。 */
export { modelRows, readStored }
