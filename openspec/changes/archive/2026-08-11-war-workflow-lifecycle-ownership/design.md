## Context

`Memory.data.war[targetRoom]` 是 War workflow owner，War 同时拥有或引用以下运行资产：

- `Memory.data.creepConfigs` 中以 source/target/generation 命名的 melee、healer 与 controller attacker 配置；
- 各 Spawn 的 `spawnList` 与 native `spawn.spawning`；
- 已出生或正在出生的 CreepMemory `configName` 引用；
- T3 generation 的 Boost task/lab reservation；
- owner 自身的 status、generation、patrol 与终态时间。

现有实现没有统一的领域释放事务。自然终态调用 `removeConfigWhenIdle`，会因存活成员而保留 config；任务随后不再被 WarControl 处理，但 SpawnPlanner 仍可在成员死亡后重新生产。`oneShot` generation 少于两人时只返回、不写 terminal；standard 固定生产两名 attacker/一名 healer，却按同索引隐式配对；Colonization、MemoryCleanup 与批量控制台路径还可以直接删除 owner。只读 TaskSystem adapter 正确地把这些问题报告为 ambiguity，但不能替 War 修复它们。

本变更是后续 `workflow-owned-assets` 的前置切片：先让 War 自己拥有明确、幂等的释放语义，再抽取跨 workflow 公共原语。

## Goals / Non-Goals

**Goals:**

- 建立 War 领域唯一的 terminal/release/purge 路径，并让所有直接调用者使用它。
- 终态同 tick 停止未来生产、释放 Boost、断开成员 owner 引用，同时默认保留已出生成员生命。
- 让 one-shot generation 耗尽进入显式 `failed`，并给出稳定机器原因。
- 让 squad pairing 成为 producer 写入的显式事实，而非 role 从 configName 索引猜测。
- 保留终态 owner 作为短期可观测记录，并让 GC 使用稳定终态时间真正回收。
- 删除已闭合的 War projection ambiguity，不改变统一 snapshot 的只读边界。

**Non-Goals:**

- 不创建通用 TaskManager、通用 terminal enum 或跨领域持久 owner store。
- 不在本变更抽象 Colonization/Rescue/RemoteMining/PowerBank 的 child assets；它们属于后续 `workflow-owned-assets`。
- 不改变 main phase、Spawn queue wire、configName 形式、War role 数量、身体、priority、路线、战斗目标选择或 Boost 配方。
- 不实现 TransferContract、CapacityLease、StageWorkClaim 或 RoomLogisticsAgent。
- 不把 TaskSystem adapter 接入 War 执行、清理或调度。

## Decisions

### 1. War owner 继续使用现有 store entry，不新增第二套持久 task ID

Owner 由 store key、`sourceRoom`、`targetRoom` 及可选 generation/component 共同证明。当前同一 target 只有一个 War owner，patrol 切换会原子重键；新增持久 task ID 会扩大 Memory 迁移和 console ABI，却不能单独解决资产释放。因此首切片保留 wire，并在领域命令中使用 exact store key 解析 owner。

替代方案是让 configName 或 live creep 反推 owner。该方案被拒绝：patrol generation 可保留初始 target configName，终态 survivor 也会继续携带旧内存，字符串前缀不等于当前 owner。

### 2. 分离 terminal transition、asset release 与 owner purge

WarControl 内建立三个层次：

1. `releaseWarTaskAssets`：一次枚举 owner config 集，移除全 Spawn queue 引用、尝试取消 native spawning、删除 config、释放 Boost，并按 policy detach 或 suicide 成员；返回结构化计数，重复调用为 no-op。
2. `transitionWarTaskTerminal`：写 `done/failed`、`completedAt`、可选 `failReason`，调用资产释放并在成功收敛后写 `assetsReleasedAt`，但保留 owner 供状态查询与 Colonization handoff。WarControl首次看到缺少该证据的legacy terminal时幂等补做释放。
3. exact owner purge command：先调用资产释放，再删除对应 store entry；`stopWarRoom` 的模糊 console lookup 只负责找到 exact key，最终仍走同一 command。

自然 terminal、staging/Boost failure、one-shot generation loss、restart/owner replacement、Colonization clear/abandon、GC 与批量 console stop 都复用这些层次。只有 War 领域模块可以执行 raw owner delete；外部调用者只能调用命令。

不选择让 TaskSystem adapter 执行 release，因为 adapter 是关闭态只读 projection，执行权反向依赖会破坏 foundation 层级。

### 3. 非 suicide 释放通过 detach 断开 ownership

默认 release 不杀已出生成员，而是设置 `_warDetached=true` 并清除 `configName` owner 引用；`role` 与 `roleArgs` 保留，所以 mount fallback 仍可执行既有角色逻辑。正在出生的 CreepMemory 也先被标记/断开；即使 native cancel 失败，出生后也不会重新成为该 owner 的生产成员。

所有基于 tick cache 的 live lookup 还必须重验当前 `creep.memory.configName` 与 `_warDetached`，避免同 tick detach 后的旧 cache 阻止 owner restart。显式 `suicide:true` 仍用于原 console stop-all 语义。

替代方案是保留 config 直到成员死亡。该方案正是重复出兵缺陷的来源，且把 executor retirement 与 production policy错误绑定。

### 4. Producer 显式写入 pair config identity

War producer 在 role args 中写 partner configName：

- standard attacker `0` ↔ healer `0`；
- standard attacker `1` 明确没有 partner；
- t3Duo generation attacker ↔ healer。

Role 只在自身显式 partner 非空且自身未 detach 时等待/协调，并用 exact configName 查找 partner；Traffic 的双人迎面换位会同时驱动双方，因此还必须验证双方 reciprocal exact partner。任何执行消费者都不得再用 `replace(":meleeAttacker:", ":healer:")` 推断。detach 必须清除运行时配对标记，旧 `roleArgs` fallback 不得将其恢复。现有 active configs 每 tick刷新，因此不需要持久 schema migration；没有显式 partner 的 legacy/fallback member按 unpaired fail-open运行，避免永久 hold。

不选择把两名 standard attacker 都绑定同一 healer，因为 healer 当前只有一个反向 partner，形成非对称三人关系会把现状歧义固化成新合同。

### 5. 终态 GC 以 terminal anchor 计时

所有新 terminal transition 写 `completedAt`。MemoryCleanup 使用 `completedAt ?? statusSince ?? createdAt` 作为终态年龄，而不是每 tick都会被 War telemetry refresh 的 `updatedAt`；到期后通过 exact owner purge command 回收。这样既兼容缺少 `completedAt` 的 legacy terminal，又不会因为观测刷新让 owner 永久泄漏。

### 6. Projection 只删除已闭合的历史 ambiguity

War adapter 继续校验 status/reason/scope/generation 等真实来源字段，并保留 malformed issue；四个由本变更解决的固定 ambiguity（raw delete、standard pairing、one-shot loss、terminal config retention）不再无条件输出。新terminal通过 `assetsReleasedAt` 提供只读闭合证据；缺少该字段的legacy terminal保留单一非致命release-unconfirmed诊断，并由WarControl下个执行tick收敛。Adapter 不读取 queue/config/Boost 来重新证明 release，也不进入生产模块图；领域测试与 writer gate负责执行正确性。

## Risks / Trade-offs

- **[detach 后角色依赖 config]** → 仅删除 owner `configName`，保留出生时复制的 `role/roleArgs`；增加 mount fallback 与 live survivor characterization。
- **[native spawn cancel 失败]** → 先对对应 spawning CreepMemory 标记 detach并清 owner引用，再尝试取消；owner purge不把 cancel成功作为唯一安全条件。
- **[同 tick cache 保留旧成员]** → 所有 owner live lookup在 cache结果上重验当前 memory config与detach状态。
- **[restart 复用 standard configName]** → 替换 owner前先完成旧owner资产释放和detach，再写新record；新生产不会借用旧survivor。
- **[外部仍可新增 raw delete]** → 增加生产源码架构测试，只允许 War领域的 exact purge实现写/删 War owner。
- **[显式 pair args 位置漂移]** → 以 producer/role集成测试锁定 standard与t3Duo payload；Boost参数位置保持不变，partner仅追加。
- **[行为修复影响既有实机编队]** → 本地先跑 War、roles、Colonization、MemoryCleanup、SpawnPlanner、TaskSystem与全量回归；不在本变更自动部署。

## Migration Plan

1. 先增加旧实现会失败的 characterization：终态配置、one-shot loss、standard attacker 1、raw purge与terminal GC。
2. 落地领域 release/terminal helper，并让 War 自身路径复用；随后迁移外部直接调用者。
3. 追加显式 partner args并更新两个角色；active config在下一个 WarControl tick自动刷新，无 Memory rewrite。
4. 删除四个固定 projection ambiguity，运行架构门禁、双 typecheck、聚焦/全量 Jest、strict OpenSpec、Rollup build与 diff-check。
5. 回滚时恢复旧 bundle并 global reset；新增字段 `assetsReleasedAt/_warPartnerConfigName` 与既有可选 `completedAt/failReason/_warDetached` 都可被旧代码忽略。回滚不承诺恢复已被正确释放的旧 War production configs。

## Open Questions

无。跨 workflow owner/ref 的公共接口刻意留给后续 `workflow-owned-assets`，本变更不提前定型。
