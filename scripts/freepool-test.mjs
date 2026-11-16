// 免费池的单元测试：排序、冷却、能力交集、状态输出。
//
// 直接跑 `node scripts/freepool-test.mjs`，不需要装任何东西、不联网。
// 这些断言护住的是「会扣钱的车道永远进不了池」这条底线——它一旦被改坏，
// 受害的是用户的账单，不是测试数量。
//
// verdict 的形状照 `src/route/classify.js:483` 给：{kind, retryable,
// cooldownMs, cooldownLevel, scope, rule, status?}。**没有 code / message** ——
// 这正是第一版冷却表读错字段、把 429 当成「普通错误」只罚 60 秒的原因。
import {
  benchMsFor,
  buildPoolEntry,
  clearBench,
  isPoolEntry,
  notePoolFailure,
  poolCandidates,
  poolStatus,
  POOL_CHANNEL,
  POOL_ID,
} from '../src/freepool.js'

let pass = 0
const fails = []

const ok = (name, cond, detail) => {
  if (cond) { pass += 1; return }
  fails.push(detail === undefined ? name : `${name} — ${detail}`)
}
const eq = (name, actual, expected) => {
  ok(name, Object.is(actual, expected), `want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const MIN = 60_000
const lane = (id, extra = {}) => ({
  id,
  name: id,
  channel: 'gitf',
  lane: 'gitf',
  wire: 'chat',
  vision: true,
  contextWindow: 64000,
  maxOutput: 8192,
  ...extra,
})
const verdict = (kind, extra = {}) => ({ kind, retryable: true, cooldownMs: 30_000, cooldownLevel: 1, scope: 'transient', rule: kind, ...extra })

// ── benchMsFor：先按 kind ─────────────────────────────────────────────────────
eq('rate_limit → 10 分钟', benchMsFor(verdict('rate_limit')), 10 * MIN)
eq('billing → 10 分钟', benchMsFor(verdict('billing')), 10 * MIN)
eq('auth → 30 分钟', benchMsFor(verdict('auth')), 30 * MIN)
eq('permission → 30 分钟', benchMsFor(verdict('permission')), 30 * MIN)
eq('timeout → 2 分钟', benchMsFor(verdict('timeout')), 2 * MIN)
eq('upstream → 2 分钟', benchMsFor(verdict('upstream')), 2 * MIN)
eq('overloaded → 5 分钟', benchMsFor(verdict('overloaded')), 5 * MIN)
eq('aborted → 0（用户按了停止，不该罚这条车道）', benchMsFor(verdict('aborted')), 0)
eq('invalid_request → 0（请求是我们写坏的）', benchMsFor(verdict('invalid_request')), 0)
eq('context_window → 0', benchMsFor(verdict('context_window')), 0)
eq('路由给的 cooldownMs 更长时用它', benchMsFor(verdict('upstream', { cooldownMs: 20 * MIN })), 20 * MIN)
eq('路由给的 cooldownMs 更短时不缩水', benchMsFor(verdict('rate_limit', { cooldownMs: 1000 })), 10 * MIN)

// 没有 kind 的老形状 / 裸字符串还得能读
eq('无 kind，message 里 429 → 10 分钟', benchMsFor({ message: '429 Too Many Requests' }), 10 * MIN)
eq('无 kind，rule 里 quota → 10 分钟', benchMsFor({ rule: 'quota exhausted for today' }), 10 * MIN)
eq('无 kind，code 11128 → 10 分钟', benchMsFor({ code: '11128' }), 10 * MIN)
eq('无 kind，status 402 → 10 分钟', benchMsFor({ status: 402 }), 10 * MIN)
eq('无 kind，401 → 30 分钟', benchMsFor({ status: 401 }), 30 * MIN)
eq('无 kind，invalid key → 30 分钟', benchMsFor({ message: 'invalid key supplied' }), 30 * MIN)
eq('裸字符串 403 → 30 分钟', benchMsFor('403 forbidden'), 30 * MIN)
eq('裸字符串 ETIMEDOUT → 2 分钟', benchMsFor('connect ETIMEDOUT'), 2 * MIN)
eq('认不出来 → 60 秒', benchMsFor('bad gateway'), MIN)
eq('空值 → 60 秒', benchMsFor(undefined), MIN)

// ── isPoolEntry ───────────────────────────────────────────────────────────────
ok('pool 行识别', isPoolEntry({ id: POOL_ID, channel: POOL_CHANNEL }))
ok('combo 行不算 pool', !isPoolEntry({ id: 'combo:x', channel: 'combo' }))
ok('null 不算 pool', !isPoolEntry(null))

// ── poolCandidates ────────────────────────────────────────────────────────────
clearBench()
const now = 1_800_000_000_000
const catalog = [
  lane('slow-free'),
  lane('fast-free'),
  lane('combo:recommended-free', { channel: 'combo' }),
  lane('free:auto', { channel: POOL_CHANNEL }),
  lane('aggregate:openai', { channel: 'aggregate' }),
  lane('eac:sealed', { channel: 'eac' }),
]
// 统计行的字段名照 src/store.js:378 —— ttftMs 是累计值，ttftSamples 是样本数
const stats = {
  models: {
    'slow-free': { calls: 10, failed: 5, ttftMs: 60_000, ttftSamples: 10 },
    'fast-free': { calls: 10, failed: 0, ttftMs: 3_000, ttftSamples: 10 },
  },
}
const ranked = poolCandidates(catalog, { stats, now })
eq('付费/combo/pool 自身被排除，只剩两条免费车道', ranked.length, 2)
eq('零失败且首字快的那条排第一', ranked[0].entry.id, 'fast-free')
ok('combo / aggregate / eac 一条都没混进来',
  !ranked.some(row => ['combo', 'aggregate', 'eac'].includes(row.entry.channel)),
  JSON.stringify(ranked.map(row => row.entry.channel)))
ok('score 是数字且快的更高', ranked[0].score > ranked[1].score,
  `${ranked[0].score} vs ${ranked[1].score}`)

// 冷却：失败的那条排到最后，并且带剩余时间与原因
const benched = notePoolFailure('fast-free', verdict('rate_limit'), now)
ok('notePoolFailure 返回一条记录', benched !== null && benched.until > now, JSON.stringify(benched))
const afterBench = poolCandidates(catalog, { stats, now: now + 1000 })
eq('冷却中的车道仍列出来（不隐藏）', afterBench.length, 2)
eq('冷却排到未冷却之后', afterBench[0].entry.id, 'slow-free')
ok('冷却带 until', Number(afterBench[1].benched?.until) > now, JSON.stringify(afterBench[1].benched))
ok('冷却带原因', String(afterBench[1].benched?.reason ?? '').includes('rate_limit'), String(afterBench[1].benched?.reason))

// aborted 不该罚任何人
eq('aborted 不产生冷却', notePoolFailure('slow-free', verdict('aborted'), now), null)
eq('aborted 之后那条车道仍在前排', poolCandidates(catalog, { stats, now: now + 1000 })[0].entry.id, 'slow-free')

// 过期就该回来
const expired = poolCandidates(catalog, { stats, now: now + 11 * MIN })
eq('冷却过期后排位恢复', expired[0].entry.id, 'fast-free')
ok('过期后 benched 为 null', expired[0].benched === null, JSON.stringify(expired[0].benched))

// exclude / limit
const excluded = poolCandidates(catalog, { stats, exclude: ['fast-free'], now })
eq('exclude 生效', excluded.length, 1)
eq('exclude 剩下的那条', excluded[0].entry.id, 'slow-free')
eq('limit 生效', poolCandidates(catalog, { stats, limit: 1, now }).length, 1)
eq('limit 非法时回落到 8 条上限', poolCandidates(catalog, { stats, limit: 999, now }).length, 2)

// clearBench
clearBench()
eq('clearBench 之后不再有冷却', poolCandidates(catalog, { stats, now: now + 1000 }).filter(row => row.benched !== null).length, 0)

// ── buildPoolEntry ────────────────────────────────────────────────────────────
const packed = buildPoolEntry({ candidates: poolCandidates(catalog, { stats, now }) })
eq('池行 id', packed.id, POOL_ID)
eq('池行通道', packed.channel, POOL_CHANNEL)
ok('池行带 lanes 列表', Array.isArray(packed.lanes) && packed.lanes.length > 0, JSON.stringify(packed.lanes))
eq('contextWindow 取候选最小值', packed.contextWindow, 64000)
eq('maxOutput 取候选最小值', packed.maxOutput, 8192)
eq('vision 取交集（全真 → 真）', packed.vision, true)
eq('池行 wire 固定 chat', packed.wire, 'chat')

const mixed = buildPoolEntry({
  candidates: [
    { entry: lane('a-free', { vision: true, contextWindow: 128000, maxOutput: 8192 }) },
    { entry: lane('b-free', { vision: false, contextWindow: 32000, maxOutput: 4096 }) },
  ],
})
eq('一条不支持图片 → 池行也不支持', mixed.vision, false)
eq('contextWindow 取较小那条', mixed.contextWindow, 32000)
eq('maxOutput 取较小那条', mixed.maxOutput, 4096)
eq('空候选也有兜底窗口', buildPoolEntry({ candidates: [] }).contextWindow, 32_000)
eq('自定义名字', buildPoolEntry({ candidates: [{ entry: lane('a-free') }], name: '我的池' }).name, '我的池')

// ── poolStatus ────────────────────────────────────────────────────────────────
clearBench()
notePoolFailure('slow-free', verdict('auth'), now)
const status = poolStatus([...catalog, packed], { stats, enabled: true, now: now + 5000, limit: 8 })
eq('status.id', status.id, POOL_ID)
eq('status.enabled 透传', status.enabled, true)
eq('status 里也排除了 pool 行自身', status.candidates.filter(row => row.id === POOL_ID).length, 0)
eq('status 候选数量', status.candidates.length, 2)
ok('status 带 rank', status.candidates.every(row => Number.isInteger(row.rank)), JSON.stringify(status.candidates.map(r => r.rank)))
ok('status 带冷却原因', status.candidates.some(row => typeof row.benchedReason === 'string' && row.benchedReason !== ''),
  JSON.stringify(status.candidates.map(r => r.benchedReason)))
eq('status.free 只数没冷却的', status.free, 1)
const off = poolStatus([...catalog, packed], { stats, enabled: false, now })
eq('enabled:false 时仍给候选（面板要能解释为什么不拨）', off.candidates.length, 2)
eq('enabled:false 透传', off.enabled, false)

clearBench()

console.log(fails.length === 0 ? `ok ${pass} assertions` : `FAIL ${fails.length}/${pass + fails.length}\n` + fails.map(line => `  - ${line}`).join('\n'))
if (fails.length > 0) process.exitCode = 1
