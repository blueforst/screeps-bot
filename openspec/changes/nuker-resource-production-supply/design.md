## Context

项目当前已经具备三段可复用能力：Hub/Distributed Synthesis 负责从基础矿和中间物规划反应链，ResourceControl 的持久任务负责跨房 Terminal 转运，Carrier 任务板负责房内结构间搬运。Nuker 尚未接入其中任何一段；直接把 Ghodium 从仓库搬入 Nuker 还会绕过 Hub 的生产承诺，而把 Energy 无条件搬入 Nuker 会降低房间生存和生产库存。

`RESERVE` 是由房间内 `RESERVE`/`RESERVE_*` Flag 决定的既有运行状态。该状态只禁止 Nuker Energy 新补给，不禁止战略 Ghodium 储备。Nuker 发射、目标选择和市场购买不属于本变更。

## Goals / Non-Goals

**Goals:**

- 对全部可见己方 Nuker 自动维持满容量 Ghodium。
- 复用现有跨房转运和 Carrier 任务，不新增旁路物流执行器。
- 让尚未装入 Nuker 的 Ghodium 容量进入现有反应链需求，库存不足时自动生产 `G`。
- 非 `RESERVE` 房间只用安全能量余量逐步填充 Nuker，保留房间能量目标、Terminal 储备及既有承诺。
- 让任务、预留、生产需求和阻塞状态可在 Memory 中核对。

**Non-Goals:**

- 不自动发射 Nuker，不选择或保存攻击目标。
- 不为 Nuker 自动从市场购买 Ghodium、基础矿或 Energy。
- 不自动建造 Nuker，不改变 `RESERVE` Flag 的生命周期。
- 不降低现有 T3、Boost、Factory、Terminal 或市场安全门槛。

## Decisions

### 1. 在 Hub Planner 前运行独立 NukerControl

新增 `nukerControl` 主循环阶段，顺序为 `productionMonitor -> nukerControl -> hubPlanner -> synthesisControl`。该阶段扫描己方房间与 Nuker、发布房内 Carrier 草案、创建必要的 Ghodium 跨房转运任务，并更新运行态需求。Hub Planner 因而能在同 tick 看到新转运承诺和 Nuker 生产需求。

备选方案是把全部逻辑塞进 Carrier 或 Hub Planner；前者无法表达跨房生产需求，后者会混合结构补给与反应链职责，因此不采用。

### 2. Ghodium 缺口作为反应链的附加消耗需求

账号级附加需求定义为所有己方 Nuker 的真实未装载容量之和：

`nukerGhodiumDemand = sum(nuker.store.getFreeCapacity(RESOURCE_GHODIUM))`

该数值不减去 Storage/Terminal 库存或 pending transfer，因为 `planHubChains` 已在 available inventory 中计算这些实物；将完整未装载量加到 `needed[G]`，可使现有 Ghodium 先抵扣 Nuker 需求，余下部分再经 `ZK + UL -> G` 生产。Ghodium 进入 Nuker 后会同时离开普通库存并减少未装载量，不会重复生产。

Hub 的 T3 目标仍先按现有合同传播需求，随后把附加 Ghodium 消耗叠加到同一 `needed` 图。Distributed Synthesis 使用同一附加需求，确保多房分配不会绕过它。

### 3. 本房搬运优先，跨房转运只补净缺口

NukerControl 先从目标房间 Storage/Terminal 发布 Ghodium Carrier 步骤，并扣除已经由 Carrier 携带到该 Nuker 的数量。若 `Nuker 缺口 - 本房可搬运库存 - pending incoming Ghodium` 仍为正，再按安全可用量、转运成本和房间名稳定选择 donor，创建 `automatic` ResourceTransferTask。

Donor 可用量扣除矿物 floor、有效生产预留、pending outgoing，以及 donor 自己的 Nuker Ghodium 缺口。新任务继续由 ResourceControl 的 receiver capacity、Terminal staging、发送费用和 action arbiter 校验，不直接调用 `terminal.send`。

### 4. Energy 仅使用安全余量且不创建跨房需求

处于 `RESERVE` 的房间不发布新的 Nuker Energy 步骤。普通状态下：

Storage 必须先达到 `energyTarget`；随后分别只计算 Storage 超出 target 和 Terminal 超出 reserve 的部分：

`safeEnergy = max(0, max(0, storageEnergy - energyTarget) + max(0, terminalEnergy - terminalEnergyReserve) - productionReservations - pendingOutgoing - otherCarrierCommitments)`

当 Storage 低于 target 时上述安全余量整体视为 0；实际步骤还受源结构实存约束。Energy 只做房内搬运，不因 Nuker 缺口创建跨房 Energy 任务。这样 E4N58 等低于能量目标的房间会等待恢复，而能量富余房间会逐步装填。

### 5. 复用 Carrier 任务板并显式保护库存

任务板新增 `nuker_supply` 类型和 `nuker` 结构类型。Ghodium 步骤在 Spawn/Extension/Tower 紧急能量及 Power Spawn 补给之后、普通能量需求之前获得专门选择机会；Nuker Energy 使用低优先级普通任务，避免压制 Lab、Terminal 和房间能量需求。

每个本地步骤为对应资源建立短 TTL production reservation，并在任务消失、结构丢失或房间不再可见时释放。Carrier 已接受的 pickup 继续依靠现有快照交付，避免任务刷新导致资源送错位置。

### 6. 运行态记录以实况为准

`Memory.runtime.nukerControl` 保存总 Ghodium 生产需求、每房 Nuker ID、容量、缺口、`reserveMode`、安全能量余量、pending incoming、Carrier task 数和最近动作。需求首次出现、归零或发生一个 Nuker 容量级变化时触发 Hub 提前重规划；其余变化由既有 planning cadence 吸收，避免每次 Carrier 投递都重跑重型规划。

## Risks / Trade-offs

- [Nuker Ghodium 会占用原本用于 Ghodium 系 T3 的矿物和 Lab 时间] → 把它建模为显式附加需求，让 Hub 同时看到两类消耗并补产，而不是暗中挪用库存。
- [自动跨房任务可能与既有 synthesis route 重叠] → 净缺口扣除全部 pending incoming，donor 扣除 pending outgoing，并使用现有任务合并与容量账本。
- [`RESERVE` 在 Carrier 已取出 Energy 后出现] → 停止新 pickup；已接受的一车继续按快照交付，避免携带态资源丢失或改送。
- [Hub 被关闭或基础矿不足] → 继续搬运已有 Ghodium并记录生产阻塞，不启用隐式市场购买。
- [重型 Hub Planner 被需求微小变化频繁唤醒] → 仅在首次需求、需求归零或容量级变化时设置 `needsPlan`，常规变化依赖 50 tick cadence。

## Migration Plan

1. 先加入纯规划、Carrier 草案、`RESERVE` 和能量安全余量单元测试。
2. 接入主循环，完成 TypeScript、全量测试、构建和 OpenSpec 严格校验。
3. 提交并部署到 shard1；确认新部署标签、Nuker runtime、Ghodium transfer/Carrier task、Hub Ghodium 链需求，以及低能量房间没有 Nuker Energy 任务。
4. 若线上出现异常，回滚该部署即可；新增任务均带自动 origin/producer，可由既有清理逻辑回收，不需要迁移持久配置。

## Open Questions

无。
