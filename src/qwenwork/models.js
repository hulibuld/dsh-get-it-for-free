/**
 * 静态内置的模型目录。
 *
 * 来源：QwenWorkCN 桌面 App 日志中的模型列表（`rawModels` 字段，实测取得）。
 * 阶段 B 不依赖 upstream 动态拉取，保证离线时 provider 不会是空的。
 *
 * 三个模型均取自 App 实际返回，未臆造：
 *   pro                  — 高级（默认模型，isDefault: true）
 *   flash                — 标准｜Qwen3.8-Flash（tags: ["is_recommend"]）
 *   qwen3.8-max-preview  — Qwen3.8-Max（isNew: true，官方描述「千问最强模型」）
 *
 * @module dsh-qwenwork-connect/models
 */

/** 本插件拥有的 provider 路由 id。 */
export const QWENWORK_PROVIDER = 'qwenwork';

/**
 * 上下文窗口与输出上限。
 *
 * ⚠️ **`MAX_INPUT_TOKENS` 必须与发给上游的 `model_config.max_input_tokens` 一致**
 * （见 `signer-session.js` 的 `buildInferBody`）。
 *
 * 真实上限的确定过程（教训记录）：
 *   1. App 日志表格列标注「1M」
 *   2. Buddy2api 的 `model_config.max_input_tokens` 写 180000
 *   3. 曾照搬 180000 —— **实测证明是错的**：
 *      probe-context-limit*.mjs 的对照实验显示
 *      ≈150K/200K/400K/700K/850K/1.0M/1.2M tokens 全部被上游接受，
 *      ≈1.5M 才被拒（"Error in upstream response"）。
 *      → 真实上限在 1.2M~1.5M 之间，「1M」是保守而合理的声明值。
 *
 * 声明与实现不一致是本项目反复出现的一类缺陷；这次是**照搬外部值未实测**。
 */
export const MAX_INPUT_TOKENS = 1_000_000;
/** 单次回复的输出上限（与 `parameters.max_tokens` 一致）。 */
export const MAX_OUTPUT_TOKENS = 32000;

/**
 * 静态回退目录。
 *
 * 每条都直接取自 App 日志的 `rawModels`，未臆造任何字段：
 * `priceFactor` → `billingRate`，`isVl` → `supportsImages`，
 * `defaultContextWindow` → `contextWindow`。
 *
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   description: string,
 *   billingRate: number,
 *   supportsImages: boolean,
 *   contextWindow: number,
 *   maxTokens: number,
 *   isDefault?: boolean,
 *   isRecommended?: boolean,
 *   isNew?: boolean,
 * }>}
 */
/**
 * 上游模型**具备视觉能力**（App 的 `rawModels` 里 `is_vl: true`），
 * 因此这里如实声明 `supportsImages: true`。
 *
 * 但声明只是前提之一——DSH 走图片路径还需要**两个条件同时满足**：
 *   ① 模型描述符声明 image 模态
 *   ② pi-ai 配置了 `resolveAttachments`（DSH 的持久化附件服务）
 *
 * 若只有 ① 没有 ②，DSH 会直接抛
 * `pi-ai image input requires the durable attachment service`（连文本对话都失败）；
 * 若只有 ② 没有 ①，图片会被投影成文本占位符，用户传了图却等于没传。
 *
 * 因此 `toPiModel` 接受 `{ supportsImages }` 覆盖：**由调用方按附件服务
 * 是否可用传入**，保证「声明」与「能力」始终一致（见 lib/index.js 的
 * `imageDepsFrom`）。
 */
export const FALLBACK_QWENWORK_MODELS = [
  {
    id: 'pro',
    shortName: '高级',
    billingRate: 1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: true,
  },
  {
    id: 'flash',
    // pi 等宿主的模型选择器只渲染描述符 `id`，干巴巴的 `flash` 看不出这是
    // 千问 3.8。展示 id 用官方全名（上游目录 display_name 实测为
    // 「标准｜Qwen3.8-Flash」）；请求路由前由 normalizeModelKey() 归一化
    // 回上游 key `flash`，两边都不破。
    displayNameId: 'qwen3.8-flash',
    shortName: '标准｜Qwen3.8-Flash',
    billingRate: 0.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isRecommended: true,
  },
  {
    id: 'frontier-1',
    shortName: 'Qwen4-Max 预览',
    billingRate: 0.4,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  },
  {
    id: 'qwen3.8-max-preview',
    shortName: 'Qwen3.8-Max',
    billingRate: 1.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  },
];

/**
 * 把宿主传来的模型标识归一化回**上游 model_config.key**。
 *
 * 背景：部分宿主（如 pi）的选择器只渲染描述符 `id`，因此目录条目允许声明
 * `displayNameId`（人类可读全名，如 `qwen3.8-flash`）作为对外 id；请求进
 * shim 后必须换回上游认得的短 key（`flash`）。未声明 displayNameId 的模型
 * 两种写法（短 key 与自身 id）都接受；目录里查不到的一律原样透传，
 * 交给上游自行裁决（不吞新模型的接入路径）。
 *
 * @param {string} model 宿主 id（displayNameId 或上游 key）
 * @returns {string} 上游 model_config.key
 */
export function normalizeModelKey(model) {
  if (typeof model !== 'string' || model === '') return model;
  const info = FALLBACK_QWENWORK_MODELS.find(
    (m) => m.id === model || m.displayNameId === model,
  );
  return info === undefined ? model : info.id;
}

/**
 * 把倍率格式化成选择器里显示的文本。
 *
 * 形态对齐 WorkBuddy（`Hy3 · x0.00 · 限时免费`）：
 *   - 0 倍率 → `免费`
 *   - 其它   → `x1.00` / `x0.10` / `x1.10`
 *
 * @param {number} rate
 * @returns {string}
 */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate === 0) return '免费';
  return `x${rate.toFixed(2)}`;
}

/**
 * 生成模型选择器里显示的名字：`名称 · 倍率 · 标记`。
 *
 * ⚠️ 这是**唯一的显示名来源**——DSH 的模型选择器渲染的就是 pi-ai 模型描述符
 * 的 `name` 字段（见 dsh-workbuddy-connect 的 `toPiModel`，它直接透传
 * 上游 `name`，而该值本身就形如 `Hy3 · x0.00 · 限时免费`）。
 * 倍率必须拼进 `name` 才会出现在选择器里；单独放 `billingRate` 字段
 * 只有设置卡片能看到。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
export function displayName(info) {
  const parts = [info.shortName ?? info.id];
  const rate = formatRate(info.billingRate);
  if (rate !== '') parts.push(rate);
  if (info.isDefault === true) parts.push('默认');
  if (info.isRecommended === true) parts.push('推荐');
  if (info.isNew === true) parts.push('新');
  return parts.join(' · ');
}

/**
 * 卡片与选择器共用的描述文案。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
function describeModel(info) {
  const rate = formatRate(info.billingRate);
  const ctx = info.contextWindow >= 1000000 ? '1M' : `${Math.round(info.contextWindow / 1000)}K`;
  return [
    info.supportsImages === true ? '视觉' : '仅文本',
    ctx,
    rate === '' ? undefined : rate === '免费' ? '免费' : rate,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 供卡片展示的精简模型行。 */
export function catalogForCard(models = FALLBACK_QWENWORK_MODELS) {
  return models.map((model) => ({
    id: model.id,
    // 卡片显示短名（倍率已单独成列），选择器则用带倍率的长名。
    name: model.shortName ?? model.id,
    description: describeModel(model),
    rate: model.billingRate,
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(model.isRecommended === true ? { isRecommended: true } : {}),
    ...(model.isNew === true ? { isNew: true } : {}),
  }));
}

/**
 * 把静态目录条目转成 pi-ai 的模型描述符。
 *
 * `name` 是**模型选择器显示的那一行文本**——因此这里用 `displayName()`
 * 把倍率拼进去（形如 `高级 · x1.00 · 默认`），否则选择器只会显示干巴巴的
 * 名称，用户看不到谁贵谁便宜。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @param {string} baseUrl 该 provider 的请求基址
 * @param {{ supportsImages?: boolean }} [opts]
 *        `supportsImages` 覆盖：**由调用方按附件服务是否可用传入**。
 *        不传则沿用目录里的声明。这样当宿主没有附件服务时，模态会退回
 *        `['text']`，避免 DSH 走图片路径后抛
 *        `pi-ai image input requires the durable attachment service`。
 */
export function toPiModel(info, baseUrl, opts = {}) {
  const supportsImages = opts.supportsImages ?? info.supportsImages === true;
  return {
    // 部分宿主（pi）的选择器只渲染描述符 `id`，这类宿主传 `displayId: true`
    // 换用人类可读全名；请求回落到 shim 时由 normalizeModelKey() 换回上游
    // 认识的短 key，两侧契约都不破。DSH 侧选择器显示的是 `name`，故保持
    // 原 id 不变，不动已持久化的模型选择记录。
    id: opts.displayId === true ? (info.displayNameId ?? info.id) : info.id,
    name: displayName(info),
    api: 'openai-completions',
    provider: QWENWORK_PROVIDER,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    /**
     * 上游确实返回思维链（`reasoning_content`），但 pi-ai 把它解析成独立
     * thinking 块**不依赖这个标志**：openai-completions 的解析分支无条件读取
     * `reasoning_content`（实测 reasoning:false 时 thinking 块照常产出）。
     *
     * 这里置 false 只有一个目的：让 DSH 不生成「推理等级」菜单。
     *
     * 原因：上游模型目录里所有模型的 `thinking_config` 都是 null，没有声明
     * 任何 effort 档位。DSH 对 `reasoning:true` 且没有 `thinkingLevelMap`
     * 的模型会自动补出 off/minimal/low/medium/high，但上游并不认这些档位，
     * 属于假开关。置 false 后 DSH 的 `reasoningInfo` 返回空，UI 不再出现
     * 推理等级；把 `thinkingLevelMap` 全设 null 反而会得到空 efforts，
     * dsh-llm 会直接抛 `INVALID_MODEL_REASONING`。
     *
     * 思考本身固定开启：请求体 `parameters.enable_thinking` 恒为 true
     * （见 signer-session.js 的 buildInferBody），不提供开关、不做回退。
     */
    reasoning: false,
    /**
     * 思考开关握手（QwenWork 网关不支持，2026-11-08 实测）：
     *
     * pi-ai 对 openai-completions API 按 `compat.thinkingFormat` 决定发不发
     * `enable_thinking`（qwen / qwen-chat-template 两种格式）。不声明时
     * auto-detect 会因 baseUrl 是 127.0.0.1 环回 shim 而落到默认 openai，
     * 宿主设 thinking="off" 只是不发 reasoning_effort，请求体里没有任何
     * 关思考字段。
     *
     * 实测（research/buddy2api-probes/probe-disable-thinking.mjs：5 变体对照；
     * probe-flash-thinking.mjs：flash 模型 3 变体）：QwenWork 网关对
     * `enable_thinking:false`、`chat_template_kwargs.enable_thinking:false`、
     * `reasoning_effort:"none"`、`is_reasoning:false` 全部无视，思考照发。
     * 所以这里**刻意不声明** compat.thinkingLevelMap / thinkingFormat，并且把
     * `reasoning` 置 false，避免 DSH 自动补出上游并不支持的通用档位：发了
     * 也是无效字段，反而让 pi-ai 以为关思考已生效。上游强制思考，
     * 宿主端的正确姿态是容忍 thinking 通道（pi-hermes-memory 的
     * thinking-channel recovery 那样从 thinking 块恢复答案）。
     */
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  };
}
