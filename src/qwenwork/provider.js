/**
 * 千问办公（QwenWork）通道：凭据发现、目录、结构适配器。
 *
 * 凭据与签名那一整套是从 `dsh-qwenwork-connect`（MIT，© AaIchhe）vendored
 * 进来的 —— 见同目录 `LICENSE`。**没有** vendor 的是它的适配器：那一份继承
 * 宿主的 pi-ai 基类（`@earendil-works/pi-ai` + `@deepseek-ai/dsh-llm-pi-ai`），
 * 而本插件注册的是结构适配器（不绑任何版本固定基类），跟 `src/mimo/provider.js`
 * 一个思路。
 *
 * 接线（为什么中间要起一个本地服务）：
 *   - 上游 `/api/v2/service/pro/sse/*` 要 COSY 签名，签名会话按凭据现算，
 *     并且 token 会轮换 —— 这套逻辑上游写在 `chat-shim.js` 里（1226 行，
 *     含重试、首字超时、图片、工具透传）；
 *   - 所以这里只做「把它当成一个 OpenAI 兼容上游」：`startChatShim()` 起在
 *     `127.0.0.1:0`，共享密钥当 Bearer，我们的流式读取器直接吃它的 chunk。
 *
 * 跟豆包那条一样是可选通道：挂不上就只让它自己缺席。
 *
 * @module src/qwenwork/provider.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { startChatShim } from './chat-shim.js'
import { createCatalogStore } from './catalog.js'
import { getAccountContext, getValidCredential, getValidToken } from './credentials-seam.js'
import { clearLocalCredential, describeHold, getLocalCredential } from './local-credentials.js'
import { startDeviceLogin } from './login-device-flow.js'
import { FALLBACK_QWENWORK_MODELS, MAX_OUTPUT_TOKENS } from './models.js'
import { createChannel } from '../channel.js'
import { toChatMessages, toToolDefs } from '../messages.js'
import { resolveDshHome } from '../store.js'
import { readStream } from '../stream.js'

export const QWENWORK_PROVIDER = 'qwenwork'
export const QWENWORK_DISPLAY_NAME = '千问办公'

/** 降智测试的超时：慢模型画两个字要等很久，150 秒是能忍的上限。 */
const DEGRADE_TIMEOUT_MS = 150_000
/** 账号测试只问一个词，给它 60 秒已经足够宽松。 */
const PROBE_TIMEOUT_MS = 60_000

/** 降智测试的 system：把「不许调工具」摆在最前面，否则它会先吐一段调用。 */
export const DEGRADE_SYSTEM = '你是一个只输出纯文本的助手。你没有、也不允许调用任何工具。'

/**
 * 降智测试的 prompt：让模型用 ASCII 画「测试」两个字。
 *
 * 选这个任务的道理跟豆包的 9.9/9.11 一样：正常模型能做出来，而缓存命中、
 * 被换成小模型、或者只会套模板的那种「降智」答不出来 —— 图形是没法背的。
 */
export const DEGRADE_PROMPT = [
  '不调用任何工具，只用纯文本把下面两个字画出来：测试',
  '',
  '要求：',
  '- 用 ASCII 字符（# | - 空格）拼成这两个汉字，左右并排；',
  '- 每个字至少 5 行高；',
  '- 不用 Unicode 制表符、不用 emoji、不用 markdown 表格；',
  '- 只输出图形本身，前后不要加任何解释。',
].join('\n')

/** 插件自己的开关状态（关掉的模型不进选择器），不写进凭据文件。 */
function statePath() {
  return path.join(resolveDshHome(), 'get-it-for-free', 'qwenwork.json')
}

/** 懒读：每次要用都读一遍，别在进程里养第二份真源。 */
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    return {
      disabledModels: Array.isArray(parsed?.disabledModels)
        ? parsed.disabledModels.filter(id => typeof id === 'string' && id !== '')
        : [],
    }
  } catch {
    return { disabledModels: [] }
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

/** 目录里一条记录取 id：上游几个版本的字段名不一样，按顺序退。 */
function idOf(entry) {
  return String(entry?.key ?? entry?.id ?? entry?.model ?? entry?.modelKey ?? '').trim()
}

/** 目录里取显示名。 */
function nameOf(entry, id) {
  const raw = entry?.displayName ?? entry?.name ?? entry?.label
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text === '' ? id : text
}

/**
 * 建立千问办公通道。
 *
 * 全程不主动联网：shim 是懒启动的（第一次真要发请求才监听），目录先用内置
 * 快照，所以没装 QwenWork 桌面端的机器也能把 provider 注册上、不拖累插件。
 *
 * @param options - 依赖。
 * @param options.logger - 日志（默认 console）。
 * @param options.onTopology - 目录/登录态变化时回调（用来重播选择器）。
 * @returns 运行时：`{ adapter, status, refresh, login, dispose }`。
 */
export function createQwenWork({ logger = console, onTopology = () => {} } = {}) {
  const catalog = createCatalogStore(FALLBACK_QWENWORK_MODELS)
  let shim = null
  let starting = null
  let disposed = false
  let lastError = ''

  /**
   * 拿一份凭据：先看本地 device flow 文件（跨平台，谁都能拿到），没有再退回
   * 上游那条 Windows 桌面端路径（在 Windows 上登录过桌面端的人零操作可用）。
   */
  async function resolveCredential() {
    const local = await getLocalCredential()
    if (local !== undefined) return local
    try {
      const fromApp = await getValidCredential()
      if (fromApp !== undefined && fromApp !== null) return fromApp
    } catch (error) {
      const message = error?.message ?? String(error)
      // 这两个词只说明「这台机器上没有 Windows 桌面端凭据」，不是故障。
      lastError = /APPDATA|DPAPI/.test(message) ? '还没登录千问办公' : message
    }
    return undefined
  }

  /** 正在进行的 device flow 登录（同一次只跑一个）。 */
  let loginRun = null

  /**
   * 起一次 device flow 登录：返回要给用户打开的地址，后台轮询到凭据落盘。
   *
   * 不 await 到登录完成 —— 卡片拿到 URL 就能显示，用户在浏览器里授权完，
   * 下一次 `status()` 自然就 signedIn 了。
   */
  function login() {
    if (loginRun !== null) return { url: loginRun.url, pending: true }
    const state = { url: '', pending: true, error: '' }
    loginRun = state
    void startDeviceLogin({
      onUrl: url => {
        state.url = url
        logger.info?.('get-it-for-free: 千问办公登录地址已生成')
      },
    })
      .then(result => {
        state.url = state.url === '' ? result.url : state.url
        state.pending = false
        lastError = ''
        onTopology()
      })
      .catch(error => {
        state.pending = false
        state.error = error?.message ?? String(error)
        lastError = state.error
        logger.warn?.(`get-it-for-free: 千问办公登录失败：${state.error}`)
      })
      .finally(() => {
        if (loginRun === state) loginRun = null
      })
    return { url: state.url, pending: true }
  }

  /** 懒启动本地 shim：失败就是失败，下次再试。 */
  async function ensureShim() {
    if (disposed) return null
    if (shim !== null) return shim
    if (starting !== null) return starting
    starting = (async () => {
      try {
        const started = await startChatShim({
          // 走接缝而不是直读磁盘：接缝内部处理 token 过期刷新与轮换回写，
          // 否则会和宿主里 t1 那一侧形成两套凭据代际。
          getCredential: () => resolveCredential(),
          logger,
        })
        shim = started
        lastError = ''
        logger.info?.(`get-it-for-free: 千问办公 shim 监听 127.0.0.1:${started.port}`)
        return started
      } catch (error) {
        lastError = error?.message ?? String(error)
        logger.warn?.(`get-it-for-free: 千问办公 shim 启动失败：${lastError}`)
        return null
      } finally {
        starting = null
      }
    })()
    return starting
  }

  /**
   * 拉一次目录。失败不算错：内置快照继续用。
   *
   * @param force - 忽略 TTL 强制拉。
   */
  async function refresh(force = false) {
    if (disposed || catalog.shouldRefresh(force) !== true) return catalog.models()
    try {
      const credential = await resolveCredential()
      if (credential === undefined || credential === null) return catalog.models()
      const next = await catalog.refresh({ credential })
      if (Array.isArray(next) && next.length > 0) onTopology()
    } catch (error) {
      logger.warn?.(`get-it-for-free: 千问办公模型目录刷新失败：${error?.message ?? error}`)
    }
    return catalog.models()
  }

  /** 关掉的模型集合：每次现读，用户在另一处改完立刻生效。 */
  function disabledSet() {
    return new Set(readState().disabledModels)
  }

  /** 卡片要的只读状态。 */
  async function status() {
    let signedIn = false
    let account = null
    try {
      const credential = await resolveCredential()
      signedIn = credential !== undefined && credential !== null
      if (signedIn) account = describeHold(credential) ?? null
    } catch (error) {
      lastError = error?.message ?? String(error)
    }
    const models = catalog.models()
    const disabled = disabledSet()
    return {
      provider: QWENWORK_PROVIDER,
      displayName: QWENWORK_DISPLAY_NAME,
      signedIn,
      account,
      models: models.length,
      modelNames: models.map(entry => nameOf(entry, idOf(entry))).filter(name => name !== ''),
      // ChannelCard 读这一份：modelNames 保留给旧调用（它没有开关状态）。
      modelList: models
        .map(entry => {
          const id = idOf(entry)
          if (id === '') return null
          return { id, name: nameOf(entry, id), disabled: disabled.has(id), dead: false }
        })
        .filter(row => row !== null),
      shimPort: shim?.port ?? null,
      login: loginRun === null ? null : { url: loginRun.url, pending: loginRun.pending },
      error: lastError === '' ? undefined : lastError,
    }
  }

  /**
   * 思考强度的落点：输出上限。
   *
   * 上游（gateway.qwenwork.cn）对 `reasoning_effort` / `enable_thinking` /
   * `is_reasoning` 一律无视（2026-11-08 实测，见 models.js 的注释）。这条线路
   * 唯一真生效的控制量是 `parameters.max_tokens`：思考量与它同向变化
   * （src/effort.js 2026-09-24 的对照实验：64 token 上限把 reasoning 从
   * 约 397 压到约 63）。所以档位映射成上限，而不是往请求里塞假字段。
   *
   * 未选档位时保持历史行为（整窗给答案），不让菜单反过来削减默认额度。
   */
  const EFFORT_IDS = ['low', 'medium', 'high']
  const EFFORT_CEILING = { low: 4096, medium: 8192, high: MAX_OUTPUT_TOKENS }

  function outputCeiling(effort, requested) {
    const key = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
    const rung = EFFORT_CEILING[key] ?? MAX_OUTPUT_TOKENS
    const asked = Number(requested)
    const bounded = Number.isFinite(asked) && asked > 0 ? Math.min(rung, asked) : rung
    return Math.max(1024, Math.trunc(bounded))
  }

  /**
   * 把宿主的一轮请求翻成 shim 的 OpenAI 请求体。
   *
   * 工具必须一并透传：不透传模型收不到 schema，会自己编一段自由文本冒充调用。
   */
  function buildBody(options, modelId) {
    const body = {
      model: modelId,
      messages: toChatMessages(options?.messages, undefined, []),
      stream: true,
      max_tokens: outputCeiling(options?.reasoningEffort, options?.maxTokens),
    }
    const tools = toToolDefs(options?.tools, 'chat')
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    return body
  }

  /** 一次真实的流式回合。 */
  async function* stream(options, modelId) {
    const running = await ensureShim()
    if (running === null) {
      throw new Error(
        `千问办公还没接上：先在本机 QwenWork 桌面端登录一次（${lastError === '' ? '未找到凭据' : lastError}）`,
      )
    }
    const channel = createChannel()
    const controller = new AbortController()
    const signal = options?.signal
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    void (async () => {
      let response
      try {
        response = await fetch(running.baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${running.sharedSecret}`,
            accept: 'text/event-stream',
          },
          body: JSON.stringify(buildBody(options, modelId)),
          signal: controller.signal,
        })
      } catch (error) {
        channel.push(new Error(`千问办公：本地 shim 请求失败（${error?.message ?? error}）`))
        return
      }
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '')
        channel.push(new Error(`千问办公：上游返回 ${response.status} ${text.slice(0, 200)}`))
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done === true) break
          buffer += decoder.decode(value, { stream: true })
          let cut = buffer.indexOf('\n\n')
          while (cut !== -1) {
            const frame = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '') continue
              if (payload === '[DONE]') {
                channel.push(undefined)
                return
              }
              channel.push(payload)
            }
            cut = buffer.indexOf('\n\n')
          }
        }
        channel.push(undefined)
      } catch (error) {
        channel.push(error instanceof Error ? error : new Error(String(error)))
      } finally {
        try {
          reader.cancel()
        } catch {
          /* 已经关了 */
        }
      }
    })()

    yield* readStream(channel.read(), 'chat', new Map(), () => Date.now(), {})
  }

  async function resolveModel(provider, model) {
    const id = String(model ?? '')
    // 关掉的模型不进目录：这里同样按「没这个条目」处理，名字退回裸 id。
    // 不直接抛错 —— 已经选中它的会话还在一轮里，替换它的应该是选择器
    // 里的消失，而不是回合中途的 TypeError。
    const disabled = disabledSet()
    const entry = disabled.has(id) ? undefined : catalog.models().find(row => idOf(row) === id)
    const name = entry === undefined ? id : nameOf(entry, id)
    return {
      provider,
      id,
      name,
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: MAX_OUTPUT_TOKENS,
      // 思考强度菜单：档位只在 max_tokens 上落地（见 outputCeiling）。
      reasoning: { efforts: EFFORT_IDS, defaultEffort: 'medium' },
    }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: QWENWORK_DISPLAY_NAME }
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
      const models = catalog.models()
      const disabled = disabledSet()
      return models
        .map(entry => {
          const id = idOf(entry)
          if (id === '' || disabled.has(id)) return null
          return {
            provider,
            id,
            name: nameOf(entry, id),
            description: '千问办公 · 桌面端额度',
            inputModalities: ['text'],
            reasoning: { efforts: EFFORT_IDS, defaultEffort: 'medium' },
          }
        })
        .filter(row => row !== null)
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

  // 挂载后补一次目录与 shim：宿主挂载那一问只能吃内置快照。
  /**
   * 卡片「刷新余额」：一次问清额度、用量、套餐。
   *
   * 千问办公的额度只在服务端：本机只有 device token，没有余额副本。所以这条
   * 路径必须真的发一次请求。失败也回一条能读的原因，让卡片自己说明白，而不是
   * 空着——空着的时候用户只能猜是没登录还是接口挂了。
   */
  async function quota() {
    try {
      const overview = await getAccountContext({})
      return {
        signedIn: true,
        quota: overview?.quota ?? null,
        usage: overview?.usage ?? null,
        plan: overview?.plan ?? null,
        degraded: overview?.degraded === true,
        at: Date.now(),
      }
    } catch (error) {
      return { signedIn: false, error: error?.message ?? String(error), at: Date.now() }
    }
  }

  /**
   * 卡片「续期」：强制用 refresh_token 换一次新 token。
   *
   * 和额度查询分开的理由：服务端的 refresh_token 是单代际轮换的，换一次就把
   * 旧的不认了。这种事只该在用户明确点「续期」时发生，不能藏在定时任务里。
   */
  async function renew() {
    try {
      await getValidToken({ forceRefresh: true })
      return { ok: true, refreshed: true, status: await status() }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), status: await status() }
    }
  }

  /**
   * 模型开关：改状态文件后重播选择器。
   *
   * 千问办公的上游一次请求就带一个 model key，所以「关掉」只等于「不在面板
   * 和选择器里列它」，不动别的东西。返回新的一份黑名单给调用方回显。
   */
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

  /** 一键全关 / 全开：名单取自当前目录，别关掉一个不存在的 id。 */
  function setAllModelsDisabled(disabled = true) {
    const current = new Set(readState().disabledModels)
    if (disabled === true) {
      for (const entry of catalog.models()) {
        const id = idOf(entry)
        if (id !== '') current.add(id)
      }
    } else {
      for (const entry of catalog.models()) current.delete(idOf(entry))
    }
    writeState({ disabledModels: [...current] })
    onTopology()
    return { disabledModels: [...current] }
  }

  /** 账号显示名：只为卡片上那一行「账号 xxx」，失败就当没有。 */
  async function accountName() {
    try {
      const credential = await resolveCredential()
      const hold = describeHold(credential)
      return typeof hold?.name === 'string' ? hold.name : ''
    } catch {
      return ''
    }
  }

  /**
   * 发一次不带工具的请求，收完整段文本。
   *
   * 为什么不复用 `stream()`：那条路要走宿主的 transcript 结构（工具、附件、
   * 块索引），而这里要的就是「一个字一个字吐出来的原文」+ 两个时间点。
   * 走同一份 shim，只是请求体更瘦。
   */
  async function runPlain({ modelId, messages, maxTokens, timeoutMs }) {
    const running = await ensureShim()
    if (running === null) {
      return { ok: false, message: lastError === '' ? '千问办公还没接上：先登录一次' : lastError }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const startedAt = Date.now()
    let firstMs = 0
    let text = ''
    try {
      const response = await fetch(running.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${running.sharedSecret}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ model: modelId, messages, stream: true, max_tokens: maxTokens }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => '')
        return { ok: false, message: `上游返回 ${response.status} ${detail.slice(0, 200)}`.trim() }
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '' || payload === '[DONE]') continue
            let parsed
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            const delta = parsed?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta !== '') {
              if (firstMs === 0) firstMs = Date.now() - startedAt
              text += delta
            }
          }
          cut = buffer.indexOf('\n\n')
        }
      }
      try {
        // 看完就松手：上游可能还挂着连接，别让 readLoop 陪它到最后。
        void reader.cancel().catch(() => {})
      } catch {
        /* 已经关了 */
      }
      return { ok: true, text, firstMs, totalMs: Date.now() - startedAt }
    } catch (error) {
      const aborted = controller.signal.aborted === true
      return {
        ok: false,
        firstMs,
        totalMs: Date.now() - startedAt,
        message: aborted
          ? `等了 ${Math.round(timeoutMs / 1000)} 秒还没回完`
          : `请求失败：${error?.message ?? error}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 卡片上的「降智测试」：真发一次请求，让模型画 ASCII 的「测试」。
   *
   * 图形背不出来，所以能画出像样两个字的就是正常模型；只回一段解释、
   * 或者干脆调工具的，一眼就知道这次被降智了。
   */
  async function degrade(modelId) {
    const id = String(modelId ?? '').trim()
    if (id === '') return { ok: false, modelId: id, message: '没指定要测哪个模型' }
    const nickname = await accountName()
    const result = await runPlain({
      modelId: id,
      messages: [
        { role: 'system', content: DEGRADE_SYSTEM },
        { role: 'user', content: DEGRADE_PROMPT },
      ],
      maxTokens: 2048,
      timeoutMs: DEGRADE_TIMEOUT_MS,
    })
    if (result.ok !== true) {
      return { ok: false, modelId: id, message: String(result.message ?? '失败') }
    }
    const answer = {
      ok: result.text !== '',
      modelId: id,
      nickname,
      text: result.text,
      firstMs: result.firstMs,
      totalMs: result.totalMs,
    }
    // 空回复也是「不 ok」，但要带上已经花掉的时间，别让卡片显示 0 毫秒。
    if (answer.ok !== true) answer.message = '模型一个字都没吐'
    return answer
  }

  /**
   * 卡片上的「账号测试」：比降智测试轻一个量级，只确认这条路还通。
   *
   * 拿不到 shim 或没有凭据都不算异常，回一条能读的原因给卡片。
   */
  async function test() {
    const startedAt = Date.now()
    let credential
    try {
      credential = await resolveCredential()
    } catch (error) {
      credential = undefined
      lastError = error?.message ?? String(error)
    }
    if (credential === undefined || credential === null) {
      return { ok: false, ms: Date.now() - startedAt, message: '还没有登录千问办公' }
    }
    const models = catalog.models().filter(entry => idOf(entry) !== '')
    if (models.length === 0) {
      return { ok: false, ms: Date.now() - startedAt, message: '目录里一个模型都没有' }
    }
    const disabled = disabledSet()
    const pick = models.find(entry => !disabled.has(idOf(entry))) ?? models[0]
    const result = await runPlain({
      modelId: idOf(pick),
      messages: [{ role: 'user', content: '只回两个字：在的' }],
      maxTokens: 64,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const ms = result.ok === true ? result.totalMs : Date.now() - startedAt
    return {
      ok: result.ok === true && result.text !== '',
      ms,
      message: result.ok === true
        ? (result.text === '' ? '回来了但一个字都没有' : String(result.text).slice(0, 80))
        : String(result.message ?? '失败'),
    }
  }

  const prime = setTimeout(() => {
    void refresh(false)
    void ensureShim()
  }, 3_000)
  if (typeof prime.unref === 'function') prime.unref()

  return {
    adapter,
    status,
    refresh,
    login,
    quota,
    renew,
    setModelDisabled,
    setAllModelsDisabled,
    degrade,
    test,

    /** 退出登录：删掉本地凭据，shim 也跟着重来。 */
    logout() {
      clearLocalCredential()
      const closing = shim?.close
      shim = null
      if (typeof closing === 'function') Promise.resolve(closing()).catch(() => {})
      onTopology()
      return status()
    },

    /** 让卡片上的「重新读取」走同一条路径。 */
    async reload() {
      const credential = await resolveCredential()
      if (credential !== undefined) catalog.refresh({ credential }).catch(() => {})
      return status()
    },
    dispose() {
      disposed = true
      clearTimeout(prime)
      const closing = shim?.close
      shim = null
      if (typeof closing === 'function') Promise.resolve(closing()).catch(() => {})
    },
  }
}
