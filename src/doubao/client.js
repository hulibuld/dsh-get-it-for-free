// 豆包（www.doubao.com / 豆包工作桌面端）的上游协议层。
//
// 身份只有一条：浏览器登录后拿到的那串 cookie。客户端把 cookie 存在自己的
// Chromium 库里并加密（macOS 上是 AES，钥匙在 keychain，service 名不是
// "Safe Storage" 那一套），所以这里不解密——cookie 由用户粘进来，或者由
// 面板从浏览器会话里导出。这和 dsh-connect-doubao 后来的选择一致：解密
// 封副本会在服务端轮换 session 后变成「本地看着登录了、上游全拒」。
//
// 所有接口都要求同一套客户端身份参数，缺一个就会被风控挡回 710022004。

const HOST = 'https://www.doubao.com'

// 宿主自带全局 fetch，但不是每个运行环境都有（插件也会被 node 直接 import 来
// 自检）。没有 fetch 时退回 node:https，接口行为一致。
async function httpsRequest(url, { method = 'POST', headers = {}, body = '' } = {}) {
  const target = new URL(url)
  const mod = await import('node:https')
  return new Promise((resolve, reject) => {
    const request = mod.default.request({
      protocol: target.protocol,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method,
      headers: body === '' ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const status = Number(response.statusCode ?? 0)
        resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString('utf8') })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    if (body !== '') request.write(body)
    request.end()
  })
}


// 这是**网页版**的身份参数（aid 497858 / doubao_device_platform=web /
// pc_version 3.45.7），不是桌面客户端的（那套是 aid 582478、SamanthaDoubao UA）。
// cookie 来自浏览器会话，所以请求也必须长成浏览器那样：两套混用会被回 710022004。
export const APP_VERSION = '3.45.7'
export const CLIENT = {
  aid: 497858,
  real_aid: 497858,
  version_code: 20800,
  chromium: '147.0.7727.149',
  runtime_version: '3.45.7',
}

export const ERROR = {
  SESSION_EXPIRED: '710012001',
  RISK_CONTROL: '710022004',
  RUNTIME_UNAVAILABLE: '710010702',
}

// device_id / web_id / tea_uuid 是页面自己生成的一串 19 位数字，只要在同一份
// cookie 上保持不变就行。用 cookie 里的 sessionid 做种子，同一个账号每次都是
// 同一个号，换账号就换号，看起来和真客户端一样。
function digitId(seed, salt) {
  let hash = 0
  const text = `${salt}:${seed}`
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 9000000000000000000
  }
  return String(7000000000000000000 + hash).slice(0, 19)
}

function cookieValue(cookieHeader, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader)
  return match ? match[1] : ''
}

export function buildQuery(cookieHeader = '', extra = {}) {
  const seed = cookieValue(cookieHeader, 'sessionid') || cookieValue(cookieHeader, 'ttwid') || 'anon'
  const fp = cookieValue(cookieHeader, 's_v_web_id') || `verify_${digitId(seed, 'fp').slice(0, 16)}`
  const params = new URLSearchParams({
    aid: String(CLIENT.aid),
    real_aid: String(CLIENT.real_aid),
    device_id: digitId(seed, 'device'),
    web_id: digitId(seed, 'web'),
    tea_uuid: digitId(seed, 'tea'),
    fp,
    version_code: String(CLIENT.version_code),
    pc_version: APP_VERSION,
    doubao_pc_version: APP_VERSION,
    pkg_type: 'release_version',
    device_platform: 'web',
    doubao_device_platform: 'web',
    web_platform: 'browser',
    language: 'zh',
    region: 'CN',
    sys_region: 'CN',
    tz_name: 'Asia/Shanghai',
    samantha_web: '1',
    'use-olympus-account': '1',
    web_tab_id: newId(),
  })
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) params.set(key, String(value))
  }
  return params.toString()
}

function msTokenOf(cookieHeader) {
  const match = /(?:^|;\s*)msToken=([^;]+)/.exec(cookieHeader)
  return match ? match[1] : ''
}

export function buildHeaders(cookieHeader) {
  // 逐条对着网页版真实请求抄的。少一个 Agw-Js-Conv 或 x-flow-trace，上游
  // 会当成脚本，直接回 710022004（rate limited），而不是报鉴权失败。
  return {
    Cookie: cookieHeader,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    Origin: 'https://www.doubao.com',
    Referer: 'https://www.doubao.com/chat/',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'Agw-Js-Conv': 'str',
    'x-flow-trace': `04-${newId().replace(/-/g, '')}${newId().replace(/-/g, '').slice(0, 16)}-${Date.now().toString(16)}-01`,
    'last-event-id': 'undefined',
    'Content-Type': 'application/json',
  }
}

export class DoubaoError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'DoubaoError'
    this.code = code
    this.status = status
  }
}

// 有的运行时（例如不带全局 fetch 的沙箱 Node）没有 fetch，就用 node:https
// 拼一个等价的请求出来。两条路返回同样的 {status, text}，上层不用分叉。
async function rawPost(url, headers, bodyText, { signal, timeoutMs = 20_000 } = {}) {
  if (typeof fetch === 'function') {
    const response = await fetch(url, { method: 'POST', headers, body: bodyText, signal })
    return { status: response.status, text: await response.text() }
  }
  const https = await import('node:https')
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    const timer = setTimeout(() => {
      request.destroy(new DoubaoError('TIMEOUT', `请求超时（${timeoutMs}ms）`))
    }, timeoutMs)
    request.on('close', () => clearTimeout(timer))
    if (signal) signal.addEventListener('abort', () => request.destroy(new DoubaoError('ABORTED', '请求被取消')), { once: true })
    request.end(bodyText)
  })
}

async function post(path, cookieHeader, body, { signal, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const { status, text } = await rawPost(
      `${HOST}${path}?${buildQuery(cookieHeader)}`,
      buildHeaders(cookieHeader),
      JSON.stringify(body ?? {}),
      { signal: controller.signal, timeoutMs },
    )
    if (status === 401) {
      throw new DoubaoError(ERROR.SESSION_EXPIRED, '登录态失效（HTTP 401），请在豆包网页重新登录', 401)
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new DoubaoError('BAD_PAYLOAD', `上游返回的不是 JSON（HTTP ${status}）：${text.slice(0, 120)}`, status)
    }
    const code = payload?.code ?? payload?.status_code
    if (typeof code === 'number' && code !== 0) {
      throw new DoubaoError(String(code), readMessage(payload) || `上游业务码 ${code}`, status)
    }
    if (status < 200 || status >= 300) {
      throw new DoubaoError(`HTTP_${status}`, `HTTP ${status}`, status)
    }
    return payload?.data ?? payload
  } finally {
    clearTimeout(timer)
  }
}

function readMessage(payload) {
  return payload?.msg || payload?.message || payload?.status_msg || ''
}

function parseAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const cleaned = value.replace(/[^\d.-]/g, '')
  const parsed = Number(parsedFloat(cleaned))
  return Number.isFinite(parsed) ? parsed : 0
}

function parsedFloat(text) {
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : 0
}

// 5 小时窗口 / 周额度 / 活动赠送，三类窗口字段一样，只是 window_type 不同。
// start_time 与 end_time 都是 0 表示「开始使用后才计时」，这种情况不编重置时间。
const WINDOW_KINDS = { 1: '5h', 2: 'week', 3: 'grant' }

function readWindows(section, fallbackLabel) {
  const groups = section?.window_limit_groups
  if (!Array.isArray(groups)) return []
  const out = []
  for (const group of groups) {
    const limits = group?.window_limits
    if (!Array.isArray(limits)) continue
    for (const limit of limits) {
      const total = parseAmount(limit?.total_amount)
      const used = parseAmount(limit?.used_amount)
      const percent = Number(limit?.used_percent)
      out.push({
        kind: WINDOW_KINDS[limit?.window_type] ?? 'other',
        label: group?.feature_group_name || fallbackLabel,
        total,
        used,
        left: Math.max(total - used, 0),
        percent: Number.isFinite(percent) ? percent : total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
        startAt: Number(limit?.start_time) || 0,
        endAt: Number(limit?.end_time) || 0,
        exhausted: limit?.usage_exhausted === true || (total > 0 && used >= total),
        lessThanOnePercent: limit?.less_than_one_percent === true,
      })
    }
  }
  return out
}

export async function fetchQuota(cookieHeader, options) {
  const data = await post('/alice/commerce/sale/subscription/quota/summary/', cookieHeader, { product_line: 'membership' }, options)
  const windows = [
    ...readWindows(data?.window_limit_section, '周期额度'),
    ...readWindows(data?.incentive_quota_section, '赠送额度'),
  ]
  const subscription = data?.current_subscription?.display ?? {}
  return {
    planName: subscription.product_name ?? '',
    planShort: subscription.short_name ?? '',
    active: data?.member_info?.hasActiveSubscription === true,
    windows,
    exhausted: windows.length > 0 && windows.every(row => row.exhausted),
    at: Date.now(),
  }
}

const MODEL_KEY_SHAPE = /^[\w.-]{1,64}$/

function readModelItem(item) {
  const key = String(item?.model_item_key ?? item?.key ?? '').trim()
  if (!MODEL_KEY_SHAPE.test(key)) return null
  const name = String(item?.name ?? item?.title ?? key).trim()
  const tags = Array.isArray(item?.tag_list) ? item.tag_list.map(tag => String(tag?.text ?? '')).filter(Boolean) : []
  // 倍率标签有的只写 "0.65x"，有的前面挂促销词 "限时优惠 0.01x"，
  // 所以按「最后一个数字 + x」抠，而不是拿整段去全等匹配。
  const ratioTag = tags.map(text => /(\d+(?:\.\d+)?)\s*[x×]/i.exec(text)).find(Boolean)
  const optionList = item?.reasoning_effort_config?.option_list
  return {
    id: key,
    name,
    isTaskMode: item?.default_mode === '3' || name.startsWith('工作任务'),
    ratio: ratioTag ? `${ratioTag[1]}x` : '',
    tags,
    contextWindow: Number(item?.model_extra_params?.total_window_size) || 0,
    reasoning: Array.isArray(optionList)
      ? optionList.map(option => ({ level: option?.level, name: String(option?.name ?? '') }))
      : [],
  }
}

export async function fetchModels(cookieHeader, { botId = '7338286299411103781', ...options } = {}) {
  const data = await post('/alice/slot/action_bar_v3/brief_list', cookieHeader, { language_code: 'zh', bot_id: botId }, options)
  const entries = Array.isArray(data?.entry_list) ? data.entry_list : []
  const preferred = entries.find(entry => entry?.action_bar_key === 'coco_deep_thinking')
  const source = preferred ?? entries.find(entry => Array.isArray(entry?.active_switch_conf?.menu_conf_v2?.model_list?.item_list))
  const items = source?.active_switch_conf?.menu_conf_v2?.model_list?.item_list
  if (!Array.isArray(items)) return []
  const seen = new Set()
  const models = []
  for (const item of items) {
    const model = readModelItem(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

// launch 只回答「这个账号现在挂在哪个活动组」。免费号常见返回空串，
// 那表示当前没有活动投放——不是 cookie 坏了，别把它当失败。
export async function fetchLaunch(cookieHeader, options) {
  const data = await post('/alice/user/launch', cookieHeader, {}, options)
  const info = data?.ug_campaign_info ?? {}
  return {
    campaign: String(data?.ug_campaign ?? ''),
    campaignGroup: String(info.campaign_group_code ?? ''),
    loggedIn: data?.extra?.is_login === '1' || data?.extra?.is_login === 1,
    assistantBotId: String(data?.assistant_bot_id ?? ''),
    secUserId: String(data?.sec_user_id ?? ''),
  }
}

// 签到状态的位置随活动版本变过三次：
//   daily_checkin.checked_in_today   ← 2026-11 的 daily_signin 任务在这里（实测）
//   campaign_task_data.checked_in_today
//   checked_in_today（顶层）
// 三个都读，都没有就留 undefined——不能当 false，否则面板会把「没有这条状态」
// 显示成「今天没签」，然后每次刷新都去重复发一次签到请求。
export function readCheckinState(task) {
  const daily = task?.daily_checkin ?? {}
  const campaign = task?.campaign_task_data ?? {}
  const checkedInToday = typeof daily.checked_in_today === 'boolean'
    ? daily.checked_in_today
    : typeof campaign.checked_in_today === 'boolean'
      ? campaign.checked_in_today
      : typeof task?.checked_in_today === 'boolean' ? task.checked_in_today : undefined
  return {
    checkedInToday,
    continuousDays: Number(daily.continuous_days) || 0,
    lastCheckinDate: String(daily.last_checkin_date ?? ''),
    totalDays: Number(daily.total_days) || 0,
    checkinReward: daily.reward && typeof daily.reward === 'object' ? daily.reward : null,
  }
}

export async function fetchCampaignDetail(cookieHeader, group, options) {
  const data = await post('/alice/ug/campaign/v3/detail', cookieHeader, { campaign_group_code: group }, options)
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  return {
    group: String(data?.campaign_code ?? group),
    tasks: tasks.map(task => ({
      code: String(task?.campaign_code ?? ''),
      group: String(task?.campaign_group_code ?? group),
      kind: String(task?.task_kind ?? ''),
      type: String(task?.campaign_type ?? ''),
      title: String(task?.title ?? ''),
      status: Number(task?.task_status) || 0,
      reward: Array.isArray(task?.reward_summaries) ? task.reward_summaries : [],
      ...readCheckinState(task),
    })),
    total: parseAmount(data?.progress?.total_amount),
  }
}

// 每日签到任务在活动组里按名字找。找不到就是「今天没有可签的任务」，
// 不是错误——很多账号是任务型活动（做一件事领额度），没有签到卡。
export function findDailyCheckin(tasks) {
  return tasks.find(task => /check_?in|sign_?in|daily_sign/i.test(`${task.code} ${task.kind} ${task.type} ${task.title}`))
    ?? tasks.find(task => /daily/i.test(task.code) && task.status === 1 && task.kind === 'chat_activity')
    ?? null
}

// 请求体按服务端 IDL 来：{scene, biz_params(map), AgwCommonParam}。
// 少给 biz_params 会被网关当成非法 request（400 InvalidRequest, expected map），
// 只给 {scene} 则能过校验但业务侧恒系统错误——见 docs/FIXES.md 的实测记录。
export async function claimCheckin(cookieHeader, group, options = {}) {
  const { bizParams, agwParams, ...rest } = options
  const body = {
    scene: group,
    biz_params: bizParams && typeof bizParams === 'object' ? bizParams : {},
    AgwCommonParam: {
      aid: CLIENT.aid,
      app_name: 'doubao',
      device_platform: 'web',
      pc_version: APP_VERSION,
      language: 'zh',
      region: 'CN',
      samantha_web: 1,
      ...(agwParams && typeof agwParams === 'object' ? agwParams : {}),
    },
  }
  const data = await post('/alice/ug/campaign/landing/checkin', cookieHeader, body, rest)
  return {
    checkedIn: data?.checked_in === true,
    checkedInToday: data?.checked_in_today === true,
    raw: data ?? null,
  }
}

export async function fetchAccountInfo(cookieHeader, options) {
  const data = await post('/passport/account/info/v2/', cookieHeader, {}, options)
  return {
    uid: String(data?.user_id_str ?? data?.user_id ?? ''),
    name: String(data?.screen_name ?? data?.user_name ?? ''),
    avatar: String(data?.avatar_url ?? ''),
  }
}

export function uidFromCookie(cookieHeader) {
  const multi = /(?:^|;\s*)multi_sids=([^;]+)/.exec(cookieHeader)
  if (multi) {
    const decoded = decodeURIComponent(multi[1])
    const uid = decoded.split(':')[0]
    if (/^\d{6,}$/.test(uid)) return uid
  }
  const session = /(?:^|;\s*)sessionid=([^;]+)/.exec(cookieHeader)
  return session ? `s_${session[1].slice(0, 12)}` : ''
}

export function hasSession(cookieHeader) {
  return /(?:^|;\s*)(sessionid|sessionid_ss)=[^;\s]+/.test(cookieHeader)
}

/* ------------------------------------------------------------------ *
 * 聊天
 *
 * POST /chat/completion，回的不是标准 SSE：一个事件是 id: / event: / data:
 * 三行加一个空行。只认 event: 那一行，正文分散在两类帧里——
 *   STREAM_MSG_NOTIFY  带着回答的开头（content_block[].text_block.text）
 *   STREAM_CHUNK / CHUNK_DELTA  带后面每一段增量（{ id, text }）
 * 思考块（block_type 10040）的文本必须丢掉，否则推理过程会混进回答。
 * ------------------------------------------------------------------ */

const CHAT_PATH = '/chat/completion'
export const DEFAULT_BOT_ID = '7338286299411103781'
const CHAT_AGENT_MODE = 2
const TASK_AGENT_MODE = 1
const ANSWER_BLOCK_TYPE = 10000
const THINKING_BLOCK_TYPE = 10040

function newId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

export function buildChatBody(prompt, options = {}) {
  const modelKey = String(options.modelId ?? '0')
  const taskMode = options.taskMode === true
  const agentMode = taskMode ? TASK_AGENT_MODE : CHAT_AGENT_MODE
  const modeId = taskMode ? '3' : '1'
  const level = Number.isFinite(Number(options.reasoningLevel)) ? Number(options.reasoningLevel) : 3
  const localMessageId = newId()
  const plainTaskParam = { runtime_type: 0, agent_task_param: {}, project_id: '', server_do_compare: true }
  const modelExtraParams = taskMode
    ? { input_token_limit: '256k', ...(modelKey === 'seed-lite-7b' ? { reasoning_effort: String(level) } : {}) }
    : {}
  const newConversation = options.conversationId === undefined || options.conversationId === ''
  return {
    messages: [
      {
        local_message_id: localMessageId,
        message_status: 0,
        content_block: [
          {
            block_type: ANSWER_BLOCK_TYPE,
            block_id: newId(),
            parent_id: '',
            meta_info: [],
            extra_info: {},
            append_fields: [],
            content: {
              text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' },
              pc_event_block: '',
            },
          },
        ],
      },
    ],
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      agent_mode: agentMode,
      tts_switch: false,
      need_deep_think: taskMode ? 10001 : 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: newId(),
      start_seq: 0,
      need_create_conversation: options.conversationId === undefined || options.conversationId === '',
      conversation_init_option: { need_ack_conversation: true },
      ...(taskMode && (options.conversationId === undefined || options.conversationId === '') ? { conversation_mode: 2 } : {}),
      conversation_init_ext: { model_item_key: modelKey, reasoning_effort: String(level), mode_id: modeId },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: plainTaskParam,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: { model_item_key: modelKey, model_extra_params: modelExtraParams, reasoning_effort: level },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: taskMode && (options.conversationId === undefined || options.conversationId === '') ? '2' : '',
        mode_id: modeId,
        model_item_key: modelKey,
        agent_mode: String(agentMode),
        reasoning_effort: String(level),
        provider_id: '',
      },
    },
    client_meta: {
      local_conversation_id: `local_${newId()}`,
      conversation_id: options.conversationId ?? '',
      bot_id: DEFAULT_BOT_ID,
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
      ],
    },
    user_context: [],
    ext: {
      agent_mode: String(agentMode),
      use_deep_think: taskMode ? '10001' : '0',
      sub_conv_firstmet_type: '1',
      general_task_param: JSON.stringify(plainTaskParam),
      collection_id: '',
      is_finish: '1',
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0',
    },
  }
}

// 三行一帧：id: / event: / data:，空行收尾。返回已完整的帧和没拼完的尾巴。
export function parseFrames(buffer) {
  const frames = []
  let rest = buffer
  for (;;) {
    const boundary = rest.search(/\r?\n\r?\n/)
    if (boundary < 0) break
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary).replace(/^(\r?\n){2}/, '')
    const frame = { id: '', event: '', data: '' }
    for (const line of block.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const field = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (field === 'id') frame.id = value
      else if (field === 'event') frame.event = value
      else if (field === 'data') frame.data = value
    }
    if (frame.data !== '' || frame.event !== '') frames.push(frame)
  }
  return { frames, rest }
}

// 从上游的 content_block 树里收集正文：跳过思考块（10040），并记住它们的 id，
// 这样 SSE 后面那些只带 id 的增量就被丢掉。模型选择器那条路要用同一个判据，
// 所以导出。
export function collectText(node, out, state) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out, state)
    return
  }
  const record = node
  if (record.block_type === THINKING_BLOCK_TYPE && typeof record.block_id === 'string') state.thinkingIds.add(record.block_id)
  if (record.block_type === THINKING_BLOCK_TYPE) return
  const textBlock = record.text_block
  if (textBlock !== null && typeof textBlock === 'object' && typeof textBlock.text === 'string' && textBlock.text !== '') {
    out.push(textBlock.text)
  }
  if (typeof record.text === 'string' && record.text !== '' && record.content_block === undefined && record.message === undefined) {
    if (!(typeof record.id === 'string' && state.thinkingIds.has(record.id))) out.push(record.text)
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'text_block' || key === 'content_block' || key === 'message') {
      if (key !== 'text_block') collectText(value, out, state)
      continue
    }
    if (typeof value === 'object' && value !== null) collectText(value, out, state)
  }
}

export async function chat(cookieHeader, options = {}) {
  const prompt = String(options.prompt ?? '')
  if (prompt === '') throw new DoubaoError('EMPTY_PROMPT', '空的提问')
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs ?? 120_000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  const msToken = msTokenOf(cookieHeader)
  const url = `${HOST}${CHAT_PATH}?${buildQuery(msToken === '' ? {} : { msToken })}`
  const headers = { ...buildHeaders(cookieHeader), Accept: 'text/event-stream' }
  const body = JSON.stringify(buildChatBody(prompt, options))
  try {
    const pieces = []
    const state = { thinkingIds: new Set() }
    let firstMs = 0
    let ended = false
    let conversationId = ''
    let buffer = ''
    const handle = frame => {
      if (frame.event === 'SSE_ACK') {
        try {
          const payload = JSON.parse(frame.data)
          conversationId = payload?.ack_client_meta?.conversation_id ?? conversationId
        } catch { /* 合并到下一帧就好 */ }
        return
      }
      if (frame.event === 'STREAM_ERROR') {
        let code = ''
        let message = '上游报错'
        try {
          const payload = JSON.parse(frame.data)
          code = String(payload?.error_code ?? '')
          message = String(payload?.error_msg ?? message)
        } catch { /* 用默认文案 */ }
        throw new DoubaoError(code || 'STREAM_ERROR', `上游报错 ${code}：${message}`)
      }
      if (frame.event !== 'STREAM_MSG_NOTIFY' && frame.event !== 'STREAM_CHUNK' && frame.event !== 'CHUNK_DELTA') {
        if (frame.event === 'SSE_REPLY_END') ended = true
        return
      }
      let payload
      try { payload = JSON.parse(frame.data) } catch { return }
      const out = []
      collectText(payload, out, state)
      for (const piece of out) {
        if (piece === '') continue
        if (firstMs === 0) firstMs = Date.now() - startedAt
        pieces.push(piece)
        if (typeof options.onText === 'function') options.onText(piece)
      }
    }
    const finish = () => {
      // 一个事件的尾巴可能没有最后那个空行，补两个换行再切一次
      const parsed = parseFrames(buffer === '' ? '' : `${buffer}\n\n`)
      for (const frame of parsed.frames) handle(frame)
      const text = pieces.join('').trim()
      if (!ended && text === '') throw new DoubaoError('EMPTY_REPLY', '没有收到任何回复内容')
      return { text, firstMs, totalMs: Date.now() - startedAt, conversationId, modelId: options.modelId ?? '' }
    }
    if (typeof globalThis.fetch !== 'function') {
      const response = await httpsRequest(url, { method: 'POST', headers, body })
      if (response.status === 401) throw new DoubaoError(ERROR.SESSION_EXPIRED, '登录态失效（HTTP 401）', 401)
      if (!response.ok) throw new DoubaoError(`HTTP_${response.status}`, `HTTP ${response.status}：${response.body.slice(0, 160)}`, response.status)
      buffer = response.body
      return finish()
    }
    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    if (response.status === 401) throw new DoubaoError(ERROR.SESSION_EXPIRED, '登录态失效（HTTP 401）', 401)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new DoubaoError(`HTTP_${response.status}`, `HTTP ${response.status}：${text.slice(0, 160)}`, response.status)
    }
    const stream = response.body
    if (stream === null || typeof stream.getReader !== 'function') {
      throw new DoubaoError('NO_STREAM', '上游没有返回事件流')
    }
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) handle(frame)
      if (ended) break
    }
    buffer += decoder.decode()
    return finish()
  } finally {
    clearTimeout(timer)
  }
}
