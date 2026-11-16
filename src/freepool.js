/**
 * The free pool: one virtual row that dials every free lane this plugin has,
 * best first, and puts a lane that just failed on the bench for a while.
 *
 * Why this exists next to combos: a combo is a chain the user laid out by hand,
 * in an order they maintain themselves. That order is right for "I trust these
 * two", and wrong for "use whatever free quota still works" — the model that was
 * fast last week is the one whose daily quota ran out an hour ago, and nothing in
 * a static chain notices. The pool re-sorts on every turn from what actually
 * happened, and benches a lane the moment it answers with a rate limit instead of
 * making every later turn pay that failure first.
 *
 * Two rules keep it honest:
 *
 *  - Only lanes whose cost is zero by construction are candidates. The aggregate
 *    lane is the user's own provider keys and the sealed lane is a credential
 *    this plugin did not issue; either could bill per token, so neither is ever
 *    picked automatically. A pool that can quietly spend money is not a free pool.
 *  - The order is recomputed per turn, and a benched lane sinks rather than
 *    disappearing. A pool that drops a candidate teaches nothing and cannot
 *    explain itself in the panel; one that sinks it can say "cooling down until
 *    14:32" and come back on its own.
 *
 * The bench is in memory on purpose: it is a property of this process's
 * experience, not of the account. Restart the app and the first turn re-learns,
 * which costs one failed candidate — cheaper than a disk file that outlives the
 * rate limit it recorded.
 *
 * @module src/freepool.js
 */

import { AGGREGATE_CHANNEL } from './aggregate.js'
import { COMBO_CHANNEL } from './combos.js'

export const POOL_CHANNEL = 'freepool'
export const POOL_ID = 'free:auto'
export const POOL_NAME = '免费池 · 自动'

/** Lanes that are never dialed automatically. See the header. */
const NEVER = new Set([COMBO_CHANNEL, POOL_CHANNEL, AGGREGATE_CHANNEL, 'eac'])

/** How long a failure keeps a lane off the front, by what the router called it.
 *
 *  The router's own `cooldownMs` is a *retry* backoff — 30s for a 5xx, 2min for an
 *  auth failure. The pool needs a *demotion*, which is a different quantity: a key
 *  that is wrong is still wrong in three minutes, and a quota that ran out does
 *  not refill in ten. So this table is the floor, and the verdict's own number is
 *  only honoured when it is longer than the floor.
 *
 *  A zero means the lane did nothing wrong: `aborted` is the user pressing stop,
 *  `invalid_request` and `context_window` are our own body. Benching those would
 *  push a perfectly good lane behind a worse one for a whole turn.
 */
const KIND_BENCH_MS = {
  rate_limit: 10 * 60_000,
  billing: 10 * 60_000,
  overloaded: 5 * 60_000,
  unavailable: 5 * 60_000,
  upstream: 2 * 60_000,
  timeout: 2 * 60_000,
  auth: 30 * 60_000,
  permission: 30 * 60_000,
  aborted: 0,
  invalid_request: 0,
  context_window: 0,
}

/** Last resort when the verdict carries no recognisable `kind`. Milliseconds. */
const BENCH = [
  { match: /429|rate.?limit|quota|exhaust|11128|402|insufficient|billing/i, ms: 10 * 60_000 },
  { match: /401|403|unauthor|forbidden|invalid.?key|credential|\bauth\b|permission/i, ms: 30 * 60_000 },
  { match: /timeout|ETIMEDOUT|abort/i, ms: 2 * 60_000 },
]

const DEFAULT_BENCH_MS = 60_000

/** id -> { until, code, reason, at }. Pruned on read, capped on write. */
const bench = new Map()
const MAX_BENCH = 500

export function isPoolEntry(entry) {
  return entry?.channel === POOL_CHANNEL
}

/** How long this failure should bench its lane. Exported for the tests. */
export function benchMsFor(verdict) {
  if (verdict !== null && typeof verdict === 'object') {
    const kind = String(verdict.kind ?? '')
    const floor = Object.hasOwn(KIND_BENCH_MS, kind) ? KIND_BENCH_MS[kind] : null
    const own = Number(verdict.cooldownMs)
    const ownMs = Number.isFinite(own) && own > 0 ? own : 0
    // A zero floor wins over the router's retry backoff: 30s of *retry* is not
    // a reason to demote a lane for the next turn when the failure was not its
    // fault in the first place.
    if (floor !== null) return floor === 0 ? 0 : Math.max(floor, ownMs)
    const text = [kind, verdict.scope, verdict.rule, verdict.code, verdict.message, verdict.status]
      .filter(value => value !== undefined && value !== null && value !== '')
      .join(' ')
    return classifyBenchText(text, ownMs)
  }
  // A caller may hand over a plain string (a bare upstream message). Read it the
  // same way rather than silently benching everything for the default minute.
  return classifyBenchText(String(verdict ?? ''), 0)
}

function classifyBenchText(text, ownMs) {
  for (const row of BENCH) if (row.match.test(text)) return Math.max(row.ms, ownMs)
  return Math.max(DEFAULT_BENCH_MS, ownMs)
}

/**
 * Bench one candidate after a failure the caller already decided to fail over.
 *
 * Only called for pre-output failures — a lane that produced an answer and then
 * broke did its job for this turn, and benching it would punish the next turn
 * for something that may have been a one-off mid-stream disconnect.
 */
export function notePoolFailure(id, verdict, now = Date.now()) {
  if (typeof id !== 'string' || id === '') return null
  if (bench.size >= MAX_BENCH) {
    const oldest = [...bench.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50)
    for (const [key] of oldest) bench.delete(key)
  }
  const ms = benchMsFor(verdict)
  // Zero means "do not bench": the failure was the request, or the user stopped
  // the turn. Recording it would put a good lane behind a worse one for nothing.
  if (!(ms > 0)) return null
  const code = String(verdict?.code ?? verdict?.status ?? verdict?.kind ?? '').slice(0, 40)
  const reason = String(verdict?.message ?? '').trim()
    || [...new Set([verdict?.kind, verdict?.rule].filter(value => value !== undefined && value !== null && value !== ''))].join(' · ')
    || 'failed'
  const row = {
    until: now + ms,
    code,
    reason: reason.slice(0, 200),
    at: now,
  }
  bench.set(id, row)
  return row
}

/** Current bench state for one id, or null when it is free to dial. */
export function benchedUntil(id, now = Date.now()) {
  const row = bench.get(id)
  if (row === undefined) return null
  if (row.until <= now) {
    bench.delete(id)
    return null
  }
  return row
}

/** Test hook and the panel's 「全部解除」 button. */
export function clearBench() {
  bench.clear()
}

function statsRow(stats, id) {
  const lifetime = stats?.models?.[id]
  if (lifetime === undefined || lifetime === null) return null
  return lifetime
}

/**
 * Score one candidate. Higher is better; the absolute value means nothing.
 *
 * Success rate dominates because a lane that fails is worse than a slow lane:
 * a failure costs the whole held buffer before it is noticed, while slowness
 * only costs the wait. Freshness of evidence is not weighted — the store already
 * prunes to 120 days, and a lane that has not been called recently keeps its
 * history instead of being reset to neutral, which is what a user who switches
 * models seasonally would notice as "it forgot".
 */
function scoreOf(entry, stats) {
  const row = statsRow(stats, entry.id)
  if (row === null) return 0.5
  const calls = Number(row.calls) || 0
  const failed = Number(row.failed) || 0
  const successRate = calls > 0 ? Math.max(0, Math.min(1, 1 - failed / calls)) : 0.5
  const samples = Number(row.ttftSamples) || 0
  const ttft = samples > 0 ? (Number(row.ttftMs) || 0) / samples : null
  const speed = ttft === null ? 0.5 : Math.max(0, Math.min(1, 1 - ttft / 8000))
  return successRate * 2 + speed
}

/**
 * Every candidate the pool may dial, best first.
 *
 * @param {Array<object>} catalog
 * @param {{ stats?: object, exclude?: string[], limit?: number, now?: number }} [options]
 * @returns {Array<{ entry: object, score: number, benched: object | null }>}
 */
export function poolCandidates(catalog, options = {}) {
  const now = options.now ?? Date.now()
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 32) : 8
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude.map(String) : [])
  const rows = []
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    if (isPoolEntry(entry)) continue
    if (NEVER.has(entry.channel)) continue
    if (exclude.has(entry.id)) continue
    const benched = benchedUntil(entry.id, now)
    rows.push({ entry, score: scoreOf(entry, options.stats), benched })
  }
  // A benched lane keeps its place in the panel but goes behind every free one;
  // among benched rows the one that comes back soonest goes first, so the pool
  // recovers in the order the benches expire.
  rows.sort((a, b) => {
    if ((a.benched === null) !== (b.benched === null)) return a.benched === null ? -1 : 1
    if (a.benched !== null && b.benched !== null) return a.benched.until - b.benched.until
    if (b.score !== a.score) return b.score - a.score
    return a.entry.id.localeCompare(b.entry.id)
  })
  return rows.slice(0, limit)
}

/**
 * The virtual catalog row. Capabilities are the conservative intersection of the
 * lanes it can reach, because a picker that promises vision and then hands the
 * turn to a text-only lane is worse than one that stays quiet about it.
 *
 * @param {{ candidates?: Array<{ entry: object }>, name?: string }} [options]
 */
export function buildPoolEntry(options = {}) {
  const entries = (Array.isArray(options.candidates) ? options.candidates : []).map(row => row.entry)
  const windows = entries.map(entry => Number(entry.contextWindow)).filter(value => Number.isFinite(value) && value > 0)
  const outputs = entries.map(entry => Number(entry.maxOutput)).filter(value => Number.isFinite(value) && value > 0)
  return {
    id: POOL_ID,
    name: String(options.name ?? '').trim() || POOL_NAME,
    channel: POOL_CHANNEL,
    pool: true,
    // Intersection, like a combo: every candidate has to support it.
    vision: entries.length > 0 && entries.every(entry => entry.vision === true),
    reasoning: entries.some(entry => entry.reasoning === true),
    contextWindow: windows.length > 0 ? Math.min(...windows) : 32_000,
    maxOutput: outputs.length > 0 ? Math.min(...outputs) : 8_192,
    canDisableThinking: entries.every(entry => entry.canDisableThinking !== false),
    regionSensitive: false,
    wire: 'chat',
    lanes: [...new Set(entries.map(entry => entry.channel ?? 'free'))],
  }
}

/**
 * What the panel shows. Deliberately includes the benched rows: 「为什么这次没用
 * 那个快的」 has to be answerable without reading a log file.
 */
export function poolStatus(catalog, options = {}) {
  const now = options.now ?? Date.now()
  const candidates = poolCandidates(catalog, { ...options, limit: 32, now })
  return {
    id: POOL_ID,
    enabled: options.enabled !== false,
    candidates: candidates.map((row, index) => ({
      id: row.entry.id,
      name: row.entry.name ?? row.entry.id,
      lane: row.entry.channel ?? 'free',
      score: Math.round(row.score * 100) / 100,
      benchedUntil: row.benched === null ? 0 : row.benched.until,
      benchedReason: row.benched === null ? '' : row.benched.reason,
      benchedCode: row.benched === null ? '' : row.benched.code,
      rank: row.benched === null ? index + 1 : 0,
    })),
    free: candidates.filter(row => row.benched === null).length,
  }
}
