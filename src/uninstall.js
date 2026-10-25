/**
 * 卸载自己。
 *
 * 用户在风险告知页按「删除该插件并退出」时，这个模块负责把这台机器上的本插件
 * 摘干净。分两步，**顺序不能反**：
 *
 *  1. `uninstallPlugin()` —— 同步、可回滚：先备份清单，再从 profile 的
 *     package.json 里删掉依赖项与 bundle 条目，并关闭插件设置。做完这些再
 *     回 HTTP 200，用户至少能看见「成功」再来收尾。
 *  2. `spawnDetachedRemoval()` —— 异步、必须在响应之后：删包目录本身。
 *     此刻插件代码还在内存里跑，删目录不能和请求抢同一段时间，所以交给一个
 *     detach 的 shell 脚本，睡一会儿再删，删完顺手退出 App。
 *
 * 数据目录（`~/.dsh/get-it-for-free`：设置、统计、备份）**保留**——里面有用户
 * 的历史与回滚点，删掉插件不等于要删掉这些东西。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** profile 根目录：包目录是 `<profile>/node_modules/<pkg>`。 */
function profileDirOf(packageDir) {
  return path.dirname(path.dirname(packageDir))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * 把依赖项与 bundle 条目从 profile 清单里去掉。
 * 用文本手术而不是整份重排 JSON：清单是用户资产，别让一次卸载把 33 个 bundle
 * 的排版全部洗一遍。
 */
function stripManifest(manifestPath) {
  const original = fs.readFileSync(manifestPath, 'utf8')
  const removed = []
  let text = original

  // 依赖项：删掉整行 `"dsh-get-it-for-free": "…",`
  const depPattern = /^[ \t]*"dsh-get-it-for-free"[ \t]*:[ \t]*"[^"]*"[ \t]*,?[ \t]*\r?\n/gm
  if (depPattern.test(text)) {
    removed.push('dependencies.dsh-get-it-for-free')
    text = text.replace(depPattern, '')
  }

  // bundles 数组：删掉 `"dsh-get-it-for-free",` 或没有尾逗号的那一项
  const bundlePattern = /^([ \t]*)"dsh-get-it-for-free"[ \t]*,?[ \t]*\r?\n/gm
  if (bundlePattern.test(text)) {
    removed.push('dsh.profile.bundles[dsh-get-it-for-free]')
    text = text.replace(bundlePattern, '')
  }

  // 数组末尾的悬空逗号（删掉最后一项时会出现）——只有 JSON.parse 报错才修
  if (text !== original) {
    try {
      JSON.parse(text)
    } catch {
      text = text.replace(/,([ \t]*\r?\n[ \t]*\])/g, '$1')
    }
  }

  const parsed = JSON.parse(text) // 还是坏的就在这里抛，调用方负责回滚
  const stillThere = Boolean(parsed?.dependencies?.['dsh-get-it-for-free'])
    || (Array.isArray(parsed?.dsh?.profile?.bundles)
      && parsed.dsh.profile.bundles.includes('dsh-get-it-for-free'))
  if (stillThere) throw new Error('清单里仍然留着 dsh-get-it-for-free')

  return { text, original, removed }
}

/**
 * 第一步：改清单。返回 `{ ok, removed, backup, dataKept }`。
 * 任何一步出错都回滚到调用前的字节，并返回 `{ ok: false, error }`。
 */
export function uninstallPlugin({ packageDir }) {
  const profileDir = profileDirOf(packageDir)
  const manifestPath = path.join(profileDir, 'package.json')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupDir = path.join(profileDir, `.uninstall-dsh-get-it-for-free-${stamp}`)
  const result = { ok: false, removed: [], dataKept: '', backup: '' }

  try {
    if (!fs.existsSync(manifestPath)) throw new Error(`找不到 profile 清单：${manifestPath}`)
    fs.mkdirSync(backupDir, { recursive: true })
    fs.copyFileSync(manifestPath, path.join(backupDir, 'package.json'))
    result.backup = backupDir

    const { text, original, removed } = stripManifest(manifestPath)
    writeFileAtomic(manifestPath, text)
    result.removed = removed

    // 复核：真的读得出来，且条目真的没了
    const after = readJson(manifestPath)
    if (after?.dependencies?.['dsh-get-it-for-free']) throw new Error('依赖项没删掉')
    if (Array.isArray(after?.dsh?.profile?.bundles)
      && after.dsh.profile.bundles.includes('dsh-get-it-for-free')) throw new Error('bundle 条目没删掉')

    result.dataKept = path.join(os.homedir(), '.dsh', 'get-it-for-free')
    result.ok = true
    result.manifest = manifestPath
    void original
    return result
  } catch (error) {
    // 回滚：备份存在就写回去，保证 DSH 下次启动还能正常读清单
    try {
      const backupFile = path.join(backupDir, 'package.json')
      if (fs.existsSync(backupFile)) writeFileAtomic(manifestPath, fs.readFileSync(backupFile, 'utf8'))
    } catch { /* 回滚失败也只能把错误报上去 */ }
    result.error = String(error?.message ?? error)
    return result
  }
}

/** 生成 detach 的 shell 脚本：等一会儿 → 删包目录 → 退出 App。 */
function removalScript({ packageDir, appPid }) {
  const quoted = `'${String(packageDir).replace(/'/g, `'\\''`)}'`
  const appName = 'DeepSeek Harness'
  // 顺序很重要：先让 App 退出，再删目录。
  // 反过来的话，删完目录到进程真正退出之间，宿主还会继续 import/读这个包，
  // 那几秒里会刷出一串 ENOENT 报错，用户看到的就是「怎么突然报错了」。
  const lines = [
    '#!/bin/sh',
    '# 由 dsh-get-it-for-free 的「删除该插件并退出」生成：先退出 App，再删自己。',
    'sleep 1.2',
  ]
  // 优先直接给宿主进程发 SIGTERM：不依赖 macOS 自动化授权（osascript 第一次会弹
  // 「允许控制 DeepSeek Harness 吗」，用户点了拒绝就退不掉）。拿不到 pid 才退回 osascript。
  if (Number.isInteger(appPid) && appPid > 0) {
    lines.push(`kill -TERM ${appPid} >/dev/null 2>&1 || true`)
  }
  if (process.platform === 'darwin') {
    lines.push(`osascript -e 'quit app "${appName}"' >/dev/null 2>&1 || true`)
  } else if (process.platform === 'win32') {
    lines.push(`taskkill /IM "${appName}.exe" /F >/dev/null 2>&1 || true`)
  }
  if (Number.isInteger(appPid) && appPid > 0) {
    lines.push('sleep 3', `kill -KILL ${appPid} >/dev/null 2>&1 || true`)
  }
  lines.push(
    'sleep 1',
    `rm -rf ${quoted}`,
    'rm -f "$0"',
    '',
  )
  return lines.join('\n')
}

/** 第二步：异步删目录。调用方**必须**已经回过 HTTP 响应。 */
export async function spawnDetachedRemoval({ packageDir }) {
  if (!fs.existsSync(packageDir)) return { ok: true, already: true }
  if (!packageDir.includes(`${path.sep}node_modules${path.sep}`)) {
    // 保险：只允许删 node_modules 下的包目录，绝不误删别处
    throw new Error(`拒绝删除非 node_modules 路径：${packageDir}`)
  }
  const scriptPath = path.join(os.tmpdir(), `dsh-uninstall-get-it-for-free-${Date.now()}.sh`)
  fs.writeFileSync(scriptPath, removalScript({ packageDir, appPid: process.pid }), { mode: 0o755 })
  const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, scriptPath }
}
