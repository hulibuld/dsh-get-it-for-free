/**
 * Get It For Free — browser half.
 *
 * Contributes three things to the web shell:
 *   1. a settings section (`settings.section` id `get-it-for-free`) holding the
 *      model roster with live availability, the usage dashboard, the OpenAI
 *      forward listener and the plugin's own switches;
 *   2. a first-run announcement (`settings.onboarding`) that is versioned, so
 *      bumping the copy re-announces once and never nags again;
 *   3. nothing else — no shadowing of the stock model picker, whose grouping by
 *      provider route is exactly the mechanism this plugin uses for its tag.
 *
 * Data is read over the plugin's own same-origin `/api/get-it-for-free/*` routes
 * rather than a typed Remote binding, because those routes are served by the same
 * host process on every kernel line this plugin targets.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-get-it-for-free',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'settings.getItForFree'
    const inject = ['slots', 'locale', 'modelDirectories']

    // Sponsor artwork, scaled proportionally for the existing 56px tile.



    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': 'Get It For Free',
        'meta.description': '在 DeepSeek Harness 内直连免密免费模型：清单随上游更新、地区可用性自动探测、思考强度真实生效，并附 Token 看板与 OpenAI 兼容转发端口。',
        'ann.pitch': '你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括 Muse Spark 1.3、MiMo V2.6 在内的前沿模型——完全免费，不限量。',
        nav: 'Get It For Free',
        title: 'Get It For Free',
        refresh: '刷新清单',
        reprobe: '重新探测可用性',
        probing: '探测中…',
        loading: '正在加载…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        'state.available': '可用',
        'state.region-blocked': '地区受限',
        'state.unavailable': '暂不可用',
        'state.throttled': '暂不可用',
        'state.unknown': '未探测',
        'state.listed': '已列出 · 未实测',
        'roster.selectable': '可选模型',
        'hint.listed': '来自渠道目录，未做逐模型推理测试；不代表对话或工具调用成功。',
        'hint.region': '该模型按出口地区放行。开启网络代理后，插件会在下一次探测自动把它移入可用分组。',
        'hint.unknown': '尚未探测，默认保持可达。',
        'hint.hidden': '探测显示网关点名了它却不路由它，因此已从模型选择器中移除；某一次探测重新通过，它会自己回来。',
        'hint.sharedBudget': '该模型思考不可关闭：思考与可见回答共用同一份额度，档位越低留给正文的越少。',
        'tag.vision': '视觉',
        'tag.text': '纯文本',
        'tag.thinking': '可调思考',
        'tag.thinkingShared': '思考不可关',
        'tag.rung': '默认档上限',
        'tag.rungTitle': '各档位实际发出的输出上限：{ladder}。档位是思考与回答共用的额度，且不会超过上面的最长输出与设置里的单次上限。',
        'tag.levels': '思考档',
        'tag.levelsTitle': '该模型自己声明的思考档位，选中后按原值下发到上游的 reasoning_effort 字段；档位之外的取值会被上游拒绝。',
        'effort.off': '关闭',
        'effort.minimal': '最小',
        'effort.low': '低',
        'effort.medium': '中',
        'effort.high': '高',
        'effort.xhigh': '极高',
        'effort.max': '最大',
        'tag.context': '上下文',
        'tag.output': '最长输出',
        'tag.latency': '首字',
        'tag.eacChannel': 'EAC 渠道 · 协付',
        'tag.new': 'NEW',
        'tag.newTitle': '新上线的模型，经 EAC 渠道转发自 OpenCode 免费车道。',
        'tag.hot': '爆',
        'tag.hotTitle': '当前最热门的免费模型之一。',
        'tag.fast': '高速',
        'tag.fastTitle': '响应快、吞吐高，适合长对话与连续调用。',
        'tag.kiloChannel': 'Kilo 渠道 · 免费池（prompt 可能被上游记录用于改进服务，勿发送敏感内容）',
        'roster.noLane': 'EAC 协付模型在当前运行环境不可用：宿主未提供可识别的桌面 / Web 配置，因此不加载该渠道。',
        'section.models': '模型清单',
        'section.modelsHint': '名称与能力来自上游清单与公开能力表，可用性由本机出口实测得出。',
        'section.dash': '用量看板',
        'section.dashHint': '数据只写入本机，不会上传。',
        'pool.levelOk': '畅通',
        'pool.levelBusy': '繁忙',
        'pool.capacity': '号池容量',
        'pool.levelOver': '过载',
        'pool.reach': '容量占用',
        'pool.formula': 'Star {stars} × 1.5',
        'pool.configured': '按实际配号数',
        'pool.active': '24h 活跃',
        'pool.live': '进行中',
        'pool.unavailable': '号池数据暂不可用 · {reason}',
        'pool.reasonNoLane': '当前运行环境未解锁协付车道',
        'pool.reasonGateway': '网关应答异常',
        'pool.reasonMalformed': '网关数据异常',
        'pool.reasonUnreachable': '网关暂不可达',
        'pool.reasonUnknown': '原因未知',
        'pool.capacityUnknown': 'Star 数据暂不可用',
        'section.eac': 'EAC 渠道授权',
        'section.eacHint': 'EAC（协付）模型需要 GitHub 登录并 star 仓库；免费车道的模型不受影响。',
        'eac.pillOk': '已授权',
        'eac.pillLocked': '未授权',
        'eac.pillRequired': '已开启强制',
        'eac.pillCompat': '兼容期',
        'eac.pillUnknown': '授权策略未确认',
        'eac.pollFailed': '领取授权失败（{reason}），正在自动重试；无需重新授权。',
        'eac.saveFailed': '授权已完成，但本机无法保存登录记录。请检查 DSH_HOME 目录权限；修复后将自动重试。',
        'eac.cancel': '取消此次登录',
        'eac.cancelFailed': '无法确认取消登录，请稍后重试。',
        'eac.pillUnverified': '网关暂不可达',
        'eac.intro': 'EAC 渠道的对话在服务器侧校验授权：用 GitHub 登录，并给 {repo} 点一个 Star，即可解锁。登录在浏览器里完成，无需复制粘贴；取消 Star 后授权会自动失效。',
        'eac.login': '使用 GitHub 登录',
        'eac.starting': '正在打开浏览器…',
        'eac.waiting': '已打开浏览器授权页；若没有自动打开，请手动访问下面的地址完成授权。完成后本页会自动确认。',
        'eac.copy': '复制链接',
        'eac.copied': '已复制',
        'eac.done': '授权成功：@{login}，现在可以使用 EAC 模型了。',
        'eac.needStar': '已用 @{login} 登录，但还没有 star 仓库；请先 Star，再在授权页点「我已 star，重新检查」。',
        'eac.expired': '这次登录等待超时了，请重新发起。',
        'eac.sessionExpired': '登录链接已失效（服务器不再认识它），请重新发起 GitHub 登录。',
        'eac.openManually': '浏览器没有自动打开，请手动访问下面的地址完成授权。',
        'eac.startFailed': '无法发起登录（{reason}）。',
        'eac.loggedIn': '已授权：@{login} · 上次复查 {when}',
        'eac.recheck': '重新检查',
        'eac.logout': '退出登录',
        'eac.noLane': '当前运行环境未解锁 EAC 协付车道，无法进行 GitHub 授权。',
        'eac.lockedTitle': '需要 GitHub 授权并 star 仓库后使用',
        'eac.lockedNote': '未授权：点下方按钮用 GitHub 登录并 star 仓库，或到「EAC 渠道授权」区完成。',
        'section.forward': '本地转发（OpenAI 兼容）',
        'section.forwardHint': '让其它本地工具用一个 base URL 调用这些模型。',
        'section.egress': '出口代理（订阅分流）',
        'section.egressHint': '把推理与探测请求从代理出口发出，缓解按 IP 的频率限制。',
        'egress.enabled': '启用出口',
        'egress.modeSubscription': '订阅模式（本地 mihomo 自动测速分流）',
        'egress.url': '订阅 / 代理 URL',
        'egress.urlNew': '替换订阅地址',
        'egress.urlPlaceholder': '粘贴新的订阅 / 代理地址（留空则保持当前不变）',
        'egress.urlNone': '未设置',
        'egress.urlClear': '清除',
        'egress.urlClearWarn': '清除本机保存的订阅 / 代理地址，并关闭出口',
        'egress.mihomoPath': 'mihomo 路径',
        'egress.mihomoHint': '订阅模式留空则自动查找本机 mihomo（如 Clash Verge）。',
        'egress.apply': '应用',
        'egress.active': '出口生效中',
        'egress.inactive': '未启用',
        'egress.outlet': '当前出口',
        'egress.node': '当前最佳节点',
        'egress.latency': '访问 opencode',
        'egress.measuring': '测量中…',
        'egress.direct': '关闭时请求直连发出；订阅地址按密钥对待——只存在本机设置里，不随常规接口数据下发，仅点「显示」时读取，面板默认打码。',
        'egress.error': '出口启动失败：{message}',
        'section.prefs': '插件设置',
        'section.prefsHint': '改动在下一次加载完全生效。',
        'heat.title': 'Token 热力图',
        'heat.legend': '少',
        'heat.legendMore': '多',
        'heat.empty': '还没有用量记录。用一次对话后回来看看。',
        'curve.title': '总量曲线',
        'curve.tokens': 'Token',
        'curve.requests': '请求数',
        'curve.total': '总计',
        'stat.output': '输出 Token',
        'stat.reasoning': '推理 Token',
        'col.reason': '推理',
        'col.output': '输出',
        'last.title': '最近一回合',
        'last.justNow': '刚刚',
        'last.minAgo': '{n} 分钟前',
        'last.hourAgo': '{n} 小时前',
        'last.dayAgo': '{n} 天前',
        'last.input': '输入',
        'last.originChat': '对话',
        'last.originHarness': '桌面',
        'last.originForward': '转发',
        'last.originBench': '测速',
        'speed.title': '速度',
        'speed.tps': '输出速度',
        'speed.ttft': '首帧延迟',
        'speed.model': '模型',
        'speed.calls': '上游请求',
        'speed.failed': '请求失败',
        'speed.turns': '对话回合',
        'speed.turnFailed': '回合失败',
        'speed.recovered': '已恢复',
        'speed.estimated': '升级前历史按上游请求估算；升级后回合按最终结果精确记录。',
        'speed.scope': '请求、回合和 Token 为累计；速度和首帧按最近 40 次调用计算，热力图按天汇总。',
        'speed.none': '暂无样本',
        'speed.note': '输出速度只统计 {n}/{total} 次可测的调用：那些没流式送出的思考 token 不计入分子，解码窗口短到测不出的也不算。',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': '启用转发端口',
        'forward.host': '监听地址',
        'forward.port': '端口',
        'forward.apply': '应用',
        'settings.failed': '设置未保存',
        'forward.running': '正在监听',
        'forward.stopped': '未启用',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API Key',
        'forward.show': '显示',
        'forward.hide': '隐藏',
        'forward.rotate': '重新生成',
        'forward.rotateWarn': '重新生成后，所有使用旧 Key 的工具都会失效。',
        'forward.copy': '复制',
        'forward.copied': '已复制',
        'forward.example': '调用示例',
        'forward.error': '启动失败：{message}',
        'forward.notice': '端口提示：{message}',
        'forward.lanTitle': '局域网访问',
        'forward.lanHint': '让同一网络里的其它设备也用这个转发端口。默认关闭；开启后中继需要一把单独的 Key。',
        'forward.lanEnabled': '允许局域网访问',
        'forward.lanPort': '局域网端口',
        'forward.lanAuto': '0 = 自动分配',
        'forward.lanApply': '应用局域网设置',
        'forward.lanRunning': '局域网中继已监听',
        'forward.lanStopped': '局域网中继未启用',
        'forward.lanError': '局域网中继启动失败：{message}',
        'forward.lanKey': '局域网 Key',
        'forward.lanRotateWarn': '重新生成后，局域网里的设备都要换新 Key；本机工具不受影响。',
        'forward.lanWarn': '开启后，能连到这台机器的任何人都可以用这个 Key 花掉本机的免费额度。请只在信任的网络里开启，必要时用防火墙限制来源。',
        'forward.lanUrl': '局域网地址',
        'forward.lanNoAddress': '没有检测到局域网 IPv4 地址',
        'forward.lanAlso': '其它地址：{list}',
        'pref.enabled': '启用免费模型',
        'pref.exposeRegion': '展示地区受限模型',
        'pref.hideFreeModels': '隐藏匿名与 Kilo 免费模型',
        'pref.hideEacModels': '隐藏 EAC 模型',
        'visibility.showModel': '在模型选择器中显示',
        'visibility.hidden': '已隐藏',
        'visibility.unlisted': '未公开模型',
        'visibility.groupHidden': '整组已隐藏，请先关闭上方的整组隐藏开关。',
        'visibility.hint': '隐藏仅影响模型选择器和网关清单，不影响历史会话；仍可在这里恢复显示。',
        'routing.capacity': '链路能力交集',
        'routing.capacityUnavailable': '暂时无法读取链路能力交集，请重试。',
        'pref.interval': '自动探测间隔（分钟）',
        'pref.maxTokens': '单次输出上限（token）',
        'pref.egress': '当前出口',
        'pref.probedAt': '最近探测',
        'pref.measuredAt': '最近测量',
        'bench.run': '测一次',
        'bench.running': '测量中…',
        'bench.notSaved': '结果未能保存，请检查数据目录；刷新后可能丢失。',
        'bench.result': '文本响应通过 · 首帧 {ttft}ms · 输出 {tps} tok/s · 推理 {reasoning} tok',
        'ann.preamble': '前言',
        'ann.models': '模型清单',
        'ann.newlane': '新模型上线',
        'ann.steps': '使用步骤',
        'ann.features': '功能介绍',
        'ann.later': '稍后再说',
        'ann.page': '第 {n} / {total} 页',
        'ann.openSettings': '打开设置页',
        'ann.p1': '免密：安装即可用，不需要注册、不需要填任何 API Key。',
        'ann.p2': '清单跟随上游：模型集合、上下文长度与能力每次刷新都重新拉取。',
        'ann.p3': '诚实的能力声明：探测不出来的能力不会显示，思考强度档位是真实生效的输出上限。',
        'ann.n1': '两个新模型已通过 EAC 渠道上线，由 OpenCode 免费车道转发：DeepSeek V4.1 Flash Free 与 GLM 5.3 Flash Free。',
        'ann.n2': '它们排在 EAC 模型页最前面，带红色 NEW / 爆 徽标和「高速」标签，一眼就能找到。',
        'ann.n3': '两个模型都真实支持思考档位（低 / 高 / 最大），DeepSeek 还能关闭思考；档位直接下发到上游，不是提示词。',
        'ann.s1': '在输入框的模型选择器里选 “Get It For Free” 分组下的任意模型。',
        'ann.s2': '需要更强推理时点开 Effort 档位；它是真实下发的输出预算，不是提示词。',
        'ann.s3': '想被其它本地工具调用：设置页 → 本地转发 → 启用，把 Base URL 和 Key 填进去。',
        'ann.s4': '地区受限模型会在你切换网络出口后自动重新归类，无需手动操作。',
        'ann.f1': '模型清单：可用性、上下文长度、是否支持视觉、是否可调思考。',
        'ann.f2': 'Token 热力图与总量曲线，支持总计与按模型分别查看。',
        'ann.f3': '输出速度（tok/s）与首字延迟（TTFT）逐次采样。',
        'ann.f4': 'OpenAI 兼容转发端口 + 可生成的 API Key。',
        'ann.f5': '全部数据留在本机，不上传任何遥测。',
        'ann.updates': '公告与升级',
        'ann.u1': '公告中心：仓库主人推送的新公告会实时到达，支持图文排版（HTML）。',
        'ann.u2': '系统通知：开启后，新公告与插件更新会弹出系统级通知。',
        'ann.u3': '应用内升级：自主管理的安装可在设置页升级；宿主管理的安装请通过原安装方式更新。',
        'ann.u4': '自主管理的安装可尝试应用内升级与热重载；宿主管理的安装请通过原安装方式更新，按宿主提示重新加载。',
        'section.news': '公告中心',
        'section.newsHint': '公告由仓库主人推送，本页实时接收。',
        'section.upgrade': '插件升级',
        'section.upgradeHint': '更新方式取决于安装来源；由宿主管理的安装请通过原安装方式更新。',
        'upgrade.managed': '此安装由安装它的宿主管理，请通过原安装方式更新；插件内检查、升级和热重载不可用。',
        'news.unread': '{n} 条未读',
        'news.allRead': '全部已读',
        'news.markRead': '标记已读',
        'news.expand': '展开公告',
        'news.collapse': '收起公告',
        'news.refresh': '检查新公告',
        'news.refreshing': '检查中…',
        'news.empty': '暂无公告。仓库主人推送的新公告会出现在这里。',
        'news.emptyHint': '公告内容支持图文排版，由仓库主人在插件仓库中编辑发布。',
        'news.osEnable': '开启系统通知',
        'news.osOn': '系统通知已开启',
        'news.osOff': '系统通知未开启',
        'news.osDenied': '浏览器拒绝了通知权限；需要在系统/浏览器设置里手动恢复。',
        'news.link': '查看详情',
        'news.urgentTitle': '重要公告',
        'news.gotIt': '知道了',
        'news.lastFetch': '最近拉取',
        'news.fetchFailed': '公告源暂不可达（显示的是缓存）',
        'level.info': '通知',
        'level.update': '更新',
        'level.warn': '注意',
        'level.urgent': '紧急',
        'upgrade.current': '运行版本',
        'upgrade.installed': '磁盘版本',
        'upgrade.mismatch': '运行版本与磁盘版本不一致，请先确认安装状态，再重载或重启。',
        'upgrade.recovery': '上次升级未完整恢复。请关闭应用，使用保留的备份恢复安装目录，重新启动后检查更新。',
        'upgrade.backup': '恢复备份',
        'upgrade.latest': '最新版本',
        'upgrade.checkedAt': '上次检查',
        'upgrade.never': '从未检查',
        'upgrade.check': '检查更新',
        'upgrade.star': '去 GitHub 点 Star',
        'upgrade.checking': '检查中…',
        'upgrade.upToDate': '已是最新版本',
        'upgrade.available': '可升级到 {version}',
        'upgrade.apply': '立即升级',
        'upgrade.applying': '升级中…',
        'upgrade.phase.download': '正在下载新版本…',
        'upgrade.phase.install': '正在安装文件…',
        'upgrade.phase.reload': '正在热重载…',
        'upgrade.done': '已升级到 {version}，插件已热重载生效。',
        'upgrade.doneRefresh': '已升级到 {version}。点击刷新页面加载新界面。',
        'upgrade.failed': '升级失败：{message}',
        'upgrade.history': '最近一次升级',
        'upgrade.from': '由 {from} 升级',
        'upgrade.notes': '更新说明',
        'upgrade.auto': '自动检查：每 {n} 小时',
        'upgrade.autoOff': '自动检查已关闭',
        'reload.now': '热重载插件',
        'reload.reloading': '重载中…',
        'reload.done': '插件已热重载（第 {n} 次）。',
        'reload.refresh': '刷新页面',
        'reload.auto': '文件变化自动热重载',
        'toast.annTitle': '新公告',
        'toast.updateTitle': '插件可升级',
        'toast.updateBody': '发现新版本 {latest}（当前 {current}），可到设置页升级。',
        'nav.tab.free': '免费模型',
        'nav.tab.eac': 'EAC 模型',
        'nav.tab.channels': '渠道接入',
        'nav.tab.picks': '推荐项目',
        'star.cta': '点个 Star',
        'star.title': '在 GitHub 上给本仓库点 Star',
        'picks.title': '推荐项目',
        'picks.sub': '同一作者的一组开源项目：把 Agent 装进原生桌面、让上百个插件和谐共存、把视频和设计留在这台机器上。用得上，就顺手点个 Star。',
        'picks.foot': 'Star 是开源项目唯一的「工资条」——它决定作者还能投入多少时间。这里的项目都免费、开源、无广告，点一下就是最实在的支持。',
        'picks.stars': 'Stars',
        'picks.forks': 'Forks',
        'picks.fork': 'Fork',
        'picks.totalStars': '{c} 个推荐项目共 {n} 个 Star',
        'picks.updated': '最近更新',
        'picks.stale': '缓存数据',
        'picks.liveFailed': '暂时读不到 GitHub 数据，数字稍后自动补上——不影响下面的链接。',
        'picks.getDesktop': '下载安装',
        'picks.getPack': '安装说明',
        'picks.getDesign': '安装说明',
        'picks.star': '点个 Star',
        'picks.starHint': '在 GitHub 上打开并点 Star',
        'picks.desktop.badge': '桌面工作台',
        'picks.desktop.tagline': '把 Agent 的能力，组织成一张真正能工作的桌面。',
        'picks.desktop.body': '基于 DeepSeek Harness 的开源桌面工作台：Tauri 原生窗口、随包 Node 运行时，双击即进入工作。项目文件、会话变更、插件目录与皮肤市场都在一处，Windows / Linux / macOS 都有安装包。',
        'picks.desktop.tag1': 'Tauri 原生窗口',
        'picks.desktop.tag2': '随包运行时',
        'picks.desktop.tag3': '文件协作与还原',
        'picks.desktop.tag4': '插件市场与皮肤',
        'picks.pack.badge': '插件整合包',
        'picks.pack.tagline': '揽尽万象：让数百个 DSH 插件和谐共存。',
        'picks.pack.body': '为 DSH Desktop 提供插件目录、批量安装、更新与移除管理，内置 72 个基线子插件、皮肤预览与 Prompt 合集；固定摘要清单逐字节校验，装出来的环境完整可信。',
        'picks.pack.tag1': '72 个基线插件',
        'picks.pack.tag2': '批量安装 / 更新',
        'picks.pack.tag3': '皮肤预览',
        'picks.pack.tag4': '摘要校验',
        'picks.design.badge': '设计工作台',
        'picks.design.tagline': '在本地把视频和设计做完，不把素材交给别人。',
        'picks.design.body': 'DeepSeek Harness 的本地视频制作与设计插件：多轨剪辑、模板与设计体系、原生预览画布，成品导出为真实文件。全流程在本机完成，素材与工程留在自己硬盘上。',
        'picks.design.tag1': '多轨剪辑',
        'picks.design.tag2': '模板与设计体系',
        'picks.design.tag3': '原生预览画布',
        'picks.design.tag4': '真实文件导出',
        'free.title': '免费模型',
        'free.sub': '免登录、免 Key、免配置：模型清单跟随上游刷新，可用性由这台机器实测。',
        'sponsor.bannerTag': '中转站',
        'sponsor.bannerTitle': '北辰 API 中转站',
        'sponsor.bannerDescription': 'OFM 官方合作中转站，为用户提供稳定、开放、高性价比的大模型 API 接入服务。支持 Claude、ChatGPT、Grok、Gemini、智谱 GLM、Kimi、DeepSeek 等主流模型，适合在 Codex、Gemini CLI、Claude Code 及其他开发工具中统一配置使用。邀请可获百分之十的返现。',
        'sponsor.bannerCta': '立即查看',
        'free.tankLabel': '免费车道可用度',
        'free.tankNote': '水位 = 当前可用模型占比（{ok}/{total}）',
        'free.tankEmpty': '尚未探测，水位按已声明模型占位。',
        'eac.title': 'EAC 模型',
        'eac.sub': '桌面端协付渠道：GitHub 登录并 star 本仓库后解锁，与免费车道互不影响。',
        'eac.tankLabel': '协付池压力',
        'chan.title': '渠道接入',
        'chan.sub': '把各家的免费额度接进来：登录一次，模型就出现在对话框的模型选择器里。凭据只写入本机凭据库，页面永远拿不到明文。',
        'chan.pack.failed': '渠道包未挂载：{reason}（免费车道与 EAC 不受影响）',
        'chan.pack.hint': '渠道包由本插件内置（vendor/channel-pack），随插件一起升级。',
        'chan.state.on': '已接入',
        'chan.state.off': '未接入',
        'chan.state.closed': '已关闭',
        'chan.meta.accounts': '账号',
        'chan.meta.models': '模型',
        'chan.act.add': '添加账号',
        'chan.zcode.bigmodel': 'bigmodel.cn',
        'chan.zcode.zai': 'z.ai 国际版',
        'chan.act.refresh': '续期',
        'chan.act.test': '测试',
        'chan.act.delete': '移除',
        'chan.act.claim': '一键领取',
        'chan.fold.accounts': '账号',
        'chan.fold.models': '模型',
        'chan.noAccount': '还没有账号——点「添加账号」开始登录。',
        'chan.enabled': '已启用',
        'chan.act.enable': '启用',
        'chan.act.disable': '停用',
        'chan.expires.never': '长效',
        'chan.disabled': '已停用',
        'chan.login.title': '登录 {name}',
        'chan.login.step1': '在浏览器中完成登录（若没有自动打开，点下面的按钮）。',
        'chan.login.step2': '登录成功后本页会自动完成，无需复制任何东西。',
        'chan.login.open': '打开登录页',
        'chan.login.cancel': '取消',
        'chan.login.waiting': '已打开登录页，等待授权…（最长等待 10 分钟）',
        'chan.login.expired': '等待超时，请重新发起登录。',
        'chan.login.done': '已接入：{login}',
        'chan.login.failed': '登录未完成：{reason}',
        'chan.test.ok': '连接正常（{ms} ms）',
        'chan.test.failed': '测试失败：{reason}',
        'chan.claim.result': '已领取 {count} 个账号，共 {credit} 积分。',
        'chan.claim.none': '今天没有可领取的积分。',
        'chan.credit.today': '今日已领 {credit}',
        'chan.model.free': '免费额度',
        'chan.model.dead': '已下架',
        'chan.model.hidden': '已隐藏',
        'chan.model.restore': '恢复显示',
        'chan.model.off': '关闭',
        'chan.model.on': '开启',
        'chan.model.enableAll': '全部开启',
        'chan.model.disableAll': '全部关闭',
        'chan.model.enabledCount': '已开启 {enabled}/{total}',
        'chan.model.allScope': '仅操作当前渠道的全部模型',
        'chan.error': '操作失败：{reason}',
        'chan.confirm.delete': '移除账号 {name}？该账号的凭据会一并删除。',
        'chan.rpc.unavailable': '宿主未提供 connection 服务，渠道操作暂不可用。',
        'nav.tab.ledger': '数据看板',
        'nav.tab.logs': '运行日志',
        'nav.tab.gateway': '网关设置',
        'nav.tab.upgrade': '插件升级',
        'chan.titleSingle': '渠道',
        'dash.title': '数据看板',
        'dash.sub': '渠道模型的 Token 消耗与推理指标：输入/输出/思考/缓存逐项统计，账号与模型双维度透视。',
        'dash.today': '今日数据',
        'dash.all': '全部历史',
        'dash.refresh': '刷新',
        'dash.kpiToday': '今日消耗 Token',
        'dash.kpiScopeAll': '范围内消耗 Token',
        'dash.kpiCumulative': '累计消耗 Token',
        'dash.kpiSpeed': '平均生成速度',
        'dash.kpiCache': '上下文缓存命中率',
        'dash.kpiRequests': '请求数 & 成功率',
        'dash.input': '输入',
        'dash.output': '输出',
        'dash.reasoning': '思考',
        'dash.ttft': '首字',
        'dash.cacheTokens': '缓存命中',
        'dash.successRate': '成功率',
        'dash.failed': '失败',
        'dash.recentTitle': '总览 · 最近请求',
        'dash.recentHint': '来自渠道包的逐请求账本：时间、账号、首字延迟、生成速度与 Token 细分。',
        'dash.empty': '暂无数据——通过渠道模型发起一次对话后，这里就会开始记录。',
        'dash.accountsTitle': '各账号用量透视与模型消耗分布',
        'dash.accountsHint': '按账号汇总请求数与 Token 细分，附调用量最高的模型。',
        'dash.modelsTitle': '模型性能指标与用量一览',
        'dash.modelsHint': '融合首字延迟、生成速度与 Token 统计 · 用量占比按消耗 Token 计算。',
        'log.time': '时间',
        'log.model': '模型',
        'log.account': '账号',
        'log.via': '通道',
        'log.viaDirect': '对话',
        'log.viaGateway': '网关',
        'log.result': '结果',
        'log.ok': '成功',
        'log.failed': '失败',
        'log.duration': '耗时',
        'log.ttft': '首字',
        'log.speed': '速度',
        'log.input': '输入',
        'log.output': '输出',
        'log.reasoning': '思考',
        'log.cache': '缓存',
        'log.total': '总 token',
        'log.requests': '请求数',
        'log.inputSlash': '输入 / 输出 / 思考',
        'log.cacheHit': '缓存命中率',
        'log.share': '用量占比',
        'log.modelMix': '调用的模型分布',
        'log.unattributed': '未归属',
        'logs.title': '运行日志',
        'logs.sub': '逐条请求明细：结果、耗时、首字、速度与 Token 细分；悬停失败行可看原因。',
        'logs.auto': '每 10 秒自动刷新',
        'logs.count': '共 {total} 条 · 本页 {shown} 条',
        'logs.empty': '还没有请求记录。',
        'logs.page': '第 {page} 页 / 共 {pages} 页',
        'logs.windowNote': '逐条日志保留最近窗口；历史只保留按日聚合（约 90 天），数据看板的「全部历史」即来源于此。',
        'gw.title': '网关设置',
        'gw.sub': '把渠道模型以 OpenAI 兼容接口发给本机与局域网工具：端点、密钥与转发端口都在这里。',
        'gw.gatewayTitle': '渠道模型网关（OpenAI 兼容）',
        'gw.gatewayHint': '覆盖全部已接入渠道；Chat Completions 与 Responses 两套接口同时可用。',
        'gw.running': '运行中',
        'gw.stopped': '未运行',
        'gw.envBlocked': '已被环境变量停用',
        'gw.switch': '启用网关',
        'gw.endpoint': '端点',
        'gw.key': 'API Key',
        'gw.show': '显示',
        'gw.hide': '隐藏',
        'gw.keyNote': '明文凭据：只用于客户端配置，请勿外发。',
        'gw.keyNone': '尚未生成',
        'gw.keyNoneHint': '启用一次网关即会自动生成密钥。',
        'gw.models': '可转发模型',
        'gw.portNote': '端口可用环境变量 DSH_OPENAI_GATEWAY_PORT 调整。',
        'gw.relayTitle': '局域网转发（本插件中继）',
        'gw.relayHint': '把网关再暴露到一个可选的地址与端口：调用方用下面的中继密钥，网关自身只监听本机。',
        'gw.relaySwitch': '启用局域网转发',
        'gw.relayBind': '监听地址',
        'gw.bindLocal': '仅本机（127.0.0.1）',
        'gw.bindLan': '局域网（0.0.0.0）',
        'gw.relayPort': '端口',
        'gw.relayUrl': 'Base URL',
        'gw.relayKey': '中继密钥',
        'gw.rotate': '轮换',
        'gw.relayNote': '中继只放行模型接口（/v1/*），并要求携带中继密钥；局域网绑定意味着同网段的设备都能访问到这个端口。',
        'gw.freeLaneNote': '免费车道（Get It For Free）自己的转发端口在「免费模型」页的「本地转发」分区。',
        'chan.credits.left': '剩余积分',
        'chan.credits.tokens': '剩余 Token',
        'chan.credits.dollars': '剩余余额（USD）',
        'chan.credits.quota': '剩余配额',
        'chan.credits.loaded': '已查询 {count} 个账号',
        'chan.credits.refresh': '刷新余额',
        'chan.credits.loading': '余额查询中…',
        'chan.credits.failed': '余额查询失败：{reason}',
        'chan.credits.partial': '{count} 个账号未能查询余额，请展开账号查看原因并重试。',
        'chan.credits.unavailable': '未返回余额数据',
        'chan.claim.failed': '领取失败：{reason}',
        'chan.auto.title': '每日自动签到',
        'chan.auto.running': '签到进行中…',
        'chan.auto.ran': '今日已自动签到',
        'chan.auto.off': '今日尚未签到',
        'chan.auto.last': '上次结果：{result}',
        'nav.tab.aggregate': '聚合渠道',
        'nav.tab.saver': '省 Token',
        'nav.tab.routing': '路由',
        'agg.title': '聚合渠道',
        'agg.sub': '把第三方 OpenAI 兼容端点接进同一条模型清单：写入本机的 Key 只以指纹回显，保存后清单与模型选择器一起更新。',
        'agg.registryCount': '注册表 {n} 家',
        'agg.configuredCount': '已配置 {n} 家',
        'agg.addProvider': '添加提供商',
        'agg.addTitle': '选择提供商',
        'agg.addHint': '可按分类、协议与认证方式筛选。标了「不可驱动」的提供商需要交互式登录或云侧凭据，本车道不会调用它们。',
        'agg.search': '搜索名称或 ID',
        'agg.filterCategory': '分类',
        'agg.filterFormat': '协议',
        'agg.filterAuth': '认证',
        'agg.filterAll': '全部',
        'agg.showing': '显示 {shown} / {total} 家',
        'agg.noMatch': '没有匹配的提供商。',
        'agg.notUsable': '不可驱动',
        'agg.notUsableWhy': '本车道不会调用它：认证方式是「{kind}」，需要交互式登录或云侧凭据，只能由宿主自己接管。',
        'agg.credential': '获取 Key',
        'agg.modelCount': '{n} 个模型',
        'agg.select': '配置',
        'agg.configuredTitle': '已配置的提供商',
        'agg.configuredHint': '保存后立即生效：清单与模型选择器一起更新。',
        'agg.empty': '还没有接入任何聚合提供商',
        'agg.emptyHint': '这一页把第三方端点接进模型清单：聚合站、免费额度池、本机推理服务都行。填入 Key 与可选的 Base URL，它们的模型就会出现在模型选择器里，也能成为降级链的一环。',
        'agg.filterEmpty': '没有符合筛选条件的已配置提供商。',
        'agg.contributes': '当前贡献 {n} 个模型',
        'agg.contributesNone': '当前未贡献任何模型',
        'agg.hasKey': '已存 Key {hint}',
        'agg.noKey': '未存 Key',
        'agg.enabled': '启用',
        'agg.disabled': '已停用',
        'agg.key': 'API Key',
        'agg.keyPlaceholder': '粘贴新的 API Key（留空则保持不变）',
        'agg.keyKeep': '留空保持当前 Key 不变；要删除请用下面的清除按钮。',
        'agg.keyClear': '清除已保存的 Key',
        'agg.keyClearWarn': '清除后该提供商立即停止贡献模型，直到重新填入 Key。',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': '留空则使用注册表默认值。',
        'agg.baseUrlDefault': '注册表默认：{url}',
        'agg.baseUrlEnv': '也可用环境变量 {env} 覆盖',
        'agg.models': '模型覆盖',
        'agg.modelsHint': '逗号或换行分隔的模型 ID；留空则用它自己声明的清单。',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': '测试',
        'agg.testing': '测试中…',
        'agg.testOk': '验证通过',
        'agg.testFailed': '验证失败',
        'agg.testUnverified': '无法验证',
        'agg.testUnverifiedWhy': '该提供商不提供模型列表接口，验证它要花掉一次真实生成——这里不做。',
        'agg.testAt': '最近测试 {when}',
        'agg.neverTested': '尚未测试',
        'agg.discover': '发现模型',
        'agg.discovering': '发现中…',
        'agg.discovered': '发现 {n} 个模型',
        'agg.discoveredNone': '该提供商不提供模型列表。',
        'agg.discoveredUse': '填入模型覆盖',
        'agg.save': '保存',
        'agg.saving': '保存中…',
        'agg.add': '添加',
        'agg.remove': '移除',
        'agg.removeConfirm': '确认移除',
        'agg.removeWarn': '移除后它贡献的模型立即从清单消失，已保存的 Key 一并删除。',
        'agg.cancel': '取消',
        'agg.saved': '已保存',
        'agg.savedBody': '{name} 的配置已保存。',
        'agg.removedBody': '{name} 已移除。',
        'agg.failed': '操作失败',
        'agg.loadFailed': '无法读取提供商注册表',
        'agg.category.apikey': 'API Key',
        'agg.category.free': '完全免费',
        'agg.category.freeTier': '免费额度',
        'agg.category.local': '本机',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API Key',
        'agg.auth.none': '免认证',
        'agg.auth.oauth': 'OAuth 登录',
        'agg.auth.adc': '云侧凭据',
        'saver.title': '省 Token',
        'saver.sub': '在请求离开本机之前压缩它：工具输出重编码、提示词瘦身，以及五个不占用上游请求的本地应答。',
        'saver.master': '启用 Token 压缩',
        'saver.masterHint': '关掉后所有压缩立即停止，请求按原样发出；下面的设置保留。',
        'saver.rtk': 'RTK 工具输出压缩',
        'saver.rtkWhat': '压缩的是工具结果：git diff / status / log、grep、find、ls、tree、构建日志、带行号的文件转储，以及重复的日志行。',
        'saver.rtkSafety': '安全边界：报错的工具结果原样保留，小体积内容不碰，替换只在新文本更小且非空时发生——压缩结果永远不会比原文更大。',
        'saver.promptTitle': '提示词压缩',
        'saver.promptHint': '在系统提示里追加一条写作指令。这是唯一能减少输出 Token 的压缩，因为它改变的是模型怎么写。',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': '电报体回复：去掉客套与重复解释，只留结论与代码。',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI 最小实现：只写被要求的那一件事，不主动加抽象、配置与兜底。',
        'saver.voiceWarn': '注意：这两族会改变助手的说话方式，并且会留在你的对话记录里。默认关闭。',
        'saver.localTitle': '本地应答',
        'saver.localHint': '这五类请求的答案就在请求体里，转发出去只是白花一次上游额度与一个来回。',
        'saver.local.enabled': '启用本地应答',
        'saver.local.quota': '额度探测',
        'saver.local.quotaHint': '回答「额度检查」这类探针，返回一句固定答复。',
        'saver.local.prefix': '命令前缀',
        'saver.local.prefixHint': '回答权限提示要的命令前缀，从 shell 命令里解析。',
        'saver.local.title': '会话标题',
        'saver.local.titleHint': '回答标题生成请求，返回固定标题。',
        'saver.local.suggestion': '建议模式',
        'saver.local.suggestionHint': '回答建议模式的空转回合，不产生上游请求。',
        'saver.local.filepath': '文件路径提取',
        'saver.local.filepathHint': '从命令与输出里解析出文件路径，返回结构化结果。',
        'saver.dashTitle': '节省统计',
        'saver.dashHint': '按字节统计本机实际发生的压缩，只写入本机。',
        'saver.bytesBefore': '压缩前',
        'saver.bytesAfter': '压缩后',
        'saver.bytesSaved': '节省字节',
        'saver.percent': '节省比例',
        'saver.blocks': '压缩块数',
        'saver.calls': '统计调用',
        'saver.promptCalls': '提示词注入',
        'saver.noData': '还没有可统计的请求。发起一次对话后，这里显示的是真实压缩字节数，不是估算。',
        'saver.report': '统计口径',
        'saver.saved': '已保存',
        'saver.savedBody': 'Token 压缩设置已保存。',
        'saver.failed': '保存失败',
        'saver.loadFailed': '无法读取 Token 压缩设置',
        'saver.level.off': '关闭',
        'saver.level.lite': '轻',
        'saver.level.full': '全',
        'saver.level.ultra': '极',
        'saver.level.wenyanLite': '文言·轻',
        'saver.level.wenyan': '文言',
        'saver.level.wenyanUltra': '文言·极',
        'routing.title': '路由',
        'routing.sub': '把若干模型串成一条降级链：链上第一个失败就换下一个，对调用方始终只有一个模型 ID。',
        'routing.chains': '已存链路',
        'routing.chainsHint': '链路按输入顺序保存；引用当前不可用模型的链路会原样保留，车道恢复后自己回来。',
        'routing.empty': '还没有降级链',
        'routing.emptyHint': '一条链就是一个虚拟模型：在模型选择器里选它，请求按顺序尝试链上的每个真实模型。用来兜住某个车道临时不可用的时段。',
        'routing.newChain': '新建链路',
        'routing.name': '名称',
        'routing.namePlaceholder': '例如：先免费后协付',
        'routing.strategy': '策略',
        'routing.strategy.fallback': '顺序降级',
        'routing.strategy.roundRobin': '轮询',
        'routing.stickyLimit': '轮询粘滞次数',
        'routing.stickyHint': '轮询时同一个模型连续用多少次再换下一个。',
        'routing.members': '成员（按顺序）',
        'routing.addMember': '添加成员',
        'routing.memberEmpty': '还没有成员——点「添加成员」从清单里挑一个。',
        'routing.moveUp': '上移',
        'routing.moveDown': '下移',
        'routing.removeMember': '移除',
        'routing.pickModel': '选择模型',
        'routing.searchModel': '搜索模型 ID 或名称',
        'routing.noModel': '没有匹配的模型。',
        'routing.usable': '可用',
        'routing.notUsable': '当前不可用',
        'routing.missing': '不在清单中的成员：{ids}',
        'routing.notUsableWhy': '链路原样保存，不会因为某条车道今天关闭而被改写；这些 ID 回到清单里它就自己恢复。如果是拼写错误，编辑链路改正即可。',
        'routing.resolved': '解析为',
        'routing.memberCount': '{n} 个成员',
        'routing.save': '保存链路',
        'routing.saved': '已保存',
        'routing.savedBody': '链路已保存。',
        'routing.failed': '保存失败',
        'routing.loadFailed': '无法读取链路设置',
        'routing.cancel': '取消',
        'routing.edit': '编辑',
        'routing.delete': '删除',
        'routing.deleteConfirm': '确认删除',
        'routing.deleteWarn': '删除后这个模型 ID 立即从清单消失，正在引用它的客户端会拿到 404。',
        'routing.enabled': '启用',
        'routing.channel.free': '免费车道',
        'routing.channel.eac': 'EAC 协付',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': '聚合',
        'routing.channel.combo': '链路',
        'gw.clientsTitle': '接入客户端',
        'gw.clientsHint': '免费车道转发端口（在「免费模型」页的「本地转发」里开关）的接入配方：地址与 Key 按实际绑定的端口与真实密钥生成。',
        'gw.clientsOff': '转发端口未启用',
        'gw.clientsOffHint': '先到「免费模型」页的「本地转发」打开端口，这里才会给出可用的地址与配方。',
        'gw.clientsModels': '可转发模型 {n} 个',
      },
      en: {
        'meta.title': 'Get It For Free',
        'meta.description': 'Free no-key models inside DeepSeek Harness: a roster that follows upstream, live regional availability, genuinely enforced thinking levels, a token dashboard and an OpenAI-compatible local forward port.',
        'ann.pitch': 'All you do is install this plugin in dsh — no login, no sign-up, no API key, no other step of any kind. The frontier models are simply there, Muse Spark 1.3 and MiMo V2.6 among them. Completely free, with no usage cap.',
        nav: 'Get It For Free',
        title: 'Get It For Free',
        refresh: 'Refresh roster',
        reprobe: 'Re-probe availability',
        probing: 'Probing…',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        'state.available': 'Available',
        'state.region-blocked': 'Region-limited',
        'state.unavailable': 'Unavailable',
        'state.throttled': 'Temporarily unavailable',
        'state.unknown': 'Not probed',
        'state.listed': 'Listed · not tested',
        'roster.selectable': 'Selectable models',
        'hint.listed': 'Listed by the channel; inference has not been tested. This does not confirm chat or tool use.',
        'hint.region': 'This model is gated by egress country. Once a proxy changes your egress, the next probe moves it into the available group by itself.',
        'hint.unknown': 'Not probed yet, so it stays reachable.',
        'hint.hidden': 'The gateway names it but refuses to route it, so it is out of the model picker. It returns by itself as soon as a probe gets through.',
        'hint.sharedBudget': 'Thinking cannot be switched off on this model, so thinking and the visible answer share one ceiling — a lower rung leaves the answer less room.',
        'tag.vision': 'Vision',
        'tag.text': 'Text only',
        'tag.thinking': 'Tunable thinking',
        'tag.thinkingShared': 'Thinking always on',
        'tag.rung': 'Default ceiling',
        'tag.rungTitle': 'What each rung actually sends: {ladder}. A rung is one ceiling shared by thinking and the answer, and it never exceeds the max output above or the per-call ceiling in settings.',
        'tag.levels': 'Thinking levels',
        'tag.levelsTitle': 'The levels this model declares itself; the selected one is sent as-is in the upstream reasoning_effort field, and a value outside the set is rejected upstream.',
        'effort.off': 'Off',
        'effort.minimal': 'Minimal',
        'effort.low': 'Low',
        'effort.medium': 'Medium',
        'effort.high': 'High',
        'effort.xhigh': 'Extra high',
        'effort.max': 'Max',
        'tag.context': 'Context',
        'tag.output': 'Max output',
        'tag.latency': 'First token',
        'tag.eacChannel': 'EAC lane · co-paid',
        'tag.new': 'NEW',
        'tag.newTitle': 'Just added: relayed to the EAC lane from OpenCode’s free tier.',
        'tag.hot': '爆',
        'tag.hotTitle': 'One of the most requested free models right now.',
        'tag.fast': 'Fast',
        'tag.fastTitle': 'Quick first token and high throughput — good for long or back-to-back turns.',
        'tag.kiloChannel': 'Kilo channel · free pool (prompts may be logged by the upstream provider — never send sensitive content)',
        'roster.noLane': 'The co-paid EAC models are unavailable in this composition: the host did not present a recognized desktop or web profile, so the lane is not loaded.',
        'section.models': 'Model roster',
        'section.modelsHint': 'Names and capacities come from the upstream roster and published capability tables; availability is measured from this machine.',
        'section.dash': 'Usage dashboard',
        'section.dashHint': 'Written to this machine only; nothing is uploaded.',
        'section.forward': 'Local forward (OpenAI compatible)',
        'section.forwardHint': 'Let other local tools reach these models through one base URL.',
        'section.egress': 'Egress outlet (subscription routing)',
        'section.egressHint': 'Send inference and probe traffic through a proxy outlet to ease per-IP rate limits.',
        'egress.enabled': 'Enable outlet',
        'egress.modeSubscription': 'Subscription mode (local mihomo picks the fastest node)',
        'egress.url': 'Subscription / proxy URL',
        'egress.urlNew': 'Replace the address',
        'egress.urlPlaceholder': 'Paste a new subscription / proxy URL (leave empty to keep the current one)',
        'egress.urlNone': 'not set',
        'egress.urlClear': 'Clear',
        'egress.urlClearWarn': 'Clear the stored subscription / proxy address and turn the outlet off',
        'egress.mihomoPath': 'mihomo path',
        'egress.mihomoHint': 'Leave empty in subscription mode to auto-locate a local mihomo (e.g. Clash Verge).',
        'egress.apply': 'Apply',
        'egress.active': 'Outlet active',
        'egress.inactive': 'Not enabled',
        'egress.outlet': 'Current outlet',
        'egress.node': 'Best node',
        'egress.latency': 'opencode access',
        'egress.measuring': 'measuring…',
        'egress.direct': 'While off, requests go direct; the address is treated as a credential — kept in this machine\'s settings only, never sent down with the regular API payloads, readable only through the reveal button, masked here by default.',
        'egress.error': 'The outlet failed to start: {message}',
        'section.prefs': 'Plugin settings',
        'section.prefsHint': 'Changes take full effect on the next load.',
        'pool.levelOk': 'Healthy',
        'pool.levelBusy': 'Busy',
        'pool.capacity': 'Pool capacity',
        'pool.levelOver': 'Overloaded',
        'pool.reach': 'Capacity in use',
        'pool.formula': '{stars} stars × 1.5',
        'pool.configured': 'configured count',
        'pool.active': '24h active',
        'pool.live': 'in flight',
        'pool.unavailable': 'Pool data unavailable · {reason}',
        'pool.reasonNoLane': 'no co-paid lane in this composition',
        'pool.reasonGateway': 'gateway answered an error',
        'pool.reasonMalformed': 'gateway data malformed',
        'pool.reasonUnreachable': 'gateway unreachable',
        'pool.reasonUnknown': 'unknown cause',
        'pool.capacityUnknown': 'star data unavailable',
        'section.eac': 'EAC lane authorization',
        'section.eacHint': 'EAC (co-paid) models need a GitHub login and a star; the free lane is unaffected.',
        'eac.pillOk': 'authorized',
        'eac.pillLocked': 'not authorized',
        'eac.pillRequired': 'enforced',
        'eac.pillCompat': 'grace period',
        'eac.pillUnknown': 'authorization policy unverified',
        'eac.pollFailed': 'Could not collect authorization ({reason}); retrying automatically. No new sign-in is needed.',
        'eac.saveFailed': 'Authorization completed, but this machine could not save it. Check DSH_HOME permissions; collection will retry automatically.',
        'eac.cancel': 'Cancel this sign-in',
        'eac.cancelFailed': 'Could not confirm cancellation. Please try again.',
        'eac.pillUnverified': 'gateway unreachable',
        'eac.intro': 'EAC turns are checked server-side: sign in with GitHub and star {repo} to unlock them. The browser does the work — nothing to paste — and removing the star revokes access automatically.',
        'eac.login': 'Sign in with GitHub',
        'eac.starting': 'Opening the browser…',
        'eac.waiting': 'The authorization page is open; if the browser did not come up, visit the address below to finish. This page confirms automatically.',
        'eac.copy': 'Copy link',
        'eac.copied': 'Copied',
        'eac.done': 'Authorized as @{login} — EAC models are unlocked.',
        'eac.needStar': 'Signed in as @{login}, but the repository is not starred yet. Star it, then press "I starred it — check again" on the authorization page.',
        'eac.expired': 'This login attempt timed out; please start again.',
        'eac.sessionExpired': 'The login link is no longer valid (the server does not know it) — please start the GitHub login again.',
        'eac.openManually': 'The browser did not open automatically — visit the address below to finish.',
        'eac.startFailed': 'Could not start the login ({reason}).',
        'eac.loggedIn': 'Authorized: @{login} · last checked {when}',
        'eac.recheck': 'Check again',
        'eac.logout': 'Sign out',
        'eac.noLane': 'The EAC co-paid lane is not unlocked in this composition, so GitHub authorization is unavailable.',
        'eac.lockedTitle': 'Needs GitHub authorization and a star',
        'eac.lockedNote': 'Not authorized: sign in with GitHub and star the repository with the button below, or from the EAC authorization section.',
        'heat.title': 'Token heatmap',
        'heat.legend': 'Less',
        'heat.legendMore': 'More',
        'heat.empty': 'No usage yet. Have one conversation and come back.',
        'curve.title': 'Cumulative tokens',
        'curve.tokens': 'Tokens',
        'curve.requests': 'Requests',
        'curve.total': 'Total',
        'stat.output': 'Output tokens',
        'stat.reasoning': 'Reasoning tokens',
        'col.reason': 'reason',
        'col.output': 'output',
        'last.title': 'Last turn',
        'last.justNow': 'just now',
        'last.minAgo': '{n} min ago',
        'last.hourAgo': '{n} h ago',
        'last.dayAgo': '{n} d ago',
        'last.input': 'input',
        'last.originChat': 'chat',
        'last.originHarness': 'desktop',
        'last.originForward': 'forward',
        'last.originBench': 'bench',
        'speed.title': 'Speed',
        'speed.tps': 'Output speed',
        'speed.ttft': 'First frame',
        'speed.model': 'Model',
        'speed.calls': 'Upstream requests',
        'speed.failed': 'Request failures',
        'speed.turns': 'Conversation turns',
        'speed.turnFailed': 'Turn failures',
        'speed.recovered': 'Recovered',
        'speed.estimated': 'Pre-upgrade history is estimated from upstream requests; turns are exact after upgrade.',
        'speed.scope': 'Requests, turns and tokens are lifetime totals; speed and first frame use the last 40 calls, the heatmap is daily.',
        'speed.none': 'No samples yet',
        'speed.note': 'Output speed covers the {n}/{total} calls it could measure: tokens never streamed out are left out of the numerator, and windows too short to time are dropped.',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': 'Enable the forward port',
        'forward.host': 'Bind address',
        'forward.port': 'Port',
        'forward.apply': 'Apply',
        'settings.failed': 'Settings not saved',
        'forward.running': 'Listening',
        'forward.stopped': 'Off',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API key',
        'forward.show': 'Show',
        'forward.hide': 'Hide',
        'forward.rotate': 'Regenerate',
        'forward.rotateWarn': 'Regenerating invalidates the old key for every tool using it.',
        'forward.copy': 'Copy',
        'forward.copied': 'Copied',
        'forward.example': 'Example',
        'forward.error': 'Could not start: {message}',
        'forward.notice': 'Port notice: {message}',
        'forward.lanTitle': 'Network access',
        'forward.lanHint': 'Let other devices on the same network use this forward port too. Off by default; the relay demands a key of its own.',
        'forward.lanEnabled': 'Allow network access',
        'forward.lanPort': 'Network port',
        'forward.lanAuto': '0 = pick one automatically',
        'forward.lanApply': 'Apply network settings',
        'forward.lanRunning': 'Network relay listening',
        'forward.lanStopped': 'Network relay off',
        'forward.lanError': 'Could not start the network relay: {message}',
        'forward.lanKey': 'Network key',
        'forward.lanRotateWarn': 'Regenerating makes every device on the network switch keys; tools on this machine are unaffected.',
        'forward.lanWarn': 'While this is on, anyone who can reach this machine can spend its free quota with that key. Enable it only on a network you trust, and narrow the sources with a firewall if you can.',
        'forward.lanUrl': 'Network URL',
        'forward.lanNoAddress': 'No network IPv4 address was detected',
        'forward.lanAlso': 'Also reachable at {list}',
        'pref.enabled': 'Enable free models',
        'pref.exposeRegion': 'Show region-limited models',
        'pref.hideFreeModels': 'Hide anonymous and Kilo free models',
        'pref.hideEacModels': 'Hide EAC models',
        'visibility.showModel': 'Show in model picker',
        'visibility.hidden': 'Hidden',
        'visibility.unlisted': 'Unlisted models',
        'visibility.groupHidden': 'This group is hidden. Turn off the group switch above first.',
        'visibility.hint': 'Hiding affects the model picker and gateway listing only. Existing sessions keep working; restore visibility here.',
        'routing.capacity': 'Chain capability intersection',
        'routing.capacityUnavailable': 'Cannot load chain capacities right now. Please retry.',
        'pref.interval': 'Auto-probe interval (minutes)',
        'pref.maxTokens': 'Output ceiling per call (tokens)',
        'pref.egress': 'Current egress',
        'pref.probedAt': 'Last probe',
        'pref.measuredAt': 'Last measurement',
        'bench.run': 'Run once',
        'bench.running': 'Measuring…',
        'bench.notSaved': 'The result could not be saved. Check the data directory; it may be lost after refresh.',
        'bench.result': 'Text response passed · first frame {ttft}ms · {tps} tok/s · {reasoning} reasoning tokens',
        'ann.preamble': 'Preamble',
        'ann.models': 'Model roster',
        'ann.newlane': 'New models',
        'ann.steps': 'How to use',
        'ann.features': 'What it does',
        'ann.later': 'Later',
        'ann.page': 'Page {n} of {total}',
        'ann.openSettings': 'Open settings',
        'ann.p1': 'No credentials: install and use it — no sign-up, no API key to paste.',
        'ann.p2': 'The roster follows upstream: models, context lengths and capabilities are re-fetched on every refresh.',
        'ann.p3': 'Honest capability claims: anything a probe cannot confirm stays hidden, and each effort level is a real output budget.',
        'ann.n1': 'Two new models are live on the EAC lane, relayed from OpenCode’s free tier: DeepSeek V4.1 Flash Free and GLM 5.3 Flash Free.',
        'ann.n2': 'They lead the EAC models page, marked with a red NEW / 爆 badge and a “Fast” tag.',
        'ann.n3': 'Both expose real thinking levels (Low / High / Max), and DeepSeek can also switch thinking off; the level goes to the upstream as-is, not as a prompt hint.',
        'ann.s1': 'Pick any model under the “Get It For Free” group in the composer’s model selector.',
        'ann.s2': 'For harder reasoning, open the Effort menu — it sends a real budget, not a prompt hint.',
        'ann.s3': 'To serve other local tools: Settings → Local forward → enable, then copy the base URL and key.',
        'ann.s4': 'Region-limited models reclassify themselves once your network egress changes.',
        'ann.f1': 'Model roster: availability, context length, vision, tunable thinking.',
        'ann.f2': 'Token heatmap and cumulative curve, per total or per model.',
        'ann.f3': 'Per-call samples of output speed (tok/s) and time to first token.',
        'ann.f4': 'OpenAI-compatible forward port with a generated API key.',
        'ann.f5': 'Everything stays on this machine — no telemetry.',
        'ann.updates': 'News & upgrades',
        'ann.u1': 'Announcement center: pushes from the repository owner arrive live, with rich (HTML) layout.',
        'ann.u2': 'OS notifications: once enabled, new announcements and plugin updates raise system-level toasts.',
        'ann.u3': 'In-app upgrades: self-managed installs can update from settings; host-managed installs use their original installation method.',
        'ann.u4': 'Self-managed installs can use in-app upgrades and hot reload. For host-managed installs, update through the original installation method and reload as instructed by the host.',
        'section.news': 'Announcement center',
        'section.newsHint': 'Published by the repository owner; this page receives them live.',
        'section.upgrade': 'Plugin upgrade',
        'section.upgradeHint': 'Update according to the installation source; host-managed installs use their original installation method.',
        'upgrade.managed': 'This installation is managed by the host that installed it. Update through the original installation method; in-plugin checks, upgrades and hot reload are unavailable.',
        'news.unread': '{n} unread',
        'news.allRead': 'Mark all read',
        'news.markRead': 'Mark read',
        'news.expand': 'Show announcements',
        'news.collapse': 'Hide announcements',
        'news.refresh': 'Check for new announcements',
        'news.refreshing': 'Checking…',
        'news.empty': 'No announcements yet. Anything the owner pushes will appear here.',
        'news.emptyHint': 'Announcements support rich layout and are published by editing the plugin repository.',
        'news.osEnable': 'Enable OS notifications',
        'news.osOn': 'OS notifications on',
        'news.osOff': 'OS notifications off',
        'news.osDenied': 'Notification permission was denied; restore it in your system or browser settings.',
        'news.link': 'Read more',
        'news.urgentTitle': 'Important announcement',
        'news.gotIt': 'Got it',
        'news.lastFetch': 'Last fetch',
        'news.fetchFailed': 'Feed unreachable right now (showing the cached copy)',
        'level.info': 'Notice',
        'level.update': 'Update',
        'level.warn': 'Heads-up',
        'level.urgent': 'Urgent',
        'upgrade.current': 'Running',
        'upgrade.installed': 'On disk',
        'upgrade.mismatch': 'The running and on-disk versions differ. Check the installation before reloading or restarting.',
        'upgrade.recovery': 'The last upgrade was not fully restored. Close the app, restore the installation from the retained backup, restart, then check for updates.',
        'upgrade.backup': 'Recovery backup',
        'upgrade.latest': 'Latest',
        'upgrade.checkedAt': 'Last check',
        'upgrade.never': 'never',
        'upgrade.check': 'Check for updates',
        'upgrade.star': 'Star on GitHub',
        'upgrade.checking': 'Checking…',
        'upgrade.upToDate': 'Up to date',
        'upgrade.available': 'Upgrade to {version} available',
        'upgrade.apply': 'Upgrade now',
        'upgrade.applying': 'Upgrading…',
        'upgrade.phase.download': 'Downloading the new version…',
        'upgrade.phase.install': 'Installing files…',
        'upgrade.phase.reload': 'Hot-reloading…',
        'upgrade.done': 'Upgraded to {version}; the plugin hot-reloaded into place.',
        'upgrade.doneRefresh': 'Upgraded to {version}. Reload the page to load the new UI.',
        'upgrade.failed': 'Upgrade failed: {message}',
        'upgrade.history': 'Last upgrade',
        'upgrade.from': 'from {from}',
        'upgrade.notes': 'Release notes',
        'upgrade.auto': 'Auto-check: every {n} h',
        'upgrade.autoOff': 'Auto-check off',
        'reload.now': 'Hot-reload plugin',
        'reload.reloading': 'Reloading…',
        'reload.done': 'Plugin hot-reloaded (#{n}).',
        'reload.refresh': 'Reload page',
        'reload.auto': 'Hot-reload on file change',
        'toast.annTitle': 'New announcement',
        'toast.updateTitle': 'Plugin update available',
        'toast.updateBody': 'Version {latest} is out (installed {current}). Upgrade from the settings page.',
        'nav.tab.free': 'Free models',
        'nav.tab.eac': 'EAC models',
        'nav.tab.channels': 'Free channels',
        'nav.tab.picks': 'Picks',
        'star.cta': 'Star',
        'star.title': 'Star this repository on GitHub',
        'picks.title': 'Recommended projects',
        'picks.sub': 'A set of open-source projects by the same author: bringing the agent to a native desktop, keeping hundreds of plugins working together, and keeping video and design work on this machine. If they are useful, a star is the thanks they understand.',
        'picks.foot': 'A star is the only payslip an open-source project gets — it decides how much more time the author can spend. Every project here is free, open source and ad-free; one click is the most concrete support there is.',
        'picks.stars': 'Stars',
        'picks.forks': 'Forks',
        'picks.fork': 'Fork',
        'picks.totalStars': '{n} stars across {c} projects',
        'picks.updated': 'Last push',
        'picks.stale': 'cached',
        'picks.liveFailed': 'GitHub numbers are unreachable right now; they will fill in later — the links below are unaffected.',
        'picks.getDesktop': 'Download',
        'picks.getPack': 'Install guide',
        'picks.getDesign': 'Install guide',
        'picks.star': 'Star it',
        'picks.starHint': 'Open GitHub and star',
        'picks.desktop.badge': 'Desktop workbench',
        'picks.desktop.tagline': 'Agent capability, organized into a desktop that actually works.',
        'picks.desktop.body': 'An open-source desktop workbench built on DeepSeek Harness: a Tauri native window with Node bundled in, so a double-click lands you in the work. Project files, session changes, a plugin catalog and a skin market in one place — with installers for Windows, Linux and macOS.',
        'picks.desktop.tag1': 'Tauri native window',
        'picks.desktop.tag2': 'Bundled runtime',
        'picks.desktop.tag3': 'File changes & revert',
        'picks.desktop.tag4': 'Plugin market & skins',
        'picks.pack.badge': 'Plugin suite',
        'picks.pack.tagline': 'Embracing all creation: hundreds of DSH plugins, living together.',
        'picks.pack.body': 'A catalog, batch install, update and removal manager for DSH Desktop, carrying 72 baseline sub-plugins, skin previews and prompt sets; a pinned digest manifest verifies every byte, so an install is complete and trustworthy.',
        'picks.pack.tag1': '72 baseline plugins',
        'picks.pack.tag2': 'Batch install / update',
        'picks.pack.tag3': 'Skin previews',
        'picks.pack.tag4': 'Digest verification',
        'picks.design.badge': 'Design workbench',
        'picks.design.tagline': 'Finish video and design work locally, without handing your footage to anyone.',
        'picks.design.body': 'A local video-production and design plugin for DeepSeek Harness: multi-track editing, templates and a design system, a native preview canvas, and exports that are real files. The whole pipeline runs on this machine, so footage and projects stay on your own disk.',
        'picks.design.tag1': 'Multi-track editing',
        'picks.design.tag2': 'Templates & design system',
        'picks.design.tag3': 'Native preview canvas',
        'picks.design.tag4': 'Real file export',
        'free.title': 'Free models',
        'free.sub': 'No login, no key, no setup: the roster follows upstream, availability is measured from this machine.',
        'sponsor.bannerTag': 'Relay',
        'sponsor.bannerTitle': 'Beichen API relay',
        'sponsor.bannerDescription': 'OFM’s official relay partner provides stable, open and cost-effective model API access. Claude, ChatGPT, Grok, Gemini, GLM, Kimi and DeepSeek are supported for one consistent setup in Codex, Gemini CLI, Claude Code and other developer tools. Invite others to receive 10% cashback.',
        'sponsor.bannerCta': 'View now',
        'free.tankLabel': 'Free-lane availability',
        'free.tankNote': 'Water level = share of reachable models ({ok}/{total})',
        'free.tankEmpty': 'Not probed yet; the level stands at the declared roster.',
        'eac.title': 'EAC models',
        'eac.sub': 'The desktop co-paid lane: unlocked by a GitHub login plus a star, independent of the free lane.',
        'eac.tankLabel': 'Co-paid pool pressure',
        'chan.title': 'Free channel access',
        'chan.sub': 'Bring each vendor\'s free quota in: sign in once and its models appear in the composer\'s model picker. Credentials are written to the local credential store only — this page never sees them.',
        'chan.pack.failed': 'Channel pack not mounted: {reason} (the free and EAC lanes are unaffected)',
        'chan.pack.hint': 'The pack ships inside this plugin (vendor/channel-pack) and upgrades with it.',
        'chan.state.on': 'Connected',
        'chan.state.off': 'Not connected',
        'chan.state.closed': 'Turned off',
        'chan.meta.accounts': 'Accounts',
        'chan.meta.models': 'Models',
        'chan.act.add': 'Add account',
        'chan.zcode.bigmodel': 'bigmodel.cn',
        'chan.zcode.zai': 'z.ai international',
        'chan.act.refresh': 'Refresh',
        'chan.act.test': 'Test',
        'chan.act.delete': 'Remove',
        'chan.act.claim': 'Claim daily',
        'chan.fold.accounts': 'Accounts',
        'chan.fold.models': 'Models',
        'chan.noAccount': 'No account yet — press “Add account” to sign in.',
        'chan.enabled': 'Enabled',
        'chan.act.enable': 'Enable',
        'chan.act.disable': 'Disable',
        'chan.expires.never': 'Long-lived',
        'chan.disabled': 'Disabled',
        'chan.login.title': 'Sign in to {name}',
        'chan.login.step1': 'Finish the sign-in in your browser (if it did not open, use the button below).',
        'chan.login.step2': 'This page completes by itself once the browser flow does — nothing to copy.',
        'chan.login.open': 'Open sign-in page',
        'chan.login.cancel': 'Cancel',
        'chan.login.waiting': 'Sign-in page opened; waiting for authorization… (up to 10 minutes)',
        'chan.login.expired': 'Timed out — please start the sign-in again.',
        'chan.login.done': 'Connected: {login}',
        'chan.login.failed': 'Sign-in did not complete: {reason}',
        'chan.test.ok': 'Connection healthy ({ms} ms)',
        'chan.test.failed': 'Test failed: {reason}',
        'chan.claim.result': 'Claimed for {count} account(s), {credit} credits in total.',
        'chan.claim.none': 'Nothing to claim today.',
        'chan.credit.today': '{credit} claimed today',
        'chan.model.free': 'Free quota',
        'chan.model.dead': 'Retired',
        'chan.model.hidden': 'Hidden',
        'chan.model.restore': 'Restore visibility',
        'chan.model.off': 'Hide',
        'chan.model.on': 'Show',
        'chan.model.enableAll': 'Show all',
        'chan.model.disableAll': 'Hide all',
        'chan.model.enabledCount': 'Shown {enabled}/{total}',
        'chan.model.allScope': 'Apply to all models in this channel only',
        'chan.error': 'Action failed: {reason}',
        'chan.confirm.delete': 'Remove account {name}? Its credential is deleted with it.',
        'chan.rpc.unavailable': 'This host exposes no connection service, so channel actions are unavailable.',
        'nav.tab.ledger': 'Dashboard',
        'nav.tab.logs': 'Request log',
        'nav.tab.gateway': 'Gateway',
        'nav.tab.upgrade': 'Plugin upgrade',
        'chan.titleSingle': 'Channel',
        'dash.title': 'Usage dashboard',
        'dash.sub': 'Token spend and inference metrics for the channel models: input/output/reasoning/cache, pivoted by account and by model.',
        'dash.today': 'Today',
        'dash.all': 'All time',
        'dash.refresh': 'Refresh',
        'dash.kpiToday': 'Tokens today',
        'dash.kpiScopeAll': 'Tokens in scope',
        'dash.kpiCumulative': 'Tokens all time',
        'dash.kpiSpeed': 'Average speed',
        'dash.kpiCache': 'Context cache hit rate',
        'dash.kpiRequests': 'Requests & success rate',
        'dash.input': 'Input',
        'dash.output': 'Output',
        'dash.reasoning': 'Reasoning',
        'dash.ttft': 'TTFT',
        'dash.cacheTokens': 'Cache hits',
        'dash.successRate': 'Success',
        'dash.failed': 'Failed',
        'dash.recentTitle': 'Overview · Recent requests',
        'dash.recentHint': 'From the pack\'s per-request ledger: time, account, TTFT, speed and the token breakdown.',
        'dash.empty': 'Nothing yet — one conversation through a channel model starts the record.',
        'dash.accountsTitle': 'Per-account usage & model mix',
        'dash.accountsHint': 'Requests and token breakdown per account, with the most-used models.',
        'dash.modelsTitle': 'Model performance & usage',
        'dash.modelsHint': 'TTFT, speed and token statistics per model · usage share is by tokens spent.',
        'log.time': 'Time',
        'log.model': 'Model',
        'log.account': 'Account',
        'log.via': 'Via',
        'log.viaDirect': 'Chat',
        'log.viaGateway': 'Gateway',
        'log.result': 'Result',
        'log.ok': 'OK',
        'log.failed': 'Failed',
        'log.duration': 'Duration',
        'log.ttft': 'TTFT',
        'log.speed': 'Speed',
        'log.input': 'Input',
        'log.output': 'Output',
        'log.reasoning': 'Reasoning',
        'log.cache': 'Cache',
        'log.total': 'Total tok',
        'log.requests': 'Requests',
        'log.inputSlash': 'Input / Output / Reasoning',
        'log.cacheHit': 'Cache hit',
        'log.share': 'Share',
        'log.modelMix': 'Model mix',
        'log.unattributed': 'Unattributed',
        'logs.title': 'Request log',
        'logs.sub': 'Every request in detail: result, duration, TTFT, speed and the token breakdown; hover a failed row for the reason.',
        'logs.auto': 'Refresh every 10 s',
        'logs.count': '{total} entries · {shown} on this page',
        'logs.empty': 'No requests recorded yet.',
        'logs.page': 'Page {page} of {pages}',
        'logs.windowNote': 'Per-request rows cover a recent window only; history is kept as daily aggregates (~90 days) — the dashboard\'s "All time" reads those.',
        'gw.title': 'Gateway settings',
        'gw.sub': 'Serve the channel models over an OpenAI-compatible API to this machine and the LAN: endpoint, key and relay port live here.',
        'gw.gatewayTitle': 'Channel gateway (OpenAI compatible)',
        'gw.gatewayHint': 'Covers every connected channel; Chat Completions and Responses are both served.',
        'gw.running': 'Running',
        'gw.stopped': 'Not running',
        'gw.envBlocked': 'Disabled by environment',
        'gw.switch': 'Enable gateway',
        'gw.endpoint': 'Endpoint',
        'gw.key': 'API Key',
        'gw.show': 'Show',
        'gw.hide': 'Hide',
        'gw.keyNote': 'A plaintext credential for client configuration — handle with care.',
        'gw.keyNone': 'Not generated yet',
        'gw.keyNoneHint': 'Enabling the gateway once mints a key automatically.',
        'gw.models': 'Servable models',
        'gw.portNote': 'The port can be moved with the DSH_OPENAI_GATEWAY_PORT environment variable.',
        'gw.relayTitle': 'LAN relay (this plugin\'s)',
        'gw.relayHint': 'Re-expose the gateway on an address and port you choose: callers use the relay key below, and the gateway itself stays on the loopback.',
        'gw.relaySwitch': 'Enable LAN relay',
        'gw.relayBind': 'Bind address',
        'gw.bindLocal': 'This machine only (127.0.0.1)',
        'gw.bindLan': 'LAN (0.0.0.0)',
        'gw.relayPort': 'Port',
        'gw.relayUrl': 'Base URL',
        'gw.relayKey': 'Relay key',
        'gw.rotate': 'Rotate',
        'gw.relayNote': 'The relay forwards only the model routes (/v1/*) and demands the relay key; binding to the LAN means every device on the network can reach that port.',
        'gw.freeLaneNote': 'The free lane (Get It For Free) has its own forward port under "Local forward" on the Free models page.',
        'chan.credits.left': 'Credits left',
        'chan.credits.tokens': 'Tokens left',
        'chan.credits.dollars': 'Balance left (USD)',
        'chan.credits.quota': 'Quota left',
        'chan.credits.loaded': '{count} accounts queried',
        'chan.credits.refresh': 'Refresh balance',
        'chan.credits.loading': 'Querying balance…',
        'chan.credits.failed': 'Balance query failed: {reason}',
        'chan.credits.partial': 'Could not query {count} accounts. Expand accounts to see the reasons and retry.',
        'chan.credits.unavailable': 'No balance data returned',
        'chan.claim.failed': 'Claim failed: {reason}',
        'chan.auto.title': 'Daily auto check-in',
        'chan.auto.running': 'Check-in running…',
        'chan.auto.ran': 'Checked in today',
        'chan.auto.off': 'Not checked in today',
        'chan.auto.last': 'Last result: {result}',
        'nav.tab.aggregate': 'Aggregate',
        'nav.tab.saver': 'Token savers',
        'nav.tab.routing': 'Routing',
        'agg.title': 'Aggregate providers',
        'agg.sub': 'Bring third-party OpenAI-compatible endpoints into the same model roster: a key written here is echoed back as a fingerprint only, and saving updates the roster and the model picker together.',
        'agg.registryCount': '{n} in the registry',
        'agg.configuredCount': '{n} configured',
        'agg.addProvider': 'Add provider',
        'agg.addTitle': 'Choose a provider',
        'agg.addHint': 'Filter by category, wire format and auth kind. A provider marked "not drivable" needs an interactive login or cloud credentials, and this lane never calls it.',
        'agg.search': 'Search name or id',
        'agg.filterCategory': 'Category',
        'agg.filterFormat': 'Format',
        'agg.filterAuth': 'Auth',
        'agg.filterAll': 'All',
        'agg.showing': 'Showing {shown} of {total}',
        'agg.noMatch': 'No provider matches.',
        'agg.notUsable': 'Not drivable',
        'agg.notUsableWhy': 'This lane never calls it: its auth kind is "{kind}", which needs an interactive login or cloud-side credentials, so only the host can take it over.',
        'agg.credential': 'Get a key',
        'agg.modelCount': '{n} models',
        'agg.select': 'Configure',
        'agg.configuredTitle': 'Configured providers',
        'agg.configuredHint': 'Changes take effect immediately: saving updates the roster and the model picker together.',
        'agg.empty': 'No aggregate provider is connected yet',
        'agg.emptyHint': 'This page brings third-party endpoints into the model roster: an aggregator, a free-tier pool, a local inference server. Fill in a key and an optional base URL and their models appear in the model picker — and can become a link in a fallback chain.',
        'agg.filterEmpty': 'No configured provider matches the filter.',
        'agg.contributes': 'Contributes {n} models',
        'agg.contributesNone': 'Contributes no model right now',
        'agg.hasKey': 'Key {hint}',
        'agg.noKey': 'No key stored',
        'agg.enabled': 'Enabled',
        'agg.disabled': 'Disabled',
        'agg.key': 'API key',
        'agg.keyPlaceholder': 'Paste a new API key (leave empty to keep the current one)',
        'agg.keyKeep': 'Empty keeps the stored key; use the clear button below to delete it.',
        'agg.keyClear': 'Clear the stored key',
        'agg.keyClearWarn': 'Clearing it stops this provider from contributing models until a key is entered again.',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': 'Empty uses the registry default.',
        'agg.baseUrlDefault': 'Registry default: {url}',
        'agg.baseUrlEnv': 'Can also be overridden by the {env} environment variable',
        'agg.models': 'Model override',
        'agg.modelsHint': 'Model ids separated by commas or newlines; empty uses the list the provider declares.',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': 'Test',
        'agg.testing': 'Testing…',
        'agg.testOk': 'Verified',
        'agg.testFailed': 'Failed',
        'agg.testUnverified': 'Not verifiable',
        'agg.testUnverifiedWhy': 'This provider declares no model listing, so verifying it would cost one real generation — not done here.',
        'agg.testAt': 'Last test {when}',
        'agg.neverTested': 'Not tested yet',
        'agg.discover': 'Discover models',
        'agg.discovering': 'Discovering…',
        'agg.discovered': 'Found {n} models',
        'agg.discoveredNone': 'This provider declares no model listing.',
        'agg.discoveredUse': 'Use these as the override',
        'agg.save': 'Save',
        'agg.saving': 'Saving…',
        'agg.add': 'Add',
        'agg.remove': 'Remove',
        'agg.removeConfirm': 'Confirm removal',
        'agg.removeWarn': 'Removing it drops its models from the roster immediately and deletes the stored key.',
        'agg.cancel': 'Cancel',
        'agg.saved': 'Saved',
        'agg.savedBody': 'The configuration for {name} is saved.',
        'agg.removedBody': '{name} was removed.',
        'agg.failed': 'Action failed',
        'agg.loadFailed': 'Cannot read the provider registry',
        'agg.category.apikey': 'API key',
        'agg.category.free': 'Fully free',
        'agg.category.freeTier': 'Free tier',
        'agg.category.local': 'Local',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API key',
        'agg.auth.none': 'No auth',
        'agg.auth.oauth': 'OAuth login',
        'agg.auth.adc': 'Cloud credentials',
        'saver.title': 'Token savers',
        'saver.sub': 'Compact a request before it leaves this machine: tool output re-encoded, the prompt slimmed, and five answers produced locally without an upstream call.',
        'saver.master': 'Enable token compaction',
        'saver.masterHint': 'Turning this off stops every saver at once and sends requests as written; the settings below are kept.',
        'saver.rtk': 'RTK tool-output compaction',
        'saver.rtkWhat': 'What it compacts: tool results — git diff / status / log, grep, find, ls, tree, build logs, numbered file dumps and duplicate log lines.',
        'saver.rtkSafety': 'Safety rules: an error result is left untouched, small bodies are not touched, and a blob is replaced only when the new text is non-empty and strictly smaller — a compacted result is never larger than the original.',
        'saver.promptTitle': 'Prompt shaping',
        'saver.promptHint': 'Appends a writing instruction to the system prompt. It is the only saver that can cut output tokens, because it changes what the model writes.',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': 'Terse replies: pleasantries and repeated explanation dropped, conclusions and code kept.',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI-minimal replies: only the one thing that was asked for, no unrequested abstraction, config or fallback.',
        'saver.voiceWarn': 'Heads-up: both families change how the assistant talks, and that lands in your transcript. Off by default.',
        'saver.localTitle': 'Local answers',
        'saver.localHint': 'The answer to these five requests is already in the request body; forwarding one spends a round trip and upstream quota on a question with one right answer.',
        'saver.local.enabled': 'Enable local answers',
        'saver.local.quota': 'Quota probe',
        'saver.local.quotaHint': 'Answers a "quota check" probe with a fixed line.',
        'saver.local.prefix': 'Command prefix',
        'saver.local.prefixHint': 'Answers the command prefix behind a permission prompt, parsed from the shell command.',
        'saver.local.title': 'Session title',
        'saver.local.titleHint': 'Answers a title-generation request with a fixed title.',
        'saver.local.suggestion': 'Suggestion mode',
        'saver.local.suggestionHint': 'Answers a suggestion-mode turn without producing an upstream request.',
        'saver.local.filepath': 'Filepath extraction',
        'saver.local.filepathHint': 'Parses the file paths out of a command and its output, and returns them structured.',
        'saver.dashTitle': 'Savings',
        'saver.dashHint': 'Bytes actually compacted on this machine, written locally only.',
        'saver.bytesBefore': 'Before',
        'saver.bytesAfter': 'After',
        'saver.bytesSaved': 'Bytes saved',
        'saver.percent': 'Saved',
        'saver.blocks': 'Blocks compacted',
        'saver.calls': 'Calls measured',
        'saver.promptCalls': 'Prompts shaped',
        'saver.noData': 'No request measured yet. One conversation later, this shows real compacted bytes rather than an estimate.',
        'saver.report': 'Reported as',
        'saver.saved': 'Saved',
        'saver.savedBody': 'The token-saver settings are saved.',
        'saver.failed': 'Not saved',
        'saver.loadFailed': 'Cannot read the token-saver settings',
        'saver.level.off': 'Off',
        'saver.level.lite': 'Lite',
        'saver.level.full': 'Full',
        'saver.level.ultra': 'Ultra',
        'saver.level.wenyanLite': 'Classical · lite',
        'saver.level.wenyan': 'Classical',
        'saver.level.wenyanUltra': 'Classical · ultra',
        'routing.title': 'Routing',
        'routing.sub': 'Chain several models into one fallback chain: when a link refuses, the next one answers, and the caller still sees a single model id.',
        'routing.chains': 'Stored chains',
        'routing.chainsHint': 'Chains are stored in the order you entered them; a chain that references a model which is unavailable right now is kept as written and comes back by itself when the lane does.',
        'routing.empty': 'No fallback chain yet',
        'routing.emptyHint': 'A chain is a virtual model: pick it in the model picker and the request tries each real model on the chain in order. Use one to cover the hours when a lane is down.',
        'routing.newChain': 'New chain',
        'routing.name': 'Name',
        'routing.namePlaceholder': 'e.g. free first, co-paid second',
        'routing.strategy': 'Strategy',
        'routing.strategy.fallback': 'Fallback',
        'routing.strategy.roundRobin': 'Round-robin',
        'routing.stickyLimit': 'Round-robin sticky limit',
        'routing.stickyHint': 'How many calls in a row one model serves before the rotation moves on.',
        'routing.members': 'Members (in order)',
        'routing.addMember': 'Add member',
        'routing.memberEmpty': 'No member yet — press "Add member" to pick one from the roster.',
        'routing.moveUp': 'Move up',
        'routing.moveDown': 'Move down',
        'routing.removeMember': 'Remove',
        'routing.pickModel': 'Pick a model',
        'routing.searchModel': 'Search model id or name',
        'routing.noModel': 'No model matches.',
        'routing.usable': 'Usable',
        'routing.notUsable': 'Not usable now',
        'routing.missing': 'Members not in the roster: {ids}',
        'routing.notUsableWhy': 'The chain is stored as written and is never rewritten because a lane is closed today; it comes back by itself once those ids are in the roster again. If an id is a typo, edit the chain and fix it.',
        'routing.resolved': 'Resolves to',
        'routing.memberCount': '{n} members',
        'routing.save': 'Save chain',
        'routing.saved': 'Saved',
        'routing.savedBody': 'The chain is saved.',
        'routing.failed': 'Not saved',
        'routing.loadFailed': 'Cannot read the chain settings',
        'routing.cancel': 'Cancel',
        'routing.edit': 'Edit',
        'routing.delete': 'Delete',
        'routing.deleteConfirm': 'Confirm delete',
        'routing.deleteWarn': 'Deleting it drops this model id from the roster immediately; a client still pointing at it gets a 404.',
        'routing.enabled': 'Enabled',
        'routing.channel.free': 'Free lane',
        'routing.channel.eac': 'EAC co-paid',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': 'Aggregate',
        'routing.channel.combo': 'Chain',
        'gw.clientsTitle': 'Connect a client',
        'gw.clientsHint': 'How the free lane\'s forward port (enabled under "Local forward" on the Free models page) plugs into each client: addresses and keys below are generated from the port that actually bound and the real key.',
        'gw.clientsOff': 'The forward port is off',
        'gw.clientsOffHint': 'Enable it under "Local forward" on the Free models page first; only then does this section have a usable address and recipes.',
        'gw.clientsModels': '{n} servable models',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Two theme variables are not defined by every shell — measured in the web
    // shell this plugin ships against, `--dsw-alias-state-warning-primary` and
    // `--dsw-alias-label-on-accent` resolve to nothing. A declaration whose
    // var() is invalid at computed-value time is dropped *whole*, so without a
    // fallback every warning-coloured surface disappears: the pool tank's water
    // (level "busy") rendered as an empty box, the region-limited badge lost its
    // colour, callouts lost their border. Every use of those two names carries a
    // fallback for exactly that reason.
    const CSS = `
/* ═══════════════════════════════════════════════════════════════════════
   Get It For Free — visual system
   统一令牌：所有色值取自宿主 --dsw-alias-* 变量，昼夜由宿主切换。
   层级约定：layer-3 凹槽/页面底 · layer-2 面板 · layer-1 浮起元素。
   动效约定：transform/opacity 优先；常规 150–300ms、覆盖层 300–400ms。
   ═══════════════════════════════════════════════════════════════════════ */
.ofm_root{--ease-instrument:cubic-bezier(.16,1,.3,1);--ease-settle:cubic-bezier(.34,1.4,.4,1);--gap:14px;display:flex;flex-direction:column;gap:calc(var(--gap)*1.4);max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ofm_root>*{position:relative;z-index:1}
.ofm_root *{box-sizing:border-box}
.ofm_root ::-webkit-scrollbar{width:10px;height:10px}
.ofm_root ::-webkit-scrollbar-track{background:transparent}
.ofm_root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
.ofm_root ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 52%,transparent);background-clip:padding-box;border:2.5px solid transparent}
.ofm_root{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent) transparent}

.ofm_root ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
/* ── 键盘可达性：只给键盘聚焦画聚焦环，鼠标点击不出现 ─────────────────── */
.ofm_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
/* ══ 页头 hero ═════════════════════════════════════════════════════════ */
.ofm_hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.ofm_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.ofm_hero>*{position:relative}
.ofm_pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.ofm_pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.ofm_pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.ofm_pagehead .ofm_pills{margin-left:auto}
.ofm_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.ofm_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;transition:border-color .16s ease,color .16s ease}
.ofm_pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.ofm_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ofm_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.ofm_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
/* ══ 区块与分节 ════════════════════════════════════════════════════════ */
.ofm_sec{display:flex;flex-direction:column;gap:10px}
.ofm_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ofm_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.ofm_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:10px}
/* ══ 卡片（双层 bezel：hairline 边框 + 顶部内高光 + 柔和外阴影） ═══════ */
.ofm_card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .18s ease}
.ofm_card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_card.dim{opacity:.68}
.ofm_cardhead{display:flex;align-items:center;gap:8px}
.ofm_cardname{font-size:13.5px;font-weight:650;letter-spacing:-.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_badge{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);white-space:nowrap}
.ofm_badge.available{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.ofm_badge.region-blocked{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 10%,transparent)}
.ofm_badge.throttled,.ofm_badge.unavailable{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.ofm_badge.unknown{color:var(--dsw-alias-label-tertiary)}
.ofm_id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_tags{display:flex;gap:5px;flex-wrap:wrap}
.ofm_tag{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.ofm_chantag{font-size:10px;font-weight:650;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);color:var(--dsw-alias-state-business-primary);white-space:nowrap}
/* ══ 新品/热门徽标与高速标签（置顶的 opencode 免费模型） ═════════════════ */
.ofm_newtag{flex:none;font-size:9.5px;font-weight:750;letter-spacing:.4px;padding:2px 7px;border-radius:999px;color:#fff;background:var(--dsw-alias-state-error-primary);box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);white-space:nowrap;text-transform:uppercase}
.ofm_hottag{flex:none;font-size:10px;font-weight:700;line-height:1;padding:2px 6px;border-radius:999px;color:#fff;background:var(--dsw-alias-state-error-primary);box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);white-space:nowrap}
.ofm_tag.fast{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);font-weight:650}
.ofm_card.pinned{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 2px 6px color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent),0 6px 18px color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ofm_card.pinned:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l2))}
.ofm_metrics{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_metrics b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.ofm_note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
/* ══ 面板 ══════════════════════════════════════════════════════════════ */
.ofm_panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);display:flex;flex-direction:column;gap:12px}
.ofm_paneltitle{font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ofm_paneltitle .ofm_sec_hint{font-weight:400;letter-spacing:0}
.ofm_row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
/* ══ 请求热度图 ════════════════════════════════════════════════════════ */
.ofm_heat{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);justify-content:start;gap:2px;overflow-x:auto;padding:2px 0 6px}
.ofm_cell{width:12px;height:12px;border-radius:3.5px;background:var(--dsw-alias-bg-layer-1);outline:1px solid var(--dsw-alias-border-l1);outline-offset:-1px;transition:transform .14s ease,background .3s ease}
.ofm_cell:hover{transform:scale(1.25)}
.ofm_cell.l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);outline-color:transparent}
.ofm_cell.l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);outline-color:transparent}
.ofm_cell.l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,transparent);outline-color:transparent}
.ofm_cell.l4{background:var(--dsw-alias-state-business-primary);outline-color:transparent}
.ofm_scale{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_scale .ofm_cell{width:10px;height:10px}
/* ══ 分段选择器 ════════════════════════════════════════════════════════ */
.ofm_svg{display:block;width:100%;height:auto;overflow:visible}
/* ══ 筛选 chips ════════════════════════════════════════════════════════ */
.ofm_chips{display:flex;gap:6px;flex-wrap:wrap}
.ofm_chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);cursor:pointer;color:var(--dsw-alias-label-secondary);transition:border-color .16s ease,color .16s ease,background .16s ease}
.ofm_chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_chip[aria-pressed="true"]{border-color:color-mix(in srgb,currentColor 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent)}
.ofm_swatch{width:8px;height:8px;border-radius:3px;flex:none}
/* ══ 数据表格 ══════════════════════════════════════════════════════════ */
.ofm_table{width:100%;min-width:760px;border-collapse:collapse;font-size:11.5px}
.ofm_tablewrap{overflow-x:auto;max-width:100%}
.ofm_table th{text-align:left;font-weight:560;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:0 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.ofm_table td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);font-variant-numeric:tabular-nums}
.ofm_table td:first-child{font-weight:600}
.ofm_table tbody tr{transition:background .15s ease}
.ofm_table tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,transparent)}
.ofm_table tr:last-child td{border-bottom:0}
.ofm_num{text-align:right}
/* ══ 按钮（分层状态） ══════════════════════════════════════════════════ */
.ofm_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .18s var(--ease-instrument),border-color .2s var(--ease-instrument),background .2s var(--ease-instrument),box-shadow .22s var(--ease-instrument),opacity .16s ease}
.ofm_btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.ofm_btn:active:not(:disabled){transform:scale(.985);transition-duration:.1s;box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_btn:disabled{opacity:.45;cursor:default;box-shadow:none;transform:none}
.ofm_btn.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),var(--dsw-alias-state-business-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);color:var(--dsw-alias-label-on-accent,#fff);box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ofm_btn.primary:hover:not(:disabled){background:linear-gradient(180deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#000));border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 1px 0 rgb(255 255 255 / 20%),0 4px 14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.ofm_btn.ghost{background:transparent;box-shadow:none;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ofm_btn.ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ofm_minibtn{font:inherit;font-size:11px;font-weight:540;padding:3px 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 85%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform .12s ease,border-color .16s ease,color .16s ease,background .16s ease,opacity .16s ease}
.ofm_minibtn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent);transform:translateY(-1px)}
.ofm_minibtn:active:not(:disabled){transform:scale(.96)}
.ofm_minibtn:disabled{opacity:.45;cursor:default;transform:none}
.ofm_minibtn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
/* ══ 表单 ══════════════════════════════════════════════════════════════ */
.ofm_field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.ofm_field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_input{font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);min-width:0;width:100%;transition:border-color .16s ease,box-shadow .16s ease}
.ofm_input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ofm_input:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 60%,var(--dsw-alias-label-tertiary))}
.ofm_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
/* ══ 开关（spring 滑块） ═══════════════════════════════════════════════ */
.ofm_switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;appearance:none;background:transparent;border:0;padding:0;font:inherit;color:inherit}
.ofm_switch i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);position:relative;transition:background .2s ease,border-color .2s ease,box-shadow .2s ease;flex:none}
.ofm_switch:hover i{filter:brightness(1.05)}
.ofm_switch[aria-checked="true"]:hover i{filter:brightness(1.08)}
.ofm_switch i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease,width .16s ease}
.ofm_switch:active i::after{width:17px}
.ofm_switch[aria-checked="true"] i{background:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000);box-shadow:inset 0 1px 3px rgb(0 0 0 / 12%)}
.ofm_switch[aria-checked="true"] i::after{transform:translateX(16px);background:#fff}
.ofm_switch[aria-checked="true"]:active i::after{transform:translateX(13px)}
.ofm_switch:focus-visible i{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}
/* ══ 提示条 ════════════════════════════════════════════════════════════ */
.ofm_callout{display:flex;gap:9px;padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ofm_error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
/* ══ 小组件统计 ════════════════════════════════════════════════════════ */
.ofm_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
.ofm_stat{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);border:1px solid var(--dsw-alias-border-l1);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_stat b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.ofm_stat span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* ══ 公告（首次引导） ══════════════════════════════════════════════════ */
    /* The onboarding slot is mounted inside the shell, but Announcement portals its
       scrim into document.body so third-party sidebar stacking contexts cannot trap
       the fixed overlay. Mask colour, blur and z-index mirror the Modal layer of the
       shell so this reads as first-party. */
.ofm_scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 32%));backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);-webkit-backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);animation:ofm-fadein .24s ease}
@keyframes ofm-fadein{from{opacity:0}to{opacity:1}}
.ofm_ann{width:min(620px,92vw);max-height:min(86vh,640px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 40%);overflow:hidden;display:flex;flex-direction:column;animation:ofm-popin .36s cubic-bezier(.16,1,.3,1)}
@keyframes ofm-popin{from{opacity:0;transform:translateY(16px) scale(.965)}to{opacity:1;transform:none}}
.ofm_annhead{padding:18px 22px 12px;display:flex;flex-direction:column;gap:8px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 75%)}
.ofm_anntitle{margin:0;font-size:18px;font-weight:730;letter-spacing:-.4px}
.ofm_annsub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ofm_steps{display:flex;gap:6px;padding:0 22px 14px}
.ofm_step{height:3px;flex:1;border-radius:99px;background:var(--dsw-alias-border-l2);transition:background .3s ease}
.ofm_step[data-on="true"]{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_annbody{padding:2px 22px 18px;max-height:min(48vh,420px);overflow:auto;display:flex;flex-direction:column;gap:12px}
.ofm_annbody h3{margin:0;font-size:13.5px;font-weight:660}
.ofm_annbody p,.ofm_annbody li{font-size:12.5px;line-height:1.72;color:var(--dsw-alias-label-secondary);margin:0}
.ofm_annbody ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px}
.ofm_annfoot{display:flex;align-items:center;gap:10px;padding:13px 22px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
.ofm_annfoot .spacer{margin-left:auto}
.ofm_kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.ofm_kvc{padding:9px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 74%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);display:flex;flex-direction:column;gap:3px}
.ofm_kvc b{font-size:12.5px;font-variant-numeric:tabular-nums}
.ofm_kvc span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
/* ══ 公告中心 ══════════════════════════════════════════════════════════ */
.ofm_news{display:flex;flex-direction:column;gap:10px}
.ofm_newsitem{display:flex;flex-direction:column;gap:7px;padding:13px 15px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);position:relative;transition:border-color .18s ease,transform .2s cubic-bezier(.32,.72,0,1),box-shadow .22s ease}
.ofm_newsitem:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 22px rgb(0 0 0 / 10%)}
.ofm_newsitem.unread{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_newsdot{position:absolute;top:14px;right:14px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_newshead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:16px}
.ofm_newstitle{font-size:13px;font-weight:650;letter-spacing:-.1px}
.ofm_level{font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ofm_level.info{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)}
.ofm_level.update{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.ofm_level.warn{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent)}
.ofm_level.urgent{color:#fff;background:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000)}
.ofm_newsmeta{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_newsbody{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ofm_newsbody p{margin:0 0 6px}
.ofm_newsbody p:last-child{margin-bottom:0}
.ofm_newsbody h1,.ofm_newsbody h2,.ofm_newsbody h3,.ofm_newsbody h4{margin:6px 0 4px;font-size:13px;line-height:1.4}
.ofm_newsbody ul,.ofm_newsbody ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.ofm_newsbody code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 5px}
.ofm_newsbody pre{margin:4px 0;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.ofm_newsbody pre code{background:transparent;border:0;padding:0}
.ofm_newsbody blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-label-tertiary)}
.ofm_newsbody img{max-width:100%;border-radius:8px}
.ofm_newsbody a{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.ofm_newsbody a:hover{text-decoration:underline}
.ofm_newsbody table{border-collapse:collapse;font-size:12px}
.ofm_newsbody th,.ofm_newsbody td{border:1px solid var(--dsw-alias-border-l1);padding:3px 8px}
.ofm_newsbody hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}
.ofm_newsbody mark{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 30%,transparent);border-radius:2px;padding:0 2px}
.ofm_upgradecards{display:flex;gap:8px;flex-wrap:wrap}
.ofm_upnotes{max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
/* ══ 进度条 ════════════════════════════════════════════════════════════ */
.ofm_prog{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 6%);overflow:hidden}
.ofm_prog i{display:block;height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent),var(--dsw-alias-state-business-primary));animation:ofm-prog-slide 1.1s ease-in-out infinite}
.ofm_prog i{position:relative;overflow:hidden}
.ofm_prog i::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-prog-shine 1.6s ease-in-out infinite}
@keyframes ofm-prog-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
@keyframes ofm-prog-slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
/* ══ Toast（fixed 到视口，浮在所有层之上） ════════════════════════════ */
.ofm_toasts{position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 36px));font-family:inherit}
.ofm_toast{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 14px 12px 16px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 26%);font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);animation:ofm-toast-rise .32s cubic-bezier(.16,1,.3,1);overflow:hidden}
.ofm_toast{transform-origin:bottom right;will-change:transform}
.ofm_toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-state-business-primary)}
.ofm_toast.warn::before{background:var(--dsw-alias-state-warning-primary,#f0a441)}
.ofm_toast.urgent::before{background:var(--dsw-alias-state-error-primary)}
.ofm_toast.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,var(--dsw-alias-border-l2))}
.ofm_toast.urgent{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2))}
.ofm_toast .ofm_toasttitle{font-weight:660;font-size:12.5px;display:flex;align-items:center;gap:7px}
.ofm_toast .ofm_toastbody{color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto;overflow-wrap:anywhere}
.ofm_toast .ofm_toastbody p{margin:0 0 5px}
.ofm_toast .ofm_toastbody p:last-child{margin-bottom:0}
.ofm_toast .ofm_toastbody img{max-width:100%}
.ofm_toastactions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ofm_toastclose{margin-left:auto;background:transparent;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;padding:0 2px;transition:color .14s ease}
.ofm_toastclose:hover{color:var(--dsw-alias-label-primary)}
@keyframes ofm-toast-rise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
/* ══ 模态 ══════════════════════════════════════════════════════════════ */
.ofm_modal{width:min(520px,92vw);max-height:min(80vh,600px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 95%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 42%);display:flex;flex-direction:column;overflow:hidden;animation:ofm-popin .34s cubic-bezier(.16,1,.3,1)}
.ofm_modalhead{padding:17px 20px 11px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:720;letter-spacing:-.2px}
.ofm_modalbody{padding:4px 20px 16px;overflow:auto;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ofm_modalbody p{margin:0 0 6px}
.ofm_modalfoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
@media (max-width:720px){.ofm_sec_hint{margin-left:0;width:100%}.ofm_pills{margin-left:0;width:100%}}
/* ══ 北辰 API 赞助横幅：免费模型页首屏入口，与桌面端保持独立 ═══════ */
.ofm_sponsor_banner{position:relative;display:grid;grid-template-columns:56px minmax(0,1fr) auto;align-items:center;gap:14px;padding:13px 16px;border:1px solid rgb(121 151 204 / 42%);border-radius:14px;overflow:hidden;background:linear-gradient(115deg,#0b1425 0%,#17253d 54%,#263654 100%);color:#f3f7ff;box-shadow:0 9px 20px rgb(12 24 49 / 20%),inset 0 1px 0 rgb(255 255 255 / 13%)}
.ofm_sponsor_banner::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.36;background-image:linear-gradient(rgb(126 164 225 / 15%) 1px,transparent 1px),linear-gradient(90deg,rgb(126 164 225 / 15%) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(90deg,black,transparent 85%)}
.ofm_sponsor_banner::after{content:"";position:absolute;inset:auto -12% -80% 35%;height:180%;pointer-events:none;background:radial-gradient(ellipse,rgb(96 137 222 / 22%),transparent 68%);transform:rotate(-7deg)}
.ofm_sponsor_banner>*{position:relative;z-index:1}
.ofm_sponsor_logo{display:flex;flex-direction:column;align-items:center;justify-content:center;width:56px;height:56px;border-radius:14px;background:#f8fbff;color:#c8470b;box-shadow:0 5px 11px rgb(0 0 0 / 22%),inset 0 0 0 1px rgb(255 255 255 / 80%);transform:rotate(4deg);font-weight:800;letter-spacing:-1px;line-height:1}
.ofm_sponsor_logo span{font-size:16px}
.ofm_sponsor_logo small{margin-top:4px;padding-top:3px;border-top:1px solid currentColor;font-size:7px;letter-spacing:1px}
.ofm_sponsor_bannerbody{min-width:0}
.ofm_sponsor_kicker{display:inline-flex;align-items:center;padding:2px 8px;border:1px solid rgb(0 194 232 / 55%);border-radius:999px;background:rgb(0 144 186 / 18%);color:#38d9f4;font-size:10px;font-weight:700;letter-spacing:.2px}
.ofm_sponsor_banner h3{margin:4px 0 3px;color:#f6f8ff;font-size:clamp(17px,2vw,22px);font-weight:780;letter-spacing:-.45px;line-height:1.15}
.ofm_sponsor_banner p{max-width:75ch;margin:0;color:rgb(220 229 246 / 82%);font-size:10.5px;line-height:1.45}
.ofm_sponsor_cta{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:92px;padding:8px 12px;border:1px solid rgb(255 255 255 / 72%);border-radius:10px;background:linear-gradient(180deg,#f9fbff,#dfe8f7);box-shadow:0 4px 10px rgb(0 0 0 / 18%),inset 0 1px 0 #fff;color:#253651;font-size:11px;font-weight:750;text-decoration:none;white-space:nowrap;transition:transform .18s var(--ease-instrument),box-shadow .18s ease,filter .18s ease}
.ofm_sponsor_cta:hover{transform:translateY(-2px);filter:brightness(1.04);box-shadow:0 9px 20px rgb(0 0 0 / 24%),inset 0 1px 0 #fff}
.ofm_sponsor_cta:active{transform:translateY(0)}
/* ══ GitHub star 按钮 ══════════════════════════════════════════════════ */
.ofm_starbtn{position:relative;display:inline-flex;gap:7px;align-items:center;padding:7px 15px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:linear-gradient(140deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent),transparent 70%);color:var(--dsw-alias-state-business-primary);text-decoration:none;font-weight:650;font-size:12.5px;transition:transform .18s ease,box-shadow .22s ease,color .22s ease,background .22s ease;white-space:nowrap;overflow:hidden}
.ofm_starbtn svg{transition:transform .5s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover svg{transform:rotate(72deg) scale(1.12)}
.ofm_starbtn:hover{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent),0 6px 16px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_starbtn:active svg{transform:rotate(72deg) scale(.94)}
.ofm_starbtn svg{width:14px;height:14px;fill:currentColor;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover{transform:translateY(-1px);box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent);background:linear-gradient(140deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,#3ECFA0));color:#fff}
.ofm_starbtn:active{transform:scale(.97)}
.ofm_starbtn:hover svg{transform:rotate(-72deg) scale(1.12)}
.ofm_starbtn::after{content:"";position:absolute;top:0;bottom:0;width:38%;left:-45%;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 34%),transparent);transform:skewX(-18deg);transition:left .55s ease}
.ofm_starbtn:hover::after{left:112%}
.ofm_starlink{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
/* ══ 鱼缸（品牌装饰：玻璃缸 + 水位 + 波光 + 鱼群） ════════════════════ */
.ofm_tank{position:relative;width:206px;height:128px;border-radius:16px;overflow:hidden;flex:none;background:linear-gradient(180deg,rgba(127,166,255,.10),rgba(127,166,255,.03));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.ofm_tankwater{position:absolute;left:0;right:0;bottom:0;height:var(--lvl,0%);transition:height 1.4s cubic-bezier(.22,.61,.36,1)}
.ofm_tank.ok .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent),var(--dsw-alias-state-business-primary))}
.ofm_tank.busy .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 72%,transparent),var(--dsw-alias-state-warning-primary,#f0a441))}
.ofm_tank.over .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-error-primary) 72%,transparent),var(--dsw-alias-state-error-primary))}
.ofm_tankdeep{position:absolute;inset:0;overflow:hidden}
.ofm_wave{position:absolute;left:0;top:-6px;width:200%;height:7px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 8' preserveAspectRatio='none'%3E%3Cpath d='M0 4 Q15 0 30 4 T60 4 T90 4 T120 4 V8 H0Z' fill='rgba(255,255,255,.45)'/%3E%3C/svg%3E") repeat-x;background-size:60px 7px;animation:ofmwave 5.5s linear infinite}
.ofm_wave.w2{top:-4px;opacity:.45;animation-duration:8.5s;animation-direction:reverse}
@keyframes ofmwave{to{transform:translateX(60px)}}
.ofm_bubble{position:absolute;bottom:-8px;width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.5);opacity:0;animation:ofmbub 7s ease-in infinite}
.ofm_bubble.b1{left:14%;animation-delay:0s}
.ofm_bubble.b2{left:32%;width:3px;height:3px;animation-delay:2.2s;animation-duration:9s}
.ofm_bubble.b3{left:55%;animation-delay:4.1s}
.ofm_bubble.b4{left:71%;width:7px;height:7px;animation-delay:1.3s;animation-duration:8s}
.ofm_bubble.b5{left:86%;width:4px;height:4px;animation-delay:5.4s;animation-duration:10s}
@keyframes ofmbub{0%{transform:translateY(0);opacity:0}12%{opacity:.75}100%{transform:translateY(-136px);opacity:0}}
.ofm_fish{position:absolute;left:-34px;width:26px;height:13px;animation:ofmswim 12s linear infinite;will-change:transform;filter:drop-shadow(0 1px 2px rgb(0 0 0 / 18%))}
.ofm_fish.f1{bottom:14px}
.ofm_fish.f1 svg,.ofm_fish.f3 svg{transform:scaleX(-1)}
.ofm_fish.f2{bottom:44px;animation-duration:16s;animation-delay:-7s;animation-name:ofmswimrev}
.ofm_fish.f3{bottom:68px;width:19px;height:10px;animation-duration:9.5s;animation-delay:-3.5s}
.ofm_fish svg{display:block;width:100%;height:100%;fill:rgba(255,255,255,.82)}
@keyframes ofmswim{0%{transform:translateX(0)}100%{transform:translateX(270px)}}
@keyframes ofmswimrev{0%{transform:translateX(270px)}100%{transform:translateX(0)}}
.ofm_tankglass{position:absolute;inset:0;pointer-events:none;border-radius:16px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),inset 0 18px 32px rgba(255,255,255,.06),inset 0 -12px 24px rgba(0,0,0,.10)}
.ofm_tankrays{position:absolute;inset:-30% -12%;pointer-events:none;opacity:.5;background:repeating-linear-gradient(104deg,rgb(255 255 255 / 7%) 0 9px,transparent 9px 30px);mix-blend-mode:soft-light;animation:ofmrays 11s ease-in-out infinite alternate}
@keyframes ofmrays{from{transform:translateX(-14px) rotate(-.4deg)}to{transform:translateX(14px) rotate(.4deg)}}
.ofm_tankshine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(196deg,rgb(255 255 255 / 13%) 0%,transparent 32%)}
@media (prefers-reduced-motion:reduce){.ofm_wave,.ofm_bubble,.ofm_fish,.ofm_tankrays{animation:none}}
/* ══ 三页外壳：极光底 · 毛玻璃导航 · 页过渡 ═════════════════════════════
   The aurora is a fixed layer *inside* our root: a flat shell background gives
   backdrop-filter nothing to sample, so every glass surface would read as a
   plain translucent box. It sits at z-index:-1 with isolation:isolate on the
   shell, which keeps it behind our content and above the app background without
   ever escaping into the shell's own stacking order. */
.ofm_shell{position:relative;display:flex;flex-direction:column;gap:18px;max-width:1120px;isolation:isolate}
.ofm_aurora{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.ofm_aurora i{position:absolute;display:block;border-radius:50%;filter:blur(70px);opacity:.42;animation:ofmdrift 44s ease-in-out infinite alternate}
.ofm_aurora i:nth-child(1){width:46vw;height:46vw;left:-12vw;top:-14vw;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),transparent 68%)}
.ofm_aurora i:nth-child(2){width:38vw;height:38vw;right:-10vw;top:4vh;background:radial-gradient(circle,rgba(62,207,160,.42),transparent 70%);animation-duration:56s;animation-delay:-12s}
.ofm_aurora i:nth-child(3){width:42vw;height:42vw;left:22vw;bottom:-18vw;background:radial-gradient(circle,rgba(227,106,166,.34),transparent 70%);animation-duration:64s;animation-delay:-26s}
@keyframes ofmdrift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(3vw,2vh,0) scale(1.09)}100%{transform:translate3d(-3vw,-2vh,0) scale(.96)}}
.ofm_nav{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;padding:10px 12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 26px rgb(0 0 0 / 10%)}
.ofm_navbrand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14px;letter-spacing:-.2px;white-space:nowrap}
.ofm_navmark{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;flex:none;background:linear-gradient(145deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,#3ECFA0));box-shadow:0 4px 12px color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_navmark svg{width:16px;height:16px;fill:#fff}
.ofm_tabs{position:relative;grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);box-shadow:inset 0 1px 2px rgb(0 0 0 / 4%)}
.ofm_tabglider{position:absolute;top:0;left:0;border-radius:10px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent));box-shadow:0 3px 10px rgb(0 0 0 / 14%),inset 0 1px 0 rgb(255 255 255 / 9%);transition:transform .34s cubic-bezier(.22,.61,.36,1),width .34s cubic-bezier(.22,.61,.36,1),height .34s cubic-bezier(.22,.61,.36,1);pointer-events:none}
.ofm_tab{position:relative;z-index:1;font:inherit;font-size:12px;font-weight:600;padding:6px 13px;border-radius:10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .2s ease}
.ofm_tab[data-on="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab:hover{color:var(--dsw-alias-label-primary)}
.ofm_tab .ofm_tabnum{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:11px}
.ofm_navspacer{display:none}
/* The star belongs beside the brand: grid auto-placement would push it below
   the tabs row (they come first in the DOM) and stretch it across the row. */
.ofm_nav .ofm_starbtn{grid-column:2;grid-row:1;justify-self:end}
.ofm_page{display:flex;flex-direction:column;gap:20px;animation:ofmpagein .4s cubic-bezier(.16,1,.3,1)}
@keyframes ofmpagein{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
/* ── 毛玻璃表面：只给大块面用 backdrop-filter，小卡片用半透明叠层，滚动更顺 */
.ofm_glass{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 68%,transparent);backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 12px 34px rgb(0 0 0 / 9%)}
.ofm_root .ofm_hero,.ofm_root .ofm_panel,.ofm_root .ofm_ann,.ofm_root .ofm_modal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);backdrop-filter:blur(18px) saturate(155%);-webkit-backdrop-filter:blur(18px) saturate(155%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 10%)}
/* ══ 鱼缸加大版（页头） ════════════════════════════════════════════════ */
.ofm_tankrow{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.ofm_tankside{flex:1;min-width:236px;display:flex;flex-direction:column;gap:11px;justify-content:center}
.ofm_tank.xl{width:264px;height:148px;border-radius:20px;box-shadow:inset 0 0 0 1px rgb(255 255 255 / 12%),0 16px 40px rgb(0 0 0 / 14%)}
.ofm_tank.xl .ofm_tankglass{border-radius:20px}
/* ══ 渠道接入页 ════════════════════════════════════════════════════════ */
.ofm_chanwrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.ofm_chan{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px 17px 15px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);overflow:hidden;transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_chan::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),transparent 78%);opacity:.95}
.ofm_chan:hover{transform:translateY(-3px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 18px 40px rgb(0 0 0 / 15%);border-color:color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 55%,transparent)}
.ofm_chan.off{opacity:.62}
.ofm_chanhead{display:flex;align-items:center;gap:11px}
.ofm_chanlogo{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:none;font-weight:800;font-size:13px;color:#fff;letter-spacing:-.3px;background:linear-gradient(150deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 45%,#101828));box-shadow:0 6px 16px color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 34%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_chan:hover .ofm_chanlogo{transform:scale(1.06) rotate(-3deg);transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.ofm_chanlogo{transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.ofm_chanid{display:flex;flex-direction:column;gap:2px;min-width:0}
.ofm_chanid b{font-size:14px;font-weight:700;letter-spacing:-.2px}
.ofm_chanid span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_chanstate{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);white-space:nowrap}
.ofm_chanmeta{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_chanmeta b{color:var(--dsw-alias-label-secondary);font-weight:650;font-variant-numeric:tabular-nums}
.ofm_chanacts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ofm_acctlist{display:flex;flex-direction:column;gap:6px}
.ofm_acct{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:7px 10px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);font-size:12px;transition:border-color .16s ease,background .16s ease}
.ofm_acct:hover{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent)}
.ofm_acct.pending{border-style:dashed}
.ofm_acctname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.ofm_acctmeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_balanceerror{flex-basis:100%;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary);font-size:11px}
.ofm_acctacts{margin-left:auto;display:flex;gap:5px;flex-wrap:wrap}
.ofm_modellist{display:flex;flex-direction:column;gap:4px;max-height:238px;overflow:auto;padding-right:2px}
.ofm_modelrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);font-size:11.5px;transition:background .15s ease}
.ofm_modelrow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 85%,transparent)}
.ofm_modelrow.off{opacity:.5}
.ofm_modelrow .ofm_id{flex:1;min-width:0}
.ofm_tagpill{font-size:10px;font-weight:560;padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_tagpill.free{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.ofm_tagpill.dead{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ofm_chanfold{border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 85%,transparent);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.ofm_foldtoggle{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;cursor:pointer;font-family:inherit;padding:0;transition:color .15s ease}
.ofm_foldtoggle svg{transition:transform .3s cubic-bezier(.32,.72,0,1)}
.ofm_foldtoggle:hover svg{transform:translateY(1px)}
.ofm_foldtoggle:hover{color:var(--dsw-alias-label-primary)}
.ofm_foldtoggle svg{width:10px;height:10px;fill:currentColor;transition:transform .22s ease}
.ofm_foldtoggle[data-open="true"] svg{transform:rotate(90deg)}
/* ══ 骨架屏 ════════════════════════════════════════════════════════════ */
.ofm_skel{position:relative;overflow:hidden;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);min-height:96px;animation:ofmpulse 1.8s ease-in-out infinite}
.ofm_skel::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-skel-shine 1.8s ease-in-out infinite}
@keyframes ofm-skel-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
.ofm_skel::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 8%) 42%,transparent 74%);animation:ofmshine 1.5s ease-in-out infinite}
@keyframes ofmshine{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes ofmpulse{0%,100%{opacity:1}50%{opacity:.55}}
/* ══ 登录引导 ══════════════════════════════════════════════════════════ */
.ofm_loginbody{display:flex;flex-direction:column;gap:14px}
.ofm_loginstep{display:flex;gap:11px;align-items:flex-start;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ofm_loginstep b{flex:none;width:21px;height:21px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:650;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);color:var(--dsw-alias-state-business-primary)}
.ofm_scanline{animation:ofmscan 2.2s ease-in-out infinite}
@keyframes ofmscan{0%,100%{opacity:.35}50%{opacity:.85}}
/* ══ 数据看板 KPI ══════════════════════════════════════════════════════ */
.ofm_kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.ofm_kpi{display:flex;flex-direction:column;gap:6px;padding:15px 17px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 16px 36px rgb(0 0 0 / 13%)}
.ofm_kpilabel{font-size:11px;font-weight:560;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ofm_kpivalue{font-size:25px;font-weight:760;letter-spacing:-.7px;line-height:1.15;font-variant-numeric:tabular-nums;background:linear-gradient(120deg,var(--dsw-alias-label-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px);transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_kpivalue{transition:transform .3s cubic-bezier(.34,1.56,.64,1);display:inline-block}
.ofm_kpisub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ofm_kpi.warn .ofm_kpivalue{-webkit-text-fill-color:var(--dsw-alias-state-warning-primary,#f0a441);background:none}
.ofm_logfailed td{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}
/* ══ 真实图标与积分展示 ════════════════════════════════════════════════ */
.ofm_navmark img,.ofm_chanlogo img{width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block}
.ofm_chanlogo{padding:0;overflow:hidden}
.ofm_credittotal b{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.ofm_creditbadge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);color:var(--dsw-alias-state-warning-primary,#f0a441);white-space:nowrap}
.ofm_creditbadge.strong{max-width:100%;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
/* ══ 账号池状态 ════════════════════════════════════════════════════════ */
.ofm_pooltop{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ofm_poolbadge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:12.5px;font-weight:650;white-space:nowrap}
.ofm_pooldot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ofm_poolbadge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.ofm_poolbadge.ok .ofm_pooldot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ofm_poolbadge.busy{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 40%,transparent)}
.ofm_poolbadge.busy .ofm_pooldot{background:var(--dsw-alias-state-warning-primary,#f0a441);animation:ofmpulse 1.4s ease-in-out infinite}
.ofm_poolbadge.over{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.ofm_poolbadge.over .ofm_pooldot{background:var(--dsw-alias-state-error-primary);animation:ofmpulse .8s ease-in-out infinite}
.ofm_poolstats{display:flex;gap:22px;flex-wrap:wrap}
.ofm_poolstats .ofm_stat b{font-size:19px}
.ofm_poolstats .ofm_stat.hot b{color:var(--dsw-alias-state-error-primary)}
.ofm_poolmeta{display:flex;gap:8px 18px;align-items:baseline;flex-wrap:wrap;justify-content:space-between}
@media (max-width:760px){.ofm_tank.xl{width:100%;max-width:340px}.ofm_tab{flex:1 1 auto;text-align:center}}
/* ══ 动效降级：用户系统开启"减少动态效果"时全部收敛 ═══════════════════ */
/* —— 交互锚点增强：激活态 / 状态色 / 加载态（additive，不改既有规则） —— */
/* tab：激活项在滑块底衬之上再补一道品牌下划线，选中更明确 */
.ofm_tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:3px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.85;transition:opacity .18s cubic-bezier(.32,.72,0,1)}
/* 渠道卡：随接入状态着色顶部 hairline 与外发光（已接入=品牌色、关闭=灰、待接入=琥珀弱化） */
.ofm_chan[data-state="on"]::before{background:linear-gradient(90deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 30%,transparent));opacity:1}
.ofm_chan[data-state="on"]{border-color:color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 34%,var(--dsw-alias-border-l2))}
.ofm_chan[data-state="idle"]::before{background:linear-gradient(90deg,var(--dsw-alias-state-warning-primary,#f0a441),transparent);opacity:.6}
.ofm_chan[data-state="off"]::before{background:linear-gradient(90deg,var(--dsw-alias-label-tertiary),transparent);opacity:.5}
/* 按钮：异步进行中显示内联 spinner（aria-busy 锚点，文字仍保留占位避免布局跳动） */
.ofm_btn[aria-busy="true"]{position:relative;color:transparent !important;pointer-events:none}
.ofm_btn[aria-busy="true"]::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,var(--dsw-alias-label-secondary));border-top-color:var(--dsw-alias-label-primary);animation:ofm-btn-spin .7s linear infinite}
@keyframes ofm-btn-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ofm_root *,.ofm_root *::before,.ofm_root *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}
/* ═══ 精密仪器精修层（世界观：原厂仪器手感）：颜色听宿主，质感在阻尼。曲线 --ease-instrument 冲得快落得稳，--ease-settle 极轻过冲。退场比进场快。 ═══ */
.ofm_glass{transition:border-color .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument),transform .22s var(--ease-instrument),background .22s var(--ease-instrument)}
.ofm_glass:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 92%,var(--dsw-alias-state-business-primary));box-shadow:0 1px 2px rgb(0 0 0 / 5%),0 10px 28px -14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_kpi{transition:border-color .22s var(--ease-instrument),transform .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument)}
.ofm_kpi:hover{transform:translateY(-1px)}
.ofm_kpivalue{transition:transform .3s var(--ease-settle),color .2s var(--ease-instrument);display:inline-block}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px) scale(1.015);color:var(--dsw-alias-label-primary)}
.ofm_table tbody tr{transition:background .14s var(--ease-instrument)}
.ofm_seg button,.ofm_chip{transition:background .2s var(--ease-instrument),color .2s var(--ease-instrument),border-color .2s var(--ease-instrument),box-shadow .22s var(--ease-settle)}
.ofm_prog i{transition:width .5s var(--ease-instrument)}
.ofm_minibtn{transition:transform .14s var(--ease-instrument),border-color .18s var(--ease-instrument),color .18s var(--ease-instrument),background .18s var(--ease-instrument)}
.ofm_minibtn:active:not(:disabled){transform:scale(.98);transition-duration:.09s}
.ofm_root input,.ofm_root select,.ofm_root textarea{transition:border-color .18s var(--ease-instrument),box-shadow .2s var(--ease-instrument),background .18s var(--ease-instrument)}
@media (prefers-reduced-motion:reduce){.ofm_glass,.ofm_kpi,.ofm_kpivalue,.ofm_minibtn,.ofm_prog i{transition:none!important}.ofm_kpi:hover,.ofm_kpi:hover .ofm_kpivalue{transform:none}}

/* ==== V5 INSTRUMENT START ==== */
/* 精密仪器·样板间覆盖层：1px细边+内高光，无外投影；颜色全部听宿主 var(--dsw-alias-*)。
   夜(暗)高光更刃、纹理更显；昼(亮)高光收敛、纹理近乎哑。reduced-motion 去位移留状态。 */

/* ── ① 面板卡片 .ofm_panel / .ofm_card ─────────────────────────── */
/* 双基底：拉丝细纹(repeating-linear-gradient)垫底，实体色覆盖在上，从边缘隐约透出拉丝感 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%), inset 0 -14px 28px -18px rgb(0 0 0 / 16%) !important;
  transition: border-color .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), transform .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -12px 24px -16px rgb(0 0 0 / 14%) !important;
  transition: transform .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), border-color .2s var(--ease-instrument) !important;
}
/* hover：kinetic tension —— 位移压浅(-1px)，去掉外投影，靠边色提亮+高光增强传递"浮起" */
.ofm_root .ofm_card:hover{
  transform: translateY(-1px) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 11%), inset 0 -12px 24px -16px rgb(0 0 0 / 10%) !important;
}

/* ── ② 按钮 .ofm_btn ─────────────────────────── */
/* kinetic tension：外壳 active 陷落(scale .985)，内部 ::after 扫光条反向滑过形成"外陷内顶" */
.ofm_root .ofm_btn{
  position: relative !important;
  overflow: hidden !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transition: transform .16s var(--ease-settle), border-color .2s var(--ease-instrument), background .2s var(--ease-instrument), box-shadow .2s var(--ease-instrument), opacity .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_btn::after{
  content: "" !important;
  position: absolute !important;
  top: 0 !important; bottom: 0 !important;
  left: -60% !important; width: 42% !important;
  background: linear-gradient(100deg, transparent, rgb(255 255 255 / 14%), transparent) !important;
  transform: skewX(-18deg) !important;
  transition: left .5s var(--ease-instrument) !important;
  pointer-events: none !important;
}
/* hover：扫光滑过（exit slower than press）；去掉原外投影，仅留顶部高光 */
.ofm_root .ofm_btn:hover:not(:disabled){
  transform: translateY(-1px) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%) !important;
}
.ofm_root .ofm_btn:hover:not(:disabled)::after{
  left: 118% !important;
}
/* active：快速陷落(.09s) + 内阴影加深=物理按压；松开靠 --ease-settle 回弹 */
.ofm_root .ofm_btn:active:not(:disabled){
  transform: scale(.985) !important;
  transition-duration: .09s !important;
  box-shadow: inset 0 2px 5px rgb(0 0 0 / 14%), inset 0 1px 0 rgb(255 255 255 / 3%) !important;
}
/* primary 按钮保留主色渐变，仅把外投影换成更克制的内高光+轻凹槽 */
.ofm_root .ofm_btn.primary{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 22%), inset 0 -10px 18px -12px rgb(0 0 0 / 24%) !important;
}
.ofm_root .ofm_btn.primary:hover:not(:disabled){
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -10px 18px -12px rgb(0 0 0 / 18%) !important;
}

/* ── ③ 表格行 hover .ofm_table tbody tr ─────────────────────────── */
/* 行首 2px 主色竖条用 transform:scaleY 展开(不触发布局)；exit(.12s) 比 entrance(.16s) 快 */
.ofm_root .ofm_table tbody tr{
  transition: background .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_table tbody tr td:first-child{
  position: relative !important;
}
.ofm_root .ofm_table tbody tr td:first-child::before{
  content: "" !important;
  position: absolute !important;
  left: 0 !important; top: 6px !important; bottom: 6px !important;
  width: 2px !important; border-radius: 2px !important;
  background: var(--dsw-alias-state-business-primary) !important;
  transform: scaleY(0) !important;
  transform-origin: center !important;
  opacity: 0 !important;
  transition: transform .16s var(--ease-instrument), opacity .12s var(--ease-instrument) !important;
  pointer-events: none !important;
}
.ofm_root .ofm_table tbody tr:hover td:first-child::before{
  transform: scaleY(1) !important;
  opacity: 1 !important;
}
/* 数字列表针走格感：tabular-nums + pl5-tick 机械顿挫(steps) */
.ofm_root .ofm_table td{
  font-variant-numeric: tabular-nums !important;
}
/* 表针走格：离散百分比快照模拟 steps 顿挫——同值连帧=停格，瞬间跳格=机械感；@keyframes 里用不了 steps() 函数，用帧堆出来 */
@keyframes pl5-tick{
  0%,24%{ transform: translateY(0); }
  25%,54%{ transform: translateY(-1.5px); }
  55%,79%{ transform: translateY(-.75px); }
  80%,100%{ transform: translateY(0); }
}

/* ── 昼(not-dark)收敛：高光更哑、拉丝更隐、回弹更小 ─────────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 45%), inset 0 -14px 28px -18px rgb(0 0 0 / 7%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%), inset 0 -12px 24px -16px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 62%) !important;
  }
}

/* ── reduced-motion 降级：去位移/回弹/扫光/顿挫，保留颜色与不透明度反馈 ── */
@media (prefers-reduced-motion: reduce){
  /* 统一过渡降级：所有交互件只留颜色/不透明度反馈，去位移 */
  .ofm_root .ofm_card,
  .ofm_root .ofm_panel,
  .ofm_root .ofm_btn,
  .ofm_root .ofm_table tbody tr,
  .ofm_root .ofm_table tbody tr td:first-child::before,
  .ofm_root .ofm_switch i,
  .ofm_root .ofm_switch i::after,
  .ofm_root .ofm_seg button,
  .ofm_root .ofm_stat,
  .ofm_root .ofm_kvc,
  .ofm_root .ofm_input,
  .ofm_root .ofm_starbtn,
  .ofm_root .ofm_chanlogo{
    transition: border-color .12s ease, background .12s ease, box-shadow .12s ease, opacity .12s ease, color .12s ease !important;
  }
  /* 去位移/回弹/陷落 */
  .ofm_root .ofm_card:hover,
  .ofm_root .ofm_btn:hover:not(:disabled),
  .ofm_root .ofm_btn:active:not(:disabled),
  .ofm_root .ofm_stat:hover,
  .ofm_root .ofm_kvc:hover,
  .ofm_root .ofm_seg button:active:not([aria-pressed="true"]),
  .ofm_root .ofm_starbtn:active,
  .ofm_root .ofm_chan:hover .ofm_chanlogo{
    transform: none !important;
  }
  /* 开关捏扁还原 */
  .ofm_root .ofm_switch:active i::after{
    width: 14px !important;
  }
  /* 扫光条砍掉 */
  .ofm_root .ofm_btn::after,
  .ofm_root .ofm_starbtn::after{
    content: none !important;
  }
  /* 呼吸灯停跳，但保留颜色状态 */
  .ofm_root .ofm_dot.ok{
    animation: none !important;
    opacity: 1 !important;
  }
  /* 表针走格动画停走，但保留数字本身 */
  .ofm_root .ofm_kpi:hover .ofm_kpivalue,
  .ofm_root .ofm_stat:hover b{
    animation: none !important;
  }
}

/* ── ④ 输入框 .ofm_input：仪器凹槽手感 ─────────────────────────── */
/* 常态凹槽(inset 顶高光+底内阴影)；focus 时凹槽不动，只换边色+外发光，像仪器被点亮 */
.ofm_root .ofm_input{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 10%) !important;
  transition: border-color .18s var(--ease-instrument), box-shadow .2s var(--ease-instrument), background .18s var(--ease-instrument) !important;
}
.ofm_root .ofm_input:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-border-l2) 55%, var(--dsw-alias-state-business-primary)) !important;
}
.ofm_root .ofm_input:focus{
  border-color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 8%), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent) !important;
}

/* ── ⑤ 开关 .ofm_switch：spring 滑块阻尼 ─────────────────────────── */
/* 滑块用 --ease-settle 带回弹；按下时滑块变宽=被"捏扁"，松开回弹归位 */
.ofm_root .ofm_switch i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 10%), inset 0 -1px 0 rgb(255 255 255 / 4%) !important;
  transition: background .22s var(--ease-instrument), border-color .22s var(--ease-instrument), box-shadow .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch i::after{
  background: var(--dsw-alias-label-primary) !important;
  box-shadow: 0 1px 3px rgb(0 0 0 / 28%), inset 0 1px 0 rgb(255 255 255 / 20%) !important;
  transition: transform .28s var(--ease-settle), background .2s var(--ease-instrument), width .14s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 14%), inset 0 -1px 0 rgb(255 255 255 / 8%) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i::after{
  background: var(--dsw-alias-label-on-accent, #fff) !important;
}
.ofm_root .ofm_switch:active i::after{
  width: 17px !important;
}

/* ── ⑥ 徽章/药丸/标签 .ofm_badge/.ofm_pill/.ofm_tag/.ofm_chantag/.ofm_chip ── */
/* 统一加顶部发丝高光；状态色只用 color-mix 调透明度，不换色相 */
.ofm_root .ofm_pill,
.ofm_root .ofm_tag,
.ofm_root .ofm_chip,
.ofm_root .ofm_chantag{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument), transform .18s var(--ease-settle) !important;
}
.ofm_root .ofm_badge{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
/* 状态点呼吸灯保留，但改成 pl5- 前缀、机械顿挫更明显的两拍节奏 */
@keyframes pl5-dot-breathe{
  0%,100%{ opacity:1; }
  50%{ opacity:.45; }
}
.ofm_root .ofm_dot.ok{
  animation: pl5-dot-breathe 2.4s cubic-bezier(.4,0,.6,1) infinite !important;
}
/* 分段控件选中块：加顶部高光，按下时微微陷落 */
.ofm_root .ofm_seg button[aria-pressed="true"]{
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%), inset 0 1px 0 rgb(255 255 255 / 8%) !important;
  transition: color .18s var(--ease-instrument), background .18s var(--ease-instrument), box-shadow .2s var(--ease-settle) !important;
}
.ofm_root .ofm_seg button:active:not([aria-pressed="true"]){
  transform: scale(.97) !important;
}

/* ── ⑦ 原生件接管：滚动条 / selection / caret / 聚焦环 ─────────────── */
/* 滚动条：仪器滑轨——thumb 加顶部高光与底部凹槽，hover 时轻微增亮 */
.ofm_root ::-webkit-scrollbar-thumb{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 30%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -1px 0 rgb(0 0 0 / 10%) !important;
  transition: background .2s var(--ease-instrument) !important;
}
.ofm_root ::-webkit-scrollbar-thumb:hover{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 48%, transparent) !important;
}
/* 文本选择：主色薄涂，昼模式再淡一点避免刺眼 */
.ofm_root ::selection{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent) !important;
}
/* 光标：跟随主色 */
.ofm_root input, .ofm_root textarea{
  caret-color: var(--dsw-alias-state-business-primary) !important;
}
/* 聚焦环：仪器刻度环——细环+外晕，用 --ease-instrument 淡入 */
.ofm_root :focus-visible{
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, transparent) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent) !important;
  transition: box-shadow .18s var(--ease-instrument), outline-color .18s var(--ease-instrument) !important;
}

/* ── ⑧【师傅批改①】拉丝纹理增强：金属感要真的能摸到 ─────────────── */
/* 夜模式 3% → 4.5%，昼模式 1.5% → 2.8%，纹理间隔收紧让拉丝更密 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
}
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
}

/* ── ⑧【师傅批改②】昼模式高光压暗：45-62% → 30-38%，更克制 ─────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 -14px 28px -18px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 38%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 42%), inset 0 -12px 24px -16px rgb(0 0 0 / 4%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 36%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 44%) !important;
  }
  .ofm_root .ofm_pill,
  .ofm_root .ofm_tag,
  .ofm_root .ofm_chip,
  .ofm_root .ofm_chantag,
  .ofm_root .ofm_badge{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%) !important;
  }
  .ofm_root .ofm_input{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 2px 6px -2px rgb(0 0 0 / 6%) !important;
  }
}

/* ── ⑧【师傅批改③】表格竖条语言统一：所有表格行 hover 都带主色竖条 ── */
/* .ofm_newsbody table 是内容型表格，保持朴素；仅给数据表 .ofm_table 统一竖条。
   同时把 .ofm_kvc / .ofm_stat 等"类表格"卡片也纳入 hover 微提亮，保持语言一致 */
.ofm_root .ofm_stat,
.ofm_root .ofm_kvc{
  transition: border-color .2s var(--ease-instrument), box-shadow .22s var(--ease-instrument), transform .2s var(--ease-settle) !important;
}
.ofm_root .ofm_stat:hover,
.ofm_root .ofm_kvc:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, var(--dsw-alias-border-l1)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transform: translateY(-1px) !important;
}

/* ── ⑩【返工·收编租界】星按钮/导航标/渠道标 全部听宿主变量 ─────────────── */
/* L1130 .ofm_starbtn:hover 混 #3ECFA0、L1181 .ofm_navmark 混 #3ECFA0 —— 统一改混 label-primary，零品牌色 */
.ofm_root .ofm_starbtn{
  transition: transform .16s var(--ease-settle), box-shadow .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
.ofm_root .ofm_starbtn:hover{
  background: linear-gradient(140deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 76%, var(--dsw-alias-label-primary))) !important;
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent), 0 6px 16px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent) !important;
}
.ofm_root .ofm_starbtn:active{
  transform: scale(.97) !important;
}
/* 扫光条改走 --ease-instrument，与 .ofm_btn 同语言 */
.ofm_root .ofm_starbtn::after{
  transition: left .5s var(--ease-instrument) !important;
}
/* 导航标：去掉 #3ECFA0 混色，改混 label-primary；外投影换成内高光+轻凹槽 */
.ofm_root .ofm_navmark{
  background: linear-gradient(145deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-label-primary))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -6px 12px -8px rgb(0 0 0 / 20%) !important;
}
.ofm_root .ofm_navmark svg{
  fill: var(--dsw-alias-label-on-accent, #fff) !important;
}
/* 渠道标：--chan-accent 兜底本来就是宿主变量，收编写死的 #fff / #101828，外投影换内高光 */
.ofm_root .ofm_chanlogo{
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  background: linear-gradient(150deg, var(--chan-accent, var(--dsw-alias-state-business-primary)), color-mix(in srgb, var(--chan-accent, var(--dsw-alias-state-business-primary)) 52%, var(--dsw-alias-bg-layer-3))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 24%), inset 0 -8px 14px -10px rgb(0 0 0 / 22%) !important;
  transition: transform .3s var(--ease-settle) !important;
}
.ofm_root .ofm_chan:hover .ofm_chanlogo{
  transform: scale(1.05) rotate(-2deg) !important;
}

/* ── ⑩【返工·收编 SEASON 落地件】色板/选中 chip/渠道卡顶条 ─────────────── */
/* SEASON 数组在 JS(L1663) 里、靠内联 style 注入，CSS 改不了值；
   收编它落地的元素，让质感听宿主：色板加高光、chip 选中不再花、渠道卡顶条收敛 */
.ofm_root .ofm_swatch{
  border-radius: 3px !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%), inset 0 -1px 0 rgb(0 0 0 / 16%) !important;
}
/* chip 选中态：JS 注入彩色背景，这里压回宿主语言——主色薄涂+主色边，去掉杂色 */
.ofm_root .ofm_chip[aria-pressed="true"]{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent) !important;
  color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%) !important;
}
/* 渠道卡顶条(::before 用 --chan-accent)：收敛高度与发光，听宿主凹槽语言 */
.ofm_root .ofm_chan::before{
  height: 2px !important;
  box-shadow: 0 1px 0 rgb(255 255 255 / 6%) !important;
}
.ofm_root .ofm_chan[data-state="on"]{
  border-color: color-mix(in srgb, var(--chan-accent, var(--dsw-alias-state-business-primary)) 30%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
}

/* ── ⑩【返工·接上 pl5-tick】KPI/统计数字获得表针走格感 ─────────────── */
/* 挂到 KPI 大数字与统计卡数字：hover 时数字以机械顿挫走一格，模拟仪表指针跳动 */
.ofm_root .ofm_kpivalue,
.ofm_root .ofm_stat b{
  display: inline-block !important;
}
.ofm_root .ofm_kpi:hover .ofm_kpivalue,
.ofm_root .ofm_stat:hover b{
  animation: pl5-tick .34s var(--ease-instrument) 1 !important;
}
/* ==== V5 INSTRUMENT END ==== */
/* ── 聚合渠道 / 省 Token / 路由：新页面的表面 ─────────────────────────────
   动效一律走 150–250ms 的短过渡，不弹跳；reduced-motion 下由文件末尾的
   媒体查询整体关掉。ofm_rise 用 backwards 而不是 both：动画结束后元素回到
   样式表里的 transform，卡片的 hover 抬升才不会被动画的终态钉死。 */
.ofm_rise{animation:ofmrisein .22s cubic-bezier(.22,.61,.36,1) backwards}
@keyframes ofmrisein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ofm_duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(272px,100%),1fr));gap:12px;align-items:start}
.ofm_duo>*{min-width:0}
.ofm_picklist{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:8px;max-height:330px;overflow:auto;padding:2px}
.ofm_pickrow{display:flex;flex-direction:column;gap:5px;align-items:stretch;text-align:left;font:inherit;padding:9px 11px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .16s ease,background .16s ease,transform .16s ease}
.ofm_pickrow:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);transform:translateY(-1px)}
.ofm_pickrow[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_pickrow:disabled{opacity:.55;cursor:default}
.ofm_pickhead{display:flex;align-items:center;gap:7px;min-width:0}
.ofm_pickhead b{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_pickmeta{display:flex;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.ofm_picknote{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.ofm_meter{height:9px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.ofm_meter i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),var(--dsw-alias-state-business-primary));transition:width .55s cubic-bezier(.22,.61,.36,1)}
.ofm_member{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);font-size:11.5px;transition:border-color .16s ease,background .16s ease}
.ofm_member .ofm_id{flex:1;min-width:0}
.ofm_snippet{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:pre;overflow:auto;max-height:230px}
@media (max-width:600px){.ofm_duo{grid-template-columns:1fr}.ofm_picklist{grid-template-columns:1fr}.ofm_member{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.ofm_rise,.ofm_page{animation:none}.ofm_pickrow,.ofm_member,.ofm_meter i,.ofm_card,.ofm_kpi,.ofm_chan{transition:none}.ofm_root .ofm_card:hover,.ofm_pickrow:hover:not(:disabled){transform:none}}

/* ── 推荐项目页：两张「去点 Star」的卡片 ─────────────────────────────────
   这一页只有一件事要促成——点开仓库、点下 Star。所以卡片比常规模型卡大一档，
   入场逐张错峰（--i 由调用方给），悬停抬升；主 CTA 是渐变星按钮，带一圈呼吸
   光环与悬停扫光；数字用 count-up 落地。全部只动 transform/opacity/颜色。
   动效降级：文件末尾的 reduced-motion 块统一关掉位移与动画。 */
.ofm_recogrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:14px;align-items:stretch}
.ofm_recocard{position:relative;display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(168deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 86%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent));box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 2px 8px rgb(0 0 0 / 5%),0 14px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent);overflow:hidden;animation:ofm-reco-in .5s var(--ease-instrument) backwards;animation-delay:calc(var(--i,0)*90ms);transition:transform .24s var(--ease-instrument),box-shadow .28s ease,border-color .2s ease}
.ofm_recocard::before{content:"";position:absolute;inset:-45% 45% 50% -35%;pointer-events:none;opacity:0;background:radial-gradient(58% 58% at 32% 32%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 72%);transition:opacity .4s ease}
.ofm_recocard:hover::before{opacity:1}
.ofm_recocard:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 10%),0 18px 44px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}
@keyframes ofm-reco-in{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
.ofm_recotop{display:flex;align-items:center;gap:11px;min-width:0}
.ofm_recomark{display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex:none;border-radius:13px;color:var(--dsw-alias-label-on-accent,#fff);background:linear-gradient(145deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary)));box-shadow:inset 0 1px 0 rgb(255 255 255 / 28%),0 4px 12px color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);transition:transform .3s var(--ease-settle)}
.ofm_recomark svg{width:22px;height:22px;fill:currentColor}
.ofm_recocard:hover .ofm_recomark{transform:rotate(-4deg) scale(1.06)}
.ofm_recoid{display:flex;flex-direction:column;gap:2px;min-width:0}
.ofm_reconame{font-size:15px;font-weight:700;letter-spacing:-.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_recorepo{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_recobadge{margin-left:auto;flex:none;font-size:10.5px;font-weight:650;padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);white-space:nowrap}
.ofm_recotagline{margin:0;font-size:13.5px;font-weight:650;line-height:1.5;letter-spacing:-.1px}
.ofm_recobody{margin:0;flex:1;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary)}
.ofm_recochips{display:flex;gap:6px;flex-wrap:wrap}
.ofm_recochip{font-size:10.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 66%,transparent);color:var(--dsw-alias-label-secondary);transition:border-color .16s ease,color .16s ease,transform .16s ease}
.ofm_recochip:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary);transform:translateY(-1px)}
.ofm_recofoot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:auto;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.ofm_recofacts{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_recofact{display:flex;align-items:baseline;gap:5px}
.ofm_recofact b{font-size:13.5px;font-weight:700;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ofm_recoacts{display:flex;gap:8px;align-items:center;margin-left:auto}
.ofm_recogo{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;transition:border-color .16s ease,color .16s ease,transform .16s ease,background .16s ease}
.ofm_recogo:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);transform:translateY(-1px)}
.ofm_recogo svg{width:12px;height:12px;fill:currentColor;opacity:.7;transition:transform .2s var(--ease-instrument)}
.ofm_recogo:hover svg{transform:translateX(2px)}
.ofm_recostar{position:relative;display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:999px;overflow:hidden;font-size:13px;font-weight:700;letter-spacing:.1px;text-decoration:none;white-space:nowrap;color:var(--dsw-alias-label-on-accent,#fff);background:linear-gradient(135deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 58%,var(--dsw-alias-label-primary)));box-shadow:inset 0 1px 0 rgb(255 255 255 / 26%),0 6px 18px color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent);transition:transform .18s var(--ease-settle),box-shadow .24s var(--ease-instrument),filter .2s ease}
.ofm_recostar:hover{transform:translateY(-2px) scale(1.02);filter:saturate(1.06);box-shadow:inset 0 1px 0 rgb(255 255 255 / 32%),0 12px 28px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent)}
.ofm_recostar:active{transform:scale(.97)}
.ofm_recostar svg{width:16px;height:16px;fill:currentColor;transition:transform .5s var(--ease-settle)}
.ofm_recostar:hover svg{transform:rotate(72deg) scale(1.15)}
.ofm_recostar::after{content:"";position:absolute;top:0;bottom:0;width:36%;left:-45%;pointer-events:none;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 38%),transparent);transform:skewX(-18deg);transition:left .6s var(--ease-instrument)}
.ofm_recostar:hover::after{left:115%}
.ofm_recostarring{position:absolute;inset:0;border-radius:inherit;pointer-events:none;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent);animation:ofm-reco-ring 2.8s var(--ease-instrument) infinite}
@keyframes ofm-reco-ring{0%{opacity:.6;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.22)}}
.ofm_recoglow{position:absolute;inset:-50% -12% auto;height:175%;z-index:0;pointer-events:none;background:radial-gradient(42% 52% at 24% 62%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent),transparent 70%),radial-gradient(38% 46% at 78% 38%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 11%,transparent),transparent 72%);filter:blur(10px);animation:ofm-reco-aurora 18s ease-in-out infinite alternate}
@keyframes ofm-reco-aurora{from{transform:translate3d(-3%,1%,0) scale(1)}to{transform:translate3d(3%,-2%,0) scale(1.08)}}
.ofm_reconote{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
@media (max-width:600px){.ofm_recogrid{grid-template-columns:1fr}.ofm_recoacts{width:100%;margin-left:0}}
@media (prefers-reduced-motion:reduce){.ofm_recocard,.ofm_recostar,.ofm_recogo,.ofm_recochip,.ofm_recomark{animation:none;transition:border-color .12s ease,background .12s ease,box-shadow .12s ease,opacity .12s ease,color .12s ease}.ofm_recocard:hover,.ofm_recostar:hover,.ofm_recostar:active,.ofm_recogo:hover,.ofm_recochip:hover,.ofm_recocard:hover .ofm_recomark{transform:none}.ofm_recostar::after,.ofm_recostarring,.ofm_recoglow{display:none}}
/* ═══════════════════════════════════════════════════════════════════════
   Minimal theme layer（本地方案自带）
   目标：工具化外观 —— 直角小圆角、1px 细边框、无阴影/无渐变/无模糊/
   无动效；字体交给系统 UI 字栈，数字与 id 用等宽。
   说明：本层写在样式表末尾，用 !important 压过上游那套玻璃拟态规则，
   不依赖任何主题变量之外的颜色。
   ═══════════════════════════════════════════════════════════════════════ */

/* ── 1. 字体与基础尺寸 ─────────────────────────────────────────────── */
.ofm_root{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
    Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
  font-size: 12.5px !important;
  line-height: 1.55 !important;
  letter-spacing: 0 !important;
  -webkit-font-smoothing: antialiased;
}
.ofm_root .ofm_num,.ofm_root .ofm_mono,.ofm_root .ofm_id,.ofm_root .ofm_kpivalue,
.ofm_root .ofm_table td:first-child{
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important;
  font-variant-numeric: tabular-nums !important;
}

/* ── 2. 拆掉装饰层：噪点、极光、扫光、玻璃、阴影、动效 ─────────────── */
.ofm_root::before{display:none !important}
.ofm_root .ofm_aurora{display:none !important}
.ofm_root *,
.ofm_root *::before,
.ofm_root *::after{
  animation: none !important;
  transition: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  text-shadow: none !important;
}
.ofm_root .ofm_btn::after{display:none !important}

/* ── 3. 容器：平面 + 细边框 + 小圆角 ───────────────────────────────── */
.ofm_root .ofm_hero,
.ofm_root .ofm_panel,
.ofm_root .ofm_card,
.ofm_root .ofm_recocard,
.ofm_root .ofm_ann,
.ofm_root .ofm_modal,
.ofm_root .ofm_glass,
.ofm_root .ofm_tank,
.ofm_root .ofm_field,
.ofm_root .ofm_callout{
  background: var(--dsw-alias-bg-layer-2, transparent) !important;
  border: 1px solid var(--dsw-alias-border-l1, currentColor) !important;
  border-radius: 6px !important;
  box-shadow: none !important;
}
.ofm_root .ofm_hero{background: var(--dsw-alias-bg-layer-1, transparent) !important}

/* ── 4. 按钮：方、平、细边；主按钮用前景色反转，不引入彩色 ─────────── */
.ofm_root .ofm_btn,
.ofm_root .ofm_minibtn,
.ofm_root .ofm_seg,
.ofm_root .ofm_foldtoggle{
  background: transparent !important;
  border: 1px solid var(--dsw-alias-border-l1, currentColor) !important;
  border-radius: 4px !important;
  box-shadow: none !important;
  color: var(--dsw-alias-label-primary) !important;
  transform: none !important;
}
.ofm_root .ofm_minibtn,
.ofm_root .ofm_foldtoggle{border: 0 !important; padding-left: 0 !important; padding-right: 0 !important}
.ofm_root .ofm_btn:hover:not(:disabled),
.ofm_root .ofm_minibtn:hover:not(:disabled){
  background: var(--dsw-alias-bg-layer-1, transparent) !important;
  border-color: var(--dsw-alias-label-tertiary, currentColor) !important;
  box-shadow: none !important;
  transform: none !important;
}
.ofm_root .ofm_btn:disabled{opacity: .45 !important}

/* ── 5. 输入与选择：细边框即可，focus 只换边框色 ───────────────────── */
.ofm_root .ofm_input,
.ofm_root .ofm_input:focus{
  background: var(--dsw-alias-bg-layer-1, transparent) !important;
  border: 1px solid var(--dsw-alias-border-l1, currentColor) !important;
  border-radius: 4px !important;
  box-shadow: none !important;
  outline: none !important;
}
.ofm_root .ofm_input:focus{border-color: var(--dsw-alias-label-secondary, currentColor) !important}

/* ── 6. 徽标与标签：小矩形，描边而非填充 ───────────────────────────── */
.ofm_root .ofm_pill,
.ofm_root .ofm_tag,
.ofm_root .ofm_tagpill,
.ofm_root .ofm_chip,
.ofm_root .ofm_badge,
.ofm_root .ofm_poolbadge,
.ofm_root .ofm_chantag,
.ofm_root .ofm_poolbadge{
  border-radius: 4px !important;
  box-shadow: none !important;
  background: transparent !important;
  border: 1px solid var(--dsw-alias-border-l1, currentColor) !important;
  font-size: 11px !important;
  letter-spacing: 0 !important;
}

/* ── 7. 表格与图形：细线、去底色 ───────────────────────────────────── */
.ofm_root .ofm_table{border-collapse: collapse !important}
.ofm_root .ofm_table th,
.ofm_root .ofm_table td{
  border-bottom: 1px solid var(--dsw-alias-border-l1, currentColor) !important;
  background: transparent !important;
}
.ofm_root .ofm_prog,
.ofm_root .ofm_tank,
.ofm_root .ofm_skel{border-radius: 3px !important; box-shadow: none !important}

/* ── 8. 滚动条与选中：去掉圆头胶囊 ─────────────────────────────────── */
.ofm_root ::-webkit-scrollbar{width: 8px !important; height: 8px !important}
.ofm_root ::-webkit-scrollbar-thumb{
  background: var(--dsw-alias-border-l2, currentColor) !important;
  border: 0 !important;
  border-radius: 2px !important;
}

/* ── 9. 标题层级收紧，工具面板不摆排版姿态 ─────────────────────────── */
.ofm_root .ofm_pagetitle{font-size: 15px !important; font-weight: 600 !important; letter-spacing: 0 !important}
.ofm_root .ofm_paneltitle{font-size: 12.5px !important; font-weight: 600 !important; letter-spacing: 0 !important}
.ofm_root .ofm_sec{letter-spacing: 0 !important}
.ofm_root h1,.ofm_root h2,.ofm_root h3,.ofm_root h4{letter-spacing: 0 !important; text-transform: none !important}

/* ── 极简皮肤：去彩色边框/渐变/阴影/动画/头像 ───────────────── */
.ofm_root,.ofm_root *{animation:none!important;transition:none!important;transform:none!important;box-shadow:none!important;text-shadow:none!important;backdrop-filter:none!important;filter:none!important;background-image:none!important}
.ofm_root{gap:10px!important;font-size:12.5px!important;max-width:960px!important}
.ofm_root::before,.ofm_aurora{display:none!important}
.ofm_hero,.ofm_panel,.ofm_card,.ofm_chan,.ofm_modal,.ofm_callout,.ofm_glass,.ofm_seg{border-radius:4px!important;border:1px solid var(--dsw-alias-border-l1)!important;background:var(--dsw-alias-bg-layer-1)!important}
.ofm_chanlogo{border-radius:3px!important;border:1px solid var(--dsw-alias-border-l1)!important;background:var(--dsw-alias-bg-layer-2)!important;color:var(--dsw-alias-label-secondary)!important;font-weight:600!important;font-size:11px!important}
.ofm_chanlogo img{display:none!important}
.ofm_chan{border-color:var(--dsw-alias-border-l1)!important}
.ofm_chan[data-state]{border-color:var(--dsw-alias-border-l1)!important;background:var(--dsw-alias-bg-layer-1)!important}
.ofm_chan[data-state]::before,.ofm_chan::before{display:none!important;background:none!important}
.ofm_chan[data-state]:hover{border-color:var(--dsw-alias-border-l2)!important}
.ofm_chan .ofm_chanlogo{background:var(--dsw-alias-bg-layer-2)!important;color:var(--dsw-alias-label-secondary)!important}
.ofm_chan .ofm_chanstate,.ofm_chan .ofm_chanmeta,.ofm_chan .ofm_note{color:var(--dsw-alias-label-tertiary)!important}
.ofm_chan:hover,.ofm_card:hover{border-color:var(--dsw-alias-border-l2)!important}
.ofm_pill,.ofm_tag,.ofm_chip,.ofm_newtag,.ofm_hottag,.ofm_badge,.ofm_kbd{border-radius:3px!important;border:1px solid var(--dsw-alias-border-l1)!important;background:transparent!important;color:var(--dsw-alias-label-secondary)!important;box-shadow:none!important;font-weight:500!important;letter-spacing:0!important;text-transform:none!important}
.ofm_dot{box-shadow:none!important}
.ofm_root button{border-radius:3px!important;border:1px solid var(--dsw-alias-border-l1)!important;background:transparent!important;box-shadow:none!important;font-weight:500!important;color:var(--dsw-alias-label-secondary)!important}
.ofm_root button:hover{background:var(--dsw-alias-bg-layer-2)!important;color:var(--dsw-alias-label-primary)!important}
.ofm_pagetitle h2{background:none!important;-webkit-text-fill-color:currentColor!important;color:var(--dsw-alias-label-primary)!important;font-size:15px!important;font-weight:600!important;letter-spacing:0!important}
.ofm_pagetitle p,.ofm_sec_hint,.ofm_note,.ofm_reconote{color:var(--dsw-alias-label-tertiary)!important;font-size:12px!important}
.ofm_root h3,.ofm_sectitle{font-size:12.5px!important;font-weight:600!important;letter-spacing:0!important;color:var(--dsw-alias-label-primary)!important}
.ofm_sponsor_banner,.ofm_sponsor_logo{display:none!important}

/* ── 去彩色（第三轮）：压住高优先级的 accent 描边与主按钮渐变 ───────── */
.ofm_root .ofm_chan[data-state],.ofm_root .ofm_chan[data-state="on"],.ofm_root .ofm_chan[data-state="idle"],.ofm_root .ofm_chan[data-state="off"]{border-color:var(--dsw-alias-border-l1)!important;box-shadow:none!important;background:var(--dsw-alias-bg-layer-1)!important}
.ofm_root .ofm_chan[data-state]:hover{border-color:var(--dsw-alias-border-l2)!important;box-shadow:none!important}
.ofm_root .ofm_chan[data-state]::before,.ofm_root .ofm_chan[data-state]::after{display:none!important;background:none!important}
.ofm_root .ofm_chan .ofm_chanlogo{display:none!important}
.ofm_root .ofm_btn.primary,.ofm_root button.primary{background:transparent!important;background-image:none!important;border:1px solid var(--dsw-alias-border-l1)!important;color:var(--dsw-alias-label-primary)!important;box-shadow:none!important}
.ofm_root .ofm_btn.primary:hover,.ofm_root button.primary:hover{background:var(--dsw-alias-bg-layer-2)!important;color:var(--dsw-alias-label-primary)!important}
.ofm_root .ofm_dot.ok,.ofm_root .ofm_dot.warn,.ofm_root .ofm_dot.err{background:var(--dsw-alias-label-tertiary)!important;box-shadow:none!important}
/* ── 成功状态一律绿色：压过极简皮肤那条把三种状态点都灰化的规则 ────── */
.ofm_root .ofm_dot.ok{background:#2ea043!important;box-shadow:0 0 0 3px rgb(46 160 67 / 18%)!important;opacity:1!important}
.ofm_root .ofm_pill .ofm_dot.ok{background:#2ea043!important}
.ofm_root .ofm_pill.ok{border-color:rgb(46 160 67 / 45%)!important;color:#2ea043!important}
/* ══ 紧凑模式：行距、卡片内距压小，渐变/投影/悬浮位移压平 ══════ */
.ofm_root{--gap:7px;gap:10px;line-height:1.45}
.ofm_root .ofm_hero{padding:14px 16px;gap:8px;border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.ofm_root .ofm_pagetitle h2{font-size:19px;letter-spacing:-.3px;background:none;-webkit-text-fill-color:currentColor;color:var(--dsw-alias-label-primary)}
.ofm_root .ofm_panel{padding:12px;gap:8px;border-radius:10px;box-shadow:none}
.ofm_root .ofm_card{padding:10px 11px;gap:6px;border-radius:10px;box-shadow:none;background:var(--dsw-alias-bg-layer-2)}
.ofm_root .ofm_card:hover{transform:none;box-shadow:none}
.ofm_root .ofm_chanwrap{gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.ofm_root .ofm_chan{padding:12px 13px;gap:8px;border-radius:12px;box-shadow:none;background:var(--dsw-alias-bg-layer-2)}
.ofm_root .ofm_chan:hover{transform:none;box-shadow:none}
.ofm_root .ofm_pill{padding:2px 8px;font-size:11px;box-shadow:none}
.ofm_root .ofm_dot.ok{box-shadow:none}
.ofm_root .ofm_btn{padding:5px 11px;font-size:11.5px;box-shadow:none;background:var(--dsw-alias-bg-layer-3)}
.ofm_root .ofm_btn:hover:not(:disabled){transform:none;box-shadow:none}
.ofm_root .ofm_seg{padding:2px;box-shadow:none}
.ofm_root .ofm_row{gap:6px}

`

    // ── helpers ───────────────────────────────────────────────────────────────
    // 用页面 base 解析，而不是 origin-absolute 的「/api/...」：DSH 挂在反向代理
    // 子路径下（https://<host>/<prefix>/）时，前导斜杠会把 <prefix> 丢掉，请求
    // 直接打到站点根被前置网关 404，设置面板报「无法连接插件后端」（#54）。
    // 相对路径随页面 base 走，根路径部署下与原值完全一致。解析不了（无 document
    // 的宿主、非常规 base）就退回根路径原值——行为不比修复前差。
    const API = (() => {
      try { return new URL('api/get-it-for-free', document.baseURI).pathname } catch { return '/api/get-it-for-free' }
    })()


    async function api(path, options) {
      // 8 秒超时兜底：后端路由未注册/挂起时 fetch 不再永久挂起——此前全部 api 调用
      // （onboarding /announcement、设置页 /announcements /update/status、面板 /summary /stats
      // /forward/key 等）无任何超时，一个不响应端点即可阻塞 settings.onboarding 协调流程
      // 并长期占用同源连接池。超时按 AbortError 抛给调用方，走各自 .catch 降级路径。
      // 慢路由按需放宽（options.timeout，毫秒）：/bench 要等一整段真实生成（本车道
      // 首帧动辄数十秒），/update/apply 要下载+校验+安装整包，/refresh /reprobe 要
      // 跑完一整轮探测——8 秒兜底套在它们身上只会“前端报失败、后端继续烧”，
      // 测速按钮因此几乎必失败而配额照付。
      const { timeout = 8000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...timeout === undefined ? {} : { timeout },
    })

    function useAsync(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ ...current, status: 'loading' }))
        loader().then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => { if (alive) setState({ status: 'error', data: undefined, error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      return { ...state, reload: run }
    }

    function kilo(value) {
      const n = Math.round(Number(value) || 0)
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
      return String(n)
    }

    function ago(ts, locale) {
      if (!ts) return '—'
      const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000))
      const zh = String(locale ?? '').toLowerCase().startsWith('zh')
      if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
      return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)}d ago`
    }

    function copy(text, done) {
      const finish = ok => done(ok)
      if (navigator?.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(() => finish(true), () => finish(legacy(text)))
        return
      }
      finish(legacy(text))
    }
    function legacy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch { return false }
    }

    // ── announcement HTML: strict allowlist, no innerHTML sink ───────────────
    // The feed is authored by the repository owner, but rendering is a trust
    // boundary of its own: the feed URL can be pointed anywhere, and a
    // compromised repository must never become script execution. Nothing here
    // hands a string to the HTML engine — the tokenizer walks the text, drops
    // everything off the allowlist, and builds a virtual tree that both React
    // and plain DOM can materialize. The same parser is exercised headlessly
    // by scripts/sanitize-test.mjs.
    const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'])
    /** Everything these elements contain is dropped, closing tag included. */
    const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'svg', 'math', 'form', 'input', 'button', 'select', 'option', 'video', 'audio', 'canvas', 'link', 'meta', 'base'])
    const VOID_TAGS = new Set(['br', 'hr', 'img'])
    const MAX_HTML_NODES = 4000
    const ALLOWED_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration'])
    const STYLE_CAMEL = { 'background-color': 'backgroundColor', 'text-align': 'textAlign', 'font-weight': 'fontWeight', 'font-style': 'fontStyle', 'text-decoration': 'textDecoration', color: 'color' }

    /** http(s), mailto and in-page fragments only; images additionally accept inline PNG/JPEG/GIF/WebP. */
    function safeUrl(raw, isImage) {
      const value = String(raw ?? '').trim()
      if (value === '' || value.length > 2000) return undefined
      const lower = value.toLowerCase()
      if (/^https?:\/\//.test(lower)) return value
      if (lower.startsWith('mailto:') && /^[^@\s]+@[^@\s]+$/.test(value.slice(7))) return value
      if (lower.startsWith('#')) return value
      if (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value
      return undefined
    }

    function sanitizeStyle(raw) {
      const out = {}
      for (const decl of String(raw ?? '').split(';')) {
        const idx = decl.indexOf(':')
        if (idx === -1) continue
        const prop = decl.slice(0, idx).trim().toLowerCase()
        const value = decl.slice(idx + 1).trim()
        if (!ALLOWED_STYLE_PROPS.has(prop) || value === '' || value.length > 120) continue
        if (/url\(|expression|javascript:|@|<|>/.test(value.toLowerCase())) continue
        out[STYLE_CAMEL[prop]] = value
      }
      return out
    }

    function sanitizeAttrs(tag, attrText) {
      const props = {}
      const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let match
      while ((match = attrRe.exec(attrText ?? '')) !== null) {
        const key = match[1].toLowerCase()
        const value = match[3] ?? match[4] ?? match[5] ?? ''
        if (key === 'style') {
          const style = sanitizeStyle(value)
          if (Object.keys(style).length > 0) props.style = style
          continue
        }
        if (tag === 'a' && key === 'href') {
          const url = safeUrl(value)
          if (url !== undefined) {
            props.href = url
            props.target = '_blank'
            props.rel = 'noopener noreferrer'
          }
          continue
        }
        if (tag === 'img' && key === 'src') {
          const url = safeUrl(value, true)
          if (url !== undefined) props.src = url
          continue
        }
        if ((tag === 'img' || tag === 'a') && key === 'title') { props.title = value.slice(0, 300); continue }
        if (tag === 'img' && key === 'alt') { props.alt = value.slice(0, 300); continue }
        if ((key === 'width' || key === 'height') && /^\d{1,4}$/.test(value)) { props[key] = Number(value); continue }
      }
      return props
    }

    /**
     * Tokenize announcement HTML into a virtual tree of
     * `{type:'el', tag, props, children}` and `{type:'text', text}` nodes.
     * Disallowed elements are unwrapped (their children survive); the content
     * of raw-text elements such as `<script>` is dropped entirely.
     */
    function parseSafeHtml(html) {
      if (typeof html !== 'string' || html.trim() === '') return []
      const root = { type: 'root', children: [] }
      const stack = [root]
      const top = () => stack[stack.length - 1]
      let nodes = 0
      let skipUntil = null
      const tokenRe = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
      let match
      while ((match = tokenRe.exec(html)) !== null) {
        if (nodes >= MAX_HTML_NODES) break
        if (match[0].startsWith('<!--')) continue
        if (match[4] !== undefined) {
          if (skipUntil === null) {
            const text = match[4]
            if (text.trim() !== '' || (top().children.length > 0 && typeof top().children[top().children.length - 1] !== 'string')) {
              top().children.push(text)
            }
          }
          continue
        }
        const name = (match[1] ?? match[2] ?? '').toLowerCase()
        if (name === '') continue
        if (match[1] !== undefined) {
          // closing tag
          if (skipUntil !== null) {
            if (name === skipUntil) skipUntil = null
            continue
          }
          if (!ALLOWED_TAGS.has(name)) continue
          let depth = stack.length - 1
          while (depth > 0 && stack[depth].tag !== name) depth -= 1
          if (depth === 0) continue
          while (stack.length - 1 > depth) {
            const dropped = stack.pop()
            top().children.push(...dropped.children)
          }
          const frame = stack.pop()
          top().children.push({ type: 'el', tag: frame.tag, props: frame.props, children: frame.children })
          nodes += 1
          continue
        }
        // opening tag
        if (skipUntil !== null) continue
        if (DROP_CONTENT_TAGS.has(name)) { skipUntil = name; continue }
        if (!ALLOWED_TAGS.has(name)) continue
        const props = sanitizeAttrs(name, match[3])
        if (name === 'img' && props.src === undefined) continue
        if (VOID_TAGS.has(name)) {
          top().children.push({ type: 'el', tag: name, props, children: [] })
          nodes += 1
          continue
        }
        stack.push({ tag: name, props, children: [] })
      }
      while (stack.length > 1) {
        const frame = stack.pop()
        top().children.push(...frame.children)
      }
      return root.children
    }

    /** Materialize the virtual tree as React elements (keys are positional). */
    function htmlToReact(nodes) {
      return nodes.map((node, index) => typeof node === 'string'
        ? node
        : h(node.tag, { key: index, ...node.props }, ...htmlToReact(node.children ?? [])))
    }

    /** Materialize the virtual tree as DOM nodes (for toasts and modals). */
    function htmlToDom(nodes) {
      return nodes.map(node => {
        if (typeof node === 'string') return document.createTextNode(node)
        const el = document.createElement(node.tag)
        for (const [key, value] of Object.entries(node.props ?? {})) {
          if (key === 'style') { Object.assign(el.style, value); continue }
          el.setAttribute(key, String(value))
        }
        for (const child of htmlToDom(node.children ?? [])) el.appendChild(child)
        return el
      })
    }

    // ── toasts: a vanilla-DOM host so pushes surface on every page ───────────
    // Slot content only exists where the shell mounts it; a toast that lived
    // inside the settings section would be invisible everywhere else. This
    // host attaches to document.body, outside the app root, and needs no
    // react-dom — the body renders through the same allowlist parser.
    function toastHost() {
      let host = document.querySelector('.ofm_toasts')
      if (host === null) {
        host = document.createElement('div')
        host.className = 'ofm_toasts'
        document.body.appendChild(host)
      }
      return host
    }

    function showToast({ title, body, html, tone, actions = [], holdMs = 10000 }) {
      try {
        const host = toastHost()
        const card = document.createElement('div')
        card.className = 'ofm_toast' + (tone === undefined ? '' : ` ${tone}`)
        const head = document.createElement('div')
        head.className = 'ofm_toasttitle'
        head.appendChild(document.createTextNode(title ?? ''))
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'ofm_toastclose'
        // No locale lookup in here on purpose: showToast also runs from the
        // push subscription before any `t` binding is in scope, and a throw
        // inside this try/catch would silently swallow the whole toast.
        close.setAttribute('aria-label', 'close')
        close.title = '✕'
        close.textContent = '✕'
        close.addEventListener('click', () => card.remove())
        head.appendChild(close)
        card.appendChild(head)
        if (body !== undefined && body !== '') {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          area.textContent = String(body)
          card.appendChild(area)
        } else if (html !== undefined) {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          for (const node of htmlToDom(parseSafeHtml(html))) area.appendChild(node)
          card.appendChild(area)
        }
        if (actions.length > 0) {
          const row = document.createElement('div')
          row.className = 'ofm_toastactions'
          for (const action of actions) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ofm_btn'
            btn.textContent = action.label
            btn.addEventListener('click', () => { card.remove(); action.onClick?.() })
            row.appendChild(btn)
          }
          card.appendChild(row)
        }
        host.appendChild(card)
        while (host.children.length > 4) host.firstElementChild?.remove()
        if (holdMs > 0) {
          const timer = setTimeout(() => card.remove(), holdMs)
          timer.unref?.()
        }
        return card
      } catch { /* a toast must never break its caller */ }
      return undefined
    }

    /** Modal surface for `urgent` announcements; dismiss runs the ack callback. */
    function showUrgentModal({ title, html, confirmLabel, onClose }) {
      try {
        document.querySelector('.ofm_scrim[data-ofm-urgent]')?.remove()
        const scrim = document.createElement('div')
        scrim.className = 'ofm_scrim'
        scrim.setAttribute('data-ofm-urgent', 'true')
        const modal = document.createElement('div')
        modal.className = 'ofm_modal'
        modal.setAttribute('role', 'alertdialog')
        modal.setAttribute('aria-modal', 'true')
        const head = document.createElement('div')
        head.className = 'ofm_modalhead'
        head.textContent = title ?? ''
        const body = document.createElement('div')
        body.className = 'ofm_modalbody'
        for (const node of htmlToDom(parseSafeHtml(html ?? ''))) body.appendChild(node)
        const foot = document.createElement('div')
        foot.className = 'ofm_modalfoot'
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'ofm_btn primary'
        ok.textContent = confirmLabel ?? 'OK'
        ok.addEventListener('click', () => { scrim.remove(); onClose?.() })
        foot.appendChild(ok)
        modal.appendChild(head)
        modal.appendChild(body)
        modal.appendChild(foot)
        scrim.appendChild(modal)
        document.body.appendChild(scrim)
      } catch { /* a modal must never break its caller */ }
    }

    /** OS-level notification, only when the user both opted in and granted. */
    function osNotify(title, body) {
      try {
        if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
        new Notification(title, { body: String(body ?? '').slice(0, 200) })
      } catch { /* the in-app toast still fires */ }
    }

    const Switch = (props) => h('button', {
      type: 'button',
      className: 'ofm_switch',
      role: 'switch',
      'aria-checked': props.checked ? 'true' : 'false',
      // Several call sites already pass `disabled` (the gateway switch does, while
      // its RPC is in flight) and it was silently dropped, so a switch stayed
      // clickable through a write it could not survive. Passing it through is what
      // those call sites meant.
      disabled: props.disabled === true,
      onClick: props.onChange,
    }, h('i'), props.label === undefined ? null : h('span', null, props.label))

    const Pill = (props) => h('span', { className: `ofm_pill${props.strong ? ' strong' : ''}` },
      props.tone === undefined ? null : h('span', { className: `ofm_dot ${props.tone}` }),
      props.children)

    const Button = props => h('button', {
      type: 'button',
      className: 'ofm_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
    }, props.children)




    // ── charts (hand-drawn SVG; the shell ships no plotting primitive) ────────

    /** Column-major local-calendar weeks, from Sunday through today (17 weeks by default). */





    // ── model roster ──────────────────────────────────────────────────────────




    // ── dashboard ─────────────────────────────────────────────────────────────
    // ── pool panel (co-paid lane capacity & live pressure) ────────────────────
    // Numbers come from the gateway through the plugin backend (/pool), which
    // is the only place the sealed gateway URL exists. All of them are real:
    // capacity is the operator's actual provisioning rule (stars × 1.5, or a
    // configured count), and the load verdict — 畅通 / 繁忙 / 过载 — is computed
    // by the gateway process itself from its in-flight streams and event-loop
    // saturation, so the panel and the server can never disagree about the
    // color. The panel renders nothing at all when the host has no lane or the
    // gateway is dark — a gauge that lies would be worse than no gauge.


    /**
     * The aquarium itself: water level, waves, bubbles, three fish and a glass
     * frame. It is deliberately a *pure* visual — every page that shows one
     * decides what the level means (free lane: share of models reachable;
     * EAC lane: the co-paid pool's 24h pressure), because a tank whose meaning
     * changes with the caller is the only way to put the same object at the top
     * of two pages without either one lying about its numbers.
     */


    /**
     * The co-paid pool snapshot, shared by the EAC page's tank and its detail
     * panel. One hook so the page and the panel never disagree: both read the
     * same 30-second poll. `pool === undefined` means "still loading", `null`
     * means "the host has no lane or the gateway is dark" — the caller decides
     * whether that is a muted line or nothing at all.
     */


    /** The pool's load verdict and the numbers behind it, from one snapshot. */


    /** The GitHub star every call to action on this page carries. */

    /** The repository every page's star button points at, opened in a new tab. */
    /** Where the pool's capacity number comes from, in one sentence. */


    // ── EAC 渠道授权（GitHub 登录 + Star） ────────────────────────────────────
    // 闸门在服务器：网关拒绝没有用户令牌的对话，而这个面板是取得令牌的唯一入口。
    // 三种状态如实呈现——未登录 / 已登录但未 star / 已授权——并且登录全程无需
    // 复制粘贴：后端把授权页交给系统浏览器，前端轮询网关领取令牌。令牌本身从不
    // 到达浏览器，这里只显示登录名与判定结果。
    //
    // 登录流（发起、轮询、busy/notice）住在 SettingsPage 级的 hook 里：页头的
    // 未授权按钮、上锁模型卡的「去授权」和这个面板必须共享同一个进行中的会话，
    // 各挂一份轮询会互相抢令牌的领取权。
    const EAC_LOGIN_TTL = 10 * 60_000
    const EAC_LOGIN_KEY = `ofm.eac.pending:${API}`
    function rememberEacLogin(pending) {
      try {
        if (pending === null) sessionStorage.removeItem(EAC_LOGIN_KEY)
        else sessionStorage.setItem(EAC_LOGIN_KEY, JSON.stringify(pending))
      } catch { /* restricted browser storage: this mounted page can still log in */ }
    }
    function restoreEacLogin() {
      try {
        const value = JSON.parse(sessionStorage.getItem(EAC_LOGIN_KEY))
        if (value !== null && /^[A-Za-z0-9_-]{16,64}$/.test(value.link)
          && typeof value.url === 'string' && /^https?:\/\//.test(value.url)
          && Number.isFinite(value.startedAt) && value.startedAt <= Date.now()
          && Date.now() - value.startedAt < EAC_LOGIN_TTL) return value
      } catch { /* absent or malformed */ }
      rememberEacLogin(null)
      return null
    }
    function useEacLogin({ t, summary, onAuth }) {
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [pending, setPending] = useState(restoreEacLogin)
      const [copied, setCopied] = useState(false)
      const starting = useRef(false)
      const cancelling = useRef(false)
      const attempt = useRef(0)
      const pendingRef = useRef(pending)
      pendingRef.current = pending
      const updatePending = value => {
        pendingRef.current = value
        rememberEacLogin(value)
        setPending(value)
      }
      const refresh = useCallback(() => {
        api('/eac/status', { timeout: 20_000 }).then(onAuth).catch(() => onAuth({ available: true, authorized: false, login: '', unverified: true }))
      }, [onAuth])
      const latest = useRef(summary)
      latest.current = summary
      const latestT = useRef(t)
      latestT.current = t

      // Schedule only after completion: slow gateway responses must not create
      // overlapping collectors. The link survives settings-page remounts.
      useEffect(() => {
        if (pending === null) return undefined
        let alive = true
        let timer
        const poll = async () => {
          const t = latestT.current
          if (!alive || cancelling.current) return
          if (Date.now() - pending.startedAt >= EAC_LOGIN_TTL) {
            updatePending(null); setNotice(t('eac.expired')); return
          }
          try {
            const result = await api(`/eac/login/poll?link=${encodeURIComponent(pending.link)}`, { timeout: 22_000 })
            if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
            if (result.status === 'ok') {
              updatePending(null)
              setNotice(t('eac.done').replace('{login}', result.login ?? ''))
              refresh(); latest.current?.reload?.()
              return
            }
            if (result.status === 'expired') {
              updatePending(null); setNotice(t('eac.sessionExpired')); return
            }
            if (result.status === 'unstarred') setNotice(t('eac.needStar').replace('{login}', result.login ?? ''))
            else setNotice('')
          } catch (error) {
            if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
            const reason = String(error?.message ?? '')
            if (reason === 'cancelled') { updatePending(null); setNotice(''); return }
            // Never render response HTML, URL or credentials as diagnostics.
            const safe = /^gateway-http-\d{3}$/.test(reason) ? `HTTP ${reason.slice(-3)}`
              : ['unreachable', 'malformed', 'not-writable', 'cancelled', 'no-lane', 'bad-link', 'timeout'].includes(reason) ? reason : 'unreachable'
            setNotice(reason === 'not-writable' ? t('eac.saveFailed') : t('eac.pollFailed').replace('{reason}', safe))
          }
          if (alive && pendingRef.current?.link === pending.link) timer = setTimeout(poll, 2500)
        }
        timer = setTimeout(poll, 2500)
        return () => { alive = false; clearTimeout(timer) }
      }, [pending, refresh])

      const cancel = async () => {
        const currentPending = pendingRef.current
        if (currentPending === null || cancelling.current) return
        cancelling.current = true
        attempt.current++; setBusy(true)
        try {
          const result = await post(`/eac/login/cancel?link=${encodeURIComponent(currentPending.link)}`)
          if (result.ok !== true && result.status !== 'ok') throw new Error('cancellation unconfirmed')
          updatePending(null)
          if (result.status === 'ok') {
            setNotice(latestT.current('eac.done').replace('{login}', result.login ?? ''))
            refresh(); latest.current?.reload?.()
          } else setNotice('')
        } catch {
          const t = latestT.current
          setNotice(t('eac.cancelFailed'))
          // A failed cancellation must retain the link and restart the serial
          // loop. The Host may already have saved it or accepted cancellation.
          updatePending({ ...currentPending })
        } finally { cancelling.current = false; setBusy(false) }
      }
      const login = async () => {
        if (starting.current || cancelling.current || pendingRef.current !== null) return
        starting.current = true
        const current = ++attempt.current
        setBusy(true); setNotice('')
        try {
          const started = await post('/eac/login/start', undefined, 30_000)
          if (current !== attempt.current) return
          if (started?.error !== undefined) { setNotice(t('eac.startFailed').replace('{reason}', started.error)); return }
          updatePending({ link: started.link, url: started.url, startedAt: Date.now() })
          if (started.opened !== true) setNotice(t('eac.openManually'))
        } catch (error) {
          if (current === attempt.current) setNotice(t('eac.startFailed').replace('{reason}', 'unreachable'))
        } finally { starting.current = false; setBusy(false) }
      }
      const logout = async () => {
        attempt.current++; updatePending(null); setBusy(true)
        try {
          await post('/eac/logout')
          refresh(); latest.current?.reload?.()
        } catch { setNotice(t('eac.startFailed').replace('{reason}', 'unreachable')) } finally { setBusy(false) }
      }
      return { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel }
    }






    const stat = (value, label) => h('div', { className: 'ofm_stat' }, h('b', null, value), h('span', null, label))




    const chip = (label, on, color, onClick) => h('button', { type: 'button', className: 'ofm_chip', 'aria-pressed': on ? 'true' : 'false', onClick, style: on ? { color } : undefined },
      h('span', { className: 'ofm_swatch', style: { background: color } }), label)

    // ── forward listener ──────────────────────────────────────────────────────


    // ── egress outlet ─────────────────────────────────────────────────────────
    // Two ways out: a Clash subscription load-balanced by a spawned mihomo, or
    // one hand-written http/https/socks5 URL. Until this is on AND started,
    // egressFetch sends every request direct — nothing here is load-bearing for
    // plain use. The address is a credential, so it never rides along in the
    // settings payload: this panel shows the masked host and pulls the value
    // itself (`/egress/url`) only when the owner asks to see or copy it.




    // ── preferences ───────────────────────────────────────────────────────────


    // ── announcement center ──────────────────────────────────────────────────






    // ── in-app upgrade ───────────────────────────────────────────────────────
    // Status requests may overlap (SSE, an action, or a remount). Only the newest
    // mounted request may publish an installation owner or an error.



    // ── 推荐项目页 ────────────────────────────────────────────────────────────
    // 这一页只有一个任务：让人点开仓库、点下 Star。所以文案是「说清它解决什么
    // 问题」，动作是「一眼能看到的星按钮」，数字是宿主 /picks 取回的真实 Star /
    // Fork / 最近提交——拿不到就整块不显示，绝不用占位数字凑版面（这块页面的
    // 全部说服力都在数字是真的）。每张卡片的文案按语言直写 t('字面量')，字典
    // 保持可 grep；各仓库的地址与「第二个动作」在这里各写一份。

    /** 2,034 — a star count is read, not computed, so it keeps its separators. */
    const grouped = value => String(Math.max(0, Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

    /**
     * 0 → n in about a second, once per arrival.
     *
     * The page's whole argument is that these numbers are real and moving, and a
     * number that counts up reads as a live reading rather than a printed one.
     * Reduced motion skips straight to the value — the number is the point, the
     * motion is not.
     */



    // ── 渠道接入页 ────────────────────────────────────────────────────────
    // Real channel logos carried over from the upstream Channel Pack client (see
    // vendor/channel-pack/NOTICE.md) — the same artwork users know from those
    // products, embedded so no network fetch is involved. Channels without an
    // entry fall back to their two-letter tile.

    /** The plugin's own brand mark (user-supplied artwork, 128px JPEG). */


    /**
     * The thirteen account channels enabled by OFM. Identity is static (it is
     * the product, not a reading), so the grid renders instantly and only the
     * *state* comes from the pack over RPC. `accent` drives each card's stripe
     * and logo tile; `login` picks the flow the card offers.
     */
    const CHANNEL_PROVIDERS = [
      { id: 'codearts', name: 'CodeArts', org: '华为云', accent: '#C7000B', login: 'browser' },
      { id: 'buddy', name: 'WorkBuddy 国内版', org: '腾讯 · copilot.tencent.com', accent: '#0A7AFF', login: 'browser' },
      { id: 'workbuddy', name: 'WorkBuddy 国际版', org: '腾讯 · workbuddy.ai', accent: '#0B63CE', login: 'browser' },
      { id: 'lobsterai', name: 'LobsterAI', org: '有道', accent: '#FF6A00', login: 'browser' },
      { id: 'qodercn', name: 'Qoder 中国版', org: '阿里系', accent: '#7A6CF0', login: 'browser' },
      { id: 'trae', name: 'TRAE', org: '字节', accent: '#00BFA6', login: 'browser' },
      { id: 'raccoon', name: 'Raccoon', org: '商汤', accent: '#00A6A6', login: 'browser' },
      { id: 'minimax', name: 'MiniMax Code', org: 'MiniMax', accent: '#E4007F', login: 'browser' },
      { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6', login: 'browser' },
    ]

    /** 与现有 RPC 的能力对应：余额、每日领取及独立签到状态分别判断。 */
    const CHANNEL_CREDITS = {
      codearts: { claim: true },
      buddy: { claim: true, status: true },
      workbuddy: {},
      lobsterai: { claim: true },
      qodercn: { claim: true },
      trae: { claim: true },
      cline: { unit: 'dollars' },
      loomy: { claim: true },
      raccoon: {},
      minimax: { claim: true, status: true },
      zcode: { claim: true, unit: 'tokens' },
    }

    /**
     * The host RPC the pack registered at `/api/channel-pack`.
     *
     * The pack's own browser half used the shell's connection service; this page
     * does the same instead of proxying through our JSON API, so channel traffic
     * keeps the connection's admission and the credential store stays the only
     * place a token exists. `connection` is read opportunistically: a shell that
     * does not offer it still renders the free and EAC pages, with this one
     * explaining itself instead of breaking.
     */
    function sameChannelTransport(left, right) {
      return left === right || (left !== null && right !== null
        && typeof left === 'object' && typeof right === 'object'
        && left.connection === right.connection && left.call === right.call)
    }

    function channelTransport(rpc) {
      return typeof rpc?.transport === 'function' ? rpc.transport() : rpc
    }

    function useChannelRpc(ctx) {
      const ctxRef = useRef(ctx)
      ctxRef.current = ctx
      const readTransport = useCallback(() => {
        const current = ctxRef.current
        let connection
        try { connection = current?.connection } catch { /* service not provided yet */ }
        if (connection === undefined || connection === null) {
          try { connection = current?.get?.('connection') } catch { /* service not provided yet */ }
        }
        try {
          const call = connection?.rpc?.call
          return typeof call === 'function' ? { connection, call } : null
        } catch { return null }
      }, [])
      const [transport, setTransport] = useState(readTransport)
      useEffect(() => {
        let alive = true
        const check = () => {
          if (!alive) return
          const next = readTransport()
          setTransport(previous => sameChannelTransport(previous, next) ? previous : next)
        }
        check()
        const timer = setInterval(check, 500)
        return () => { alive = false; clearInterval(timer) }
      }, [readTransport])
      // Context wrappers do not invalidate readers; actual transport replacement does.
      // 宿主可能把处理结果再包一层 `{ok, value}`，这里统一剥到底，
      // 让调用方永远拿到 handler 的返回体。
      const unwrapEnvelope = value => {
        let current = value
        for (let depth = 0; depth < 4; depth++) {
          if (current === null || typeof current !== 'object') return current
          if (current.ok === false) throw new Error(current.error?.message ?? current.error?.code ?? 'rpc-failed')
          if (current.ok === true && 'value' in current) { current = current.value; continue }
          if (current.type === 'server-response' && 'value' in current) { current = current.value; continue }
          return current
        }
        return current
      }
      // 兜底通道：直接用同源 fetch 打 pack 自己注册的 HTTP 端点。
      // 桌面宿主里 connection 服务有时不可见（或 rpc 不是可调用形态），
      // 但端点本身是 HTTP 的，浏览器自带 cookie，走这条路同样能拿到数据。
      const envelopeRpc = useCallback(async (method, payload, timeoutMs = 60_000) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch('/api/channel-pack', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              method: 'channel-pack',
              payload: { method, payload },
            }),
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`http-${response.status}`)
          const rawText = await response.text()
          lastRaw = `status=${response.status} ${rawText.slice(0, 200)}`
          let body
          try { body = rawText === '' ? {} : JSON.parse(rawText) } catch { body = {} }
          if (body?.type === 'server-response' && body.ok === false) throw new Error(body.error?.message ?? body.error?.code ?? 'rpc-failed')
          const inner = body?.value ?? body
          if (inner?.ok === true) return unwrapEnvelope(inner.value)
          if (inner?.ok === false) throw new Error(inner.error?.message ?? inner.error?.code ?? 'rpc-failed')
          return inner
        } finally { clearTimeout(timer) }
      }, [])
      const rpc = useCallback(async (method, payload, timeoutMs = 60_000) => {
        // ① 插件宿主侧的进程内桥：桌面端浏览器侧的 connection.rpc 会挂起不回，
        //    但宿主自己还能发同一个调用，由 /api/get-it-for-free/rpc 转一手。
        try {
          const bridged = await post('/rpc', { method, payload }, timeoutMs)
          if (bridged?.ok === false) throw new Error(bridged.error ?? 'bridge-failed')
          const inner = unwrapEnvelope(bridged?.reply)
          if (inner?.ok === true) { lastTransportKind = 'bridge'; return inner.value }
          if (inner?.ok === false) throw new Error(inner.error?.message ?? inner.error?.code ?? 'rpc-failed')
          lastTransportKind = 'bridge'
          return inner
        } catch { /* 桥不通，落到下面的浏览器侧通道 */ }
        const latest = readTransport()
        if (latest === null) { lastTransportKind = 'http'; return await envelopeRpc(method, payload, timeoutMs) }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const result = await latest.call.call(latest.connection.rpc, '/api', 'channel-pack', { method, payload }, controller.signal)
          if (result?.ok === true) { lastTransportKind = 'rpc'; return unwrapEnvelope(result.value) }
          if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
          lastTransportKind = 'rpc'
          return result
        } catch (error) {
          // 只在「根本没有 rpc 通道」时回退，避免把有副作用的调用重放两次。
          const reason = String(error?.message ?? error)
          if (reason === 'no-connection' || /no connection|not provided|not registered|undefined is not a function/i.test(reason)) {
            lastTransportKind = 'http'
            return await envelopeRpc(method, payload, timeoutMs)
          }
          throw error
        } finally { clearTimeout(timer) }
      }, [readTransport, transport])
      rpc.transport = readTransport
      return { available: true, rpc }
    }

    let lastTransportKind = '?'
    let lastRaw = ''
    let diagMounts = 0
    let diagApplies = 0
    function closeLoginPopup(popup) {
      try { if (popup && !popup.closed) popup.close() } catch { /* best effort */ }
    }

    /** Human text for a millisecond timestamp, or the long-lived marker. */
    function expiryText(entry, t) {
      if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= 0) return t('chan.expires.never')
      return ago(entry.expiresAt, t.locale)
    }

    function ChannelCard(props) {
      const { channel, status, rpc, t, onError, onChanged } = props
      const [open, setOpen] = useState(null)
      const [accounts, setAccounts] = useState(undefined)
      const [models, setModels] = useState(undefined)
      const [credits, setCredits] = useState(undefined)
      // 实时积分：每个账号的剩余余额（credits.balances），卡片汇总 + 账号行
      // 逐条展示；随账号列表与领积分动作刷新，另有一个慢轮询兜底。
      const [balances, setBalances] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      const modelBatchPending = useRef(false)
      const [balanceError, setBalanceError] = useState('')
      const [balanceLoading, setBalanceLoading] = useState(false)
      const balancePending = useRef(null)
      const balanceGeneration = useRef(0)
      const claimPending = useRef(false)
      const creditCapability = CHANNEL_CREDITS[channel.id]
      // 端点选择器已经删掉：zcode 一律走国内 bigmodel 端点，不再读写偏好。
      const zcodeProvider = 'bigmodel'
      const loginAttempt = useRef(null)
      const balanceLabel = creditCapability?.unit === 'tokens' ? t('chan.credits.tokens')
        : creditCapability?.unit === 'dollars' ? t('chan.credits.dollars')
          : creditCapability?.quota ? t('chan.credits.quota') : t('chan.credits.left')

      const accountsCount = status?.accounts?.total ?? 0
      const enabledCount = status?.accounts?.enabled ?? 0
      const modelsTotal = status?.models?.total ?? 0
      const modelsOff = status?.models?.disabled ?? 0
      // `/channels` 里的 models.total 是**黑名单条数**（不是渠道目录里的模型总数），
      // 拿它算比例会得到「全关 0/7、开一个变 0/6」这种越开越小的怪数字。真正的
      // 目录要问 model.list（它返回完整模型表，每个带 disabled 标记），所以卡片
      // 自己拉一次目录来算「已启用/总数」；还没拿到时显示省略号，不显示错的数。
      const catalogue = Array.isArray(models) ? models : models === null ? null : undefined
      const catalogueTotal = Array.isArray(catalogue) ? catalogue.length : undefined
      const catalogueOn = Array.isArray(catalogue) ? catalogue.filter(row => row?.disabled !== true).length : undefined
      const modelsLabel = Array.isArray(catalogue)
        ? (catalogueTotal === 0 ? '—' : `${catalogueOn}/${catalogueTotal}`)
        : modelsTotal > 0 ? `${modelsTotal - modelsOff}/${modelsTotal}` : '…'
      const connected = enabledCount > 0
      // 「有账号」优先于「被关闭」：账号池里还有启用的账号就是已接入。
      // 反过来，「已关闭」只由账号决定（有账号且全部停用）——与模型开关无关。
      // 判据直接从这里算，不再读 status.closed：宿主 REST 与兜底 RPC 两条取数
      // 路径对 closed 的口径历史上并不一致（前者按账号、后者按模型全关），
      // 只认一个来源才能保证文案、圆点、置灰永远同源。
      const closedByAccounts = accountsCount > 0 && enabledCount === 0
      const chanState = connected ? 'on' : closedByAccounts ? 'off' : 'idle'
      const stateText = connected ? t('chan.state.on') : closedByAccounts ? t('chan.state.closed') : t('chan.state.off')

      const loadAccounts = useCallback(async () => {
        try {
          const value = await rpc('account.list', { provider: channel.id })
          setAccounts(value?.accounts ?? [])
        } catch (error) { setAccounts([]); onError(channel, error) }
      }, [rpc, channel.id, onError])
      const loadModels = useCallback(async () => {
        try {
          const value = await rpc('model.list', { provider: channel.id })
          setModels(value?.models ?? [])
        } catch (error) { setModels(null); onError(channel, error) }
      }, [rpc, channel.id, onError])
      const loadCredits = useCallback(async () => {
        if (!CHANNEL_CREDITS[channel.id]?.status) return
        try {
          const value = await rpc('credits.status', { provider: channel.id })
          setCredits(value?.accounts ?? [])
        } catch { setCredits([]) }
      }, [rpc, channel.id])
      const loadBalances = useCallback((afterWrite = false) => {
        if (!CHANNEL_CREDITS[channel.id] || !rpc) return Promise.resolve()
        const pending = balancePending.current
        if (!afterWrite && pending?.provider === channel.id && pending.rpc === rpc) return pending.promise
        const generation = ++balanceGeneration.current
        const request = { provider: channel.id, rpc }
        balancePending.current = request
        setBalanceLoading(true); setBalanceError('')
        request.promise = (async () => {
          try {
            const value = await rpc('credits.balances', { provider: channel.id, ...afterWrite ? { force: true } : {} }, 90_000)
            if (generation === balanceGeneration.current) setBalances(value?.accounts ?? [])
          } catch (error) {
            if (generation === balanceGeneration.current) {
              setBalances([])
              setBalanceError(String(error?.message ?? error))
            }
          } finally {
            if (generation === balanceGeneration.current) setBalanceLoading(false)
            if (balancePending.current === request) balancePending.current = null
          }
        })()
        return request.promise
      }, [rpc, channel.id])
      useEffect(() => {
        setBalances(undefined); setBalanceError('')
        void loadBalances()
        return () => { balanceGeneration.current++; balancePending.current = null }
      }, [loadBalances])
      // A slow heartbeat keeps the numbers honest while the page sits open:
      // balances move whenever a model is used elsewhere, and a stale credit
      // count reads as "I have more quota than I do".
      useEffect(() => {
        if (!CHANNEL_CREDITS[channel.id]) return undefined
        const timer = setInterval(() => { void loadBalances() }, 90_000)
        return () => clearInterval(timer)
      }, [channel.id, loadBalances])
      const balanceOf = accountId => {
        const row = (balances ?? []).find(entry => entry.accountId === accountId)
        return row?.balance === null || row?.balance === undefined ? null : row.balance
      }
      const balancesTotal = (balances ?? []).reduce((sum, row) => sum + (Number.isFinite(row.balance?.total) ? row.balance.total : 0), 0)
      const balancesKnown = (balances ?? []).some(row => Number.isFinite(row.balance?.total))
      const balanceFailures = (balances ?? []).filter(row => row.error || !Number.isFinite(row.balance?.total)).length

      // Refetch what is on screen whenever the pack reports a change for this
      // channel: an account added in another tab, a completed background login,
      // a claim that moved the numbers.
      useEffect(() => {
        const onEvent = () => {
          if (open === 'accounts') { void loadAccounts(); void loadCredits() }
          if (open === 'models') void loadModels()
          void loadBalances()
        }
        window.addEventListener('ofm:channels', onEvent)
        return () => window.removeEventListener('ofm:channels', onEvent)
      }, [open, loadAccounts, loadModels, loadCredits, loadBalances])

      // 卡片不展开也要显示模型比例，所以进页面就把目录拉一次（本地 RPC，很快）。
      useEffect(() => {
        const timer = setTimeout(() => { void loadModels() }, 120)
        return () => clearTimeout(timer)
      }, [loadModels])

      // 未接入（一条账号都没有）的渠道：模型自动全部关掉。这些模型本来也选不到，
      // 留着只会让「模型」栏里挂一堆还能点的开关，容易让人以为渠道能用。
      // 每个挂载周期只尝试一次；失败就放弃，不重试、不刷屏。
      const autoClosed = useRef(false)
      useEffect(() => {
        if (autoClosed.current) return
        // 必须确认渠道状态真的加载过：status 还没到时 accountsCount 也是 0，
        // 直接判「没账号」会把有账号渠道的模型全部关掉（实测误关过 buddy/trae）。
        if (!status || !status.accounts || typeof status.accounts.total !== 'number') return
        if (!Array.isArray(catalogue) || accountsCount !== 0) return
        if (!catalogue.some(row => row?.disabled !== true)) { autoClosed.current = true; return }
        autoClosed.current = true
        void (async () => {
          try {
            await rpc('model.setAllDisabled', { provider: channel.id, disabled: true })
            await loadModels()
            onChanged()
          } catch (error) {
            // 失败也把标记留住：这类失败通常来自适配器没有目录，重试只会反复报错。
            onError(channel, error)
          }
        })()
      }, [status, catalogue, accountsCount, rpc, channel.id, loadModels, onChanged, onError])

      const toggle = async fold => {
        if (open === fold) { setOpen(null); return }
        setOpen(fold)
        if (fold === 'accounts') { setAccounts(undefined); await loadAccounts(); void loadCredits(); void loadBalances() }
        if (fold === 'models') { setModels(undefined); await loadModels() }
      }

      // The pack's login is two-phase: `account.create` returns the URL to open
      // *immediately* (a popup opened after a 30-second await is blocked), then
      // the browser flow finishes in the background and `login.poll` sees the
      // credential appear. The placeholder account is real from the first
      // moment, so the card can poll against it.
      useEffect(() => {
        if (loginAttempt.current?.cancelled) {
          loginAttempt.current = null
          setBusy(value => value === 'add' ? '' : value)
        }
        return () => {
          const attempt = loginAttempt.current
          if (attempt) { attempt.cancelled = true; closeLoginPopup(attempt.popup) }
        }
      }, [channel.id])
      useEffect(() => {
        const attempt = loginAttempt.current
        if (!attempt || sameChannelTransport(attempt.transport, channelTransport(rpc))) return
        attempt.cancelled = true
        closeLoginPopup(attempt.popup)
        loginAttempt.current = null
        setBusy(value => value === 'add' ? '' : value)
      }, [rpc])
      const startLogin = async () => {
        if (loginAttempt.current && !loginAttempt.current.cancelled) return
        const attempt = { popup: null, cancelled: false, transport: channelTransport(rpc) }
        const current = () => !attempt.cancelled && sameChannelTransport(attempt.transport, channelTransport(rpc))
        loginAttempt.current = attempt
        setBusy('add'); setNotice('')
        // Reserve inside the click; a delayed RPC would lose transient activation.
        try {
          attempt.popup = window.open('about:blank', '_blank')
          if (attempt.popup) attempt.popup.opener = null
        } catch { closeLoginPopup(attempt.popup); attempt.popup = null }
        try {
          const value = await rpc('account.create', {
            provider: channel.id,
            ...channel.id === 'zcode' ? { zcodeProvider } : {},
          }, 90_000)
          if (!current()) { attempt.cancelled = true; closeLoginPopup(attempt.popup); return }
          const accountId = value?.accountId
          const url = value?.loginUrl
          if (typeof accountId !== 'string' || accountId === '') throw new Error('bad-answer')
          if (typeof url === 'string' && url !== '') {
            const target = new URL(url)
            if (url.length > 2048 || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('bad-login-url')
            let opened = false
            try {
              if (attempt.popup && !attempt.popup.closed) {
                attempt.popup.location.replace(url)
                opened = true
                attempt.popup = null
              }
            } catch { /* the host can open it instead */ }
            closeLoginPopup(attempt.popup); attempt.popup = null
            if (!opened) {
              try { opened = (await post('/open-external', { url }, 15_000))?.opened === true } catch { /* manual link remains available */ }
            }
            if (!current()) { attempt.cancelled = true; return }
            if (!opened) {
              try { window.open(url, '_blank', 'noopener') } catch { /* the modal offers the link too */ }
            }
          } else { closeLoginPopup(attempt.popup); attempt.popup = null }
          setLogin({ accountId, url: typeof url === 'string' ? url : '', startedAt: Date.now() })
          setOpen('accounts')
        } catch (error) {
          closeLoginPopup(attempt.popup)
          if (current()) onError(channel, error)
        } finally {
          if (loginAttempt.current === attempt && !attempt.cancelled) {
            loginAttempt.current = null
            setBusy('')
          }
        }
      }

      // Poll the placeholder until its credential lands. Ten minutes matches the
      // window the pack keeps a pending login link alive for.
      useEffect(() => {
        if (login === null) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (Date.now() - login.startedAt > 10 * 60_000) {
            if (alive) { setLogin(null); setNotice(t('chan.login.expired')) }
            return
          }
          try {
            const value = await rpc('login.poll', { accountId: login.accountId, provider: channel.id })
            if (!alive) return
            if (value?.done === true) {
              setLogin(null)
              if (value.success === false) {
                setNotice(t('chan.login.failed').replace('{reason}', value.error ?? '未知原因'))
              } else {
                setNotice(t('chan.login.done').replace('{login}', value.login ?? ''))
                onChanged()
                void loadAccounts()
                void loadCredits()
                void loadBalances(true)
              }
            } else if (typeof value?.error === 'string' && value.error !== '') {
              setLogin(null)
              setNotice(t('chan.login.failed').replace('{reason}', value.error))
            }
          } catch { /* the link may still complete; keep polling */ }
        }, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [login, rpc, channel.id, t, onChanged, loadAccounts, loadCredits, loadBalances])

      const accountAction = async (key, accountId, fn) => {
        setBusy(key); setNotice('')
        try { await fn() } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      const setAllModels = async disabled => {
        if (busy !== '' || modelBatchPending.current || !rpc || !models?.length) return
        modelBatchPending.current = true
        try {
          await accountAction(disabled ? 'models:hide' : 'models:show', '', async () => {
            await rpc('model.setAllDisabled', { provider: channel.id, disabled })
            await loadModels()
            onChanged()
          })
        } finally { modelBatchPending.current = false }
      }

      const removeAccount = async accountId => {
        const entry = (accounts ?? []).find(row => row.id === accountId)
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('chan.confirm.delete').replace('{name}', entry?.nickname ?? accountId))) return
        await accountAction('del:' + accountId, accountId, async () => {
          await rpc('account.delete', { accountId })
          onChanged(); await loadAccounts(); void loadBalances(true)
        })
      }

      const claim = async () => {
        if (!creditCapability?.claim || busy !== '' || claimPending.current) return
        claimPending.current = true
        setBusy('claim'); setNotice('')
        try {
          const value = await rpc('credits.claimAll', { provider: channel.id }, 180_000)
          const summary = value?.summary ?? value
          const claimed = Number(summary?.claimed ?? 0)
          const credit = Number(summary?.totalCredit ?? 0)
          const failed = (value?.results ?? []).filter(row => row.outcome?.kind === 'failed')
          const successText = t('chan.claim.result').replace('{count}', String(claimed)).replace('{credit}', String(credit))
          const failureText = t('chan.claim.failed').replace('{reason}', failed.map(row => row.outcome.message).join('；'))
          setNotice(failed.length > 0 ? claimed > 0 ? `${successText}；${failureText}` : failureText
            : claimed > 0 ? successText : t('chan.claim.none'))
          void loadCredits(); void loadBalances(true)
        } catch (error) { onError(channel, error) } finally { claimPending.current = false; setBusy('') }
      }

      const creditFor = accountId => (credits ?? []).find(row => row.accountId === accountId)?.status ?? null

      const card = h('article', {
        className: `ofm_chan ofm_glass${chanState === 'off' ? ' off' : ''}`,
        'data-state': chanState,
        style: { '--chan-accent': channel.accent },
      },
        h('div', { className: 'ofm_chanhead' },
          h('span', { className: 'ofm_chanid' },
            h('b', null, channel.name),
            h('span', null, channel.org)),
          h('span', { className: 'ofm_chanstate' },
            h('span', { className: `ofm_dot ${connected ? 'ok' : closedByAccounts ? 'err' : ''}` }),
            stateText)),
        h('div', { className: 'ofm_chanmeta' },
          h('span', null, `${t('chan.meta.accounts')} `, h('b', null, `${enabledCount}/${accountsCount}`)),
          h('span', null, `${t('chan.meta.models')} `, h('b', null, modelsLabel)),
          creditCapability ? h('span', { className: 'ofm_credittotal' },
            `${balanceLabel} `,
            h('b', null, balanceLoading ? '…' : balancesKnown
              ? creditCapability.quota ? t('chan.credits.loaded').replace('{count}', String((balances ?? []).filter(row => Number.isFinite(row.balance?.total)).length)) : kilo(balancesTotal)
              : balances === undefined ? '…' : '—')) : null),
        h('div', { className: 'ofm_chanacts' },
          h('button', { type: 'button', className: 'ofm_btn', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'add' ? 'true' : undefined, onClick: startLogin }, busy === 'add' ? '…' : t('chan.act.add')),
          accountsCount > 0 ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'refreshAll' ? 'true' : undefined,
            onClick: () => accountAction('refreshAll', '', async () => {
              for (const row of accounts ?? await rpc('account.list', { provider: channel.id }).then(v => v?.accounts ?? [])) {
                try { await rpc('account.refresh', { accountId: row.id }, 90_000) } catch (error) { onError(channel, error) }
              }
              onChanged(); await loadAccounts(); void loadBalances(true)
            }),
          }, busy === 'refreshAll' ? '…' : t('chan.act.refresh')) : null,
          creditCapability ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: balanceLoading || busy !== '' || !rpc,
            'aria-busy': balanceLoading ? 'true' : undefined, onClick: () => void loadBalances(true),
          }, balanceLoading ? t('chan.credits.loading') : t('chan.credits.refresh')) : null,
          creditCapability?.claim ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'claim' ? 'true' : undefined,
            onClick: claim,
          }, busy === 'claim' ? '…' : t('chan.act.claim')) : null,
          h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'accounts' ? 'true' : 'false', onClick: () => void toggle('accounts') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.accounts'), accounts === undefined ? null : ` (${accounts.length})`),
          h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'models' ? 'true' : 'false', onClick: () => void toggle('models') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.models'), models === undefined ? null : ` (${models.length})`)),
        notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null,
        balanceError !== '' ? h('p', { className: 'ofm_balanceerror', role: 'alert' },
          t('chan.credits.failed').replace('{reason}', balanceError))
          : balanceFailures > 0 ? h('p', { className: 'ofm_balanceerror', role: 'status' },
            t('chan.credits.partial').replace('{count}', String(balanceFailures))) : null,
        open === 'accounts' ? h('div', { className: 'ofm_chanfold' },
          accounts === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('chan.noAccount'))
              : h('div', { className: 'ofm_acctlist' }, accounts.map(row => {
                const credit = creditFor(row.id)
                const pending = row.refreshable !== true && !Number.isFinite(row.expiresAt)
                return h('div', { className: 'ofm_acct' + (pending ? ' pending' : ''), key: row.id },
                  h('span', { className: 'ofm_acctname', title: row.nickname ?? row.id }, row.nickname ?? row.id),
                  h('span', { className: 'ofm_acctmeta' }, row.enabled === false ? t('chan.disabled') : t('chan.enabled'), ' · ', expiryText(row, t)),
                  credit?.todayCheckedIn === true && Number.isFinite(credit.todayCredit) ? h('span', { className: 'ofm_creditbadge' },
                    t('chan.credit.today').replace('{credit}', String(credit.todayCredit))) : null,
                  (() => {
                    const balance = balanceOf(row.id)
                    if (!creditCapability) return null
                    if (balanceLoading) return h('span', { className: 'ofm_note' }, t('chan.credits.loading'))
                    const result = (balances ?? []).find(entry => entry.accountId === row.id)
                    if (balance === null || !Number.isFinite(balance.total)) return h('span', { className: 'ofm_balanceerror' },
                      balanceError ? t('chan.credits.failed').replace('{reason}', balanceError)
                        : result?.error || t('chan.credits.unavailable'))
                    const reading = creditCapability.quota
                      ? (balance.packages ?? []).map(pkg => `${pkg.name} ${pkg.remaining}%`).join(' · ') || '—'
                      : kilo(balance.total)
                    return h('span', { className: 'ofm_creditbadge strong', title: balanceLabel },
                      `${balanceLabel} ${reading}`)
                  })(),
                  h('span', { className: 'ofm_acctacts' },
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('test:' + row.id, row.id, async () => {
                        const value = await rpc('account.test', { accountId: row.id }, 90_000)
                        setNotice(value?.ok === false
                          ? t('chan.test.failed').replace('{reason}', value?.error ?? '')
                          : t('chan.test.ok').replace('{ms}', String(value?.ms ?? value?.latencyMs ?? '—')))
                      }),
                    }, t('chan.act.test')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('refresh:' + row.id, row.id, async () => {
                        await rpc('account.refresh', { accountId: row.id }, 90_000)
                        onChanged(); await loadAccounts(); void loadBalances(true)
                      }),
                    }, t('chan.act.refresh')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('toggle:' + row.id, row.id, async () => {
                        await rpc('account.update', { accountId: row.id, patch: { enabled: row.enabled === false } })
                        onChanged(); await loadAccounts()
                      }),
                    }, row.enabled === false ? t('chan.act.enable') : t('chan.act.disable')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn danger', disabled: busy !== '' || !rpc,
                      onClick: () => void removeAccount(row.id),
                    }, t('chan.act.delete'))))
              }))) : null,
        open === 'models' ? h('div', { className: 'ofm_chanfold' },
          models === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : models.length === 0 ? h('p', { className: 'ofm_note' }, '—')
              : h(Fragment, null,
                h('div', { className: 'ofm_row' },
                  h('span', { className: 'ofm_note' }, t('chan.model.enabledCount')
                    .replace('{enabled}', String(models.filter(model => model.disabled !== true).length))
                    .replace('{total}', String(models.length))),
                  h('button', {
                    type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc,
                    title: t('chan.model.allScope'), 'aria-busy': busy === 'models:show' ? 'true' : undefined,
                    onClick: () => void setAllModels(false),
                  }, t('chan.model.enableAll')),
                  h('button', {
                    type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc,
                    title: t('chan.model.allScope'), 'aria-busy': busy === 'models:hide' ? 'true' : undefined,
                    onClick: () => void setAllModels(true),
                  }, t('chan.model.disableAll'))),
                h('div', { className: 'ofm_modellist' }, models.map(model => h('div', {
                className: 'ofm_modelrow' + (model.disabled === true ? ' off' : ''),
                key: model.id,
              },
                h('span', { className: 'ofm_id', title: model.id }, model.name ?? model.id),
                model.isFree === true ? h('span', { className: 'ofm_tagpill free' }, t('chan.model.free')) : null,
                model.dead === true ? h('span', { className: 'ofm_tagpill dead' }, t('chan.model.dead')) : null,
                model.disabled === true ? h('span', { className: 'ofm_tagpill' }, t('chan.model.hidden')) : null,
                h('button', {
                  type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                  onClick: () => accountAction('model:' + model.id, '', async () => {
                    if (model.dead === true) await rpc('model.clearDead', { provider: channel.id, modelId: model.id })
                    else await rpc('model.setDisabled', { provider: channel.id, modelId: model.id, disabled: model.disabled !== true })
                    await loadModels(); onChanged()
                  }),
                }, model.dead === true ? t('chan.model.restore') : model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))) : null)

      const modal = login === null ? null : h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('chan.login.title').replace('{name}', channel.name) },
          h('div', { className: 'ofm_modalhead' }, t('chan.login.title').replace('{name}', channel.name)),
          h('div', { className: 'ofm_modalbody ofm_loginbody' },
            h('div', { className: 'ofm_loginstep' }, h('b', null, '1'), h('span', null, t('chan.login.step1'))),
            h('div', { className: 'ofm_loginstep' }, h('b', null, '2'), h('span', null, t('chan.login.step2'))),
            login.url === '' ? null : h('code', { className: 'ofm_mono', style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, login.url),
            h('p', { className: 'ofm_note ofm_scanline' }, t('chan.login.waiting'))),
          h('div', { className: 'ofm_modalfoot' },
            login.url === '' ? null : h('a', { className: 'ofm_btn primary', href: login.url, target: '_blank', rel: 'noreferrer noopener' }, t('chan.login.open')),
            h('button', { type: 'button', className: 'ofm_btn ghost', onClick: () => setLogin(null) }, t('chan.login.cancel')))))

      return h(Fragment, null, card, modal)
    }


    /**
     * The MiMo lane's card.
     *
     * MiMo has no account pool: its credential is the cookie the Xiaomi MiMo
     * desktop app already holds, so there is nothing to add or remove here and
     * nothing to sign in through. The card therefore shows only what the lane
     * can answer on its own — whether a desktop session was found, how much of
     * the daily allowance is left, and how many models the gateway advertises.
     */
    function MiMoCard(props) {
      const { t } = props
      const [state, setState] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const load = useCallback(async force => {
        try { setState(await api(`/mimo/status${force ? '?refresh=1' : ''}`, { timeout: 25_000 })) }
        catch (error) { setState({ signedIn: false, reason: String(error?.message ?? error) }) }
      }, [])
      useEffect(() => { void load(false) }, [load])
      const signedIn = state?.signedIn === true
      const quota = state?.quota ?? null
      const percent = typeof quota?.percent === 'number' ? Math.round(quota.percent) : null
      const reset = typeof quota?.resetDate === 'string' && quota.resetDate !== ''
        ? quota.resetDate
        : typeof quota?.resetAt === 'number' && Number.isFinite(quota.resetAt)
          ? new Date(quota.resetAt).toLocaleDateString()
          : ''
      const models = Array.isArray(state?.models) ? state.models.length : 0
      return h('div', {
        className: `ofm_chan ofm_glass${signedIn ? '' : ' off'}`,
        'data-state': signedIn ? 'on' : 'off',
      },
        h('div', { className: 'ofm_chanhead' },
          h('span', { className: 'ofm_chanid' },
            h('b', null, 'MiMo'),
            h('span', null, '小米 · 桌面端额度')),
          h('span', { className: 'ofm_chanstate' },
            h('span', { className: `ofm_dot ${signedIn ? 'ok' : ''}` }),
            state === undefined ? '…' : signedIn ? t('chan.state.on') : t('chan.state.off'))),
        h('div', { className: 'ofm_chanmeta' },
          h('span', null, '额度 ', h('b', null, state === undefined ? '…' : percent === null ? '—' : `${percent}%`)),
          reset === '' ? null : h('span', null, '重置 ', h('b', null, reset)),
          h('span', null, `${t('chan.meta.models')} `, h('b', null, state === undefined ? '…' : String(models)))),
        signedIn || state === undefined ? null : h('p', { className: 'ofm_note' }, String(state?.reason ?? '未在小米 MiMo 桌面端登录')),
        h('div', { className: 'ofm_chanacts' },
          h('button', {
            type: 'button', className: 'ofm_btn', disabled: busy,
            'aria-busy': busy ? 'true' : undefined,
            onClick: () => { setBusy(true); void load(true).finally(() => setBusy(false)) },
          }, busy ? '…' : '刷新额度')))
    }

    function ChannelsPage(props) {
      const { t, ctx, summary } = props
      const { available, rpc } = useChannelRpc(ctx)
      // The pack runs a daily auto check-in engine across the credit channels;
      // this page is where it is switched and watched (usage.autoCheckin).
      const [auto, setAuto] = useState(undefined)
      const loadAuto = useCallback(async () => {
        if (!available) return
        try { const value = await rpc('usage.autoCheckin', {}, 30_000); setAuto(value?.autoCheckin ?? null) } catch { setAuto(null) }
      }, [available, rpc])
      useEffect(() => { void loadAuto() }, [loadAuto])
      const toggleAuto = async () => {
        try { const value = await rpc('usage.autoCheckin', { enabled: auto?.enabled !== true }, 60_000); setAuto(value?.autoCheckin ?? null) } catch { /* the status refresh tells */ }
      }
      const [statuses, setStatuses] = useState(undefined)
      const [error, setError] = useState('')
      const pack = summary?.channels ?? { state: 'pending', error: '' }
      // The pack is what answers this page's RPC, so *the RPC answering* is the
      // readiness signal — the summary's `channels` bit can be a step behind:
      // it is read when the page mounts, while the pack's dynamic import may
      // still be in flight, and a page that trusted it would show an empty grid
      // for as long as that stale read lasted. The summary state is then only
      // the failure *reason* when the probes never come back.
      // 渠道卡片先渲染，RPC 状态稍后回填：宁可显示「未连接」的卡片，
      // 也不要在 RPC 慢一拍时整页空白（这就是「渠道一个都看不见」的成因）。
      const [ready, setReady] = useState(true)

      const statusGeneration = useRef(0)
      const statusRetry = useRef(null)
      const statusRequest = useRef(0)
      const statusApplied = useRef(0)
      const loadStatus = useCallback(async (attempt = 0, generation = statusGeneration.current) => {
        if (attempt === 0) { clearTimeout(statusRetry.current); statusRetry.current = null }
        if (!available) return
        const request = ++statusRequest.current
        const transport = channelTransport(rpc)
        const current = () => generation === statusGeneration.current && request >= statusApplied.current
          && sameChannelTransport(transport, channelTransport(rpc))
        try {
          // 桌面端的宿主 RPC 会挂起不返回（provider.status 永远 pending），
          // 所以账号/模型计数改走插件自己的 REST 路由，RPC 仅作兜底。
          let value
          try {
            const listed = await api('/channels', { timeout: 15_000 })
            value = { statuses: listed?.statuses ?? {} }
          } catch (restError) {
            value = await rpc('provider.status', { providers: CHANNEL_PROVIDERS.map(row => row.id) }, 8_000)
          }
          // 只按「请求序号」判新旧：effect 每轮重建会导致 generation 一直变，
          // 旧实现会把刚拿到的好数据丢掉，页面永远停在初始态。
          if (request < statusApplied.current) return
          statusApplied.current = request
          diagApplies++
          setStatuses(value?.statuses ?? {})
          setReady(true)
          setError('')
        } catch (err) {
          if (request < statusApplied.current) return
          // The pack imports asynchronously on a cold start; retry a bounded
          // few times before believing the failure and surfacing the reason.
          if (attempt < 4) {
            clearTimeout(statusRetry.current)
            statusRetry.current = setTimeout(() => { if (current()) void loadStatus(attempt + 1, generation) }, 4000)
            return
          }
          setError(String(err?.message ?? err))
        }
      }, [available, rpc])

      useEffect(() => {
        diagMounts++
        void loadStatus()
        return () => { statusGeneration.current++; clearTimeout(statusRetry.current); statusRetry.current = null }
      }, [loadStatus])
      // A second poll loop, slow: the pack pushes nothing for accounts changed
      // in another window, and a stale count on this page is the kind of quiet
      // wrongness that reads as a bug. Local actions refresh immediately.
      useEffect(() => {
        if (!available) return undefined
        const timer = setInterval(() => { void loadStatus() }, 45_000)
        return () => clearInterval(timer)
      }, [available, loadStatus])

      const onChanged = useCallback(() => {
        void loadStatus()
        try { window.dispatchEvent(new CustomEvent('ofm:channels')) } catch { /* no window */ }
      }, [loadStatus])

      const onError = useCallback((channel, err) => {
        const reason = String(err?.message ?? err)
        showToast({ title: t('chan.error').replace('{reason}', reason).slice(0, 120), body: channel.name, tone: 'warn' })
      }, [t])

      const connected = statuses === undefined ? 0 : CHANNEL_PROVIDERS.filter(row => (statuses[row.id]?.accounts?.enabled ?? 0) > 0).length
      const failed = !ready && pack.state === 'failed'

      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('chan.title')),
              h('p', { className: 'ofm_pagesub' }, t('chan.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: ready ? 'ok' : failed ? 'err' : 'warn' },
                ready ? `${connected}/${CHANNEL_PROVIDERS.length} ${t('chan.state.on')}` : t('chan.state.off')),
              h(Pill, null, `${t('chan.meta.accounts')} ${statuses === undefined ? '—' : CHANNEL_PROVIDERS.reduce((sum, row) => sum + (statuses[row.id]?.accounts?.enabled ?? 0), 0)}`))),
          auto == null ? null : h('div', { className: 'ofm_row' },
            h(Switch, { checked: auto.enabled === true, label: t('chan.auto.title'), onChange: () => void toggleAuto() }),
            h(Pill, { tone: auto.running === true ? 'warn' : auto.ranToday === true ? 'ok' : '' },
              auto.running === true ? t('chan.auto.running') : auto.ranToday === true ? t('chan.auto.ran') : t('chan.auto.off')),
            typeof auto.lastResult === 'string' && auto.lastResult !== '' ? h('span', { className: 'ofm_note', title: auto.lastResult }, t('chan.auto.last').replace('{result}', auto.lastResult.length > 60 ? `${auto.lastResult.slice(0, 60)}…` : auto.lastResult)) : null)),
        failed ? h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, t('chan.pack.failed').replace('{reason}', pack.error ?? ''), h('div', { className: 'ofm_note' }, t('chan.pack.hint')))) : null,
        !available ? h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))) : null,
        !ready && available ? h('div', { className: 'ofm_chanwrap' },
          [0, 1, 2].map(index => h('div', { className: 'ofm_skel', key: index, style: { minHeight: 168 } }))) : null,
        ready ? h('div', { className: 'ofm_chanwrap' }, [h(MiMoCard, { key: 'mimo', t }), ...CHANNEL_PROVIDERS.map(channel => h(ChannelCard, {
          key: channel.id,
          channel,
          status: statuses?.[channel.id],
          rpc: available ? rpc : null,
          t,
          onError,
          onChanged,
        }))]) : null,
        error !== '' && !failed ? h('p', { className: 'ofm_note' }, `${t('chan.error').replace('{reason}', error)}`) : null)
    }

    // ── 数据看板 / 运行日志 / 网关设置 ────────────────────────────────────────
    // The absorbed pack keeps a per-request token ledger (channel → provider →
    // account → model trees, plus a ring of individual requests). These three
    // pages are its reading surface, modelled on the standalone gateway
    // consoles users already know: KPI cards, an account pivot, a model
    // performance table, a paginated request log and the gateway's switches.


    /** Weighted merge of tree rows: averages are re-weighted by request count
     *  so a cross-day or cross-account merge never pretends a heavy day and a
     *  light day average to their mean. */


    /** Flatten the channel→provider→account tree into account rows. */


    /** Aggregate the same tree into per-model rows (across accounts). */


    /** Flatten history days into one merged tree (the 全部历史 view). */











    /** KPI cards: one reading per card, exactly like the gateway consoles. */




    /** The log page: the same request ring, at full width and full detail. */


    /** The gateway page: the pack's OpenAI endpoint plus this plugin's relay. */


    /** Shared page hero for the three gateway-console pages. The caller
     *  renders the copy: literal t() calls stay visible to the copy lint. */


    // ── 聚合渠道 / 省 Token / 路由 ─────────────────────────────────────────────
    /**
     * One panel fetch per page, plus the merge for what a write answers with.
     *
     * `useAsync` above re-reads the whole payload after a write. These three
     * pages must not do that: every control's POST already answers with the state
     * the host stored, and a re-read would either double the round trips or open a
     * window where a switch shows what was *clicked* rather than what was saved.
     * So the payload lives here and the caller merges the POST answer in through
     * `patch`. The shimmer is for the first answer only — a reload after a write
     * keeps the current panel on screen instead of collapsing it back.
     */


    /** First-fetch placeholder: three shimmering cards, not one grey line. */


    /**
     * A load failure that names what failed and offers the retry.
     *
     * The older pages render nothing at all when a route refuses, which reads as
     * "this plugin has no such feature". Each of the three new pages passes its
     * own title, because "cannot read the provider registry" and "cannot read the
     * chain settings" are different sentences to act on.
     */


    /** Copy-to-clipboard that answers the click, so a copy is never silent. */


    /** A switch with its one-line explanation underneath. */


    // Labels for the ids the host serves. Literal t() calls inside an object
    // literal rather than a key table, because a key the copy lint cannot see is
    // a key it reports as unused (the same shape the pool-reason table uses).





    /**
     * Auth kinds this lane cannot drive.
     *
     * `oauth` needs an interactive login and `adc` a cloud-side credential, so
     * the aggregate lane skips them when it builds the catalog. Offering one in
     * the picker would be offering a provider whose key field can never work, so
     * they are shown and marked instead of hidden — "this exists and this lane
     * will not call it" is the honest sentence.
     */


    /** `a, b` / `a\nb` -> `['a','b']`, the shape POST /providers stores. */


    /** How many catalog rows one provider contributes right now, read from
     *  /summary: "configured" must never imply "in the model picker". */




    /**
     * The add-provider picker: the whole registry, filtered.
     *
     * Every row carries what the decision needs — category, wire format, auth
     * kind, how many models ship with it, where to get a key and the free-tier
     * note — because "which of these 76 is worth a key" is the actual question.
     * Rows are capped; the counts say how many matched.
     */


    /**
     * One provider's editor, shared by "configure" and "add".
     *
     * The key box starts empty on purpose and an empty box means *keep*: the host
     * distinguishes an absent field from an empty string, and conflating them is
     * what silently kept a key the user believed they had deleted. Deleting one
     * is therefore its own button, and it says what it does.
     */


    /** A configured provider as one card: identity, what it contributes, and its
     *  editor. The editor is inline rather than behind a fold because every field
     *  on it is something the card's own state can disagree with. */


    /**
     * 聚合渠道: the registry, the configured providers and their editors.
     *
     * The catalog is read from the summary the shell already holds, so the
     * "contributes N models" line is the picker's own view rather than a second
     * derivation — and every write asks the shell to re-read it, because saving a
     * provider changes what the model picker offers.
     */


    /** The segmented level picker the two prompt savers share. */


    /** The savings bar: it grows into place once the first measurement lands, so
     *  the number reads as a measurement rather than as decoration. */


    /**
     * 省 Token: the three savers and what they have actually saved.
     *
     * Every control posts and then renders the host's own answer; nothing here
     * shows a switch state the settings file does not have. The dashboard reads
     * the measurement the host keeps, and says so explicitly when there is none —
     * an empty meter is not a claim that nothing was saved, it is the absence of a
     * measurement.
     */


    /** The chain editor's member picker: searchable, and it shows the lane and
     *  the vision flag, because those are what decide a chain's order. */




    /**
     * The chain editor.
     *
     * The member list is ordered and the order is the chain, so it is edited in
     * place (add / remove / move) rather than through a free-text field: a typo in
     * a text field is a link that silently never resolves, and the host has no way
     * to tell "you meant this model" from "this model is gone".
     */


    /**
     * One stored chain.
     *
     * A chain that resolves to nothing right now is *not* an error state: the host
     * keeps such a chain on purpose, because a link that reaches an EAC model is
     * still correct on a day that lane is closed, and rewriting the user's chain
     * for them is worse than showing it as unavailable. So the card names the
     * members that are not in the roster and says the chain is kept as written —
     * which is the difference between "your chain is fine" and "your chain is
     * broken", and the user is the only one who can tell which one it is.
     */


    /**
     * 路由: the stored fallback chains and their editor.
     *
     * The resolution shown per chain is derived from the model list this page
     * already holds — the same intersection the host uses to build the virtual
     * catalog row — so it survives a reload, and the `usable` array a save answers
     * with is preferred when it is there.
     */


    // ── settings page ─────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const tagged = props.locale === undefined ? props.t : Object.assign(x => props.t(x), { locale: props.locale })
      const t = tagged
      const [busy, setBusy] = useState(false)
      const [benches, setBenches] = useState({})
      const summary = useAsync(() => api('/summary'), [])
      const stats = useAsync(() => api('/stats'), [])
      // GitHub 授权状态由这一层持有：模型卡的锁标记与 EAC 面板必须看到同一个
      // 判定，登录 / 退出后两边同时更新；60 秒轮询兜住别处（另一台机器）的变动。
      const [eacAuth, setEacAuth] = useState(undefined)
      useEffect(() => {
        let alive = true
        const load = () => api('/eac/status', { timeout: 20_000 })
          .then(data => { if (alive) setEacAuth(data) })
          .catch(() => { if (alive) setEacAuth({ available: false, authorized: false, login: '' }) })
        load()
        const timer = setInterval(load, 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // 登录流只有这一份：EAC 面板、页头的未授权按钮、上锁模型卡的「去授权」
      // 共享同一个进行中的会话（同一轮询、同一条提示），见 useEacLogin。
      const eacLogin = useEacLogin({ t, summary, onAuth: setEacAuth })

      const apply = async patch => {
        setBusy(true)
        try {
          await post('/settings', patch)
          summary.reload(); stats.reload()
        } catch (error) {
          // The route can refuse a patch — a routable forward bind, for one — and a
          // rejection nobody shows is a button that appears to do nothing.
          showToast({ title: t('settings.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const bench = async model => {
        setBenches(current => ({ ...current, [model.id]: { running: true } }))
        try {
          // 默认档（balanced）而不是 deep：测速要回答的是“这个模型日常多快”，
          // 默认档就是日常档；deep 每次最多烧 32K 输出 token，且经常把固定
          // bench 会话自己打到 429。
          // The backend owns the 300s total budget; leave 30s for its final response.
          const result = await post('/bench', { model: model.id }, 330_000)
          setBenches(current => ({ ...current, [model.id]: { running: false, result: t('bench.result').replace('{ttft}', result.ttftMs).replace('{tps}', result.tokensPerSecond ?? '—').replace('{reasoning}', result.reasoningTokens ?? '—') + (result.persisted === false ? ' · ' + t('bench.notSaved') : '') } }))
          summary.reload()
        } catch (error) {
          setBenches(current => ({ ...current, [model.id]: { running: false, result: String(error?.message ?? error) } }))
          summary.reload()
        }
      }

      if (summary.status === 'loading' && summary.data === undefined) return h('div', { className: 'ofm_root' }, h('p', { className: 'ofm_note' }, t('loading')))
      if (summary.status === 'error') {
        return h('div', { className: 'ofm_root' },
          h('div', { className: 'ofm_callout ofm_error' }, h('div', null, h('b', null, t('loadFailed')), h('div', null, summary.error))),
          h('div', null, h(Button, { onClick: () => summary.reload() }, t('retry'))))
      }
      const data = summary.data
      // The tank and the stat chips describe the free lane's health, so the
      // absorbed channels stay out of the tally — their cards carry their own
      // availability badge, and a lane that is never probed would otherwise
      // read as a permanently green slice of this gauge.
      const counts = data.catalog.filter(m => !m.channel).reduce((acc, m) => ({ ...acc, [m.availabilitySource === 'listing' ? 'unknown' : m.availability]: (acc[m.availabilitySource === 'listing' ? 'unknown' : m.availability] ?? 0) + 1 }), {})
      return h(Shell, {
        t: tagged, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin,
        busy, setBusy, apply, bench, benches, ctx: props.ctx,
      })
    }

    // ── the three-page shell ──────────────────────────────────────────────────
    // The settings section used to be one long scroll. It is now three pages
    // behind one glass navigation bar, because the three lanes answer three
    // different questions and mixing them pushed the model roster — the thing
    // people actually open this page for — below the fold:
    //   免费模型       the no-account lane (this plugin's own gateway),
    //   EAC 模型       the desktop co-paid lane behind GitHub auth,
    //   渠道接入   the thirteen enabled account channels and their logins.
    // The active page lives in localStorage so a reload — or the hot reload the
    // upgrader triggers — comes back to the page the user was reading.
    function Shell(props) {
      const { t, summary, ctx } = props
      return h('div', { className: 'ofm_root ofm_shell' },
        h('div', { className: 'ofm_aurora', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h(ChannelsPage, { t, ctx, summary }))
    }







    // ── announcement ──────────────────────────────────────────────────────────










    // ── registration ──────────────────────────────────────────────────────────
    // The shell mirrors the active language onto <html lang>, so a render-time
    // read survives a language switch without owning a subscription.
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    // ── 模型选择器合并：同一渠道只留「自动识图」那一条 ─────────────────────
    // 视觉路由（vision-router）会给每个 provider 复制一个 `<id>-vision` 孪生路由，
    // 名字是「<原名> + 自动识图」，两条路由的模型完全一样，选择器里就成了两份。
    // 两条路由同账号同模型、纯文本同价，故这里在展示层把原生组藏起来、把孪生组
    // 改回原名，用户只看到一条。纯展示：路由、会话、默认模型都不动。
    const PICKER_HIDDEN_PROVIDERS = new Set(['raccoon'])
    const PICKER_TWIN_OF = { raccoon: 'raccoon-vision' }
    const PICKER_TWIN_SUFFIX = ' + 自动识图'
    const PICKER_PROVIDER_LABELS = { 'raccoon-vision': 'Raccoon' }
    const pickerStateCache = new WeakMap()
    const pickerDirectoryCache = new WeakMap()

    /**
     * 投影一份选择器快照：藏掉原生组、孪生组去掉「+ 自动识图」后缀，
     * 并把指向被藏组的 current 改到孪生组上。
     * 同一个入参对象必须返回同一个出参对象（React 18 的 useSyncExternalStore
     * 要求快照引用稳定，否则会无限重渲染把选择器整块打掉）。
     */
    function projectPickerState(state) {
      if (state === null || typeof state !== 'object' || !Array.isArray(state.groups)) return state
      const cached = pickerStateCache.get(state)
      if (cached !== undefined) return cached
      let changed = false
      const groups = []
      // 只有「合并目标其实存在」时才隐藏原生组：否则（对端没装/没开 vision-router 时
      // 孪生组根本不存在）隐藏等于把整家公司从列表里抹掉。
      const twinPresent = new Set()
      for (const group of state.groups) {
        if (group === null || typeof group !== 'object' || typeof group.id !== 'string') continue
        if (!Array.isArray(group.models) || group.models.length === 0) continue
        twinPresent.add(group.id)
      }
      for (const group of state.groups) {
        if (group === null || typeof group !== 'object' || typeof group.id !== 'string') {
          groups.push(group)
          continue
        }
        if (PICKER_HIDDEN_PROVIDERS.has(group.id)) {
          const mergedInto = PICKER_TWIN_OF[group.id]
          if (mergedInto !== undefined && twinPresent.has(mergedInto)) {
            changed = true
            continue
          }
          groups.push(group)
          continue
        }
        const label = PICKER_PROVIDER_LABELS[group.id]
        const stripped = typeof group.name === 'string' && group.name.endsWith(PICKER_TWIN_SUFFIX)
          ? group.name.slice(0, -PICKER_TWIN_SUFFIX.length)
          : undefined
        if (label !== undefined || stripped !== undefined) {
          changed = true
          groups.push({ ...group, name: label !== undefined ? label : stripped })
          continue
        }
        groups.push(group)
      }
      let current = state.current
      if (current !== null && typeof current === 'object' && typeof current.provider === 'string' && PICKER_HIDDEN_PROVIDERS.has(current.provider)) {
        const twin = PICKER_TWIN_OF[current.provider]
        const twinGroup = twin === undefined ? undefined : state.groups.find((group) => group !== null && typeof group === 'object' && group.id === twin && Array.isArray(group.models) && group.models.some((model) => model !== null && typeof model === 'object' && model.id === current.model))
        if (twin !== undefined && twinGroup !== undefined) {
          current = { ...current, provider: twin }
          changed = true
        }
      }
      const projected = changed ? { ...state, groups, current } : state
      pickerStateCache.set(state, projected)
      return projected
    }

    function projectPickerSelection(selection) {
      if (selection === null || typeof selection !== 'object' || typeof selection.provider !== 'string') return selection
      if (!PICKER_HIDDEN_PROVIDERS.has(selection.provider)) return selection
      const twin = PICKER_TWIN_OF[selection.provider]
      return twin === undefined ? selection : { ...selection, provider: twin }
    }

    function projectPickerDirectory(directory) {
      if (directory === null || typeof directory !== 'object') return directory
      const cached = pickerDirectoryCache.get(directory)
      if (cached !== undefined) return cached
      // 原型链接到真实 directory 上：我们没有显式覆盖的成员仍然可用，
      // 不会因为少实现一个方法就把调用方打崩。
      const facade = Object.create(directory)
      facade.getSnapshot = () => projectPickerState(directory.getSnapshot())
      facade.subscribe = (listener) => directory.subscribe(listener)
      facade.load = () => Promise.resolve(directory.load()).then((state) => projectPickerState(state))
      facade.select = (selection) => directory.select(projectPickerSelection(selection))
      if (directory.store !== null && typeof directory.store === 'object') {
        const store = directory.store
        facade.store = {
          getSnapshot: () => projectPickerState(store.getSnapshot()),
          subscribe: (listener) => store.subscribe(listener),
          set: (value) => store.set(value),
          update: (updater) => store.update(updater),
        }
      }
      pickerDirectoryCache.set(directory, facade)
      return facade
    }

    function installProviderLayout(ctx) {
      ctx.inject(['modelDirectories'], (scope) => {
        const models = scope.modelDirectories
        if (models === null || typeof models !== 'object' || typeof models.directoryFor !== 'function') return
        if (models.__getItForFreePicker === true) return
        const original = models.directoryFor
        try {
          models.directoryFor = function directoryFor(sessionId) {
            return projectPickerDirectory(original.call(this, sessionId))
          }
          models.__getItForFreePicker = true
        } catch (error) {
          void error
          return
        }
        scope.effect?.(() => () => {
          try {
            models.directoryFor = original
            delete models.__getItForFreePicker
          } catch (error) {
            void error
          }
        })
      })
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'get-it-for-free: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-get-it-for-free')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'get-it-for-free: styles')

      installProviderLayout(ctx)

      // ── push subscription ───────────────────────────────────────────────────
      // One EventSource for the whole app surface: new announcements become
      // toasts (and OS notifications when opted in), urgent ones open a modal,
      // update availability and completed upgrades broadcast onto window so
      // whichever panel is mounted can refresh itself. EventSource reconnects
      // by itself; the hot reload closes every stream server-side, so a swap
      // simply shows up as a fresh `hello` a second later.
      ctx.effect(() => {
        if (typeof EventSource !== 'function') return
        let osEnabled = false
        let disposed = false
        let source
        let retryTimer
        // 重连轮次必须活在 open() 之外：open() 每次重连都会重入，计数器若在里面
        // 会被清零，退避就永远是第一档而不是 30s 翻倍到 5 分钟。
        let retries = 0
        api('/announcements').then(payload => { osEnabled = payload?.notifyOs === true }).catch(() => {})
        const open = () => {
          if (disposed) return
          source = new EventSource(`${API}/events`)
          // 断连保护：服务端不可达时 EventSource 默认无限自动重连（持续占连接池）。
          // 连续失败达到上限先关闭让出连接，但按退避（30s 翻倍、封顶 5 分钟）定时
          // 重新打开——永久关闭让公告/更新/升级推送在宿主重启或休眠后整体静默失效，
          // 只有刷新页面才能恢复；退避重连在恢复连接性的同时保住连接池。
          let errCount = 0
          source.onopen = () => { errCount = 0; retries = 0 }
          source.onerror = () => {
            errCount += 1
            if (errCount < 5) return
            try { source.close() } catch { /* 已关闭 */ }
            if (disposed || retryTimer !== undefined) return
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              open()
            }, Math.min(30_000 * 2 ** retries, 300_000))
            retries += 1
          }
          source.addEventListener('announcements', event => {
            errCount = 0
            let data
            try { data = JSON.parse(event.data) } catch { return }
            for (const item of data.items ?? []) {
              osNotify(t('toast.annTitle'), item.title)
              if (item.level === 'urgent') {
                showUrgentModal({
                  title: `${t('news.urgentTitle')} · ${item.title}`,
                  html: item.html ?? '',
                  confirmLabel: t('news.gotIt'),
                  onClose: () => { void post('/announcements/ack', { id: item.id }).catch(() => {}) },
                })
              } else {
                showToast({ title: t('toast.annTitle'), body: item.title, tone: item.level === 'warn' ? 'warn' : undefined })
              }
            }
            window.dispatchEvent(new CustomEvent('ofm:announcements', { detail: data }))
          })
          source.addEventListener('update', event => {
            let data
            try { data = JSON.parse(event.data) } catch { return }
            osNotify(t('toast.updateTitle'), t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''))
            showToast({
              title: t('toast.updateTitle'),
              body: t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''),
              tone: 'warn', holdMs: 14000,
            })
            window.dispatchEvent(new CustomEvent('ofm:update', { detail: data }))
          })
          source.addEventListener('upgraded', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:upgraded', { detail: data }))
          })
          source.addEventListener('hello', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:hello', { detail: data }))
          })
        }
        open()
        return () => {
          disposed = true
          if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
          try { source?.close() } catch { /* already closed */ }
        }
      }, 'get-it-for-free: push subscription')

      // A hot reload or in-app upgrade swaps this bundle while the page stays
      // open. The only durable marker across that swap is localStorage, so the
      // successor announces what happened exactly once.
      ctx.effect(() => {
        void (async () => {
          try {
            const meta = await api('/meta')
            const at = Number(meta?.reloadedAt ?? 0)
            if (at <= 0) return
            let seen = ''
            try { seen = window.localStorage?.getItem('ofm.reloadedAt') ?? '' } catch { /* storage unavailable */ }
            if (String(at) === seen) return
            try { window.localStorage?.setItem('ofm.reloadedAt', String(at)) } catch { /* ignore */ }
            showToast({
              title: meta.version !== '' ? `Get It For Free ${meta.version}` : 'Get It For Free',
              body: t('reload.done').replace('{n}', String(meta.reloadCount ?? 0)),
              actions: [{ label: t('reload.refresh'), onClick: () => { try { window.location.reload() } catch { /* top-level navigation refused */ } } }],
              holdMs: 12000,
            })
          } catch { /* backend absent */ }
        })()
        return () => {}
      }, 'get-it-for-free: reload notice')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'get-it-for-free',
        order: 35,
        label: () => 'Get It For Free',
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(ctx), ctx })))

    }
    /**
     * Owns the announcement's readiness.
     *
     * The onboarding coordinator mounts one ordered step at a time and waits for
     * the registrant to either show something or call `complete`. This renders
     * null until the ack state is known — a step that paints a skeleton then
     * removes it is worse than one that waits — and completes immediately when
     * the user already acknowledged the current copy version.
     */

    exports.apply = apply
    exports.inject = inject
    exports.name = 'get-it-for-free'
    // Headless test seams use the same stub React as scripts/client-lint.mjs.

    return module.exports
  },
})

// build: 2026-10-23T14:45 forward-refresh
