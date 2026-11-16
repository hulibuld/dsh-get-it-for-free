// 豆包账号库：一个账号一条 cookie，和 WorkBuddy 的多账号是同一个思路——
// 上游只认 cookie，不认「哪个 app 实例」，所以想用几个账号就有几条记录。
//
// 文件 0600，写盘走 tmp + rename，崩在中间不会留下半个 JSON。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FILE_VERSION = 1

export function storePath(home) {
  return path.join(home, 'doubao.json')
}

function emptyStore() {
  return { version: FILE_VERSION, accounts: [], disabledModels: [], roster: [], rosterAt: 0, updatedAt: 0 }
}

// 上一次从上游拉到的模型目录要落盘。原因不是省一次请求，而是宿主的模型选择器
// 在我们「还没拉到目录」的那几秒里会拿到空表，然后记住这个空表 —— 表现就是
// 豆包这一组在右下角彻底不出现，重启才好。留一份快照，冷启动时先给旧的。
function normalizeRoster(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const row of list.slice(0, 200)) {
    if (!row || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '' || id.length > 64) continue
    out.push({
      id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : id,
      contextWindow: Number(row.contextWindow) > 0 ? Number(row.contextWindow) : 0,
      ratio: typeof row.ratio === 'string' ? row.ratio.slice(0, 16) : '',
      // 思考强度菜单也要进快照：选择器那一栏是从这行元数据长出来的，丢了就只能
      // 显示「不支持调思考强度」。level 在上游是数字，这里统一成字符串当菜单 id。
      reasoning: normalizeReasoning(row.reasoning),
      isTaskMode: row.isTaskMode === true,
    })
  }
  return out
}

/** 上游 option_list → `[{level:'3', name:'深度思考'}]`；只留能用的一档，最多 8 条。 */
function normalizeReasoning(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const row of list.slice(0, 8)) {
    const level = String(row?.level ?? '').trim()
    if (level === '' || level.length > 8 || seen.has(level)) continue
    seen.add(level)
    const name = typeof row?.name === 'string' ? row.name.trim().slice(0, 24) : ''
    out.push({ level, name })
  }
  return out
}

function normalizeAccount(row) {
  if (!row || typeof row !== 'object') return null
  const cookieHeader = typeof row.cookieHeader === 'string' ? row.cookieHeader.trim() : ''
  const id = typeof row.id === 'string' && row.id !== '' ? row.id : ''
  if (id === '' || cookieHeader === '') return null
  return {
    id,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : `豆包 ${id}`,
    uid: typeof row.uid === 'string' ? row.uid : '',
    cookieHeader,
    savedAt: Number(row.savedAt) || 0,
    source: typeof row.source === 'string' ? row.source : 'manual',
    enabled: row.enabled !== false,
    lastCheckin: row.lastCheckin && typeof row.lastCheckin === 'object' ? row.lastCheckin : null,
  }
}

function normalizeDisabled(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (id !== '' && id.length <= 64) seen.add(id)
  }
  return [...seen]
}

export async function readStore(home) {
  try {
    const raw = await readFile(storePath(home), 'utf8')
    const parsed = JSON.parse(raw)
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.map(normalizeAccount).filter(Boolean) : []
    return {
      version: FILE_VERSION,
      accounts,
      disabledModels: normalizeDisabled(parsed?.disabledModels),
      roster: normalizeRoster(parsed?.roster),
      rosterAt: Number(parsed?.rosterAt) || 0,
      updatedAt: Number(parsed?.updatedAt) || 0,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore()
    // 坏文件当作空库：下次写盘会覆盖，不至于让整个面板挂掉
    return emptyStore()
  }
}

export async function writeStore(home, store) {
  const next = {
    version: FILE_VERSION,
    accounts: (store.accounts ?? []).map(normalizeAccount).filter(Boolean),
    disabledModels: normalizeDisabled(store.disabledModels),
    roster: normalizeRoster(store.roster),
    rosterAt: Number(store.rosterAt) || 0,
    updatedAt: Date.now(),
  }
  await mkdir(home, { recursive: true })
  const target = storePath(home)
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, target)
  return next
}

export function parseCookieText(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return ''
  // 允许用户直接粘整行 "sessionid=...; sid_tt=..."，也允许粘
  // {"Cookie": "..."} 这类从 devtools 复制出来的片段
  const fromJson = /"cookie"\s*:\s*"([^"]+)"/i.exec(raw)
  const body = fromJson ? fromJson[1] : raw
  return body
    .replace(/\r?\n/g, ' ')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.includes('=') && !part.toLowerCase().startsWith('cookie:'))
    .join('; ')
}
