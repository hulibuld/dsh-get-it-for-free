// 豆包工作的「模型选择器适配器」。
//
// 面板上那张卡（账号 / 额度 / 目录 / 签到）走的是我们自己的 REST 路由；这里
// 是另一半：把豆包的 12 个模型真正注册给宿主的 LLM 层，让它们出现在右下角的
// 模型选择器里、能被选来跑会话。
//
// 两个刻意的取舍：
//   1. **无状态**。豆包原生靠 conversation_id 续上下文，但一个账号只有 3 个并发
//      会话槽（超了回 TM.00001041）。宿主每轮都会把完整 transcript 交给我们，
//      所以这里把 transcript 拍平成一段话发出去，从不 hold 服务端会话 ——
//      少一点上下文效率，换掉整类「槽位泄漏」的故障。
//   2. **只做文本**。豆包不吃 `tools` 数组（它的工具调用是客户端运行时那套），
//      所以这里不假装支持工具，只转正文增量。
//
// 上游协议细节都在 ./client.js 里（cookie、device id、帧格式），这里只负责把
// 那些帧翻译成宿主认识的 OpenAI 形状。

import {
  DoubaoError,
  ERROR,
  buildChatBody,
  buildHeaders,
  buildQuery,
  collectText,
  parseFrames,
} from './client.js'
import { createChannel } from '../channel.js'
import { readStream } from '../stream.js'

export const DOUBAO_PROVIDER = 'doubao'
export const DOUBAO_DISPLAY_NAME = '豆包工作'

const CHAT_PATH = '/chat/completion'
const DEFAULT_MAX_TOKENS = 8192

/** 一个模型行在卡片/选择器里的副标题。倍率来自上游 tag_list（"0.65x"）。 */
function describeModel(entry) {
  const parts = [DOUBAO_DISPLAY_NAME, '网页版额度']
  if (typeof entry.ratio === 'string' && entry.ratio !== '') parts.push(entry.ratio)
  return parts.join(' · ')
}

/**
 * 把宿主的 messages 拍成豆包要的那一段 prompt。
 *
 * 保留角色标签，因为拍平之后模型只能靠标签分辨谁说了什么；工具结果折叠成
 * 「工具结果」而不是伪装成 user，免得模型把它们当成用户的话去回答。
 */
export function flattenMessages(messages) {
  const rows = Array.isArray(messages) ? messages : []
  const system = []
  const turns = []
  for (const row of rows) {
    const role = typeof row?.role === 'string' ? row.role : 'user'
    const text = contentText(row?.content)
    if (text === '') continue
    if (role === 'system') system.push(text)
    else if (role === 'tool') turns.push(`[工具结果] ${text}`)
    else if (role === 'assistant') turns.push(`[助手] ${text}`)
    else turns.push(`[用户] ${text}`)
  }
  const head = system.length > 0 ? `${system.join('\n\n')}\n\n` : ''
  const tail = turns.length > 0 ? turns.join('\n\n') : ''
  return `${head}${tail}`
}

/** 消息内容可能是字符串，也可能是 block 数组（图片、工具结果）。 */
function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (typeof block === 'string') out.push(block)
    else if (typeof block?.text === 'string') out.push(block.text)
    else if (block?.type === 'image') out.push('[图片]')
  }
  return out.join('\n').trim()
}

/** 上游一次会话最多 3 个并发槽；超出时把话说清楚，别让用户对着超时发呆。 */
function explain(error) {
  if (error instanceof DoubaoError) {
    if (error.code === ERROR.SESSION_EXPIRED) return new Error('豆包登录态已失效：请在「Get It For Free」的豆包卡里重新扫码登录')
    if (error.code === ERROR.RISK_CONTROL) return new Error('豆包风控拦下了这次请求（710022004）：过一会再试，或先在网页版发一条消息')
    if (error.code === 'TM.00001041') return new Error('豆包这个账号的并发会话已满（3 个）：稍等再试')
    return new Error(`豆包返回错误${error.code === '' ? '' : ` ${error.code}`}：${error.message}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 一帧上游事件 -> 若干段正文。返回空数组表示这帧没有可见文字。 */
function textOf(frame, state) {
  if (frame.event !== 'STREAM_MSG_NOTIFY' && frame.event !== 'STREAM_CHUNK' && frame.event !== 'CHUNK_DELTA') {
    return []
  }
  let payload
  try {
    payload = JSON.parse(frame.data)
  } catch {
    return []
  }
  const out = []
  collectText(payload, out, state)
  return out
}

/**
 * 豆包自己的思考强度菜单。
 *
 * 上游 `reasoning_effort_config.option_list` 给的是一串 `{level, name}`，level 是数字
 * （1/2/3 这类），发请求时要把它放进 `reasoning_effort` 字段。宿主的选择器只认
 * 「模型声明了哪些强度」这一份元数据，所以这里把上游菜单直接翻译过去 —— 不自己造
 * 一套 low/high 的假名字，那样面板点了也发不出去。
 *
 * @param {any} entry 目录行
 * @returns {{efforts: {id: string, name: string}[], defaultEffort?: string}}
 */
function effortMenuOf(entry) {
  const rows = Array.isArray(entry?.reasoning) ? entry.reasoning : []
  const efforts = []
  const seen = new Set()
  for (const row of rows) {
    const id = String(row?.level ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = String(row?.name ?? '').trim()
    efforts.push({ id, name: name === '' ? id : name })
  }
  if (efforts.length === 0) return { efforts }
  // 默认挑最高一档：豆包网页版自己的默认就是最深的那个。用户没点强度时按它发，
  // 与旧行为（写死 3）一致，不会因为这次改动让输出变浅。
  const numeric = efforts
    .map(row => ({ id: row.id, value: Number(row.id) }))
    .filter(row => Number.isFinite(row.value))
    .sort((left, right) => right.value - left.value)
  const chosen = numeric.length > 0 ? numeric[0].id : efforts[efforts.length - 1].id
  return { efforts, defaultEffort: chosen }
}

/** 宿主选中的强度 -> 上游要的数字。没选或选了个不在菜单里的，退回默认档。 */
function reasoningLevelOf(entry, requested) {
  const menu = effortMenuOf(entry)
  const wanted = String(requested ?? '').trim()
  const picked = menu.efforts.some(row => row.id === wanted) ? wanted : menu.defaultEffort
  const level = Number(picked)
  return Number.isFinite(level) ? level : 3
}

/**
 * 建立适配器。
 *
 * @param doubao - `src/doubao/index.js` 的运行时（提供 `models` / `pickAccount`）。
 * @param logger - 日志。
 */
export function createDoubaoAdapter({ doubao, logger = console } = {}) {
  // 目录走两条路：
  //   1. 注册那一刻要的答案 —— 只读本地快照，绝不等网络。宿主在挂载时问一次
  //      listModels，那一问超时或抛错，这一组模型就再也不出现（而且没有重试
  //      入口），所以我们宁可先给一份旧快照，也不让这一问落在网络往返上。
  //   2. 快照为空时在后台补拉一次，拉到就广播 `llm/adapters-updated`，让选择器
  //      自己重挂。这就是「面板说有 12 个模型、右下角一个都没有」的修法。
  let refreshing = false
  async function roster() {
    try {
      const rows = await doubao.modelsSnapshot()
      if (rows.length > 0) return rows
    } catch (error) {
      logger.warn?.(`get-it-for-free: 豆包本地目录读取失败：${error?.message ?? error}`)
    }
    if (!refreshing) {
      refreshing = true
      void doubao.models()
        .catch(error => {
          logger.warn?.(`get-it-for-free: 豆包模型目录读取失败：${error?.message ?? error}`)
        })
        .finally(() => { refreshing = false })
    }
    return []
  }

  /** 后台补拉一次目录（加账号、点「刷新模型」之后用）。 */
  function warm() {
    if (refreshing) return
    refreshing = true
    void doubao.models()
      .catch(error => {
        logger.warn?.(`get-it-for-free: 豆包模型目录读取失败：${error?.message ?? error}`)
      })
      .finally(() => { refreshing = false })
  }

  async function resolveModel(provider, model) {
    const id = String(model ?? '')
    const entries = await roster()
    const entry = entries.find(row => row.id === id) ?? { id, name: id }
    const menu = effortMenuOf(entry)
    return {
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      inputModalities: ['text'],
      context: { contextWindow: Number(entry.contextWindow) > 0 ? Number(entry.contextWindow) : 256000 },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      // 只有上游真的给了强度菜单才声明。空菜单会让选择器显示一栏点了没反应的强度。
      ...menu.efforts.length === 0 ? {} : { reasoning: { efforts: menu.efforts, defaultEffort: menu.defaultEffort } },
    }
  }

  /**
   * 一次真实的流式回合。
   *
   * 上游给的是三行帧（`id:` / `event:` / `data:`），我们把它翻成 OpenAI 的
   * `chat.completion.chunk` 形状交给 `readStream` —— 那条投影已经处理好了块索引、
   * 用量与结束原因，自己再写一遍只会写漏。
   */
  async function* stream(options, modelId) {
    const account = await doubao.pickAccount()
    if (!account) {
      throw new Error('豆包工作还没有登录账号：在设置的豆包卡里点「添加账号」扫码登录')
    }
    const signal = options?.signal
    const prompt = flattenMessages(options?.messages)
    if (prompt === '') throw new Error('这一轮没有可发送的内容')

    const url = `https://www.doubao.com${CHAT_PATH}?${buildQuery(account.cookieHeader)}`
    const headers = {
      ...buildHeaders(account.cookieHeader),
      Accept: 'text/event-stream',
      'content-type': 'application/json',
    }
    const entry = (await roster()).find(row => row.id === modelId) ?? { id: modelId }
    const body = JSON.stringify(buildChatBody(prompt, {
      modelId,
      taskMode: entry.isTaskMode === true,
      reasoningLevel: reasoningLevelOf(entry, options?.reasoningEffort),
    }))

    if (typeof globalThis.fetch !== 'function') {
      throw new Error('豆包通道需要宿主提供全局 fetch；这个运行环境没有')
    }
    let response
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal })
    } catch (error) {
      throw explain(error)
    }
    if (response.status === 401) {
      throw new Error('豆包登录态已失效：请在豆包的卡里重新扫码登录')
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`豆包拒绝了这个请求：HTTP ${response.status}${detail === '' ? '' : ` · ${detail.slice(0, 200)}`}`)
    }
    if (response.body === null || typeof response.body.getReader !== 'function') {
      throw new Error('豆包没有返回事件流')
    }

    const channel = createChannel()
    const state = { thinkingIds: new Set() }
    const push = delta => {
      channel.push(JSON.stringify({
        id: 'doubao',
        object: 'chat.completion.chunk',
        model: modelId,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      }))
    }

    void (async () => {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let ended = false
      try {
        while (!ended) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseFrames(buffer)
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            if (frame.event === 'STREAM_ERROR') {
              let code = ''
              let message = '上游报错'
              try {
                const payload = JSON.parse(frame.data)
                code = String(payload?.error_code ?? '')
                message = String(payload?.error_msg ?? message)
              } catch { /* 用默认文案 */ }
              throw explain(new DoubaoError(code || 'STREAM_ERROR', message))
            }
            if (frame.event === 'SSE_REPLY_END') {
              ended = true
              break
            }
            for (const piece of textOf(frame, state)) if (piece !== '') push(piece)
          }
        }
        buffer += decoder.decode()
        if (!ended) {
          const parsed = parseFrames(`${buffer}\n\n`)
          for (const frame of parsed.frames) {
            if (frame.event === 'SSE_REPLY_END') { ended = true; break }
            for (const piece of textOf(frame, state)) if (piece !== '') push(piece)
          }
        }
        // 上游没有 usage，也不给结束原因：补一个正常的 stop，让宿主的块协议收尾。
        channel.push(JSON.stringify({
          id: 'doubao',
          object: 'chat.completion.chunk',
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }))
        channel.push(undefined)
      } catch (error) {
        channel.push(explain(error))
      } finally {
        try { reader.cancel() } catch { /* 已经关了 */ }
      }
    })()

    yield* readStream(channel.read(), 'chat', new Map(), () => Date.now(), {})
  }

  // 挂载后不久补拉一次目录：宿主挂载时问的那一次只能拿到快照，而快照可能是
  // 空的（新装/换了账号）。等宿主把路由都装好再补这一次，就不会和挂载抢时间。
  const prime = setTimeout(() => { warm() }, 2_000)
  if (typeof prime.unref === 'function') prime.unref()

  return {
    providerInfo(provider) {
      return { id: provider, name: DOUBAO_DISPLAY_NAME }
    },

    // 这三个宿主会无守卫地调用：缺一个就是 TypeError，路由整体挂不上。
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
      // 没有账号时给空表：宁可这组不出现在选择器里，也不提供一条按不动的模型。
      const account = await doubao.pickAccount()
      if (!account) return []
      const entries = await roster()
      return entries.map(entry => {
        const menu = effortMenuOf(entry)
        return {
          provider,
          id: entry.id,
          name: entry.name ?? entry.id,
          description: describeModel(entry),
          inputModalities: ['text'],
          ...menu.efforts.length === 0 ? {} : { reasoning: { efforts: menu.efforts, defaultEffort: menu.defaultEffort } },
        }
      })
    },

    resolveModel,

    async prepareCall(provider, model) {
      return {
        model: await resolveModel(provider, model),
        stream: options => stream(options, model),
      }
    },
  }
}
