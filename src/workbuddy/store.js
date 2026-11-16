/**
 * WorkBuddy 账号库：从桌面端 auth 文件里扫出来的账号，落到本插件自己的文件。
 *
 * 为什么不复用 src/store.js 那个 JsonStore：那一份是「宿主整套设置」的持有者，
 * 会在启动时合并默认值、做节流写盘；账号库只需要读-改-写三步，而且必须保证
 * 0600（里面有 accessToken/refreshToken），所以走独立的原子写。
 *
 * 文件位置跟着 $DSH_HOME 走，和插件其他数据同一个目录：用户备份/迁移一个目录
 * 就搬走了全部凭据，不会漏。
 *
 * @module src/workbuddy/store
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR_NAME } from '../store.js'

/** 文件名固定：桌面端的东西我们只读，自己的东西只有一个落点，不给用户配。 */
export const ACCOUNTS_FILENAME = 'workbuddy-accounts.json'

/** 形状变了就抬版本，读到更高版本时按空库处理而不是猜字段。 */
const FILE_VERSION = 1

function homeOf(env) {
  const home = typeof env?.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME.trim() : ''
  if (home !== '') return home
  const profile = typeof env?.USERPROFILE === 'string' ? env.USERPROFILE.trim() : ''
  return profile !== '' ? profile : os.homedir()
}

/** 账号库的绝对路径。`env` 可注入，测试不必摸真机。 */
export function accountsPath(env = process.env) {
  const dshHome = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = dshHome !== '' ? dshHome : path.join(homeOf(env), '.dsh')
  return path.join(home, DATA_DIR_NAME, ACCOUNTS_FILENAME)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 一行账号。没 id 或没 token 的行一律丢掉 —— 它们既不能用，也会在列表里
 * 表现为一个点不动的空账号。
 */
function normalizeAccount(row) {
  if (row === null || typeof row !== 'object') return null
  const id = text(row.id)
  const accessToken = text(row.accessToken)
  if (id === '' || accessToken === '') return null
  return {
    id,
    nickname: text(row.nickname) || `WorkBuddy ${id}`,
    authFile: text(row.authFile),
    uin: text(row.uin),
    accessToken,
    refreshToken: text(row.refreshToken),
    savedAt: Number(row.savedAt) || 0,
  }
}

/**
 * 读账号库。坏文件当空库读：下次写入会整份覆盖，不至于让发现/导入整条链
 * 因为一行坏 JSON 直接抛出去。
 */
export async function readAccounts(env = process.env) {
  try {
    const raw = await readFile(accountsPath(env), 'utf8')
    const parsed = JSON.parse(raw)
    if (Number(parsed?.version) > FILE_VERSION) return []
    const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return rows.map(normalizeAccount).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 整份写回。tmp + rename 是因为崩在中间会留下半个 JSON，而这是用户唯一的
 * 登录态副本；随机后缀是因为同一毫秒内两次写盘会算出同一个 tmp 路径，
 * 后一个 rename 会把前一个的字节顶掉。
 */
export async function writeAccounts(env, accounts) {
  const rows = (Array.isArray(accounts) ? accounts : []).map(normalizeAccount).filter(Boolean)
  const target = accountsPath(env)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify({ version: FILE_VERSION, accounts: rows, updatedAt: Date.now() }, null, 2)}\n`
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    // 留着 half-written 的临时文件等于把 token 复制了一份且没人管。
    try {
      await unlink(tmp)
    } catch {}
    throw error
  }
  // rename 保留的是 tmp 自己的权限，但某些文件系统（以及预先存在的目标文件）
  // 会让结果带上别处来的位，所以再压一次。
  try {
    await chmod(target, 0o600)
  } catch {}
  return rows
}
