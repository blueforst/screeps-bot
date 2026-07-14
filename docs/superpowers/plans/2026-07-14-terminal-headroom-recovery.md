# Terminal Headroom Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让处于 storage/terminal 容量压力的房间能够持续释放 terminal 空间并最终退出压力态，同时禁止未获发送资格的 staging、重复接收承诺和同 tick 容量预支。

**Architecture:** 提取单一容量水位策略，供 ResourceControl 与 Hub 共用；ResourceControl 每 tick 只构建一次可变转运上下文和 receiver 容量账本，在规划、执行、staging、持久化阶段连续更新；terminal 恢复采用“恢复缺口 + storage 安全余量 + 受保护库存”三重约束；监控层只投影已存在的新字段，旧快照继续兼容。

**Tech Stack:** TypeScript、Screeps API、Jest、Rollup、Node.js

## Global Constraints

- 遵守 `src/main.ts` 既有阶段顺序，不改变主循环编排。
- 保留手动转运任务；容量不足时只暂停其 carrier feed，不隐式取消任务。
- 新自动任务必须满足 receiver admission；执行阶段仍使用更宽松的物理安全容量重新校验。
- terminal 恢复不得预支尚未执行的 offload，也不得搬走当前已准入发送批次、生产保留量或 fee/energy 安全量。
- 每项行为变更必须先新增或修改测试并确认 RED，再写最小实现得到 GREEN。
- 每完成一组实现立即勾选 `openspec/changes/terminal-headroom-recovery/tasks.md` 对应任务。

---

## Task 1：建立共享容量水位策略

**Files:**

- Create: `src/runtime/logistics/capacityHeadroom.ts`
- Create: `src/runtime/logistics/capacityHeadroom.test.ts`
- Modify: `src/runtime/resourceControl.ts`
- Modify: `src/runtime/hubPlanner.ts`
- Modify: `src/global.d.ts`
- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`

- [ ] 1.1 在 `capacityHeadroom.test.ts` 写失败测试，覆盖默认水位、非法值归一化、storage 顺序 `pressure <= relief <= receiver`、terminal 顺序 `pressure <= receiver <= relief`、滞回状态与 feature flag 默认值。
- [ ] 1.2 运行 `npx jest src/runtime/logistics/capacityHeadroom.test.ts --runInBand`，确认因模块/行为缺失而 RED。
- [ ] 1.3 实现 `CapacityHeadroomPolicy`、`DEFAULT_CAPACITY_HEADROOM_POLICY`、`normalizeCapacityHeadroomPolicy`、`resolveCapacityState`、`isReceiverAdmissionEligible`、`getReceiverSafeCapacity`。
- [ ] 1.4 将 `resourceControl.ts` 的容量配置和状态判定改为调用共享模块；保留现有导出与配置兼容层。
- [ ] 1.5 在 `global.d.ts` 增加可选 `terminalHeadroomRecoveryEnabled` 配置，并保证缺省为启用。
- [ ] 1.6 再跑目标测试与 `npx jest src/runtime/resourceControl.test.ts src/runtime/hubPlanner.test.ts --runInBand`，确认 GREEN。

## Task 2：统一 Hub receiver admission 与接收承诺

**Files:**

- Modify: `src/runtime/logistics/resourceTransferTasks.ts`
- Modify: `src/runtime/logistics/resourceTransferTasks.test.ts`
- Modify: `src/runtime/hubPlanner.ts`
- Modify: `src/runtime/hubPlanner.test.ts`
- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`

- [ ] 2.1 先写失败测试：`receiver_capacity`/`source_depleted` 不算健康接收承诺；新鲜且可继续的自动任务算承诺；过期无进展自动任务不算承诺；manual 未阻塞任务保持兼容。
- [ ] 2.2 运行 `npx jest src/runtime/logistics/resourceTransferTasks.test.ts --runInBand`，记录 RED。
- [ ] 2.3 增加专用 `isHealthyReceiverCapacityCommitment`，不改变通用 `isHealthyResourceTransferTaskReservation` 的既有语义。
- [ ] 2.4 修改 Hub：使用共享 admission/安全容量策略；目标库存和可接收容量都扣除健康 incoming commitment；每新建一项任务立即更新本轮本地索引，避免同 tick 重复承诺。
- [ ] 2.5 修改 Hub 测试：已有 500 incoming、目标 1000 时只新增 500；覆盖跨资源共享 receiver 容量和低于 admission 水位不建自动任务。
- [ ] 2.6 运行 `npx jest src/runtime/hubPlanner.test.ts src/runtime/logistics/resourceTransferTasks.test.ts --runInBand`，确认 GREEN。

## Task 3：单 tick receiver 容量账本与一次索引构建

**Files:**

- Create: `src/runtime/logistics/receiverCapacityLedger.ts`
- Create: `src/runtime/logistics/receiverCapacityLedger.test.ts`
- Modify: `src/runtime/resourceControl.ts`
- Modify: `src/runtime/resourceControl.test.ts`
- Modify: `src/runtime/resourceControl.capacityRegression.test.ts`
- Modify: `src/runtime/hubPlanner.ts`
- Modify: `src/runtime/hubPlanner.test.ts`
- Modify: `src/global.d.ts`
- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`

- [ ] 3.1 先写失败测试：跨资源任务共享 receiver 容量上限；已有任务只取回自己的 reservation；新建任务立即 reservation；`receiver_capacity` blocker 不占 commitment；同 tick send 后 snapshot 的 terminal used/free 同步变化。
- [ ] 3.2 运行 `npx jest src/runtime/resourceControl.test.ts src/runtime/resourceControl.capacityRegression.test.ts --runInBand`，确认新增断言 RED。
- [ ] 3.3 提取共享 receiver capacity ledger；Hub 与 ResourceControl 使用同一实现，按房间总量、资源量、per-task commitment/reservation 和排除原因维护可变投影。Hub 新任务先写入持久 task store，ResourceControl 随后只构建一次本轮索引。
- [ ] 3.4 将容量救济规划、执行和后续 staging 改为复用同一个 ResourceControl 上下文；新任务、进度、完成、取消或 blocker 变化都同步更新 ledger。
- [ ] 3.5 扩展 `applyPostSendDelta`，同时更新 terminal energy、used/free 与相应资源库存，防止同 tick 后续阶段看到过期容量。
- [ ] 3.6 用测试断言 `capacityIndexBuildCount === 1`，并确认跨资源总承诺不超过接收端安全容量。
- [ ] 3.7 运行 Task 3 两个测试文件，确认 GREEN。

## Task 4：修复 terminal 50k 粘滞并安全渐进恢复

**Files:**

- Modify: `src/runtime/resourceControl.ts`
- Modify: `src/runtime/resourceControl.test.ts`
- Modify: `src/runtime/resourceControl.capacityRegression.test.ts`
- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`

- [ ] 4.1 先写失败测试：previous=`pressure`、terminal used=250k/free=50k、relief target=80k 时仍生成一批非 energy offload，且状态保持 pressure。
- [ ] 4.2 写安全边界失败测试：storage 无恢复安全余量时不 offload；只有生产/发送保护库存时不 offload；feature flag 关闭时保持旧 250k 阈值行为。
- [ ] 4.3 运行目标测试并确认 RED。
- [ ] 4.4 将压力态目标改为 `terminalCapacity - terminalReliefTargetFreeCapacity`；单批 offload 限制为 `min(recoveryGap, transferBatch, storageFree - storageReliefTargetFreeCapacity)`，非 energy 优先、energy 最后。
- [ ] 4.5 保护范围改为“当前已准入批次 + 生产保留 + fee/energy 安全量”，不再用完整 pending backlog 锁死 terminal。
- [ ] 4.6 删除 feed capacity 中“计划 offload 即可用”的预支；所有 feed 共用实际物理 headroom ledger。
- [ ] 4.7 在回归测试中模拟 carrier 执行，验证 terminal free `50k → 60k → 70k → 80k → normal`，下一轮无 feed/offload 抖动。
- [ ] 4.8 运行相关测试，确认 GREEN。

## Task 5：实现发送窗口与 staging admission

**Files:**

- Modify: `src/runtime/resourceControl.ts`
- Modify: `src/runtime/resourceControl.test.ts`
- Modify: `src/runtime/resourceControl.capacityRegression.test.ts`
- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`

- [ ] 5.1 先写失败测试：`receiver_capacity`/`source_depleted` 清除旧 feed；真实 fee 不可支付时不 feed；资源在 storage 但 terminal 暂缺时仍允许为可支付任务 staging。
- [ ] 5.2 写有界窗口失败测试：cooldown 下同房只允许最高优先级任务占当前/下一发送窗口；tail 25 和 receiver reservation 3000 分别限制 admitted amount。
- [ ] 5.3 写冲突失败测试：本轮计划 H offload 不得让 K feed 预支空间；admitted K batch 不得被反向 offload；energy 与非 energy feed 共用 headroom。
- [ ] 5.4 运行测试确认 RED。
- [ ] 5.5 按现有 transfer priority 排序并建立每房有界窗口；admitted amount 取任务 remaining、batch、source safe stock、receiver reservation、真实 fee 和物理 terminal headroom 的最小值。
- [ ] 5.6 对复合 blocker `insufficient_terminal_resource_or_fee` 重新判断资源短缺与 fee 短缺，避免“需要 staging 才可发送却禁止 staging”的死锁。
- [ ] 5.7 仅为 admitted batch 创建 feed，并通过既有 `replaceCarrierTasksForProducerRoom` 清除 stale draft、保留同 ID `createdAt`。
- [ ] 5.8 补两轮 blocker 恢复回归：persistent transfer task 不重建，receiver 恢复后 feed 自动恢复。
- [ ] 5.9 运行相关测试，确认 GREEN。

## Task 6：补齐运行态与 monitor 可观测性

**Files:**

- Modify: `src/global.d.ts`
- Modify: `src/runtime/resourceControl.ts`
- Modify: `scripts/monitor-service.mjs`
- Modify: `scripts/fixtures/resource-control-monitor.json`
- Create: `scripts/fixtures/resource-control-headroom-monitor.json`
- Create: `scripts/monitor-service.test.ts`
- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`

- [ ] 6.1 先写 runtime 失败断言，覆盖生效水位、eligible receiver 数、receiver 排除原因、reservation、staging admitted/suppressed、sticky headroom 原因和 `capacityIndexBuildCount`。
- [ ] 6.2 先写 monitor 失败测试：新快照正确投影；旧 fixture 缺字段时输出 `null`，不得伪造 `0` 或 `false`。
- [ ] 6.3 运行 `npx jest scripts/monitor-service.test.ts src/runtime/resourceControl.test.ts --runInBand`，确认 RED。
- [ ] 6.4 增加可选 runtime 类型与持久化字段；坚持单次索引构建，不为观测再次扫描任务板。
- [ ] 6.5 更新 monitor summarizer 和 fixture，保持旧快照兼容。
- [ ] 6.6 运行目标测试与 fixture CLI：`node scripts/monitor-service.mjs --once --memory-fixture scripts/fixtures/resource-control-headroom-monitor.json --segment-id off --output off --no-http`。
- [ ] 6.7 确认 GREEN 并勾选对应 OpenSpec 任务。

## Task 7：全量验证、审查与上线观察

**Files:**

- Modify: `openspec/changes/terminal-headroom-recovery/tasks.md`
- Inspect: `dist/main.js`

- [ ] 7.1 运行 `npx tsc --noEmit`。
- [ ] 7.2 运行 `npm run build`。
- [ ] 7.3 运行 `npm test -- --runInBand`，要求不少于基线 79 suites / 2307 tests，且 0 failures。
- [ ] 7.4 对照 proposal、design、两份 delta spec 和 24 项 tasks 做逐项自审，修正遗漏并再次运行受影响测试。
- [ ] 7.5 使用独立代码审查检查 shared policy、一致性账本、feature flag 兼容与 staging/offload 冲突。
- [ ] 7.6 仅在本地验证全部通过后执行 `npm run push`；分别记录本地测试、bundle 构建、推送结果和 live loaded/deploy tag 状态。
- [ ] 7.7 观察至少一个恢复窗口：确认 pressure 房 terminal free 连续增加、receiver 不超配、suppressed 原因可解释、退出 pressure 后无任务抖动。
- [ ] 7.8 将所有已验收项在 OpenSpec tasks 中勾选；若 live 观察尚未完成，明确保留未完成项，不提前宣称 change 完成。
