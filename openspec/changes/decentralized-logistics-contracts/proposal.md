## Why

当前跨房物流由 Hub、Synthesis、PowerBank、容量均衡和生存能量等 producer 分别计算并由 ResourceControl 集中执行，任务缺少显式优先级、容量租约、执行所有权和可恢复 staging 账本，导致重复承诺、长期阻塞、单 receiver 集中与 Hub 容量耦合。P0 恢复 terminal headroom 后，需要把调度从“全局队列直接驱动动作”升级为“房间发布事实与意图、全局轻量匹配、房间自治执行”的可扩展合同模型。

## What Changes

- 每个拥有 storage/terminal 的房间发布带 revision、TTL 和幂等键的最新资源 offer、demand、headroom、energy budget 与 terminal readiness；Hub、Synthesis、PowerBank 和容量均衡只发布策略意图，不直接拥有发送执行权，也不保留追加式意图日志。
- 引入轻量确定性 matcher，依据显式优先级、截止时间、库存保护、容量压力、交易能耗、terminal 等待和公平性，将供需匹配为源到目标的直接路线；Hub 不再是普通物流的必经中转或 matcher 存活前提。
- 引入持久 `TransferContract` 状态机、合同内 source stock commitment 与 receiver `CapacityLease`，统一生存 energy、生产补给、boost、容量泄压、普通均衡和手工 transfer 的进度、幂等、阻塞、退避、改道及恢复语义。
- 每个房间由唯一 LogisticsAgent 仲裁 staging、`terminal.send` 和会占用 terminal/cooldown 的 market action；receiver 侧只有该 Agent 可授予 CapacityLease；carrier 使用带 `contractId`、数量和过期时间的持久 StageWork claim，避免重复 withdraw 与过量装载。
- 用显式 priority class、aging、deadline 和 per-source 公平调度替代 reason 字符串解析；全局 send budget 仅作为 CPU/安全护栏，不能成为固定的跨房公平瓶颈。
- 通过 feature flag 和兼容适配器分阶段把现有 resource-transfer v2 tasks 迁移为 contract；保留 console transfer API、库存保护、市场规则和主循环阶段顺序。
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
- 调整 `src/runtime/carrierTaskBoard.ts`、`src/roles/carrier.ts` 与 assignment state，加入 contract-scoped staging claim 和 global reset 恢复。
- 扩展 `src/global.d.ts`、`Memory.data`/`Memory.runtime` schema、`scripts/monitor-service.mjs` 及对应测试。
- 依赖 `terminal-headroom-recovery` 提供的共享容量策略与安全容量投影；不新增外部依赖，不改变 Screeps API，不执行市场清仓，也不引入跨 shard 或跨房 creep 搬运。
