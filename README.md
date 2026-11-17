# DSH KOOK

[源码仓库](https://github.com/kaiheila/dsh-kook) · [使用说明](https://github.com/kaiheila/dsh-kook#readme) · [MIT 许可证](./LICENSE)

作者：<lspbupt@sina.com>。本项目采用 MIT 许可证，允许商用、修改和再分发，须保留版权及许可声明；完整条款见 [LICENSE](./LICENSE)。

让本地 DeepSeek Harness 与 KOOK 双向对话的 Host 插件。接收消息使用 KOOK **WebSocket** 模式，发送回复使用 KOOK HTTP API；无需公网地址、Webhook 或开放入站端口。

基于 KOOK 官方 SDK [@kookapp/js-sdk](https://github.com/kaiheila/js-bot) **0.1.4**。DSH 接口沿用 0.3.3 对本机 **DSH 0.2.2-rc.3** 安装包的核对，包清单限制为该版本；其他 DSH 版本需要重新核对接口后调整版本范围。Node.js 24.9+，建议使用 DSH 自带运行时。

0.3.4 将通信层迁移到官方 SDK：使用公开的连接、事件及 REST 接口，由 SDK 管理心跳、消息序号和断线恢复；卸载时销毁客户端并取消待发送请求。Token、配置字段和会话路由存储格式不变。

0.3.3 更新了 DSH 版本声明及 Cordis / Schemastery 依赖；会话预设改用 `agentPresets.presetForSession()` 读取；配置页补齐 `remote.agentPresets` 注入，修复预设列表读取失败。配置字段和会话路由存储格式不变。

## 能做什么

- 白名单用户私聊机器人，或在白名单频道发送 `/dsh <问题>`，消息进入本地 DSH Agent。开启“自动转发频道消息”后，白名单频道中的普通发言也会自动进入 DSH。
- DSH 已提交的助手文本回复自动发回原私聊/频道；在本地 UI 操作这些会话产生的回复也会同步。
- 私聊按用户隔离，频道按「频道 + 用户」隔离上下文。**频道回复对频道成员可见**。
- 同一路由串行处理输入，消息 ID 去重；回复按目标顺序发送，并按 UTF-8 字节数拆分长文本。
- 保存 KOOK 路由与 DSH 会话 ID，重启后下一条消息恢复原会话。聊天记录由 DSH 的持久化服务管理。
- 支持停止、新建会话、查询会话 ID；后台指数退避重连，卸载时关闭连接、取消待发送请求并释放本插件持有的 Agent。
- 支持可配置人格、陌生人配对审批、按用户隔离的长期记忆、月级别缓慢衰退，以及本地文本知识库检索。

## 安装与启用

### 1. 创建 KOOK 机器人

在 [KOOK 开发者平台](https://developer.kookapp.cn/) 创建应用/机器人，选择 **WebSocket** 连接模式，获取 Bot Token。将机器人加入需要使用的服务器，授予目标频道的查看和发送消息权限。取得你自己的 KOOK 用户 ID，以及需要启用的频道 ID。

这里用的是机器人 Token，不是用户登录 Token、应用 ID 或应用 Secret。一个 Token 只运行一个本插件实例。

### 2. 准备插件

在项目目录执行：

```powershell
npm ci --ignore-scripts
npm run build
npm test
npm run check
npm pack --ignore-scripts
```

Host 源码是原生 ESM JavaScript；`npm run build` 生成 DSH 客户端配置页入口。打包得到 `dsh-kook-0.3.4.tgz`。发布到 npm 后，可在安装框填写 `dsh-kook@0.3.4`；不要填写 `https://www.npmjs.com/package/dsh-kook` 网页地址。

在 **DSH Web GUI → 插件 → 安装** 中填写本项目的绝对路径，例如：

```text
C:/Projects/my-project
```

也可用打包后的 `.tgz` 安装。让 DSH 插件管理器完成安装并启用组合包。桌面版使用桌面应用当前 profile，不要另开一个 CLI profile 代替。没有配置 Token 时插件仅记录 `KOOK inactive`，不连接网络。

本项目目前只创建了插件源文件与安装包，**没有修改你的 DSH profile 或安装到正在运行的 DSH**。

### 3. 在插件界面配置

安装并启用后，刷新 DSH 页面，打开 **插件 → 已安装 → dsh-kook**，在包详情中的 **KOOK 机器人** 表单填写：

1. **Bot Token**：粘贴开发者平台的机器人 Token，输入框按密码显示。
2. **工作目录**：点击“选择目录”，浏览 DSH 主机目录后点击“使用此目录”。桌面宿主提供原生选择器时使用系统窗口。
3. **允许的用户 ID**：填写你自己的 KOOK 用户 ID；多个 ID 按表单提示分隔。
4. **允许的频道 ID**：填写要接入的频道；留空仅允许私聊。
5. **模型与 Agent**：从下拉列表选择供应商、模型和预设，或保留“跟随 DSH 默认”。切换供应商后需要重新选择模型；可点击“刷新可选项”读取最新列表。
6. 配置 **陌生人配对审批**、**主人用户 ID**、**机器人性格设定**、**记忆条数/半衰期**。知识库点击文件选择控件，选择 UTF-8 `.txt`、`.md` 或 `.markdown` 文件（最大 1 MiB）。文件内容与文件名保存为快照，不保存浏览器本地路径；原文件修改后需重新导入。旧版主机文件配置仍可继续使用，导入后替换旧配置。
7. 会话与记忆文件默认自动管理；需要调整时展开 **高级存储与兼容设置**，选择保存目录并设置文件名。
8. 点击 **保存设置**。整份表单一次保存，插件会关闭旧连接并按新配置连接，无需修改环境变量或重启 DSH。

Token 不回显；已有 Token 时，不输入新值会保留它。清除 Token 会停止连接。保存配置会停止本插件当前持有的任务，下一条消息按保存的路由恢复会话。目录或预设变化后，旧路由需要 `/new`。

表单通过 DSH 自带的 Settings/Config Editor 保存到当前 profile；秘密字段不会通过表单读取接口返回明文。配置文件仍由 DSH 管理，并非额外的系统钥匙串存储。

未填写 Token 时插件保持可配置，不连接网络；目录、白名单或模型配置不完整时也保持页面可编辑，修正后重新保存即可。

### 4. 高级配置与环境变量兼容

所有插件配置都可以在界面填写。`examples/cordis.patch.yml` 仅供希望手动管理 profile 的用户参考；插件行 ID 为 `kook`。DSH patch 的 `config` 是整个对象替换，修改时保留需要的字段。

仍兼容旧版的 `KOOK_BOT_TOKEN`、`KOOK_WORKSPACE`、`KOOK_ALLOWED_USERS`、`KOOK_ALLOWED_CHANNELS` 环境变量。只有对应界面配置未设置时才读取环境变量；显式清空 Token 会停止连接，不会退回环境变量。修改环境变量本身仍需重启 DSH 进程。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `token` | 未设置时读取环境变量 | 界面密码字段；填写后优先使用，显式清空停止连接 |
| `tokenEnv` | `KOOK_BOT_TOKEN` | 可选：兼容环境变量的名称 |
| `workspace` | `KOOK_WORKSPACE` | 已存在的绝对工作目录 |
| `allowedUsers` | `KOOK_ALLOWED_USERS` | 用户 ID 字符串数组；不能为空 |
| `allowedChannels` | `KOOK_ALLOWED_CHANNELS` | 频道 ID 字符串数组；空数组禁用频道 |
| `allowPrivate` | `true` | 是否接受白名单用户的私聊 |
| `pairingEnabled` | `false` | 陌生人私聊是否先等待主人批准 |
| `ownerUserId` | 空 | 主人 KOOK 用户 ID；启用配对审批时必填 |
| `personality` | 空 | 注入每次请求的长期人格和行为设定 |
| `memoryFile` | `.dsh-kook/memories.json` | 用户记忆持久化文件 |
| `memoryLimit` | `8` | 每次提供给模型的记忆条数 |
| `memoryHalfLifeMonths` | `6` | 记忆权重衰减一半所需的月数 |
| `knowledgeFile` | 空 | 兼容旧版主机文件路径；导入文件时清空 |
| `knowledgeText` / `knowledgeName` | 空 | 文件选择器导入的文本快照与文件名；内容优先于旧版路径，随 DSH 配置保存 |
| `knowledgeLimit` | `5` | 每次提供给模型的相关知识条数 |
| `autoForwardChannels` | `false` | 是否把白名单频道中的普通消息自动转发到 DSH；关闭时需使用 `/dsh` 前缀 |
| `commandPrefix` | `/dsh` | 频道触发前缀，需与正文以空白分隔 |
| `stateFile` | `.dsh-kook/routes.json` | 路由元数据文件；相对路径从工作目录解析 |
| `agentPreset` | DSH 默认预设 | 使用 DSH 已配置的预设；恢复时要求预设与原会话一致 |
| `provider` / `model` | DSH 当前默认模型 | 必须同时设置或同时省略 |

ID 必须加引号，如 `['1234567890']`。显式 YAML 配置覆盖对应环境变量，包括显式空的频道列表。模型凭据仍由 DSH 自己管理。

工作目录、预设改变后，旧路由不会被悄悄迁移；发送 `/new` 开始新会话。同一个路由文件只供一个插件实例使用；不同机器人/实例请配置不同 `stateFile`。不要编辑正在运行实例的路由文件。

## 使用

私聊：

```text
帮我检查这个项目的测试
/status
/stop
/new
/help
```

频道：

```text
/dsh 帮我解释这个项目的入口
/dsh /status
/dsh /stop
/dsh /new
/dsh /help
```

`/stop` 取消当前已加载 Agent 的任务和待处理输入。`/new` 解除当前路由并释放对应 Agent，下一条普通消息创建新会话；旧聊天记录保留在 DSH。`/status` 返回会话 ID，可在本地 DSH 查找该会话。

启用配对审批后，陌生人私聊会收到六位配对码，主人会收到通知。主人在私聊中发送 `/approve 配对码` 后，该用户才可使用机器人。已批准用户保存在 `memoryFile` 中；如需撤销，可从该文件的 `pairedUsers` 删除对应 ID 后重新加载插件。

长期记忆按 KOOK 用户 ID 分开保存，不会把一个人的记忆提供给另一个人。用户消息和助手已提交的文本会写入记忆；`memoryHalfLifeMonths` 控制权重每经过多少个月减半，检索时优先使用与当前问题相关且较新的内容。发送 `/memory` 可以查看当前用户仍可检索到的记忆。知识库通过配置页选择 UTF-8 文本文件导入，段落用空行分隔，插件按问题关键词挑选相关段落注入当前请求。知识文本随 DSH 配置保存；原文件改变后需重新导入。


## 会话可见性与故障定位

0.3.2 修复了旧版直接调用 Agent 时遗漏用户消息 `id` 和 `role` 的问题。旧版连续发送消息时，前一条尚在 pending 队列，下一条可能因 `undefined` ID 冲突而被拒绝。空字符串 Agent 预设现在正确回退到 DSH 默认预设。

新建和恢复的 KOOK 会话会登记到配置目录对应的 DSH 工作区，在侧栏该工作区下查看。启动时也会尝试补登记路由文件中的旧会话，不会重放消息或创建替代对话。已删除、已归档或工作目录不匹配的旧会话不会因此恢复；尚未成功写入 DSH 的旧消息也无法补回。`/status` 可获取当前会话 ID。

失败回复包含错误码和关联编号，本地 KOOK 日志使用相同编号；不会回显异常里的 Token、消息正文或个人路径。常见错误：

- `SESSION_CREATE` / `SESSION_RESUME`：新建或恢复会话失败。
- `PRESET_UNAVAILABLE` / `MODEL_UNAVAILABLE`：重新选择可用预设或模型。
- `WORKSPACE_CHANGED` / `PRESET_CHANGED`：当前设置与旧会话不一致，发送 `/new` 后开始新对话。
- `WORKSPACE_ATTACH`：会话无法登记到工作区，检查目录和 DSH 存储服务。
- `ROUTE_SAVE` / `MEMORY_SAVE`：检查保存目录权限和磁盘空间。
- `MESSAGE_SUBMIT`：Agent 拒绝本次提交，查看会话状态。
- `SESSION_OWNED`：旧会话已被其他组件持有；先在本地完成任务，或 `/new` 建立独立会话。

## 验证范围与限制

0.3.3 的自动化回归测试覆盖：新版预设服务读取、新建/恢复会话、预设变化和清空、工作目录变化、拒绝接管他人 Agent、工作区登记失败后的释放、连续消息的唯一 ID，以及真实 Cordis 4.1 装载/卸载和客户端预设 RPC 服务注入。`npm run build` 重新生成发布客户端，`npm run check` 检查 JavaScript 语法。

0.3.4 增加真实官方 SDK + 本地 HTTP/WebSocket 服务集成测试，覆盖认证和 HELLO、心跳、群聊/私信收发、非文本及机器人过滤、去重、断线 RESUME、初次认证失败恢复、HTTP/API/JSON 错误、429 不重试、超时和卸载取消。另有生命周期测试覆盖延迟创建、初始重试、停止/重启竞态和敏感错误屏蔽；所有测试均不访问真实 KOOK。

本次未在当前运行的 DSH GUI 中安装并操作配置页，也未使用真实机器人 Token 验证 KOOK 服务端权限、实际消息投递或在完整 DSH 宿主中跑模型。安装后可用私聊 `你好`、连续两条追问、`/status`、`/stop`、`/new` 及断网恢复完成联调。

当前版本的边界：

- 接收文本与 KMarkdown，发回纯文本；不处理图片、附件、语音、卡片，不逐 token 刷新。
- 不转发 reasoning、工具参数或工具结果；助手文本可能包括过程说明与最终答复。
- 审批、计划确认、交互式问题在本地 DSH UI 完成。插件在识别到审批/相关工具调用时发送提示，不提供 KOOK 远程批准按钮。
- 重连期间尽力通过 SDK RESUME 恢复；没有持久消息队列或 exactly-once 保证。去重状态只保留在内存，进程重启后不保留。
- 发送失败或超时不自动重发，避免网络超时导致重复发帖；完整原文仍保留在 DSH。错误日志不包含 Token 或原始消息正文。
- 每个实例最多同时持有 100 个 Agent，待处理路由操作最多 100 条；单条输入最多 16,000 UTF-8 字节。超过准入限制的消息被忽略；已存在的持久路由不会因此被删除。
- 仅恢复本插件创建的会话，不自动绑定任意已有会话。若会话已被本地其他组件加载并持有，恢复会拒绝，避免越过 Agent 所有权；用 `/new` 创建独立会话。

## 实现说明

- `client/index.js`：插件页面上的完整配置表单。
- `scripts/build-client.mjs`：生成 `src/client.js` 供 DSH ModuleLoader 加载。
- `src/index.js`：Cordis 生命周期、即时配置重载、DSH `agents.create/resume` 和预设装配。
- `src/bridge.js`：路由、指令、去重、事件转发与输出拆分。
- `src/transport.js`：KOOK SDK WebSocket 与 REST 适配。
- `src/store.js`：只存会话 ID 的原子路由文件。

通信层使用 `@kookapp/js-sdk` 的 `KookClient.connect()`、顶层 `event` / `stateChange` / `reconnecting` 事件和 `destroy()`。心跳、序号排序与 RESUME 由 SDK 管理；初始连接失败后适配器销毁客户端并指数退避重试。发送使用公开的 `client.api.request()`，以传入取消信号、超时及 `retryOnRateLimit: false`，避免失败后重复发帖。SDK 原始日志被关闭，仅输出固定的连接状态，不记录 Token、网关 URL 或消息正文。SDK 固定为 0.1.4，升级前运行本地集成测试。

参考：[KOOK 文档](https://developer.kookapp.cn/)、[WebSocket 协议](https://developer.kookapp.cn/doc/websocket)、[官方 SDK 源码](https://github.com/kaiheila/js-bot)。
