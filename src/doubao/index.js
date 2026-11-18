// 豆包工作通道：账号库 + 额度 + 模型目录 + 每日签到。
//
// 和 pack.js 里那些渠道不同，这一层完全长在我们自己的插件里（不去动 vendored
// 的 pack.js），原因很简单：那份文件改坏一次就会整个渠道层加载失败，而豆包
// 这边每次对接都需要反复试协议，不该拿全渠道的可用性去赌。

import os from 'node:os'
import path from 'node:path'

import {
  DoubaoError,
  ERROR,
  chat,
  claimCheckin,
  fetchAccountInfo,
  fetchCampaignDetail,
  fetchLaunch,
  fetchModels,
  fetchQuota,
  findDailyCheckin,
  hasSession,
  uidFromCookie,
} from './client.js'
import { parseCookieText, readStore, writeStore } from './store.js'
import { createLoginFlow } from './login.js'

const QUOTA_TTL_MS = 5 * 60_000
const MODELS_TTL_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 20_000
const DEFAULT_GROUP = 'pc_incentive_task_mvp_v3'
const CONFIRM_DELAYS = [0, 2_000, 4_000]

export function defaultDoubaoHome(env = process.env) {
  const base = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(base, 'get-it-for-free')
}

function shortError(error) {
  const code = error instanceof DoubaoError ? error.code : ''
  const message = String(error?.message ?? error ?? '').slice(0, 200)
  return {
    code: String(code ?? ''),
    message: code === ERROR.SESSION_EXPIRED ? '登录态失效，请重新登录豆包再粘一次 cookie' : message,
  }
}

export function createDoubao({ home, logger, env = process.env, onChange } = {}) {
  const dir = home ?? defaultDoubaoHome(env)
  const cache = new Map()

  // 任何会改变「选择器里能看到哪些模型」的写入都要广播一次，否则宿主那份
  // adapters 快照要等到下次重启才更新，用户看到的就是「面板说 12 个模型，
  // 右下角一个都没有」。
  function notify() {
    try { onChange?.() } catch { /* 广播失败不影响数据本身 */ }
  }

  // 上次拉到的目录先落盘，下次冷启动直接拿它顶上；上游不可达时也不至于
  // 让整组模型从选择器里消失。
  async function rememberRoster(models) {
    const rows = (models ?? []).map(item => ({
      id: item.id,
      name: item.name ?? item.id,
      contextWindow: Number(item.contextWindow) || 0,
      ratio: typeof item.ratio === 'string' ? item.ratio : '',
      // 这两项是选择器元数据的一部分，不是「顺手存的附件」：
      // reasoning 决定模型有没有思考强度菜单，isTaskMode 决定请求走哪条 agent 模式。
      // 少了前者，宿主这一组模型永远显示「不支持调思考强度」。
      reasoning: Array.isArray(item.reasoning) ? item.reasoning : [],
      isTaskMode: item.isTaskMode === true,
    }))
    if (rows.length === 0) return
    try {
      const store = await load()
      const before = JSON.stringify(store.roster ?? [])
      const after = JSON.stringify(rows)
      if (before === after) return
      await save({ ...store, roster: rows, rosterAt: Date.now() })
      notify()
    } catch (error) {
      logger?.warn?.(`[doubao] roster 落盘失败：${String(error?.message ?? error).slice(0, 160)}`)
    }
  }

  function cached(id) {
    return cache.get(id) ?? { quota: null, models: null, quotaAt: 0, modelsAt: 0, probe: null, probeAt: 0 }
  }

  async function load() {
    return readStore(dir)
  }

  async function save(store) {
    return writeStore(dir, store)
  }

  // 面板上四个刷新按钮各自只该动自己那一块：点「刷新模型」不该顺带把余额
  // 也重拉一遍，否则一次点击就是三个上游请求。
  async function refreshAccount(account, { force = false, only = 'all' } = {}) {
    const row = cached(account.id)
    const now = Date.now()
    const next = { ...row }
    const useProbe = force || only === 'all' || only === 'probe'
    const useQuota = force || only === 'all' || only === 'quota'
    const useModels = force || only === 'all' || only === 'models'
    if (useProbe && (force || !next.probe || now - next.probeAt > MODELS_TTL_MS)) {
      try {
        const info = await fetchAccountInfo(account.cookieHeader, { timeoutMs: PROBE_TIMEOUT_MS })
        next.probe = { ok: true, name: info.name, uid: info.uid }
      } catch (error) {
        next.probe = { ok: false, ...shortError(error) }
      }
      next.probeAt = now
    }
    if (useQuota && (force || !next.quota || now - next.quotaAt > QUOTA_TTL_MS)) {
      try {
        next.quota = await fetchQuota(account.cookieHeader, { timeoutMs: PROBE_TIMEOUT_MS })
        next.quotaError = null
      } catch (error) {
        next.quota = null
        next.quotaError = shortError(error)
      }
      next.quotaAt = now
    }
    if (useModels && (force || !next.models || now - next.modelsAt > MODELS_TTL_MS)) {
      try {
        next.models = await fetchModels(account.cookieHeader, { timeoutMs: PROBE_TIMEOUT_MS })
        next.modelsError = null
      } catch (error) {
        next.models = null
        next.modelsError = shortError(error)
      }
      next.modelsAt = now
    }
    cache.set(account.id, next)
    return next
  }

  function view(account, row, disabled = new Set()) {
    const quota = row.quota
    const modelList = (row.models ?? []).map(item => ({
      ...item,
      disabled: disabled.has(item.id),
      dead: false,
    }))
    return {
      id: account.id,
      name: account.name,
      uid: account.uid,
      savedAt: account.savedAt,
      source: account.source,
      enabled: account.enabled !== false,
      online: row.probe?.ok === true,
      accountName: row.probe?.name ?? '',
      error: row.probe?.ok === false ? row.probe : null,
      quota: quota
        ? {
            planName: quota.planName,
            planShort: quota.planShort,
            active: quota.active,
            exhausted: quota.exhausted,
            total: quota.windows.reduce((sum, item) => sum + item.total, 0),
            left: quota.windows.reduce((sum, item) => sum + item.left, 0),
            windows: quota.windows,
            at: quota.at,
            error: null,
          }
        : null,
      quotaError: row.quotaError ?? null,
      models: modelList.length,
      modelList,
      modelsError: row.modelsError ?? null,
      lastCheckin: account.lastCheckin ?? null,
    }
  }

  function disabledSet(store) {
    return new Set(Array.isArray(store.disabledModels) ? store.disabledModels : [])
  }

  async function status({ force = false } = {}) {
    const store = await load()
    const disabled = disabledSet(store)
    if (store.accounts.length === 0) {
      return { home: dir, accounts: [], disabledModels: [...disabled], updatedAt: store.updatedAt }
    }
    const accounts = await Promise.all(
      store.accounts.map(async account => view(account, await refreshAccount(account, { force }), disabled)),
    )
    return { home: dir, accounts, disabledModels: [...disabled], updatedAt: store.updatedAt }
  }

  async function addAccount({ cookie, name } = {}) {
    const cookieHeader = parseCookieText(cookie)
    if (cookieHeader === '' || !hasSession(cookieHeader)) {
      throw Object.assign(new Error('cookie 里没有 sessionid，粘完整的一串'), { code: 'NO_SESSION' })
    }
    const store = await load()
    let resolvedName = typeof name === 'string' && name.trim() !== '' ? name.trim() : ''
    let uid = uidFromCookie(cookieHeader)
    try {
      const info = await fetchAccountInfo(cookieHeader, { timeoutMs: PROBE_TIMEOUT_MS })
      if (info.uid !== '') uid = info.uid
      if (resolvedName === '' && info.name !== '') resolvedName = info.name
    } catch (error) {
      // 探不到名字不算失败：cookie 可能是刚签的，先存下来，下一次刷新会补上
      logger?.warn?.(`[doubao] account probe failed: ${String(error?.message ?? error).slice(0, 160)}`)
    }
    if (uid === '') uid = `anon_${Date.now().toString(36)}`
    const account = {
      id: uid,
      name: resolvedName !== '' ? resolvedName : `豆包 ${uid}`,
      uid,
      cookieHeader,
      savedAt: Date.now(),
      source: 'manual',
      lastCheckin: null,
    }
    const others = store.accounts.filter(row => row.id !== account.id)
    const next = await save({ ...store, accounts: [...others, account] })
    cache.delete(account.id)
    await refreshAccount(account, { force: true })
    notify()
    return { account: view(account, cached(account.id)), count: next.accounts.length }
  }

  async function removeAccount(id) {
    const store = await load()
    const next = await save({ ...store, accounts: store.accounts.filter(row => row.id !== id) })
    cache.delete(id)
    notify()
    return { count: next.accounts.length }
  }

  async function requireAccount(id) {
    const store = await load()
    const account = store.accounts.find(row => row.id === id)
    if (!account) throw Object.assign(new Error(`没有这个豆包账号：${id}`), { code: 'NOT_FOUND' })
    return { store, account }
  }

  async function rememberCheckin(account, lastCheckin) {
    const store = await load()
    const accounts = store.accounts.map(row => (row.id === account.id ? { ...row, lastCheckin } : row))
    await save({ ...store, accounts })
    return lastCheckin
  }

  // 签到只有一种成功判据：活动详情里那条 daily_checkin 变成「今天已签」。
  // landing 回执的 checked_in 只是「请求被接受」，不能当完成。
  async function checkin(id, { dryRun = false } = {}) {
    const { account } = await requireAccount(id)
    const steps = []
    try {
      const launch = await fetchLaunch(account.cookieHeader, { timeoutMs: PROBE_TIMEOUT_MS })
      steps.push({ step: 'launch', group: launch.campaignGroup || launch.campaign || '' })
      const group = launch.campaignGroup || launch.campaign || DEFAULT_GROUP
      const detail = await fetchCampaignDetail(account.cookieHeader, group, { timeoutMs: PROBE_TIMEOUT_MS })
      steps.push({ step: 'detail', group: detail.group, tasks: detail.tasks.length })
      const task = findDailyCheckin(detail.tasks)
      if (!task) {
        const result = {
          status: 'inactive',
          message: '这个账号当前活动里没有签到任务（常见于只投放「做任务领额度」的账号）',
          steps,
        }
        await rememberCheckin(account, { at: Date.now(), status: 'inactive', message: result.message })
        return result
      }
      if (task.checkedInToday === true) {
        const streak = task.continuousDays > 0 ? `，已连签 ${task.continuousDays} 天` : ''
        const result = { status: 'already', message: `今天已经签过了${streak}`, task: task.code, steps }
        await rememberCheckin(account, { at: Date.now(), status: 'already', task: task.code })
        return result
      }
      if (dryRun) {
        const reward = task.checkinReward?.reward_amount
        const hint = reward ? `（${reward}）` : ''
        return { status: 'available', message: `可签：${task.title}${hint}`, task: task.code, steps }
      }
      let receipt = null
      try {
        receipt = await claimCheckin(account.cookieHeader, detail.group, { timeoutMs: PROBE_TIMEOUT_MS })
        steps.push({ step: 'claim', checkedIn: receipt.checkedIn })
      } catch (error) {
        const detailCode = error instanceof DoubaoError ? error.code : ''
        if (detailCode === ERROR.RUNTIME_UNAVAILABLE) {
          // 710010702 是 /alice/ug/campaign/landing/checkin 对 web 会话的无条件系统错误：
          // 抓包实测 22 组参数（scene/biz_params/AgwCommonParam/referer/桌面端 aid）全部同码，
          // 活动页自己也写着「该活动仅支持在豆包电脑版参与」。不是脚本缺参数，是服务端看客户端上下文。
          const message = '签到接口只认豆包电脑客户端：web 会话调 /alice/ug/campaign/landing/checkin 恒返回 710010702（已实测 22 组参数），请在电脑客户端里点一次签到'
          await rememberCheckin(account, { at: Date.now(), status: 'needs-manual', task: task.code, message })
          return { status: 'needs-manual', message, task: task.code, steps }
        }
        throw error
      }
      if (receipt.checkedInToday) {
        const result = { status: 'claimed', message: '签到成功', task: task.code, steps }
        await rememberCheckin(account, { at: Date.now(), status: 'claimed', task: task.code })
        return result
      }
      // landing 接受了请求，但详情可能异步刷新：0/2/4 秒各回查一次
      for (const delay of CONFIRM_DELAYS) {
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        const again = await fetchCampaignDetail(account.cookieHeader, detail.group, { timeoutMs: PROBE_TIMEOUT_MS })
        const row = again.tasks.find(item => item.code === task.code)
        steps.push({ step: 'confirm', after: delay, checkedInToday: row?.checkedInToday })
        if (row?.checkedInToday === true) {
          const result = { status: 'claimed', message: '签到成功', task: task.code, steps }
          await rememberCheckin(account, { at: Date.now(), status: 'claimed', task: task.code })
          return result
        }
      }
      const result = {
        status: 'confirming',
        message: '领取请求已提交，但详情还没刷新；过一会再看，重跑不会重复发奖',
        task: task.code,
        steps,
      }
      await rememberCheckin(account, { at: Date.now(), status: 'confirming', task: task.code })
      return result
    } catch (error) {
      const detail = shortError(error)
      await rememberCheckin(account, { at: Date.now(), status: 'error', message: detail.message })
      return { status: 'error', code: detail.code, message: detail.message, steps }
    }
  }

  // 面板的「续期 / 刷新余额 / 刷新模型」三个按钮映射到 part：
  // probe 只重新确认登录态，quota 只重拉额度，models 只重拉目录。
  async function refresh({ id = '', part = 'all' } = {}) {
    const store = await load()
    const disabled = disabledSet(store)
    const rows = id === '' ? store.accounts : store.accounts.filter(account => account.id === id)
    const accounts = []
    for (const account of rows) {
      accounts.push(view(account, await refreshAccount(account, { only: part }), disabled))
    }
    // 刷新模型之后目录要落到快照里，否则下一次挂载又回到「面板有、选择器没有」。
    if (part === 'models' || part === 'all') {
      const merged = new Map()
      for (const row of accounts) {
        for (const item of row.modelList ?? []) {
          if (disabled.has(item.id) || merged.has(item.id)) continue
          merged.set(item.id, item)
        }
      }
      if (merged.size > 0) await rememberRoster([...merged.values()])
      notify()
    }
    return { accounts, disabledModels: [...disabled] }
  }

  // 模型开关只影响我们自己的目录展示（豆包上游一次请求带一个 model_item_key，
  // 从来没有「一次问全部模型」的调用），所以关掉一个模型＝面板上不再列它。
  async function setModelsDisabled({ ids = [], disabled = true } = {}) {
    const store = await load()
    const current = new Set(disabledSet(store))
    for (const id of ids) {
      const key = String(id ?? '')
      if (key === '') continue
      if (disabled) current.add(key)
      else current.delete(key)
    }
    const next = await save({ ...store, disabledModels: [...current] })
    notify()
    return { disabledModels: [...disabledSet(next)] }
  }

  async function updateAccount(id, patch = {}) {
    const store = await load()
    let found = null
    const accounts = store.accounts.map(account => {
      if (account.id !== id) return account
      found = { ...account, ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}) }
      return found
    })
    if (found === null) throw Object.assign(new Error(`没有这个豆包账号：${id}`), { code: 'NOT_FOUND' })
    const next = await save({ ...store, accounts })
    notify()
    return { account: view(found, cached(id), disabledSet(next)) }
  }

  async function checkinAll({ dryRun = false } = {}) {
    const store = await load()
    const rows = []
    for (const account of store.accounts) {
      const result = await checkin(account.id, { dryRun })
      rows.push({ id: account.id, name: account.name, ...result })
    }
    return {
      at: Date.now(),
      dryRun,
      accounts: rows,
      claimed: rows.filter(row => row.status === 'claimed').length,
      already: rows.filter(row => row.status === 'already').length,
      inactive: rows.filter(row => row.status === 'inactive').length,
      needsManual: rows.filter(row => row.status === 'needs-manual').length,
      failed: rows.filter(row => row.status === 'error').length,
    }
  }

  // 真正发一条消息出去。面板上的「测一测」和以后接进模型选择器的对话都走这里。
  async function talk(id, { modelId = '0', prompt, reasoningLevel, taskMode = false, conversationId = '' } = {}) {
    const { account } = await requireAccount(id)
    const result = await chat(account.cookieHeader, {
      prompt,
      modelId,
      reasoningLevel,
      taskMode,
      conversationId,
      timeoutMs: 120_000,
    })
    return { ...result, accountId: account.id, accountName: account.name }
  }

  // 卡片上的「智商检测」：问一个答案是固定值的小问题，把首字延迟和整段耗时
  // 一起报回去。选 9.9 与 9.11 是因为不少模型会按字符串长度答错，一眼能看出
  // 这次到底是真模型在答还是缓存/降级在答。
  const DEGRADE_PROMPT = '只回答一个词，不要解释：9.11 和 9.9 哪个大？'

  async function degrade({ id = '', modelId = '0' } = {}) {
    const store = await load()
    const account = id !== '' ? store.accounts.find(row => row.id === id) : store.accounts[0]
    if (!account) throw Object.assign(new Error('还没有豆包账号'), { code: 'NO_ACCOUNT' })
    const startedAt = Date.now()
    try {
      const result = await chat(account.cookieHeader, {
        prompt: DEGRADE_PROMPT,
        modelId,
        reasoningLevel: 0,
        timeoutMs: 120_000,
      })
      return {
        ok: result.text !== '',
        firstMs: result.firstMs,
        totalMs: result.totalMs || Date.now() - startedAt,
        nickname: account.name,
        text: result.text,
        message: '',
        accountId: account.id,
      }
    } catch (error) {
      const detail = shortError(error)
      return {
        ok: false,
        firstMs: 0,
        totalMs: Date.now() - startedAt,
        nickname: account.name,
        text: '',
        message: detail.message,
        accountId: account.id,
      }
    }
  }

  // 模型选择器要的是「所有启用账号的模型并集」：只要目录，不要额度与探针，
  // 所以这里只刷 models 那一片。关掉的模型不进并集 —— 面板上的开关就是这里生效。
  async function models() {
    const store = await load()
    const disabled = disabledSet(store)
    const merged = new Map()
    for (const account of store.accounts) {
      if (account.enabled === false) continue
      const row = await refreshAccount(account, { only: 'models' })
      for (const item of row.models ?? []) {
        if (disabled.has(item.id) || merged.has(item.id)) continue
        merged.set(item.id, item)
      }
    }
    const rows = [...merged.values()]
    if (rows.length > 0) await rememberRoster(rows)
    return rows
  }

  // 同步视角的那一份：只读本地快照，永不发网络请求。
  //
  // 宿主的 registerAdapter 会在挂载时问一次 listModels，那一问如果卡在网络上，
  // 整组模型就挂不上（而且挂不上之后没有任何重试入口）。所以这条路径必须
  // 立刻有答案：有快照就给快照，没快照就返回空表 + 后台自己去拉。
  async function modelsSnapshot() {
    try {
      const store = await load()
      const disabled = disabledSet(store)
      // 这里不看账号数量。原来 enabled.size === 0 就返回空表，把
      // 「没登录 / 卡被关掉」和「这个渠道没有模型」混成一件事：右下角选择器
      // 看不到豆包，而面板上明明写着「模型 12/12」。目录是服务的属性，
      // 账号可用性是请求的属性，两件事不共用一个闸门。
      const roster = (store.roster ?? []).filter(row => !disabled.has(row.id))
      if (roster.length > 0) {
        return roster.map(row => ({
          id: row.id,
          name: row.name,
          contextWindow: row.contextWindow,
          ratio: row.ratio,
          reasoning: Array.isArray(row.reasoning) ? row.reasoning : [],
          isTaskMode: row.isTaskMode === true,
          disabled: false,
          dead: false,
        }))
      }
      return []
    } catch {
      return []
    }
  }

  /** 快照是不是空的：空表时适配器要主动催一次后台刷新。 */
  async function needsRoster() {
    const rows = await modelsSnapshot()
    return rows.length === 0
  }

  // 轮着用一个账号：一个账号同一时刻只有一个会话活得舒服（上游给 3 个并发槽，
  // 超了回 TM.00001041），轮询能把多账号摊平。
  let cursor = 0
  async function pickAccount() {
    const store = await load()
    const rows = store.accounts.filter(account => account.enabled !== false && hasSession(account.cookieHeader))
    if (rows.length === 0) return null
    const account = rows[cursor % rows.length]
    cursor += 1
    return account
  }

  // 登录流：开一个干净的浏览器，用户登完就抓 cookie。抓到的 cookie 走
  // addAccount 同一条路径（同样校验 sessionid、同样探测账号名），
  // 所以「点按钮登录」和「手动粘贴」存下来的是同一种记录。
  const login = createLoginFlow({ logger, addAccount: input => addAccount(input) })

  return {
    home: dir,
    status,
    refresh,
    addAccount,
    removeAccount,
    checkin,
    checkinAll,
    setModelsDisabled,
    updateAccount,
    talk,
    degrade,
    models,
    modelsSnapshot,
    needsRoster,
    pickAccount,
    login,
  }
}
