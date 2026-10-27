# dsh-get-it-for-free

把**免费 / 签到型**大模型账号渠道接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）：
在设置里登录账号、每日签到、同步可用模型池，模型以普通 provider 的形式出现在模型选择器里。

纯本地运行：没有遥测、没有自更新、不向上游仓库发任何请求。账号凭据只写在本机
`~/.dsh/get-it-for-free/` 目录里。

## 首次使用会看到什么

第一次打开设置页，会先弹一个全屏告知：标题「贪生怕死勿入斯门」，正中间一颗血红色按钮
「删除该插件并退出」，正文是三段不客气的话。这颗按钮**真的会卸载本插件**——它会从你的
profile 里删掉依赖和 bundle 条目、删掉插件目录，然后退出 DSH；账号与历史数据留在
`~/.dsh/get-it-for-free/` 不删。右下角那行几乎看不见的小字「无视风险继续使用。」才是继续。

写这个弹窗不是为了拦人，是因为用第三方客户端反代官方额度这件事，官方明确不允许。愿意
承担风险的人自然会点右边；不愿意的，请点红色那个。

## 支持的渠道

| 渠道 | 登录方式 | 备注 |
| --- | --- | --- |
| 华为云 CodeArts | 浏览器授权 / AK-SK | 积分制，按账号发现可用模型 |
| 腾讯 CodeBuddy / WorkBuddy | 浏览器授权 | 免费档模型，含每日签到 |
| Qoder（国际 / 国内） | 浏览器授权 | — |
| TRAE | 设备码 / 浏览器授权 | 含签到 |
| Raccoon | 浏览器授权 | — |
| LobsterAI | 浏览器授权 | — |
| MiniMax | 浏览器授权 | — |
| ZCode | 浏览器授权 | — |
| Loomy（讯飞） | 微信扫码 | 模型带倍率；临时 / 永久两套积分池，通道只消耗临时池 |
| MiMo（小米） | 桌面端已登录即可 | 复用桌面端 cookie，无需添加账号；额度按天重置 |

## 功能

- **账号看板**：一页管理各渠道账号（登录 / 刷新 / 退出 / 启停），登录态保存在本机。
- **每日签到**：渠道支持签到时可直接签到，也可开启每日自动签到；「已接入」「今日已自动签到」用绿点标示。
- **模型池**：定时探测每个账号当前可用的模型，按可用 / 区域受限两档注册为 provider。
- **每日自动刷新渠道模型**：每天本地时间 **12:00** 强制各渠道重新拉取一次远端模型目录（各渠道平时把目录缓存在进程里，一个进程只拉一次，所以上游上了新模型——比如 Qoder 新出的 Kimi K3 Pro——不重启就看不到）。到点时电脑没开、或者昨天那一次没刷成，都会在下次启动后立刻补刷；失败不会记成成功，15 分钟后重试。
- **模型开关**：每个渠道的模型可单独关闭，也可以一键全关 / 全开；**未接入（一条账号都没有）的渠道，模型会自动全部关掉**，免得列表里挂着用不了的开关。
- **用量看板**：本机统计 token 与调用次数，按渠道 / 模型分列。
- **本地优先**：设置、缓存、登录态全部落在 `~/.dsh/get-it-for-free/`，不依赖任何远端服务；升级时会自动迁移旧数据目录一次。
- **MiMo 桌面端额度**：不添加账号，直接复用小米 MiMo 桌面端已登录的 cookie，把它的模型接进选择器，设置页显示剩余额度与重置日期（额度读取失败不影响选择器）。
- **CodeBuddy CLI 通道（可选，支持多账号）**：同一条腾讯账号，多一条「走官方客户端」的路。插件不再自己拼 HTTP 请求去模仿官方 IDE，而是调用你自己装好、自己登录的 `codebuddy` CLI——发出去的流量和普通 CLI 用户完全一样，因此更不容易被风控判定为滥用、能维持更久。代价是它整段返回、不流式，每轮要启动一次进程，所以它和原来的 HTTP 通道**并存**，在模型选择器里是单独一组，由你按需选。没装 CLI 时这一组不会出现，其他渠道不受任何影响。
- **多个腾讯账号各算各的**：你在「腾讯 CodeBuddy」里加过的每个账号都会参与，插件给每个账号单独传它自己的登录令牌，不共用本机 `codebuddy` 的那一份。选择器里只列模型（`Hy3`、`DeepSeek V4.1 Flash`、`Hy4 Preview`），**不写账号名**——账号是路由细节，请求在它们之间轮着走；想指定某个账号时，老会话里存的 `hy3@账号 id` 写法依然有效。
- **思考强度**：CLI 通道会按模型的档位传 `--effort`（Hy3 是 low / high，DeepSeek V4.1 Flash 多一档 max，Hy4 Preview 固定 high，默认 high），在模型选择器里选档位即可。
- **大上下文不再被截断**：CLI 的返回值改成先落临时文件再读回——之前接管道时，CLI 收尾用 `process.exit()`，Node 来不及 flush 异步写，超过 64KB（正好一个管道缓冲区）的返回必然半截，长会话因此稳定失败。实测同一份 190KB 的 prompt：接文件 246484 字节完整返回，接管道只剩 65536 字节。
- **失败不再是一句话了事**：CLI 隧道失败时会给出具体原因（登录失效 / 模型不可用 / 服务端 5xx / 轮次用尽 / 网络），瞬时故障自动重试一次，原始 stdout/stderr 追加写入 `~/.dsh/get-it-for-free/cli-failure.log`；设置页的 CodeBuddy CLI 卡片上有「自检一次」，跑一个两个字符的最小请求，几秒内告诉你现在到底通不通。腾讯 HTTP 通道若被上游风控拦下（`Illegal API invocation from an unapproved channel`），被拒的请求体会落到 `~/.dsh/get-it-for-free/buddy-http.log`，便于定位是哪段文本触发的。
- **腾讯 HTTP 通道的两种风控已自动绕开**：一是正文里的产品名，二是 DSH 自己那两行 `@路径` 说明文字——上游把它们当作「非官方客户端」的指纹，两句同时出现就回 400 `code=11128`。插件在发请求前把前者加零宽字符、把后者改写成同义句，规则照样传达给模型，请求不再被拦。
- **Loomy（讯飞）**：Loomy 办公助手云端通道，微信扫码登录，模型带倍率（如 `DeepSeek V4 Flash 0731 · x3.0`）。它的积分分「临时」与「永久」两池，通道侧只按临时池消耗。

## 安装

插件按 DSH 的 profile 方式安装：把本目录作为包放进 profile 的 `node_modules`，
并在 `package.json` 的 `dsh.profile.bundles` 里加入 `dsh-get-it-for-free`。
`cordis.patch.yml` 会由 bundle 层自动合并，不需要手改 profile 的补丁文件。

用 tarball 安装（推荐，免构建）：

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:/path/to/dsh-get-it-for-free-2.3.0.tgz
# 然后在 package.json 的 dsh.profile.bundles 里加入 "dsh-get-it-for-free"
```

装完重启 DSH（Host 半身新装才会加载）；界面部分刷新页面即可（⌘⇧R）。

要求 Node.js `^22.19.0 || >=24.0.0`，DSH `0.2.0-rc.1` 及以上。

## 配置

插件自身设置保存在 `~/.dsh/get-it-for-free/settings.json`（设置页也能改）。

| 键 | 含义 |
| --- | --- |
| `enabled` | 总开关（关掉后本插件的模型不再出服务） |
| `hideAllModels` | 一键隐藏本插件注册的全部模型 |
| `hiddenModelIds` | 单独隐藏的模型 id 列表 |
| `hideFreeModels` / `hideEacModels` | 按来源分组隐藏 |
| `probeIntervalMinutes` | 模型目录探测周期（分钟，默认 15） |
| `autoReloadWatch` | 改插件目录后自动热重载 |

## 界面

设置 → 「Get It For Free」。单页看板，极简风格：系统字体、1px 细边框、无阴影与动效。

## 隐私

- 仓库内不含任何个人信息、本机路径、账号凭据或推广链接。
- 运行期产生的登录态、缓存只存在于本机数据目录，不会被上传。
- `vendor/channel-pack/` 内含的第三方代码保留其原始许可证（见同目录 `NOTICE.md` 与 `LICENSE`）。

## 目录结构

```
index.js              Host 半身：设置、REST 路由、模型注册、点播
client.js             浏览器半身：设置页看板（手写 ModuleLoader bundle，无构建步骤）
src/                  适配层：账号池、签到、探测、转发、限流、用量统计
adapter/              模型适配器
vendor/channel-pack/  各渠道账号池与适配器（第三方，保留原许可）
locale/               界面文案
cordis.patch.yml      bundle 补丁（一行 insert 挂载 Host 半身）
```

## 开发

无构建步骤：`client.js` 是手写的 `window.__ModuleLoader__` bundle，改完直接刷新页面。
改 `index.js` / `src/**` 时，若开着 `autoReloadWatch`，宿主会做一次自愈式热重载
（导入失败会回滚到旧代码）。

```bash
node --check index.js && node --check client.js   # 语法自检
```

## 许可

以 MIT 许可证发布，详见 `LICENSE`。
