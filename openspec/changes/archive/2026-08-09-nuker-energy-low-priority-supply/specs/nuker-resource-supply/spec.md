## MODIFIED Requirements

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

#### Scenario: 任务刷新发生在 Energy 取货后
- **WHEN** Carrier 已成功接受 Nuker Energy withdraw，下一 tick 因 Reserve 或重新规划不再发布原步骤
- **THEN** Carrier 仍按 pickup 快照把所携 Energy 送入原 Nuker

#### Scenario: 满仓房间的 Carrier 已携带普通 Energy
- **WHEN** Carrier 已携带 Energy、没有普通供能目标、Storage/Terminal 无法接收，且存在有效的 Nuker Energy 步骤
- **THEN** Carrier 将不超过该步骤额度的 Energy 送入 Nuker；普通供能目标一旦存在仍优先于该兜底
