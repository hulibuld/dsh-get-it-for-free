/**
 * 秒悟网页（meoo.com）的 SSE 翻译层。
 *
 * 上游不是 OpenAI 协议：agent 的流是一串单行 `data: {json}`，事件类型写在
 * `type` 上（`task_id` / `task_complete` / `error` / `ui_event` …），增量正文藏在
 * `ui_event` 的 `data.type` 里（`ui:agent_thinking`、`ui:agent_synthesis_text_delta`、
 * `ui:sync_assistant_update` …）。宿主的 `readStream('chat')` 只认 OpenAI 的
 * `choices[].delta`，所以这里把上游事件翻成 OpenAI chunk 再交出去。
 *
 * 两种正文语义必须分开处理，混起来就会重复输出：
 *   - **增量**（`*_delta` / `*_text_stream`）：直接接在已发内容后面。
 *   - **快照**（`ui:add_agent_message`、`ui:agent_message_update`、
 *     `ui:sync_assistant_update`）：带的是到目前为止的完整正文，要和已发的比前缀，
 *     只补差集。
 *   - **终稿**（`task_complete.text`）：同样是快照；已经流完了就一条都不再发。
 *
 * @module dsh-get-it-for-free/meoo-web/sse
 */

/** 上游事件里代表「正文结束」的类型。 */
const TERMINAL_EVENTS = new Set(['ui:agent_task_end', 'ui:agent_finish_reason'])

/** 上游事件里带增量正文的类型。 */
const DELTA_EVENTS = new Set([
  'ui:agent_sub_task_text_delta',
  'ui:agent_synthesis_text_delta',
  'ui:swarms_text_stream',
  'ui:btw_text_stream',
  'ui:enhance_text_stream',
])

/** 上游事件里带快照正文的类型。 */
const SNAPSHOT_EVENTS = new Set([
  'ui:add_agent_message',
  'ui:agent_message_update',
  'ui:sync_assistant_update',
  'ui:sync_messages_update',
])

/**
 * 从事件对象里捞一段正文。
 *
 * 上游同一个字段在不同版本里换过名字（`text` / `content` / `delta` /
 * `message.content`），所以按顺序都试一遍，拿到第一个非空字符串就走。
 *
 * @param data - 上游事件对象。
 * @returns 正文，或 undefined。
 */
function textOf(data) {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return undefined
  for (const key of ['text', 'delta', 'content', 'deltaText', 'answer', 'value']) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const message = data.message
  if (typeof message === 'string' && message !== '') return message
  if (message !== null && typeof message === 'object') {
    for (const key of ['content', 'text', 'answer']) {
      const value = message[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

/**
 * 把一个上游事件翻成「这件事意味着什么」。
 *
 * 纯函数，不碰状态：`task_complete` 该不该发、快照该补多少，都由调用方按已发
 * 内容决定。
 *
 * @param payload - SSE 帧里的 JSON。
 * @returns {{taskId?: string, text?: string, snapshot?: string, reasoning?: string, final?: string, done?: boolean, error?: string}}
 */
export function translateEvent(payload) {
  if (payload === null || typeof payload !== 'object') return {}
  const type = payload.type

  if (type === 'task_id') {
    const id = typeof payload.text === 'string' ? payload.text.trim() : ''
    return id === '' ? {} : { taskId: id }
  }
  if (type === 'task_complete') {
    const final = textOf(payload) ?? textOf(payload.data)
    return { ...(final === undefined ? {} : { final }), done: true }
  }
  if (type === 'error' || type === 'server_error') {
    const detail = payload.data !== null && typeof payload.data === 'object' ? payload.data.message : undefined
    const message = typeof detail === 'string' && detail !== '' ? detail
      : typeof payload.text === 'string' && payload.text !== '' ? payload.text
        : typeof payload.message === 'string' && payload.message !== '' ? payload.message : '秒悟上游返回了错误事件'
    return { error: message, done: true }
  }
  if (type !== 'ui_event') return {}

  const data = payload.data
  if (data === null || typeof data !== 'object') return {}
  const inner = typeof data.type === 'string' ? data.type : ''

  if (inner === 'ui:agent_thinking') {
    const reasoning = textOf(data)
    return reasoning === undefined ? {} : { reasoning }
  }
  if (TERMINAL_EVENTS.has(inner)) return { done: true }
  if (DELTA_EVENTS.has(inner)) {
    const text = textOf(data)
    return text === undefined ? {} : { text }
  }
  if (SNAPSHOT_EVENTS.has(inner)) {
    const snapshot = textOf(data)
    return snapshot === undefined ? {} : { snapshot }
  }
  return {}
}

/** 一个 OpenAI 形状的增量 chunk。 */
function deltaChunk(delta) {
  return JSON.stringify({ id: 'meoo-web', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })
}

/** 收尾 chunk：宿主看到 finish_reason 就会把这一轮判成正常结束。 */
function finishChunk() {
  return JSON.stringify({ id: 'meoo-web', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
}

/** 错误 chunk：宿主的 chat 分支见到 `error` 会按 classifyFailure 抛出来。 */
function errorChunk(message) {
  return JSON.stringify({ error: { message, type: 'meoo_web_error' } })
}

/**
 * 把上游事件流翻译成 OpenAI chunk 流。
 *
 * 只负责「已发内容」这一份状态：谁先到谁说了算，快照永远只补差集。
 */
export class MeooSseTranslator {
  /** 已经发出去的正文。 */
  #sent = ''
  /** 是否已经发过收尾 chunk。 */
  #closed = false
  /** 上游给的任务 id（诊断用，不进正文）。 */
  #taskId = ''

  /** 上游任务 id，收到 `task_id` 之后才有。 */
  get taskId() {
    return this.#taskId
  }

  /** 是否已经收尾。 */
  get closed() {
    return this.#closed
  }

  /**
   * 吞一个事件，吐出要推给宿主的 chunk。
   *
   * @param payload - SSE 帧里的 JSON。
   * @returns chunk 字符串数组（可能为空）。
   */
  handle(payload) {
    const event = translateEvent(payload)
    const out = []
    if (event.taskId !== undefined) this.#taskId = event.taskId

    if (event.reasoning !== undefined) out.push(deltaChunk({ reasoning: event.reasoning }))

    if (event.text !== undefined) {
      this.#sent += event.text
      out.push(deltaChunk({ content: event.text }))
    }

    if (event.snapshot !== undefined) {
      const delta = this.#diff(event.snapshot)
      if (delta !== '') out.push(deltaChunk({ content: delta }))
    }

    if (event.final !== undefined) {
      // 终稿常常和已经流出去的内容一字不差；只补它多出来的尾巴。
      const delta = this.#diff(event.final)
      if (delta !== '') out.push(deltaChunk({ content: delta }))
    }

    if (event.error !== undefined) {
      out.push(errorChunk(event.error))
      this.#closed = true
      return out
    }

    if (event.done === true && !this.#closed) {
      this.#closed = true
      out.push(finishChunk())
    }
    return out
  }

  /**
   * 算快照相对已发内容的增量。
   *
   * 上游偶尔会重写整段（快照和已发内容不是前缀关系）。这时**不重发**：重发会让
   * 用户看到同一段话两遍，而少补一句话只是难看，不算坏。唯一例外是终稿并且我们
   * 一个字都还没发过 —— 那种情况下整段就是该说的话。
   *
   * @param snapshot - 上游给的完整正文。
   * @param final - 是不是终稿。
   * @returns 要补的增量（可能为空串）。
   */
  #diff(snapshot) {
    if (snapshot === this.#sent) return ''
    if (this.#sent === '') {
      this.#sent = snapshot
      return snapshot
    }
    if (snapshot.startsWith(this.#sent)) {
      const delta = snapshot.slice(this.#sent.length)
      this.#sent = snapshot
      return delta
    }
    return ''
  }
}

/**
 * 把一条 SSE 响应体读成事件对象。
 *
 * 行协议按上游实际发的来：`data: {json}` 单行、`:` 开头是心跳注释、帧之间空行。
 * 一帧里出现多行 `data:` 时按 SSE 规范用换行拼起来再解析 —— 上游现在是单行，
 * 但这是协议允许的形状，多写三行就不用等它哪天改。
 *
 * @param body - `response.body`（ReadableStream）。
 * @param signal - 调用方的 abort signal。
 * @yields 解析后的事件对象；解析不了的行直接丢。
 */
export async function* sseEvents(body, signal) {
  if (body === null || typeof body.getReader !== 'function') return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted === true) return
      const { value, done } = await reader.read()
      if (done === true) break
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const payload = parseFrame(frame)
        if (payload !== undefined) yield payload
        cut = buffer.indexOf('\n\n')
      }
    }
    const tail = parseFrame(buffer)
    if (tail !== undefined) yield tail
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

/**
 * 解析一帧 SSE 文本。
 *
 * @param frame - 不含结尾空行的一帧。
 * @returns 解析后的事件对象，或 undefined。
 */
function parseFrame(frame) {
  const data = []
  for (const rawLine of String(frame ?? '').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '' || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    const value = line.slice(5)
    data.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  if (data.length === 0) return undefined
  const text = data.join('\n').trim()
  if (text === '' || text === '[DONE]') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
