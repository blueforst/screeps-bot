# 离线 executor 交付

目录包含未修改的 XV baseline executor、FC1 正常适配/生成入口，以及一个只读 Git 对象的离线组装器。

```sh
node build-offline-executor.cjs --repo <repo-path> --source-ref <verified-commit> --out <new-output-directory>
node <new-output-directory>/tools/run-tests.cjs --out <outside-output-test-directory>
```

生成器校验源提交父级、标题、文件范围和每个文件的 Git blob/SHA。最终 executor policy 明确标记为 `WAITING_FOR_EXPLICIT_AUTHORIZATION`，`run` 与直接 `observe` 都会在网络请求和 marker 写入前拒绝在线执行。旧 authorizationId/runId 是历史值，仅用于验证“不复用”闩。

本目录中的 `final-executor` 和验证日志仅在完整离线测试通过后生成；不会包含用户 token、私有 candidate/backup 或 Screeps 回包。
