/**
 * 上游错误分类：把 HTTP 状态、业务码、排队信息归一成下游可理解的语义。
 *
 * 背景：千问办公把很多错误塞在 HTTP 200 的 SSE 帧里（例如 `code: "10605"`
 * 表示排队），pi-ai 只按错误文案里的状态码分类。若不把这些业务码翻译成
 * 明确的 HTTP 语义，pi-ai 会落到 `PI_AI_ERROR`，DSH 不重试——多轮 agent
 * 跑到一半撞上模型池忙，整轮就停在这里。
 *
 * 本模块只做**分类**，不做重试、不做降级：分类结果交给调用方决定
 * （pre-stream 用 HTTP 状态，in-band 用 `HTTP <code>: <message>` 文案）。
 *
 * @module dsh-qwenwork-connect/upstream-errors
 */

/** 上游「排队」业务码。 */
const QUEUED_CODE = '10605';

/** 配额/额度类业务码。 */
const QUOTA_CODES = new Set([
  '110', '112', '113', '114', '115', '116', '117', '118', '119', '122',
]);

/** 请求非法类业务码。 */
const REQUEST_CODES = new Set([
  '406', '416', '430', '80411', '80412', '100400', '100401', '100403',
]);

const ALL_MODELS_FAILED_RE = /all models failed/i;
const UPSTREAM_FAILED_RE = /error in upstream response/i;
const QUOTA_TEXT_RE = /quota|credits?|usage limit|insufficient (?:balance|quota|credits?)|out of credits?|exceeded.*(?:quota|limit)|余额不足|额度/i;

/** 上游未给出等待时间时的默认值（秒）。 */
const DEFAULT_BUSY_WAIT = 30;

/**
 * 解析上游错误原文（可能是 JSON，也可能是纯文本）。
 *
 * 处理上游的两种嵌套：`message` 字段里再塞一层 JSON；以及 `details.error.message`。
 *
 * @param {unknown} text
 * @returns {{ status?: number, code?: string, message?: string, queue?: object }}
 */
export function parseUpstreamFailureText(text) {
  if (isObject(text)) return fromParsed(text);
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return {};
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 400) };
  }
  if (!isObject(json)) return { message: raw.slice(0, 400) };
  return fromParsed(json);
}

/** 已解析后的 JSON 对象 → 归一字段。 */
function fromParsed(json) {

  const status = toStatus(json.statusCodeValue ?? json.statusCode);
  let code = json.code === undefined || json.code === null ? '' : String(json.code);
  let message = typeof json.message === 'string' ? json.message : '';
  let queue = isObject(json.queue) ? json.queue : undefined;

  if (json.details !== undefined) {
    const details = typeof json.details === 'string' ? tryParse(json.details) : json.details;
    const detailMessage = isObject(details) && isObject(details.error) ? details.error.message : undefined;
    if (typeof detailMessage === 'string' && detailMessage !== '') {
      message = message === '' ? detailMessage : `${message}: ${detailMessage}`;
    }
  }

  // 401/403 外壳里再包一层 JSON（上游真实形态之一）。
  const nested = tryParse(message);
  if (isObject(nested)) {
    if (['', '401', '403'].includes(code) && nested.code !== undefined) {
      code = String(nested.code);
    }
    if (typeof nested.message === 'string' && nested.message !== '') message = nested.message;
    if (queue === undefined && isObject(nested.queue)) queue = nested.queue;
    if (queue === undefined && hasQueueFields(nested)) queue = nested;
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(code === '' ? {} : { code }),
    ...(message === '' ? {} : { message }),
    ...(queue === undefined ? {} : { queue }),
  };
}

/**
 * 把一次上游失败归一成 `{ status, code, message, retryAfter? }`。
 *
 * @param {{ status?: number, code?: string, message?: string, queue?: object }} [input]
 * @returns {{ status: number, code: string, message: string, retryAfter?: number }}
 */
export function classifyUpstreamFailure(input = {}) {
  const status = toStatus(input.status);
  const code = input.code === undefined || input.code === null ? '' : String(input.code);
  const message =
    typeof input.message === 'string' && input.message.trim() !== ''
      ? input.message.trim()
      : status === undefined
        ? 'upstream error'
        : `HTTP ${status}`;
  const queue = isObject(input.queue) ? input.queue : undefined;

  if (code === QUEUED_CODE || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const wait = retryAfterOf(queue);
    const label = queue?.isQueued === true ? '已排队' : '正忙';
    return {
      status: 503,
      code: 'QUEUED',
      message: `千问办公${label}（queued），约 ${wait} 秒后重试：${message}`,
      retryAfter: wait,
    };
  }

  if (QUOTA_CODES.has(code)) {
    return {
      status: 429,
      code: 'QUOTA_EXCEEDED',
      message: `用量已用完（insufficient quota）：${message}`,
    };
  }

  if (REQUEST_CODES.has(code)) {
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message: `千问办公拒绝了这次请求（${code}）：${message}`,
    };
  }

  if (UPSTREAM_FAILED_RE.test(message)) {
    return { status: 502, code: 'SERVER', message: `上游服务错误（HTTP 502）：${message}` };
  }

  if (ALL_MODELS_FAILED_RE.test(message)) {
    return {
      status: 503,
      code: 'MODEL_POOL_BUSY',
      message: `千问办公模型池暂时不可用（model pool busy），约 ${DEFAULT_BUSY_WAIT} 秒后重试：${message}`,
      retryAfter: DEFAULT_BUSY_WAIT,
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 401,
      code: 'AUTH',
      message: `登录已失效，请重新登录（上游 ${status}：${message}）`,
    };
  }

  if (QUOTA_TEXT_RE.test(message)) {
    return {
      status: 429,
      code: 'QUOTA_EXCEEDED',
      message: `用量已用完（insufficient quota）：${message}`,
    };
  }

  if (status === 429) {
    return {
      status: 429,
      code: 'MODEL_POOL_BUSY',
      message: `上游限流（rate limit），约 ${DEFAULT_BUSY_WAIT} 秒后重试：${message}`,
      retryAfter: DEFAULT_BUSY_WAIT,
    };
  }

  if (status !== undefined && status >= 500) {
    return { status, code: 'SERVER', message };
  }

  if (status === 400) {
    return { status: 400, code: 'INVALID_REQUEST', message };
  }

  return {
    status: status ?? 502,
    code: status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
    message,
  };
}

/**
 * 给 in-band 错误帧用：pi-ai 只能从文案里认状态码，所以必须带 `HTTP <code>:`。
 * @param {{ status: number, message: string }} failure
 */
export function formatFailureMessage(failure) {
  const text = String(failure?.message ?? '');
  return text.startsWith('HTTP ') ? text : `HTTP ${failure.status}: ${text}`;
}

function retryAfterOf(queue) {
  const value = Number(queue?.retryAfterSeconds);
  if (Number.isFinite(value) && value > 0) return Math.ceil(value);
  return DEFAULT_BUSY_WAIT;
}

function hasQueueFields(value) {
  return isObject(value)
    && ('isQueued' in value || 'serviceAvailable' in value || 'retryAfterSeconds' in value);
}

function toStatus(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function tryParse(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
