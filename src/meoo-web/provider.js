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
import { readStream } from '../stream.js'
import {
  MeooWebSession,
  NeedLoginError,
  clearStored,
  describeSecret,
  modelRows,
  parsePasted,
  readStored,
  resolveSecret,
  writeStored,
} from './session.js'
import { MeooSseTranslator, sseEvents } from './sse.js'

export const MEEO_WEB_PROVIDER = 'meoo-web'
export const MEEO_WEB_DISPLAY_NAME = '秒悟 · 网页版'

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

/** 读偏好（目前只有一份模型黑名单）。 */
function readState() {
  try {
    const body = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return { disabledModels: Array.isArray(body?.disabledModels) ? body.disabledModels.filter(id => typeof id === 'string') : [] }
  } catch {
    return { disabledModels: [] }
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

  /** 拿到（必要时重建）会话。 */
  function currentSession() {
    if (session !== null) return session
    session = new MeooWebSession({ secret: resolveSecret() })
    return session
  }

  /** 模型黑名单的集合视图。 */
  function disabledSet() {
    return new Set(readState().disabledModels)
  }

  /** 记一条失败原因，同时保证日志里看得见。 */
  function fail(error) {
    lastError = String(error?.message ?? error ?? '未知原因')
    if (!(error instanceof NeedLoginError)) logger?.warn?.(`get-it-for-free: 秒悟网页 ${lastError}`)
    return lastError
  }

  /**
   * 重拉模型目录。
   *
   * @returns 目录行 `[{id, name}]`。
   */
  async function refresh() {
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
    await active.probeAuth()
    catalog = rows
    catalogAt = Date.now()
    lastError = ''
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
   * @returns 状态对象。
   */
  async function status() {
    const secret = resolveSecret()
    if (secret === null) {
      return {
        provider: MEEO_WEB_PROVIDER,
        displayName: MEEO_WEB_DISPLAY_NAME,
        signedIn: false,
        account: null,
        models: 0,
        modelNames: [],
        modelList: [],
        disabledModels: readState().disabledModels,
        secret: null,
        login: { mode: 'paste' },
        error: 'NEED_LOGIN：还没有秒悟网页的凭据。贴一个 meoo.com 的 Cookie（或先在本机跑一次 meoo login）。',
      }
    }
    const rows = await ensureCatalog()
    const disabled = disabledSet()
    return {
      provider: MEEO_WEB_PROVIDER,
      displayName: MEEO_WEB_DISPLAY_NAME,
      signedIn: true,
      account: { name: `秒悟 · ${secret.source === 'cli' ? 'CLI 登录态' : '手动凭据'}` },
      models: rows.length,
      modelNames: rows.map(row => row.name),
      modelList: rows.map(row => ({ id: row.id, name: row.name, disabled: disabled.has(row.id), dead: false })),
      disabledModels: [...disabled],
      secret: describeSecret(secret),
      login: { mode: 'paste' },
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
    writeStored(parsed)
    session = null
    catalog = []
    catalogAt = 0
    let error = ''
    try {
      await refresh()
    } catch (issue) {
      error = fail(issue)
    }
    return { ok: error === '', stored: true, error, status: await status() }
  }

  /** 忘掉这份凭据（不动 CLI 自己的登录态）。 */
  async function logout() {
    clearStored()
    session = null
    catalog = []
    catalogAt = 0
    lastError = ''
    return { signedIn: false, removed: true }
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
      if (outer.aborted === true) controller.abort(outer.reason)
      else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true })
    }

    void (async () => {
      const translator = new MeooSseTranslator()
      try {
        const response = await active.openChat({ model: chosen, message: prompt, signal: controller.signal })
        for await (const payload of sseEvents(response.body, controller.signal)) {
          for (const chunk of translator.handle(payload)) channel.push(chunk)
          if (translator.closed) break
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

    yield* readStream(channel.read(), 'chat', new Map(), () => Date.now(), {})
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
      // 没凭据时一条都不投放：选择器里看不到这条渠道，别的渠道不受影响。
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
    refresh,
    models: async () => {
      const rows = await refresh()
      return { models: rows.map(row => ({ id: row.id, name: row.name })) }
    },
    test,
    setModelDisabled,
    setAllModelsDisabled,
    describe: () => ({ provider: MEEO_WEB_PROVIDER, signedIn: resolveSecret() !== null, secret: describeSecret(resolveSecret()), projectId: session?.projectId ?? '' }),
    dispose: () => { session = null },
  }
}

/** 备用：给外部（例如自检脚本）用的模型行解析，避免重复实现。 */
export { modelRows, readStored }
