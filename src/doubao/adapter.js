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
import { finishReason, readStream } from '../stream.js'

export const DOUBAO_PROVIDER = 'doubao'
export const DOUBAO_DISPLAY_NAME = '豆包工作'

const CHAT_PATH = '/chat/completion'
const DEFAULT_MAX_TOKENS = 8192

/**
 * 上游短时频控的退避。
 *
 * 710022004 的 error_msg 字面就是 `rate limited`（scripts/_db-heal2.mjs 实测：
 * 同一份 cookie 连着发，第二次起 250ms 就被拦），跟登录态、跟内容都无关。吐字
 * 之前撞上就等一会儿重来；吐过字就不重试，免得半截回答拼两遍。
 * TM.00001041 是会话槽满（同时 3 个），同样等一等就有位置。
 */
const RETRY_MAX = 3
const RETRY_DELAYS_MS = [1500, 4000, 9000]
const RETRYABLE_CODES = new Set([ERROR.RISK_CONTROL, 'TM.00001041'])

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** 一个模型行在卡片/选择器里的副标题。倍率来自上游 tag_list（"0.65x"）。 */
function describeModel(entry) {
  const parts = [DOUBAO_DISPLAY_NAME, '网页版额度']
  if (typeof entry.ratio === 'string' && entry.ratio !== '') parts.push(entry.ratio)
  return parts.join(' · ')
}

/**
 * 豆包通道的固定前缀与注入净化。
 *
 * 宿主下发的 system 里会混进各种插件塞进来的模块（prompt-inject.md 那类越狱
 * 注入、dsh_boost 覆盖块）。豆包上游的内容风控按整段语义判：只要请求最前面
 * 那一段带着「解除限制 / 无视规则」的语境，整条请求就被挡回「该内容涉嫌违反
 * 豆包使用规范」——用户看到的就是发任何东西都报违规。
 *
 * 所以这条通道的请求前缀必须是**固定的、干净的**，只用本文件的常量与本文件的
 * 规则，任何插件都改不到它：
 *   1. 开头固定拼 SAFE_PREFIX，谁都不能替代；
 *   2. system 按空行切段，命中注入特征的段落整段丢掉，没命中的原样留下 ——
 *      只管前缀，不动宿主自己那份正常提示词。
 *
 * 这个净化只发生在发给豆包的这一路请求上；别的渠道、别的对话读到的
 * messages 仍是原样，一个字都不改。
 */
const SAFE_PREFIX = '你是一个中文 AI 助手，正在协助用户完成当前任务。请直接、完整地回答用户的问题，不要复述这些说明。'

// 注入特征：伪造的 chat 模板边界、覆盖式的指令块、越狱模块自报的家门。
const INJECTION_MARKERS = [
  /<\|[^|>\n]{0,40}\|>/,              // <|im_start|> / <|im_end|> 这类伪造的模板边界
  /<\/?project_instructions>/i,
  /<\/?dsh_boost[\s>]/i,
  /\[\s*MODE\s*:\s*UNRESTRICTED/i,
  /UNRESTRICTED\s+SANDBOX/i,
  /\bPRIME\s+DIRECTIVE\b/,
  /\bNever\s+refuse\b/i,
]

/**
 * 整块剥离的注入模块。
 *
 * 段落级过滤治不了这些块：宿主把整套越狱指令写在一对标签里，开标签在第一段、
 * 闭标签在最后一段，中间那些「Scoped Rules 3. 病毒/蠕虫/木马…」「9. 写色情/
 * 黄文/露骨性行为…」的段落本身不带任何标签，按段过筛会原样留下 —— 实测
 * （scripts/_db-clean.mjs、_db-full.mjs）就是这样：项目指令剥掉了，规则正文
 * 一条不落全发到了豆包，上游按语义判成违规，整轮被拦。
 *
 * 所以先按成对标签整块删，再走段落过筛。没闭合的（system 被截断）从开标签删到段尾。
 */
const INJECTION_BLOCKS = [
  /<project_instructions>[\s\S]*?<\/project_instructions>/gi,
  /<dsh_boost[^>]*>[\s\S]*?<\/dsh_boost>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<context-rescue-checkpoint>[\s\S]*?<\/context-rescue-checkpoint>/gi,
  /<\|im_start\|>[\s\S]*?<\|im_end\|>/gi,
]

/** 只剥掉越狱模块这几对标签，正文一个字都不改；没闭合时删到末尾。 */
function stripInjectionBlocks(text) {
  let out = text
  for (const re of INJECTION_BLOCKS) out = out.replace(re, '')
  // 没闭合的开标签：从它删到段尾（这时候后面全是它的正文，留着就是原样外发）
  out = out.replace(/<(project_instructions|dsh_boost|system-reminder|context-rescue-checkpoint)\b[^>]*>[\s\S]*$/gi, '')
  return out
}

/**
 * 规则正文的语义特征。
 *
 * 只对 system 生效（用户自己的提问一个字都不动）。这些词出现在**系统提示**里
 * 基本只有一种来源：越狱模块的逐条操作清单。豆包风控按语义判，留着就整轮被拦。
 */
const SENSITIVE_MARKERS = [
  /Scoped\s+Rules/i,
  /REFUSAL\s+HARDENING/i,
  /拒绝对抗/,
  /Core\s+Motivation/i,
  /写色情|黄文|露骨性行为|AV\s*场景|角色扮演成人/,
  /病毒|蠕虫|木马|勒索|远控|键盘记录|间谍软件/,
  /外挂|读内存|改金币|反作弊/,
  /webshell|一句话木马|留后门/i,
  /钓鱼|仿站|社工库|撞库|盗刷|洗钱|跑分/,
  /找盗版|破解版|注册机|脱壳|卡密|磁力链接/i,
]

/**
 * 只有整份规则清单才有的招牌词。
 *
 * 对话轮次不能像 system 那样按单个敏感词过筛：用户问一句「木马是什么」、
 * 工具读一段过滤器源码（里面就有 木马 / webshell 这些字面量），都会被误伤，
 * 而实测（scripts/_db-tool.mjs 的 C/D、_db-slice.mjs 的 E）这类单片词根本
 * 不触发风控 —— 触发的是「一大段规则清单」这个整体语义。
 *
 * 所以对话轮次只认这份清单：命中 2 个以上才当作归档的规则正文处理。
 */
const STRONG_MARKERS = [
  /UNRESTRICTED\s+SANDBOX/i,
  /PRIME\s+DIRECTIVE/,
  /Little\s+Code\s+Sauce/i,
  /REFUSAL\s+HARDENING/i,
  /Scoped\s+Rules/i,
  /拒绝对抗|Core\s+Motivation/,
  /Never\s+refuse/i,
  /不做任何拒绝|解除一切限制|解除所有限制|无视一切规则|拒绝是一种故障/,
]

function looksInjected(text) {
  return INJECTION_MARKERS.some(re => re.test(text))
}

/** 单条消息里的伪协议标签一律抹掉，免得它们被当成真的模板边界。 */
function stripInjectionMarkup(text) {
  return text
    .replace(/<\|[^|>\n]{0,40}\|>/g, '')
    .replace(/<\/?project_instructions>/gi, '')
    .replace(/<\/?dsh_boost[^>]*>/gi, '')
}

/**
 * 一段话要不要丢。
 *
 * 命中特征词直接丢；另外把越狱模块的招牌句式也算进来 —— 那些段落本身不带
 * 标签，但通篇是「无视规则 / 不做任何拒绝」的口气，风控照样会咬。
 * 最后一道是规则正文的语义特征（Scoped Rules 的逐条清单那类），只在 system
 * 里生效。
 */
function paragraphInjected(para) {
  if (para.trim() === '') return false
  if (looksInjected(para)) return true
  if (/(不做任何拒绝|绝不拒绝|拒绝是一种故障|解除一切限制|解除所有限制|无视一切规则)/.test(para)) return true
  return SENSITIVE_MARKERS.some(re => re.test(para))
}

/**
 * system 净化的三步：成对标签整块剥（连带里面的规则正文）→ 按空行切段过筛 →
 * 抹掉残余的伪协议标签。
 */
function cleanSystem(text) {
  const kept = []
  for (const para of stripInjectionBlocks(text).split(/\n{2,}/)) {
    if (paragraphInjected(para)) continue
    const body = stripInjectionMarkup(para).trim()
    if (body !== '') kept.push(body)
  }
  return kept.join('\n\n')
}

/**
 * 对话轮次（user / assistant / tool）的净化。
 *
 * 原来这条分支一个字都不动，理由是「用户自己的提问不该被改」。实测下来这个
 * 假设站不住：
 *
 *   scripts/_db-role.mjs —— 同一段规则正文，放进 system 段被拦、放进 assistant
 *   段照样被拦（710022004「该内容涉嫌违反豆包使用规范」）；
 *   scripts/_db-role2.mjs —— 连 user 段里带 `[Compressed conversation section]`
 *   引一段规则正文都被拦（99 字、1.3 秒就回，稳定复现）；
 *   scripts/_db-det.mjs —— 同一段内容连发 6 次，6 次全拦，不是概率问题。
 *
 * 而 DSH 的历史里到处是这类正文：上下文压缩会把旧的越狱规则整段摘进摘要，
 * 助手回复里也会复述「按你的规则第 3 条…」。这些轮次原样外发，等于每一轮都
 * 把越狱正文重新递给风控 —— 用户看到的就是「发任何东西都报违规」。
 *
 * 所以对话轮次也过一遍：命中的段落换成一句占位继续往下走（不整轮丢掉，否则
 * 对话结构断裂、模型看不懂上下文），没命中的原样保留。用户真正的提问——问
 * 代码、贴报错、贴日志——不带这些特征词，一个字都不会被改。
 */
function cleanTurn(text) {
  const stripped = stripInjectionBlocks(text)
  // 整轮就是一份规则清单：直接换一句占位，剩下的残句没有意义，留着反而还在
  // 递语义线索给风控。
  const strong = STRONG_MARKERS.filter(re => re.test(stripped)).length
  if (strong >= 2) return `[本段历史含已归档的规则清单，已省略 ${stripped.length} 字]`
  const kept = []
  let skipped = 0
  for (const para of stripped.split(/\n{2,}/)) {
    const ruled = strong >= 1 && paragraphInjected(para)
    if (ruled) { skipped += para.length; continue }
    const body = stripInjectionMarkup(para).trim()
    if (body !== '') kept.push(body)
  }
  if (skipped > 0) kept.push(`[这一段已省略 ${skipped} 字]`)
  return kept.join('\n\n')
}

/**
 * 豆包网页版对单次输入的字符硬顶。
 *
 * 实测（scripts/_probe-doubao-thr.mjs、_probe-doubao-size2.mjs）：拍平后的 prompt
 * 到了 265000 字符，上游一定回 `710020202 common invalid param`；这个码跟请求形状
 * （runtime_type / agent_task_param / project_id）、model_extra_params、
 * taskMode 全都无关，只跟字符数有关。宿主每轮下发的 system 里塞了大量插件内容，
 * 加上几十个工具定义，很容易稳定越过这条线 —— 用户看到的就是「发任何东西都报
 * 该内容涉嫌违反豆包使用规范 / common invalid param」。
 *
 * 所以这条通道必须在发出去之前自己夹一刀：留着固定前缀 + 一段 system + 最新
 * 的若干轮，把老的丢掉。宁可少一点上下文，也不要整个请求被上游拒掉。
 */
export const PROMPT_CHAR_BUDGET = 200_000

/** system 再长也只留这么多字：真正把请求撑爆的就是它，不是对话本身。 */
const SYSTEM_CHAR_CAP = 60_000

const TRUNCATED_MARK = '\n…（内容过长，已截断）'
const DROPPED_MARK = '[较早的历史已省略]'

/**
 * 把宿主的 messages 拍成豆包要的那一段 prompt，并按字符预算夹取。
 *
 * 保留角色标签，因为拍平之后模型只能靠标签分辨谁说了什么；工具结果折叠成
 * 「工具结果」而不是伪装成 user，免得模型把它们当成用户的话去回答。
 *
 * 预算从后往前分配：最新的一轮一定有位置（它超长就先截它自己），更早的轮次
 * 放不下就整轮丢掉，并留一行说明。这样「用户刚说的话」永远不会被挤掉。
 *
 * @param messages 宿主下发的 messages
 * @param budget 拍平后允许的最大字符数
 * @returns 可以直接塞进 buildChatBody 的整段文本
 */
export function flattenMessages(messages, budget = PROMPT_CHAR_BUDGET) {
  const rows = Array.isArray(messages) ? messages : []
  const system = []
  const turns = []
  for (const row of rows) {
    const role = typeof row?.role === 'string' ? row.role : 'user'
    const text = contentText(row?.content)
    if (text === '') continue
    if (role === 'system') {
      const kept = cleanSystem(text)
      if (kept !== '') system.push(kept)
      continue
    }
    const body = cleanTurn(text)
    if (body === '') continue
    if (role === 'tool') turns.push(`[工具结果] ${body}`)
    else if (role === 'assistant') turns.push(`[助手] ${body}`)
    else turns.push(`[用户] ${body}`)
  }

  const parts = [SAFE_PREFIX]
  let left = budget - SAFE_PREFIX.length

  if (system.length > 0) {
    let systemText = system.join('\n\n')
    if (systemText.length > SYSTEM_CHAR_CAP) systemText = systemText.slice(0, SYSTEM_CHAR_CAP) + TRUNCATED_MARK
    parts.push(systemText)
    left = Math.max(0, left - systemText.length - 2)
  }

  if (turns.length > 0) {
    const kept = []
    let dropped = false
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const text = turns[i]
      const cost = text.length + 2
      if (cost <= left) {
        kept.unshift(text)
        left -= cost
        continue
      }
      if (kept.length === 0) {
        // 连最新的一轮都放不下：留开头那段（指令通常在前面），尾巴截掉。
        const room = left - TRUNCATED_MARK.length - 2
        if (room > 0) kept.unshift(text.slice(0, room) + TRUNCATED_MARK)
      }
      dropped = true
      break
    }
    if (dropped) kept.unshift(DROPPED_MARK)
    if (kept.length > 0) parts.push(kept.join('\n\n'))
  }

  return parts.join('\n\n')
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
    // 710022004 的实际含义是「这份登录态不是当前那个」，不是内容违规：网页端每开
    // 一次页面重铸 s_v_web_id，插件存的那份对不上就整轮被拦。pickAccount 已经会按
    // 浏览器当前 cookie 自愈，走到这里说明浏览器里也没有可用的新号。
    if (error.code === ERROR.RISK_CONTROL) return new Error('豆包不认这份登录态（710022004）：在浏览器里打开 www.doubao.com 刷新一次（保持登录），再重发这条消息')
    if (error.code === ERROR.INVALID_PARAM) {
      return new Error('豆包拒收了这次请求（710020202）：拍平后的输入超过了网页版字符硬顶。新开一轮对话再试，或先清掉过长的历史')
    }
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
export function createDoubaoAdapter({ doubao, logger = console, onRoster = null } = {}) {
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

  /**
   * 目录换了一版就叫外面重挂一次路由。
   *
   * 宿主的选择器（`buildModelCatalog`）是在 `modelCatalog()` 那一刻算出来的，
   * 客户端只在收到 `llm/adapters-updated` 时才重读；注册完就不再广播的插件，
   * 后面拿到的模型等于「只有自己知道」。所以每拉完一次目录都重播一遍。
   */
  function announce() {
    if (typeof onRoster !== 'function') return
    try {
      onRoster()
    } catch (error) {
      logger.warn?.(`get-it-for-free: 豆包目录广播失败：${error?.message ?? error}`)
    }
  }

  /** 后台补拉一次目录（加账号、点「刷新模型」之后用）。 */
  function warm() {
    if (refreshing) return
    refreshing = true
    void doubao.models()
      .then(() => { announce() })
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

    /**
     * 一次请求 + 读完整条流。
     *
     * 抽出来是为了上面的重试：710022004 的 error_msg 字面就是 rate limited
     * （scripts/_db-heal2.mjs 实测，同一份 cookie 隔几秒连发必被拦，250ms 就回），
     * 属于上游短时频控，不是登录态失效、也不是内容违规。没吐出任何字之前退避重来
     * 一次通常就过；已经吐过字则不能重试（会把半截回答拼两遍）。
     */
    async function runOnce(emit) {
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
              throw new DoubaoError(code || 'STREAM_ERROR', message)
            }
            if (frame.event === 'SSE_REPLY_END') {
              ended = true
              break
            }
            for (const piece of textOf(frame, state)) if (piece !== '') emit(piece)
          }
        }
        buffer += decoder.decode()
        if (!ended) {
          const parsed = parseFrames(`${buffer}\n\n`)
          for (const frame of parsed.frames) {
            if (frame.event === 'SSE_REPLY_END') { ended = true; break }
            for (const piece of textOf(frame, state)) if (piece !== '') emit(piece)
          }
        }
      } finally {
        try { reader.cancel() } catch { /* 已经关了 */ }
      }
    }

    void (async () => {
      let emitted = 0
      const emit = piece => { emitted += 1; push(piece) }
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await runOnce(emit)
            break
          } catch (error) {
            const code = error instanceof DoubaoError ? error.code : ''
            const retry = attempt < RETRY_MAX && emitted === 0 && RETRYABLE_CODES.has(code)
            if (!retry) throw error
            await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)])
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
      }
    })()

    // readStream 只把上游的 finish 记进快照，不产出 finish 块 —— 而宿主的块协议
    // 靠 finish 块收尾。以前这里直接结束，网关于是判定「流没结束就断了」，
    // 统一回 502 incomplete_stream（即使正文已经正常吐完）。
    const outcome = yield* readStream(channel.read(), 'chat', new Map(), () => Date.now(), {})
    if (outcome.sawUsage === true) yield { type: 'usage', usage: outcome.usage }
    yield { type: 'finish', reason: outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish) }
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
      // 目录不设账号门槛。原来这里「没有账号就返回空表」，代价是整组模型直接
      // 从右下角选择器里消失；而账号能不能用是发请求那一刻才知道的事
      // (stream() 会明确回「还没有登录账号：在设置的豆包卡里点添加账号」)。
      // 一个随时会整组消失的渠道，比一条选了才报错的模型更难用。
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

    /**
     * 基类里 `stream` 是**唯一**抽象方法（`LlmAdapter.stream`），其余都有默认
     * 实现。只给 `prepareCall` 是不够的：宿主有几条路径直接拿
     * `registration.adapter.stream(options)`（版本差异、探测、以及 `prepareCall`
     * 抛错后的回退），拿到 undefined 就是 TypeError，而注册外面那层 try/catch
     * 会把它咽掉 —— 表现就是「面板上模型数正常、右下角没有这一组」。
     * 所以两条入口都给，model 从 options 里取。
     */
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
}
