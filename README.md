# dsh-get-it-for-free

把**免费 / 签到型**大模型账号渠道接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）：
在设置里登录账号、每日签到、同步可用模型池，模型以普通 provider 的形式出现在模型选择器里。

纯本地运行：没有遥测、没有自更新、不向上游仓库发任何请求。账号凭据只写在本机
`~/.dsh/get-it-for-free/` 目录里。

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
| Cline / Loomy / Gemini 等 | 视渠道而定 | 见设置页 |

## 功能

- **账号看板**：一页管理各渠道账号（登录 / 刷新 / 退出 / 启停），登录态保存在本机。
- **每日签到**：渠道支持签到时可直接签到，也可开启每日自动签到；「已接入」「今日已自动签到」用绿点标示。
- **模型池**：定时探测每个账号当前可用的模型，按可用 / 区域受限两档注册为 provider。
- **模型开关**：每个渠道的模型可单独关闭，也可以一键全关 / 全开；**未接入（一条账号都没有）的渠道，模型会自动全部关掉**，免得列表里挂着用不了的开关。
- **用量看板**：本机统计 token 与调用次数，按渠道 / 模型分列。
- **本地优先**：设置、缓存、登录态全部落在 `~/.dsh/get-it-for-free/`，不依赖任何远端服务；从旧版本（`~/.dsh/our-free-model/` 或 `~/.dsh/free-ride/`）升级时会自动迁移一次。

## 安装

插件按 DSH 的 profile 方式安装：把本目录作为包放进 profile 的 `node_modules`，
并在 `package.json` 的 `dsh.profile.bundles` 里加入 `dsh-get-it-for-free`。
`cordis.patch.yml` 会由 bundle 层自动合并，不需要手改 profile 的补丁文件。

用 tarball 安装（推荐，免构建）：

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:/path/to/dsh-get-it-for-free-2.0.0.tgz
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

## 来源与许可

本项目是 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（MIT）的衍生分支：内核沿用其账号渠道适配层，界面、包标识、数据目录与默认配置
已改为独立的本地实现，并移除了上游的公告、自更新、赞助与统计入口。

以 MIT 许可证发布，详见 `LICENSE`。
