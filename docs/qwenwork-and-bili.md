# 千问办公接入 / 豆包选择器 / 华为云 × bili（2026-11-17 夜）

## 1. 豆包不进右下角模型选择器 —— 已修

根因两条，缺一条都不显示：

- 适配器缺 `stream`。宿主 `LlmAdapter` 的基类里只有 `stream` 是 abstract，其它都有默认实现；我们原来只把 `stream` 藏在 `prepareCall` 的回包里，宿主有路径直接 `adapter.stream(...)`，于是 TypeError 被 `registerAdapter` 外面的 try/catch 吞掉，面板照旧显示「1/1 账号、12 模型」，选择器里却没有这一组。
- 目录变了不广播。`llm/adapters-updated` 只在 `LlmRuntime.commitRoutes()` 里发，对外只有 `registerAdapter()` 与 `RegistrationHandle.replace()` 能触发。豆包 `notify()` 只调 `onChange`，宿主不知道目录更新了。

改动：

- `src/doubao/adapter.js:383` 补 `stream(options)`；`:155` 多收 `onRoster`；`:181-207` 拉完目录后回调 `onRoster()`。
- `index.js:1340-1367` 用 `reannounceDoubao()`（3 秒节流）调 `doubaoRegistration.replace([DOUBAO_PROVIDER])` 重播；`onChange` 里同时 `emitTopology()`。

验证：`/tmp/test-doubao-catalog.mjs` 照抄宿主校验跑真数据 → `providerName="豆包工作"`, `modelCount=9`, `groupVisible=true`, `problems=[]`。

## 2. 千问办公（QwenWork）渠道 —— 新增

上游 `dsh-qwenwork-connect@0.3.2` 是独立 DSH 插件，`lib/index.js` import 了 `@deepseek-ai/dsh-llm` 等宿主包。本插件目录不在 profile 的 `node_modules` 里，解析不到那些包 → 不能整包 vendor 它的 index。

做法（跟 MiMo 同构）：

1. vendor `lib/*.js` 到 `src/qwenwork/`，去掉 `index.js` / `client.js` / `login-route.js` / `logout-route.js`；**另外补拷 `web-status.js`**（`chat-shim.js` 直接 import 它，漏了就 `ERR_MODULE_NOT_FOUND`）。除 index 外全部只 import node 内置。
2. `src/qwenwork/provider.js`：`startChatShim()` 起本地 OpenAI 兼容服务（内部做 COSY 签名 + 上游 SSE 转 chunk），我们写 structural adapter 指过去，复用 `createChannel` / `readSse` / `readStream` / `toChatMessages` / `toToolDefs`。工具必须透传，否则模型自己编一段自由文本冒充调用。
3. 凭据：上游那条是 **Windows 专属**——`credentials.js` 只认 `%APPDATA%\QwenWorkCN`，`dpapi.js` 直接 `process.platform === 'win32'` 才过，Mac 上整条渠道是死的。补 `src/qwenwork/local-credentials.js`：优先读 device flow 落盘的 `~/.dsh/qwenwork-desktop.json`（过期用 refresh_token 换一次并回写，`mode 0o600`），拿不到再退回上游那条 Windows 路径。账号名本地解 JWT，不为一个名字打网络。
4. 接线：`index.js:530` 注册适配器 + `registerConfigurableProviders`（`settingsNs: 'qwenwork'`），异常只 warn 不带崩整个插件；`:1458` deps 加 `qwenwork`；`:2483` 四条路由 `GET /qwenwork/status`、`POST /qwenwork/login|logout|reload`，全部走 `deps.qwenwork.*`。
5. 卡片：`client.js:4803 QwenWorkCard`，结构照 MiMo 的 `ofm_chan / ofm_glass / ofm_chanhead / ofm_chanmeta / ofm_chanacts / ofm_btn ghost`，风格与其它渠道一致。未登录只有「登录」→ 拿 device flow 地址 `window.open`，之后 3 秒轮询状态直到亮起。

未登录时一条模型都不投放，选择器里看不到这一组，不影响别的渠道（跟 MiMo、CLI 车道一个规矩）。

## 3. 华为云 × bili —— 结论与取舍

bili 的契约：签过名的请求要么「重签后压缩」，要么「字节原样放行（passthrough）」。CodeArts 走 SDK-HMAC-SHA256，签名盖住 body。

- 重签这条路实测必挂：bili 的 resigner 会把 path 补成以 `/` 结尾、并对部分模型加 `maas_type: benefit` 头，前者签名对不上，后者直接 404。
- 查过 bili 0.1.216 的 dist：`/__bili/plugin/compact` 只是「压缩边界」信号（发 conversationId），不是压缩服务；`resign*` 一堆内部函数里没有「压缩完交回调用方签名」的钩子。也就是说 bili 不提供先压缩再由我们签的接口。

所以现在的组合是：`~/.config/billion-context/billion-context.json` 里 `resign.sdk-hmac-sha256.passthrough = true`（`src/bili-config.js` 受控写这个键，写前备份），华为云这条链路字节原样过 bili，不压缩、不重签，稳定可用。

真正让华为云吃到压缩的做法在我们这一侧：所有 pack 渠道的请求体在出门前都会过 `src/adapter.js:405 applyTokenSavers(payload, wire, saverConfig(settings))`，token-saver 一套（rtk 过滤器 + caveman/ponytail 档位）对 CodeArts 一样生效。也就是说：**bili 那层省不了，插件这层照省**。要更狠就调 token-saver 档位，不要去动 bili 的签名。

## 4. 代码精简

删掉千问办公里没人引用的四个文件（371 行）：`src/qwenwork/auth-api.js`、`signer-shim.js`、`stall-guard.js`、`api.js`。删后 `node --check` + 动态 import + `node scripts/selftest.mjs` 全过。

## 5. 待用户做的两件事

1. 完全退出 DeepSeek Harness 再打开（路由与适配器在 Host 进程里，刷新页面换不掉）。
2. 千问办公卡片点「登录」，在浏览器里完成 device flow 授权；授权完整条渠道自己亮。
