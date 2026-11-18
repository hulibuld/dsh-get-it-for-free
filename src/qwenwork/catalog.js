/**
 * 动态模型目录：用 COSY 签名拉 `/algo/api/v2/model/list?Encode=1`。
 *
 * 聊天与目录共用同一套手写 COSY 签名、凭据、VPC 端点与企业字段。
 *
 * 目录以 5 分钟 TTL 缓存：`getModels()` 是同步接口，不能每次都等网络；
 * 后台刷新成功后下一次 `getModels()` 自然看到新目录。刷新失败时保留
 * 上一次成功的快照（首次启动是 models.js 里的内置目录）。
 *
 * @module dsh-qwenwork-connect/catalog
 */

import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, FALLBACK_QWENWORK_MODELS } from './models.js';
import { createSignerSession } from './signer-session.js';

/** 上游目录端点（与聊天同一网关，COSY 签名）。 */
export const CATALOG_PATH = '/algo/api/v2/model/list?Encode=1';

/** 目录缓存时间。 */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

/** 上游返回的 scene 顺序：千问办公主要用 qwork。 */
const SCENES = ['qwork', 'app', 'chat'];

/**
 * 把上游目录响应解析成本项目的模型条目（形状对齐 models.js 的内置目录）。
 *
 * 只取第一个非空的 scene；字段缺失时回退到保守值，不臆造能力：
 *   - `is_vl` 缺失 → 不声明视觉
 *   - `price_factor` 缺失 → 1.0
 *   - `max_input_tokens` 缺失 → context_config 里最大的档位
 *
 * @param {any} payload 目录接口的 JSON
 * @returns {Array<any>} 模型条目；解析不出时返回空数组
 */
export function parseCatalog(payload) {
  for (const scene of SCENES) {
    const list = payload?.[scene];
    if (!Array.isArray(list)) continue;
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const entry = toCatalogEntry(item);
      if (entry === null || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** 单条上游模型 → 内部条目。 */
function toCatalogEntry(item) {
  if (item === null || typeof item !== 'object') return null;
  const id = typeof item.key === 'string' ? item.key.trim() : '';
  if (id === '' || item.enable === false) return null;

  const contextWindow =
    positiveNumber(item.max_input_tokens) ?? defaultContextWindow(item.context_config);
  return {
    id,
    // 保持既有选择器显示：flash 对外仍是 qwen3.8-flash，请求前由
    // normalizeModelKey() 换回上游 key。
    ...(id === 'flash' ? { displayNameId: 'qwen3.8-flash' } : {}),
    shortName: nonEmpty(item.display_name) ?? id,
    ...(nonEmpty(item.description) === undefined ? {} : { description: item.description }),
    billingRate: nonNegativeNumber(item.price_factor) ?? 1,
    supportsImages: item.is_vl === true,
    contextWindow,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(item.is_default === true ? { isDefault: true } : {}),
    ...(item.is_new === true ? { isNew: true } : {}),
  };
}

/** `context_config` 是 `{ "1M": { token_count }, "200K": ... }`，键名大小写不统一。 */
function contextWindows(config, fallback) {
  const values = new Set();
  if (config !== null && typeof config === 'object') {
    for (const value of Object.values(config)) {
      const tokens = positiveNumber(value?.token_count);
      if (tokens !== undefined) values.add(tokens);
    }
  }
  values.add(fallback);
  return [...values].sort((a, b) => b - a);
}

/** 没有 `max_input_tokens` 时，取 context_config 里最大的档位。 */
function defaultContextWindow(config) {
  const windows = contextWindows(config, 0).filter((value) => value > 0);
  return windows[0] ?? MAX_INPUT_TOKENS;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 目录缓存。
 *
 * `models()` 始终返回一个非空数组：首次刷新成功前用内置目录，
 * 之后失败保留上一次成功的快照。
 *
 * @param {Array<any>} [seed]
 */
export function createCatalogStore(seed = FALLBACK_QWENWORK_MODELS) {
  let models = seed;
  let fetchedAt = 0;
  let inflight = null;

  return {
    models: () => models,
    lastFetchedAt: () => fetchedAt,
    /** 到 TTL 或显式要求时才值得再拉。 */
    shouldRefresh: (force = false) => force || Date.now() - fetchedAt >= CATALOG_TTL_MS,

    /**
     * 拉一次目录。并发调用共享同一个请求；失败原样抛出，由调用方记录日志。
     *
     * @param {{ credential: any, endpoint?: string, fetchImpl?: typeof fetch }} opts
     * @returns {Promise<Array<any>>} 刷新后的目录
     */
    refresh({ credential, endpoint, fetchImpl }) {
      if (inflight !== null) return inflight;
      const run = (async () => {
        const session = await createSignerSession({
          credential,
          ...(endpoint === undefined ? {} : { endpoint }),
        });
        try {
          const signed = session.signRequest({ path: CATALOG_PATH, method: 'GET' });
          const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
          const response = await doFetch(signed.url, {
            method: 'GET',
            headers: signed.headers,
          });
          if (!response.ok) {
            throw new Error(`model list HTTP ${response.status}`);
          }
          const payload = await response.json();
          const parsed = parseCatalog(payload);
          if (parsed.length === 0) {
            throw new Error('model list returned no usable models');
          }
          models = parsed;
          fetchedAt = Date.now();
          return parsed;
        } finally {
          try {
            session.dispose();
          } catch {
            /* 释放失败不影响目录结果 */
          }
        }
      })();
      inflight = run;
      // 失败也要清掉 inflight，下一次刷新才能重试。
      run.then(
        () => {
          if (inflight === run) inflight = null;
        },
        () => {
          if (inflight === run) inflight = null;
        },
      );
      return run;
    },
  };
}
