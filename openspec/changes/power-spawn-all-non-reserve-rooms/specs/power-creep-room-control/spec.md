## MODIFIED Requirements

### Requirement: 能力房间的 carrier 供能策略
系统 SHALL 仅在具备 `OPERATE_EXTENSION` Power Creep 能力的房间调整 Spawn 和 Extension 的供能来源。Power Spawn 的加工补给所有权 SHALL 由房间是否符合非储备加工资格独立决定，不得再以该 Power Creep 能力作为前置条件。

#### Scenario: 能力房间始终跳过 Spawn
- **WHEN** carrier 为具备该能力的房间选择 Energy 投递目标
- **THEN** carrier 不得选择 Spawn

#### Scenario: PC 控制健康时跳过 Extension
- **WHEN** PC 已孵化、位于归属房间、房间 Power 已启用且控制心跳新鲜
- **THEN** carrier 不得选择 Extension

#### Scenario: PC 控制失效时回退
- **WHEN** 具备能力的 PC 暂时不可用或控制心跳过期
- **THEN** carrier 恢复 Extension 供能但仍不得选择 Spawn

#### Scenario: 无 PC 能力的非储备 Power Spawn 使用专用补给
- **WHEN** 己方非储备房间拥有己方 Power Spawn，但没有 `OPERATE_EXTENSION` Power Creep 能力
- **THEN** 通用 Energy 投递不得选择该 Power Spawn，系统 SHALL 由 Power Spawn 专用加工补给策略管理其 Power 和 Energy

## ADDED Requirements

### Requirement: PowerSpawn 加工补给覆盖所有非储备己方房间
系统 SHALL 为所有当前可见、己方控制、拥有己方 Power Spawn 且不处于储备模式的房间，通过 carrier task board 补充加工所需 Power 和 Energy，并使用 20% 低水位与 90% 高水位滞回。该补给资格 MUST NOT 依赖 Power Creep 是否存在或是否具备 `OPERATE_EXTENSION`。普通 Carrier Energy 目标 MUST NOT 与有效的专用 Power Spawn 补给重复派工。

#### Scenario: 无 PC 能力房间的 Power 低于低水位
- **WHEN** 非储备己方房间拥有己方 Power Spawn，该结构的 Power 低于容量 20%，房间有可用 Power 库存且没有具备 `OPERATE_EXTENSION` 的 PC
- **THEN** 系统发布补至满仓的 `power_spawn_supply` Power 步骤

#### Scenario: 非 Hub 房间的 Energy 低于低水位
- **WHEN** 非储备非 Hub 己方房间拥有己方 Power Spawn，该结构的 Energy 低于容量 20% 且房间有可用 Energy 库存
- **THEN** 系统发布补至满仓的 `power_spawn_supply` Energy 步骤

#### Scenario: 补给任务处于滞回区间
- **WHEN** 既有 Power Spawn 补给步骤尚未完成且对应资源已达到 20% 但低于 90%
- **THEN** 系统继续发布该资源步骤，避免任务在临界值反复出现和消失

#### Scenario: 补给资源达到高水位
- **WHEN** Power Spawn 的 Power 和 Energy 均达到各自容量的 90%
- **THEN** 系统清除该房间的 `power_spawn_supply` 任务

#### Scenario: 房间进入储备模式
- **WHEN** Power Spawn 所在房间出现 `RESERVE` 或 `RESERVE_<room>` Flag
- **THEN** 系统不得发布新的加工补给任务，并清理该房间既有的 `power_spawn_supply` 任务

#### Scenario: 房间不再符合己方结构资格
- **WHEN** 房间不可见、Controller 不再属于己方或房间不存在己方 Power Spawn
- **THEN** 系统不得保留该房间的 `power_spawn_supply` 任务

### Requirement: PowerSpawn 自动加工覆盖所有非储备己方房间
系统 SHALL 允许所有当前可见、己方控制、拥有己方 Power Spawn 且不处于储备模式的房间，在资源满足基础加工成本时每 tick 至多尝试加工一次。加工资格 MUST NOT 依赖房间名、Hub 身份、Power Creep 是否存在或其技能。

#### Scenario: 非 Hub 无 PC 房间资源充足
- **WHEN** 非储备非 Hub 己方房间的己方 Power Spawn 至少有 1 Power 和 50 Energy，且房间没有 Power Creep 能力
- **THEN** 系统在该 tick 至多调用一次该 Power Spawn 的 `processPower()`

#### Scenario: 任一加工资源不足
- **WHEN** 合格房间 Power Spawn 的 Power 小于 1 或 Energy 小于 50
- **THEN** 系统不得调用该 Power Spawn 的 `processPower()`

#### Scenario: 储备房间资源充足
- **WHEN** 己方 Power Spawn 资源充足但所在房间处于储备模式
- **THEN** 系统不得调用该 Power Spawn 的 `processPower()`

#### Scenario: 非己方或无 Power Spawn 房间
- **WHEN** 可见房间的 Controller 不属于己方，或己方房间没有己方 Power Spawn
- **THEN** 系统不得为该房间调用 `processPower()` 或发布加工补给任务

## REMOVED Requirements

### Requirement: PowerSpawn 加工补给仅限 E4N58
**Reason**: 单一 Hub 白名单与所有非储备己方房间就地加工 Power 的新运营策略冲突。

**Migration**: 改用“PowerSpawn 加工补给覆盖所有非储备己方房间”要求；E4N58 继续作为普通合格房间运行，不再享有特殊准入。

### Requirement: PowerSpawn 自动加工仅限 E4N58
**Reason**: 非 Hub 房间已经拥有 Power Spawn 和本地 Power 库存，继续禁止加工会让资源长期闲置。

**Migration**: 改用“PowerSpawn 自动加工覆盖所有非储备己方房间”要求；以己方结构和储备 Flag 取代房间名与 PC 能力门禁。
