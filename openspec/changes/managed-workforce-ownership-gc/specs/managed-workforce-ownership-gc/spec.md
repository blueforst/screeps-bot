## ADDED Requirements

### Requirement: Canonical workforce identity 必须可证明且单一来源

系统必须（MUST）以纯 formatter/parser 定义 source、mineral、carrier slot 与 worker slot 的 canonical workforce config identity。只有 configName、role、args 与可选 roomName 全部匹配 canonical 合同的配置才能（MUST）被判定为 bootstrap-owned；identity 模块不得（MUST NOT）读取 Game、Memory、runtimeServices 或 workforce policy。

#### Scenario: 自动 identity 往返一致

- **WHEN** inventory 为 harvester、miner、mineralHarvester、carrier 与 worker 生成 configName
- **THEN** parser 必须还原同一 room、role 与 discriminator，且 payload proof 成功

#### Scenario: 非 canonical 与不匹配 payload fail-safe

- **WHEN** config 使用 manual/emergency/specialized namespace、非规范 slot、role/args 不匹配或 roomName 指向其他房间
- **THEN** ownership proof 必须失败，managed workforce GC 不得修改该配置

#### Scenario: canonical namespace 冲突归 bootstrap

- **WHEN** 手工写入的配置与 canonical workforce name、role、args、roomName 完全相同
- **THEN** 系统必须将该 identity 视为 bootstrap 专属，且不得声称现有 schema 能区分其生产者

#### Scenario: 有效 owner 的 canonical 扩展字段被归一化

- **WHEN** visible managed room 的 canonical config 还携带 body、name、spawnOnce、taskId、powerBankGeneration 或未来非 canonical 字段
- **THEN** GC 必须将其交给 bootstrap，且 canonical upsert 必须替换为仅含 role、args、roomName 的 managed payload

### Requirement: 有效房间 owner 与 workforce policy 必须分离

managed workforce GC 必须（MUST）只用 visible owned managed room 集合判断 identity owner 是否有效。有效 owner 的配置必须完全交给同 tick bootstrap 对账；GC 不得（MUST NOT）重算 expected workforce membership、Source/Mineral 资格、Reserve、Construction、Worker task 或 construction tier effect。

#### Scenario: 可见 managed room 由 bootstrap 独占对账

- **WHEN** normal/industrial room 可见且 controller.my，即使其中存在本 tick 不再 desired 的 canonical config
- **THEN** managed GC 不得修改该 config/queue，稍后的 bootstrap 按角色专用语义完成 reconcile

#### Scenario: Reserved room 停止 canonical workforce 生产

- **WHEN** visible owned room 的 type 为 reserved
- **THEN** 其 canonical workforce owner 必须视为无效，全部同名 queue occurrence 被撤销，idle config 删除，live/spawning config orphan

#### Scenario: Lost 或不可见 room 停止 canonical workforce 生产

- **WHEN** identity room 不再 visible owned managed
- **THEN** 系统必须使用与 reserved 相同的退役事务，且不得为该房重建 workforce inventory

### Requirement: Live 与 spawning 引用必须在清理前统一快照

系统必须（MUST）在 dead creep Memory 或 managed config cleanup 之前统一快照 `Game.creeps` 引用和 `spawn.spawning -> Game.creeps/Memory.creeps` 引用。queue-only 与孤立 Memory.creeps 不得（MUST NOT）作为 live guard。

#### Scenario: 普通 live 与 Game.creeps spawning 保活

- **WHEN** canonical config 被普通 live creep 或 `Game.creeps` 中 spawning creep 引用
- **THEN** owner 失效时 config 必须保留 role/args、移除 roomName 并撤销 queue，而不是被删除

#### Scenario: Spawn memory in-flight 保活

- **WHEN** Spawn 的 `spawning.name` 能通过 `Memory.creeps[name].configName` 精确关联 canonical config，即使该名字暂不在 `Game.creeps`
- **THEN** 引用必须在 Memory cleanup 前被识别，该 creep Memory 与 config 均不得在同次 cleanup 中被误删

#### Scenario: 孤立 Memory 与 queue 不保活

- **WHEN** canonical config 只有无 Spawn/live 对应的 `Memory.creeps` 残留或 queue occurrence
- **THEN** owner 失效时 config 必须删除，所有同名 queue occurrence 必须撤销

### Requirement: Canonical config 与 Spawn queue 必须原子退役

owner 无效的 canonical config 必须（MUST）在一次 managed GC 调用中完成所有 Spawn queue 同名项的稳定过滤，以及 config orphan 或 delete。事务必须（MUST）保持无关 queue FIFO，并且重复执行幂等。

#### Scenario: 多 Spawn 重复 queue 原子收敛

- **WHEN** stale canonical config 同时位于 active/inactive 多个 Spawn 队列的首、中、尾或重复位置
- **THEN** 本次 GC 返回前所有 occurrence 均被移除，其他 configName 在每个 Spawn 内的相对顺序不变

#### Scenario: Manual max-carrier 不被 role-only GC 误删

- **WHEN** `spawnMaxCarrier` 创建的 `room:manual:maxcarrier:tick` carrier 尚在 queue 且没有 live creep
- **THEN** managed workforce GC 必须保留 config 与 queue，后续 Spawn pipeline 可继续执行该手工请求

#### Scenario: 重复运行幂等

- **WHEN** 相同 Game/Memory 状态连续执行两次 ownership GC
- **THEN** 第二次不得进一步改变 config store、queue 或 orphan 状态

### Requirement: 运行时与回滚边界保持不变

本变更不得（MUST NOT）新增 Memory/global schema、runtime service/cache、main phase 或 cleanup interval，也不得修改 spawnPlanner 的通用 CreepConfig 消费、body/priority/prespawn 与角色执行。

#### Scenario: Spawn pipeline 兼容

- **WHEN** valid managed room 的 inventory 经 bootstrap 写入现有 CreepConfig store 后继续运行 schedule/spawn/creep phases
- **THEN** 下游仍只观察既有 configName、role、args、roomName，现有生产与优先级行为保持

#### Scenario: 回滚不需要 schema migration

- **WHEN** 部署后回滚到父提交
- **THEN** 现有 Memory 与 queue 可直接被父版本读取；managed room bootstrap 可在下一 tick重新 upsert canonical config
