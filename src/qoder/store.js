/**
 * Qoder 账号库的落盘与来源合并层：按区域一份 JSON，一个 PAT 一条记录。
 *
 * 为什么账号 id 从 PAT 单向派生、而不是等 jobToken 交换拿 uid：
 * 「这个 PAT 是不是已经在库里」是每次开面板都要回答的问题，而交换要联网。
 * 离线可算才谈得上去重，也才不会因为一次网络抖动把同一个账号记成两条。
 *
 * 为什么来源是「合并」而不是「覆盖」：设置卡片、环境变量、保险库是三种不同
 * 的录入渠道，同一个 PAT 从两处进来仍是一个账号；但「谁优先」必须确定，
 * 否则同一个账号在不同面板上会显示不同的 label。
 *
 * 文件 0600，写盘走 tmp + rename：一个 PAT 等价于账号本身，崩在中间不能留下
 * 半个 JSON，也不能让别的用户读到它。
 *
 * @module src/qoder/store.js
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 两个区域的端点与专属环境变量。
 *
 * 区域不是一个显示用的标签：CN 与国际版的 openapi、鉴权域名、账号体系全不同，
 * 把同一个 PAT 记到另一区，模型列表和计费都会跟着错（上游两条链路不互通）。
 *
 * @type {Readonly<Record<'cn'|'global', {id: string, label: string, authBase: string, openApiBase: string, apiBase: string, envName: string}>>}
 */
export const REGIONS = Object.freeze({
  cn: Object.freeze({
    id: 'cn',
    label: 'Qoder 中国版',
    authBase: 'https://qoder.com.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    apiBase: 'https://api.qoder.com.cn',
    envName: 'QODERCN_PERSONAL_ACCESS_TOKEN',
  }),
  global: Object.freeze({
    id: 'global',
    label: 'Qoder 国际版',
    authBase: 'https://qoder.sh',
    openApiBase: 'https://openapi.qoder.sh',
    apiBase: 'https://api.qoder.sh',
    envName: 'QODER_PERSONAL_ACCESS_TOKEN',
  }),
})

/** 区域 id 列表，顺序即面板/报告的展示顺序。 */
export const REGION_IDS = Object.freeze(Object.keys(REGIONS))

/** 来源优先级，从高到低。同一个 PAT 只保留最先命中的那个来源作为 primary。 */
export const SOURCE_ORDER = Object.freeze(['settings', 'env', 'vault'])

/** 保险库文件名前缀；完整名是 `.qoder-accounts.<region>.json`。 */
export const VAULT_PREFIX = '.qoder-accounts'

/** 保险库格式版本。字段语义变了才升，加字段不升。 */
export const VAULT_FORMAT_VERSION = 1

const MAX_PAT_LENGTH = 512
const MAX_LABEL_LENGTH = 64

/** @param {unknown} value */
export function isRegion(value) {
  return typeof value === 'string' && Object.hasOwn(REGIONS, value)
}

/**
 * 断言区域合法。
 *
 * 这里刻意不设默认值：跨区记错账号的代价（模型全不在、计费翻倍）远大于
 * 一次参数缺失的报错。
 *
 * @param {unknown} region
 * @returns {'cn'|'global'}
 */
export function requireRegion(region) {
  if (isRegion(region)) return /** @type {'cn'|'global'} */ (region)
  throw Object.assign(
    new Error(`region 必须是 'cn' 或 'global'（收到 ${JSON.stringify(region ?? null)}）：两个区域账号体系不互通`),
    { code: 'REGION_REQUIRED' },
  )
}

/**
 * 从 PAT 单向派生账号 id。
 *
 * @param {string} pat
 * @returns {string} `pat-<sha256 前 16 位十六进制>`
 */
export function qoderAccountId(pat) {
  return `pat-${createHash('sha256').update(String(pat ?? ''), 'utf8').digest('hex').slice(0, 16)}`
}

/**
 * 派生 id 的形态检查（面板/CLI 收到 id 时用来区分「id」与「误粘进来的 PAT」）。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isQoderAccountId(id) {
  return /^pat-[0-9a-f]{16}$/.test(String(id ?? ''))
}

/**
 * PAT 打码：前 4 后 4，中间固定四个星号。
 *
 * 短令牌前后各留 4 位就等于全文，所以 8 位及以下只留前 2 位。
 *
 * @param {unknown} pat
 * @returns {string}
 */
export function maskPat(pat) {
  const raw = typeof pat === 'string' ? pat : ''
  if (raw === '') return ''
  if (raw.length <= 8) return `${raw.slice(0, 2)}****`
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`
}

/**
 * DSH home 的解析：`$DSH_HOME` 优先，否则 `~/.dsh`。
 *
 * 与 `src/store.js` 的 `resolveDshHome` 同口径，但这一层不吃 `process.env`
 * 的默认值，方便测试把 env 整个替换掉。
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

/**
 * 某区域的保险库路径。
 *
 * @param {string} home - DSH home（不是插件数据目录：上游插件把它放在 home 根下）
 * @param {'cn'|'global'} region
 * @returns {string}
 */
export function vaultPath(home, region) {
  return path.join(home, `${VAULT_PREFIX}.${requireRegion(region)}.json`)
}

/**
 * 环境变量里的 PAT（空串表示没配）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {'cn'|'global'} region
 * @returns {string}
 */
export function envPat(env, region) {
  const name = REGIONS[requireRegion(region)].envName
  const value = typeof env?.[name] === 'string' ? env[name].trim() : ''
  return value
}

/**
 * 清洗一条记录。id 永远重算，不信任文件里写的那一个。
 *
 * @param {unknown} row
 * @returns {{id: string, label: string, pat: string, addedAt: number}|null}
 */
function normalizeAccount(row) {
  if (!row || typeof row !== 'object') return null
  const source = /** @type {{pat?: unknown, label?: unknown, addedAt?: unknown}} */ (row)
  const pat = typeof source.pat === 'string' ? source.pat.trim() : ''
  if (pat === '' || pat.length > MAX_PAT_LENGTH) return null
  const label = typeof source.label === 'string' ? source.label.trim().slice(0, MAX_LABEL_LENGTH) : ''
  return { id: qoderAccountId(pat), label, pat, addedAt: Number(source.addedAt) || 0 }
}

/**
 * 去掉重复 PAT（保留最早那条），顺带给出「文件坏了」这个事实而不是静默当空库。
 *
 * @param {unknown[]} rows
 * @returns {{id: string, label: string, pat: string, addedAt: number}[]}
 */
function dedupeAccounts(rows) {
  const seen = new Map()
  for (const row of rows) {
    const account = normalizeAccount(row)
    if (account === null) continue
    // 同一 PAT 出现两次时保留 addedAt 更早的那条：它才是「第一次加进来」的时间
    const known = seen.get(account.id)
    if (known === undefined) seen.set(account.id, account)
    else if (account.addedAt > 0 && (known.addedAt === 0 || account.addedAt < known.addedAt)) known.addedAt = account.addedAt
  }
  return [...seen.values()]
}

/**
 * 读一个区域的保险库。
 *
 * 坏文件不当成「没有账号」而是带 `damaged` 返回：面板要能说出「这个文件读不动」，
 * 否则用户会以为自己的账号凭空消失了。
 *
 * @param {string} home
 * @param {'cn'|'global'} region
 */
export async function readVault(home, region) {
  const file = vaultPath(home, region)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return { version: VAULT_FORMAT_VERSION, file, accounts: dedupeAccounts(rows), damaged: false, error: '' }
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') {
      return { version: VAULT_FORMAT_VERSION, file, accounts: [], damaged: false, error: '' }
    }
    return {
      version: VAULT_FORMAT_VERSION,
      file,
      accounts: [],
      damaged: true,
      error: String(/** @type {{message?: unknown}} */ (error)?.message ?? error).slice(0, 200),
    }
  }
}

/**
 * 原子写一个区域的保险库。
 *
 * @param {string} home
 * @param {'cn'|'global'} region
 * @param {unknown[]} accounts
 */
export async function writeVault(home, region, accounts) {
  const rows = dedupeAccounts(Array.isArray(accounts) ? accounts : [])
  const target = vaultPath(home, region)
  await mkdir(home, { recursive: true, mode: 0o700 })
  // 随机后缀而不是 pid+时间戳：同一毫秒内的两次写会算出同一个临时名，
  // 输的那次 rename 会把赢家的字节发布出去（或直接失败并留下垃圾文件）。
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(
    {
      version: VAULT_FORMAT_VERSION,
      accounts: rows.map(row => ({ id: row.id, label: row.label, pat: row.pat, addedAt: row.addedAt })),
    },
    null,
    2,
  )}\n`
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {}
    throw error
  }
  // rename 不改变权限位，但一个「事先存在、权限更宽」的目标文件会保留旧权限，
  // 所以落盘后再压一次。
  try {
    await chmod(target, 0o600)
  } catch {}
  return { version: VAULT_FORMAT_VERSION, file: target, accounts: rows }
}

/**
 * 设置卡片里的 PAT 字段摊平成行。
 *
 * 接受三种写法，因为设置卡片是分区域两份表单，而有些调用方只给一份：
 *   `{ cn: 'pt-…', global: 'pt-…' }`
 *   `{ cn: { pat: 'pt-…', label: '主号' }, … }`
 *   `{ pat: 'pt-…', region: 'cn', label: '主号' }`
 *
 * @param {unknown} settings - 对象，或返回对象的函数（宿主配置是活的对象）
 * @returns {{pat: string, region: 'cn'|'global', label?: string}[]}
 */
function settingsRows(settings) {
  let value = settings
  if (typeof settings === 'function') {
    try {
      value = settings()
    } catch {
      value = undefined
    }
  }
  if (!value || typeof value !== 'object') return []
  const out = []
  for (const region of REGION_IDS) {
    const entry = /** @type {Record<string, unknown>} */ (value)[region]
    if (typeof entry === 'string') out.push({ pat: entry, region })
    else if (entry && typeof entry === 'object') {
      const row = /** @type {{pat?: unknown, label?: unknown}} */ (entry)
      if (typeof row.pat === 'string') {
        out.push({ pat: row.pat, region, label: typeof row.label === 'string' ? row.label : '' })
      }
    }
  }
  const flat = /** @type {{pat?: unknown, region?: unknown, label?: unknown}} */ (value)
  if (typeof flat.pat === 'string' && isRegion(flat.region)) {
    out.push({ pat: flat.pat, region: /** @type {'cn'|'global'} */ (flat.region), label: typeof flat.label === 'string' ? flat.label : '' })
  }
  return out
}

/**
 * 把一个区域的三路来源按 id 合并。
 *
 * 输出行带 `pat`（明文）——调用方要么就地打码，要么自己承担明文外流的责任；
 * `createQoder()` 那一层的 `list()/status()` 全部打码，只有真正要发请求的
 * 装配层才该用这里的明文。
 *
 * @param {object} options
 * @param {string} options.home - DSH home
 * @param {Record<string, string|undefined>} [options.env]
 * @param {unknown} [options.settings] - 设置卡片里的 PAT 字段
 * @param {'cn'|'global'} options.region
 * @returns {Promise<{region: 'cn'|'global', file: string, damaged: boolean, error: string, accounts: {id: string, region: 'cn'|'global', pat: string, label: string, addedAt: number, source: 'settings'|'env'|'vault', sources: string[]}[]}>}
 */
export async function resolveAccounts({ home, env = process.env, settings, region } = /** @type {any} */ ({})) {
  const target = requireRegion(region)
  const vault = await readVault(home, target)
  const tiers = [
    ['settings', settingsRows(settings).filter(row => row.region === target)],
    ['env', envPat(env, target) === '' ? [] : [{ pat: envPat(env, target), region: target }]],
    ['vault', vault.accounts],
  ]

  /** @type {Map<string, {id: string, region: 'cn'|'global', pat: string, label: string, addedAt: number, source: 'settings'|'env'|'vault', sources: string[]}>} */
  const merged = new Map()
  for (const [source, rows] of tiers) {
    for (const row of /** @type {{pat: string, label?: string, addedAt?: number}[]} */ (rows)) {
      const pat = typeof row.pat === 'string' ? row.pat.trim() : ''
      if (pat === '' || pat.length > MAX_PAT_LENGTH) continue
      const id = qoderAccountId(pat)
      const known = merged.get(id)
      if (known !== undefined) {
        // 低优先级来源只贡献「这个账号还从这儿见过」，不改 primary
        known.sources.push(source)
        if (known.label === '' && typeof row.label === 'string' && row.label !== '') known.label = row.label.trim().slice(0, MAX_LABEL_LENGTH)
        continue
      }
      merged.set(id, {
        id,
        region: target,
        pat,
        label: typeof row.label === 'string' ? row.label.trim().slice(0, MAX_LABEL_LENGTH) : '',
        addedAt: Number(row.addedAt) || 0,
        source: /** @type {'settings'|'env'|'vault'} */ (source),
        sources: [source],
      })
    }
  }

  // 顺序是稳定的：先按来源优先级，再按写入时间，最后按 id
  const rank = source => SOURCE_ORDER.indexOf(source)
  const accounts = [...merged.values()].sort(
    (a, b) => rank(a.source) - rank(b.source) || a.addedAt - b.addedAt || a.id.localeCompare(b.id),
  )
  return { region: target, file: vault.file, damaged: vault.damaged, error: vault.error, accounts }
}
