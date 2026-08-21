# Shadow v2 CPU gate 口径变更决策与验证（attribution v2）

- 日期：2026-08-21
- 决策：用户批准（本文件即批准记录）。备选方案与利弊分析见对话交付说明；批准内容为"方案 1 + 两道保守约束"。

## 决策内容

- **v1 口径**（r3/r4/r5 使用）：`gateUsed = 完整 ResourceControl phase + producerUsed`，p95 ≤ disabled 基线 × 1.10。
- **v2 口径**（本决策起生效）：
  1. 正式窗口 CPU 门槛：`shadowUsed = producerUsed + consumerUsed` 的 p95 ≤ **4.0**（绝对上限）；
  2. `gateUsed` 照常计量、照常投影 monitor，降级为 **observation-only**（不作 pass/fail）；
  3. 其余门槛全部不变（10 warmup + 100 measured、Memory ≤ 32 KiB、`effectiveAuthority=legacy`、零 active contract/lease/claim、零 arbiter 归属、零 invariant violation、coherent + tick-aligned 样本接纳、口径变更后旧窗口不得追认通过）。

## 理由（摘自 r5 复盘与方案分析）

- r5 窗口配对维度全绿（181 有效 epoch 全部 matched，unresolved=0），shadow 决策正确性已验证；唯一阻断是 CPU 维度。
- v1 口径把 legacy RC 本体 CPU 与同 tick 的 GC/邻近模块波动（含 market ~42 CPU/tick）计入被测对象：r5 gateUsed p95=7.406 vs cap 3.094（98/100 超限），而 shadow 自身增量合计仅 ~3.7（producer 2.32 + consumer 1.35），max 18.3 的尖峰来自共享 tick 波动。
- CPU 优化（6635241，producer 本地 -65%）同时降低 disabled 基线使 cap 收紧 22%，相对差距结构性不收敛——复盘原话："即便 shadow 增量降到零，tick 级波动也使 p95 不稳定收敛"。
- 备选：按 intents 归一化（不解决波动来源、小样本不稳）；维持 v1（gate 永久红、迁移系列被口径噪声无限期阻塞）。均否决。
- 保守约束的动机：绝对上限 4.0 防增量口径被滥用（上限取 r5 实测 shadowUsed p95 量级上浮）；gateUsed 观察位保留总 CPU 可见性，异常时人工介入。

## 计量字段现状（无需代码变更）

- `Memory.runtime.resourceControl.logistics.cpu` 每 epoch 已包含 `{attributionVersion:2, sampleTick, measurementAvailable, producerUsed, consumerUsed}`（proposal 要求的 v2 归因合同）。
- `scripts/monitor-service.mjs` 已投影 `shadowUsed=producerUsed+consumerUsed`、`gateUsed`、`cpuGateEligible`、`gateInconclusive`——口径切换只影响窗口分析器的 pass/fail 判定，不涉及 src 变更与部署。

## 执行与验证计划

1. openspec：proposal.md gate 条款追加 v2 口径修订（同 commit）。
2. 重开 shadow：`Memory.cfg.resourceControl.logistics.mode: disabled → shadow`（常设授权范围内；execution authority 恒为 legacy；严禁 canary/enabled）。
3. 新窗口：10 warmup + 100 measured epoch，本地采样 `Memory.runtime.resourceControl.logistics`（每 epoch 去重，校验 `updatedAt` 单调与 10-tick cadence 连续性），分析 shadowUsed p95（剔除 warmup）+ Memory 字节 + 安全不变量投影。
4. 结果回写本文件；若 p95 > 4.0 或任何安全维度失败，按规程回退 disabled 并记录。

## 窗口结果

（待回写）
