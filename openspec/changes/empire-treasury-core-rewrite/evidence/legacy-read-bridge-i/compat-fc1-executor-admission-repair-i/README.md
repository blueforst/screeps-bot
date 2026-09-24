# FC1 执行器准入修复

## 接续事实

- 起点：`compat/treasury-read-bridge-i` `0cdbd061c2645366bd409dbdbd262881d277cb35`；`refactor/empire-treasury-rearchitecture` `b17979591d8308088c774fbb92a43f4cf5a80df7`。同步时远端 HEAD 与审查锚点一致。
- R1 保持 `STRUCTURAL_REVIEW_REQUIRED`：4 条报告、0/4 完整业务样本；旧 evidence 的恢复为精确字节读回和约 75 秒独立运行验证。
- FC1 旧 run 保持 `NOT_DEPLOYED`：`TIMING_PROFILE_INVALID`，candidate/restore 写入均为 0，没有取得新成本样本。
- 在未修改的生成适配器上组装最终执行器，运行 window-selection fixture，复现 `profileFor()` 的 10/25 被最终 `time-budget.plan()` 以 2/5 拒绝。该复现仅本地运行，线上调用与源码写入均为 0。结果见 `reproduction/baseline-defect.json`。

## 本轮修复

- 在 `task-package/fc1-delivery/tools/adapt-executor.cjs` 增加 time-budget 生成变换。最终准入严格绑定 FC1 协议、10/25/55、bucket 2000、100 tick、4 点、16384 字节、固定房间/资源和窗口；旧 baseline 继续单独保持 2/5。
- 最终 executor 测试从组装后的 runtime 和 repository 模块加载。它验证真实生成 profile 通过 binding 与 upload admission；旧/混用/扩展配置、过期证据、时间不足、身份漂移和过期窗口都挡在上传前。
- 在线入口增加新授权闩。当前输出标记为等待新授权，并且不能沿用旧 authorizationId/runId；这不会限制离线组装和测试。
- `build-offline-executor.cjs` 可从指定已提交兼容源码对象组装完整离线 executor，不修改 Git 工作树。完整旧工具测试缩到 4 组关键风险回归，完整 165 项历史测试不再作为默认门禁；24 项成本/报告断言保留，并新增最终组合用例。

## 授权与线上状态

本修订没有发起 Screeps GET/POST，未部署、未产生业务样本或成本回执，也没有恢复动作。因此本轮恢复状态为“未部署、未需恢复”，不能继承旧 run 的恢复结论。输出的生产配置仍为 OFF。线上阶段只剩明确的新一轮实验授权；收到授权后必须新建 ID 和 marker，不得复用旧启动记录。

## 构建与验证

Node 22.23.3 / TypeScript 5.9.3 下，制作端 122/122 通过；最终组装 executor 的 100 项择时、写入配额、身份、恢复回归和 35 项 FC1 组合测试均通过（合计 135/135）；仓库 FC1/R1 定向测试 75/75 通过，compat loader generator check 通过。默认门禁缩小后未跑 165 项完整历史工具套件、全量 Jest、双 tsc、生产 Rollup 或线上观察。实际命令和结果在 `offline-validation/` 及 `task-package/final-executor-verification/result.json`；源码提交与推送回执在本次交付回复中列明。

最终 executor fingerprint 为 `ee396de45c8f08ef3e414f5bd103fe72c29b24aed5ff4b14c165165d7ee2cf76`，源码为远端 compat 的 `0cdbd061`，生产配置保持 OFF，candidate/restore 网络写入为 0。最终包根目录的旧 XV 运行说明已由 pending 授权说明替换。在线授权闩处于等待状态。完整状态见 `offline-validation/ASSEMBLY.json`。历史 `compat-read-path-r1-online-i` 与 `compat-full-cost-fc1-online-i` 证据只读保留在 refactor 分支。
