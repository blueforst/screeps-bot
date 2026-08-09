## Why

当前 Spawn Planner 为了保证可执行性，会在房间存在 active Spawn 时忽略 inactive Spawn 的队列。这个策略能把任务重新排到可工作的 Spawn，却没有转移旧队列项：普通配置会同时存在于 active/inactive 两个队列，inactive Spawn 恢复后再次生产；`spawnOnce` 则会被既有 `queuedAt` 阻止重排，长期卡在 inactive Spawn。

历史设计已经把 `configName` 作为一个逻辑生产槽，并在多 Spawn 分配测试中要求每个配置只排一次；当前缺少的是在 `scheduleSpawnTasks → spawnWork` 边界统一收敛所有 producer 写入的房间级队列所有权。

## What Changes

- 新增房间级 Spawn 队列所有权协调器，在 `scheduleSpawnTasks` 完成全部配置规划后、`spawnWork` 之前执行。
- 对每个有效且未在 spawning 的 `configName` 保留至多一个队列 owner：优先 active Spawn；只有 inactive owner 时原子迁移到 active Spawn；全部 Spawn inactive 时保留一个确定性 owner。
- 删除缺失配置、已经 spawning 的残余队列项，以及同一配置的跨 Spawn/单 Spawn重复项。
- 保持现有 `SpawnMemory.spawnList: string[]`、`spawnOnce.queuedAt`、队列优先级排序、prototype ABI 和主循环 phase 顺序不变。
- 增加 inactive 恢复、`spawnOnce` 迁移、active 重复、spawning 残项、全 inactive fallback 与队列相对顺序的回归测试。

## Capabilities

### New Capabilities

- `spawn-queue-ownership-contract`: 规定 Spawn 调度屏障完成时 `configName` 的单一队列 owner、inactive failover、in-flight 清理与确定性迁移语义。

### Modified Capabilities

无。

## Impact

- 运行时：新增 `src/runtime/spawnQueueOwnership.ts`，并在 `src/runtime/spawnPlanner.ts` 的调度末端接入。
- 测试：新增队列所有权单元测试，升级现有 inactive Spawn Planner 测试；回归 War、Colonization、Cross-Shard Colonization、HomeDefense、Emergency Spawning 与多 Spawn 分配。
- 行为变化：历史 active/inactive 双副本会在首个部署 tick 自动收敛；inactive 上的 `spawnOnce` 会迁移而非重新入队，因此保留原 `queuedAt`。
- 不变边界：不改变默认/显式 creep 名称、body 选择、失败重试、transient 配置删除、每 Spawn 每 tick 最多执行一个队首项、37-phase 顺序与 Memory schema。
- 回滚：没有持久结构迁移；回滚代码后现有 `string[]` 队列仍可读取，但将重新暴露旧的双副本/卡住风险。
