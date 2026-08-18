## Why

当前跨房物流由 Hub、Synthesis、PowerBank、容量均衡和生存能量等 producer 分别计算并由 ResourceControl 集中执行，任务缺少显式优先级、容量租约、执行所有权和可恢复 staging 账本，导致重复承诺、长期阻塞、单 receiver 集中与 Hub 容量耦合。`production-logistics-liveness` 必须先消除失效 incoming 假覆盖、重复合成房 assignment 和无 owner 配置漂移；`terminal-headroom-recovery` 的共享 oracle、本地回归和冻结 Memory 边界是纯只读 Shadow 的可用基线，其 6.4 线上恢复周期验收则是任何 contract authority canary 之前必须关闭的独立门槛。

## What Changes

- 每个拥有 storage/terminal 的房间发布带 revision、TTL 和幂等键的最新资源 offer、demand、headroom、energy budget 与 terminal readiness；Hub、Synthesis、PowerBank 和容量均衡只发布策略意图，不直接拥有发送执行权，也不保留追加式意图日志。
- 引入轻量确定性 matcher，依据显式优先级、截止时间、库存保护、容量压力、交易能耗、terminal 等待和公平性，将供需匹配为源到目标的直接路线；Hub 不再是普通物流的必经中转或 matcher 存活前提。
- 引入持久 `TransferContract` 状态机、合同内 source stock commitment 与 receiver `CapacityLease`，统一生存 energy、生产补给、boost、容量泄压、普通均衡和手工 transfer 的进度、幂等、阻塞、退避、改道及恢复语义。
- 每个房间由唯一 LogisticsAgent 选择 staging、send 与 market proposal，但所有 terminal/deal 副作用继续提交给既有 `marketActionArbiter`，不新建第二套 terminal lock/claim；receiver 侧只有该 Agent 可授予 CapacityLease。
- Carrier 工作继续发布到既有 owner-aware `CarrierTaskBoard`，以完整 `CarrierDispatchRef` 标识；持久 StageWorkClaim 只补跨 tick carrying/恢复语义，并与现有 tick-bound `CarrierAmountSlicePort` 通过单一 `executionAuthority` 隔离。
- 用显式 priority class、aging、deadline 和 per-source 公平调度替代 reason 字符串解析；全局 send budget 仅作为 CPU/安全护栏，不能成为固定的跨房公平瓶颈。
- 配置默认为 `disabled`；第一实现切片只允许 `synthesis_room` 发布 latest-state intent，即 room reaction 的 legacy `synthesis:<room>:<product>` reagent demand，并以纯 `shadow` comparator 对照 legacy donor/route/priority/coverage/headroom/预测 staging eligibility 结果。`synthesis_distributed_demand`（`direct/hub-route/resupply`）、`synthesis:surplus:*` 和 `auto:synthesis:*` 兼容 planner 都属后续 Shadow 扩展，首片必须将它们以机器可读 `out_of_scope` 投影而不得静默遗漏。
- Synthesis 必须在写入 legacy task 前冻结不可变的 intent/房间事实输入，并捕获实际 legacy decision；若只能在写入后比较，只允许用稳定 decision/task identity 精确排除已配对的自身 commitment，不得按 reason 前缀或房间+资源宽泛排除。
- 纯 Shadow 中 legacy 仍是唯一 `executionAuthority`；Shadow 只可写入有界 intent/comparator/runtime 投影，不创建 active contract、CapacityLease 或 StageWorkClaim，不修改 legacy task/授权，不向 terminal/deal arbiter 新增 actor、claim 或 side effect。首片以相同 fixture 的 `disabled`/`shadow` 可观察状态差分及 send/deal mock 调用差分验收：除 `Memory.data.resourceControl.logistics` 与 `Memory.runtime.resourceControl.logistics` 外，legacy task、CarrierTaskBoard、arbiter claim/journal、receiver reservation、terminal/store 和其他 Memory 投影必须一致，send/deal mock 不得出现 Shadow 新增调用。legacy 自身的正常 send/deal 仍被允许，不得被误记为 Shadow side effect。
- 后续 `canary` 只能按 `(origin, sourceRoom)` 双重 allowlist 转移单一执行权，不允许只按 targetRoom 开启；回滚也不是瞬时布尔开关，而是带 requestId、scope 和可恢复 phase 的持久请求，global reset 后必须续跑当前阶段。
- 首个 Shadow 线上门槛为剔除 warmup 后至少 100 个连续可观测 tick：包含 Shadow 成本的同口径 ResourceControl phase p95 CPU 不得高于部署前基线 110%（增幅不超过 10%），`Memory.data.resourceControl.logistics` 与 `Memory.runtime.resourceControl.logistics` 的 UTF-8 JSON 序列化字节数合计不得超过 32 KiB；live 投影还必须持续显示 `effectiveAuthority=legacy`、active contract/lease/claim store 为零、无归属于 Logistics Shadow 的 arbiter actor/claim/journal 记录和可观察 invariant violation。首片没有跨模块瞬时 attempt instrumentation，这些证据不得被表述为能够发现已经回滚、释放或失败且未留下状态的 attempt。
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
