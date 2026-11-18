/**
 * 千问办公凭据：跨平台的那一条路。
 *
 * 上游 vendored 的 `credentials.js` 走的是一条**只存在于 Windows**的路 ——
 * 读桌面端 Chromium 的 `Local State` → `os_crypt.encrypted_key` → DPAPI
 * 解出主密钥 → 解 `auth-v2.dat`。在 macOS / Linux 上 `dpapi.js` 直接抛
 * 「凭据解密仅支持 Windows DPAPI」，整条渠道等于死的。
 *
 * 所以这里补一条跟平台无关的路：device flow 登录把凭据以明文 JSON 落在
 * `~/.dsh/qwenwork-desktop.json`（字段契约见 `login-device-flow.js` 的
 * `writeCredential`），token 过期就用 refresh_token 换一次并回写。
 *
 * 顺序：先看本地 device-flow 文件（新、可控、写完就是一份）；没有才退回
 * 上游那条 Windows 路径（Windows 上桌面端登录过的人可以零操作直接用）。
 *
 * @module src/qwenwork/local-credentials.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { requestTokenRefresh } from './auth.js'
import { decodeJwt, resolveCredentialPath } from './login-device-flow.js'
import { isTokenExpired } from './credentials.js'

/** 提前量：token 还剩不到 2 分钟就当作过期，别把一次请求赌在边界上。 */
const EXPIRY_SKEW_MS = 120_000

/** 相对某份凭据的绝对路径。 */
export function credentialPathOf(explicit) {
  return resolveCredentialPath(explicit)
}

/** 读本地文件；不存在或读坏了都返回 undefined（不抛）。 */
export function readLocalCredential(explicit) {
  const file = credentialPathOf(explicit)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const raw = JSON.parse(text)
    if (typeof raw?.token !== 'string' || raw.token === '') return undefined
    return { ...raw, file }
  } catch {
    return undefined
  }
}

/** 把刷新后的 token 写回同一份文件，保留原有其它字段（user 等）。 */
function writeBack(file, previous, refreshed) {
  const next = {
    ...previous,
    token: refreshed.token,
    refreshToken: refreshed.refreshToken ?? previous.refreshToken,
    expiresAt: refreshed.expiresAt ?? previous.expiresAt,
    refreshedAt: new Date().toISOString(),
  }
  delete next.file
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  } catch {
    /* 回写失败不影响本次使用：内存里的 token 还是新的 */
  }
  return next
}

/**
 * 拿一份能直接用的凭据：必要时刷新。
 *
 * @param explicit - 显式指定的凭据文件路径（测试用）。
 * @returns `{ token, refreshToken, expiresAt, user, source }`，或 undefined。
 */
export async function getLocalCredential(explicit) {
  const held = readLocalCredential(explicit)
  if (held === undefined) return undefined
  if (isTokenExpired(held, EXPIRY_SKEW_MS) !== true) return held
  if (typeof held.refreshToken !== 'string' || held.refreshToken === '') return held

  try {
    const refreshed = await requestTokenRefresh(held.refreshToken)
    if (typeof refreshed?.token === 'string' && refreshed.token !== '') {
      return writeBack(held.file, held, refreshed)
    }
  } catch {
    /* 刷新失败就交回原凭据：上游会给 401，那条错误比这里的更准确 */
  }
  return held
}

/** 账号显示名：先在本地解 JWT，不为了一个名字打一次网络。 */
export function describeHold(credential) {
  if (credential === undefined || credential === null) return undefined
  const user = credential.user ?? {}
  let claims = {}
  try {
    claims = credential.token === undefined ? {} : decodeJwt(credential.token)
  } catch {
    claims = {}
  }
  const name = user.name ?? user.username ?? claims.username ?? claims.email ?? user.email
  const email = user.email ?? claims.email
  const text = typeof name === 'string' && name !== '' ? name : undefined
  return {
    name: text,
    email: typeof email === 'string' && email !== '' ? email : undefined,
    source: credential.source ?? 'desktop-app',
    expiresAt: credential.expiresAt ?? undefined,
  }
}

/** 删掉本地凭据（退出登录）。 */
export function clearLocalCredential(explicit) {
  const file = credentialPathOf(explicit)
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 目录是否可写 —— 登录前先确认一次，省得登录完写不进去。 */
export function credentialDirWritable(explicit) {
  const dir = path.dirname(credentialPathOf(explicit))
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export const CREDENTIAL_HOME = path.join(os.homedir(), '.dsh')
