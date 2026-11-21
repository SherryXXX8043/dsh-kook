# 官方上游与兼容分支维护

## 仓库结构

- 官方上游：<https://github.com/kaiheila/dsh-kook>
- 目标个人 Fork：`SherryXXX8043/dsh-kook`。只有 GitHub 创建 Fork 成功后，该地址才可用。
- `main`：保留官方提交，便于使用 GitHub 的 **Sync fork**。
- `compat/dsh-0.2.2-rc.5`：保存 rc.5 适配、回归测试和本地版说明。
- 不把插件 Token、DSH profile、白名单、聊天记录、记忆或依赖目录提交到仓库。

当前适配基线为官方提交 `c9afa98662cdc59c0d56ffb718553dd732b66149`。

## 第一次连接

Fork 创建好之后，普通克隆可这样设置：

```sh
git clone https://github.com/SherryXXX8043/dsh-kook.git
cd dsh-kook
git remote add upstream https://github.com/kaiheila/dsh-kook.git
git fetch upstream
git switch compat/dsh-0.2.2-rc.5
```

已有本地维护克隆时先用 `git remote -v` 核对，不要重复添加同名 remote。

## 官方更新后

工作区干净时执行：

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch compat/dsh-0.2.2-rc.5
git merge upstream/main
```

`--ff-only` 失败时先检查是否误在 main 提交过修改，不要 force push。合并兼容分支时遇到冲突，应逐项核对模型选择、版本范围、客户端构建和锁文件，不能简单全部采用一侧。

保留 Fork 关系不代表自动适配。特别检查官方是否已经修复相同问题；如果已修复，应移除重复补丁。官方引入新 DSH 版本要求时重新核对该版本接口，不直接把 engines.dsh 放宽到未知未来版本。

## 合并后的验证

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check
npm pack --ignore-scripts
```

常规测试为 29 项；另有 4 项实际宿主 AgentModel 验证，需要在 DSH 0.2.2-rc.5 环境中以自带 Electron 运行时运行。确保设置 `ELECTRON_RUN_AS_NODE=1`，使用 `--import ./validation/runtime-hooks.mjs --test --test-isolation=none validation/rc5-host.test.mjs`；保留 DSH 提供的 `DSH_INSTALL_DIR`。Windows 的 import 参数应使用相对路径或有效 file URL。

通过测试后，用自己的白名单账号验证私聊、频道、连续对话、停止和模型选择。打包不会自动安装；通过 DSH 当前 profile 的插件管理器安装。更换已加载的插件版本时，如果管理器提示需要重启，应等任务结束后重启 DSH。

当官方已兼容所需 DSH 版本并覆盖本地修复时，可以停止维护这条兼容分支，切回官方发布包。保留路由和记忆数据，不同时运行两个使用同一 Token 的实例。
