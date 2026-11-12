/**
 * 模型目录同步（对标 dsh-model-sync 的核心那一半）。
 *
 * 原先只有一个「清缓存」动作：每天 12:00 让 channel-pack 把各渠道的远端模型
 * 缓存清掉，真正重新拉取是适配器懒加载时才发生的。结果是——用户看不到任何
 * 「这次同步多了什么、少了什么」，两个渠道同时上新也分不清是谁的。
 *
 * 这里补的就是这段：清缓存 → **主动**把每个渠道的目录拉一遍 → 和上一次快照
 * 比 diff → 落盘 + 记历史。它不另起一套调度，接的是 index.js 里既有的那条
 * `refreshChannelModels`（每日 12:00 / 开机补刷 / 面板手动），所以「自动更新
 * 模型列表」仍然只有一个入口、一份时间戳。
 *
 * 不做的：定价库、TTFT 探测、@fast/@cheap 虚拟别名、能力微探测、Ollama 管理。
 * 那些属于独立插件的完整形态；这份只需要「上游出了新模型，我能立刻看见」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 快照 + 历史落盘位置。与 settings.json 同目录，卸载插件时由用户自行决定去留。 */
const STORE_DIR = () => path.join(os.homedir(), '.dsh', 'get-it-for-free')
const STORE_FILE = () => path.join(STORE_DIR(), 'model-sync.json')

/** 历史保留条数。几十条足够回看一周，再多只会让文件变成日志。 */
const HISTORY_LIMIT = 40

/**
 * 单渠道拉取的超时。
 *
 * 适配器内部本来就有自己的请求超时，但这里面对的是**宿主**的 `llm.listModels`：
 * 某个渠道的适配器卡住时，它会一路挂到上游超时（最长十几秒 × 十几个渠道），
 * 整轮同步就永远回不来，面板上的「同步中」变成永久转圈。给每轮一个硬上限，
 * 卡住的那个渠道记一条 error，其余照常写入快照。
 */
const PROVIDER_TIMEOUT_MS = 25_000

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return {
      version: 1,
      lastRunAt: Number(parsed.lastRunAt ?? 0) || 0,
      lastRunReason: typeof parsed.lastRunReason === 'string' ? parsed.lastRunReason : '',
      providers: parsed.providers !== null && typeof parsed.providers === 'object' ? parsed.providers : {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
    }
  } catch {
    return { version: 1, lastRunAt: 0, lastRunReason: '', providers: {}, history: [] }
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(STORE_DIR(), { recursive: true })
    const temp = `${STORE_FILE()}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8')
    fs.renameSync(temp, STORE_FILE())
  } catch {
    // 落盘失败不该让同步本身失败：本轮 diff 仍然返回给调用方。
  }
}

/**
 * 把宿主回传的一条模型描述压成快照要存的最小集合。
 *
 * 只留 diff 真正需要的字段。`vision` 单独拍平成一个布尔是刻意的：
 * `inputModalities` 数组在不同宿主小版本里写法飘（有时 'image'，有时
 * 'image_url'），一比就整片「变化」，用户看到的是满屏假更新。
 */
export function normalizeModel(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : ''
  if (id === '') return null
  const modalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : []
  const vision = entry.vision === true || entry.supportsImages === true ||
    modalities.some(value => typeof value === 'string' && value.startsWith('image'))
  const contextWindow = Number(entry.contextWindow ?? entry.context_length ?? 0) || 0
  const maxTokens = Number(entry.maxTokens ?? entry.maxOutput ?? entry.max_tokens ?? 0) || 0
  return {
    id,
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
    contextWindow,
    maxTokens,
    vision,
  }
}

/** `llm.listModels` 的返回值形态在宿主各版本间不一致，统一剥到数组。 */
function modelsOf(reply) {
  if (Array.isArray(reply)) return reply
  const value = reply?.value ?? reply?.models ?? reply
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.models)) return value.models
  return []
}

/**
 * 两次快照的差异。
 *
 * `changed` 只在**同一把 id** 的上下文窗口 / 输出上限 / 视觉能力变了时记一条，
 * 名字变化（`deepseek-v4.1-flash` → `DeepSeek V4.1 Flash`）不算，渠道改显示名
 * 比改能力频繁得多，算进去等于每天都在「有更新」。
 */
export function diffModels(before, after) {
  const old = new Map((Array.isArray(before) ? before : []).map(model => [model.id, model]))
  const next = new Map((Array.isArray(after) ? after : []).map(model => [model.id, model]))
  const added = []
  const changed = []
  const removed = []
  for (const [id, model] of next) {
    const previous = old.get(id)
    if (previous === undefined) { added.push(id); continue }
    if (previous.contextWindow !== model.contextWindow || previous.maxTokens !== model.maxTokens || previous.vision !== model.vision) {
      changed.push({
        id,
        contextWindow: [previous.contextWindow, model.contextWindow],
        maxTokens: [previous.maxTokens, model.maxTokens],
        vision: [previous.vision, model.vision],
      })
    }
  }
  for (const id of old.keys()) if (!next.has(id)) removed.push(id)
  return { added, removed, changed }
}

function withTimeout(promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * 同步引擎。
 *
 * @param {object} options
 * @param {() => string[]} options.listProviders 当前挂载的渠道 id（与选择器同一份 membership）
 * @param {(provider: string) => Promise<any>} options.listModels 宿主的模型列表入口
 * @param {(reason: string) => Promise<boolean>} options.refresh 既有的「清缓存 + 广播」动作
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 */
export function createModelSync({ listProviders, listModels, refresh, logger }) {
  let running = null

  function status() {
    const store = readStore()
    const providers = Object.entries(store.providers).map(([id, row]) => ({
      id,
      at: Number(row?.at ?? 0) || 0,
      count: Array.isArray(row?.models) ? row.models.length : 0,
      lastDiff: row?.lastDiff ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id))
    const lastRun = store.history[store.history.length - 1]
    return {
      lastRunAt: store.lastRunAt,
      lastRunReason: store.lastRunReason,
      running: running !== null,
      providers,
      total: providers.reduce((sum, row) => sum + row.count, 0),
      lastDiff: lastRun ?? null,
      history: store.history.slice(-10).reverse(),
    }
  }

  /**
   * 跑一轮。
   *
   * `running` 是单例锁：面板按钮和 12:00 定时器撞在一起时，第二次调用直接
   * 拿到第一次的 promise，而不是把同一批渠道再拉一遍（十几个渠道 × 十几秒）。
   */
  function run(options) {
    const reason = typeof options?.reason === 'string' && options.reason !== '' ? options.reason : '手动同步'
    if (running !== null) return running
    running = (async () => {
      const startedAt = Date.now()
      // 先清缓存，否则 listModels 拿到的是进程内旧目录——「同步」就只是把上一次
      // 的结果再抄一遍，永远 diff 出零变化。
      try { await refresh(reason) } catch (error) {
        logger?.warn?.(`get-it-for-free: 模型同步前清缓存失败（${error?.message ?? error}）`)
      }
      const store = readStore()
      const providers = {}
      const report = {}
      const previous = store.providers ?? {}
      const ids = (() => {
        try { return Array.isArray(listProviders()) ? listProviders() : [] } catch { return [] }
      })()
      for (const provider of ids) {
        try {
          const reply = await withTimeout(listModels(provider), PROVIDER_TIMEOUT_MS, provider)
          const models = modelsOf(reply).map(normalizeModel).filter(model => model !== null)
          // 空目录不覆盖旧快照：渠道恰好这次没取到（令牌过期、上游 5xx）时，
          // 把「0 个模型」写进去会让下一轮把整批模型误报成新增。
          if (models.length === 0 && Array.isArray(previous[provider]?.models) && previous[provider].models.length > 0) {
            providers[provider] = { ...previous[provider], at: startedAt, stale: true }
            report[provider] = { count: previous[provider].models.length, stale: true, added: [], removed: [], changed: [] }
            continue
          }
          const diff = diffModels(previous[provider]?.models, models)
          providers[provider] = { at: startedAt, models, lastDiff: { at: startedAt, ...diff } }
          report[provider] = { count: models.length, ...diff }
        } catch (error) {
          const message = String(error?.message ?? error).slice(0, 200)
          report[provider] = { count: previous[provider]?.models?.length ?? 0, error: message, added: [], removed: [], changed: [] }
          if (previous[provider] !== undefined) providers[provider] = previous[provider]
          logger?.warn?.(`get-it-for-free: 模型同步跳过 ${provider}（${message}）`)
        }
      }
      const totals = Object.values(report).reduce((sum, row) => ({
        added: sum.added + row.added.length,
        removed: sum.removed + row.removed.length,
        changed: sum.changed + row.changed.length,
      }), { added: 0, removed: 0, changed: 0 })
      const entry = { at: startedAt, reason, providers: report, totals, durationMs: Date.now() - startedAt }
      store.providers = providers
      store.lastRunAt = startedAt
      store.lastRunReason = reason
      store.history = [...store.history, entry].slice(-HISTORY_LIMIT)
      writeStore(store)
      logger?.info?.(`get-it-for-free: 模型同步完成（${reason}）：${ids.length} 个渠道，新增 ${totals.added}、下线 ${totals.removed}、变更 ${totals.changed}，用时 ${entry.durationMs}ms`)
      return entry
    })().finally(() => { running = null })
    return running
  }

  return { status, run }
}
