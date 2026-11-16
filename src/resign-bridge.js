// 给 billion-context（bili）递签名凭据 —— 让 CodeArts 这条链路重新可压缩。
//
// 背景：CodeArts 用的是 SDK-HMAC-SHA256，签名把请求体也盖住了。bili 想压缩
// 上下文就必须改 body，改了签名就废，于是它只有两条路：拿凭据自己重签，或者
// 拒绝转发（403 signed_request_requires_resign）。我们 3.0.38 把出网口改到宿主
// fetch 之后，CodeArts 的请求第一次真的被 bili 看见了，也就第一次撞上这堵墙；
// 当时用 bili 的 passthrough 配置绕过（该链路不压缩）。
//
// bili 找凭据的位置是写死的（dist/agent/dsh-native.js 的 codeartsRefCandidates）：
//   ① 全局配置 resign.credentialRef 里钉一个 ref；或者
//   ② <DSH_HOME>/jet-hub/state.json 的 accounts[] 里 provider==='codearts'、
//      enabled!==false、credentialRef 非空的条目。
// 然后它对每个 ref 调宿主的 credentials.resolve(ref)，把值按 JSON 解析出
// access_key_id / secret_access_key / security_token，并用请求头里的 AK 去匹配
// 是哪一号账号（多账号必须逐个对上，否则重签出来是别人的身份，上游照样 401）。
//
// 所以这里做的事只有一件：把本插件 state.json 里的 CodeArts 账号镜像到
// jet-hub/state.json，让 bili 扫得到。不复制密钥本体（凭据仍在 DSH 的凭据库里，
// 它自己按 ref 去解），不替它重签，也不改它的判断逻辑。
//
// 注意：bili 每次请求都会重新扫这个文件，所以同步完不需要重启宿主。

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const BRIDGE_PROVIDER = 'codearts'
const BRIDGE_SOURCE = 'get-it-for-free'

/** 宿主数据根目录；与 pack.js 用的是同一套约定。 */
export function defaultDshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : ''
  return fromEnv !== '' ? fromEnv : path.join(homedir(), '.dsh')
}

export function channelPackStatePath(dshHome) {
  return path.join(dshHome, 'channel-pack', 'state.json')
}

export function jetHubStatePath(dshHome) {
  return path.join(dshHome, 'jet-hub', 'state.json')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 本插件里可拿去重签的 CodeArts 账号。
 *
 * 只认三件事：provider 是 codearts、没被停用、有 credentialRef。其余字段
 * （昵称、过期时间、限流时间戳）bili 不看，但带上昵称能让 /__bili/ 的列表
 * 显示成人能读的名字。
 */
export async function readBridgeCandidates(dshHome) {
  const state = await readJson(channelPackStatePath(dshHome))
  const rows = Array.isArray(state?.accounts) ? state.accounts : []
  const out = []
  for (const row of rows) {
    if (row?.provider !== BRIDGE_PROVIDER) continue
    if (row?.enabled === false) continue
    const ref = typeof row?.credentialRef === 'string' ? row.credentialRef.trim() : ''
    if (ref === '') continue
    out.push({
      id: String(row.id ?? ref),
      nickname: typeof row.nickname === 'string' && row.nickname !== '' ? row.nickname : String(row.id ?? ref),
      credentialRef: ref,
    })
  }
  return out
}

/**
 * 把账号镜像进 bili 要读的那个文件。
 *
 * 合并而不是覆盖：jet-hub 若真的存在（别处装的插件在用它），它的条目一个不动，
 * 我们只替换 provider==='codearts' 那几条 —— 那几条本来就是这个插件自己的账号，
 * 停用或删掉之后也应该跟着消失，否则 bili 会拿死凭据去重签。
 */
export async function syncResignAccounts({ dshHome = defaultDshHome(), logger } = {}) {
  const candidates = await readBridgeCandidates(dshHome)
  const file = jetHubStatePath(dshHome)
  const existing = (await readJson(file)) ?? {}
  const accounts = Array.isArray(existing.accounts) ? existing.accounts : []
  const foreign = accounts.filter(row => row?.provider !== BRIDGE_PROVIDER)
  const mirrored = candidates.map(row => ({
    id: row.id,
    provider: BRIDGE_PROVIDER,
    nickname: row.nickname,
    enabled: true,
    credentialRef: row.credentialRef,
    source: BRIDGE_SOURCE,
  }))
  const next = { ...existing, version: existing.version ?? 1, accounts: [...foreign, ...mirrored] }

  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)

  const summary = { at: Date.now(), path: file, accounts: mirrored.length, refs: mirrored.map(row => row.credentialRef) }
  logger?.info?.(`get-it-for-free: resign bridge synced ${mirrored.length} codearts account(s) -> ${file}`)
  return summary
}

export function createResignBridge({ logger, dshHome = defaultDshHome() } = {}) {
  let last = undefined
  let running = undefined
  let lastError = ''

  const status = async () => {
    let candidates = []
    try {
      candidates = await readBridgeCandidates(dshHome)
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 200)
    }
    return {
      path: jetHubStatePath(dshHome),
      candidates: candidates.map(row => ({ id: row.id, nickname: row.nickname, credentialRef: row.credentialRef })),
      last: last ?? null,
      error: lastError !== '' ? lastError : null,
    }
  }

  return {
    status,
    // 同步失败不该把宿主启动拖下水：bili 拿不到凭据只会退回它的 passthrough 判断。
    sync: () => {
      if (running !== undefined) return running
      running = syncResignAccounts({ dshHome, logger })
        .then(summary => {
          last = summary
          lastError = ''
          return summary
        })
        .catch(error => {
          lastError = String(error?.message ?? error).slice(0, 200)
          logger?.warn?.(`get-it-for-free: resign bridge sync failed: ${lastError}`)
          return { at: Date.now(), path: jetHubStatePath(dshHome), accounts: 0, refs: [], error: lastError }
        })
        .finally(() => {
          running = undefined
        })
      return running
    },
  }
}
