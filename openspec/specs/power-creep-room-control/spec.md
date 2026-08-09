# power-creep-room-control 规范

## Purpose

定义 Power Creep 的房间归属、生命周期、持久任务队列、房间技能调度、交通协作与当前 PowerSpawn 加工范围。

## Requirements

### Requirement: 动态发现 Power Creep 房间能力
系统 SHALL 从 Power Creep 的持久化房间归属和实际技能等级动态生成房间能力，不得使用具体房间名白名单生成能力。

#### Scenario: 拥有 OPERATE_EXTENSION 的已归属 PC
- **WHEN** Power Creep 已归属一个己方房间且 `PWR_OPERATE_EXTENSION` 等级大于零
- **THEN** 系统将该房间标记为具备 Extension 接管能力

#### Scenario: 无对应技能的房间
- **WHEN** 房间没有已归属且拥有 `PWR_OPERATE_EXTENSION` 的 Power Creep
- **THEN** 系统保持该房间原有 carrier 供能行为

### Requirement: 未归属 PC 仅按同名房间自动归属
系统 SHALL 将 `PowerCreepMemory.homeRoom` 作为归属事实并保留已有显式归属。对于没有 `homeRoom` 的 Power Creep，系统 SHALL 仅在同名房间可见、Controller 属于己方且拥有己方 PowerSpawn 时自动建立归属，不得回退到 PC 当前房间。

#### Scenario: PC 名称对应己方 PowerSpawn 房间
- **WHEN** 未归属 Power Creep 的名称对应一个可见己方且拥有己方 PowerSpawn 的房间
- **THEN** 系统持久化该房间为 PC 的 `homeRoom`

#### Scenario: 已有显式归属
- **WHEN** PC 已有显式持久化的 `homeRoom`
- **THEN** 系统保留该归属，不以名称自动覆盖

#### Scenario: 同名房间没有 PowerSpawn
- **WHEN** 未归属 PC 名称对应的己方房间没有己方 PowerSpawn
- **THEN** 系统不建立自动归属、不尝试孵化或启用其他房间，且不得采用 PC 当前房间

### Requirement: Power Creep 任务队列
系统 SHALL 为每个 Power Creep 维护持久化、去重、按优先级选择的任务队列，并由 PC 在接到任务后自行寻路。

#### Scenario: 重复调度同一任务
- **WHEN** 相同稳定任务 ID 已经处于队列中
- **THEN** 系统不插入第二份任务

#### Scenario: 多个任务同时可执行
- **WHEN** 队列中存在不同优先级的可执行任务
- **THEN** 系统先执行优先级更高的任务，并在同优先级时先执行更早创建的任务

#### Scenario: 高优先级技能缺少 OPS
- **WHEN** 高优先级技能任务暂时缺少 OPS 且 `GENERATE_OPS` 可执行
- **THEN** 系统保留高优先级任务并允许执行 `GENERATE_OPS`，不得形成队首死锁

#### Scenario: PC 同房移动和等待让路
- **WHEN** PC 正在同房前往任务目标，或已在技能范围内等待执行条件
- **THEN** 系统使用通用交通协议协调 `Creep | PowerCreep` 占位；移动中的 PC 保留路径优先，等待中的 PC 可被普通 creep 推到相邻可走位置

#### Scenario: Storage 范围内等待时被推让
- **WHEN** 等待 `OPERATE_STORAGE` 的 PC 阻挡普通 creep 且 Storage 范围内存在可走让路位置
- **THEN** 系统优先将 PC 推到仍位于 Storage 实际技能范围内的位置

### Requirement: Power Creep 生命周期自动化
系统 SHALL 自动孵化已建立合格归属的 PC、启用归属房间，并在寿命低于 200 tick 时优先续命。

#### Scenario: 已归属 PC 尚未孵化
- **WHEN** 归属房间拥有可用的己方 PowerSpawn，PC 位于当前 shard 或尚未绑定 shard，且不在孵化冷却中
- **THEN** 系统在归属房间的 PowerSpawn 调用一次 PC `spawn()`

#### Scenario: 未出生 PC 的 TTL 为 NaN
- **WHEN** 运行时为未出生 PC 暴露非有限 `ticksToLive`，且 PC 没有 `room` 和 `pos`
- **THEN** 系统将其视为未出生，并在通过 shard 与孵化冷却检查后尝试 `spawn()`

#### Scenario: 有限 TTL 边界
- **WHEN** PC 的 `ticksToLive` 为有限的 0 或正数
- **THEN** 系统不得仅因 TTL 值进入孵化分支；若 `room` 或 `pos` 尚未暴露，则安全等待下一 tick

#### Scenario: 房间尚未启用 Power
- **WHEN** 已孵化 PC 的归属房间 Controller 未启用 Power
- **THEN** 系统保留唯一 `enable_room` 任务并调用 `enableRoom()`，不在范围内时向 Controller 寻路

#### Scenario: 房间已经启用 Power
- **WHEN** 归属房间 Controller 的 `isPowerEnabled` 为 true
- **THEN** 系统不保留或重复执行 `enable_room` 任务

#### Scenario: 寿命低于阈值
- **WHEN** PC 的 `ticksToLive` 小于 200
- **THEN** 系统插入唯一的最高优先级 `renew` 任务并在归属房间 PowerSpawn 上执行

### Requirement: OPS 生成和卸载
系统 SHALL 在 `GENERATE_OPS` 冷却完成时立即入队，并在 OPS 接近满载或不足以容纳下一次产出时向 Storage 卸载至约半仓。

#### Scenario: GENERATE_OPS 冷却完成
- **WHEN** `PWR_GENERATE_OPS` 的 cooldown 为零且队列中没有对应任务
- **THEN** 系统插入 `generate_ops` 任务

#### Scenario: OPS 达到高水位
- **WHEN** PC 携带 OPS 达到总容量 90% 或剩余容量小于下一次生成量
- **THEN** 系统插入唯一卸载任务，并在成功后使 PC 保留约总容量 50% 的 OPS

### Requirement: OPERATE_STORAGE 调度
系统 SHALL 将 `OPERATE_STORAGE` 作为最高优先级的普通技能，并在 cooldown 完成时立即覆盖同级或更低级的有效同类 effect；只有目标上的有效同类 effect 等级高于当前技能等级时才等待。

#### Scenario: Storage 尚无效果
- **WHEN** 已归属 PC 拥有 `PWR_OPERATE_STORAGE` 且 Storage 没有有效同类 effect
- **THEN** 系统持续保留唯一的最高普通优先级 `operate_storage` 任务，并在技能、OPS 和距离条件满足的首个 tick 执行

#### Scenario: cooldown 完成而旧效果同级或更低级
- **WHEN** `PWR_OPERATE_STORAGE` cooldown 为零且 Storage 存在等级不高于当前技能的有效同类 effect
- **THEN** 系统立即插入并执行维护任务，以新的 effect 覆盖旧 effect，不等待旧 effect 结束

#### Scenario: Storage 存在更高级效果
- **WHEN** `PWR_OPERATE_STORAGE` cooldown 为零且 Storage 存在等级高于当前技能的有效同类 effect
- **THEN** 系统保留唯一维护任务但不得对 Storage 调用 `usePower()`，直到更高级 effect 不再有效，同时不得阻断其他可执行的 effect 任务

#### Scenario: 维护任务缺少 OPS
- **WHEN** `operate_storage` 维护任务因 OPS 少于 100 暂不可执行
- **THEN** 系统允许已就绪的 `GENERATE_OPS` 及其他 runnable 任务按正常优先级越过该任务；当本 tick 选择 `GENERATE_OPS` 或没有位置型 runnable 任务时继续以 Storage 为预定位目标

#### Scenario: Storage 效果缺失且技能可用
- **WHEN** Storage 没有有效同类 effect、技能 cooldown 为零且 PC 拥有至少 100 OPS
- **THEN** 系统在第一个可执行 tick 使用 `PWR_OPERATE_STORAGE` 并完成当前维护任务

### Requirement: REGEN_SOURCE 交替调度
系统 SHALL 对归属房间两个 Source 按稳定顺序交替使用 `REGEN_SOURCE`，在 cooldown 完成时立即为下一 Source 入队；目标上没有有效同类 effect 或 effect 等级不高于当前技能时立即覆盖，只有更高级 effect 才等待，并且仅在成功施法后切换目标。

#### Scenario: cooldown 完成时下一 Source 为同级或更低级效果
- **WHEN** `PWR_REGEN_SOURCE` cooldown 为零且下一 Source 存在等级不高于当前技能的有效同类 effect
- **THEN** 系统立即插入唯一任务并调用 `usePower()` 覆盖旧 effect，不等待其结束

#### Scenario: 下一 Source 存在更高级效果
- **WHEN** 已入队目标存在等级高于当前 `PWR_REGEN_SOURCE` 技能的有效同类 effect
- **THEN** 系统保留任务且不得对该 Source 调用 `usePower()`、不得切换下一目标，直到更高级 effect 不再有效，同时允许其他 runnable 任务继续执行

#### Scenario: 下一 Source 没有有效效果
- **WHEN** 已入队目标没有有效 `PWR_REGEN_SOURCE` effect、技能 cooldown 为零且 PC 满足 OPS 和距离条件
- **THEN** 系统在首个可执行 tick 调用 `usePower()`

#### Scenario: 成功覆盖后轮换
- **WHEN** 对当前 Source 调用 `PWR_REGEN_SOURCE` 返回 `OK`
- **THEN** 系统完成当前任务并将下一目标切换到另一个 Source

### Requirement: REGEN_SOURCE 驱动 miner 体型
系统 SHALL 按房间已归属 Power Creep 的最高 `REGEN_SOURCE` 等级提高本房间 link miner 的 WORK 数，使其能够覆盖技能提升后的 Source 平均产量，且不得硬编码房间名。

#### Scenario: 四级 REGEN_SOURCE 房间
- **WHEN** 房间已归属的 Power Creep 拥有 4 级 `PWR_REGEN_SOURCE`
- **THEN** 系统为该房间 miner 使用至少 12 个 WORK，并保留适配其移动和 link 搬运的 CARRY、MOVE 部件

#### Scenario: 没有 REGEN_SOURCE 的房间
- **WHEN** 房间没有已归属且拥有 `PWR_REGEN_SOURCE` 的 Power Creep
- **THEN** 系统继续使用现有 6 WORK miner 基线体型

#### Scenario: 现役 miner 体型落后
- **WHEN** 现役 miner 与当前技能等级对应的目标体型不同
- **THEN** 系统先安排唯一的新体型替代者，并仅在替代者进入 Source 范围 1 后退役旧体型

#### Scenario: Source 只有一个可站工位
- **WHEN** 旧 miner 位于 Source 范围 1、占据唯一工位，且新体型替代者已抵达旧 miner 相邻格
- **THEN** 系统允许交接并退役旧 miner，使替代者可进入唯一工位，不得因严格要求替代者先进入 Source 范围 1 而死锁

### Requirement: OPERATE_EXTENSION 调度
系统 SHALL 在 Extension 存在能量缺口且技能可用时使用有能量的合法房间结构执行 `OPERATE_EXTENSION`。

#### Scenario: Extension 存在能量缺口
- **WHEN** `PWR_OPERATE_EXTENSION` cooldown 为零且房间 Extension 未满
- **THEN** 系统以有能量的 Storage、Terminal 或 Container 为目标插入唯一任务

### Requirement: 能力房间的 carrier 供能策略
系统 SHALL 仅在具备 `OPERATE_EXTENSION` Power Creep 能力的房间调整 Spawn、Extension 和 PowerSpawn 的供能来源。

#### Scenario: 能力房间始终跳过 Spawn
- **WHEN** carrier 为具备该能力的房间选择 Energy 投递目标
- **THEN** carrier 不得选择 Spawn

#### Scenario: PC 控制健康时跳过 Extension
- **WHEN** PC 已孵化、位于归属房间、房间 Power 已启用且控制心跳新鲜
- **THEN** carrier 不得选择 Extension

#### Scenario: PC 控制失效时回退
- **WHEN** 具备能力的 PC 暂时不可用或控制心跳过期
- **THEN** carrier 恢复 Extension 供能但仍不得选择 Spawn

#### Scenario: PowerSpawn 使用专用加工补给策略
- **WHEN** 房间具备 `OPERATE_EXTENSION` 能力
- **THEN** 通用 Energy 投递不得与 PowerSpawn 专用加工补给重复派工；非加工房间的 PowerSpawn 仅用于 PC 孵化和续命

### Requirement: PowerSpawn 加工补给仅限 E4N58
系统 SHALL 当前仅为 E4N58 的 PowerSpawn 通过 carrier task board 补充加工所需 Power 和 Energy，并使用既有低水位与高水位滞回。其他房间 SHALL NOT 发布 `power_spawn_supply` 任务。

#### Scenario: E4N58 Power 低于低水位
- **WHEN** E4N58 具备相应 PC 能力、PowerSpawn 的 Power 低于容量 20% 且房间有可用 Power 库存
- **THEN** 系统发布补至满仓的 `power_spawn_supply` 步骤

#### Scenario: E4N58 Energy 低于低水位
- **WHEN** E4N58 具备相应 PC 能力、PowerSpawn 的 Energy 低于容量 20% 且房间有可用 Energy 库存
- **THEN** 系统发布补至满仓的 `power_spawn_supply` 步骤

#### Scenario: 其他能力房间
- **WHEN** 非 E4N58 房间拥有己方 PowerSpawn 和具备相应能力的已归属 PC
- **THEN** 系统不得发布该房间的 `power_spawn_supply` 任务

### Requirement: PowerSpawn 自动加工仅限 E4N58
系统 SHALL 当前仅允许 E4N58 的 PowerSpawn 在资源满足基础加工成本时每 tick 至多尝试加工一次；其他房间 PowerSpawn 只供 PC 孵化和续命使用。

#### Scenario: E4N58 Power 和 Energy 充足
- **WHEN** E4N58 具备相应 PC 能力且 PowerSpawn 至少有 1 Power 和 50 Energy
- **THEN** 系统每 tick 至多调用一次 `processPower()`

#### Scenario: E4N58 任一资源不足
- **WHEN** E4N58 PowerSpawn 的 Power 小于 1 或 Energy 小于 50
- **THEN** 系统不得调用 `processPower()`

#### Scenario: 其他房间资源充足
- **WHEN** 非 E4N58 房间拥有己方 PowerSpawn、同名 PC 能力且加工资源充足
- **THEN** 系统不得调用该 PowerSpawn 的 `processPower()`，也不得发布该房间的加工补给任务
