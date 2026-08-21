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

- 采样：本地脚本轮询 `Memory.runtime.resourceControl.logistics`（~35s/次，按 `updatedAt` 去重），窗口 tick **73154380–73155660**（1,280 tick），**119 个 distinct epoch**，原始数据 `monitor-data/shadow-v2-gate-attribution-v2.jsonl`（本地归档，与 r5/baseline5 同例不入库）。
- cadence：7 处非 10-tick 缺口（+20×5、+30×1、+40×1）逐一经 wallClock 复核与 ~35s 轮询周期自洽（对应 39–173s），按 r5 先例接纳为采样侧缺口。注：纯采样数据无法严格区分"轮询漏采"与"运行时停摆 20–40 tick"（数据形态相同），本判定依据是缺口时长与轮询周期量级吻合。剔除前 10 warmup 后 **109 个 measured epoch ≥ 100**，窗口成立。
- 归因合同：119/119 样本 `attributionVersion=2`、`measurementAvailable=true`、`sampleTick=updatedAt`。
- 安全维度（全绿）：全部 epoch `requestedMode=shadow`、`effectiveAuthority=legacy`、`blocker=null`；安全九项（nonLegacyAuthorityRecords / activeContracts / activeLeases / activeClaims / shadowArbiterActor / shadowClaim / shadowJournal / shadowCarrierTask / shadowReceiverReservation）全部为 0，`violations=[]`；Memory 峰值 **13,156 B ≤ 32 KiB**。
- **CPU 维度（唯一失败项）**：measured shadowUsed（producer+consumer）median 3.630 / mean 3.914 / p90 4.379 / **p95 4.996** / p99 8.913 / min 2.964 / max 14.414；**24/109 超过 4.0 上限**。分项 p95：producer 3.005、consumer 1.747。
- **判定：FAIL**（shadowUsed p95 4.996 > 4.0）。
- **回退已执行**：console op `6a880bdf9192cf0013dfb64b` 将 cfg mode 置回 `disabled`；tick 73155720 读回原文：cfg=`{"schemaVersion":1,"mode":"disabled"}`，runtime `{updatedAt:73155720, requestedMode:"disabled", effectiveAuthority:"legacy", blocker:"mode_disabled"}`（读回摘录仅含 mode 相关字段；后续复测建议将读回原文随归档保存）。

### 结论

- attribution v2 达成了口径目的：本次失败**不再是 v1 的"被测对象混入 legacy 本体与邻域波动"问题**——增量本身（典型 3.6–3.9，中位 3.63 距上限仅 ~9% 余量）已实际落在 4.0 之上。尾部（p99 8.9 / max 14.4）按 r5 先例推断主要来自共享 tick 波动（本窗口数据无 GC 标记，无法直接验证）；判定对尾部剔除稳健——剔 top 1/3/5/10 极端值后 p95 分别为 4.833/4.476/4.379/4.199，需剔除全部 24 个超限值才降到 3.938。
- 配对维度本窗口未作为门槛，且 comparison 投影全程为 null（配对数据未采集）；本文件安全九项全零、authority 恒 legacy 佐证 shadow 无副作用，但决策正确性结论依赖 r5 先例（口径变更只影响 CPU 计量，不影响决策逻辑）。后续复测窗口应恢复配对采集。

### 下一步提案（需用户决策，未执行）

1. 继续 CPU 结构削减：consumer 侧 matcher（r5 单段最大 ~0.354）与 finalize 段为主要剩余目标；producer store 管线已在 6635241 削减 65%。
2. 降低 epoch 频率（RC `sampleInterval` 10 → 20/30）摊薄每 tick 成本，代价是 comparator 对照新鲜度下降。
3. 上调绝对上限（例如 5.5，覆盖本窗口 p95）——放宽需用户明确批准。
4. 维持 disabled，待 market 复杂体（窗口期 ~42 CPU/tick）等大 CPU 消费方收缩后复测。
