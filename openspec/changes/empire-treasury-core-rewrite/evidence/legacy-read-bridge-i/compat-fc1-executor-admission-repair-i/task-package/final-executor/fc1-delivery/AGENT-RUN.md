# FC1 执行器准入修复交付

本包修复最终组装器中 profile 与 time admission 使用不同 CPU 协议的问题。它仅用于本地离线组装和验证；当前在线授权状态为 `WAITING_FOR_EXPLICIT_AUTHORIZATION`。

## 离线组装与验证

从仓库对象读取已提交源码，不修改 compat/refactor 工作树：

```sh
node task-package/build-offline-executor.cjs \
  --repo /path/to/screeps-bot \
  --source-ref <verified-compat-source-commit> \
  --out /path/outside/repository/fc1-executor
node /path/outside/repository/fc1-executor/tools/run-tests.cjs \
  --out /path/outside/repository/fc1-executor-tests
```

组装命令校验源提交父级、提交标题、变更路径集合及逐文件 Git blob/SHA；生成的 executor 包含最终运行模块。测试入口拒绝缺文件、空跑、跳过和未列入 contract 的用例。

## 在线阶段授权

- 旧 FC1 `authorizationId`、`runId` 和对应启动记录仅作历史证据，不能用于新实验。
- 输出 policy 的 `newRoundAuthorization` 默认为等待授权。`tools/run.cjs` 和直接 `tools/observe.cjs` 入口都会在任何实验目录或网络访问之前拒绝该状态。
- 只有获得明确的新一轮授权后，才能将新的 `authorizationId`、新的 `runId` 和授权状态写入一份新执行包；两个 ID 必须与历史 ID 不同。不得复用、删除或刷新旧 marker。
- 新授权仍受 candidate POST ≤1、restore POST ≤1、不重试、不补第五个业务点、不自动开启第二窗口的限制。
- 线上凭据只从用户指定的外部 secret 文件读取，不写入此包或 evidence。

## 固定测量范围

FC1 仍使用 `screeps.com / default / shard1`，房间 `E3N59`、`E4N58`，资源 `energy`、`H`。协议固定为 ceiling 10 CPU、reserve 25 CPU、入口 headroom 55 CPU、bucket 2000、4 个点、间隔 100 tick。10 CPU 仅为保护边界，没有性能合格线或生产配额含义。

本包不改生产 writer、不启用完整 Treasury、不授权业务 action，也不修改 generated Core。
