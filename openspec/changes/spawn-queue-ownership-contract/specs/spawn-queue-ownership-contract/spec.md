# spawn-queue-ownership-contract Specification

## Purpose
规定 Spawn 调度屏障结束时 configName 的单一队列所有权、inactive failover、in-flight 清理和确定性迁移语义，避免同一逻辑生产槽重复出生或 one-shot 卡在不可执行 Spawn。

## ADDED Requirements

### Requirement: 每个配置必须只有一个队列 owner
系统 MUST 在 `scheduleSpawnTasks` 完成后、`spawnWork` 开始前，使同一房间每个有效且未在 spawning 的 `configName` 最多存在于一个 Spawn 队列中。单队列内或跨 Spawn 的重复项 MUST 收敛为一个确定性 owner，且不同 configName 不得互相去重。

#### Scenario: 多个 active Spawn 已持有同一配置
- **WHEN** 两个 active Spawn 的队列都包含同一有效 configName
- **THEN** 调度屏障必须基于同一代输入快照，在位置最靠前的 active 副本中选择规范化负载最小、Spawn 名字典序最小的 owner，使用所有副本中的最小索引重定位请求，并删除其余副本

#### Scenario: 多个 active 队列包含相同的批量副本
- **WHEN** 两个 active Spawn 都按相同顺序持有配置 A、B
- **THEN** owner 决策必须全部基于写入前快照，并在相同队列位置时按规范化计划负载分散 A、B，不得让处理 A 产生的索引变化影响 B 的候选 owner

#### Scenario: 不同配置并行排队
- **WHEN** 两个 Spawn 分别持有不同 configName，即使它们属于相同 role
- **THEN** 两个请求都必须保留并可在同 tick 分别执行

### Requirement: inactive owner 必须迁移而非复制
房间存在 active Spawn 时，系统 MUST 将只有 inactive owner 的 pending configName 迁移至 active Spawn，并删除所有 inactive 副本；迁移 MUST 保留无关队列项相对顺序，且不得把同一请求视为一次新的入队。

#### Scenario: 普通配置由 inactive Spawn 持有
- **WHEN** inactive Spawn 队列包含配置 C，房间另有 active Spawn且 C 尚未 spawning
- **THEN** scheduler 后 C 必须只存在于一个 active Spawn 队列，原 inactive Spawn 不得继续持有 C

#### Scenario: 多个 inactive 队列批量迁移
- **WHEN** 多个 inactive Spawn 的若干请求迁移至相同 active Spawn
- **THEN** 系统必须以迁移前快照中的原索引和 Spawn 名稳定合并请求，并保持每个请求 canonical source 队列内部的相对顺序；canonical source 是所有副本中原索引最小、Spawn 名字典序最小的 occurrence

#### Scenario: stale 副本顺序与 canonical source 冲突
- **WHEN** 同一 configName 的 active canonical occurrence 与更晚的 inactive stale occurrence 给出冲突相对顺序
- **THEN** canonical source 顺序必须优先，系统不得让将被删除的非 canonical stale 副本覆盖可执行 owner 的顺序

#### Scenario: spawnOnce 由 inactive Spawn 持有
- **WHEN** inactive Spawn 持有带既有 `spawnOnce.queuedAt` 的配置，房间另有 active Spawn
- **THEN** 系统必须迁移同一个队列请求，并保持 `queuedAt` 原值不变

#### Scenario: 全部 Spawn inactive
- **WHEN** 房间全部 Spawn 都 inactive 且一个或多个队列含配置 C
- **THEN** 系统必须保留恰好一个确定性 inactive owner，不得丢弃 pending request

### Requirement: 已在生产或无配置的队列项必须清理
系统 MUST 删除所有指向缺失配置的队列项；若 configName 已由任一 Spawn spawning，系统 MUST 删除所有同名队列项但不得取消合法 spawning。系统不得因存在一个 live creep 而删除合法 replacement request。

#### Scenario: 配置已经 spawning
- **WHEN** Spawn A 正在生产配置 C，任意 Spawn 队列仍含 C
- **THEN** scheduler 后所有队列中的 C 必须被删除，Spawn A 的生产继续

#### Scenario: 配置已删除
- **WHEN** 队列项引用的 configName 已不在 CreepConfigService
- **THEN** scheduler 后该 configName 不得继续占用任何 Spawn 队列

### Requirement: 队列 schema 与既有优先级必须兼容
系统 MUST 保持 `SpawnMemory.spawnList` 为 configName 字符串数组，保持 `StructureSpawn.addTask/mainSpawn/work` ABI 和现有稳定 role priority 排序。所有权迁移不得修改 creep 配置、默认/显式名称、body、transient 生命周期或 spawnCreep 错误重试语义。

#### Scenario: toFront 请求从 inactive 迁移
- **WHEN** 配置位于 inactive owner 队首并迁移到 active Spawn
- **THEN** 它必须按原索引有界插入，随后仍由现有 priority sort 决定最终位置，无关队列项相对顺序保持不变
