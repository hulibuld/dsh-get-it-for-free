/**
 * Qoder 每日签到（中国版 + 国际版同形接口）
 *
 * 为什么单独写一份，而不是等渠道包自动签到：
 *
 *   渠道包的调度器只在「启动那一轮」和「每天 10:05（UTC+8）」各跑一次，
 *   而 Qoder 的每日活动 10:00 才刷新。机器早上 7 点开机的场景下，启动那轮
 *   看到的是昨天那一轮，`lastDate` 却被记成今天 —— 于是 10:05 的补签成了唯一
 *   机会，机器没开着（或 10:05 之后才开机、又一次被 `lastDate` 挡住）就整天
 *   不会签。面板上留下的话是「N 个未开启」，用户只能自己去点按钮。
 *
 * 这一份按「今天到底签没签」判断，不看轮次：
 *   - 活动列表里已经有 CLAIM_BENEFIT 且 claimStatus=CLAIMED → 今天已签，不再发请求；
 *   - 有 CLAIMABLE → 领；
 *   - 10:00 前既没有可领也没有已签 → 尚未刷新，等下一轮（调度器会再来）。
 *
 * 接口（与渠道包一致，实测于 2026-11-17，qodercn 三个账号）：
 *   GET  {openApiBase}/sash/api/v1/me/campaigns
 *        → { campaigns: [{ campaignId, campaignKey, actionType, claimStatus,
 *                          startAt, endAt, benefit: { kind, amount } }] }
 *   POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim
 *        → { status: 'CLAIMED' | 'BLOCKED' | …, replayed?: boolean }
 *   GET  {openApiBase}/sash/api/v2/me/usage  （只在「活动列表里压根没有每日活动」时用来
 *        区分「没开通」与「今天没有活动」）
 *
 * 头只有三个是必需的：`Authorization: Bearer <security_oauth_token>`、
 * `Cosy-ClientType: 10`（桌面 app 身份，服务端据此进入活动下发分支）、`User-Agent: Qoder`。
 * 少 `Cosy-ClientType` 会拿到空活动列表 —— 那是唯一容易误判成「没活动」的地方。
 */

export const QODER_CHECKIN_SCHEMA = 'get-it-for-free/qoder-checkin/v1'

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000
const REFRESH_HOUR_UTC8 = 10
const TIMEOUT_MS = 15_000
const CONFIRM_DELAY_MS = 1_200

/** 只放有实测依据的站点。国际版（qoder.com）走渠道包那条路，这里不重复。 */
export const QODER_PRODUCTS = {
  qodercn: {
    id: 'qodercn',
    displayName: 'Qoder (中国版)',
    openApiBase: 'https://openapi.qoder.com.cn',
    sashClientType: '10',
  },
}

const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
const USAGE_PATH = '/sash/api/v2/me/usage'

export function utc8Date(now = Date.now()) {
  return new Date(now + UTC8_OFFSET_MS).toISOString().slice(0, 10)
}

/** Qoder 每日活动在 UTC+8 10:00 刷新；10:00 之前看到的还是昨天那一轮。 */
export function campaignsRefreshedToday(now = Date.now()) {
  return new Date(now + UTC8_OFFSET_MS).getUTCHours() >= REFRESH_HOUR_UTC8
}

function bearerOf(credential) {
  const token = credential?.security_oauth_token
  if (typeof token === 'string' && token.length > 0) return token
  const access = credential?.access_token
  return typeof access === 'string' ? access : ''
}

function headersOf(token, product) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    // 桌面 app 身份。缺这个头活动列表是空的，看起来像「今天没有活动」。
    'Cosy-ClientType': product.sashClientType,
    'User-Agent': 'Qoder',
  }
}

async function requestJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    return { ok: false, status: response.status, message: `服务端回了非 JSON（HTTP ${response.status}）：${text.trim().slice(0, 80)}` }
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '凭据已失效，请重新登录该账号' : `HTTP ${response.status}`
    return { ok: false, status: response.status, message: hint, body }
  }
  return { ok: true, status: response.status, body }
}

function amountOf(benefit) {
  const amount = benefit?.amount
  if (typeof amount === 'number' && Number.isFinite(amount)) return amount
  const parsed = Number(amount)
  return Number.isFinite(parsed) ? parsed : 0
}

function readCampaigns(body) {
  const rows = Array.isArray(body?.campaigns) ? body.campaigns : []
  return rows
    .filter(row => row !== null && typeof row === 'object')
    .map(row => ({
      campaignId: String(row.campaignId ?? ''),
      campaignKey: String(row.campaignKey ?? ''),
      actionType: String(row.actionType ?? ''),
      claimStatus: String(row.claimStatus ?? ''),
      startAt: Number(row.startAt) || 0,
      endAt: Number(row.endAt) || 0,
      amount: amountOf(row.benefit),
    }))
    .filter(row => row.campaignId !== '')
}

const isBenefit = row => row.actionType === 'CLAIM_BENEFIT'

/**
 * 今天签没签，只看活动本身，不看轮次：日期窗口还在、状态是 CLAIMED，就是签过了。
 */
function claimedToday(rows, now) {
  return rows.find(row => isBenefit(row) && row.claimStatus === 'CLAIMED' && row.endAt * 1000 > now) ?? null
}

function claimableRows(rows) {
  return rows.filter(row => isBenefit(row) && row.claimStatus === 'CLAIMABLE')
}

function hasBenefitEver(rows) {
  return rows.some(isBenefit)
}

/**
 * 单个账号签到。返回的 `status` 是给调度器用的单词，不是文案：
 *   claimed / already / not-refreshed / not-offered / not-activated / failed
 */
export async function checkinAccount({ credential, product, now = Date.now(), fetchImpl = fetch }) {
  const token = bearerOf(credential)
  if (token === '') return { status: 'failed', message: '凭据里没有令牌' }
  const headers = headersOf(token, product)
  const listed = await requestJson(fetchImpl, `${product.openApiBase}${CAMPAIGNS_PATH}`, { method: 'GET', headers })
  if (!listed.ok) return { status: 'failed', message: listed.message ?? '活动列表查询失败' }
  const rows = readCampaigns(listed.body)

  const done = claimedToday(rows, now)
  if (done !== null) return { status: 'already', amount: done.amount, campaignId: done.campaignId }

  const targets = claimableRows(rows)
  if (targets.length === 0) {
    if (!campaignsRefreshedToday(now)) {
      return { status: 'not-refreshed', message: '今天这一轮还没刷新（UTC+8 10:00 刷新）' }
    }
    if (!hasBenefitEver(rows)) {
      const usage = await requestJson(fetchImpl, `${product.openApiBase}${USAGE_PATH}`, { method: 'GET', headers })
      const addOn = usage.ok && usage.body?.qoderUsage !== null && typeof usage.body?.qoderUsage === 'object'
        ? usage.body.qoderUsage.addOnQuota
        : undefined
      // 从来没有活动 + 没有赠送额度 → 这个号在 Qoder 侧没开通过每日领取。
      if (usage.ok && addOn === undefined) {
        return {
          status: 'not-activated',
          message: '该账号尚未在 Qoder 侧开通每日领取，请先用官方客户端登录一次该账号',
        }
      }
    }
    return { status: 'not-offered', message: '今天没有可领取的每日活动' }
  }

  let total = 0
  let firstError = ''
  for (const target of targets) {
    const claimed = await claimOne({ token, product, campaignId: target.campaignId, fetchImpl })
    if (claimed.status === 'claimed') total += claimed.amount ?? target.amount
    else if (claimed.status === 'already') total += claimed.amount ?? target.amount
    else if (firstError === '') firstError = claimed.message ?? '领取失败'
  }
  if (total > 0) return { status: 'claimed', amount: total }
  if (firstError !== '') return { status: 'failed', message: firstError }
  return { status: 'already', amount: 0 }
}

async function claimOne({ token, product, campaignId, fetchImpl }) {
  const url = `${product.openApiBase}${CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`
  const posted = await requestJson(fetchImpl, url, {
    method: 'POST',
    headers: { ...headersOf(token, product), 'Content-Type': 'application/json' },
    body: '',
  })
  if (!posted.ok) return { status: 'failed', message: posted.message ?? '领取请求失败' }
  if (posted.body?.replayed === true) return { status: 'already', amount: amountOf(posted.body) }
  const status = typeof posted.body?.status === 'string' ? posted.body.status : ''
  if (status === '' || status === 'CLAIMED') return { status: 'claimed', amount: amountOf(posted.body) }

  // BLOCKED 之类不等于「领不到」：2026-11-02 实测服务端已经把这笔记了下来，
  // 只是没在当次响应里下发。隔一下再看一眼活动列表确认。
  await new Promise(resolve => setTimeout(resolve, CONFIRM_DELAY_MS))
  const again = await requestJson(fetchImpl, `${product.openApiBase}${CAMPAIGNS_PATH}`, {
    method: 'GET',
    headers: headersOf(token, product),
  })
  if (again.ok) {
    const row = readCampaigns(again.body).find(item => item.campaignId === campaignId)
    if (row !== undefined && row.claimStatus === 'CLAIMED') return { status: 'claimed', amount: row.amount }
  }
  return { status: 'failed', message: `领取未完成（status=${status}），服务端没当场下发积分` }
}

/**
 * 批量扫。`state` 是上次的落盘结果，形如
 * `{ schema, date, accounts: { [accountId]: { status, amount, at } } }`：
 * 今天已经确认签过的账号直接跳过 —— 一天里每一轮都发请求只会招风控。
 */
export async function sweepQoderCheckin({
  accounts,
  read,
  products = QODER_PRODUCTS,
  now = Date.now(),
  fetchImpl = fetch,
  force = false,
  state = null,
  log = () => {},
}) {
  const today = utc8Date(now)
  const previous = state !== null && typeof state === 'object' && state.date === today && state.accounts !== null && typeof state.accounts === 'object'
    ? state.accounts
    : {}
  const next = {}
  const result = { at: new Date(now).toISOString(), date: today, checked: 0, claimed: 0, totalCredit: 0, already: 0, pending: 0, failed: 0, accounts: [] }

  let rows = []
  try {
    rows = await accounts()
  } catch (error) {
    log(`读取账号池失败：${String(error)}`)
    return { ...result, skipped: true, reason: '账号池读取失败' }
  }

  for (const row of rows) {
    const product = products[row.provider]
    const id = String(row.id ?? '')
    if (product === undefined || id === '') continue
    const cached = previous[id]
    if (!force && cached !== undefined && (cached.status === 'claimed' || cached.status === 'already')) {
      next[id] = cached
      result.already += 1
      result.accounts.push({ id, nickname: row.nickname, provider: row.provider, action: cached.status, amount: cached.amount ?? 0, cached: true })
      continue
    }
    let credential
    try {
      const resolved = await read(row.credentialRef)
      if (resolved === undefined || resolved === null || typeof resolved.value !== 'string') {
        result.failed += 1
        result.accounts.push({ id, provider: row.provider, action: 'missing' })
        continue
      }
      credential = JSON.parse(resolved.value)
    } catch (error) {
      result.failed += 1
      result.accounts.push({ id, provider: row.provider, action: 'unreadable', error: String(error) })
      continue
    }
    result.checked += 1
    const outcome = await checkinAccount({ credential, product, now, fetchImpl })
    const entry = { status: outcome.status, amount: outcome.amount ?? 0, at: now }
    if (outcome.status === 'claimed' || outcome.status === 'already') next[id] = entry
    if (outcome.status === 'claimed') {
      result.claimed += 1
      result.totalCredit += outcome.amount ?? 0
      log(`${row.nickname ?? id} +${outcome.amount ?? 0} 积分`)
    } else if (outcome.status === 'already') {
      result.already += 1
    } else if (outcome.status === 'not-refreshed' || outcome.status === 'not-offered' || outcome.status === 'not-activated') {
      result.pending += 1
    } else {
      result.failed += 1
    }
    result.accounts.push({
      id,
      nickname: row.nickname,
      provider: row.provider,
      action: outcome.status,
      amount: outcome.amount ?? 0,
      ...outcome.message === undefined ? {} : { message: outcome.message },
    })
  }

  result.state = { schema: QODER_CHECKIN_SCHEMA, date: today, accounts: next }
  return result
}
