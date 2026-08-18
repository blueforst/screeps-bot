## Context

当前 `Memory.data.resourceControl.tasks` 同时承担发送账本、库存预留和生产需求覆盖。`isHealthyResourceTransferTaskReservation()` 对 incoming 只会在 `source_depleted` 超过宽限后失效，因此长期 `receiver_capacity` 阻塞仍会被 Hub/Synthesis 当作即将到货；但 ReceiverCapacityLedger 会立即排除这类任务。生产规划与物理 admission 因而对同一任务给出相反结论。

分布式合成的 planner 还把 `usedRooms` 只作为 `-300` 软惩罚。同一房间可能收到多个 `dispatchAssignments`，而 `Memory.cfg.synthesisControl.rooms[room].reactions` 每次只写一个反应，导致较早 assignment 的路线、allocation ledger 和保护事实仍存在，实际产线却被后一个产品覆盖。

本变更是 `decentralized-logistics-contracts` 前的 P0 基线修复。它必须保持 canonical 37-phase 顺序、legacy task 执行权、现有 `marketActionArbiter` 和本地 CarrierTaskBoard，不引入新的 Terminal side effect。

## Goals / Non-Goals

**Goals:**

- 让所有生产规划消费者共用同一个“任务是否仍覆盖需求”的纯判定。
- 让长期 receiver-capacity 阻塞的 automatic task 有界退出，并在保留审计记录的同时允许重新选择 donor。
- 保证一个 synthesis 房间在一个 Hub plan revision 内最多承诺一个 active product。
- 给 Hub 写入的房间反应配置增加 owner/revision，并只回收自己拥有的旧配置。
- 让 coverage 失效、blocked target、重复 assignment 和配置 reconcile 可诊断且有界。

**Non-Goals:**

- 不实现 TransferContract、CapacityLease、RoomLogisticsAgent、持久 StageWorkClaim 或新 matcher。
- 不改变合成目标、T3 储备、反应配方、Factory 策略、PowerSpawn 策略或市场价格。
- 不重排 `src/main.ts`，不新增 Global API，不执行 live Memory 迁移命令。
- 不解决 Terminal Energy/bootstrap、Factory 跨房补料或普通 Lab/Factory 多 Carrier 数量切片；这些保留给后续 change。

## Decisions

### 1. 把 demand coverage 与物理 reservation health 分开

新增唯一纯判定 `countsResourceTransferTaskTowardDemand(task, options)`，供 `getIncomingResourceTransferAmount`、`ResourceTransferTaskAmountIndex.getIncoming`、Synthesis pending coverage 和 Hub route/import 去重共同使用：

- 非 pending 不覆盖需求；
- manual pending 始终覆盖需求，保持人工意图语义；
- automatic `source_depleted` 只在现有 source-depleted grace 内覆盖；
- automatic `receiver_capacity` 只在新的 `receiverCapacityDemandCoverageGraceTicks` 内覆盖；
- 其他 pending blocker 继续覆盖，最终仍受现有 no-progress TTL 约束。

默认 receiver coverage grace 为 500 tick，可在 `resourceControl.capacityBalancing` 配置，范围 50–5,000。选择独立窗口而不是复用 5,000 tick no-progress TTL，是为了允许生产在十个默认 Hub plan 周期后重选 donor，同时不改变其他 supply/fee blocker 的存活语义。

`reconcileResourceTransferTasks` 在 automatic receiver-capacity coverage 到期后把原任务置为 `cancelled`，原因固定为 `automatic_receiver_capacity_coverage_timeout`；终态记录继续按既有 TTL 保留。automatic task merge 必须跳过已经 coverage-expired 的候选，防止 Hub/Synthesis 在 ResourceControl phase reconciliation 之前把新需求重新累加到即将取消的旧任务。Outgoing 库存保护仍按现有规则计算，不把“需求已允许重规划”误解为同 tick 可释放已 staging 货物。

不选择仅从 incoming 合计中排除而保留旧任务可发送：那会让新旧 donor 在条件恢复后重复交付同一需求。

### 2. Pending 观测与 demand coverage 使用不同计数

完整 pending task 数仍表示真实账本积压；新增 demand-covering incoming 计数供 Synthesis 的 `pendingTasks`/Hub liveness 使用。Monitor 必须同时显示 raw pending 与 coverage-expired，不能用较小的 coverage 数隐藏仍待清理的旧任务。

### 3. `usedRooms` 是硬约束，写配置前再做一次不变量校验

`assignStepToRoom` 必须过滤已在当前 plan revision 中使用的房间，而不是降低分数。planner 输出后再以稳定 room key 验证 assignment 唯一性；如果仍发现重复，整个 distributed plan 必须 fail closed：不写 reaction config、不创建/刷新 route、不提交包含幽灵 assignment 的保护事实，并投影机器可读违规。

不采用“保留得分最高的一条并丢弃其余”修复，因为 allocation ledger 已在逐步分配时扣减；事后裁剪会留下与实际配置不一致的资源承诺。

### 4. Hub-managed synthesis config 使用窄 owner/revision 元数据

在房间 synthesis config 增加可选 `plannerOwnership`：

```ts
{
  owner: "hubPlanner";
  hubRoomName: string;
  revision: number;
}
```

Hub planning attempt 的 `attemptRevision` 传入 distributed config writer。每次实际写入房间 reaction 时原子刷新 ownership；旧的无 owner 配置仍按当前可重写门禁被首次采用并打标，以保持现有自动规划行为。reconcile 只清理 `owner=hubPlanner` 且 `hubRoomName` 相同、revision 旧于当前、当前计划不再选择、并且房间 stage 可安全重写的配置；人工/未知 owner 永不清理，busy 房只记录 skipped 并等待下一 revision。

### 5. 观测只投影执行事实，不反向驱动规划

`Memory.runtime.resourceControl.taskSummary` 增加 coverage-expired incoming 数；`Memory.runtime.hub.distributedSynthesis` 增加 `blockedTargets`、有界 `invariantViolations` 和本轮 config reconciliation 摘要。Monitor 对缺失字段输出 `null`/空兼容值，不伪造旧快照已通过新不变量。planner 不读取这些投影作为事实。

### 6. 保持 phase 与 side-effect 边界

所有逻辑留在现有 Hub/Synthesis/ResourceControl phase。Terminal send/deal 仍只经 `marketActionArbiter`；本变更不会增加 action 数，也不会修改 Carrier task 优先级。Hub planner 仍早于 ResourceControl，因此 coverage 判定必须只依赖 task 自身和 `Game.time`，不能依赖尚未运行的本 tick reconciliation。

### 7. 新字段通过 owner-local adapter 接入冻结的 Memory 声明边界

仓库的 `Memory.cfg/runtime/data/analytics` canonical declarations 由 protected fingerprint 与 500-case budget 同时冻结，本 change 不修改这些声明或测试基线。`receiverCapacityDemandCoverageGraceTicks` 只由 ResourceTransferTask/ResourceControl 配置 adapter 解析；`plannerOwnership` 只由 HubPlanner owner adapter 读写；新增 runtime 诊断只由对应 producer adapter 与 Monitor 动态投影访问。调用方不得散落新的裸 cast 或把这些字段升级为公共 Global API；若未来要把它们纳入 canonical declaration，必须另立 Memory schema/budget 变更。

## Risks / Trade-offs

- **[500 tick 后任务 churn]** Receiver 长期无容量时 planner 可能周期性重建任务 → 旧任务先失去 merge 资格并在同 tick 后续 reconciliation 取消；runtime 计数和测试限制重复 active coverage。
- **[配置 owner 首次采用误认人工计划]** 旧自动/人工配置没有来源标记 → 首次仅在现有 `canRewriteSynthesisRoom` 允许时采用，不主动清理 ownerless 配置；之后才按 owner/revision 回收。
- **[硬唯一约束降低并发链覆盖]** 链步骤多于可用房间时部分步骤不会同轮执行 → 这反映一房一反应的物理事实；blocked target/未分配步骤必须可见，下一 planning revision 再调度。
- **[保护 snapshot 与写入中途异常]** duplicate/foreign assignment 在相关 config、allocation 与 distributed route 写入前 fail closed；其余合法计划若在后续保护 snapshot 构建中因畸形旧 Memory 抛错，仍发布 invalid protection，但本 change 不把整个旧 Hub import/config 写链事务化，部署前必须以 strict protection/错误日志门禁观察。
- **[额外扫描]** 新 coverage 统计可能重复遍历 tasks → 在现有 amount index/task contribution 构建时累计，Monitor 只读投影；聚焦测试锁定单轮有界扫描。

## Migration Plan

1. 先加入纯判定、配置项和定向测试；旧 Memory 缺字段时使用 500 tick 默认值。
2. 接入 amount index、Synthesis pending coverage、Hub 去重与 automatic merge/reconcile；不改变 Terminal 执行路径。
3. 加入 assignment 硬约束、二次 validator、owner/revision 和 reconcile 观测。
4. 运行相关 Jest、TypeScript、build、OpenSpec strict 与独立审查。
5. 部署前记录当前 blocked incoming、Hub assignment/config 和 CPU；部署后确认没有 duplicate assignment、coverage-expired 任务会取消/重建且 protection snapshot 仍 consistent。

回滚为部署旧 bundle；owner-local adapter 的新增 cfg/runtime 字段均可选，旧代码会忽略。被新版本取消的 automatic task 不自动复活；如需恢复，只由旧 planner 在下一周期按真实缺口重新创建，避免重放已交付量。

## Open Questions

无阻塞问题。500 tick 默认 coverage grace 可在 Shadow/live 证据下后续收窄或放宽，但不得取消有界性与单一 active coverage 不变量。
