## Context

`getExpectedManagedConfigNames(room)` 同时被 `memoryCleanup` 与 `bootstrapRooms` 调用。它返回 durable identity 的字符串数组，却不携带 role、args、来源类型或 construction tier effect；因此 bootstrap 会再次扫描 Source/Mineral、再次判断 Link 与 Reserve，并通过前缀重建配置 payload。

这两个调用发生在不同 phase，不能合并或按 tick 缓存：cleanup 每 17 tick 位于 `flagControl`、`refreshWorkerTasks` 之前，bootstrap 位于任务刷新之后；第 51 tick 两次观察可能有意得到不同 normal-repair/flag 世代。函数还会通过 Worker 滞回写 `RoomMemory.workerConstructionTier`，并通过 task-board getter 惰性创建 heap store。

稳定 `configName` 是跨 Memory、Spawn queue 与 Creep 的身份协议；不同角色也有不同退役策略：Source 先 orphan 后交接、Worker orphan 自然退役、Carrier 立即删除 config。这个切片只能替换“inventory 表达与同 phase 重复解释”，不能把生命周期统一成 generic diff。

线上基线（shard1 tick 72892850，tag `2026.8.10-6+4cb1bc8`）为 8 个 managed rooms、29 个 bootstrap-managed configs、空 Spawn queues、全部 `workerConstructionTier=0`；`bootstrapRooms` 最新 CPU 约 1.25。部署后以这些可见状态和连续 51 tick 的 config/queue 稳定性做对比。

## Goals / Non-Goals

**Goals:**

- 用判别联合类型表达 source、mineral、carrier、worker inventory，并保持现有 configName、payload 和枚举顺序。
- 让 bootstrap 每房只构建一次 inventory，随后所有 upsert、expected membership 与 role-specific reconciliation 消费同一个对象。
- 将 construction tier 的 `preserve`/`set` 显式化，使 inventory 构建本身不写 RoomMemory；由现有调用 phase 明确提交 effect。
- 保留 cleanup 与 bootstrap 的两次独立观察和现有 17-tick GC 语义。
- 恢复能证明现有身份、数量、滞回与生命周期边界的 characterization。

**Non-Goals:**

- 不改变 configName 格式、role、args、数量、阈值、body、spawn priority 或 prespawn。
- 不移除/重写 `cleanupManagedCreepConfigs`，不处理失去 ownership 或 reserved room 的新 GC 语义。
- 不持久化 inventory，不加入 runtimeServices，不做 tick/room memoization。
- 不修正 spawning replacement 被视为 live、外援期间 live source config 未 orphan 等已识别行为缺陷；它们另立 correctness change。
- 不修改 main phase、task refresh 频率、spawnPlanner、Memory/global schema 或角色执行。

## Decisions

### 1. 使用 tick-local 判别联合，而不是扩展持久 CreepConfig

新增 `RoomWorkforceInventory`，包含 `roomName`、`reserveMode`、`constructionTierEffect` 与按固定顺序排列的 `configs`。配置项使用 `kind` 判别：

```ts
type ManagedWorkforceConfigSpec =
  | { kind: "source"; configName; role; args; source; deprecatedConfigName }
  | { kind: "mineral"; configName; role: "mineralHarvester"; args; mineralId }
  | { kind: "carrier"; configName; role: "carrier"; args: []; slot }
  | { kind: "worker"; configName; role: "worker"; args: []; slot };
```

Source 对象只在当前 bootstrap 调用栈内用于 miner body/handoff；inventory 不进入 Memory/global。持久化仍通过现有 config service，仅写原有 `role/args/roomName`。

备选方案是只增加 `{configName, role, args}`，但 bootstrap 仍需根据 prefix 或重新扫描来恢复 source transition 与 slot 类型，不能消除重复解释。

### 2. inventory 构建不写持久状态，tier effect 由调用者提交

construction tier 使用：

```ts
type ConstructionTierEffect =
  | { kind: "preserve" }
  | { kind: "set"; value: 0 | 1 | 2 | 3 };
```

Reserve 在当前实现中短路 Worker 计算并保留旧 tier，因此不能把 `nextTier` 简化为必填数字。RCL8 非 Reserve 仍返回 `set:0` 和一个 Worker。`applyRoomWorkforceConstructionTierEffect(room, effect)` 是唯一写点；bootstrap 和兼容 wrapper 各自在自己的 phase、成功生成 inventory 后调用一次。

inventory collector 可以读取 Game/Memory/TickContext/source-link cache，但不得写 RoomMemory、CreepConfig 或 Spawn queue。Worker task 观察使用不创建空 store 的 selector，避免“查询”隐式扩张 `global.__workerTaskBoard`。

### 3. bootstrap 消费一次 inventory，但保留原动作顺序与专用退役函数

bootstrap 对每个 visible owned managed room：

1. 构建 inventory 并提交 tier effect；
2. 用 config specs 构造 expected set；
3. 应用现有 colonization/rescue source suppression；
4. 按 source → mineral → queue/source cleanup → carrier → worker 的现有顺序执行；
5. 对 upsert payload 使用 spec 的 role/args，不再重新查询 Link/Mineral 或通过 prefix 判断要写什么。

Source、Carrier、Worker 的 cleanup 函数保持独立；本切片不把它们合并成一个 map diff。`reserveMode` 来自 inventory，替代 bootstrap 的第二次 Flag 查询，但保留当前幂等 orphan 语义。

### 4. GC 仅使用兼容投影，不共享 inventory 实例

暂时保留 `getExpectedManagedConfigNames(room)`：它独立构建 inventory、提交 tier effect，然后机械映射 `configs.map(configName)`。`memoryCleanup` 不改调用位置、角色白名单、live guard 或删除策略。

禁止把 cleanup 产生的 inventory 存入 runtimeServices、module cache 或跨 phase Map。这样 tick 51 仍是 cleanup 观察刷新前 task board、bootstrap 观察刷新后 task board；行为与当前一致。

后续 GC 解耦会另立 change：届时只按 canonical ownership 和 room ownership 回收不可见房间的 config，而不是在 cleanup phase 重算 workforce policy。

### 5. 用行为与架构双重门禁约束迁移

行为测试锁定：稳定顺序/身份、Link role、Mineral 资格、RCL carrier 数、Worker 滞回/normal repair、Reserve tier preserve、RCL8 tier reset、supported room suppression、source handoff、Worker orphan、Carrier immediate detach。

架构门禁锁定：bootstrap 不再直接导入 `sourceLink`、`getEligibleMineralIds` 或 `roomReserve`；inventory 不被 runtimeServices 持有；memoryCleanup 仍只通过兼容投影调用且 main phase 不变。

## Risks / Trade-offs

- [typed spec 与持久 configName 漂移] → 用 exact array/payload 测试和现有 spawn/creep 生命周期测试锁住，不改命名函数。
- [Reserve 或 RCL8 tier 写入时机变化] → 显式 effect + direct compatibility tests；每个调用 phase 仅在 inventory 成功后 apply。
- [误把两 phase 观察合并] → 静态依赖门禁禁止 runtimeServices/cache，增加 tick 34/36/51 characterization。
- [统一 cleanup 破坏角色退役] → 保留现有 role-specific reconciliation，仅替换数据输入。
- [Source 对象进入持久 Memory] → adapter 只把 role/args/roomName 传给 config service；测试断言无 `kind/source/slot/effect` 字段。
- [测试固化已知缺陷] → characterization 只锁历史明确合同；spawning readiness 与 support-live orphan 以独立预期失败用例/后续 change 处理，不写成本规格 MUST。

## Migration Plan

1. 先恢复 characterization 与静态依赖门禁，证明当前身份和生命周期合同。
2. 引入 union、inventory builder、只读 task selector 与 tier effect；保持兼容 wrapper。
3. 让 bootstrap 改用单一 inventory，复跑定向/全量测试与 bundle。
4. 提交后部署同一 commit；比较 29 个 managed configs、queue 唯一性、tier、角色计数和 bootstrap CPU，至少跨过一个 51-tick cleanup/task-refresh 重合点。
5. 若 config 数量、role/args、source 生产或队列出现异常，直接部署父提交；无 schema/data migration，旧 bootstrap 下一 tick可从现有 CreepConfig store重新对账。

## Open Questions

无；GC ownership 解耦与两个 source correctness 缺陷已明确移到后续 change。
