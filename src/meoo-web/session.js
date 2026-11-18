/**
 * 秒悟网页（meoo.com）会话层。
 *
 * 这条通道用**用户自己在浏览器里的登录态**，不自己造账号、不自己刷令牌：
 *
 *   1. 首选 `~/.meoo/credentials.json` 里的 `accessToken`（官方 CLI 登录后落盘的
 *      那份，只读，不写回去）；
 *   2. 其次插件自己存的一份「用户贴进来的 Cookie / token」——
 *      `~/.dsh/get-it-for-free/meoo-web.json`。
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

import { resolveDshHome } from '../store.js'

/** 网页站点的 origin。 */
export const MEEO_WEB_ORIGIN = 'https://meoo.com'

/** 上游端点。 */
export const MEEO_WEB_APIS = {
  models: '/api/v1/agent/models',
  start: '/api/agent/start',
  stop: '/api/agent/stop',
  query: '/api/agent/query',
  projectList: '/api/v1/project/list',
  projectEnsure: '/api/v1/project/ensure',
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

/** 插件自己的凭据落盘位置。 */
export function statePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'meoo-web.json')
}

/**
 * 读插件存的那份凭据。
 *
 * @returns {{token: string, cookie: string, savedAt: number}} 缺失的字段是空串。
 */
export function readStored() {
  try {
    const body = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return {
      token: typeof body?.token === 'string' ? body.token : '',
      cookie: typeof body?.cookie === 'string' ? body.cookie : '',
      savedAt: Number.isFinite(body?.savedAt) ? body.savedAt : 0,
    }
  } catch {
    return { token: '', cookie: '', savedAt: 0 }
  }
}

/**
 * 覆盖写入凭据文件（目录不存在就建）。
 *
 * @param next - `{token, cookie}`；两个都空等于清空。
 */
export function writeStored(next) {
  const file = statePath()
  const token = typeof next?.token === 'string' ? next.token.trim() : ''
  const cookie = typeof next?.cookie === 'string' ? next.cookie.trim() : ''
  if (token === '' && cookie === '') {
    clearStored()
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = JSON.stringify({ token, cookie, savedAt: Date.now() }, null, 2)
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* 非 POSIX 文件系统不管权限 */ }
}

/** 删掉插件存的那份凭据。 */
export function clearStored() {
  try { fs.rmSync(statePath(), { force: true }) } catch { /* 已经没了 */ }
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
 * @returns {{kind: 'token'|'cookie', value: string, source: 'stored'|'cli'}|null}
 */
export function resolveSecret() {
  const stored = readStored()
  if (stored.cookie !== '') return { kind: 'cookie', value: stored.cookie, source: 'stored' }
  if (stored.token !== '') return { kind: 'token', value: stored.token, source: 'stored' }
  const cli = readCliAccessToken()
  if (cli !== '') return { kind: 'token', value: cli, source: 'cli' }
  return null
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
    for (const key of ['id', 'projectId', 'project_id']) {
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
    if (response.status === 401 || response.status === 403 || /NEED_LOGIN|LOGIN_INVALID/.test(trimmed)) {
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
   * 验一次「这份凭据到底还能不能用」。
   *
   * 模型目录是公开的（不带头也回 200），所以拿它当登录态探针会假绿：token 早过期了
   * 也一样列得出 16 个模型。项目列表必须带凭据，401 就是真没了，所以用它。
   *
   * @param options - `{signal}`。
   * @returns true；凭据不可用时抛 NeedLoginError。
   */
  async probeAuth(options = {}) {
    await this.json(MEEO_WEB_APIS.projectList, { signal: options.signal, timeoutMs: 15_000 })
    return true
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
    const created = await this.json(MEEO_WEB_APIS.projectEnsure, {
      method: 'POST',
      body: { title: 'DSH' },
      signal: options.signal,
    })
    const id = projectIdOf(created)
    if (id === '') throw new Error('秒悟：拿不到 projectId（/api/v1/project/ensure 没回 id），这条通道暂时发不出消息')
    this.#projectId = id
    return id
  }

  /**
   * 发起一轮并拿到事件流。
   *
   * 顺序是有讲究的：先把 `query` 的流挂上，再 POST `start`。反过来的话，`start`
   * 一开始吐的事件会在我们连上之前就过去，用户看到的第一句永远是半句话。
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
      if (response.status === 401 || response.status === 403 || /NEED_LOGIN|LOGIN_INVALID/.test(text)) {
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
