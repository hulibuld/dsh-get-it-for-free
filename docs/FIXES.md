# 已知问题与修复记录

本表只记录**能追溯到提交的修复**。

两点先说清，免得误读：

- **日期是修复提交的日期**，不是 bug 首次出现的时间。这个仓库没有开过 issue，早期版本也没有逐条登记问题，所以「出现时间」多数还原不出来，标「未记录」。填一个看着整齐的日期等于造假。
- **版本号是仓库版本**。npm 上的同名包在 3.0.9 之后停了一段时间，3.0.28 起恢复同步发布；在此之前的分发只走 GitHub。

按版本倒序。

| 修复版本 | 修复日期 | 现象 | 原因 | 修复方式 | 提交 |
| --- | --- | --- | --- | --- | --- |
| 3.4.4 | 2026-11-18 | 秒悟那张卡还留着「计划 free」「部署额度：静态 0/50 · 镜像 0/1」「账号 (1)」这些格子，跟别的渠道卡不是一套；插件里其实早就有「把全部渠道用一个 key 再暴露一次」的中继（`/chan-gateway`），但设置页上找不到入口，等于用不了 | ①秒悟卡是手写的旧骨架，格子按平台字段铺，不是按渠道卡的「账号 / 模型 / 余额」三格铺；折叠里还藏着一个账号列表，和一个没有下文的部署额度 ②`chan-relay` 的后端路由（`GET /chan-gateway`、`POST /chan-gateway/apply`、`GET /chan-gateway/key`、`POST /chan-gateway/rotate`）从 3.0.27 起就在，`client.js` 里却一行都没引用它 —— 有后端没前端，key 只能靠 curl 拿 | ①`MeooCard` 重排成与 `CliLaneCard`/`ChannelCard` 同形：head + 「在选择器里投放」开关 + `账号 1/1 · 模型 n/n · 剩余积分` 三格 + 一排按钮，账号行改为内联 `MeooAccountRow`，删掉部署额度那行与整个折叠 ②新增 `ChanRelayCard`（`client.js:4817`，渲染在 `GatewayCard` 之后）：开关走 `POST /chan-gateway/apply {enabled}`、地址显示 `http://host:port/v1`、key 支持生成/换一把（`POST /chan-gateway/rotate`）、显示/隐藏/复制（`GET /chan-gateway/key`，惰读）、上游端口与中继错误同卡展示 | 未提交 |
| 3.4.3 | 2026-11-18 | 千问办公那张卡跟其它渠道卡还不是一个形态：模型只有一串名字、不能单独关掉、没有降智测试和账号测试，而且关掉的模型下次启动又全回来了 | 后端只给了 `modelNames`（纯字符串，没有 id、没有开关状态），模型开关没有任何落盘位置；降智测试与账号测试两条路由当时只有豆包有，千问办公缺 `degrade`/`test` | `src/qwenwork/provider.js`：`status()` 增加 `modelList: [{id,name,disabled,dead:false}]`（`modelNames` 保留给旧调用）；新增 `<resolveDshHome>/get-it-for-free/qwenwork.json`（`{disabledModels:[...]}`，懒读、写时 `mkdir -p` + `0o600`）；新增 `setModelDisabled()` / `setAllModelsDisabled()`（改文件后 `onTopology()` 重播选择器）、`degrade()`（经 shim 发一次无工具请求，`DEGRADE_PROMPT` 让模型用 ASCII 左右并排画「测试」，150 秒超时，回 `{ok,modelId,nickname,text,firstMs,totalMs}`）、`test()`（回 `{ok,ms,message}`），`listModels` 与 `resolveModel` 都过滤 `disabledModels`；`index.js` 补 `POST /qwenwork/models/toggle`、`POST /qwenwork/degrade`、`POST /qwenwork/test` 三条路由与 bridge 兜底 | 未提交 |
| 3.4.2 | 2026-11-18 | 千问办公卡报 `creds.expiresAt.getTime is not a function`，账号一格永远 0/1；秒悟「添加账号」点了没开浏览器；秒悟卡上那个「装秒悟技能」按钮不要；秒悟要拆成普通与 CLI 两张卡（照 CodeBuddy 的普通/CLI 那样） | ①`src/qwenwork/credentials.js` 的 `isTokenExpired` 直接对 `creds.expiresAt` 调 `.getTime()`，而 expiresAt 可能是 ISO 字符串或毫秒数（旧版本写盘 / 上游接口），一撞上就整条凭据链路抛错 ②`src/meoo/index.js` 的 `login()` 只回一句「在终端跑 meoo login」，插件从来没真跑过它 ③按钮是自己加的，用户不要 ④额度积分（平台账本）和 CLI 本体（装没装/版本/登录态）是两件事，混在一张卡里会出现「账号 1/1」和「未装 CLI」同时成立 | ①改用同文件已有的 `parseDate()` 归一化再比时间，解析不出来就当无过期信息 ②`login()` 真去 spawn `meoo login`（CLI 自己开浏览器、自己起本地回调端口，插件不插手；同一时刻只跑一份），前端点完不再让用户手动回来点刷新，自己每 2 秒查一次 `/meoo/status` 直到登录成功（最多 90 秒）③删掉按钮和整段 `installSkill` 回调 ④新增 `MeooCliCard`（`meoo-cli`），卡片 id 独立、可单独隐藏；后端补 `upgrade()` 与 `POST /meoo/upgrade`（只调官方 `meoo upgrade`） | 未提交 |
| 3.4.1 | 2026-11-18 | 设置页整页报「无法连接插件后端 / not found」，重试也没用；插件等于没装 | `index.js` apply 顶层误用 `scoped.effect(...)`（那个名字只在 `ctx.inject(..., scoped => ...)` 的闭包里存在）。apply 一开头就抛 ReferenceError，`ctx.inject(['webServer'], ...)` 那段根本没跑到，`/api/get-it-for-free` 一条路由都没注册 —— 前端所有 api 调用全是 404，页面只剩这一句 | 改成 `ctx.effect(...)` 并就地写清「这里在 apply 顶层、不在 inject 闭包里」；`scripts/selftest.mjs` 加第 2b 步「apply() 试跑」（Proxy 当 ctx，不抛才算过），这类「语法绿但挂不上」的缺陷以后自检会挡住 | 未提交 |
| 3.4.0 | 2026-11-18 | 千问办公那张卡跟别的渠道卡长得不一样，还挤在最上面；秒悟（meoo）的积分与部署额度只能在终端敲命令看；豆包面板显示已接入但右下角选择器里没有豆包 | 千问办公卡是手写的旧样式、只有三个按钮；秒悟的额度真源只在官方 CLI（oauth 的 401 刷新归它管，插件自己刷会把 refreshToken 用废）；豆包 `listModels` 在没账号时直接返回空数组，宿主会把空模型组整个丢掉 | 千问办公卡改成和渠道卡同形（账号/模型/余额三格 + 添加账号/续期/刷新余额/刷新模型/一键领取）并挪到卡片区最后；新增 `src/meoo/index.js` 与 `/meoo/status`、`/meoo/skill/install`、`/meoo/login` 三条路由，配一张秒悟卡（计划/积分/部署额度/一键装 meoo-cli 技能）；豆包 `listModels` 去掉账号门槛、`modelsSnapshot` 不再因无启用账号返回空 | 未提交 |
| 3.3.0 | 2026-11-16 | 选择器里出现过一批不需要任何账号就能用的模型（`*-free` 与 `kilo-auto/free` 等），还多出一行「免费池 · 自动」；用户要求「只做登录账号后的渠道模型提供」 | 插件同时提供了三条免登录车道：本插件自己的匿名清单（`fetchListing()` 直接打上游 `/inference/v1/models`，`FALLBACK_CATALOG` 里还硬编码了 8 个 `*-free`）、Kilo 网关（`KILO_BASE`，零凭据）、以及 3.2.0 新增的免费池（只由前两条构成）。这三条都不需要登录，讲不清账号归属，也不属于「账号 → 模型」这条产品线 | 整条移除：`src/freepool.js`、`src/kilo.js`、`scripts/freepool-test.mjs` 删除；`src/core/runtime.js` 不再有 `freeCatalog`/`kiloCatalog`/`materializeCatalog`/`fetchListing`/`refreshKiloRoster`/`poolStatus`，`rebuildCatalog()` 只合并 `sealedCatalog`（EAC）与 `aggregateCatalog`（用户自己的 key）；`src/adapter.js` 去掉 pool 分支、Kilo 出网分支与 `trustedOutcome` 里那段 Kilo 计量修正；`src/catalog.js` 截掉整段 Kilo 频道代码；`index.js` 删 `deps.freePool`、三条 `/free-pool` 路由、`fetchListing` 解构与 `measureGatewayLatency()`（它测的就是匿名清单，且 `gatewayLatency` 从未被赋值）；`client.js` 删 `PoolCard` 与 `fpool.*`；settings 的 `freePool`/`freeChannelsEnabled`/`hideAllModels`/`hideFreeModels` 四个键列入 `RETIRED_SETTINGS`，启动时 `migrateSettings()` 清掉；`combos` 默认值改成 `[]`（原来预置的 `combo:recommended-free` 点的全是免费 id）。文案同步改口径：`meta.description`、`ann.pitch`、`ann.p1` 不再说「无需登录/免密」 | 3.3.0 提交 |
| 3.1.1 | 2026-11-16 | 豆包的模型终于进了选择器，但思考强度菜单整条不见了；华为云账号库里只要有一行字段不全，登录写回就把它连同别的行一起静默抹掉 | ① `rememberRoster()` 落盘只挑了 id / name 等少数字段，`reasoning` 与 `isTaskMode` 在选择器需要它们之前就蒸发了；② `readAccounts()` 把形状不对的行直接过滤，一条日志都不留 | roster 保留 `reasoning`（数组，上限 8 档）与 `isTaskMode`（`=== true`），注释写明这是选择器元数据；`readAccounts()` 回 `skipped` 计数，`saveAccount()` 与 `remove()` 两条写回路径各 warn 一次残行数量（删不存在的号不误报） | 3.1.1 提交 |
| 3.1.0 | 2026-11-16 | 「豆包工作」卡上写着 12 个模型、能测速，右下角选择器里一个都没有；渠道包的车道（CodeBuddy / WorkBuddy、Qoder、CodeArts）只能手工去它自己的 state.json 里塞凭据；走 `postStreamed` / `eac` / `cli-lane` 的请求偶发 `400 code=11128` | ① `ctx.llm.registerAdapter` 挂载时只问一次 `listModels`，而豆包的 `models()` 每次都走网络，超时或空表就被当成这组不存在，账号或模型变化后也不广播 `llm/adapters-updated`；② 渠道包只认它自己那份账号池；③ 上游对「`@` 前缀路径」与「相对路径解析」两句做了指纹校验，`src/http.js` 的改写表少了这两条 | 豆包目录落盘（`roster` / `rosterAt`，`modelsSnapshot()` 只读本地永不联网，`needsRoster()` 判空，适配器空表才后台补拉并 `setTimeout(warm, 2000)`），`createDoubao({onChange})` 一变就 `emitTopology()`；新增 `src/workbuddy/*`、`src/qoder/*`、`src/codearts/*` 与 `src/pack-inject.js`，把三家凭据按 `<provider>-<sha256 前 8 位>` 同时写进凭据服务与账号池（Qoder 的 `machine_id` 由 PAT 派生、CodeArts 令牌 `refreshable:false` 由插件自己续签）；`TRACE_PHRASE_REWRITES` 补两条对齐 `pack.js:36004` | 3.1.0 提交 |
| 3.0.43 | 2026-11-15 | 豆包的 12 个模型在设置卡里能看到、能测速，但右下角模型选择器里一个都没有；华为云渠道一开 bili 就整轮卡死或 502 | ① 豆包只做了「渠道卡」那一半，模型从没注册给宿主的 LLM 层（`ctx.llm.registerAdapter`）；② CodeArts 的签名盖住请求体，bili 只有「重签后压缩」和「拒转发」两条路，而它的重签实现把 path 补成以 `/` 结尾、还给部分模型加 `maas_type: benefit`，两件上游都不接受，所以递了凭据反而更糟 | 新增 `src/doubao/adapter.js`（无状态适配器：transcript 拍平成一段话发出去、上游三行帧翻成 OpenAI chunk 交给 `readStream`、`pickAccount()` 轮询多账号），`src/doubao/index.js` 加 `models()` / `pickAccount()` 并在 `apply()` 里注册；新增 `src/bili-config.js` + `GET /bili/status` / `POST /bili/passthrough`，卡上给一个开关把华为云链路设成原样放行（bili 照常记录、不压缩），写配置前先备份、只动 `resign.sdk-hmac-sha256` 一个键 | 3.0.43 提交 |
| 3.0.42 | 2026-11-15 | 会话开工就卡十几分钟没有任何输出，接着报「渠道网络请求失败（直连；UND_ERR_CONNECT_TIMEOUT）」，CodeArts 那边还会夹一条「上游网关暂时不可用（HTTP 502）」 | 两处都是 3.0.38 埋的：① 出网口默认改走 `globalThis.fetch` 后，billion-context 每次都打 `[bili-native] third-party globalThis.fetch install detected (#1158) — re-chaining as downstream (install 8)` 再重挂一次链，链一多连接就烂掉；② 把 CodeArts 的 `credentialRef` 镜像进 `~/.dsh/jet-hub/state.json` 以后，bili 对每个 CodeArts 请求改走自己的重签（日志 `[resign] re-sign arm active (sdk-hmac-sha256)`），重签出来的请求被华为云回 502，比原来「原样放行」更糟 | 出网口改回默认走打包的 undici，要实验再显式 `GET_IT_FOR_FREE_HOST_FETCH=1`；撤回 jet-hub 里的 codearts 条目，签名中转改为手动点「同步」才写（建空文件 `~/.dsh/get-it-for-free/resign-auto` 才恢复自动），等 bili 的重签被证明兼容再打开 | 3.0.42 提交 |
| 3.0.41 | 2026-11-15 | 豆包工作的卡片上「剩余积分」显示「—」，账号行写着「未返回余额数据」，顶部还提示「1 个账号未能查询余额」 | 卡片读的是 `credits.balances` 回包里的 `row.balance.total`，而给豆包做的那层 RPC 适配把 `total` 放在行顶层、没包 `balance` 这一层，于是每个账号都被当成「没有余额数据」；余额本身是好的（同一份 cookie 直接打上游返回 300 总额、剩 187） | 适配层按其它渠道的形状回 `{accountId, nickname, balance:{total,packages}, error?}`；个别账号缺余额时只补刷那个账号的 `part:'quota'`，不再整体重拉 | 3.0.41 提交 |
| 3.0.40 | 2026-11-15 | 走 CodeArts 的 `glm-5.3-flash` 一直「华为云网关暂时找不到这个接口（InferHub.APIG.0101.404）」，刷新模型也不管用；`deepseek-v4.1-flash` 回 `InferHub.001001005.400 The request param is invalid` | 两条错误都是 `maas_type: benefit` 这个请求头造成的：带它 → 0101「接口未发布」或 001001005「参数非法」；摘掉 → 同一请求 200 正常出流。与模型是否发布、`max_tokens` 是否过大、`prompt_cache_key`/`include`/`tool_stream` 这些扩展字段都无关（两个账号、裸体/65536/全扩展/带 tools 逐一对照实测） | 福利头默认仍不带（`GET_IT_FOR_FREE_CODEARTS_BENEFIT_HEADER=1` 才带），并在代码里写明这次实测结论，防止再被改回默认带；参数非法时按三级退让重发（去 `tool_stream` → 去整套方言字段 → 上限压 8192），每级都落 `phase: sse-param-N` 便于下次定位 | 3.0.40 提交 |
| 3.0.38 | 2026-11-15 | 走本插件渠道的会话，宿主侧插件（billion-context）看不到模型请求：`acp_status` 返回 `404 unknown plugin conversation`，日志里本会话 id 一行都没有 | `vendor/channel-pack/pack.js` 的出网口固定调用打包进来的 `undici.fetch`，不经过 `globalThis.fetch`，任何依赖全局 fetch 包装的宿主插件都拦不到 | 出网口改走 `globalThis.fetch`（调用方自带 `dispatcher` 时仍用自带 undici，避免打断出口代理）；**该默认值已在 3.0.42 撤回**（见上：重挂链导致卡死与 `UND_ERR_CONNECT_TIMEOUT`），现在要显式 `GET_IT_FOR_FREE_HOST_FETCH=1` 才生效 | 3.0.38 提交 |
| 3.0.28 | 2026-11-12 | 上游上了新模型，面板只说「这个渠道有几个模型」，看不出这一轮到底多了什么、少了什么、是谁的 | 每天 12:00 那一轮只清进程内缓存，不主动拉、也不跟上一份目录比对，用户手里没有任何可看的证据 | 新增模型同步引擎 `src/model-sync.js`：清缓存 → 逐渠道主动拉目录 → 与上一份快照 diff → 落盘 `~/.dsh/get-it-for-free/model-sync.json`，保留 40 条历史；单渠道硬超时 25 秒、空目录不覆盖旧快照；设置页新增「模型同步」卡片；12:00 定时器改走同一引擎，不新增第二个入口 | 3.0.28 提交 |
| 3.0.27 | 2026-11-12 | 设置页翻遍也不显示 API Key，拿不到能填进别的工具的 key | `gateway.getEnabled` 回传的 key 取自正在运行的网关实例（`gatewayApiKey()` = `running?.apiKey ?? lastApiKey`），而网关从没启用过，两者都是 null | 改成按需读盘：没有活实例就调 `loadOrCreateApiKey()` 当场造一把（首次生成 43 位、权限 0600），地址在关闭状态下也回显将来要监听的 `127.0.0.1:8326`；另加「复制 base_url + Key」一键带走 | 3.0.27 提交 |
| 3.0.26 | 2026-11-12 | 重启后设置页一片空白，控制台报 `transport failure for /api/channel-pack: HTTP 404`，选择器里只剩 CodeBuddy CLI 一组 | 把 channel-pack 内部的 `handleMethod` 加进模块导出表，而它并不是模块顶层函数（`SyntaxError: Export 'handleMethod' is not defined in module`），整包加载失败，所有渠道适配器消失；宿主侧还新增了一条直调它的 `/gateway` 路由 | pack 导出表恢复原样、宿主路由整段回退；网关卡改走客户端已有的 `rpc()` 三级回落（`/rpc` 桥 → 浏览器 connection → `/api/channel-pack`）；同时补上 `gateway.regenerateKey`、`gateway.selfTest` 与 CodeArts 倍率标签（读 `credit[].ratio_display`，写进模型显示名） | 3.0.26 提交 |
| 3.0.24 | 2026-11-10 | 上游上了新模型（如 Qoder 的 qoduck）面板里看不到，只能等每天 12:00 那一轮 | 界面没有任何触发 model.refresh 的入口，且适配器把远端目录缓存在进程内 | 每个渠道卡片新增「刷新模型」按钮，打开设置页时按渠道 30 分钟节流自动探访；benefit 头改为反向探测（遇「模型未注册」自动补头重试一次） | 756814e |
| 3.0.23 | 2026-11-10 | 会话每轮失败「codearts: 华为云网关暂时找不到这个接口（InferHub.APIG.0101.404）」，错误码 `RATE_LIMIT` | `maas_type: benefit` 这个请求头把请求路由到一条未发布的福利接口；不带该头的同一请求立刻 200 | 默认不带 benefit 头（`GET_IT_FOR_FREE_CODEARTS_BENEFIT_HEADER=1` 可显式打开），流内与 HTTP 0101 均先摘头重发而不是换号 | 32996e1 |
| 3.0.22 | 2026-11-10 | 会话里反复出现「本轮运行失败 codearts: The API does not exist or has not been published in the environment」（`INVALID_REQUEST`） | 华为云网关的路由层错误 `APIG.0101` 被当成「请求写错」；流内错误分支还不写日志、拿不到 `request_id` | 流内错误先落盘再分类，`APIG.0101` 归瞬时故障（先换号、再按可重试抛出），非 200 的 404 同路径；同时补 CodeArts 图片输入链路（默认纯文本、白名单开启）、`max_tokens` 环境变量覆盖、每日缓存命中率 | f8f2736 |
| 3.0.21 | 2026-11-09 | 商汤（Raccoon）渠道签不到；网页版每天能领 300 积分 | 每日积分在「账号当天第一次以网页客户端身份访问办公接口」时落库，插件只调积分接口，服务端不认 | 模仿网页端请求头打四条只读办公接口，再按账单确认到账；一键领取与自动签到都走这条 | dddbea5 |
| 3.0.20 | 2026-11-08 | CodeArts 一打开设置页，两个账号都报「账户信息查询失败：HTTP 400 APIG.0602 the security token has expired」 | 余额、签到状态、一键领取三条读接口直接拿存储凭据出网，和启动时的 30 分钟续期任务抢跑；「续期」按钮按有效期判断，令牌还剩一小时时点了不生效 | 发请求前按需续期，撞上过期强制续期并重发一次；续期按钮改为强制换令牌；推理链路补过期分支 | dddbea5 |
| 3.0.17 | 2026-11-04 | CLI 通道偶发 900 秒无返回 | 默认思考档位过高，等待被拖死 | 默认思考档位压到 low | 53ff53ae |
| 3.0.16 | 2026-11-03 | 各渠道带出身份痕迹；CodeArts 报 rpc-failed；同一账号被重复计入 | 未记录 | 清身份痕迹；rpc-failed 与重复账号分别修正 | eb8e5d23 |
| 3.0.11 | 2026-11-03 | MiMo 桌面端登录识别不到，模型目录读错来源 | 未记录 | 模型目录改读桌面端文件 | fcea7eb5 |
| 3.0.9 | 2026-11-01 | 积分领取链路存在四个缺陷 | 未记录（提交未逐条说明） | 四处分别修正 | 1d56f2cb |
| 3.0.7 | 2026-10-31 | 11128 触发段整句表述有问题；代码里留有误导性的零宽注释 | 上游对零宽字符已识破（见 2.5.6） | 整句换成中性说法，删掉误导注释 | 51ca1190 |
| 3.0.4 | 2026-10-30 | Qoder 业务码 112 被当成未知错误，界面直接显示 JSON | 把「额度受限」当成了异常 | 归入额度受限并换号，JSON 错误转成人话 | 3516f8b3 |
| 3.0.2 | 2026-10-30 | CLI 通道卡死时无法判断原因；商汤 429 后不换号 | 未记录 | 卡死可诊断可换号、按用量选号、429 换号 | 8bd169b4 |
| 2.5.7 | 2026-10-29 | CodeArts 每天要手动签到，失败了看不出原因 | 没有调度器，失败原因被吞掉 | 每日自动签到调度器 + 失败原因可见 + checkinState 只读 RPC | 222f2844 |
| 2.5.6 | 2026-10-29 | DeepSeek 通道被上游识别；CLI 思考过程不显示；首字节长时间无响应 | 指纹里的零宽字符已被上游识破 | 整段替换指纹；探活改自家适配器；思考过程边想边显示；首字节三分钟看门狗 | 0d1f63c6 |
| 2.5.2 | 2026-10-27 | CLI 通道大上下文被截断；模型名里带账号；腾讯 HTTP 风控拦截 | 未记录 | 修截断、接思考强度、模型名去账号、绕开腾讯风控指纹 | 86e8d014 |
| 2.0.2 | 2026-10-24 | 免费模型通道默认开启，容易误用 | 未记录 | 默认关闭；清理无用组件；选择器合并仅在孪生存在时生效 | b8c817a1 |

## 不在这张表里的提交

截至 3.0.19 的提交里，另外 9 条是功能或杂务，不进修复表：2.1.1 移除上游来源说明并统一署名、2.1.3 界面更紧凑并移除已不可用渠道、2.2.0 接入 MiMo 桌面端额度、2.3.0 首启风险告知与 CodeBuddy CLI 通道、2.4.0 CodeBuddy CLI 支持多个腾讯账号、3.0.3 CodeArts 今日已领徽章与 Gemini 渠道卡、3.0.5 五个渠道显示今日已领、3.0.6 自动签到覆盖七个渠道、3.0.8 每个模型加降智测试。

3.0.26 之后的提交里，另有两条是功能：本机 OpenAI 兼容网关的界面（设置页里的「本机 API 网关」卡片）与模型同步卡片；它们进 README 的「能做什么」，不进修复表。

## 以后怎么加一行

修完一次就加一行，别攒着——攒三个月再回忆，原因那一列就只能写「未记录」了。

1. 修复版本：改了 `package.json` 的 version 就算一个新行。
2. 修复日期：提交日期。
3. 现象：用户看到的是什么，不写技术描述。「卡死 900 秒」比「超时配置不当」有用。
4. 原因：能说清才写。说不清就写「未记录」，这是诚实，不是缺陷。
5. 修复方式：一句话说清动了什么。
6. 提交：短 SHA，方便回头查。

## 3.4.5

- 秒悟卡：`/meoo/enabled`、`/meoo/cli/enabled` 调用了不存在的 `readJsonBody` → 500，开关点了没反应（`index.js` 改成 `readJson`）。
- 秒悟两张卡：补「刷新模型」「一键领取」两枚按钮，并把投放开关的说明改成真话 —— 秒悟是部署平台，没有可投放的模型，选择器里不会出现它。
- 千问办公：`CHANNEL_CREDITS.qwenwork` 打开 claim，新增 `provider.claim()` / `POST /qwenwork/claim` / `credits.claimAll` 分支；上游没有签到接口时回一行原因，不弹 500。**该入口已在 3.5.0 撤回**（见上表：上游本来就没有签到接口，留着只是一个永远失败的按钮）。

## 3.5.0

- 千问办公：一轮对话只要历史里有一条 `tool_calls[*].function.arguments` 不是合法 JSON（同一次调用被挤成两段），后面每轮都报 `HTTP 400: Failed to convert request`，而且只在 `qwen4-max` 一类模型上炸。改成降级而不是丢弃：括号配平取第一个合法 JSON 值当 arguments，余下片段以 `[tool: … ← 未合并进 arguments 的参数片段：…]` 并回 assistant 的 content，`tools` schema 一个字段不动，每次降级落 `trace('convert-degrade', …)`（`src/qwenwork/chat-shim.js` 的 `sanitizeToolCalls` / `normalizeToolArguments` / `firstJsonValue`）。附带说清一件事：上游的 400 是 **HTTP 200 + SSE 首帧里内嵌错误体**，探针只看 `response.status` 会误报成功。
- 千问办公：右下角没有思考强度菜单。原因是 provider 自己的模型描述符里没声明档位（`models.js` 那句 `reasoning: false` 是给上游 `model_config` 用的，不是给选择器的）。现在 `resolveModel` / `listModels` 都返回 `reasoning: { efforts: ['low','medium','high'], defaultEffort: 'medium' }`，档位在 `buildBody` 与 shim 的 `resolveOutputCeiling()` 里收敛成 `parameters.max_tokens`（4096 / 8192 / 32000，宿主给的 `max_tokens` 只能往下压，下限 1024，不选档位就沿用整窗 32000）。上游对 `reasoning_effort` / `enable_thinking` 一律无视，这是它唯一真生效的控制量。
- 千问办公：签到按钮撤掉（`provider.claim()`、`POST /qwenwork/claim`、`credits.claimAll` 三处），上游没有这个接口，额度按自然月发放。
- 新增「秒悟 · 网页版」渠道（provider id `meoo-web`）：仿冒 meoo 网页端自己的 agent 管线（`GET /api/v1/agent/models`、`POST /api/v1/agent/chat` 的 SSE、`GET /api/v1/project/list`），把它的 `ui_event` 流翻成 OpenAI chunk。凭据三级解析：插件状态 → `~/.meoo/credentials.json` 的 accessToken → 卡片里贴的 Cookie/Bearer；失效时抛 `NEED_LOGIN` 直接报，不静默重试。登录态探针打 `/api/v1/project/list`（模型目录是公开的，不带头也 200，拿它当探针会假绿）。
- 渠道网关的 API Key 早就在 `/chan-gateway/key` 与 `/chan-gateway/rotate` 上，设置页一直没有入口；3.4.4 补的 `ChanRelayCard` 承担了这部分（生成 / 换一把 / 显示 / 复制 / 开关）。
- 华为云（CodeArts）× billion-context：出网口从「全局开关」改成「按域名挑」。华为云的请求是签名盖住请求体的，bili 对它只能重签或原样放行，所以这条链路现在走宿主 `globalThis.fetch`（bili 才看得见），配合启动时幂等写入的 `resign.sdk-hmac-sha256.passthrough = true`，bili 只记账、不动手；其余渠道继续走打包的 undici。`GET_IT_FOR_FREE_HOST_FETCH=1` 回到「全部走宿主 fetch」的实验态，`=0` 回到 3.0.42 的全 undici。
- 精简：删掉 `src/qwenwork/stall-detector.js`（295 行，无任何引用）、`/meoo/skill/install` 路由与 `installSkill()` 全链（按钮 3.4.2 已删，后端留着等于一条必然失败的接口）。
