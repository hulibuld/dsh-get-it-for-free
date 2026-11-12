#!/usr/bin/env node
/**
 * 一条命令发布：GitHub + npm。
 *
 * 为什么要有这个脚本：本机这份源码目录**没有 .git**（是从 zip / 上传流程拿出来的
 * 一份副本），直接在原地 `git init` 会得到一条与远端无关的历史，想推上去只能
 * force push，把 GitHub 上已有的提交和 `docs/`、`.github/` 全抹掉。所以脚本反过来做：
 *
 *   1. 先把远端仓库浅克隆到一个临时目录（历史和远端独有的文件都在那儿）
 *   2. 把本地这份源码**覆盖**进去（只覆盖，不删除——远端独有的 docs/、.github/ 原样保留）
 *   3. 在临时目录里 commit、打 tag、push
 *   4. 回到本地目录 npm publish
 *
 * 用法：
 *   node scripts/release.mjs               # 校验 + 发布 GitHub + 发布 npm
 *   node scripts/release.mjs --dry-run     # 只校验、只显示会改哪些文件，不推不发
 *   node scripts/release.mjs --github      # 只发 GitHub
 *   node scripts/release.mjs --npm         # 只发 npm
 *
 * 前提：git 能用现有凭据 push（macOS 钥匙串 / SSH），npm 能用 `~/.npmrc` 里的 token 发布。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = new Set(process.argv.slice(2))
const dryRun = argv.has('--dry-run')
const onlyGithub = argv.has('--github')
const onlyNpm = argv.has('--npm')
const doGithub = onlyNpm ? false : (onlyGithub || !onlyNpm)
const doNpm = onlyGithub ? false : (onlyNpm || !onlyGithub)

/** 只在这台机器上存在、不该进仓库的东西。其余一律照抄。 */
const SKIP = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'package-lock.json', // 插件走 profile 的依赖树，提交 lock 只会和宿主打架
  'docs-merge', // 上游插件测绘笔记：含本机路径与取证过程
  'client 2.js', // Finder 复制出来的副本
])
const skipName = name => SKIP.has(name) || name.startsWith('交接文档') || name.startsWith('handoff-')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, stdio: 'inherit', ...options })
  if (result.error !== undefined) throw new Error(`${command} 起不来：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`)
  return result
}

function output(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return ''
  return String(result.stdout ?? '').trim()
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

function preflight() {
  console.log(`\n── 预检 （${pkg.name}@${version}）`)
  // 宿主要 import 这几个入口，任何一个语法错，整个插件在设置页里直接空白。
  const entries = ['index.js', 'client.js', 'src/model-sync.js', 'vendor/channel-pack/pack.js']
  for (const entry of entries) {
    process.stdout.write(`   node --check ${entry} … `)
    run(process.execPath, ['--check', entry], { stdio: 'pipe' })
    console.log('ok')
  }
  // pack.js 的导出表里只要多一个不存在的名字，整包就会加载失败（3.0.26 的教训）。
  const pack = fs.readFileSync(path.join(ROOT, 'vendor/channel-pack/pack.js'), 'utf8')
  const exportBlock = pack.slice(pack.lastIndexOf('export {'))
  for (const match of exportBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)) {
    const name = match[1]
    if (name === '' || name === '}' || name === 'export') continue
    const declared = new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`).test(pack)
    if (!declared) throw new Error(`pack.js 导出表里有未声明的名字：${name}（会让整包加载失败）`)
  }
  console.log('   pack.js 导出表 ok')
  // src/ 里被 import 但没落盘的文件，是「笔记本里改过、这台机器没同步」的典型症状。
  const missing = []
  const scanned = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'index.js'), path.join(ROOT, 'client.js')]
  for (const file of scanned) {
    if (!file.endsWith('.js')) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(path.dirname(file), match[1])
      if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`)) missing.push(`${path.relative(ROOT, file)} → ${match[1]}`)
    }
  }
  if (missing.length > 0) throw new Error(`这些 import 指不到文件：\n     ${missing.join('\n     ')}`)
  console.log('   相对 import 全部落盘 ok')
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipName(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

function copyInto(target) {
  let copied = 0
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file)
    const destination = path.join(target, rel)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    // 内容一样就不写，免得 mtime 全变、diff 全是噪音。
    if (fs.existsSync(destination) && fs.readFileSync(destination).equals(fs.readFileSync(file))) continue
    fs.copyFileSync(file, destination)
    copied += 1
  }
  return copied
}

function publishGithub() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfor-release-'))
  const clone = path.join(work, 'repo')
  console.log(`\n── GitHub（临时目录 ${clone}）`)
  run('git', ['clone', '--depth', '1', repo, clone], { stdio: 'pipe' })
  const copied = copyInto(clone)
  console.log(`   覆盖 ${copied} 个文件（远端独有的 docs/、.github/ 保留）`)

  const status = output('git', ['status', '--short'], clone)
  if (status === '') {
    console.log('   没有变化，跳过提交')
  } else {
    console.log(status.split('\n').slice(0, 40).map(line => `   ${line}`).join('\n'))
    if (status.split('\n').length > 40) console.log('   …')
    if (dryRun) {
      console.log('   --dry-run：不提交、不推。临时目录保留在上面那个路径，可以自己看 diff。')
      return
    }
    run('git', ['add', '-A'], { cwd: clone })
    const message = process.env.RELEASE_MESSAGE ?? `feat(model-sync): 模型目录同步引擎（${version}）`
    run('git', ['-c', 'user.name=hulibuld', '-c', 'user.email=hulibuld@users.noreply.github.com',
      'commit', '-m', message], { cwd: clone })
    run('git', ['push', 'origin', 'HEAD:main'], { cwd: clone })
    console.log('   已推送 main')
  }

  const tag = `v${version}`
  const existing = output('git', ['ls-remote', '--tags', 'origin', tag], clone)
  if (existing !== '') {
    console.log(`   tag ${tag} 已存在，跳过`)
  } else if (dryRun) {
    console.log(`   --dry-run：会打 tag ${tag}`)
  } else {
    run('git', ['-c', 'user.name=hulibuld', '-c', 'user.email=hulibuld@users.noreply.github.com',
      'tag', '-a', tag, '-m', `${pkg.name} ${version}`], { cwd: clone })
    run('git', ['push', 'origin', tag], { cwd: clone })
    console.log(`   已打并推送 tag ${tag}`)
  }
  console.log(`   仓库：${repo}`)
}

function publishNpm() {
  console.log('\n── npm')
  const latest = output('npm', ['view', pkg.name, 'version'])
  console.log(`   线上最新 ${latest === '' ? '（查不到，可能没发过）' : latest} → 本次 ${version}`)
  if (latest === version) throw new Error(`npm 上已经是 ${version}，先改 package.json 的 version`)
  if (dryRun) {
    // pack 的清单就是真正会发上去的东西，比读 files 字段可靠。
    const listed = output('npm', ['pack', '--dry-run', '--json'])
    try {
      const files = JSON.parse(listed)[0].files.map(entry => entry.path)
      console.log(`   --dry-run：会发 ${files.length} 个文件`)
      if (files.some(file => file.startsWith('docs-merge') || file.startsWith('交接文档'))) {
        throw new Error('打包清单里混进了只该留在本机的文件')
      }
      if (!files.includes('src/model-sync.js')) throw new Error('打包清单里没有 src/model-sync.js')
    } catch (error) {
      if (error instanceof SyntaxError) console.log('   （npm pack --dry-run 没给 JSON，跳过清单检查）')
      else throw error
    }
    return
  }
  run('npm', ['publish', '--access', 'public'])
  console.log(`   已发布 ${pkg.name}@${version}`)
  console.log(`   https://www.npmjs.com/package/${pkg.name}/v/${version}`)
}

preflight()
if (doGithub) publishGithub()
if (doNpm) publishNpm()
console.log(`\n完成。${dryRun ? '（dry-run，什么都没改）' : ''}`)
