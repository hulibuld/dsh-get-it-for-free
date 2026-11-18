#!/usr/bin/env node
/**
 * probe-convert.mjs — 直接打上游，验证「HTTP 400 Failed to convert request」的
 * **最小触发组合**，以及 `toQwenWorkMessages` 的降级是否把坑填上。
 *
 * 背景（t4）：
 *   用户在 DSH 里选「千问办公」渠道发消息，拿回 `HTTP 400: Failed to convert request`。
 *   这句话不存在于本仓库任何文件里 —— 它是 gateway.qwenwork.cn 的响应文本，
 *   由 src/qwenwork/chat-shim.js 的 classifyUpstreamFailure/formatFailureMessage
 *   原样透传成 `HTTP 400: …`。也就是说：**我们 POST 给上游的 body，上游转换不了**。
 *
 * 用法（不依赖插件宿主，能单独跑）：
 *
 *   node scripts/probe-convert.mjs                 # 全部用例，走 toQwenWorkMessages（生产路径）
 *   node scripts/probe-convert.mjs tool-args       # 只跑名字含 "tool-args" 的用例
 *   node scripts/probe-convert.mjs --raw           # 绕过 toQwenWorkMessages，直接把原始
 *                                                  # messages 送上游（用来复现修复前的 400）
 *   node scripts/probe-convert.mjs --json          # 额外把每个用例的请求体打成单行 JSON
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 用例过滤为空；3 = 凭据/会话异常。
 *
 * ── 复现用例（t4 实测结论，改代码前先看这段）──────────────────────────────
 *   ❌ 不是触发点（这些组合单独都 200，已用本探针逐个确认）：
 *      · messages 里出现 `role:"tool"` / `assistant.tool_calls`（tool-history-valid）
 *      · tools 的 parameters 带 $schema / additionalProperties / oneOf / format /
 *        default / strict / x-order（tools-full-schema）
 *      · 多模态 content 数组（multimodal —— 探针只有 1x1 占位图，上游图片管线会回
 *        `400 Image preprocessing failed`，那是图片本身不行、请求转换已经过了，
 *        因此该用例按 [N/A] 记，不算失败）
 *      · 目录外/未声明的 model key（model-unknown）
 *      · tool_call 带私有字段 index / extra_content（tool-call-extra-fields）
 *
 *   ✅ 最小触发条件（`tool-args-concat-qwen4max`，唯一复现出来的 400）：
 *      ① model key 走 **qwen4-max** 这条路径（`pro` 对同样的坏数据宽容，见
 *         `tool-args-concat-pro` 对照组）；
 *      ② `assistant.tool_calls[*].function.arguments` **不是合法 JSON**。
 *      最省的复现数据：4 条消息（user / assistant+tool_calls / role:tool / user）
 *      + 1 个 tool，arguments 用 `'{"path":"/etc/hosts"}{"mode":"text"}'`
 *      （两个 JSON 对象首尾相接）即可 —— 不需要 194 个 tools、不需要中文、
 *      与 tool 名和 tool_call id 都无关（8 格交叉矩阵实测一致）。
 *      上游转换器对 arguments 做 JSON.parse，解析失败 → 整个请求
 *      `400 INVALID_REQUEST / "Failed to convert request"`（首帧即错，不上模型）。
 *
 *   ⚠️ 判定坑：这个 400 **不是 HTTP 状态码**，而是 HTTP 200 里 SSE 的首帧错误：
 *      `data:{"headers":{…},"body":"{\"code\":\"400\",\"message\":\"Failed to convert request\"}",
 *        "statusCodeValue":400,"statusCode":"Bad Request"}`
 *      所以只看 `response.status` 会把失败当成功（早期版本正是这样误报 10/10 PASS）。
 *      下面 `looksLikeConvertError()` 同时扫响应体，这是本探针的判定核心。
 *
 *   为什么后果是「永久坏掉」：那条坏 assistant 消息一旦落进会话历史，
 *   之后每一轮请求都会重新带上它，于是**每一次**都 400，重试也没用。
 *   证据见 ~/.dsh/sessions/…/session-ffec19b3…/session.v4.jsonl.zstd 的
 *   `tool/call` 事件（turn 2 step 1，callId toolu_431e5147f6b84cb6849f9449，
 *   arguments 里两个 JSON 对象首尾相接），其后 turn 2 step 2 起全部
 *   `HTTP 400: Failed to convert request`。
 *
 *   修法（chat-shim.js 的 `toQwenWorkMessages` → `sanitizeToolCalls`）：
 *   降级而不是丢弃 —— 拆出第一个合法 JSON 对象作为 arguments，剩余片段与
 *   无法解析的原文以 `[tool: name ← …]` 文本形式并进该条 assistant 的 content，
 *   并 trace('convert-degrade') 记账。默认模式下本探针走这条路径；加 `--raw`
 *   就能看到同样数据在修复前的原始行为（400）。
 *
 * 凭据：读 `~/.dsh/qwenwork-desktop.json`（device-flow 落的那份，含 token +
 * loginDeviceId），只读不刷新、不回写 —— 探针不该动用户的登录态。
 * 可用 `QWENWORK_CREDENTIAL=/path/to/cred.json` 覆盖。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildInferBody, createSignerSession } from '../src/qwenwork/signer-session.js';
import { toQwenWorkMessages } from '../src/qwenwork/chat-shim.js';

const CREDENTIAL_PATH = process.env.QWENWORK_CREDENTIAL
  ?? path.join(os.homedir(), '.dsh', 'qwenwork-desktop.json');

/** 单次上游请求的观察上限：拿到响应头后最多看这么久/这么多字节就断开。 */
const READ_BUDGET_MS = 20_000;
const READ_BUDGET_BYTES = 4000;

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const rawMode = argv.includes('--raw');
const filter = argv.find((a) => !a.startsWith('-')) ?? '';

/** 1x1 透明 PNG，用来构造最小多模态数组。 */
const TINY_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/6Bb4AAAAAElFTkSuQmCC';

function readCredential() {
  let text;
  try {
    text = fs.readFileSync(CREDENTIAL_PATH, 'utf8');
  } catch (error) {
    throw new Error(`读不到凭据 ${CREDENTIAL_PATH}：${error?.message ?? error}`);
  }
  const raw = JSON.parse(text);
  if (typeof raw?.token !== 'string' || raw.token === '') {
    throw new Error(`凭据缺 token：${CREDENTIAL_PATH}`);
  }
  return raw;
}

/**
 * 判定响应体里是否藏着「转换失败」。
 *
 * 上游把上游侧错误包成 HTTP 200 的双层信封 SSE，首帧 `body` 字段里才是真
 * 错误码。命中任意一条都算失败 —— 只看 HTTP 状态码是不够的。
 *
 * @param {string} text
 * @returns {string | null} 命中的原因，未命中返回 null
 */
function looksLikeConvertError(text) {
  if (text === '') return null;
  if (/Failed to convert/i.test(text)) return 'Failed to convert request';
  if (/"code"\s*:\s*\\?"?400/.test(text)) return 'envelope code=400';
  if (/"statusCodeValue"\s*:\s*400/.test(text)) return 'envelope statusCodeValue=400';
  return null;
}

/** 一个带「上游可能不认识的 JSON-Schema 关键字」的工具定义（DSH 实际会发这种）。 */
function fullSchemaTool() {
  return {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读一个文件',
      parameters: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径', format: 'uri-reference' },
          mode: { type: 'string', enum: ['text', 'bytes'], default: 'text' },
          range: {
            oneOf: [
              { type: 'object', properties: { start: { type: 'number' } }, required: ['start'] },
              { type: 'null' },
            ],
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };
}

/** 只带最小关键字、没有任何 $schema/additionalProperties 的工具定义（对照组）。 */
function bareSchemaTool() {
  return {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读一个文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
      },
    },
  };
}

/** 带 strict 与非标准 x- 关键字的工具定义（探针里用来确认上游是否挑剔）。 */
function strictSchemaTool() {
  return {
    type: 'function',
    function: {
      name: 'bash',
      description: '跑一条命令',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', 'x-order': 1 },
          timeout: { type: 'integer', minimum: 1, maximum: 600 },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  };
}

const US = { role: 'user', content: '只回答一个数字：1+1 等于几？' };
const GOOD_ARGS = '{"path":"/etc/hosts"}';

/** 真实事故里那条坏 arguments：两个 JSON 对象首尾相接（模型把两次调用挤进一个 call）。 */
const CONCAT_ARGS = '{"path":"/etc/hosts"}{"mode":"text"}';

/** assistant 带一条 tool_call 的最小历史，arguments 由调用方决定。 */
function toolHistory(argumentsValue, extra = {}) {
  return [
    US,
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: argumentsValue },
        ...extra,
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '127.0.0.1 localhost' },
    { role: 'user', content: '刚才那个文件第一行是什么？' },
  ];
}

/**
 * 用例表：每项独立构造 messages / tools / modelKey，互不依赖。
 *
 * 「最小复现」= `tool-args-concat-qwen4max`。想验证修复前行为：
 *   node scripts/probe-convert.mjs tool-args-concat-qwen4max --raw   # 期望 FAIL(400)
 *   node scripts/probe-convert.mjs tool-args-concat-qwen4max         # 期望 PASS
 */
const CASES = [
  {
    name: 'min-text',
    note: '最小 body：一条 user 文本 + tools:[]（model=pro）',
    build: () => ({ messages: [US], tools: [], modelKey: 'pro' }),
  },
  {
    name: 'min-text-qwen4max',
    note: '同上，model=qwen4-max（事故模型基线）',
    build: () => ({ messages: [US], tools: [], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tools-full-schema',
    note: 'tools 带 $schema + additionalProperties + oneOf + format + default',
    build: () => ({ messages: [US], tools: [fullSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tools-strict',
    note: 'tools 带 strict:true + x-order + minimum/maximum',
    build: () => ({ messages: [US], tools: [strictSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tool-history-valid',
    note: 'assistant.tool_calls + role:tool 结果，arguments 合法',
    build: () => ({ messages: toolHistory(GOOD_ARGS), tools: [bareSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tool-args-concat-qwen4max',
    note: '★最小复现：arguments = 两个 JSON 对象首尾相接 + model=qwen4-max',
    build: () => ({ messages: toolHistory(CONCAT_ARGS), tools: [bareSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tool-args-concat-real',
    note: '★最小复现（真实事故原文，270 字 arguments）',
    build: () => ({
      messages: toolHistory(
        '{"file_path": "LifeCard/交接-给下一个AI.md"}'
        + '{"command": "ls ~/.dsh | head -50; echo ---; ls /Users/joyfon620 | head -40",'
        + ' "description": "List home"}',
      ),
      tools: [bareSchemaTool()],
      modelKey: 'qwen4-max',
    }),
  },
  {
    name: 'tool-args-concat-pro',
    note: '对照组：同样的坏 arguments，但 model=pro（宽容，修复前后都应 PASS）',
    build: () => ({ messages: toolHistory(CONCAT_ARGS), tools: [bareSchemaTool()], modelKey: 'pro' }),
  },
  {
    name: 'tool-args-notjson',
    note: 'arguments 完全不是 JSON（裸命令行）',
    build: () => ({ messages: toolHistory('ls -la /etc'), tools: [bareSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tool-args-empty',
    note: 'arguments 是空串',
    build: () => ({ messages: toolHistory(''), tools: [bareSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tool-args-object',
    note: 'arguments 是对象而不是字符串',
    build: () => ({ messages: toolHistory({ path: '/etc/hosts' }), tools: [bareSchemaTool()], modelKey: 'qwen4-max' }),
  },
  {
    name: 'tool-call-extra-fields',
    note: 'tool_call 带非标准字段 index / extra_content（arguments 合法）',
    build: () => ({
      messages: toolHistory(GOOD_ARGS, { index: 0, extra_content: { google: { thought_signature: 'x' } } }),
      tools: [bareSchemaTool()],
      modelKey: 'qwen4-max',
    }),
  },
  {
    name: 'tool-no-id',
    note: 'tool_call 无 id，tool 结果无 tool_call_id',
    build: () => ({
      messages: [
        US,
        { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: GOOD_ARGS } }] },
        { role: 'tool', name: 'read_file', content: '127.0.0.1 localhost' },
        { role: 'user', content: '继续' },
      ],
      tools: [bareSchemaTool()],
      modelKey: 'qwen4-max',
    }),
  },
  {
    name: 'tool-result-array',
    note: 'role:tool 的 content 是数组',
    build: () => ({
      messages: [
        US,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: GOOD_ARGS } }],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: '继续' },
      ],
      tools: [bareSchemaTool()],
      modelKey: 'qwen4-max',
    }),
  },
  {
    name: 'tool-msg-only',
    note: '只有 role:tool（无 assistant.tool_calls）',
    build: () => ({
      messages: [
        US,
        { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'x' },
        { role: 'user', content: '继续' },
      ],
      tools: [],
      modelKey: 'qwen4-max',
    }),
  },
  {
    name: 'assistant-toolcalls-only',
    note: '只有 assistant.tool_calls（无 tool 结果）',
    build: () => ({
      messages: [
        US,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: GOOD_ARGS } }],
        },
        { role: 'user', content: '继续' },
      ],
      tools: [bareSchemaTool()],
      modelKey: 'qwen4-max',
    }),
  },
  {
    name: 'multimodal',
    note: 'user content 是数组（text + image_url data URL）',
    // 探针里只能用 1x1 的占位图，上游图片管线会回 `400 Image preprocessing failed`
    // ——那是**图片本身**不行，不是请求转换失败（转换已经过了才会走到图片预处理）。
    // 所以这条只用来确认「多模态数组不触发 convert-400」，图片错误按 N/A 记。
    knownFixtureIssue: 'Image preprocessing failed',
    build: () => ({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里有什么？' },
          { type: 'image_url', image_url: { url: TINY_PNG } },
        ],
      }],
      tools: [],
      modelKey: 'pro',
      imageUrls: [TINY_PNG],
    }),
  },
  {
    name: 'model-unknown',
    note: 'modelKey 不在静态目录里（原样透传路径）',
    build: () => ({ messages: [US], tools: [], modelKey: 'qwen3.8-flash' }),
  },
  {
    name: 'no-reasoning',
    note: 'is_vl=false / is_reasoning=false',
    build: () => ({ messages: [US], tools: [], modelKey: 'pro', isVl: false, isReasoning: false }),
  },
];

/** 读响应，最多 READ_BUDGET_BYTES / READ_BUDGET_MS，然后强行断开。 */
async function readLimited(response) {
  const chunks = [];
  let bytes = 0;
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), READ_BUDGET_MS);
  try {
    if (response.body === null) return '';
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of response.body) {
      chunks.push(decoder.decode(chunk, { stream: true }));
      bytes += chunk.byteLength;
      if (bytes >= READ_BUDGET_BYTES) break;
      if (Date.now() - started > READ_BUDGET_MS) break;
    }
  } catch {
    /* 主动断开 / 上游断流都算读到了这里为止 */
  } finally {
    clearTimeout(timer);
  }
  return chunks.join('');
}

async function runCase(session, item) {
  const params = item.build();
  /** @type {Array<Record<string, any>>} */
  const degrades = [];
  // 默认走生产路径：原始 OpenAI body → toQwenWorkMessages（含 sanitizeToolCalls）。
  const messages = rawMode
    ? params.messages
    : toQwenWorkMessages({ messages: params.messages, tools: params.tools }, { onDegrade: (info) => degrades.push(info) });

  const bodyJson = buildInferBody({
    messages,
    modelKey: params.modelKey,
    sessionId: `probe-convert-${item.name}`,
    tools: params.tools,
    isVl: params.isVl === true,
    isReasoning: params.isReasoning === true,
    imageUrls: params.imageUrls ?? [],
  });
  const signed = session.signInferRequest(bodyJson, {
    modelKey: params.modelKey,
    modelSource: 'system',
  });

  let status = 0;
  let text = '';
  let error = null;
  const t0 = Date.now();
  try {
    const response = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: AbortSignal.timeout(READ_BUDGET_MS + 20_000),
    });
    status = response.status;
    text = await readLimited(response);
  } catch (err) {
    error = err?.message ?? String(err);
  }

  const embedded = looksLikeConvertError(text);
  const fixtureIssue = typeof item.knownFixtureIssue === 'string' && text.includes(item.knownFixtureIssue)
    ? item.knownFixtureIssue
    : null;
  return {
    case: item.name,
    note: item.note,
    status,
    ok: error === null && status === 200 && (embedded === null || fixtureIssue !== null),
    embedded,
    fixtureIssue,
    ms: Date.now() - t0,
    error,
    degrades,
    // 上游原文（不脱敏、不裁语义）—— 400 的判定依据就在这段文本里
    upstream: text.slice(0, 1200),
    ...(wantJson ? { requestBody: bodyJson } : {}),
  };
}

async function main() {
  const credential = readCredential();
  const session = await createSignerSession({ credential });

  const cases = CASES.filter((c) => filter === '' || c.name.includes(filter));
  if (cases.length === 0) {
    console.error(`没有匹配 "${filter}" 的用例。可用：${CASES.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }

  console.log(`凭据 ${CREDENTIAL_PATH}`);
  console.log(`端点 ${session.endpoint}  cosy=${session.cosyVersion ?? '?'}`);
  console.log(`模式 ${rawMode ? 'raw（绕过 toQwenWorkMessages，修复前行为）' : 'shim（走 toQwenWorkMessages 降级）'}`);
  console.log('');

  let bad = 0;
  for (const item of cases) {
    const result = await runCase(session, item);
    if (!result.ok) bad += 1;
    const flag = result.ok ? (result.fixtureIssue === null ? 'PASS' : 'N/A ') : 'FAIL';
    const detail = result.embedded === null ? '' : `  内嵌错误：${result.embedded}`;
    console.log(`[${flag}] ${result.case.padEnd(26)} HTTP ${result.status} ${result.ms}ms${detail} — ${result.note}`);
    if (result.fixtureIssue !== null) {
      console.log(`        已知夹具限制：上游回 "${result.fixtureIssue}"（图片占位图问题，非请求转换失败）`);
    }
    if (result.error !== null) console.log(`        网络错误：${result.error}`);
    if (result.degrades.length > 0) {
      for (const d of result.degrades) console.log(`        降级：${JSON.stringify(d)}`);
    }
    if (!result.ok && result.upstream !== '') {
      console.log(`        上游原文：${result.upstream.replace(/\s+/g, ' ').slice(0, 800)}`);
    }
    if (wantJson) console.log(`        body: ${result.requestBody}`);
    console.log('');
  }

  console.log(`总计 ${cases.length} 个用例，${bad} 个失败。`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`探针失败：${error?.stack ?? error}`);
  process.exit(3);
});
