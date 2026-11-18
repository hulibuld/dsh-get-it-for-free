/**
 * 千问办公签名会话：手写 COSY 信封，不再依赖 WASM。
 *
 * ── 为什么换掉 WASM ────────────────────────────────────────────────
 * 原实现从桌面客户端提取签名 WASM；那份二进制非 MIT、不随包分发，用户得
 * 自己找一份。手写 COSY 只依赖 `node:crypto` 与客户端内置的 RSA 公钥，
 * 安装即用，也不再需要 wasm.bin。
 *
 * ── 职责 ──────────────────────────────────────────────────────────
 *  - 每次请求现取 Cosy-Version / machineId，构造 COSY 头
 *  - 推理请求体按 `Encode=1` 的自定义字母表编码后再签名
 *  - 把「凭据变更」表现为可重建：token 刷新后重新构造即可
 *
 * ── 不可退让的事实 ────────────────────────────────────────────────
 *  1. `Authorization: Bearer COSY.<payload>.<sig>` 的 sig 覆盖
 *     `payload\nkey\nts\nwireBody\npath` 五段，path 去掉 `/algo` 前缀、
 *     不含 query；body 是**编码后**的 wire 串。
 *  2. `Cosy-Scene: assistant`、`Cosy-Data-Policy: agree`、企业账号带
 *     `Cosy-Organization-Id` —— 与客户端 1.2.0 实测一致。
 *  3. 请求体必须经过 `encodeBody()`；响应若被编码，由 sse 解析器解码。
 *
 * @module dsh-qwenwork-connect/signer-session
 */

import { QwenAuthError, ErrorCode } from './errors.js';
import { buildCosyHeaders, encodeBody } from './cosy.js';
import { resolveCosyVersion, resolveMachineId } from './runtime-identity.js';
// 输入/输出上限的唯一定义处：与 models.js 声明的 contextWindow 必须一致，
// 否则 DSH 的上下文溢出判断会与实际可用窗口脱节。
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from './models.js';

/** 签名端点的基址（与阶段 A-1 一致）。 */
export const DEFAULT_ENDPOINT = 'https://gateway.qwenwork.cn';

/** QwenWork 集成模式的客户端元数据（复刻 SDK 的 uE()，buildInferBody 使用）。 */
export const CLIENT_METADATA = Object.freeze({
  client_type: '6',
  business_product: 'qoder_work',
  business_type: 'agent',
  scene: 'assistant',
});

/** 推理端点（含 `Encode=1`；签名覆盖的 path 不含 query，也不含 `/algo`）。 */
export const INFER_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

/**
 * 创建一次签名会话。
 *
 * @param {object} params
 * @param {any} params.credential  t1 的规范化凭据（需 token / user / loginDeviceId）
 * @param {string} [params.endpoint]
 * @param {{ installRoot?: string, env?: NodeJS.ProcessEnv }} [params.identity]
 * @returns {Promise<object>} 会话对象
 */
export async function createSignerSession(params) {
  const credential = params.credential;
  if (credential === null || typeof credential !== 'object') {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, '签名会话缺少凭据对象。', {
      recovery: '请先登录千问办公桌面应用，或检查凭据文件是否可读。',
    });
  }

  const identityOpts = {
    credential,
    ...(params.identity?.installRoot === undefined ? {} : { installRoot: params.identity.installRoot }),
    ...(params.identity?.env === undefined ? {} : { env: params.identity.env }),
  };

  const cosy = resolveCosyVersion(identityOpts);
  const machine = resolveMachineId(identityOpts);

  if (machine === null) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      '无法确定签名所需的 machineId，签名将不被服务端接受。',
      {
        recovery:
          '凭据缺少 loginDeviceId。请重新登录千问办公应用；'
          + '或显式设置环境变量 QWEN_MACHINE_ID。',
        retryable: false,
      },
    );
  }

  const user = credential.user ?? {};
  const uid = String(user.uid ?? user.id ?? '');
  const token = typeof credential.token === 'string' ? credential.token : '';
  if (uid === '' || token === '') {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      '签名会话缺少 uid 或 token，无法构造 COSY 信封。',
      {
        recovery: '请重新登录千问办公以刷新凭据。',
        retryable: false,
      },
    );
  }

  const endpoint = params.endpoint ?? DEFAULT_ENDPOINT;
  const inferUrl = endpoint + INFER_PATH;

  return {
    endpoint,
    cosyVersion: cosy,
    machineId: machine,

    /**
     * 对推理请求签名：请求体先按 `Encode=1` 编码，COSY 的 sig 覆盖 wire body。
     *
     * @param {string | object} bodyJson 明文的 QwenWork 请求体 JSON（或等价对象）
     * @param {{ modelKey?: string, modelSource?: string }} [opts]
     * @returns {{ url: string, headers: Record<string,string>, body: string, headerCount: number }}
     */
    signInferRequest(bodyJson, opts = {}) {
      const wire = encodeBody(normalizeBodyInput(bodyJson));
      const { headers } = buildCosyHeaders({
        url: inferUrl,
        credential,
        machineId: machine.machineId,
        cosyVersion: cosy.version,
        body: wire,
        mode: 'chat',
        modelKey: opts.modelKey,
      });
      return { url: inferUrl, headers, body: wire, headerCount: Object.keys(headers).length };
    },

    /**
     * 对通用请求签名（目录等 GET；body 为空串）。
     *
     * @param {{ path: string, method: string, body?: string }} req
     */
    signRequest(req) {
      const url = endpoint + req.path;
      const wire = typeof req.body === 'string' && req.body !== '' ? encodeBody(req.body) : '';
      const { headers } = buildCosyHeaders({
        url,
        credential,
        machineId: machine.machineId,
        cosyVersion: cosy.version,
        body: wire,
        mode: 'json',
      });
      return {
        url,
        headers,
        ...(wire === '' ? {} : { body: wire }),
        headerCount: Object.keys(headers).length,
      };
    },

    /**
     * 非敏感诊断信息，可安全落入日志。machineId 只输出掩码。
     */
    describe() {
      return {
        endpoint,
        cosyVersion: cosy,
        machineId: {
          source: machine.source,
          length: machine.machineId.length,
          masked: maskIdentifier(machine.machineId),
        },
        uidPresent: uid !== '',
      };
    },

    /** 无 WASM 资源需要释放，保留接口让调用方无需分支。 */
    dispose() {},
  };
}

/**
 * 把 `signInferRequest` 的 body 入参归一化成字符串。
 *
 * 生产调用方（chat-shim.js）传的是 `buildInferBody()` 产出的字符串；
 * 这里兼容对象入参，便于测试与探针直接传结构化 body。
 *
 * @param {string | object} body
 * @returns {string}
 */
function normalizeBodyInput(body) {
  if (typeof body === 'string') return body;
  if (body !== null && typeof body === 'object') return JSON.stringify(body);
  throw new QwenAuthError(
    ErrorCode.SCHEMA_INVALID,
    `签名会话的请求体必须是 JSON 字符串或对象（实际为 ${body === null ? 'null' : typeof body}）。`,
    {
      recovery: '请用 buildInferBody() 构造请求体，或传入等价的 JSON 字符串。',
      retryable: false,
    },
  );
}

/**
 * 构造 QwenWork 的推理请求体（千问办公 **1.2.0 协议，21 个顶层键**）。
 *
 * ⚠️ `messages` 必须在**顶层**。阶段 A-1 实测：嵌套在 `chat.messages` 会被
 * 服务端以 `400 messages is required` 拒绝。
 *
 * ── 字段规格来源 ──────────────────────────────────────────────────
 * `对话/2026-09-24-千问1.2.0适配/recon-body-spec.md`：该文件逐字段给出 SDK 1.2.0
 * （`@qoder-ai/qoder-agent-sdk` 的 `qoder-worker-runtime.obf.mjs`，body 构造位于
 * 偏移 8815338）的确定取值、证据片段与偏移。下面每个字段的注释都标注对应小节，
 * **凡规格标注「未确定」的取值，这里一律不填**（见 §5 未确定项清单）。
 *
 * ── 为什么必须补这些字段 ──────────────────────────────────────────
 * 根因（规格 §1.1b.1 的实测消融）：上游对**缺 `business`（或 `business` 不含
 * `product`）** 的请求恒返回 `503 Model catalog unavailable`；补上
 * `business.product` 后即正常流式出流（_probe/o36-e2e.txt：HTTP 200、69233 字节
 * SSE、reasoning + 正文均正常）。其余字段与 503 无关（21 字段但无 business 仍是
 * 同一个 503），补齐属「与 SDK 契约一致」的正确实现。
 *
 * @param {object} params
 * @param {Array<{ role: string, content: string }>} params.messages
 * @param {string} [params.modelKey]
 * @param {string} [params.modelSource]
 * @param {string} [params.sessionId]
 * @param {string} [params.requestId]
 * @param {string} [params.requestSetId] 缺省与 request_id 同值（§3.1）
 * @param {string} [params.taskId]       缺省 `"common"`（§3.4）
 * @param {string} [params.sessionType]  缺省见 resolveSessionType()（§3.5）
 * @param {boolean} [params.isVl]        模型是否支持视觉，缺省 false（§3.6）
 * @param {boolean} [params.isReasoning] 模型是否输出思考链，缺省 false（§3.6）
 * @param {Array<string|object>} [params.imageUrls]
 * @param {Array} [params.tools]
 * @param {object} [params.customModel]  仅 BYOK 场景传入（§3.7）
 * @param {number} [params.maxInputTokens]  内部覆盖口；产品路径固定 1000000
 * @param {number} [params.maxOutputTokens] 默认 32000
 * @returns {string}
 */
export function buildInferBody(params) {
  const modelKey = params.modelKey ?? 'pro';
  const modelSource = params.modelSource ?? 'system';
  // 产品策略：固定按 1M 声明上下文档位，不向用户提供档位切换。
  // 依据：上游计费按模型倍率 + 实际用量；实测 200K / 1M 两种声明扣费一致。
  const maxInput = params.maxInputTokens ?? MAX_INPUT_TOKENS;
  const maxOutput = params.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  // 上游用 chat_context.text 作为「当前这轮要处理什么」的锚点，
  // 并用 chat_context.imageUrls 接收图片（见 Buddy2api 的 build_body）。
  const lastUserText = lastUserContent(params.messages);
  const imageUrls = Array.isArray(params.imageUrls) ? params.imageUrls : [];
  // §3.1【确定】request_id / request_set_id / chat_record_id 三者同值：
  //   SDK 为 `request_id: o?.requestId ?? randomUUID()`、
  //          `request_set_id: o?.requestSetId ?? s`、`chat_record_id: s`（s 即 request_id）。
  //   `WWc` 就是 node:crypto 的 `randomUUID`（偏移 8812803）。
  const requestId = params.requestId ?? randomId();
  // §3.6【确定】`model_config.is_vl` / `is_reasoning` 来自上游 catalog 的**逐模型**
  // 声明（`r?.is_vl` / `r?.is_reasoning`，缺省 false）。插件侧的等价物是 models.js
  // 的静态目录声明，因此由调用方传入，不在这里凭空取值。
  const isVl = params.isVl === true;
  const isReasoning = params.isReasoning === true;
  const customModel = params.customModel;

  const body = {
    // ── §3.1 request_id / request_set_id / chat_record_id ──────────────
    request_id: requestId,
    request_set_id: params.requestSetId ?? requestId,
    chat_record_id: requestId,
    // ── §3.2 session_id ───────────────────────────────────────────────
    // 多轮关联的前提：同一对话的多次请求必须复用同一个 session_id
    // （由 chat-shim 的 deriveSessionId 派生后传入）。
    session_id: params.sessionId ?? `sess-${Date.now().toString(36)}`,
    // ── §3.3 字面量字段（全 SDK 各只出现一次，已逐项验证无分支覆盖）──
    stream: true,           // `stream:!0`
    chat_task: 'FREE_INPUT',
    // ── §3.11 chat_context ────────────────────────────────────────────
    chat_context: {
      text: lastUserText,
      features: [],
      extra: {
        context: [],
        // §3.11【确定】结构为 `{ key, is_reasoning }`（key = resolvedModelKey，
        // is_reasoning 与 model_config 同级值一致）。这里额外保留插件既有的
        // `source`——它是历史字段、实测未影响上游，按「只增不减」保留。
        modelConfig: { key: modelKey, source: modelSource, is_reasoning: isReasoning },
        originalContent: lastUserText,
      },
      chatPrompt: '',
      // 图片经此字段送达上游；无图时为 null（上游约定）。
      //
      // ⚠️ t7 实测修正（勿据本字段推断上游行为）：
      //   - 真正让上游「看到」图片的通道是 `messages[].content[]` 里的
      //     `{type:"image_url", image_url:{url:"data:..."}}`；
      //     本字段 **实测完全无作用**，且 SDK 在 1.0.6 就写死 `null`
      //     （**不是** 1.2.0 的回归）。
      //   - 既然如此仍保留「有图时填数组」：它是插件既有行为，属**只增不减**的
      //     历史字段；本任务的约束是「不得为跑通而删掉图片链路」，故保持原样。
      //     清理它属于另一次改动，不在此次范围内。
      //   - SDK 侧恒为 `null`：`$Wc`（偏移 8817892）返回 `imageUrls:null`，
      //     无任何分支写入数组（规格 §3.11、§5.3）。
      imageUrls: imageUrls.length > 0 ? imageUrls : null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,        // 数字 1（非字符串）——字面量检查命中 `source:1,version`
    version: '3',     // 字符串 "3"
    agent_id: 'agent_common',
    // ── §3.4 task_id ──────────────────────────────────────────────────
    // 表达式 `o?.taskId ?? qWc(m?.type) ?? o?.policyTaskId ?? "common"`；而
    // `qWc(x)` 仅在 `x === "sec_scan"` 时非 undefined（`VWc = new Set(["sec_scan"])`），
    // 正常聊天场景恒为 "common"。这是 SDK 自身的默认产出值，上游必然接受。
    task_id: params.taskId ?? 'common',
    // ── §3.5 session_type ─────────────────────────────────────────────
    // 表达式与默认值的依据见 resolveSessionType()（含规格 §5.1 未确定项处理）。
    session_type: params.sessionType ?? resolveSessionType(),
    // ── §3.3 aliyun_user_type ─────────────────────────────────────────
    aliyun_user_type: '',   // 全 SDK 仅此一次出现，恒为空串
    // ── §3.6 model_config（`ZWc`，偏移 8816066）───────────────────────
    // 非 BYOK 时的确定清单：display_name = key、model 恒为 ""（只有
    // outer_provider 存在时才换成该键）、format = "openai"、
    // api_key / url 恒为 ""、source = "system"（`dBe`）。
    // ⚠️ model_config **不含** max_output_tokens —— 输出上限走 parameters.max_tokens。
    model_config: {
      key: modelKey,
      display_name: modelKey,
      model: '',
      format: 'openai',
      is_vl: isVl,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: modelSource,
      max_input_tokens: maxInput,
    },
    // ── §3.7 custom_model（条件展开，键序与 SDK 一致，见 §2）──────────
    // 【确定】非 BYOK 场景下 SDK 的 `custom_model`（`n`）恒为 `undefined`，
    // 经 `JSON.stringify` 后该键**整体消失**（偏移 8736330 `Q=JSON.stringify(A)`）。
    // SDK 从不发空字符串，规格 §5.2 亦标注「能否为 ""」未确定——因此这里默认
    // **不发该键**；只有调用方显式提供 BYOK 配置时才按 §3.7 的结构写入。
    ...(customModel === undefined || customModel === null ? {} : { custom_model: customModel }),
    // ── §3.9 system ───────────────────────────────────────────────────
    // 【确定】1.2.0 的 `system` 是**数组**（`[{type:"text",text}]`），无 system
    // 提示时为 `[]`——**不是** 1.0.6 的字符串 `""`（真实契约变化之一）。
    // 本插件不注入独立的 system prompt block，故恒为 `[]`；对话里 role:"system"
    // 的消息仍留在 messages 中原样透传（不搬运、不改写，避免改变既有行为）。
    system: [],
    messages: params.messages,
    // ── §3.12 tools ───────────────────────────────────────────────────
    // 【确定】`tools: o?.tools ?? []`——恒为数组，无工具时也发空数组（不是省略该键）。
    // 工具定义必须透传：若丢弃，模型收不到规范 schema，会自行编造
    // `<tool_call><invoke ...>` 这类自由文本格式，DSH 无法解析，最终原样显示成正文。
    tools: Array.isArray(params.tools) ? params.tools : [],
    // ── §3.8 parameters ───────────────────────────────────────────────
    // 确定最小形态是 `{ max_tokens }`；`context_length` 是产品额外声明的窗口。
    // `enable_thinking` 固定 true：千问办公网关强制思考，关不掉（2026-11-08
    // 五变体实测），插件也不提供开关；显式发 true 比依赖上游默认更明确。
    //
    // ⚠️ context_length 的计量单位是 **Qwen 的 token**，与 DSH 用的 tokenizer
    // 不是同一套；不能拿 DSH 的 token 计数直接填。当前策略是固定 1M、按消息
    // 估算窗口的实现需要额外接 Qwen tokenizer，这里不做。
    parameters: { enable_thinking: true, max_tokens: maxOutput, context_length: maxInput },
    // ── §3.13 business（**503 根因字段**）─────────────────────────────
    // SDK 的写法是条件展开 `...void 0!==m?{business:m}:{}`，但服务端要求它存在
    // 且含 `product`：缺失即 503（§1.1b.1 实测）。
    business: buildInferBusiness(),
  };
  return JSON.stringify(body);
}

/**
 * 解析 1.2.0 的 `session_type`（规格 §3.5）。
 *
 * SDK 表达式（偏移 8815700）：
 *   `session_type: process.env[TPA] ?? (dg() ? Yqe : TyA)`
 * 其中 `TPA = "QODERCN_SESSION_TYPE"`（经 `vr()` 加 `QODERCN_` 前缀）、
 * `dg() = ("1" === process.env.QODER_WORK_INTEGRATION_MODE)`、
 * `Yqe = "qoder_work"`、`TyA = "qoderclicn"`。
 *
 * ⚠️ 规格 §5.1 标注：**千问办公进程实际是否设置 `QODER_WORK_INTEGRATION_MODE=1`
 * 未被静态反解证明**。而本插件运行在 DSH 宿主进程内，读到的 env 与千问办公进程
 * 并不是同一份，因此**不能**把 `dg()` 的判定结果当作「千问办公的真实取值」。
 *
 * 默认取 `"qoder_work"` 的依据（基于实测，不是猜测）：
 *   ① 本插件复刻的就是千问办公的 **Qoder Work 集成模式**——见同文件
 *      `CLIENT_METADATA`（`business_product: "qoder_work"`、`client_type: "6"`，
 *      与 SDK 的 `uE()` 一致），`business.product` 亦取同一来源；
 *   ② 上游实测通过的用例**全部**使用 `"qoder_work"`（_probe/o34-converge.txt 的
 *      H/I/J 用例、o36-e2e.txt 端到端），`"qoderclicn"` 未经端到端跑通。
 *
 * 保留 SDK 的**第一优先级**分支：env 里设了 `QODERCN_SESSION_TYPE` 就以它为准。
 * 调用方也可经 `buildInferBody({ sessionType })` 显式覆盖。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSessionType(env = process.env) {
  const fromEnv = env?.QODERCN_SESSION_TYPE;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return 'qoder_work';
}

/**
 * 构造 1.2.0 的 `business` 字段（规格 §3.13；**503 的根因字段**，§1.1b.1 实测）。
 *
 * ── t8 对 t1 的一处取值修正（已落实到本函数；captain 已逐字复核 obf 原文）──
 * ⚠️ t1 规格 §3.4 曾称「`dg()` 为真时 `business.type` 默认 `"qoder_work"`」——**该说法有误**。
 * obf 原文（`kpe()`，偏移 1382329）逐字为：
 * ```js
 * function kpe(){
 *   let A=aTA, e=ZXe;                              // A="cli", e="agent"
 *   return "1"===process.env[Sne] ? (A=cTA, e=XXe) // ide 分支：A="ide", e="quest"
 *        : dg() && (A=ZRe),                        // work 分支：**只改 A**；e 不变！
 *          {product: process.env[$fe] ?? A, type: process.env[exe] ?? e}
 * }
 * ```
 * `dg() && (A=ZRe)` 是逗号表达式的一支，**只给 `A`（product）赋值**，`e` 从未被改，
 * 仍是初始值 `ZXe="agent"`。故 `type` **恒为 `"agent"`**，**绝不是** `"qoder_work"`。
 * 常量组（同处 var 声明）：`aTA="cli"`、`cTA="ide"`、`ZRe="qoder_work"`、
 * `ZXe="agent"`、`XXe="quest"`、`Spe="init"`。
 *
 * ── 三个子字段的确定依据 ──────────────────────────────────────────
 *   - `product`：`kpe()` 的合法取值恰好 3 组——`"cli"`+type`"agent"`（裸 CLI）、
 *     `"ide"`+type`"quest"`（IDE-Quest）、`"qoder_work"`+type`"agent"`（千问办公桌面端，
 *     即 `dg()` 为真）。强佐证：`vg()`（偏移 7549，控制 `Cosy-ClientType` 等签名头）
 *     原文为 `client_type: process.env[iK] ?? (A?S1t:nxe)`、`business_product: ... ?? (A?Yqe:D1t)`、
 *     `business_type: process.env[exe] ?? b1t`、`scene: process.env[Oqe] ?? P1t` ——
 *     其中 **`business_type` 与 `scene` 都没有 `dg()` 分支**（独立印证 type 恒为 `"agent"`），
 *     且四个值与同文件 `CLIENT_METADATA`（`client_type:'6'`、`business_product:'qoder_work'`、
 *     `business_type:'agent'`、`scene:'assistant'`）**逐字段完全吻合**。即签名头的
 *     `Cosy-Business-Product` 与 body 的 `business.product` 天然同源；填 `cli`/`ide`
 *     会让两者自相矛盾。
 *   - `type`：`ZXe = "agent"`，恒不受 `dg()` 影响（见上「修正」）。
 *   - `stage`：SDK 常量 `Spe = "init"`（偏移 1295477）。
 *
 * 实测支持：只发 `{product:"qoder_work"}` 这一个字段即可让上游从 503 变为正常出流
 * （_probe/o35-abl.txt）；从完整对象里**删掉 `product`** 则立刻退回 503。本形态
 * `{product, type, stage}` 正是 _probe/o36-e2e.txt 端到端跑通的形态。
 *
 * ── t8 给出的三条硬约束（均已满足）────────────────────────────────
 *   ① 必须是**对象**——传数组 / 假值 → 400 `Invalid agent chat JSON body`；
 *   ② **必须含 `product`**——空对象 `{}` 或仅含 `type` → 仍 503；
 *   ③ `product` 取 `"qoder_work"`；最小可行 `{product:"qoder_work"}`。
 * 另：t8 确认**不存在**「缺 business 被其它分支救回」的路径（全文 `{business:` 仅 5 处
 * 且属不同请求构造；`KWc` 的合成分支反而会产生无 `product` 的 business，是加重而非救回）
 * —— 这与「本插件必须显式传 business」完全一致。
 *
 * 为什么**不**发 `version` / `id` / `name` / `begin_at`：
 *   SDK 的完整业务对象由 `Bwr()` 构造（`{product, version, type, id, name, begin_at, stage}`），
 *   其中 `version` 来自 `await Oi()`、`id` 由 `RTA()`/`gQl()`（即 `node:crypto.randomUUID`）
 *   生成、`name`/`sub_task` 来自 `vFt()`、`begin_at` 为 `Date.now()`。这些字段的取值
 *   依赖本插件不存在的 SDK 会话上下文（「生成标题 / 提示建议 / 觉察提醒」等业务场景
 *   与客户端版本号），规格 §3.13/§5 未给出确定语义 → **不得用猜测值填充**。
 *   实测消融（§1.1b.1）：除 `product` 外逐项删除仍 PASS，故省略它们没有功能损失。
 *
 * @returns {{ product: string, type: string, stage: string }}
 */
function buildInferBusiness() {
  return {
    product: CLIENT_METADATA.business_product, // "qoder_work"（kpe 的 ZRe 分支）
    type: CLIENT_METADATA.business_type,       // "agent"（ZXe，恒不受 dg() 影响）
    stage: 'init',                             // SDK 常量 Spe
  };
}

/**
 * 取最后一条 user 消息的纯文本（用作 chat_context.text）。
 *
 * @param {Array<{role?: string, content?: unknown}>} [messages]
 * @returns {string}
 */
function lastUserContent(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
    }
  }
  return '';
}

/** 生成一个 request id（不依赖 crypto.randomUUID 的存在性）。 */
function randomId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    /* 回退下面 */
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把标识符掩码成 `前4***后2`，长度不足时全掩。
 * 用于任何可能进日志的字段。
 *
 * @param {string} value
 * @returns {string}
 */
export function maskIdentifier(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

// MAX_INPUT_TOKENS / MAX_OUTPUT_TOKENS 从这里也可见：调用方校验
// 「models.js 的 contextWindow 声明」与「请求体里的 max_input_tokens」
// 是否一致时需要同时拿到两者。
export { randomId, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS };
