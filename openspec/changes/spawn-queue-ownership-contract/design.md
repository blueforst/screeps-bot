## Context

Spawn 队列由 Spawn Planner、War、Colonization、Cross-Shard Colonization、HomeDefense、Emergency Spawning 等多个 producer 写入。它们都把 `configName` 当作一个逻辑生产槽；并行数量通过不同 configName 表达，预生成通过“一个存活 creep + 一个队列请求”表达，不依赖同一 configName 的多个队列副本。

`scheduleSpawnTasks` 是 `spawnWork` 前最后一个固定 phase，因此它是无需重排主循环即可规范化所有 producer 写入的天然 generation barrier。当前 Planner 的 active 优先过滤只解决“新请求应放到能工作的 Spawn”，没有解决旧 owner 的转移。

## Goals / Non-Goals

**Goals:**

- `scheduleSpawnTasks` 完成时，同房每个 configName 至多有一个 queue owner。
- active Spawn 可用时，将只有 inactive owner 的同一 pending request 迁移到 active Spawn。
- 迁移不重建请求，不修改 `spawnOnce.queuedAt`，不改变无关队列项相对顺序。
- 对历史重复项、缺失配置和已经 spawning 的残余项在首 tick 自动收敛。

**Non-Goals:**

- 不修复默认 creep 名称同 tick 冲突；该问题在队列唯一性上线后独立处理。
- 不抽取 Spawn executor，不改变 `StructureSpawn.addTask/mainSpawn/work` ABI。
- 不把所有 producer 改写为统一 repository，也不禁止控制台直接修改 `spawnList`。
- 不为 Spawn 已销毁后丢失的 `spawnOnce` 引入 durable request schema。
- 不改变队列 role priority、战争/应急/RCL8 admission 或 spawnCreep 错误分类。

## Decisions

### 1. 在 scheduler 末端建立房间级所有权屏障

`scheduleSpawnTasks()` 完成 emergency、普通配置、PowerBank 与 RCL1 特例处理后，对每个己方房间调用队列所有权协调器，再执行现有 `prioritizeSpawnQueue()`。这样所有早期 producer 和 Planner 本身的 front/back 写入都会被覆盖，且 `spawnWork` 读取的是同一代规范化队列。

只改 `StructureSpawn.addTask()` 不足：War、Colonization、Cross-Shard claimer、carrier 前插与 RCL8 maintenance 会直接写数组；让 prototype 隐式修改兄弟 Spawn 也会引入难以观察的非局部副作用。

### 2. 保持 string[]，以确定性规则选择 owner

协调器先按 Spawn 名排序，并清除缺失配置、已在 spawning 的配置和单队列内重复项，再冻结同一代队列快照。owner 选择、原索引和批量迁移全部从该快照派生，所有决策完成后才重建队列。对剩余跨 Spawn 副本：

- 房间有 active Spawn且已有 active owner时，先限制到队列位置最靠前的 active 候选，再选择规范化计划负载最小、Spawn 名字典序最小的 owner，并使用所有 active/inactive 副本中的最小索引重定位该请求；
- 只有 inactive owner但存在 active Spawn时，选择原队列位置最靠前的 pending request，并迁移到当前规范化队列负载最小、名字典序最小的 active Spawn；
- 全部 Spawn inactive时，按相同确定性规则保留一个 inactive owner；
- 其余副本全部删除。

队列通过“原索引、placement 优先、canonical source Spawn 名、稳定决策序”的排序键一次重建，而不是边删除边插入。每个请求的 canonical source 是全部副本中原索引最小、Spawn 名字典序最小的 occurrence；它会保留无关项和 canonical source 队列的相对顺序，并让 toFront 请求迁移后仍在队首附近。互相冲突的历史副本不可能同时保序，因此将被删除的非 canonical stale occurrence 不得覆盖 canonical source。协调后继续执行既有 role priority 排序，因此 emergency、carrier、war 与 RCL8 的现有优先级仍是最终执行规则。

### 3. `queuedAt` 属于请求，不属于 owner

所有权迁移只移动 configName 字符串，不调用普通 requeue 判定，也不写/清 `config.spawnOnce.queuedAt`。因此 inactive 上已有的 one-shot request 能继续执行，且不会被误当成新请求或重新计时。

Spawn 已销毁且唯一队列项已经从 `Memory.spawns` 消失时，当前 `queuedAt` 仍可能使 one-shot 永久不可恢复；修复它需要 durable request/ack 语义，不纳入本切片。

### 4. spawning 是已经取得生产权的状态

若任一 Spawn 正在生产 configName，所有队列中的同名项都是残余副本，协调器必须删除但不得取消合法 spawning。存活 creep 不等于 in-flight：预生成允许一个存活 creep 与一个 replacement request 并存，因此协调器不按 live creep 删除队列。

## Risks / Trade-offs

- [迁移改变同优先级队列的精确位置] → 使用原索引有界插入并保留无关项顺序；随后继续执行现有稳定 priority sort，聚焦测试锁定 front/back 与 unrelated 顺序。
- [旁路 writer 在 scheduler 之后写入重复项] → 当前 canonical phase 中 scheduler 后立即进入 spawnWork，没有生产模块写队列；控制台异步写入留给下一 tick barrier 收敛。
- [删除 missing config 比原来更早] → 现有 executor 对 missing config 本就把队首视为可消费毒项；提前清除只避免占用 Spawn tick，不改变可生产配置。
- [所有 active Spawn 的负载在批量收敛中变化] → 在单一输入快照上计算规范化基础负载，再为每个计划 placement 累加负载并以 Spawn 名打破平局；最后一次重建，避免决策受写入顺序污染。
- [回滚重新暴露旧风险] → Memory wire shape 不变，回滚无需迁移；以部署前 commit 为代码回滚点。

## Migration Plan

1. 先新增协调器单测和 planner 集成测试，证明旧实现会留下 inactive 副本/卡住 spawnOnce。
2. 实现 scheduler 末端所有权屏障，运行 Spawn/War/Colonization/HomeDefense 相关测试、TypeScript、全量 Jest 与 build。
3. 独立审查 owner 选择、`spawnOnce`、spawning 和全 inactive 兼容边界。
4. 部署同一已验证 commit；首 tick 观察 deploy tag、Spawn 失败诊断、队列深度与实际 spawning config。
5. 若出现严重回归，重新部署父 commit；无需回滚 Memory schema。

## Open Questions

无。默认名称唯一性和 executor 抽取明确拆为后续独立变更。
