/**
 * 环回聊天 shim：本插件唯一的「聊天数据面」。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * pi-ai 的 `openAICompletionsApi` 只会说标准 OpenAI 协议
 * （`POST {baseUrl}/chat/completions`、`Authorization: Bearer <apiKey>`）。
 * 而 QwenWork 上游要的是：COSY 签名的 `Authorization: Bearer COSY.<...>`、
 * 被加密的 body、以及它自己那套双层信封 SSE。
 *
 * shim 夹在两者之间，把差异全部吸收掉：
 *
 *     pi-ai ──OpenAI 请求──▶ shim ──签名+加密──▶ gateway.qwenwork.cn
 *          ◀──OpenAI SSE──      ◀──双层信封 SSE──
 *
 * ── 安全边界（不可退让）─────────────────────────────────────────────
 *  1. **只接受环回请求**（Host/Origin 校验，见 ./loopback.js），挡 DNS-rebinding。
 *  2. **绝不下发凭据**：响应体里只有模型输出；上游签名头不回传。
 *  3. 监听地址固定 `127.0.0.1`，端口由系统分配（不对外暴露）。
 *  4. 日志不含 token / key；上游错误经脱敏后才回传。
 *
 * @module dsh-qwenwork-connect/chat-shim
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { loopbackRequest } from './loopback.js';
import { safeMessage } from './web-status.js';
import {
  SseParser,
  parseQwenWorkFrame,
  parseRawUsage,
  encodeOpenAiChunk,
  SSE_DONE,
} from './sse.js';
import { buildInferBody, createSignerSession } from './signer-session.js';
import {
  classifyUpstreamFailure,
  formatFailureMessage,
  parseUpstreamFailureText,
} from './upstream-errors.js';
import { resolveGatewayEndpoint, relaxTlsForVpc } from './endpoint.js';
import { FALLBACK_QWENWORK_MODELS, MAX_OUTPUT_TOKENS, normalizeModelKey } from './models.js';
import { recordSample } from './perf.js';
import { trace as appendTrace } from './trace.js';

/** shim 对外暴露的 OpenAI 兼容路径。 */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/** 默认的上游流空闲上限（毫秒）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * 「已拿到 200 但一直无正文」的放弃上限（毫秒）。
 *
 * trace 实测发现的真实故障模式（见 analyze-slow-detail 的输出）：
 *   upstream-headers 200 到得很快（2-10s），**之后**上游长时间静默——
 *   不发 reasoning、不发 content，连接挂着直到 DSH 侧放弃。
 *   典型样本：4112ms 拿到 200 → 177 秒零字节 → 结束（chars=0）。
 *
 * 这是上游「接了单但还没排到」的排队态。此时正确的做法是**尽早放弃**、
 * 让 DSH 的重试层换一个时间片再来——DSH 的指数退避（0.5/1/2/4/8s）
 * 正适合这种场景。挂在原地等 300 秒只是把失败拉长。
 *
 * 90 秒的依据：正常长思考的**首帧**（reasoning）实测都在 10 秒内到达
 * （见 probe-long-think-gap）；排队最坏也就几十秒。90 秒足够宽容，
 * 又能在「排不上的队列」里及时止损。
 */
export const FIRST_CONTENT_TIMEOUT_MS = 90_000;

/**
 * 可重试的上游状态码。
 *
 * 借鉴 Buddy2api `providers/qwenwork/constants.py` 的 `RETRYABLE_STATUS`：
 * 只重试「限流 / 网关瞬时故障」，不重试语义错误（400/401/403 重试也不会变好）。
 */
export const RETRYABLE_STATUS = Object.freeze([408, 409, 425, 429, 500, 502, 503, 504]);

/** 上游请求的最大尝试次数（含首次）。 */
export const UPSTREAM_MAX_ATTEMPTS = 3;

/** 重试的基础退避毫秒数（第 n 次重试等待 n × 该值）。 */
export const UPSTREAM_RETRY_BASE_DELAY_MS = 400;

/** 判断某状态码是否值得重试。 */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.includes(status);
}

/**
 * 上游「响应头」到达的等待上限（毫秒）。
 *
 * 为什么需要它：`fetch()` 会等到**响应头**到达才 resolve。若上游接受了连接
 * 却一直不响应，这个 await 永不返回——此时流内看门狗（`armIdle`）根本还没
 * 启动，客户端就会**无限等待**（界面一直转圈，不是报错，最难排查）。
 *
 * 为什么是 180 秒（曾为 60 秒，引发「长思考必超时」）：
 *   长思考请求（数学证明 / 逻辑题）在**响应头阶段**就要排队等上游调度，
 *   实测平峰 2–5 秒、高峰可远超 60 秒。60 秒的阈值会在高峰期把这些
 *   「慢但能成」的请求掐死在 502，随后 DSH 以 0.5/1/2/4/8s 的退避重试
 *   5 次，每次都可能再次撞上同一堵墙——用户看到的就是「长思考必超时」，
 *   而短请求（响应头快）完全正常。放宽到 180 秒后，高峰期的长思考
 *   请求能等到真正的响应头；真正的上游宕机仍会在 3 分钟内明确失败。
 *
 * 该值只覆盖「拿到响应头之前」，不限制后续流式读取（那由 `getIdleTimeoutMs`
 * 的流内看门狗负责）。
 *
 * ⚠️ 实现约束（2026-10-28 事故）：**必须用可清除的 AbortController，不得用
 * AbortSignal.timeout**。AbortSignal.timeout 一旦绑进 fetch 的 signal，undici
 * 会把它维持到**整个响应生命周期结束（含 body 流）**，而不是拿到头就解除——
 * 长思考请求（thinking 流 >180s）会在第 180 秒被掐死，抛
 * "The operation was aborted due to timeout"，且下游（DSH/pi）重试后每次都
 * 挂在同一秒。响应头到手后必须 clearTimeout，此后流只受 upstreamAbort
 * （idle 看门狗 / 客户端断开）控制。
 */
export const UPSTREAM_HEADER_TIMEOUT_MS = 180_000;

/**
 * 向签名后的上游端点发起请求，对可重试状态码做有限次重试。
 *
 * ⚠️ 调用方必须保证这发生在「向客户端写任何 SSE 之前」——一旦响应开始，
 * 重试会造成串流。本函数只负责拿到一个可用的 Response。
 *
 * @param {{ signInferRequest: Function }} session 签名会话
 * @param {string} bodyJson 已构造好的请求体
 * @param {string} modelKey 模型键
 * @param {{ warn?: Function }} log 日志器
 * @param {{ headerTimeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchUpstreamWithRetry(session, bodyJson, modelKey, log, opts = {}) {
  const headerTimeoutMs = opts.headerTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  let lastError = null;
  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt++) {
    // 每次尝试都重新签名：签名内含时间戳，重试时必须刷新，否则会被判过期。
    const signed = session.signInferRequest(bodyJson, { modelKey, modelSource: 'system' });
    let response;
    // ⚠️ 用**可清除**的 AbortController 而非 AbortSignal.timeout（见常量文档）：
    // 响应头到手立刻 clearTimeout，header 超时从此不再约束 body 流。
    const headerAbort = new AbortController();
    let headerTimer = null;
    try {
      // 响应头超时：上游不响应时明确失败，而不是让客户端无限等待。
      headerTimer = setTimeout(() => {
        headerAbort.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
      }, headerTimeoutMs);
      const signal =
        opts.signal === undefined
          ? headerAbort.signal
          : AbortSignal.any([opts.signal, headerAbort.signal]);
      response = await doFetch(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        signal,
      });
    } catch (error) {
      lastError = error;
      // ⚠️ **超时类失败不得重试**（这是「长思考必超时」的另一半根因）：
      //
      // header 超时 = 180s。若重试，最坏 3×180s ≈ 9 分钟都耗在这一个请求上；
      // 且超时几乎总是「上游高峰排队」，等 0.4s 再打大概率还是超时——重试
      // 只是把同样的等待重复三遍。更糟的是 DSH 的重试层看到我们最终失败
      // 还会再来 5 轮（0.5/1/2/4/8s 退避），叠加成用户视角的"永远转圈"。
      //
      // 正确姿势：超时立即抛给上层，让 DSH 的重试层（带指数退避）统一处理；
      // 我们只对**明确可恢复**的状态码（429/503 等）做本层重试。
      const isTimeout = /timeout|aborted/i.test(safeMessage(error));
      if (attempt < UPSTREAM_MAX_ATTEMPTS && !isTimeout) {
        log.warn?.(
          `dsh-qwenwork-connect: upstream network error (attempt ${attempt}/${UPSTREAM_MAX_ATTEMPTS})`,
          safeMessage(error),
        );
        await delay(UPSTREAM_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw error;
    } finally {
      // 无论成功/失败/抛错，header 计时器到此为止——成功路径上响应头已到手，
      // 之后的 body 流只受 opts.signal（idle 看门狗 / 客户端断开）约束。
      if (headerTimer !== null) clearTimeout(headerTimer);
    }

    if (response.ok || !isRetryableStatus(response.status)) return response;

    // 可重试状态：读掉 body 释放连接，再退避重试。
    if (attempt < UPSTREAM_MAX_ATTEMPTS) {
      await response.text().catch(() => '');
      log.warn?.(
        `dsh-qwenwork-connect: upstream ${response.status} (attempt ${attempt}/${UPSTREAM_MAX_ATTEMPTS}), retrying`,
      );
      await delay(UPSTREAM_RETRY_BASE_DELAY_MS * attempt);
      continue;
    }
    return response; // 最后一次仍失败：交给调用方按原状态码处理
  }
  if (lastError !== null) throw lastError;
  /* c8 ignore next */
  throw new Error('upstream retry loop exited unexpectedly');
}

/** 等待若干毫秒。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成每次启动唯一、进程内有效的共享密钥。
 *
 * 用途：进程级请求鉴别。环回校验挡住的是网络层（外部主机、DNS-rebinding），
 * 而共享密钥挡住的是**本机其他进程**——它们能构造环回请求，但拿不到这个
 * 只在进程内传递的密钥。两者叠加才是完整边界。
 *
 * 密钥不落盘、不进日志、不下发浏览器；每次启动重新生成（不持久化更安全）。
 */
export function generateSharedSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * 常量时间比较共享密钥。
 *
 * `crypto.timingSafeEqual` 要求两侧长度严格相等，否则抛
 * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`。header 侧密钥长度未知，故两侧先取
 * SHA-256（固定 32 字节）再比较——既规避长度陷阱，又保留常量时间语义。
 *
 * @param {string} received 请求头里收到的候选密钥
 * @param {string} expected 本进程生成的共享密钥
 */
export function secretMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 从请求头解析 Bearer 凭据。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | undefined}
 */
function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * 从 OpenAI 请求体里取出 QwenWork 需要的 messages。
 *
 * `content` 会被塌缩成纯文本（OpenAI 的多模态 content 数组只取 `type === 'text'`
 * 部分——**视觉输入本期不支持**，见 README 的未支持列表）。
 *
 * **工具调用历史必须保留**：`assistant.tool_calls` 与 `role: "tool"` 的返回结果
 * 是模型进行多轮工具调用的上下文。若在这里丢弃，模型会失去工具调用历史，
 * 只能凭用户消息重新编造一轮调用。
 *
 * **但 tool_calls 必须降级到上游转换器能吃的形态**（t4 定位的 400 根因）：
 * `qwen4-max` 这条模型路径在转换请求时会对 `function.arguments` 做严格 JSON
 * 解析，解析失败就整请求 `400 "Failed to convert request"`（首帧即错，不上模型）。
 * 事故形态：模型把两次调用挤进了同一个 tool_call，arguments 成了
 * `'{"file_path":"…"}{"command":"…"}'` —— 两个 JSON 对象首尾相接，不是合法 JSON。
 * 更糟的是这条坏消息一旦落进会话历史，**之后每一轮**都带着它重发，于是永久 400。
 * `pro` 路径对此宽容（实测 200），所以这个坑只在 qwen4-max 一类模型上炸。
 *
 * 处理原则是**降级而不是丢弃**（见 `sanitizeToolCalls`）：拆出第一个合法 JSON
 * 对象作为 arguments，剩余片段以 `[tool: name ← …]` 文本并回该条 assistant 的
 * content，模型仍能看到完整历史；`tools` schema 一律不动（实测上游对
 * `$schema`/`additionalProperties`/`oneOf`/`format` 都能吃）。
 *
 * @param {any} body
 * @param {{ onDegrade?: (info: Record<string, any>) => void }} [options]
 *   `onDegrade` 在发生任何降级时被调用一次（宿主拿它写
 *   `trace('convert-degrade', …)`，事后能查到「这一轮剔除了什么」）。
 * @returns {Array<object>}
 */
/**
 * 思考强度的落点：输出上限。
 *
 * 上游（gateway.qwenwork.cn）对 `reasoning_effort` / `enable_thinking` 一律无视
 * （2026-11-08 实测）。这条线路上唯一真生效的控制量是 `parameters.max_tokens`：
 * 上限越小，思考链越短（src/effort.js 2026-09-24 的对照实验：64 token 上限把
 * reasoning 从约 397 压到约 63）。所以宿主选的档位在这里收敛成一个数。
 *
 * 宿主给的 `max_tokens` 只能往下压，不能往上抬；下限 1024 —— 再低答案本身就没
 * 地方落。宿主没给档位就保持历史行为（整窗 32000），不让菜单反过来削默认额度。
 */
const EFFORT_CEILING = { low: 4096, medium: 8192, high: MAX_OUTPUT_TOKENS };

export function resolveOutputCeiling(body) {
  const effort = typeof body?.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : '';
  const rung = EFFORT_CEILING[effort] ?? MAX_OUTPUT_TOKENS;
  const asked = Number(body?.max_tokens);
  const bounded = Number.isFinite(asked) && asked > 0 ? Math.min(rung, asked) : rung;
  return Math.max(1024, Math.trunc(bounded));
}

export function toQwenWorkMessages(body, options = {}) {
  const onDegrade = typeof options.onDegrade === 'function' ? options.onDegrade : () => {};
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  /** @type {Array<object>} */
  const out = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message === null || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = flattenContent(message.content);

    // role: "tool" —— 工具执行结果。content 可以为空串，但仍要带 tool_call_id。
    if (role === 'tool') {
      const entry = { role, content };
      if (typeof message.tool_call_id === 'string') entry.tool_call_id = message.tool_call_id;
      if (typeof message.name === 'string') entry.name = message.name;
      out.push(entry);
      continue;
    }

    // assistant 带 tool_calls —— 工具调用请求。可能同时没有文本 content。
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const { calls, notes } = sanitizeToolCalls(message.tool_calls, onDegrade, messageIndex);
      if (calls.length === 0) {
        // 全部调用都不可救（连 name 都没有）：只剩文本内容可送，避免整轮丢失。
        if (content !== '') out.push({ role, content });
        continue;
      }
      const entry = { role, content: notes.length === 0 ? content : [content, ...notes].filter((s) => s !== '').join('\n\n') };
      entry.tool_calls = calls;
      out.push(entry);
      continue;
    }

    // 含图片的消息：**必须保留数组 content**（不能塌缩成纯文本）。
    //
    // 实测结论（见 research/probes-2026-09-14/probe-image-format.mjs 的变体对照）：
    // 上游要同时具备两个条件才会「看到」图片——
    //   ① chat_context.imageUrls 非空（标注本轮有图）
    //   ② messages[].content 是含 image_url 的**数组**
    // 任一缺失，模型都会回复「我没有看到您上传的图片」。
    const multimodal = toMultimodalContent(message.content);
    if (multimodal !== null) {
      out.push({ role, content: multimodal });
      continue;
    }

    if (content === '') continue;
    out.push({ role, content });
  }
  return out;
}

/** 并入 content 的降级提示里，最多引用多少字符的原始 arguments 片段。 */
const DEGRADE_SNIPPET_MAX = 240;

/**
 * 从一段文本里截出**第一个完整的 JSON 值**（对象或数组）。
 *
 * 专治「模型把两次调用挤进一个 tool_call」这种坏 arguments：
 * `'{"file_path":"a.md"}{"command":"ls"}'` → 前半段是合法 JSON，后半段是
 * 另一个被硬接进来的对象。用括号配平扫描（跳过字符串内的括号与转义）找出
 * 第一个值的边界，剩下的留给调用方当文本处理。
 *
 * @param {string} text
 * @returns {{ value: unknown, raw: string, end: number } | null}
 *   `raw` 是第一个值的原文切片，`end` 是它结束后的下标（用于取剩余片段）。
 */
function firstJsonValue(text) {
  const begin = text.search(/[{[]/);
  if (begin < 0) return null;
  const open = text[begin];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = begin; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(begin, i + 1);
        try {
          return { value: JSON.parse(raw), raw, end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 把 tool_call 的 `function.arguments` 收敛成**上游能 JSON 解析的对象字符串**。
 *
 * 上游 `qwen4-max` 转换器对 arguments 做严格 JSON.parse，失败就整请求 400；
 * `pro` 路径宽容。所以这里只做「保证合法对象」这一件事，能救的信息一律保留：
 *
 * | 输入 | 输出 | degrade |
 * |---|---|---|
 * | 合法对象 JSON | 原样不动（一个字符都不改） | — |
 * | 两个 JSON 首尾相接 | 第一个对象（压缩）+ 剩余片段进 notes | `arguments-concat` |
 * | 截断的 JSON | 救不回来 → `{}` + 片段进 notes | `arguments-unparsable` |
 * | 空串 / 缺省 | `{}` | `arguments-empty` |
 * | 已是对象（非字符串） | `JSON.stringify` | `arguments-object` |
 * | 合法但不是对象（数组/标量） | `{"value": …}` | `arguments-not-object` |
 *
 * @param {unknown} raw
 * @returns {{ arguments: string, degrade: string | null, rest: string }}
 */
function normalizeToolArguments(raw) {
  if (raw !== null && typeof raw === 'object') {
    return { arguments: JSON.stringify(raw), degrade: 'arguments-object', rest: '' };
  }
  if (typeof raw !== 'string') return { arguments: '{}', degrade: 'arguments-empty', rest: '' };
  const text = raw.trim();
  if (text === '') return { arguments: '{}', degrade: 'arguments-empty', rest: '' };
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { arguments: text, degrade: null, rest: '' };
    }
    return { arguments: JSON.stringify({ value }), degrade: 'arguments-not-object', rest: '' };
  } catch {
    // 落到抢救路径
  }
  const head = firstJsonValue(text);
  if (head !== null && head.value !== null && typeof head.value === 'object' && !Array.isArray(head.value)) {
    return { arguments: JSON.stringify(head.value), degrade: 'arguments-concat', rest: text.slice(head.end).trim() };
  }
  return { arguments: '{}', degrade: 'arguments-unparsable', rest: text };
}

/**
 * 清洗一条 assistant 的 `tool_calls`：只留上游认识的字段，arguments 保证合法。
 *
 * 被丢掉的只有**上游不认识的私有字段**（`index`、`extra_content` 等）和
 * 连 `name` 都没有的残废调用；能表达的信息一律降级进文本 notes，不静默蒸发。
 *
 * @param {Array<any>} toolCalls
 * @param {(info: Record<string, any>) => void} onDegrade
 * @param {number} messageIndex 消息在原始数组里的下标（便于对照 trace）
 * @returns {{ calls: Array<object>, notes: Array<string> }}
 */
function sanitizeToolCalls(toolCalls, onDegrade, messageIndex) {
  /** @type {Array<object>} */
  const calls = [];
  /** @type {Array<string>} */
  const notes = [];
  for (const [index, raw] of toolCalls.entries()) {
    if (raw === null || typeof raw !== 'object') {
      onDegrade({ messageIndex, index, kind: 'tool-call-dropped', reason: 'not-an-object' });
      continue;
    }
    const fn = raw.function !== null && typeof raw.function === 'object' ? raw.function : raw;
    const name = typeof fn.name === 'string' ? fn.name : typeof raw.name === 'string' ? raw.name : '';
    if (name === '') {
      onDegrade({ messageIndex, index, kind: 'tool-call-dropped', reason: 'no-name' });
      continue;
    }
    const { arguments: args, degrade, rest } = normalizeToolArguments(fn.arguments);
    const extraFields = Object.keys(raw).filter((k) => !['id', 'type', 'function', 'name'].includes(k));
    const call = { type: 'function', function: { name, arguments: args } };
    if (typeof raw.id === 'string' && raw.id !== '') call.id = raw.id;
    calls.push(call);

    if (degrade !== null) {
      const snippet = rest.length > DEGRADE_SNIPPET_MAX ? `${rest.slice(0, DEGRADE_SNIPPET_MAX)}…` : rest;
      onDegrade({
        messageIndex,
        index,
        kind: 'tool-call-arguments',
        tool: name,
        reason: degrade,
        rawChars: typeof fn.arguments === 'string' ? fn.arguments.length : 0,
        keptChars: args.length,
        droppedFields: extraFields,
        snippetChars: snippet.length,
      });
      if (snippet !== '') {
        // 降级进文本：模型仍能看到「这一轮还想过带上这些参数」。
        notes.push(`[tool: ${name} ← 未合并进 arguments 的参数片段：${snippet}]`);
      } else {
        notes.push(`[tool: ${name} ← arguments 无法解析（${degrade}），已按空对象处理]`);
      }
    } else if (extraFields.length > 0) {
      // arguments 本身没问题，只剥了私有字段：记一行，不往 content 里塞文本。
      onDegrade({ messageIndex, index, kind: 'tool-call-fields', tool: name, droppedFields: extraFields });
    }
  }
  return { calls, notes };
}

/**
 * 把含图片的 content 转成上游接受的多模态数组；无图时返回 `null`。
 *
 * 输出形态为 OpenAI 标准：`[{type:'text',text}, {type:'image_url',image_url:{url}}]`
 * （变体对照中只有这种 + imageUrls 组合能让上游识别）。
 *
 * @param {unknown} content
 * @returns {Array<object> | null}
 */
function toMultimodalContent(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image' || part.type === 'image_url') {
      const url = extractImageUrl(part);
      if (url === null) continue;
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return hasImage ? parts : null;
}

/**
 * 把 OpenAI 的 content 归一化成纯文本。
 *
 * 文本部分照常拼接；**图片块在其位置留下占位说明**（图片数据本身由
 * `collectImageUrls` 单独提取后经 `chat_context.imageUrls` 送上游）。
 *
 * 为什么留占位而不是直接丢弃：模型需要知道「这轮有图」，否则面对
 * "这张图里有什么？"会凭空编造答案。
 *
 * @param {unknown} content
 * @returns {string}
 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    if (part.type === 'image' && extractImageUrl(part) !== null) {
      parts.push('[图片]');
      continue;
    }
    if (part.type === 'image' || part.type === 'image_url') {
      parts.push('[图片：格式无法识别，已忽略]');
    }
  }
  return parts.join('');
}

/**
 * 从图片块里取出可送上游的 URL / data URL。
 *
 * 支持两种形态：
 *   ① DSH 内部形态：`{ type: 'image', data: '<base64>', mimeType: 'image/png' }`
 *      （见 dsh-llm-pi-ai 的 `userContent()`——它把持久化附件解成 base64）
 *   ② OpenAI 标准形态：`{ type: 'image_url', image_url: { url } }`
 *
 * @param {any} part
 * @returns {string | null}
 */
function extractImageUrl(part) {
  // ② OpenAI 标准
  if (part.type === 'image_url') {
    const url = part.image_url?.url ?? part.image_url;
    if (typeof url === 'string' && url !== '') return url;
    return null;
  }
  // ① DSH 内部：base64 + mimeType → data URL
  if (typeof part.data === 'string' && part.data !== '') {
    const mime = typeof part.mimeType === 'string' && part.mimeType !== '' ? part.mimeType : 'image/png';
    return `data:${mime};base64,${part.data}`;
  }
  // 有的实现直接给 url 字段
  if (typeof part.url === 'string' && part.url !== '') return part.url;
  return null;
}

/**
 * 收集整个请求里所有图片，转成上游要的 URL 列表。
 *
 * ⚠️ 只取**最后一条 user 消息**里的图片：上游的
 * `chat_context.imageUrls` 描述的是「当前这轮要处理的图」，
 * 把历史图片一并塞进去会让模型重复分析旧图。
 *
 * @param {{ messages?: Array<any> }} body
 * @returns {string[]}
 */
export function collectImageUrls(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    const urls = [];
    for (const part of m.content) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type !== 'image' && part.type !== 'image_url') continue;
      const url = extractImageUrl(part);
      if (url !== null) urls.push(url);
    }
    return urls;
  }
  return [];
}

/**
 * 提取一个稳定、可复用多轮的 session id。
 *
 * 多轮对话的关键：同一会话的多次请求必须带**同一个** `session_id`，
 * 否则上游无法关联上文。优先级：
 *   1. 调用方显式传入
 *   2. OpenAI 请求体的 `user` 字段（DSH 会带上会话标识）
 *   3. 由首条消息内容派生的稳定指纹（同一对话历史 → 同一 id）
 *
 * @param {any} body
 * @param {string|undefined} explicit
 * @returns {string}
 */
export function deriveSessionId(body, explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof body?.user === 'string' && body.user !== '') return `user-${simpleHash(body.user)}`;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = messages.find((m) => m !== null && typeof m === 'object');
  const seed = first === undefined ? '' : flattenContent(first.content);
  return seed === '' ? `sess-${Date.now().toString(36)}` : `conv-${simpleHash(seed)}`;
}

/** 稳定的 32 位字符串哈希（FNV-1a），用于派生会话 id。 */
export function simpleHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 确定请求要用的模型 key。
 *
 * DSH/pi-ai 会把模型 id 放在 `body.model`。QwenWork 的 `model_config.key`
 * 使用上游短名（pro / flash / ...）；宿主 UI（如 pi 选择器）可能回传目录声明
 * 的展示名 `displayNameId`（如 qwen3.8-flash），这里经 normalizeModelKey()
 * 归一化回短名。缺省回退 `pro`。
 *
 * @param {any} body
 * @returns {string}
 */
export function resolveModelKey(body) {
  const model = body?.model;
  if (typeof model === 'string' && model !== '') return normalizeModelKey(model);
  return 'pro';
}

/**
 * 取某个模型声明的能力位（供 1.2.0 的 `model_config.is_vl` / `is_reasoning` 使用）。
 *
 * 依据：SDK 1.2.0 的 `model_config`（规格 §3.6，偏移 8816066）里
 *   `is_vl: t?.isVl ?? r?.is_vl ?? false`、`is_reasoning: r?.is_reasoning ?? false`，
 * 其中 `r` 是上游 catalog 返回的**逐模型**记录。插件不动态拉 catalog，等价物是
 * models.js 的静态目录（其注释注明取自 App `rawModels` 的 `is_vl` 等实测值）：
 *   - `is_vl`        ← 目录的 `supportsImages`（App `rawModels.is_vl === true`）
 *   - `is_reasoning` ← 固定 true：思考始终开启，与 models.js 的 `reasoning:false`
 *                      不冲突（后者只是让 DSH 不生成推理等级菜单；pi-ai 仍会
 *                      解析上游的 `reasoning_content`，思考块照常显示）
 *
 * 目录里查不到的模型按 SDK 的兜底取 `false`——不凭空声明能力。注意
 * `is_reasoning` 还会被 SDK 按 `thinkingBudget === 0` / `reasoning_effort === "none"`
 * 降级为 false（规格 §3.6）；但实测该降级对上游无效（QwenWork 网关强制思考，
 * 2026-11-08 probe-disable-thinking.mjs 五变体对照），插件不做也无法做思考开关。
 * 上游无法关闭的应对见 models.js `toPiModel()` 里「思考开关握手」注释。
 *
 * ⚠️ **`is_vl` 绝不可用作「是否发送图片」的开关**（t7 实测）：
 *   - 上游**不看**该字段——实测 `is_vl:false` 时上游照样正常识图；
 *   - 它只是 SDK **本地**决定是否把图片降级为 `[Image omitted...]` 占位符的开关；
 *   - 真正的发图判据是 `toMultimodalContent()`：content 数组里存在
 *     `{type:"image_url"}` 块才发图，与模型能力声明无关。
 *   它在这里**仅**用于填写 1.2.0 契约要求的 `model_config.is_vl` 字段。
 *
 * @param {string} modelKey
 * @returns {{ isVl: boolean, isReasoning: boolean }}
 */
function resolveModelCapabilities(modelKey) {
  const info = FALLBACK_QWENWORK_MODELS.find((m) => m.id === modelKey);
  if (info === undefined) return { isVl: false, isReasoning: false };
  return { isVl: info.supportsImages === true, isReasoning: true };
}

/**
 * 创建 shim 的请求处理器。
 *
 * @param {{
 *   getCredential: () => Promise<any>,
 *   getIdleTimeoutMs?: number,
 *   endpoint?: string,
 *   identity?: { installRoot?: string, env?: NodeJS.ProcessEnv },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   signerFactory?: typeof createSignerSession,
 * }} deps
 */
export function createChatShimHandler(deps) {
  const idleTimeoutMs = deps.getIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  // 上游「响应头」等待上限。默认 60s；测试可传更小值验证不悬挂。
  const headerTimeoutMs = deps.getHeaderTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  const log = deps.logger ?? {};
  const signerFactory = deps.signerFactory ?? createSignerSession;
  // 共享密钥：优先用调用方传入的（startChatShim 会生成并传入），
  // 否则在此处生成——保证「无密钥即拒绝」始终成立，密钥绝不缺省为空。
  const sharedSecret = deps.sharedSecret ?? generateSharedSecret();
  /** 缓存的签名会话，避免每次请求都重建 COSY 上下文。 */
  let sessionPromise = null;
  /** 会话对应的 token，用于在凭据变更时失效。 */
  let sessionToken = null;
  /** 只对当前网关放行 TLS 的 fetch；公有云保持全局 fetch。 */
  let gatewayFetch = globalThis.fetch;

  /** 取（或重建）签名会话。token 变化时自动重建。 */
  async function getSession() {
    const credential = await deps.getCredential();
    const token = credential?.token ?? '';
    if (sessionPromise !== null && token !== '' && token === sessionToken) return sessionPromise;
    if (sessionPromise !== null) {
      // 凭据已变更：释放旧会话
      sessionPromise.then((s) => s.dispose?.()).catch(() => {});
    }
    sessionToken = token;
    // 端点随凭据解析：VPC 租户（iss 含 .vpc.）自动切到租户网关，公有云
    // 租户保持缺省。deps.endpoint 显式传入时优先（测试/覆盖口）。
    const resolvedEndpoint = deps.endpoint ?? resolveGatewayEndpoint(credential);
    gatewayFetch = relaxTlsForVpc(resolvedEndpoint);
    sessionPromise = signerFactory({
      credential,
      endpoint: resolvedEndpoint,
      ...(deps.identity === undefined ? {} : { identity: deps.identity }),
    });
    sessionPromise.catch(() => {
      sessionPromise = null;
      sessionToken = null;
    });
    return sessionPromise;
  }

  return async function handleChatShim(req, res) {
    const reqT0 = Date.now();
    const requestId = crypto.randomUUID();
    const trace = (event, data = {}) => appendTrace(event, { requestId, ...data });
    trace('request-in', { method: req.method, url: req.url });
    // ---- 观测盲区修补 -------------------------------------------------
    // 曾有 33 条请求只留下 `request-in`，之后一行都没有：它们走的都是
    // 「向客户端写完错误就 return」的提前返回，以及**在下方 res.on('close')
    // 注册之前**就断开的连接。两种情况都不落日志，事后无法归因。
    // `stage` 记录请求走到的最后一步；`settled` 表示已有专门的收尾行
    // （reject / upstream-fail / upstream-rejected / stream-end）。未 settled 就
    // 结束 ⇒ 补一行 request-end，说明它走到了哪里、是客户端先挂断还是
    // 处理器抛异常后由外层回了 500。
    let stage = 'request-in';
    let settled = false;
    /** 提前返回统一出口：先留痕，再回错误。 */
    const reject = (reason, status, message, type) => {
      stage = `reject:${reason}`;
      // 客户端已挂时 close 监听可能先记了一行 request-end：同一请求只允许
      // 一条终止记录，否则下游统计会重复计数。
      if (!settled) {
        settled = true;
        trace('reject', { reason, status, ms: Date.now() - reqT0, message });
      }
      jsonError(res, status, message, type);
    };
    res.on('close', () => {
      if (settled) return;
      trace('request-end', {
        stage,
        // ended=false：客户端在完成前断开；ended=true：我们回了响应却没人记账
        //（处理器抛异常，由 startChatShim 的 catch 回了 500）。
        ended: res.writableEnded === true,
        ms: Date.now() - reqT0,
      });
      settled = true;
    });
    if (req.method !== 'POST') {
      reject('method', 405, 'method not allowed', 'invalid_request_error');
      return;
    }
    if (!loopbackRequest(req)) {
      reject('loopback', 403, 'request-not-trusted', 'permission_error');
      return;
    }
    // 进程级鉴别：环回校验挡住外部主机，这里挡住本机其他进程。
    // 无密钥 / 错误密钥一律 401——不得在未鉴别时触碰任何业务逻辑或上游。
    if (!secretMatches(extractBearer(req), sharedSecret)) {
      reject('auth', 401, 'unauthorized', 'authentication_error');
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      // 超上限与「客户端中途挂断」都从这里出来，必须分开记。
      const oversize = /too large/i.test(safeMessage(error));
      reject(oversize ? 'body-too-large' : 'body-read-failed', 413, safeMessage(error), 'invalid_request_error');
      return;
    }
    stage = 'body-read';

    let body;
    try {
      body = JSON.parse(raw === '' ? '{}' : raw);
    } catch {
      reject('invalid-json', 400, 'request body is not valid JSON', 'invalid_request_error');
      return;
    }
    stage = 'body-parsed';

    const messages = toQwenWorkMessages(body, { onDegrade: (info) => trace('convert-degrade', info) });
    if (messages.length === 0) {
      reject('no-messages', 400, 'messages is required', 'invalid_request_error');
      return;
    }
    // 必须至少有一条 user 消息：上游以「最后一条 user 消息」作为 chat_context.text，
    // 只有 system / 只有 assistant 时该字段为空，上游会拿空输入作答（表现为答非所问）。
    // 与其让下游收到一段莫名其妙的内容，不如立刻给出明确的 400。
    if (!messages.some((m) => m.role === 'user')) {
      reject('no-user-message', 400, 'messages must contain at least one user message', 'invalid_request_error');
      return;
    }

    const modelKey = resolveModelKey(body);
    const sessionId = deriveSessionId(body, undefined);

    let session;
    try {
      session = await getSession();
    } catch (error) {
      log.warn?.('dsh-qwenwork-connect: chat shim could not build signer session', safeMessage(error));
      reject('signer-session', 503, safeMessage(error), 'authentication_error');
      return;
    }
    stage = 'session-ready';

    // ---- 向上游发起签名请求 ------------------------------------------
    // 重试策略借鉴 Buddy2api 的 RETRYABLE_STATUS：仅对可重试状态码（限流/网关瞬时故障）
    // 重试，且必须发生在「向客户端写任何 SSE 之前」——否则响应已开始，重试会串流。
    //
    // ⚠️ `upstreamAbort` 必须在此**声明**（下方多处引用它）：它的声明位置曾晚于
    // 首次使用，导致 TDZ 错误 `Cannot access 'upstreamAbort' before initialization`，
    // 使**所有**请求都直接 502。
    const upstreamAbort = new AbortController();
    let upstream;
    /** @type {Record<string, string>} */
    const upstreamRequestIds = {};
    try {
      // tools 必须一并透传：否则模型收不到工具 schema，会编造自由文本格式。
      // 1.2.0 的 model_config 需要 is_vl / is_reasoning（规格 §3.6），取值来自
      // models.js 的静态目录声明（插件侧不动态拉 catalog）。
      const capabilities = resolveModelCapabilities(modelKey);
      const bodyJson = buildInferBody({
        messages,
        modelKey,
        sessionId,
        tools: body?.tools,
        isVl: capabilities.isVl,
        isReasoning: capabilities.isReasoning,
        // 图片经 chat_context.imageUrls 送上游。
        // ⚠️ t7 实测：该字段**无实际作用**，真正生效的通道是 messages[].content[]
        // 里的 {type:"image_url",image_url:{url}}（由 toMultimodalContent 产出）。
        // 此处保留仅为「只增不减」既有行为，删除它不属本任务范围。
        imageUrls: collectImageUrls(body),
        // 思考强度只在这一处生效：档位 → parameters.max_tokens（见 resolveOutputCeiling）。
        maxOutputTokens: resolveOutputCeiling(body),
      });
      stage = 'upstream-fetch';
      upstream = await fetchUpstreamWithRetry(session, bodyJson, modelKey, log, {
        signal: upstreamAbort.signal,
        fetchImpl: gatewayFetch,
        ...(headerTimeoutMs === undefined ? {} : { headerTimeoutMs }),
      });
      for (const name of ['x-request-id', 'x-acs-request-id', 'request-id', 'x-trace-id', 'x-correlation-id', 'traceparent']) {
        const value = upstream.headers.get(name);
        if (value !== null) upstreamRequestIds[name] = value;
      }
      trace('upstream-headers', {
        ms: Date.now() - reqT0,
        status: upstream.status,
        model: modelKey,
        upstreamSessionId: sessionId,
        upstreamRequestIds,
        contentType: upstream.headers.get('content-type'),
      });
    } catch (error) {
      settled = true;
      trace('upstream-fail', { ms: Date.now() - reqT0, error: safeMessage(error) });
      log.warn?.('dsh-qwenwork-connect: upstream request failed', safeMessage(error));
      jsonError(res, 502, safeMessage(error), 'api_error');
      return;
    }
    stage = 'upstream-headers';

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      // 上游的错误体可能是业务码 JSON（10605 排队、配额码等），也可能只是文本。
      // 分类后按语义状态返回，pi-ai / DSH 才能判断该不该重试。
      const failure = classifyUpstreamFailure({
        status: upstream.status,
        ...parseUpstreamFailureText(text),
      });
      settled = true;
      trace('upstream-rejected', {
        ms: Date.now() - reqT0,
        status: upstream.status,
        code: failure.code,
        retryAfter: failure.retryAfter ?? null,
      });
      log.warn?.(
        `dsh-qwenwork-connect: upstream rejected (${upstream.status}/${failure.code})`,
      );
      jsonError(res, failure.status, safeMessage(failure.message), errorTypeFor(failure));
      return;
    }

    // ---- 解析上游 SSE 并转成 OpenAI SSE ------------------------------
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // 明确禁止缓冲，保证真流式
      'X-Accel-Buffering': 'no',
    });

    // 自此时刻起，收尾由下面的 stream-end / close 监听器负责，
    // 顶部的 client-abort 观测器不再重复记账。
    settled = true;

    const chunkId = `chatcmpl-${requestId}`;
    const created = Math.floor(Date.now() / 1000);
    const parser = new SseParser();
    let finished = false;
    let clientGone = false;
    /** 上游在流中途报错；置位后不得再补正常收尾帧，否则会掩盖真实错误。 */
    let errored = false;
    /** 上游末帧给出的 token 统计（OpenAI 形态）；拿不到保持 null，不编造。 */
    let usage = null;
    // ---- 性能采样（供设置卡片展示上游速度）----
    const startedAt = Date.now();
    /** 首个**正文**内容到达时刻；null 表示还没有正文。 */
    let firstContentAt = null;
    /** 累加的正文长度（不含思考链）——速率只看正文，否则思考会虚高。 */
    let outputChars = 0;
    /** 累加的思考链长度：只思考不回答的回合要靠它区分「有产出」与「空回合」。 */
    let thinkingChars = 0;
    /** 本回合是否已下发工具调用分片（有它就算有产出）。 */
    let toolCallsEmitted = false;
    let lastChunkAt = null;
    let upstreamChunks = 0;
    let upstreamBytes = 0;
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    const streamDiagnostics = () => ({
      responseId: chunkId,
      upstreamSessionId: sessionId,
      upstreamRequestIds,
      lastChunkAt: lastChunkAt === null ? null : new Date(lastChunkAt).toISOString(),
      idleMs: Date.now() - (lastChunkAt ?? startedAt),
      upstreamChunks,
      upstreamBytes,
      outputChars,
      thinkingChars,
      toolCallsEmitted,
      usageSeen: usage !== null,
      eventLoopDelayMs: eventLoopDelay.max === 0 ? null : {
        resolutionMs: 20,
        max: eventLoopDelay.max / 1e6,
        p99: eventLoopDelay.percentile(99) / 1e6,
      },
    });
    // ---- 「200 之后的静默」放弃计时器 ----
    // 上游拿到 200 后若在 FIRST_CONTENT_TIMEOUT_MS 内**任何帧都没发**
    // （reasoning 或 content 都算帧），就视为排队失败，主动放弃并报错。
    // 见 FIRST_CONTENT_TIMEOUT_MS 的文档（trace 实测的排队态卡死模式）。

    res.on('close', () => {
      clientGone = true;
      // 客户端走了就没有下游了，及时中断上游，避免连接与 token 被白白消耗。
      try {
        upstreamAbort.abort('client disconnected');
      } catch {
        /* 已中止 */
      }
    });

    /** 写一块；客户端断开后不再写。 */
    const write = (text) => {
      if (clientGone || res.writableEnded) return false;
      try {
        res.write(text);
        return true;
      } catch {
        clientGone = true;
        return false;
      }
    };

    /** 处理解析出的负载；返回 false 表示应停止读流。 */
    const handlePayload = (payload) => {
      const frame = parseQwenWorkFrame(payload);
      if (frame.kind === 'skip') return true;
      if (frame.kind === 'error') {
        // 上游在流中途报告错误：以 OpenAI 的 error 帧表达。
        //
        // ⚠️ 置 `errored`，收尾时**不得**再补 `finish_reason`，只补 `[DONE]`
        // 终止读取。否则下游会把「错误」误读成「正常结束但内容为空」，
        // 真实原因被 EMPTY_RESPONSE 之类的通用错误覆盖。
        //
        // 上游把错误放在 HTTP 200 的 SSE 流内，协议层没有状态码；同时它还会
        // 用业务码表达语义（10605 排队、配额码、请求码……）。这里统一交给
        // classifyUpstreamFailure 翻译成状态 + code，再按 `HTTP <code>: ...`
        // 下发给 pi-ai——pi-ai 只能从文案里识别状态码，不翻译就会落到
        // PI_AI_ERROR，DSH 不会重试。
        const failure = classifyUpstreamFailure(frame.error);
        const message = formatFailureMessage(failure);
        trace('upstream-error-frame', {
          code: failure.code,
          status: failure.status,
          retryAfter: failure.retryAfter ?? null,
        });
        write(
          `data: ${JSON.stringify({
            error: { message, type: errorTypeFor(failure), code: failure.code },
          })}\n\n`,
        );
        errored = true;
        return false;
      }
      // 上游把 token 统计放在末帧的 raw_usage 里，且常与 finish_reason 帧分离。
      // 先记下来，收尾时随最后一个 chunk 下发（OpenAI 的用法）。
      if (frame.rawUsage !== undefined) {
        usage = parseRawUsage(frame.rawUsage);
      }
      if (frame.delta !== undefined && Object.keys(frame.delta).length > 0) {
        // 性能采样：只对**正文**计时（思考链长度会让速率虚高；纯思考
        // 而无正文的请求不应计入——那会得到"首 token 很早但速率极低"的假象）。
        if (typeof frame.delta.content === 'string' && frame.delta.content !== '') {
          if (firstContentAt === null) {
            firstContentAt = Date.now();
            trace('first-content', { ms: firstContentAt - reqT0 });
          }
          outputChars += frame.delta.content.length;
        }
        if (typeof frame.delta.reasoning === 'string' && frame.delta.reasoning !== '') {
          thinkingChars += frame.delta.reasoning.length;
        }
        if (Array.isArray(frame.delta.tool_calls) && frame.delta.tool_calls.length > 0) {
          toolCallsEmitted = true;
        }
        write(encodeOpenAiChunk({ model: modelKey, id: chunkId, created, delta: frame.delta }));
      }
      if (frame.finishReason !== null && frame.finishReason !== undefined) {
        // 上游常把「带工具调用」的回合标成 stop。下游（pi-ai / DSH）靠
        // finish_reason 判断要不要继续跑工具，标成 stop 就等于告诉它「本轮结束了」，
        // agent 循环于是停在工具调用前面——表现为「模型不动了」。
        let reason = frame.finishReason;
        if (toolCallsEmitted && (reason === 'stop' || reason === 'end')) reason = 'tool_calls';
        // 只思考不回答（reasoning 一大堆、正文和工具调用都没有）：这是一次
        // 空回合。报成 stop 会让下游拿到一条空 assistant 消息就收工；
        // 报错才能让它重试——实测过 340 秒思考、9.5 万字符思考链、0 正文。
        if (!toolCallsEmitted && outputChars === 0) {
          trace('empty-answer', { ms: Date.now() - reqT0, thinkingChars });
          write(
            `data: ${JSON.stringify({
              error: {
                message: `upstream finished without any answer (thinking ${thinkingChars} chars, no content, no tool calls)`,
                type: 'empty_answer',
              },
            })}\n\n`,
          );
          reason = 'network_error';
        }
        write(
          encodeOpenAiChunk({
            model: modelKey,
            id: chunkId,
            created,
            finishReason: reason,
            usage,
          }),
        );
        finished = true;
        // 已带 usage 时无需再补一帧；否则继续读，等可能的 raw_usage 帧。
        return usage === null;
      }
      return true;
    };

    const idleTimer = { current: null };
    let idleFired = false;
    /**
     * 看门狗。deadlineMs 决定这一轮允许静默多久：
     *   - 首帧之前用 FIRST_CONTENT_TIMEOUT_MS（90s）：拿到 200 却久久没有任何帧，
     *     是上游「接了单没排上」的排队态，干等 300 秒只是把失败拉长；
     *   - 首帧之后用 idleTimeoutMs（300s）：长思考时上游仍在持续推 reasoning 帧。
     * 这个常量此前只有声明和注释、未被任何代码使用，等于首帧预算形同虚设。
     */
    const armIdle = (deadlineMs = idleTimeoutMs) => {
      clearTimeout(idleTimer.current);
      const dueAt = performance.now() + deadlineMs;
      idleTimer.current = setTimeout(() => {
        // ⚠️ 关键：必须**先给客户端一个明确结果**，再收摊。
        // 只设 clientGone 会让后续所有 write 被跳过，客户端一个字节都收不到
        // → 界面永久转圈（表现为"卡住"，比报错更难排查）。
        idleFired = true;
        trace('idle-watchdog-fired', {
          ms: Date.now() - reqT0,
          deadlineMs,
          watchdogDelayMs: Math.max(0, performance.now() - dueAt),
          ...streamDiagnostics(),
        });
        if (!res.writableEnded) {
          try {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  // DSH pi-ai 按错误消息识别 TIMEOUT，由宿主策略控制重试。
                  message: `upstream idle timeout: no data for ${deadlineMs}ms`,
                  type: 'api_error',
                },
              })}\n\n`,
            );
            res.write(SSE_DONE);
          } catch {
            /* 客户端已断开 */
          }
        }
        clientGone = true;
        // ⚠️ 用 AbortController 中断读取，**不要**调 `upstream.body.cancel()`：
        // 此刻 `for await (const chunk of upstream.body)` 正在读取该流，
        // ReadableStream 已被锁定，`cancel()` 会抛
        // `ERR_INVALID_STATE: ReadableStream is locked`。该异常在定时器回调里
        // 抛出，**不会被外层的 try/catch 捕获**（不在同一调用栈），
        // 会冒成 uncaughtException。
        try {
          upstreamAbort.abort('upstream idle timeout');
        } catch {
          /* 已中止 */
        }
      }, deadlineMs);
    };

    try {
      eventLoopDelay.enable();
      // 首帧预算更紧：排队态的 200 会先到、随后长时间零字节。
      armIdle(FIRST_CONTENT_TIMEOUT_MS);
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of upstream.body) {
        if (clientGone) break;
        lastChunkAt = Date.now();
        upstreamChunks += 1;
        upstreamBytes += chunk.byteLength;
        armIdle();
        if (upstreamChunks === 1) {
          trace('first-upstream-chunk', { ms: lastChunkAt - reqT0, bytes: chunk.byteLength });
        }
        const payloads = parser.push(decoder.decode(chunk, { stream: true }));
        let keepGoing = true;
        for (const payload of payloads) {
          if (!handlePayload(payload)) {
            keepGoing = false;
            break;
          }
        }
        if (!keepGoing) break;
      }

      if (!clientGone && !parser.done) {
        for (const payload of parser.flush()) {
          if (!handlePayload(payload)) break;
        }
      }

      // 收尾：无论上游是否给了 finish_reason，都要给下游一个明确的结束帧，
      // 否则 pi-ai 会一直等下去（"挂起"）。
      //
      // 例外一：上游已在流内报错（errored）——**不得**补正常收尾帧，否则下游
      //   会把「错误」误读成「正常结束但无内容」，真实原因被 EMPTY_RESPONSE
      //   之类的通用错误覆盖。只补一个 [DONE] 终止读取。
      // 例外二：看门狗已触发（idleFired）——它已经写过错误帧 + [DONE]，
      //   此处 `clientGone` 为 true 因而整体跳过，不会再补正常帧。
      if (!clientGone) {
        if (errored) {
          write(SSE_DONE);
        } else {
          if (!finished) {
            // ⚠️ 上游没给 finish 帧就结束了：这是**被截断**的回合，不是正常收尾。
            // 补一个 `stop` 会让下游把「被切断的回答」当成「模型自己讲完了」，
            // agent 循环就此静默终止——用户看到的正是「模型突然不动了」。
            //   有产出(正文/工具调用) → `length`：客户端知道被截断，可续写/重试
            //   毫无产出(只有思考)     → 错误帧 + `network_error`：让下游重试整轮
            // 两种情况都必须给下游一个明确的结束信号，不能挂起。
            if (outputChars > 0 || toolCallsEmitted) {
              trace('truncated', { ms: Date.now() - reqT0, outputChars, thinkingChars });
              write(
                encodeOpenAiChunk({
                  model: modelKey,
                  id: chunkId,
                  created,
                  finishReason: 'length',
                  usage,
                }),
              );
            } else {
              trace('empty-answer', { ms: Date.now() - reqT0, thinkingChars });
              write(
                `data: ${JSON.stringify({
                  error: {
                    message: `upstream ended without any answer (thinking ${thinkingChars} chars, no content, no tool calls)`,
                    type: 'empty_answer',
                  },
                })}\n\n`,
              );
              write(
                encodeOpenAiChunk({
                  model: modelKey,
                  id: chunkId,
                  created,
                  finishReason: 'network_error',
                  usage,
                }),
              );
            }
          } else if (usage !== null) {
            // finish 帧已经发过、usage 是随后才到的：补一帧只带 usage 的分块。
            // OpenAI 的约定是 usage 出现在最后一个 chunk 上（choices 可为空）。
            write(
              `data: ${JSON.stringify({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: modelKey,
                choices: [],
                usage,
              })}\n\n`,
            );
          }
          write(SSE_DONE);
        }
      }
    } catch (error) {
      // 网络中断：不让异常穿透出去炸掉插件，给下游一个错误帧即止
      log.warn?.('dsh-qwenwork-connect: upstream stream interrupted', safeMessage(error));
      if (!clientGone) {
        write(`data: ${JSON.stringify({ error: { message: safeMessage(error), type: 'api_error' } })}\n\n`);
        // ⚠️ 断流也要给 finish 帧。只发错误帧 + [DONE] 时，有的下游会把「没有
        // finish_reason」当成「流异常结束但内容正常」，有的则报 EMPTY_RESPONSE；
        // 已产出内容就说 length（被截断），一个字节都没出就说 network_error。
        write(
          encodeOpenAiChunk({
            model: modelKey,
            id: chunkId,
            created,
            finishReason: outputChars > 0 || toolCallsEmitted ? 'length' : 'network_error',
            usage,
          }),
        );
        write(SSE_DONE);
      }
    } finally {
      clearTimeout(idleTimer.current);
      eventLoopDelay.disable();
      trace('stream-end', {
        ms: Date.now() - reqT0,
        clientGone,
        errored,
        finished,
        idleFired,
        abortReason: upstreamAbort.signal.aborted ? safeMessage(upstreamAbort.signal.reason) : null,
        ...streamDiagnostics(),
      });
      // 性能采样：只在「有正文且未出错」时记录——失败请求与纯思考无正文的
      // 请求会污染速率统计（分母极小或为 0）。recordSample 内部还会再校验。
      if (firstContentAt !== null && !errored) {
        const endedAt = Date.now();
        const genMs = endedAt - firstContentAt;
        recordSample({
          ttftMs: firstContentAt - startedAt,
          charsPerSec: genMs > 0 ? (outputChars / genMs) * 1000 : 0,
          totalMs: endedAt - startedAt,
          outputChars,
        });
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* 已关闭 */
        }
      }
    }
  };
}

/** 读取请求体，带大小上限。 */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const parts = [];
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // 不用 req.destroy()：它连 socket 一起拆，413 根本发不出去，调用方
        // 只能拿到一个无信息的连接错误（旧行为）。这里只释已缓存的体，
        // 响应写完后 Node 会自动断开未读完的请求。
        parts.length = 0;
        finish(reject, new Error('request body too large'));
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(parts).toString('utf8')));
    req.on('error', (error) => finish(reject, error));
    // 客户端写完一半就挂断：既不 end 也不 error。旧版本这里悬挂到进程结束，
    // 每次只留下一个 `request-in`（就是 33 条孤儿记录里那类），
    // 现在明确报错，让处理器能记下终止原因并释放 await。
    req.on('close', () => finish(reject, new Error('request body was not delivered (client closed)')));
  });
}

/** OpenAI 错误类型：只影响下游展示，重试判断仍看 message 里的状态码。 */
function errorTypeFor(failure) {
  if (failure.code === 'AUTH') return 'authentication_error';
  if (failure.code === 'QUOTA_EXCEEDED') return 'insufficient_quota';
  if (failure.status === 429) return 'rate_limit_error';
  return 'api_error';
}

/** 以 OpenAI 错误信封返回。 */
function jsonError(res, status, message, type) {
  if (res.writableEnded) return;
  const payload = JSON.stringify({ error: { message, type } });
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  } catch {
    /* 连接已断 */
  }
}

/**
 * 启动 shim 服务器，监听 `127.0.0.1` 的随机端口。
 *
 * @param {Parameters<typeof createChatShimHandler>[0]} deps
 * @returns {Promise<{ baseUrl: string, port: number, close: () => Promise<void> }>}
 */
export function startChatShim(deps) {
  // 共享密钥在启动时生成一次；handler 用它做进程级鉴别，
  // 返回对象把它暴露给调用方（经 resolveApiKey 喂回 pi-ai）。
  const sharedSecret = deps.sharedSecret ?? generateSharedSecret();
  const handler = createChatShimHandler({ ...deps, sharedSecret });
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith(CHAT_COMPLETIONS_PATH)) {
      jsonError(res, 404, 'not found', 'invalid_request_error');
      return;
    }
    handler(req, res).catch(() => {
      jsonError(res, 500, 'internal error', 'api_error');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        // baseUrl 含 CHAT_COMPLETIONS_PATH 路径：历史形态，所有直接 fetch
        // shim.baseUrl 的测试与探针都依赖它。pi-ai 的 OpenAI SDK 会在其后
        // 再拼一次 /chat/completions（trace 实测
        // `/v1/chat/completions/chat/completions`），shim 的 startsWith
        // 路由会放行——虽然不优雅，但它是**实测可工作**的形态。
        // ⚠️ 修改此形状前先跑通全部测试；曾因改成 origin 形式引发回归。
        baseUrl: `http://127.0.0.1:${port}${CHAT_COMPLETIONS_PATH}`,
        port,
        // 供 pi-ai 的 resolveApiKey 使用；只应经进程内接线传递，绝不下发。
        sharedSecret,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
