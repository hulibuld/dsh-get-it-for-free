// 把一份凭据写进渠道包自己的账号池。
//
// 为什么需要这一层：dsh-codearts / dsh-connect-workbuddy / dsh-connect-qoder 三家
// 都能「自己拿到凭据」，但拿到之后如果没有写进渠道包，模型选择器里依然什么都
// 不会多 —— 渠道包的可见性判据是「凭据可解析」而不是「有条目」（pack.js
// providerCatalogVisible()），两边必须成对写。
//
// 三件事必须同时成立，缺一条账号就会变成一个点不动的空行：
//   1. `.credentials.yaml` 里有一份以 `<PREFIX>_ACCOUNT_<HEX>` 命名的凭据
//      （pack.js ACCOUNT_REF_RE 硬要求 6 位以上十六进制后缀）；
//   2. `state.json` 的 accounts 里有一条指向这个 ref 的条目；
//   3. 条目 id 与 ref 同源 —— pack.js 在 state.json 丢失时靠 ref 名重建账号，
//      规则是 `id = <provider>-<后缀小写>`。自己另起 id 的话，重建出来的就是
//      另一条账号，用户会看到「账号凭空多了一份」。
//
// 所以这里统一从 seed 派生后缀，id 与 ref 都从它算，不做第二次决定。

import { createHash } from 'node:crypto'

/** provider → 凭据 ref 前缀（与 pack.js REF_PREFIX_TO_PROVIDER 对齐）。 */
const REF_PREFIX = {
  codearts: 'CODEARTS',
  buddy: 'BUDDY',
  workbuddy: 'WORKBUDDY',
  qoder: 'QODER',
  qodercn: 'QODERCN',
  trae: 'TRAE',
  loomy: 'LOOMY',
}

/** 后缀是十六进制：pack.js 的正则只认 `[0-9A-Fa-f]{6,}`。 */
function suffixOf(seed) {
  const digest = createHash('sha256').update(String(seed)).digest('hex')
  return digest.slice(0, 8)
}

/** 账号 id 与凭据 ref 名都由同一段后缀算出。 */
export function slotFor(provider, seed) {
  const prefix = REF_PREFIX[provider]
  if (prefix === undefined) throw Object.assign(new Error(`这个渠道没有登记 ref 前缀：${provider}`), { code: 'BAD_PROVIDER' })
  const suffix = suffixOf(seed)
  return { id: `${provider}-${suffix}`, refName: `${prefix}_ACCOUNT_${suffix.toUpperCase()}` }
}

/**
 * 写一份凭据，并保证账号池里有一条指向它的条目。
 *
 * @param {object} options
 * @param {object} options.credentials 宿主凭据服务（scoped.credentials）
 * @param {Function} options.credentialRef 宿主的 credentialRef 构造器
 * @param {object} options.pool 渠道包的账号池（scoped.get('accountPool')）
 * @param {string} options.provider provider id
 * @param {string} options.seed 派生 id/ref 的种子（PAT、uin、user_id 之类稳定值）
 * @param {string} options.nickname 展示名
 * @param {object} options.credential 凭据对象（会被 JSON 序列化）
 * @param {number} [options.expiresAt] 过期时间毫秒
 * @param {boolean} [options.refreshable] 能否自动续期
 * @param {boolean} [options.enabled] 默认启用
 * @returns {Promise<{ id: string, refName: string, existed: boolean }>}
 */
export async function injectCredential({
  credentials,
  credentialRef,
  pool,
  provider,
  seed,
  nickname,
  credential,
  expiresAt,
  refreshable = false,
  enabled = true,
} = {}) {
  if (credentials === undefined || credentials === null) {
    throw Object.assign(new Error('宿主的凭据服务不可用，写不了账号'), { code: 'NO_CREDENTIALS' })
  }
  if (pool === undefined || pool === null) {
    throw Object.assign(new Error('渠道包还没挂载完，稍等一秒再试'), { code: 'NO_POOL' })
  }
  if (typeof credentialRef !== 'function') {
    throw Object.assign(new Error('宿主的凭据引用构造器不可用'), { code: 'NO_CREDENTIAL_REF' })
  }
  if (typeof credential !== 'object' || credential === null) {
    throw Object.assign(new Error('凭据是空的'), { code: 'EMPTY_CREDENTIAL' })
  }
  const { id, refName } = slotFor(provider, seed)
  // 先写凭据：先写条目后写凭据的话，中间那一刻渠道包会看到一条指向空 ref 的
  // 账号，模型目录请求会以「凭据不可解析」失败并把这个 provider 整组过滤掉。
  await credentials.set(credentialRef(refName), JSON.stringify(credential))

  const existing = await pool.listAllAccounts()
  const found = Array.isArray(existing) ? existing.find(row => row?.id === id) : undefined
  const patch = {
    nickname,
    enabled,
    refreshable,
    ...(typeof expiresAt === 'number' && expiresAt > 0 ? { expiresAt } : {}),
  }
  if (found === undefined) {
    await pool.addAccount({
      id,
      provider,
      credentialRef: refName,
      createdAt: Date.now(),
      ...patch,
    })
    return { id, refName, existed: false }
  }
  // 已存在就只更新元数据，不重排顺序：用户的账号顺序决定实际用哪一号。
  await pool.updateAccount(id, patch)
  return { id, refName, existed: true }
}

/** 删掉一个账号（连带它的凭据）。用于「导入错了」「重新扫码」。 */
export async function evictAccount({ credentials, credentialRef, pool, accountId } = {}) {
  const rows = await pool.listAllAccounts()
  const found = Array.isArray(rows) ? rows.find(row => row?.id === accountId) : undefined
  if (found === undefined) return { removed: false }
  if (typeof found.credentialRef === 'string' && found.credentialRef !== '' && typeof credentialRef === 'function') {
    try {
      await credentials.unset(credentialRef(found.credentialRef))
    } catch { /* 凭据本来就不在，不算失败 */ }
  }
  await pool.removeAccount(accountId)
  return { removed: true }
}
