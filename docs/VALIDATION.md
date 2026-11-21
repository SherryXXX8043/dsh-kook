# 验证记录与本地改动

版本：`dsh-kook@0.3.4-local.rc5.1`。日期：2026-11-21。

## 修改范围

- `package.json`、`package-lock.json`：精确支持 DSH `0.2.2-rc.5`；增加本地版本标识，private 防止意外公开发布。
- `src/index.js`：完整继承默认模型的 reasoningEffort；在 Agent setup 的未发布阶段显式选择模型，使恢复会话使用当前插件选择。
- `client/index.js` 及其构建产物：说明模型策略与保存会中止 KOOK 任务。
- `locale/`：标注为本地修改版；保留包名与 `kook` 配置身份。
- `test/compatibility.test.js`：新增 5 项回归。
- `validation/rc5-host.test.mjs`：增加 4 项使用真实 rc.5 AgentModel 的验证。
- 通信层、Token 处理、白名单、数据文件格式保持上游实现；原许可证保留。

## 自动化验证

运行环境为当前 DSH 0.2.2-rc.5 自带 Electron 44.7.0 / Node v24.21.0，Cordis 4.1.0，Schemastery 3.19.0；KOOK SDK 0.1.4、ws 8.23.0、pako 2.2.0 按上游锁文件的 SHA-512 校验。

最终测试共 33 项，全部通过、失败 0、跳过 0：上游 24 项、本地回归 5 项、当前 rc.5 AgentModel 验证 4 项。公开仓库保留可复现的验证代码，不提交包含本机路径的测试输出。

用户随后在本机安装本地包并反馈：私聊、指定文字频道回复和网络搜索测试正常。这是用户环境下的使用反馈，不代表其他 DSH 版本、权限组合或所有模型的兼容保证。

覆盖包括：预设及会话参数、连续消息唯一 ID、工作区登记失败 dispose、Cordis 激活与卸载、配置模块服务注入；官方 SDK 对本地 HTTP/WebSocket 假服务的群聊/私聊、鉴权、心跳、断线恢复、取消、超时与错误；模型恢复、默认 effort、相同选择去重、仅 effort 改变与清除旧 effort。

`validation/runtime-hooks.mjs` 仅供审查，将 DSH 包导向本机实际安装库；它不随安装包运行，也不修改生产模块解析。

## 静态核对

当前 rc.5 仍提供：agents.create/resume/get、agent.followup/cancel/model.select、agentPresets.resolve/presetForSession/mount、workspaceRegistry.create/attachSession、session/event、配置表单 get/describe/mutate、目录选择和目录浏览、模型与预设列表以及 plugins.bundle.config 插槽。

setup 内 model.select 的合法性、setup 失败时宿主 dispose 的路径均已查看当前宿主源码。独立子代理做了运行时代码审查及安装/配置使用流程审查；安装说明中的旧 rc.3 指引已修正。

## 未验证事项

- 自动化验证不包含真实 KOOK Token 或付费模型请求；实际私聊、频道与搜索仅有上述用户反馈，没有完整平台端到端测试矩阵。
- 没有浏览器自动化测试覆盖表单各字段、Token 保留/清空及并发 revision 冲突。
- Agent create/resume 的大部分测试使用模拟服务；真实 AgentModel 测试的 Session append/fold 仍是受控测试对象，不是完整 AgentLoop、持久化服务或真实 Session 集成。
- setup 失败释放完整宿主 scope 的路径只做源码核对；不要把 mock 参数失败测试描述成完整宿主清理测试。
- 图标沿用上游未提供专用图标的情况，使用 DSH 默认图标；未新增预览图。前端视觉和实际图标显示没有浏览器验收。

## 模型策略

本地版有意让创建或恢复使用当前插件选择，可能覆盖曾在 DSH UI 单独修改的 KOOK 会话选择。显式模型没有 reasoningEffort 时清除旧 effort，使用该模型默认。模型选择事件本身不检查供应商可用性；首次真实模型调用才会验证相关凭据与服务。

不使用版本豁免，不放宽到未知未来 DSH 版本，不修改 DSH 安装文件。
