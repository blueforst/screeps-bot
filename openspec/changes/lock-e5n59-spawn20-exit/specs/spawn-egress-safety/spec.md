## ADDED Requirements

### Requirement: E5N59 Spawn20 仅允许北侧出生
系统 MUST 在 E5N59 的 Spawn20 启动任何 creep 出生时，将 `SpawnOptions.directions` 精确设置为 `[TOP]`，且 MUST NOT 包含南侧或其他回退方向。

#### Scenario: Spawn20 启动 carrier 出生
- **WHEN** E5N59/Spawn20 从有效配置启动 carrier
- **THEN** `spawnCreep` 接收既有 body、name 与 memory，并额外接收 `directions: [TOP]`

#### Scenario: Spawn20 启动非 carrier 出生
- **WHEN** E5N59/Spawn20 从有效配置启动任意其他 role
- **THEN** 相同的 `directions: [TOP]` 约束仍然生效

#### Scenario: 北侧出口临时繁忙
- **WHEN** creep 完成出生时 E5N59/Spawn20 的北侧出口被判定为 busy
- **THEN** 出生 directions 不得回退到南侧封闭格，并由 Screeps 原生出生机制等待北侧可用

### Requirement: 非目标 Spawn 保持默认方向语义
系统 MUST 仅对房间名与 Spawn 名同时匹配 E5N59/Spawn20 的实例应用该特例。其他 Spawn 的 `spawnCreep` options MUST NOT 新增 `directions` 字段。

#### Scenario: E5N59 的其他 Spawn 启动出生
- **WHEN** E5N59/Spawn15 或该房间其他 Spawn 启动 creep 出生
- **THEN** options 保持既有 memory 内容且不包含 `directions`

#### Scenario: 其他房间的 Spawn 启动出生
- **WHEN** 非 E5N59 房间的任意 Spawn 启动 creep 出生
- **THEN** options 保持既有默认方向行为

### Requirement: 出生管线边界保持不变
该特例 MUST NOT 修改 Spawn 队列内容或顺序、CreepConfig、body、creep name、Creep Memory、transient config 生命周期、main phase 顺序或 role 执行逻辑。

#### Scenario: 目标 Spawn 成功接受请求
- **WHEN** E5N59/Spawn20 的 `spawnCreep` 返回 `OK`
- **THEN** 既有队列 shift、CPU 记录与 transient config 清理语义保持不变

#### Scenario: 目标 Spawn 拒绝请求
- **WHEN** E5N59/Spawn20 的 `spawnCreep` 返回非 `OK`
- **THEN** 既有 `_lastSpawnFail` 记录与队列重试语义保持不变
