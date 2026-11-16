// 让 bili（billion-context）和华为云 CodeArts 这条链路共存。
//
// 为什么需要这个文件：CodeArts 的请求是 SDK-HMAC-SHA256 签名的，签名盖住了请求体。
// bili 的契约是「签名的请求要么重签后压缩，要么拒转发」——它没有「原样放行」以外的
// 第三条路。我们实测过重签这条路：bili 自己的 resigner 会把 path 补成以 `/` 结尾、
// 还会给部分模型加 `maas_type: benefit` 头，这两件事上游都不接受（前者签名对不上，
// 后者直接 404），所以重签出来的请求必挂。
//
// 于是唯一稳定的组合是：这条链路不压缩、字节原样放行。这是 bili 官方给的选项，
// 写在它自己的配置文件里（`resign.sdk-hmac-sha256.passthrough = true`）。
// 用户手动改 JSON 容易改坏整份配置，所以这里做一个受控的写入器：只动这一个键，
// 其余内容原样保留，写之前先备份。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCHEME = 'sdk-hmac-sha256'

/** bili 的配置在哪：macOS 走 Application Support 之外的 XDG 目录，其余平台同名。 */
export function defaultBiliConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config')
  return path.join(base, 'billion-context', 'billion-context.json')
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: '配置文件不是 JSON 对象', value: null }
    }
    return { ok: true, reason: '', value: parsed }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, reason: 'missing', value: {} }
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200), value: null }
  }
}

/** 现在这条路是什么状态：已放行 / 会拒转发 / 会重签 / 没装 bili。 */
export function readBiliCompat({ configPath = defaultBiliConfigPath() } = {}) {
  const probe = readJson(configPath)
  if (!probe.ok) {
    return { configPath, present: false, mode: 'unknown', error: probe.reason }
  }
  const present = probe.reason !== 'missing'
  const resign = probe.value?.resign
  const scheme = resign !== null && typeof resign === 'object' ? resign[SCHEME] : undefined
  const passthrough = scheme?.passthrough === true
  const enabled = scheme?.enabled !== false
  const mode = passthrough ? 'passthrough' : enabled ? 'resign' : 'disabled'
  return { configPath, present, mode, passthrough, enabled, scheme: scheme ?? null }
}

/**
 * 把这条链路设成「原样放行」，或者反过来交还给 bili。
 *
 * `passthrough: true` 是 bili 认的键。关掉时删掉这个键而不是写 false ——
 * 让它回到自己的默认判断（有凭据就重签），少一个「我们替它决定」的地方。
 */
export function setBiliPassthrough({ configPath = defaultBiliConfigPath(), enabled = true } = {}) {
  const probe = readJson(configPath)
  if (!probe.ok) throw Object.assign(new Error(`读不了 bili 配置：${probe.reason}`), { code: 'BAD_CONFIG' })
  const doc = probe.value
  const resign = doc.resign !== null && typeof doc.resign === 'object' && !Array.isArray(doc.resign) ? { ...doc.resign } : {}
  const scheme = resign[SCHEME] !== null && typeof resign[SCHEME] === 'object' && !Array.isArray(resign[SCHEME])
    ? { ...resign[SCHEME] }
    : {}
  if (enabled) scheme.passthrough = true
  else delete scheme.passthrough
  if (Object.keys(scheme).length === 0) delete resign[SCHEME]
  else resign[SCHEME] = scheme
  if (Object.keys(resign).length === 0) delete doc.resign
  else doc.resign = resign

  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  let backup = ''
  if (probe.reason !== 'missing') {
    backup = `${configPath}.bak-${Date.now()}`
    try { fs.copyFileSync(configPath, backup) } catch { backup = '' }
  }
  const tmp = `${configPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, configPath)
  return { ...readBiliCompat({ configPath }), backup, changed: true }
}
