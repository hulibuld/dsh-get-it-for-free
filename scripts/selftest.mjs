#!/usr/bin/env node
/**
 * 一条命令验证这份插件的四个入口 + 软链 + 版本 + 本机网关。
 *
 *   node scripts/selftest.mjs
 *
 * 为什么要这个脚本：交接文档第 1 节那四条命令靠人肉敲，敲漏一条就出现
 * 「版本号对、代码不对」。这个脚本把四条合成一条，并且补上 3.0.26 新增的
 * 「本机 API 网关」的三项体检（密钥文件、监听端口、鉴权）。
 *
 * 脚本只做只读检查：不写任何配置、不调任何会花额度的接口（最小对话那一步
 * 只在加 --chat 时才跑，且要你自己指定模型）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const entries = ['index.js', 'client.js', 'src/cli-lane.js', 'vendor/channel-pack/pack.js']
const argv = process.argv.slice(2)
const wantChat = argv.includes('--chat')
const chatModelIndex = argv.indexOf('--model')
const chatModel = chatModelIndex >= 0 ? argv[chatModelIndex + 1] : undefined

let failures = 0
const ok = text => console.log(`  \x1b[32m✓\x1b[0m ${text}`)
const bad = text => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${text}`) }
const info = text => console.log(`  \x1b[2m·\x1b[0m ${text}`)

console.log(`\n工作目录 ${here}\n`)

// ── 1. 四个入口的语法 ────────────────────────────────────────────────────────
console.log('1) 四个入口的语法')
for (const entry of entries) {
  const path = join(here, entry)
  if (!existsSync(path)) { bad(`${entry} 不存在`); continue }
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status === 0) ok(entry)
  else bad(`${entry}\n${(result.stderr ?? '').trim().split('\n').slice(0, 6).join('\n      ')}`)
}

// ── 2. 宿主半身能不能被 import ──────────────────────────────────────────────
console.log('\n2) 宿主半身 import')
{
  const script = `import(${JSON.stringify(resolve(here, 'index.js'))})
  .then(m => { console.log('LOAD OK ' + Object.keys(m).length + ' exports'); })
  .catch(e => { console.error('LOAD FAIL ' + (e && e.message)); process.exit(1); })`
  const result = spawnSync(process.execPath, ['--preserve-symlinks', '-e', script], { encoding: 'utf8' })
  const line = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status === 0) ok(line.replace(/^LOAD OK/, 'LOAD OK').trim())
  else bad(line.split('\n').slice(0, 8).join('\n      '))
}

// ── 3. 软链有没有断 ─────────────────────────────────────────────────────────
console.log('\n3) 软链')
{
  const link = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-get-it-for-free')
  if (!existsSync(link)) bad(`${link} 不存在（插件没挂进 profile）`)
  else {
    let real = ''
    try { real = realpathSync(link) } catch (error) { real = `realpath 失败：${error?.message ?? error}` }
    if (resolve(real) === resolve(here)) ok(`指向 ${real}`)
    else bad(`指向 ${real}，但不是本目录（${here}）—— 很可能被面板「更新」换成了实体目录，源码改动不会生效`)
  }
}

// ── 4. 版本号 ───────────────────────────────────────────────────────────────
console.log('\n4) 版本号')
{
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  ok(`package.json = ${pkg.version}`)
  info('设置页显示的版本应与这里一致；不一致说明宿主里跑的还是旧代码（重启 App）')
}

// ── 5. 本机网关 ─────────────────────────────────────────────────────────────
console.log('\n5) 本机 API 网关（OpenAI 兼容）')
{
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const keyPath = join(home, 'openai-gateway', 'api-key')
  let key = ''
  if (existsSync(keyPath)) {
    key = readFileSync(keyPath, 'utf8').trim()
    const mode = statSync(keyPath).mode & 0o777
    ok(`密钥文件存在（${keyPath}，权限 ${mode.toString(8)}）`)
    if (mode & 0o077) info('权限比 0600 宽，建议 chmod 600')
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) bad('密钥形态不是本插件生成的 43 位 base64url，网关会拒绝启动并报错（见 auth.ts）')
  } else {
    info(`密钥文件不存在：${keyPath}`)
    info('它只在你第一次启用网关时生成 —— 面板「本机 API 网关」卡片里按一下「启用网关」即可')
  }

  const statePath = join(home, 'channel-pack', 'state.json')
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      info(`channel-pack state: gatewayEnabled=${state.gatewayEnabled}`)
    } catch (error) { info(`state.json 读不出来：${error?.message ?? error}`) }
  }

  const port = Number(process.env.DSH_OPENAI_GATEWAY_PORT ?? 8326)
  const base = `http://127.0.0.1:${port}`
  const probe = async (label, path, headers) => {
    try {
      const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(4000) })
      return { label, status: response.status }
    } catch (error) {
      return { label, status: 0, error: error?.name === 'TimeoutError' ? '4 秒没有响应' : String(error?.message ?? error) }
    }
  }
  const models = await probe('models', '/v1/models', key === '' ? {} : { authorization: `Bearer ${key}` })
  if (models.status === 200) ok(`${base}/v1/models → 200`)
  else if (models.status === 0) info(`${base} 没有监听（${models.error}）—— 网关关着，属正常，去面板打开`)
  else if (models.status === 401) bad(`${base}/v1/models → 401：网关活着但密钥对不上（密钥文件被换过？重新生成一次）`)
  else bad(`${base}/v1/models → HTTP ${models.status}`)

  if (models.status === 200) {
    const wrong = await probe('models-bad-key', '/v1/models', { authorization: 'Bearer definitely-not-the-key' })
    if (wrong.status === 401) ok('错密钥 → 401（鉴权生效）')
    else bad(`错密钥 → ${wrong.status}：任何人都能用这个端口，检查 authorized()`)
  }

  if (wantChat && models.status === 200 && chatModel !== undefined) {
    console.log(`\n6) 最小对话（模型 ${chatModel}，会消耗一点额度）`)
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: chatModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }),
        signal: AbortSignal.timeout(120000),
      })
      const text = await response.text()
      if (response.status === 200) ok(`200：${text.slice(0, 200)}`)
      else bad(`HTTP ${response.status}：${text.slice(0, 300)}`)
    } catch (error) {
      bad(`${error?.name === 'TimeoutError' ? '120 秒没有响应' : String(error?.message ?? error)}`)
    }
  } else if (models.status === 200) {
    info('想验一次真对话：node scripts/selftest.mjs --chat --model <provider>/<model>')
  }
}

console.log(failures === 0 ? '\n\x1b[32m全部通过\x1b[0m\n' : `\n\x1b[31m${failures} 项未通过\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)