## Context

`nukerControl` 当前把 Storage `energyTarget` 当作创建 Nuker Energy 任务的硬门槛。E6N59 在 tick 72882630 为非储备状态，Nuker Energy 为 0，Storage 为 196,795、配置 target 为 200,000，Terminal 为 21,376、reserve 为 20,000；虽然房间仍远高于默认 120,000 `energyFloor`，运行态仍因 Storage 略低于 target 得到 `safeEnergy = 0`。

Carrier task board 按 priority 数值降序选择，Nuker Energy 当前为 40，低于现有生产代码中的正常任务，但任务类型本身没有最低层隔离。Carrier 还会保留仍可执行的既有 assignment，因此仅调整数值不能保证新出现的正常任务覆盖尚未取货的 Nuker Energy 路径。

## Goals / Non-Goals

**Goals:**

- 让非 `RESERVE` 房间在高于生存 `energyFloor` 时利用本地安全余量渐进填充 Nuker。
- 保留 Storage floor、Terminal reserve、生产预留、跨房 outgoing 和其他 Carrier 承诺。
- 将单次计划和预留限制为标准 Carrier 的 1000 容量。
- 让同 tick 的实际 pickup 与普通携能 fallback 共享原子任务额度，执行总量不突破草案和安全池。
- 让 Nuker Energy 的新 pickup 在代码结构上晚于所有正常物流，同时在物流空闲时可执行。
- 保留已接受 pickup 的快照交付和既有 Carrier replacement retirement 行为。

**Non-Goals:**

- 不为 Nuker Energy 创建跨房任务，不改变 Ghodium 生产与补给。
- 不新增 aging、最低服务比例或完成 SLA。
- 不修改 Carrier task board 数据结构、Memory schema、Carrier 数量或主循环阶段。
- 不保证正常物流永久繁忙时 Nuker Energy 在有限 tick 内完成。

## Decisions

### 1. 用 energyFloor 取代 energyTarget 作为 Storage admission 门槛

仅当 `storageEnergy >= energyFloor` 时计算安全余量：

`safeEnergy = max(0, (storageEnergy - energyFloor) + max(0, terminalEnergy - terminalEnergyReserve) - otherReservations - pendingOutgoing - otherCarrierCommitments)`

Storage 低于 floor 时整个安全池仍为 0，Terminal 余量不能掩盖房间生存缺口。相比完全取消门槛，这能防止后台武器补给抽干房间；相比继续使用 target，它允许 E6N59 这类健康但尚未恢复到目标库存的房间工作。

### 2. 每次仅发布一个标准 Carrier 批次

Energy `plannedAmount` 额外受 `STANDARD_CARRIER_MAX_CAPACITY` 限制，因此 task steps 总量和同 holder 的 production reservation 均不超过 1000。复用身体策略的唯一常量，避免另建重复配置。

### 3. 用瞬时原子 claim 约束实际执行总量

任务板为每个 `roomName + taskId` 建立仅当前 `Game.time` 有效的瞬时额度账本。领取时同时检查任务所有步骤总额与目标步骤额度，并在单线程 tick 内先原子占用、再写 Screeps intent：

- `withdraw` 或 fallback `transfer` 返回 `OK` 时将 active claim 提交为本 tick 已消费额度；本 tick 后续 Carrier 只能领取剩余额度。
- `ERR_NOT_IN_RANGE`、其他失败或异常立即释放 active claim，允许真正可执行的 Carrier 使用额度。
- 同 tick 以相同任务 ID 刷新草案时保留已提交消费，避免通过 refresh 重置 1000 上限；删除任务会释放尚未提交的 active claim，但不会抹掉已经接受的 intent。
- claim 所属 Creep 已从 `Game.creeps` 消失时可回收其额度；无论成功、清理或死亡，整个瞬时账本都在下一 tick 自动失效。下一轮由真实 store、Carrier 在途快照和新草案重新计算，不写持久 Memory。

Nuker Energy 的任务 pickup 与普通已携 Energy fallback 共用该账本，所以两条入口无法分别消费完整 1000。成功 pickup 仍把目标和资源写入既有 snapshot，额度账本只解决当前 tick 原子性，不替代跨 tick 交付状态。

### 4. 用选择阶段而不是魔法数保证最低优先级

`NUKER_ENERGY_SUPPLY_PRIORITY` 降为 0，用于任务展示和同类排序；真正的最低优先级由 Carrier source 阶段保证：

1. 保留既有 Power Bank、紧急 Lab、关键 Energy、Power Spawn、Nuker Ghodium 与普通 Energy 顺序。
2. 通用任务选择显式过滤掉 Nuker Energy，执行所有可运行的非 Nuker-Energy board task，不依赖其 priority 数值。
3. 执行 dead-store 清理。
4. 保留现有 newer replacement retirement 门禁。
5. 单独尝试 Nuker Energy。
6. 最后进入既有 idle Energy fallback。

正常任务过滤会忽略尚未 withdraw 的旧 Nuker assignment，并允许新的正常 candidate 覆盖 assignment。成功 withdraw 后，Carrier 直接依靠已有 pending target/resource 快照完成交付，即使 producer 因 Reserve 或水位变化删除草案也不改送。

### 5. 最终可执行定义为空闲窗口进展

当普通 Energy target、所有非 Nuker-Energy board task、dead-store 与 replacement retirement 均无动作，且 Nuker Energy 步骤仍可运行时，Carrier MUST 在该 tick 尝试其 pickup。持续存在的正常物流允许该后台任务持续等待；不通过 aging 抬升优先级。

## Risks / Trade-offs

- [Storage 可能从 target 逐步下降到 floor] → floor 是既有生存边界，所有正常物流始终优先，Reserve 仍会阻止继续领取。
- [1000 草案可能需要较多往返才能填满 Nuker] → 这是降低资源锁定和 Carrier 压力的预期代价。
- [瞬时 claim 不跨 tick 持久化] → 成功 pickup 由既有在途快照承接；下一 tick 的真实库存与 carried amount 会生成新草案，避免长期锁和陈旧 claim。
- [持续正常负载可能让后台任务长期等待] → 规范明确采用 quiescent eventual，而不是与绝对最低优先级矛盾的有界 SLA。

## Migration Plan

1. 更新规划和 Carrier 选择测试，确认 E6N59 精确回归及全部安全边界。
2. 完成代码、TypeScript、构建和 OpenSpec 严格校验。
3. 后续获准部署时观察 `Memory.runtime.nukerControl.rooms.E6N59`、task amount、reservation 和 Carrier assignment；异常时回滚代码即可，无持久数据迁移。

## Open Questions

无。
