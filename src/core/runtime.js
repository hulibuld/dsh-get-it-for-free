import fs from 'node:fs'
import path from 'node:path'
import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../adapter.js'
import { isEacEntry } from '../catalog.js'
import { buildAggregateCatalog, isAggregateEntry } from '../aggregate.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from '../combos.js'
import { JsonStore, RETIRED_SETTINGS, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, migrateSettings, migrateStats, pruneDays, recordTurn, recordUsage, isModelHidden } from '../store.js'
import { STATE, detectEgress, probeCatalog } from '../probe.js'
import { CODE, UpstreamError } from '../http.js'
import { runModelTest, modelAvailability } from '../model-test.js'
import { DEFAULT_LEVEL } from '../effort.js'
import { createForwardCompletion, publicModelRows } from './completion.js'

// 这个插件只做「登录账号之后的渠道」。没有凭据就能调的匿名清单与 Kilo 车道
// 已经整条拆除：它们的模型不需要任何账号，与这里其余的每一条车道都不是同类，
// 混在一个选择器里既说不清来源，也没法回答「这个模型能用，凭的是哪个账号」。
// 于是 MODEL_ROWS 恒为空，catalog 只由下面三条有凭据的车道组成：
// sealed（EAC，GitHub 授权后解锁）、aggregate（用户自己的 key）、combo（链）。

/** 路径由产品入口决定；核心不解析 DSH_HOME，也不发现宿主服务。 */
export function createRuntimeStores({ dataDir, logger = console }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const open = (file, initial) => new JsonStore(path.join(dataDir, file), structuredClone(initial), {
    log: message => logger.warn?.(message),
  })
  // Seed the recommended combo only for a genuinely fresh install. Existing
  // settings files that predate combos must not gain a new advertised model
  // merely because a new default was added to SETTINGS_INITIAL; user edits to
  // an existing `combos` field still win through JsonStore's normal merge.
  const settingsInitial = structuredClone(SETTINGS_INITIAL)
  const settingsPath = path.join(dataDir, 'settings.json')
  if (fs.existsSync(settingsPath)) settingsInitial.combos = []
  const settings = new JsonStore(settingsPath, settingsInitial, {
    log: message => logger.warn?.(message),
  })
  // 3.3.0 拆掉免登录车道后，旧文件里的四个键已经没有读者；清一次，之后不会再出现。
  if (RETIRED_SETTINGS.some(key => Object.hasOwn(settings.get(), key))) settings.edit(migrateSettings)
  const stats = open('stats.json', STATS_INITIAL)
  const availability = open('availability.json', { version: 1, at: 0, egress: null, results: {} })
  const catalogStore = open('catalog.json', { version: 1, at: 0, entries: [] })
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)
  return {
    settings, stats, availability, catalogStore,
    dispose() {
      settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
    },
  }
}

/**
 * 两个产品共同使用的模型运行时。宿主仅注入能力，不传入 Cordis ctx。
 * 创建不启动网络任务；入口先绑定本地监听器，再决定何时刷新和探测。
 */
export function createModelRuntime({
  settings, stats, availability, catalogStore,
  logger = console,
  attributionUserAgent = '',
  resolveImage,
  sealedCredential = () => null,
  onSealedUnavailable = () => {},
  onTopology = () => {},
}) {
  let catalog = []
  // 3.3.4: 免登录车道整条拆掉。这里以前会把 catalog.json 里缓存的 sealIds 复活成
  // 「免登录免费模型」，于是删掉车道之后选择器里还留着一排 amd/、opencode/-free。
  // 现在恒为空，且下面 refreshSealedRoster 不再联网、不再写缓存。
  let sealedCatalog = []
  /** The aggregate lane: one row per enabled provider/model the user configured.
   *  Derived from settings, not from a listing, so it is rebuilt on every merge. */
  let aggregateCatalog = []
  /** The virtual rows a combo contributes; rebuilt last, after every real lane. */
  let comboCatalog = []
  let egress = availability.get().egress ?? null
  let gatewayLatency = { ms: 0, at: 0 }
  let disposed = false
  const lifetime = new AbortController()
  let reprobeTimer

  /**
   * Rebuild the merged catalog from its parts, in precedence order.
   *
   * Rebuilt rather than appended to, because every one of these lists can shrink:
   * a provider the user switched off, a chain whose head was removed, a Kilo
   * model that went paid. Appending only ever grew the view, so a removed row
   * stayed dialable until the next full listing round happened to reset it.
   *
   * Combos come last on purpose — a chain's links have to already exist as real
   * rows, which is also what makes `buildComboCatalog` drop a link that is gone
   * instead of keeping a hopeful placeholder.
   */
  const rebuildCatalog = () => {
    const seen = new Set()
    const merged = []
    for (const entry of [...sealedCatalog, ...aggregateCatalog]) {
      if (entry === null || entry === undefined || seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    const combos = normalizeCombos(settings.get().combos)
    comboCatalog = buildComboCatalog(combos, merged)
    pruneRotation(combos)
    for (const entry of comboCatalog) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    catalog = merged
  }
  const mergeCatalogs = () => {
    aggregateCatalog = buildAggregateCatalog(settings.get().aggregate ?? {})
    rebuildCatalog()
  }
  mergeCatalogs()
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
    // 面板与请求共用同一份计数：一次读取，同一个 store，不做副本。
    stats: stats.get(),
  })
  const emitTopology = () => { if (!disposed) onTopology() }
  const adapter = new FreeModelAdapter({
    state,
    resolveImage,
    sealedCredential,
    recordUsage: record => {
      if (disposed) return
      recordUsage(stats, record)
      stats.edit(value => pruneDays(value, 120))
    },
    recordTurn: record => { if (!disposed) recordTurn(stats, record) },
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    onRegionBlocked: () => {
      if (disposed || reprobeTimer !== undefined) return
      reprobeTimer = setTimeout(() => {
        reprobeTimer = undefined
        if (!disposed) void refreshAvailability(true).catch(error => {
          logger.warn?.(`get-it-for-free: region reprobe failed (${error?.message ?? error})`)
        })
      }, 4000)
      reprobeTimer.unref?.()
    },
  })

  // 手动强制刷新不能借用一个因限流而跳过探测的普通刷新。
  let catalogRefresh = null
  let catalogRefreshForced = false
  let catalogRefreshProbed = false
  async function refreshCatalog(opts) {
    const { probe = true, force = false } = opts ?? {}
    if (disposed) return catalog
    while (catalogRefresh !== null) {
      const shared = catalogRefresh
      const sharedForced = catalogRefreshForced
      const sharedProbed = catalogRefreshProbed
      const value = await shared
      if (disposed || ((!force || sharedForced) && (!probe || sharedProbed))) return value
    }
    const run = refreshCatalogOnce({ probe, force })
    catalogRefresh = run
    catalogRefreshForced = force
    catalogRefreshProbed = probe
    try { return await run } finally {
      if (catalogRefresh === run) {
        catalogRefresh = null; catalogRefreshForced = false; catalogRefreshProbed = false
      }
    }
  }

  // 一次刷新只做一件事：问有凭据的那条车道要清单，再合并。没有匿名清单可拉，
  // 所以这里不再有一次「免费模型目录」的网络往返。
  async function refreshCatalogOnce({ probe, force }) {
    await refreshSealedRoster()
    if (disposed) return catalog
    mergeCatalogs()
    if (probe) await refreshAvailability(force)
    emitTopology()
    return catalog
  }

  async function refreshSealedRoster() {
    // 免登录车道已下线：不读凭据、不拉清单、不写缓存，只把残留清干净。
    if (sealedCatalog.length > 0) sealedCatalog = []
    const stale = catalogStore.get().sealIds
    if (Array.isArray(stale) && stale.length > 0) catalogStore.update({ sealIds: [] })
    onSealedUnavailable()
  }

  async function refreshSealedLane() {
    await refreshSealedRoster()
    if (disposed) return
    // The rebuild in `mergeCatalogs` drops a stale roster on its own: a closed
    // lane's rows vanish without a filter pass over the merged view.
    mergeCatalogs()
    emitTopology()
  }

  let probeRound = null
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0
  async function runProbeRound() {
    // The absorbed channels get no per-model probes: their verdicts would be
    // spent against a different gateway than the one that serves them, and a
    // roster the listing named is advertised as-is (its health is the listing
    // round's, refreshed on the same cadence). The aggregate lane is excluded
    // for a sharper reason — a probe there is a *real request to a provider the
    // user pays for*, spent to learn something the settings page already knows
    // (whether a key is configured). A combo is excluded because it has no
    // endpoint of its own: probing one would send the chain's own id to a lane as
    // a model name, spending quota to collect a verdict about nothing.
    //
    // 拆掉匿名车道之后这个集合就是空的：剩下每条车道都有凭据，健康度由它自己的
    // 账号与上游决定，用一个匿名探针去替它下判断没有意义。探针框架留着，是为了
    // 入口那边的「重新探测」按钮还有个确定的行为（一轮空探测，不改任何结论）。
    const probeable = catalog.filter(entry => !isEacEntry(entry) && !isAggregateEntry(entry) && !isComboEntry(entry))
    const results = await probeCatalog(probeable, { attributionUserAgent, signal: lifetime.signal }, (id, result) => {
      if (disposed) return
      availability.edit(value => ({
        ...value,
        results: {
          ...value.results,
          [id]: {
            state: result.state,
            ...result.detail === undefined ? {} : { detail: result.detail },
            ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
            latencyMs: result.latencyMs, startedAt: result.startedAt, at: Date.now(),
          },
        },
      }))
    }, 2)
    if (disposed) return {}
    availability.update({ at: Date.now(), egress })
    availability.flush()
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
      logger.warn?.(`get-it-for-free: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    const allThrottled = verdicts.length > 0 && verdicts.every(row => row.state === STATE.throttled)
    probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
    probeBackoffUntil = allThrottled
      ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
      : 0
    if (allThrottled) {
      logger.warn?.(`get-it-for-free: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected, and the reprobe button forces a round)`)
    }
    emitTopology()
    return results
  }
  async function refreshAvailability(force = false) {
    if (disposed || (!force && probeBackoffUntil > Date.now())) return {}
    if (probeRound !== null) return probeRound
    const round = runProbeRound()
    probeRound = round
    try { return await round } finally { if (probeRound === round) probeRound = null }
  }

  async function watchEgress() {
    if (disposed) return false
    const seen = await detectEgress({ signal: lifetime.signal })
    if (disposed || seen === undefined) return false
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      availability.update({ egress: seen })
      availability.flush()
      logger.info?.(`get-it-for-free: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; re-probing availability`)
      await refreshAvailability(true)
    }
    return true
  }

  const latestTests = new Map()
  async function testModel(id, effort = DEFAULT_LEVEL, { signal } = {}) {
    if (disposed) throw new UpstreamError('Model runtime stopped', CODE.aborted)
    if (settings.get().enabled === false) throw new UpstreamError('Inference is paused', CODE.client)
    const entry = catalog.find(candidate => candidate.id === id)
    if (!entry) throw new UpstreamError('Unknown model "' + id + '"', CODE.client, { status: 404 })
    const token = {}
    latestTests.set(id, token)
    const selectedEffort = effort === undefined || effort === '' ? DEFAULT_LEVEL : effort
    const linkedSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const persist = row => {
      if (disposed || linkedSignal.aborted || latestTests.get(id) !== token) return false
      availability.edit(value => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }))
      availability.flush()
      emitTopology()
      return !availability.writeFailed
    }
    try {
      const measured = await runModelTest(testSignal => adapter.stream({
        provider: ROUTE_MAIN, model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: selectedEffort, sessionId: 'bench:' + entry.id + ':' + selectedEffort,
        signal: testSignal,
      }, entry, state()), { signal: linkedSignal })
      if (linkedSignal.aborted || disposed) throw new UpstreamError('Text test cancelled', CODE.aborted)
      const persisted = persist({ state: STATE.available, source: 'manual', at: Date.now(), ttftMs: measured.ttftMs, latencyMs: measured.totalMs })
      return { model: entry.id, effort: selectedEffort, ok: true, ...measured, persisted }
    } catch (error) {
      // Cancellation is a user action, not a fresh availability verdict. Other failures
      // remain unknown instead of silently banning a paid/region-gated route.
      if (error?.code !== CODE.aborted) persist({ state: STATE.unknown, source: 'manual', at: Date.now(), detail: String(error?.message ?? error).slice(0, 200) })
      throw error
    } finally {
      if (latestTests.get(id) === token) latestTests.delete(id)
    }
  }

  return {
    testModel, state, adapter, refreshCatalog, refreshSealedLane, refreshAvailability, watchEgress,
    complete: createForwardCompletion({
      adapter, signal: lifetime.signal,
      state: () => {
        const snapshot = state()
        // Hiding advertisements must not invalidate requests using a saved id.
        return { ...snapshot, membership: computeMembership(snapshot.catalog, availability.get(), {
          ...snapshot.settings, hiddenModelIds: [], hideEacModels: false,
        }) }
      },
    }),
    publicModelRows: () => publicModelRows(state()),
    // A settings write that changes the aggregate lane or the chains (a key
    // saved, a provider switched off, a combo edited) rebuilds the merged view
    // without a listing round: the aggregate rows come from settings alone.
    syncAggregateCatalog() {
      if (disposed) return catalog
      mergeCatalogs()
      emitTopology()
      return catalog
    },
    get catalog() { return catalog },
    get egress() { return egress },
    get gatewayLatency() { return gatewayLatency },
    setAttributionUserAgent(value) { attributionUserAgent = value },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
      clearTimeout(reprobeTimer)
    },
  }
}

export function computeMembership(catalog, availabilitySnapshot, settings) {
  // 进到这里的每一条车道都已经过了凭据判定（账号池、聚合 key、链），所以不再有
  // 「整组隐藏」的开关：有凭据就投放，没凭据的车道根本不在 catalog 里。
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => modelAvailability(entry.id, availabilitySnapshot, Boolean(entry.channel)).availability
  const probeable = catalog.filter(entry => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every(entry => verdictOf(entry) === STATE.unavailable)
  let usable = catalog.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (refusedAll) usable = catalog
  const main = []
  const region = []
  for (const entry of usable) {
    if (isModelHidden(entry, settings)) continue
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}
