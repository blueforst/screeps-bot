## Context

当前 `cleanupManagedCreepConfigs` 是历史补丁叠加出的兼容谓词：role 属于 harvester/mineralHarvester/miner/carrier/worker、configName 不在所有 visible owned room 重算出的 expected 集合、且没有 `Game.creeps` 引用时删除。它不检查 canonical identity、实际生产者、room type、Spawn queue 或 `spawn.spawning`。

这段逻辑最初同时承担两件事：动态 workforce 缩编，以及房间丢失后的遗留配置回收。前者现在已经由 `bootstrapRooms` 的 typed inventory 和角色专用 reconciliation 完整负责；后者仍必须保留，但应基于 ownership，而不是在 cleanup phase 再解释 Source Link、Mineral、Reserve、Construction 与 Worker task policy。

当前主循环中 cleanup 位于 flag/task refresh/bootstrap 之前。每 51 tick，旧实现会先用旧 task board 删除 bonus Worker，再由 refresh 后的 bootstrap 重建；还会写一次 `workerConstructionTier`。同时，`spawnMaxCarrier` 创建的 `room:manual:maxcarrier:tick` 因 role 为 carrier 会被误判，且 queue cleanup 早于 managed config 删除，形成悬挂 queue 窗口。

线上基线（shard1 tick 72893640，tag `2026.8.10-6+6328e0f`）为 8 个 default-normal rooms、27 个动态 managed configs（16 miner、8 carrier、2 mineralHarvester、1 worker），全部有 live/spawning/queue 引用，无 dangling 或 duplicate queue。数量会随工作量变化，部署验收必须比较 identity/引用/queue 不变量而非固定总数。

## Goals / Non-Goals

**Goals:**

- 为 canonical workforce config 建立纯、可逆、单一来源的 identity 格式化与解析边界。
- 让 visible normal/industrial room 的 workforce policy 只由同 tick bootstrap 解释。
- 对 reserved、lost、unseen 或 non-owned room 的 canonical workforce config 安全停产并最终回收。
- 在任何删除前统一识别 live 与 spawning 引用，并让 queue orphan/delete 成为一次原子退役动作。
- 保护 manual/emergency/specialized config，不再只凭 role 推断 ownership。
- 移除 `getExpectedManagedConfigNames` 兼容投影及 cleanup 对 workforce policy 的依赖。

**Non-Goals:**

- 不增加 `CreepConfig.owner`、plan revision 或任何 Memory/global schema。
- 不改变 managed room 内 source handoff、Worker orphan、Carrier immediate detach、support suppression 或 workforce 数量规则。
- 不改变 main phase、cleanup 周期、spawnPlanner 生产/优先级、body/prespawn 或角色执行。
- 不修复 source handoff 对 spawning creep 的 retirement 细节，也不修改 colonization/rescue live source lifecycle。
- 不允许 manual config 与完全相同的 canonical workforce identity 共存；若未来需要，应另做 provenance 迁移。

## Decisions

### 1. 用纯 identity 模块共享“生成”与“证明”，不让 GC 依赖 policy

新增 `roomWorkforceIdentity.ts`，只依赖类型，提供 canonical format/parse/match。identity 为恰好三段：

```text
<room>:harvester:<sourceId>
<room>:miner:<sourceId>
<room>:mineralHarvester:<mineralId>
<room>:carrier:<canonical non-negative slot>
<room>:worker:<canonical non-negative slot>
```

room 必须是 Screeps room name（含 `sim`）；Source/Mineral discriminator 非空且不含冒号；slot 只接受 `0` 或无前导零的正整数。ownership proof 还要求 `config.role` 与 identity role 相同，Source/Mineral args 恰为 `[discriminator]`，slot role args 恰为空，且 `config.roomName` 缺失或等于 identity room。

`roomWorkforce` 必须用同一 formatter 生成全部 configName，防止 parser/generator 漂移。identity 模块不得读取 Game/Memory、导入 runtimeServices/bootstrap/workerTaskPool，也不得持有 cache。

备选方案是只导出五角色集合；它仍会误删 manual carrier。新增持久 owner 字段能无歧义区分生产者，但需要迁移全部旧配置，超出本切片。

### 2. canonical namespace 归 bootstrap 独占，非 canonical 默认保留

完全满足 name/role/args/roomName proof 的配置视为 bootstrap-owned；`:manual:`、`:emergency:`、remote/haul/rescue/war/powerbank 等多段或不匹配 identity 一律 fail-safe 保留。公开 API 手工写入与 automatic config 完全相同的 identity 在现有 schema 中不可区分，因此 canonical namespace 明确保留给 bootstrap；本切片不让 generic config service 反向依赖 workforce 模块。

显式 body/name/spawnOnce 等扩展字段不改变 canonical namespace 的 ownership；managed room 下 bootstrap 本来也会用 canonical payload 归一化它们。未来如需支持同名手工覆盖，必须新增 provenance，而不是继续猜测可选字段。

为保持这项既有“完整 payload 替换”语义，`CreepConfigService.upsert` 的等价判断会同步收紧：只有 role/args/roomName 三个字段且 args 是无空洞、逐项相等的数组时才可跳过写入。`null`、稀疏数组和 spawnOnce/taskId 等扩展字段都必须触发 canonical payload 归一化；service 公共接口与 global cache 生命周期不变。

### 3. 有效 owner 只指 visible owned managed room

cleanup 每次只构建一次 `getMyRooms().filter(isOwnedManagedRoom)` 名称集合：

- identity owner 在集合中：GC 完全跳过，所有 desired membership、Reserve Flag、support suppression 与角色退役交给稍后的 bootstrap。
- visible owned 但 `type=reserved`：没有 bootstrap owner，进入停产退役。
- non-my、unseen、lost 或不存在：进入停产退役。

这有意修复 reserved room 的历史不一致：bootstrap 已停止生产，但旧 GC 会继续把 canonical config 当 expected，从而让 spawnPlanner 继续补产。

### 4. 在 destructive cleanup 前快照 live/spawning 引用

`runMemoryCleanup` 必须在 `cleanupDeadCreepMemory` 之前建立本次 tick 的引用快照：

```text
Game.creeps[*].memory.configName
union
Game.spawns[*].spawning.name
  -> Game.creeps[name]?.memory.configName
  ?? Memory.creeps[name]?.configName
```

单独残留的 `Memory.creeps` 不是引用；queue 只是生产意图，也不是 live guard。若 Spawn 明确报告正在生产某 creep，其 Memory 记录不得在同次 dead-creep cleanup 中先被删除。

这与 spawnPlanner 当前识别 in-flight config 的口径对齐，同时避免“先删 Memory、后判断 ownership”的时序错误。

### 5. 退役是 queue + config 的原子事务

对 owner 无效的 canonical config：

1. 从所有 `Game.spawns[*].memory.spawnList` 删除全部同名 occurrence，保持每个 Spawn 中无关项相对顺序；
2. 若引用快照包含 configName，则删除 `config.roomName` 使其 orphan，保留 role/args 供在役/出生中 creep 使用；
3. 否则删除 config。

queue-only 不保活，因 owner 已失效时该生产意图必须取消。重复执行必须幂等；retirement 不进入 generic `CreepConfigService.remove`，以免其他 producer 的专用 lifecycle 被隐式级联。

### 6. 删除跨 phase compatibility projection，保留 phase 与 schema

`getExpectedManagedConfigNames` 的唯一生产消费者消失后直接删除；测试改为从 typed inventory 观察名称。`memoryCleanup` 只导入纯 identity 与 `roomTypes`，不导入 `roomWorkforce`，也不创建 inventory、读取 task board 或提交 construction tier effect。

`CLEANUP_INTERVAL=17`、main phase 顺序、runtimeServices 公共接口/cache 生命周期、Memory schema 与 spawnPlanner CreepConfig ABI 全部保持不变；runtimeServices 内部仅修复 upsert payload 等价判断和 malformed args 防护。

## Risks / Trade-offs

- [identity parser 与自动生成漂移] → formatter 与 parser 同模块，inventory 只能调用 formatter；表驱动 round-trip 与静态依赖测试锁定。
- [误删手工 canonical config] → 明确 canonical namespace 为 bootstrap 专属；非 canonical/mismatched payload 默认保留；未来若要同名覆盖，另增 provenance。
- [reserved room 行为改变] → 作为显式 correctness change 测试：撤队，live/spawning orphan，idle 删除；当前线上无 reserved room，部署风险低。
- [spawning reference 在 cleanup 前丢失] → 引用快照和 spawning-name guard 均在 dead-creep Memory 清理前建立。
- [queue 过滤改变顺序] → 只做稳定 filter，覆盖多 Spawn、重复 occurrence、首中尾与无关 FIFO/property 测试。
- [回滚后 orphan config 不自动恢复] → 无 schema 迁移；将 room 设回 normal/industrial 后旧/新 bootstrap 都会下一 tick重新 upsert canonical payload。reserved/lost 状态下保持 orphan 正是停产目标。
- [一次全 config × all Spawn 扫描] → cleanup 仅每 17 tick运行且 Spawn 数很小；可先收集 retirement name set，再对每个 queue 做一次 filter，复杂度为 O(config + queue entries)。

## Migration Plan

1. 先新增 identity/reference/queue RED 与架构门禁，证明当前 manual、reserved、spawning 和悬挂 queue 缺陷。
2. 引入纯 identity formatter/parser，并让 inventory 统一使用 formatter。
3. 将 managed GC 改为有效 owner + reference snapshot + 单次 queue filter + orphan/delete，移除 compatibility projection。
4. 运行定向、双 typecheck、全量 Jest、Rollup、OpenSpec strict 和独立审查。
5. 提交后部署同一 implementation commit；比较 dynamic managed configs、live/spawning/queue 引用、queue 唯一性、reserved/manual 状态和 cleanup/bootstrap CPU，至少跨过一个 51-tick cleanup/task-refresh 重合点。
6. 出现 canonical config、队列或 spawn lifecycle 异常时部署父提交；无需 Memory schema 回滚。managed room 下一 tick bootstrap 可重新对账，reserved/lost room 保持停产。

## Open Questions

无；canonical namespace 独占、reserved 停产与 spawning guard 均作为本次显式合同，而 provenance/manual canonical coexistence 留给未来变更。
