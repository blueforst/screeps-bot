## ADDED Requirements

### Requirement: 动态发现 Power Creep 房间能力
系统 SHALL 从 Power Creep 的持久化房间归属和实际技能等级动态生成房间能力，不得使用具体房间名白名单。

#### Scenario: 拥有 OPERATE_EXTENSION 的已归属 PC
- **WHEN** Power Creep 已归属一个己方房间且 `PWR_OPERATE_EXTENSION` 等级大于零
- **THEN** 系统将该房间标记为具备 Extension 接管能力

#### Scenario: 无对应技能的房间
- **WHEN** 房间没有已归属且拥有 `PWR_OPERATE_EXTENSION` 的 Power Creep
- **THEN** 系统保持该房间原有 carrier 供能行为

### Requirement: 自动建立通用房间归属
系统 SHALL 将 `PowerCreepMemory.homeRoom` 作为归属事实，并可从匹配己方 Power Spawn 房间的 Power Creep 名称或其当前有效房间进行一次性引导。

#### Scenario: PC 名称对应己方 Power Spawn 房间
- **WHEN** 未归属 Power Creep 的名称对应一个可见己方且拥有 Power Spawn 的房间
- **THEN** 系统持久化该房间为 PC 的 `homeRoom`

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
系统 SHALL 自动孵化已归属 PC、启用归属房间，并在寿命低于 200 tick 时优先续命。

#### Scenario: 已归属 PC 尚未孵化
- **WHEN** 归属房间拥有可用的己方 Power Spawn 且 PC 不在孵化冷却中
- **THEN** 系统调用 PC 的 `spawn()`

#### Scenario: 房间尚未启用 Power
- **WHEN** 已孵化 PC 位于归属房间且 Controller 未启用 Power
- **THEN** 系统插入并执行 `enable_room` 任务

#### Scenario: 寿命低于阈值
- **WHEN** PC 的 `ticksToLive` 小于 200
- **THEN** 系统插入唯一的最高优先级 `renew` 任务并在归属房间 Power Spawn 上执行

### Requirement: OPS 生成和卸载
系统 SHALL 在 `GENERATE_OPS` 冷却完成时立即入队，并在 OPS 接近满载或不足以容纳下一次产出时向 storage 卸载至约半仓。

#### Scenario: GENERATE_OPS 冷却完成
- **WHEN** `PWR_GENERATE_OPS` 的 cooldown 为零且队列中没有对应任务
- **THEN** 系统插入 `generate_ops` 任务

#### Scenario: OPS 达到高水位
- **WHEN** PC 携带 OPS 达到总容量 90% 或剩余容量小于下一次生成量
- **THEN** 系统插入唯一卸载任务，并在成功后使 PC 保留约总容量 50% 的 OPS

### Requirement: OPERATE_STORAGE 调度
系统 SHALL 将 `OPERATE_STORAGE` 作为最高优先级的普通技能，并通过提前归位和 OPS 解锁保证 Storage effect 在游戏机制允许的最早 tick 续上。

#### Scenario: Storage 尚无效果
- **WHEN** 已归属 PC 拥有 `PWR_OPERATE_STORAGE` 且 Storage 没有有效同类 effect
- **THEN** 系统持续保留唯一的最高普通优先级 `operate_storage` 任务，并让 PC 返回范围 3 内等待可执行条件

#### Scenario: 冷却完成而旧效果仍有效
- **WHEN** `PWR_OPERATE_STORAGE` cooldown 为零但 Storage 旧 effect 尚未结束
- **THEN** 系统提前插入维护任务并让 PC 停留在范围 3 内，不得提前覆盖旧 effect

#### Scenario: 维护任务缺少 OPS
- **WHEN** `operate_storage` 维护任务因 OPS 少于 100 暂不可执行
- **THEN** 系统允许已就绪的 `GENERATE_OPS` 越过该任务，同时阻止 `REGEN_SOURCE` 和 `OPERATE_EXTENSION` 把 PC 调离 Storage

#### Scenario: Storage 效果到期且技能可用
- **WHEN** Storage 的旧 effect 消失、技能 cooldown 为零且 PC 拥有至少 100 OPS
- **THEN** 系统在第一个可执行 tick 使用 `PWR_OPERATE_STORAGE` 并完成当前维护任务

### Requirement: REGEN_SOURCE 交替调度
系统 SHALL 对归属房间两个 Source 按稳定顺序交替使用 `REGEN_SOURCE`，在 cooldown 完成时立即为下一 Source 入队并提前归位，且仅在成功施法后切换目标。

#### Scenario: cooldown 完成时下一 Source 仍有旧效果
- **WHEN** `PWR_REGEN_SOURCE` cooldown 为零且下一 Source 的旧 effect 仍有效
- **THEN** 系统立即为该 Source 插入唯一任务，并在没有更高优先级任务阻止时移动到技能范围内等待

#### Scenario: 等待旧效果结束
- **WHEN** 已入队的目标 Source 仍有有效 `PWR_REGEN_SOURCE` effect
- **THEN** 系统保留任务且不得提前调用 `usePower()`，不得因为旧 effect 仍存在而删除任务

#### Scenario: 旧效果结束后的首个可执行 tick
- **WHEN** 已入队目标的旧 effect 消失、技能 cooldown 为零且 PC 拥有足够 OPS
- **THEN** 系统在首个可执行 tick 调用 `usePower()`，并仅在返回 `OK` 后将下一目标切换到另一个 Source

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
- **THEN** 系统以有能量的 storage、terminal 或 container 为目标插入唯一任务

### Requirement: 能力房间的 carrier 供能策略
系统 SHALL 仅在具备 `OPERATE_EXTENSION` Power Creep 能力的房间调整 Spawn、Extension 和 Power Spawn 的供能来源。

#### Scenario: 能力房间始终跳过 Spawn
- **WHEN** carrier 为具备该能力的房间选择能源投递目标
- **THEN** carrier 不得选择 Spawn

#### Scenario: PC 控制健康时跳过 Extension
- **WHEN** PC 已孵化、位于归属房间、房间 Power 已启用且控制心跳新鲜
- **THEN** carrier 不得选择 Extension

#### Scenario: PC 控制失效时回退
- **WHEN** 具备能力的 PC 暂时不可用或控制心跳过期
- **THEN** carrier 恢复 Extension 供能但仍不得选择 Spawn

### Requirement: Power Spawn carrier 任务
系统 SHALL 为能力房间的 Power Spawn 通过 carrier 任务板批量补充 Power 和 Energy，且不得与通用能源目标重复派工。

#### Scenario: Power 低于低水位
- **WHEN** Power Spawn 的 Power 低于容量 20% 且房间有可用 Power 库存
- **THEN** 系统发布补至满仓的 `power_spawn_supply` 步骤

#### Scenario: Energy 低于低水位
- **WHEN** Power Spawn 的 Energy 低于容量 20% 且房间有可用 Energy 库存
- **THEN** 系统发布补至满仓的 `power_spawn_supply` 步骤

#### Scenario: 非能力房间
- **WHEN** 房间没有具备 `OPERATE_EXTENSION` 的已归属 Power Creep
- **THEN** 系统不发布该房间的 Power Spawn 专用任务且保留原有通用供能逻辑

### Requirement: Power Spawn 自动加工
系统 SHALL 在能力房间 Power Spawn 资源满足基础加工成本时每 tick 尝试加工一次。

#### Scenario: Power 和 Energy 充足
- **WHEN** Power Spawn 至少有 1 Power 和 50 Energy
- **THEN** 系统调用一次 `processPower()`

#### Scenario: 任一资源不足
- **WHEN** Power Spawn 的 Power 小于 1 或 Energy 小于 50
- **THEN** 系统不得调用 `processPower()`
