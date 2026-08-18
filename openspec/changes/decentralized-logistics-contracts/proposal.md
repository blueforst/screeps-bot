## Why

当前跨房物流由 Hub、Synthesis、PowerBank、容量均衡和生存能量等 producer 分别计算并由 ResourceControl 集中执行，任务缺少显式优先级、容量租约、执行所有权和可恢复 staging 账本，导致重复承诺、长期阻塞、单 receiver 集中与 Hub 容量耦合。`terminal-headroom-recovery` 恢复物理容量后，还必须先由 `production-logistics-liveness` 消除失效 incoming 假覆盖、重复合成房 assignment 和无 owner 配置漂移；只有这两层 P0 成为可信基线后，才进入合同 Shadow。

## What Changes

- 每个拥有 storage/terminal 的房间发布带 revision、TTL 和幂等键的最新资源 offer、demand、headroom、energy budget 与 terminal readiness；Hub、Synthesis、PowerBank 和容量均衡只发布策略意图，不直接拥有发送执行权，也不保留追加式意图日志。
- 引入轻量确定性 matcher，依据显式优先级、截止时间、库存保护、容量压力、交易能耗、terminal 等待和公平性，将供需匹配为源到目标的直接路线；Hub 不再是普通物流的必经中转或 matcher 存活前提。
- 引入持久 `TransferContract` 状态机、合同内 source stock commitment 与 receiver `CapacityLease`，统一生存 energy、生产补给、boost、容量泄压、普通均衡和手工 transfer 的进度、幂等、阻塞、退避、改道及恢复语义。
- 每个房间由唯一 LogisticsAgent 选择 staging、send 与 market proposal，但所有 terminal/deal 副作用继续提交给既有 `marketActionArbiter`，不新建第二套 terminal lock/claim；receiver 侧只有该 Agent 可授予 CapacityLease。
- Carrier 工作继续发布到既有 owner-aware `CarrierTaskBoard`，以完整 `CarrierDispatchRef` 标识；持久 StageWorkClaim 只补跨 tick carrying/恢复语义，并与现有 tick-bound `CarrierAmountSlicePort` 通过单一 `executionAuthority` 隔离。
- 用显式 priority class、aging、deadline 和 per-source 公平调度替代 reason 字符串解析；全局 send budget 仅作为 CPU/安全护栏，不能成为固定的跨房公平瓶颈。
- 第一实现切片只让 Synthesis 发布 latest-state intent，并以纯 Shadow comparator 对照 legacy route/priority/capacity 结果；不创建 active lease/contract authority，也不发送。后续再通过 feature flag 和兼容适配器按 origin/room 迁移。
- 在三项核心能力内增加 intent/contract/lease/claim 的运行时观测、状态耗时、吞吐、公平性、安全不变量和 CPU 指标，并覆盖 global reset、部分完成、cooldown、租约过期和孤儿货物恢复。

## Capabilities

### New Capabilities

- `resource-transfer-contract-lifecycle`: 最新状态型供需意图、确定性 matcher、显式 priority、TransferContract 幂等进度、source commitment、阻塞退避、改道和旧任务迁移。
- `receiver-capacity-leases`: receiver 房间基于 P0 安全 headroom 授予、续约、消费和回收跨 tick CapacityLease。
- `room-logistics-agent-execution`: 每房单一 LogisticsAgent、contract-aware staging window、持久 carrier claim、terminal/market 仲裁和 reset 恢复。

### Modified Capabilities

无。仓库当前没有已同步到 `openspec/specs/` 的基线物流能力规格；本变更复用但不修改 P0 变更中的共享 headroom 行为约束。

## Impact

- 新增 `src/runtime/logistics/` 下的 latest-intent index、matcher、contract/lease store、RoomLogisticsAgent 与迁移适配模块。
- 调整 `src/runtime/resourceControl.ts`、`hubPlanner.ts`、`synthesisControl.ts`、`powerBankBoost.ts` 和 console transfer producer，使其发布意图或创建兼容 contract。
- 复用 `src/runtime/carrierTaskBoard.ts`、Dispatch Ownership 的完整 ref/同 tick amount slice 与 `src/roles/carrier.ts` 既有选择链；新增 contract-scoped 持久 claim adapter 和 global reset 恢复，不建立平行 task board。
- 在现有 owner 分支下增加 versioned Memory adapter 与 `scripts/monitor-service.mjs` 投影；遵守冻结的四个 Memory 根声明指纹，不直接扩 `src/global.d.ts` 或 canonical root declaration。
- 依赖 `terminal-headroom-recovery` 的共享容量策略、`production-logistics-liveness` 的 demand coverage/合成配置 ownership，以及 `local-dispatch-ownership` 的 Carrier identity/board/amount slice。Terminal side effect 必须复用 `marketActionArbiter` 与 Energy ownership；不新增外部依赖、不执行市场清仓，也不引入跨 shard 或跨房 creep 搬运。
- `local-dispatch-ownership` 的“未部署”任务状态已与 Git ancestry/后续 bundle 部署证据发生漂移；P1 只把其代码接口视为现有基线，部署前另做只读证据审计，不再安排所谓首次全量切换。
