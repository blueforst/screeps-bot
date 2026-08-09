# nuker-resource-supply 规范

## Purpose

定义己方 Nuker 的自动发现、Ghodium 生产与跨房补给，以及非储备状态下的安全 Energy 填充合同。

## Requirements

### Requirement: 自动发现并跟踪己方 Nuker
系统 SHALL 每 tick 发现可见己方房间中的己方 Nuker，并以结构实际 Store 容量和库存计算 Ghodium、Energy 缺口；结构消失或房间失去控制后 MUST 清除对应 Carrier 任务和资源预留。

#### Scenario: 新建 Nuker 被自动纳管
- **WHEN** 己方可见房间出现一个尚未记录的己方 Nuker
- **THEN** 系统在当 tick 创建运行态条目并开始计算其两种资源缺口

#### Scenario: Nuker 消失
- **WHEN** 先前纳管的 Nuker 已不存在或房间不再属于玩家
- **THEN** 系统移除该房间的 Nuker Carrier 草案并释放该 producer 的失效资源预留

### Requirement: Ghodium 本地补给
系统 SHALL 在房间 Storage 或 Terminal 存在可安全搬运的 Ghodium 时发布到 Nuker 的 Carrier 任务，目标为填满 Nuker 的 Ghodium 容量；计算草案时 MUST 扣除已经由 Carrier 携带到该 Nuker 的同资源数量，并 MUST 为草案占用的源库存建立生产资源预留。

#### Scenario: 本房已有足量 Ghodium
- **WHEN** Nuker 缺少 Ghodium，目标房间 Storage/Terminal 有可搬运库存且没有同资源在途 Carrier
- **THEN** 系统发布不超过真实缺口和可用库存的 `nuker_supply` 步骤

#### Scenario: Carrier 已携带 Ghodium
- **WHEN** Carrier 已按已接受的 Nuker 步骤携带 Ghodium 前往目标结构
- **THEN** 新草案扣除该在途数量，不再为同一容量重复取货

### Requirement: Ghodium 跨房转运
系统 SHALL 在本房可搬运库存与 pending incoming 仍不能覆盖 Nuker Ghodium 缺口时，通过现有 automatic ResourceTransferTask 创建跨房补给。Donor 选择 MUST 扣除 mineral floor、生产预留、pending outgoing 和 donor 自身 Nuker 缺口，并 MUST 继续服从 receiver capacity、Terminal staging、发送费用和 action arbiter。

#### Scenario: 其他房间有安全 Ghodium 库存
- **WHEN** 目标 Nuker 的净缺口为正且另一个房间存在扣除全部保护后的 Ghodium
- **THEN** 系统创建不超过净缺口和 donor 安全可用量的 automatic 转运任务

#### Scenario: 已有入站任务
- **WHEN** 目标房间已有足以覆盖净缺口的 pending incoming Ghodium
- **THEN** 系统不得为该缺口重复增加跨房任务

#### Scenario: Donor 自己也有空 Nuker
- **WHEN** 候选 donor 的 Ghodium 需要用于填充本房 Nuker
- **THEN** 该本地缺口从 donor 可用量中扣除，不能被发送给其他房间

### Requirement: Nuker Ghodium 进入生产链
系统 MUST 把所有己方 Nuker 尚未装载的 Ghodium 容量作为 Hub 反应链的附加消耗需求，并与既有 T3 需求在同一库存和分配账本中计算。普通库存足以覆盖组合需求时 MUST 优先使用库存；不足部分 MUST 通过 `ZK + UL -> G` 及必要上游步骤规划生产，且 Distributed Synthesis MUST 使用相同需求。

#### Scenario: 普通库存足以覆盖 Nuker 需求
- **WHEN** 普通结构中的可计入 Ghodium 足以覆盖 Nuker 未装载容量且没有额外下游消耗缺口
- **THEN** 生产链不新增 Ghodium 反应步骤，但该库存仍被 Nuker 附加需求占用

#### Scenario: Ghodium 库存不足
- **WHEN** 现有 Ghodium 小于 T3 传播需求与 Nuker 未装载容量之和，而 ZK 和 UL 可用
- **THEN** Hub 规划生成数量等于组合净缺口的 Ghodium 反应步骤

#### Scenario: Ghodium 已装入 Nuker
- **WHEN** 一批 Ghodium 从普通库存进入 Nuker
- **THEN** 普通库存与未装载容量同步减少，下一轮规划不得为该批资源重复生产

### Requirement: 非储备状态安全填充 Energy
系统 SHALL 仅在 Nuker 所在房间不处于 `RESERVE` 模式且 Storage Energy 不低于房间 `energyFloor` 时发布 Nuker Energy Carrier 步骤。安全余量 MUST 等于 Storage 高于 `energyFloor` 的数量加上 Terminal 高于 `terminalEnergyReserve` 的数量，再扣除其他生产预留、pending outgoing 和其他 Carrier 承诺；Storage 低于 `energyFloor` 时整个安全余量 MUST 为零。可搬运量 MUST 不超过 Nuker 净缺口、源结构实存、安全余量和 `STANDARD_CARRIER_MAX_CAPACITY` 1000，且对应 production reservation MUST 使用相同的至多 1000 数量。同一 tick 内，所有 Carrier 对该任务成功接受的 pickup 与普通已携 Energy fallback 的合计 MUST 同时不超过任务总额和各步骤额度；额度领取 MUST 原子化，失败、放弃或无效目标不得泄漏未消费 claim。系统不得因 Nuker Energy 缺口自动创建跨房 Energy 任务。

#### Scenario: E6N59 略低于 target 但高于 floor
- **WHEN** 非储备房间 Storage 有 196,795 Energy、`energyFloor` 为 120,000、`energyTarget` 为 200,000，Terminal 有 21,376 Energy 且 reserve 为 20,000，没有其他承诺，空 Nuker 缺少 300,000 Energy
- **THEN** 系统计算原始安全余量 78,171，并发布总量 1000 的 Nuker Energy 任务和 production reservation

#### Scenario: Storage 低于生存 floor
- **WHEN** 非储备房间 Storage Energy 低于 `energyFloor`，即使 Terminal 高于 reserve
- **THEN** 系统将 Nuker Energy 安全余量视为零，不发布新 pickup

#### Scenario: 普通状态存在超过单批上限的能量余量
- **WHEN** 非储备房间扣除 floor、Terminal reserve 和全部承诺后仍有超过 1000 Energy，且 Nuker 净缺口也超过 1000
- **THEN** 系统发布的 Energy steps 总量与对应 production reservation 均为至多 1000

#### Scenario: 多 Carrier 在同 tick 竞争单批任务
- **WHEN** 多个 Carrier 在同一 tick 对总额 1000 的 Nuker Energy 任务尝试 pickup 或普通携能 fallback
- **THEN** 系统以原子 claim 缩小或拒绝后续动作，使所有成功接受的 Energy 合计不超过 1000，且各来源步骤也不被超领

#### Scenario: claim 失败与生命周期释放
- **WHEN** Carrier 的 withdraw/transfer 返回失败或未到达、任务被清理、claim 所属 Creep 死亡，或者成功动作进入下一 tick
- **THEN** 未消费 claim 立即释放，已成功消费的额度在当前 tick 内继续阻止重复消费，并在下一 tick 由最新 store、在途快照和新草案重新核算

#### Scenario: 同 tick 任务刷新
- **WHEN** Carrier 已成功消费部分任务额度后，producer 在同一 tick 用相同任务 ID 刷新步骤
- **THEN** 已消费额度继续计入该任务的当前 tick 总额，新 Carrier 不得借刷新重复领取

#### Scenario: 房间处于储备状态
- **WHEN** Nuker 房间存在 `RESERVE` 或 `RESERVE_*` Flag
- **THEN** 系统不发布新的 Nuker Energy pickup 步骤并清理失效预留，但 Ghodium 补给仍继续

#### Scenario: 既有承诺占用安全余量
- **WHEN** 非储备房间存在生产预留、pending outgoing 或从 Storage/Terminal 取货的其他 Carrier 承诺
- **THEN** 系统在计算 Nuker Energy 任务前扣除这些数量，且不得突破 Storage floor 或 Terminal reserve

#### Scenario: Terminal 仅剩储备
- **WHEN** Terminal Energy 不高于 `terminalEnergyReserve`
- **THEN** Terminal 不得贡献 Nuker Energy 安全余量或成为该步骤的可用来源

### Requirement: Carrier 优先级与任务稳定性
系统 MUST 让 Nuker Ghodium 补给在 Spawn/Extension/Tower 紧急能量和 Power Spawn 补给之后、普通能量需求之前获得执行机会。Nuker Energy 的公开 priority MUST 为 0，且新 pickup MUST 在所有普通 Energy target、所有非 Nuker-Energy Carrier board task、dead-store 清理和既有 replacement retirement 门禁之后单独选择，不得依赖其他任务的数值 priority 来维持最低级。尚未接受 withdraw 的 Nuker Energy assignment MUST 能被新出现的正常任务覆盖；已接受的 pickup MUST 继续送往原 Nuker，不能因草案消失或 Reserve 切换而改送其他结构。当上述更高层工作均不可执行且 Nuker Energy 步骤可执行时，Carrier MUST 尝试该后台 pickup；系统不以 aging 或 SLA 提升其优先级。

#### Scenario: 紧急房间能量与 Ghodium 同时缺少
- **WHEN** Spawn、Extension 或低水位 Tower 有紧急 Energy 需求且 Nuker 缺少 Ghodium
- **THEN** Carrier 先处理紧急 Energy，再处理 Nuker Ghodium

#### Scenario: Ghodium 与普通能量目标同时存在
- **WHEN** 没有紧急能量或 Power Spawn 任务，Nuker Ghodium 与普通结构 Energy 需求均可执行
- **THEN** Carrier 选择 Nuker Ghodium 步骤

#### Scenario: 正常任务使用更低数值 priority
- **WHEN** Nuker Energy priority 为 0，另一个可执行的非 Nuker-Energy board task 即使使用小于或等于 0 的 priority
- **THEN** Carrier 仍先选择该正常任务

#### Scenario: 新正常任务覆盖未取货的旧 assignment
- **WHEN** Carrier 已记住一个仍可运行但尚未 withdraw 的 Nuker Energy assignment，随后出现可执行的正常 board task
- **THEN** Carrier 覆盖旧 assignment 并执行正常任务，不继续前往 Nuker Energy 来源

#### Scenario: dead-store 与 Nuker Energy 同时可执行
- **WHEN** 没有普通 Energy target 和正常 board task，但存在可清理的 dead-store 资源及可执行的 Nuker Energy 步骤
- **THEN** Carrier 先清理 dead-store，不领取 Nuker Energy

#### Scenario: 物流进入空闲窗口
- **WHEN** 普通 Energy target、非 Nuker-Energy board task、dead-store 和 replacement retirement 均无动作，且 Nuker Energy 步骤可执行
- **THEN** Carrier 在该 tick 尝试领取 Nuker Energy；无需等待 aging

#### Scenario: 任务刷新发生在取货后
- **WHEN** Carrier 已成功接受 Nuker 资源 withdraw，下一 tick producer 不再发布原步骤
- **THEN** Carrier 仍按 pickup 快照把所携资源送入原 Nuker

#### Scenario: 任务刷新发生在 Energy 取货后
- **WHEN** Carrier 已成功接受 Nuker Energy withdraw，下一 tick 因 Reserve 或重新规划不再发布原步骤
- **THEN** Carrier 仍按 pickup 快照把所携 Energy 送入原 Nuker

#### Scenario: 满仓房间的 Carrier 已携带普通 Energy
- **WHEN** Carrier 已携带 Energy、没有普通供能目标、Storage/Terminal 无法接收，且存在有效的 Nuker Energy 步骤
- **THEN** Carrier 将不超过该步骤额度的 Energy 送入 Nuker；普通供能目标一旦存在仍优先于该兜底

### Requirement: Nuker 补给可观测
系统 SHALL 在 `Memory.runtime.nukerControl` 中记录总 Ghodium 生产需求和每房 Nuker 的结构 ID、两种资源容量/库存/缺口、Reserve 状态、安全 Energy 余量、pending incoming、Carrier task 数及有界最近动作。需求首次出现、归零或变化达到一个 Nuker Ghodium 容量时 MUST 请求 Hub 提前重规划。

#### Scenario: 空 Nuker 首次被发现
- **WHEN** 系统首次观察到一个 Ghodium 未装满的己方 Nuker
- **THEN** runtime 记录其完整缺口并把 Hub `needsPlan` 置为 true

#### Scenario: 小批投递进行中
- **WHEN** Ghodium 需求仅因单次 Carrier 投递产生小于一个 Nuker 容量的变化
- **THEN** runtime 更新真实缺口，但不要求每次投递都额外触发重型 Hub 规划
