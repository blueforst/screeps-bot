## ADDED Requirements

### Requirement: 未归属 PC 按同名房间自动归属
系统 SHALL 保留显式 `homeRoom` 兼容入口；对于没有 `homeRoom` 的 Power Creep，系统 SHALL 仅在同名房间可见、Controller 属于己方且拥有己方 PowerSpawn 时自动建立归属。

#### Scenario: 同名己方房间拥有 PowerSpawn
- **WHEN** Power Creep 名称等于一个可见己方房间名，且该房间拥有己方 PowerSpawn
- **THEN** 系统将该房间持久化为 PC 的 `homeRoom`

#### Scenario: 已有显式归属
- **WHEN** PC 已有显式持久化的 `homeRoom`
- **THEN** 系统保留该归属，不以名称自动覆盖

#### Scenario: 同名房间没有 PowerSpawn
- **WHEN** 未归属 PC 名称对应的己方房间没有己方 PowerSpawn
- **THEN** 系统不建立自动归属、不尝试孵化或启用其他房间，且不得回退到 PC 当前房间

### Requirement: 同名 PC 自动孵化和启用房间
系统 SHALL 使用归属房间的己方 PowerSpawn 自动孵化可孵化的同名 PC，并在出生后自动为未启用 Power 的归属房间去重入队并执行 `enable_room`。

#### Scenario: 同名 PC 尚未出生
- **WHEN** 同名 PC 已建立合格归属、当前未出生、位于当前 shard 或未绑定 shard，且不在孵化冷却中
- **THEN** 系统在归属房间的己方 PowerSpawn 调用一次 `spawn()`

#### Scenario: Controller 尚未启用 Power
- **WHEN** 同名 PC 已出生且归属房间 Controller 的 `isPowerEnabled` 为 false
- **THEN** 系统保留唯一 `enable_room` 任务并调用 `enableRoom()`，不在范围内时向 Controller 寻路

#### Scenario: Controller 已启用 Power
- **WHEN** 归属房间 Controller 的 `isPowerEnabled` 为 true
- **THEN** 系统不保留或重复执行 `enable_room` 任务

### Requirement: PowerSpawn 加工仅限 E4N58
系统 SHALL 当前仅允许 E4N58 的 PowerSpawn 获得加工资源补给并调用 `processPower()`；其他房间 PowerSpawn SHALL 只供 PC 孵化和续命使用。

#### Scenario: E4N58 加工资源充足
- **WHEN** E4N58 具备相应 PC 能力，且 PowerSpawn 至少有 1 Power 和 50 Energy
- **THEN** 系统每 tick 至多调用一次 `processPower()`

#### Scenario: E4N58 加工资源低于补给水位
- **WHEN** E4N58 具备相应 PC 能力且 PowerSpawn 的 Power 或 Energy 低于既有补给水位
- **THEN** 系统按既有滞回规则发布 E4N58 的 `power_spawn_supply` 任务

#### Scenario: 其他房间资源充足
- **WHEN** 非 E4N58 房间拥有己方 PowerSpawn、同名 PC 能力且加工资源充足
- **THEN** 系统不得调用该 PowerSpawn 的 `processPower()`，也不得发布该房间的 `power_spawn_supply` 任务
