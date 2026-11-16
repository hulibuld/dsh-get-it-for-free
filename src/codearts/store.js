/**
 * CodeArts 账号库：一个账号一条记录，键由 `accountKeyOf`（src/codearts/oauth.js）给出，
 * 优先 userId，退到 refresh_token / 公钥指纹，最后才是临时键。
 *
 * 为什么不用 accessKeyId 当键：STS 临时凭据每次续期都会换一对新 AK/SK，
 * 拿它当键的结果是「同一个账号每次续期都多出一个账号」。而且 STS 并不保证回 userId，
 * 所以键必须能从凭据本身重新算出来（见 oauth.js 的 accountKeyOf）。
 *
 * 为什么自己写原子落盘、不复用 src/store.js：那个 JsonStore 是宿主整套设置的持有者，
 * 会合默认值、节流写盘，而且文件权限跟着设置走；账号库必须 0600 且写失败的语义是
 * 「这次登录作废」，不是「稍后重试」。
 *
 * 为什么 tmp 名带 pid + 随机：登录回调和后台续期会同时写同一个文件。共用一个
 * `${file}.tmp` 时，先完成的 rename 会把 tmp 挪走，后一个 rename 就 ENOENT
 * —— 表现是「登录成功但账号没了」。上游踩过，这里照抄这个结论。
 *
 * @module src/codearts/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 文件放在 DSH home 根下，和上游 dsh-codearts 同名同位置：换插件不丢账号。 */
export const ACCOUNTS_FILENAME = '.codearts-accounts.json'

/**
 * 老版本 dsh-codearts 的单账号文件（见 docs-merge/codearts.md §E8）。
 * 只读不写不删：迁移只往新库搬一份，旧文件留给用户自己决定要不要清。
 */
export const LEGACY_AUTH_FILENAME = '.codearts-auth.json'

/**
 * 结构版本。字段语义变了才升。
 *
 * 加字段不升：`normalizeAccount` 是「展开原对象再覆盖已知字段」，
 * 它不认识的字段（包括以后才加的）原样穿过读写，不会在第一次写盘时被抹掉。
 */
export const FILE_VERSION = 1

/**
 * DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`。
 *
 * env 可注入，测试不必动真机目录；也避免这一层偷偷读 process.env 之外的东西。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

/**
 * @param {string} home
 * @returns {string}
 */
export function accountsFile(home) {
  return path.join(home, ACCOUNTS_FILENAME)
}

/**
 * @param {string} home
 * @returns {string}
 */
export function legacyAuthFile(home) {
  return path.join(home, LEGACY_AUTH_FILENAME)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 清洗一条账号。字段名全 camel：这份文件是我们自己的，不需要兼容上游的蛇形写法。
 *
 * 「可用」的判定故意宽松——只要还能拿去签名（AK/SK/token 三件套齐）或者还能续期，
 * 就留着。续期失败要留下 stale 标记让面板说得清，而不是把账号删掉；
 * 删了用户就得重新走一遍浏览器授权。
 *
 * @param {unknown} row
 * @returns {null | {userId: string, userName: string, domainId: string, label: string, token: string, accessKeyId: string, secretAccessKey: string, expiration: string, refreshToken: string, dpopPrivateKey: null | {kty: string, crv: string, x: string, y: string, d: string}, clientId: string, storedAt: number, stale: boolean, paused: boolean, pinned: boolean}}
 */
export function normalizeAccount(row) {
  if (row === null || typeof row !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (row)
  const userId = text(source.userId)
  if (userId === '') return null
  const token = text(source.token) || text(source.securityToken)
  const accessKeyId = text(source.accessKeyId)
  const secretAccessKey = text(source.secretAccessKey)
  const refreshToken = text(source.refreshToken)
  const hasSigning = token !== '' && accessKeyId !== '' && secretAccessKey !== ''
  if (!hasSigning && refreshToken === '') return null
  const key = source.dpopPrivateKey
  const dpopPrivateKey =
    key !== null && typeof key === 'object' &&
    typeof (/** @type {Record<string, unknown>} */ (key).d) === 'string'
      ? /** @type {{kty: string, crv: string, x: string, y: string, d: string}} */ ({
          kty: String(/** @type {any} */ (key).kty ?? 'EC'),
          crv: String(/** @type {any} */ (key).crv ?? 'P-256'),
          x: String(/** @type {any} */ (key).x ?? ''),
          y: String(/** @type {any} */ (key).y ?? ''),
          d: String(/** @type {any} */ (key).d),
        })
      : null
  const userName = text(source.userName)
  // 展开原对象再覆盖已知字段：写盘会过这道清洗，若在这里白名单重建，
  // paused / pinned 以及以后加的字段就会在第一次写盘时被抹掉（注释说的「原样保留」也就成了假话）。
  /** @type {Record<string, unknown>} */
  const clean = {}
  for (const [name, value] of Object.entries(source)) {
    // `__proto__` 从 JSON 里进来是 own property，再铺一次就成了原型。
    if (name === '__proto__') continue
    clean[name] = value
  }
  return {
    ...clean,
    userId,
    userName,
    domainId: text(source.domainId),
    label: text(source.label) || userName || userId,
    token,
    accessKeyId,
    secretAccessKey,
    expiration: text(source.expiration),
    refreshToken,
    dpopPrivateKey,
    clientId: text(source.clientId),
    storedAt: Number(source.storedAt) || 0,
    // 这两个是行为开关（暂停续期 / 置顶轮转），面板只会按布尔读，
    // 落盘值若是 "false" 字符串会被当成真，所以显式归一。
    stale: source.stale === true,
    paused: source.paused === true,
    pinned: source.pinned === true,
  }
}

/**
 * 读老版单账号文件（`.codearts-auth.json`）。只读，永不写、永不删。
 *
 * 为什么迁移值得做：用户机器上若已经有旧插件的登录，读不到就意味着要重走一遍
 * 浏览器授权；而旧文件的结构就是一条 credential，键名与新库一致（§E8）。
 *
 * @param {string} home
 * @returns {Promise<null | Record<string, any>>}
 */
async function readLegacyAccount(home) {
  let raw
  try {
    raw = await readFile(legacyAuthFile(home), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  /** @type {Record<string, any>} */
  const row = { ...parsed }
  if (text(row.userId) === '') {
    // 旧文件理论上带 userId；万一没有，只能用临时 AK 派生一个（§E8 的迁移兜底）。
    const ak = text(row.accessKeyId)
    if (ak === '') return null
    row.userId = `ak-${createHash('sha256').update(ak).digest('hex').slice(0, 16)}`
  }
  return normalizeAccount(row)
}

/**
 * 读账号库。
 *
 * 坏文件不当空库静默返回，而是带 `damaged` 上报：账号凭空消失比报错更让人困惑，
 * 而调用方（面板/登录流程）需要知道「现在写回会不会把别人覆盖掉」。
 *
 * 「坏」包括形状不对：合法 JSON 但顶层是 null / 数组，或 accounts 不是对象。
 * 这些以前会被当成「空库且完好」，紧接着一次登录把整份读空的文档写回，
 * 同文件里其它账号就被静默清空——比解析失败更危险，因为它不报错。
 *
 * 单行字段残缺（缺 userId、三件套与 refreshToken 全空）不算「坏库」：
 * 那种行本来就不可用，拦下来会让正常登录也失败。但静默丢掉同样是数据丢失，
 * 所以用 `skipped` 报出被跳过的行数，调用方写回前打一条 warn。
 *
 * @param {string} home
 * @returns {Promise<{file: string, version: number, order: string[], accounts: Record<string, any>, damaged: boolean, error: string, skipped: number}>}
 */
export async function readAccounts(home) {
  const file = accountsFile(home)
  const empty = { file, version: FILE_VERSION, order: /** @type {string[]} */ ([]), accounts: /** @type {Record<string, any>} */ ({}), damaged: false, error: '', skipped: 0 }
  let raw = ''
  let exists = true
  let skipped = 0
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') {
      return { ...empty, damaged: true, error: String(/** @type {{message?: unknown}} */ (error)?.message ?? error).slice(0, 200) }
    }
    exists = false
  }

  /** @type {Record<string, any>} */
  const accounts = {}
  let order = /** @type {string[]} */ ([])

  if (exists) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { ...empty, damaged: true, error: `JSON 解析失败：${String(/** @type {{message?: unknown}} */ (error)?.message ?? error).slice(0, 160)}` }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...empty, damaged: true, error: `账号库形状不对：顶层是 ${Array.isArray(parsed) ? '数组' : parsed === null ? 'null' : typeof parsed}，不是对象` }
    }
    const rawVersion = /** @type {{version?: unknown}} */ (parsed).version
    const version = rawVersion === undefined ? FILE_VERSION : Number(rawVersion)
    if (!Number.isFinite(version) || version !== FILE_VERSION) {
      return { ...empty, version: Number.isFinite(version) ? version : FILE_VERSION, damaged: true, error: `账号库版本 ${String(rawVersion)} 不是本插件支持的 ${FILE_VERSION}` }
    }
    const source = /** @type {{accounts?: unknown}} */ (parsed).accounts
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      return { ...empty, damaged: true, error: `账号库形状不对：accounts 是 ${Array.isArray(source) ? '数组' : source === null ? 'null' : typeof source}，不是对象` }
    }
    for (const [key, row] of Object.entries(source)) {
      // 用 own key 重新建对象，而不是把解析结果直接铺开：`__proto__` 之类的键
      // 从 JSON 里进来时是 own property，再铺一次就成了原型。
      if (key === '__proto__') continue
      const account = normalizeAccount(row)
      if (account === null) {
        skipped += 1
        continue
      }
      accounts[key] = account
    }
    const rawOrder = /** @type {{order?: unknown}} */ (parsed).order
    order = Array.isArray(rawOrder)
      ? rawOrder.map(value => text(value)).filter(id => id !== '' && Object.hasOwn(accounts, id))
      : []
  }

  if (!exists) {
    // 只在「新库根本不存在」时看旧文件。
    // 不按「accounts 为空」判断，是因为用户删掉最后一个账号后文件里就是空 accounts，
    // 那时再迁一次会把刚删的账号变回来——迁移只该发生一次。
    const legacy = await readLegacyAccount(home)
    if (legacy !== null) {
      accounts[legacy.userId] = legacy
      order = [legacy.userId]
      // 一次性迁移。旧文件保持原样（不写不删）；写新库失败也不影响这次返回，
      // 下次读还会再看到旧文件、再试一次。
      try {
        await writeAccounts(home, { order, accounts })
      } catch {}
    }
  }

  return { file, version: FILE_VERSION, order, accounts, damaged: false, error: '', skipped }
}

/**
 * 原子写账号库。返回写进去的那份文档，方便调用方直接当快照用。
 *
 * @param {string} home
 * @param {{order?: string[], accounts?: Record<string, unknown>}} doc
 * @returns {Promise<{file: string, version: number, order: string[], accounts: Record<string, any>}>}
 */
export async function writeAccounts(home, doc) {
  const file = accountsFile(home)
  /** @type {Record<string, any>} */
  const accounts = {}
  for (const [key, row] of Object.entries(doc?.accounts ?? {})) {
    if (key === '__proto__') continue
    const account = normalizeAccount(row)
    if (account !== null) accounts[key] = account
  }
  const order = Array.isArray(doc?.order)
    ? doc.order.map(value => text(value)).filter((id, index, all) => id !== '' && Object.hasOwn(accounts, id) && all.indexOf(id) === index)
    : []
  for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify({ version: FILE_VERSION, order, accounts }, null, 2)}\n`
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, file)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {}
    throw error
  }
  // rename 不改权限位：目标文件如果先前存在且更宽，会带着旧权限留下来。
  try {
    await chmod(file, 0o600)
  } catch {}
  return { file, version: FILE_VERSION, order, accounts }
}
