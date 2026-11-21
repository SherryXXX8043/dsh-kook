# 上游同步与分支维护

## 仓库结构

- 官方上游：<https://github.com/kaiheila/dsh-kook>，通过 `upstream` 远端跟踪。
- 个人 Fork：<https://github.com/SherryXXX8043/dsh-kook>，通过 `origin` 远端推送。
- `main`：本 Fork 的集成主线，包含 DSH rc.5 适配、图片功能和设置界面优化。
- `compat/dsh-0.2.2-rc.5`、`feature/image-support`、`feature/settings-ui`：保留对应开发阶段的提交历史；功能整合后，新开发从 `main` 另开分支。
- 官方历史仍保留在 Git 祖先提交和 `upstream/main` 中。当前适配基线为官方提交 `c9afa98662cdc59c0d56ffb718553dd732b66149`。
- 不提交 Token、DSH profile、白名单、聊天记录、记忆、依赖目录或本机诊断产物。

## 克隆并连接上游

```sh
git clone https://github.com/SherryXXX8043/dsh-kook.git
cd dsh-kook
git remote add upstream https://github.com/kaiheila/dsh-kook.git
git fetch upstream
```

已有维护克隆时先用 `git remote -v` 核对，不重复添加同名远端。推送自己的改动使用 `origin`，不向 `upstream` 直接推送。

## 开发新功能

工作区干净时：

```sh
git switch main
git pull --ff-only origin main
git switch -c feature/your-feature
```

完成修改和验证后，提交并推送功能分支，再合并回个人 Fork 的 `main`。不要使用强制推送来跳过远端差异。

## 官方更新后

`main` 已包含本 Fork 的功能，因此不再作为官方分支的纯镜像。不要用覆盖分支的方式“同步”而丢弃本地功能。建议先在独立分支审查上游更新：

```sh
git fetch origin
git fetch upstream
git switch main
git pull --ff-only origin main
git switch -c maintenance/sync-upstream
git merge upstream/main
```

遇到冲突时逐项核对模型选择、版本要求、图片事件、设置入口、客户端构建和锁文件，不简单全部采用一侧。特别检查官方是否已修复相同问题，并移除重复补丁。官方引入新 DSH 版本要求时，重新核对接口和测试，不直接放宽 `engines.dsh`。

验证通过后再将该维护分支合并到 `main` 并推送 `origin`。如果 `git pull --ff-only` 失败，先检查分支分歧，不要 force push。

## 验证与安装

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check
npm pack --ignore-scripts
```

设置优化版本的常规回归为 127 项；实际宿主图片与 AgentModel 验证另需 DSH 自带 Electron 运行时：

```sh
# 使用 DSH_NODE_EXECUTABLE，设置 ELECTRON_RUN_AS_NODE=1 后执行以下参数
--import ./validation/runtime-hooks.mjs --test --test-isolation=none validation/image-host.test.mjs validation/rc5-host.test.mjs
```

保留 DSH 提供的 `DSH_INSTALL_DIR`。Windows 的 import 参数使用相对路径或有效 file URL。详细验证范围见 [验证记录](VALIDATION.md)。

通过自动化后，用自己的白名单账号检查私聊、频道、图片、连续对话及停止。设置界面还需检查现有值、目录选择、Token 行为和并发配置提示。打包不会自动安装，通过 DSH 当前 profile 的插件管理器更新；如果提示需要重启，应等任务结束后重启。

当官方已覆盖所需兼容与功能时，可评估切回官方版本。保留本地路由和记忆数据，不同时运行两个使用同一 Token 的实例。
