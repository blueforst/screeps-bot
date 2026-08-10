# Typed Room Workforce Inventory 规格

## Purpose

定义房间托管劳动力的临时类型化清单、稳定配置身份、Worker 建造滞回效果，以及 bootstrap 与 17-tick 清理之间的阶段隔离边界。

## Requirements

### Requirement: Workforce inventory 使用稳定的 typed config identity

系统必须（MUST）为每个可见、owned managed room 构建临时 `RoomWorkforceInventory`。inventory 必须按 source、eligible mineral、carrier slot、worker slot 的既有顺序包含判别联合 config specs；每个 spec 必须携带当前稳定 `configName`、role 与 args，且不得（MUST NOT）改变 `room:role:sourceId|mineralId|slot` 身份语法。

#### Scenario: Source 与 Mineral payload 只解释一次

- **WHEN** 房间同时包含 linked/unlinked Source 和符合/不符合资格的 Mineral
- **THEN** inventory 只为当前 Source role 与 eligible Mineral 生成 specs，bootstrap 使用 spec payload 写配置且不重新查询 Link 或 Mineral 资格

#### Scenario: 枚举顺序保持

- **WHEN** 房间有多个 Source、Mineral、Carrier 与 Worker intents
- **THEN** config specs 保持 source → mineral → carrier slot → worker slot 及各组原始发现/index顺序

#### Scenario: 持久配置不泄漏 plan metadata

- **WHEN** bootstrap 将 inventory adapter 写入 `Memory.data.creepConfigs`
- **THEN** config 仍只使用既有 `CreepConfig` 字段，且不包含 kind、source、slot、construction tier effect 或 plan revision

### Requirement: Construction tier effect 保持现有滞回语义

inventory 构建必须（MUST）显式返回 `preserve` 或 `set(0..3)` construction tier effect，并且构建过程不得（MUST NOT）写 `RoomMemory.workerConstructionTier`。调用者必须只在 inventory 完整生成后提交 effect。

#### Scenario: Reserve 保持旧 tier

- **WHEN** managed room 处于 `RESERVE` 或 `RESERVE_*` Flag 所在房间
- **THEN** inventory 不包含 Worker specs、effect 为 preserve，现有 construction tier 不被写零或重算

#### Scenario: RCL8 重置 tier

- **WHEN** 非 Reserve managed room 为 RCL8
- **THEN** inventory 包含恰好一个 Worker spec、effect 为 set(0)，提交后 RoomMemory tier 为 0

#### Scenario: 建造滞回与 normal repair bonus 保持

- **WHEN** construction site 数量跨过 1/6/15 上升或 0/4/12 下降边界，或已发布 task board 含 active normal-repair task
- **THEN** Worker spec 数量与当前上限、RCL 基线、滞回和单个 repair bonus 规则一致

### Requirement: Bootstrap 每房消费单一 inventory

`bootstrapRooms` 对每个 visible owned managed room 每 tick 必须（MUST）至多构建一次 inventory，并以同一对象完成 expected membership、upsert、source transition 与 role-specific cleanup。它不得（MUST NOT）重新判断 Source Link、Mineral eligibility、Reserve 或从 configName prefix 重建 upsert payload。

#### Scenario: Source handoff 生命周期保持

- **WHEN** Source 在 harvester 与 miner role 之间切换
- **THEN** 新 spec 使用相同 sourceId 稳定身份创建，旧 config 按现有 orphan、queue cleanup、replacement-live 后 retirement 顺序处理

#### Scenario: 角色专用退役保持

- **WHEN** Worker 缩编或进入 Reserve、Carrier 从 RCL4 的两名缩到 RCL5 的一名
- **THEN** surplus Worker 继续 orphan 且不 suicide，Carrier config 继续立即删除，所有现有 queue cleanup 语义保持

#### Scenario: 外援 Source 抑制保持

- **WHEN** colonization bootstrap 或 rescue 正为目标房提供 Source workforce
- **THEN** bootstrap 从同一 inventory expected set 中抑制本地 Source specs，同时继续维护 Mineral、Carrier 与 Worker specs

### Requirement: Bootstrap 必须独占 workforce policy 解释

`bootstrapRooms` 必须（MUST）是 visible owned managed room 的唯一 workforce policy 解释者。17-tick cleanup 只可依赖纯 canonical identity 和有效 room owner，不得（MUST NOT）构建 inventory、投影 expected names、读取 Worker task board 或提交 construction tier effect。

#### Scenario: Cleanup 与 task refresh 同 tick

- **WHEN** Game tick 同时命中 17-tick cleanup 与 3-tick Worker task refresh
- **THEN** cleanup 不得提前删除或创建 managed-room workforce config，refresh 后 bootstrap 以当前 task board 构建一次 inventory 并提交最终结果

#### Scenario: Cleanup 不产生 workforce policy 副作用

- **WHEN** periodic cleanup 处理任意数量的 managed config
- **THEN** 它不得扫描房间 Source、Mineral、Construction Site，不得创建/读取 Worker task board，也不得写 `workerConstructionTier`

#### Scenario: Compatibility projection 被移除

- **WHEN** 生产代码与测试需要观察 expected managed identities
- **THEN** bootstrap 使用 `RoomWorkforceInventory.configs`，且系统不得保留供 cleanup 重建 policy 的 `getExpectedManagedConfigNames` 入口

### Requirement: 下游与运行时边界保持不变

本变更不得（MUST NOT）修改 main phase 顺序、task refresh 周期、Memory/global schema、spawnPlanner 的通用 CreepConfig 消费、body/priority/prespawn 或角色执行。

#### Scenario: Spawn pipeline 兼容

- **WHEN** inventory 经 bootstrap 写入现有 CreepConfig store 后运行 `scheduleSpawnTasks` 与 `spawnWork`
- **THEN** 下游只观察现有 configName、role、args、roomName，并保持跨 Spawn 唯一 owner 与当前优先级行为

#### Scenario: 回滚无需迁移

- **WHEN** 部署后需要回滚到父提交
- **THEN** 无需转换 Memory、queue 或 Creep identity，父版本可在下一 tick 使用同一持久配置继续对账
