## Context

外矿模块已经具备任务状态、scout、`remoteDefender`、creep config、spawn queue 与退役清理机制，但 `getRemoteThreatReason` 当前把所有 Invader Core 直接归入 `hostile_structures`，使任务只能暂停。shard1 的 E6N57 是 E7N57 的既有双源外矿，当前正因一座可攻击的 level 0 Core（100,000 hits）处于该暂停状态；E7N57 为 RCL7、有两座 Spawn、没有 Observer，现有 MOVE scout 正维持视野。

现有 RCL7 `remoteDefender` profile 在 5,300 能量容量下生成 16 `RANGED_ATTACK`、7 `HEAL`、23 `MOVE`，每 tick 对建筑造成 160 远程伤害，理论上约 625 ticks 可清理 100,000 hits 的 level 0 Core。因此一个既有 defender config 已是当前场景的最小充分编制。

只读实况基线来自 shard1 tick `72881325`（部署标记 `2026.8.9-12+c78789d`）：`Memory.data.remoteMining.E6N57` 的来源房为 E7N57、状态为 `suspended/hostile_structures`；房间对象 API 显示 Core id `6a754dbb7dc788acbbc6fcda`、level 0、`100000/100000` hits，且无其他敌对 creep、tower、spawn 或 rampart。其无敌效果已过期，collapse timer 尚余约 24,000 ticks。E7N57 为 RCL7、50 个 Extension、两座 Spawn、无 Observer，现有 `E7N57:remoteMine:E6N57:scout` 正提供视野。

## Goals / Non-Goals

**Goals:**

- 仅处理已经存在、来源房仍有效且未被人工暂停的外矿任务目标房。
- 在有视野的情况下识别并清理可由单只现有 `remoteDefender` 处理的 level 0 Invader Core。
- 视野、无敌效果、来源房容量、defense mode 与 Stronghold 等危险条件不足时保守等待或暂停。
- Core 消失或任务失效时幂等清理 config、队列，并让现存 defender 安全退役。
- 保持玩家结构绝不成为该流程的攻击目标。

**Non-Goals:**

- 不处理 level 1 及以上 Stronghold、其塔群/壁垒或需要多人编队的战斗。
- 不为尚未建立的候选外矿、已 abandoned 的任务或任意普通房间主动扫荡 Core。
- 不新增 Observer 调度、战斗角色、boost 体系或手工控制台命令。

## Decisions

### 1. 将可清理 Core 作为外矿主动防御原因

为 `RemoteDefenseReason` 增加 `npc_invader_core`。level 0 Core 不再作为被动 `hostile_structures` 直接暂停，而是进入既有 `defending` 状态；level 1+ Core 仍保持被动威胁并暂停。

这样可以复用既有状态机与清理语义，也能让已有 `suspended/hostile_structures` 任务在再次看到支持的 Core 时直接迁移到清理状态。替代方案是建立独立 Core 任务存储，但会重复 config、队列和退役生命周期，且更容易产生重复出生。

### 2. 单 config、视野门控、无敌期门控

支持的 Core 可见且无活动中的 `EFFECT_INVULNERABILITY`、来源房能量容量达到 5,300 时，状态机只 upsert 既有 `<source>:remoteMine:<target>:defender:0`。单 config 与 spawn planner 的现有单实例判断共同防止重复出生。

Core 无敌或目标房无视野时保留/生成 scout config，但移除 defender 的出生资格；无视野只表示“未知”，绝不触发完成。来源房没有 Observer 时，这一设计仍能靠现有 scout 闭环恢复判定。低于最低容量时不派出无法保证完成清理的单位。

### 3. `remoteDefender` 仅显式选择 Invader Core

当 `defenseReason === "npc_invader_core"` 且没有更优先的合法 hostile creep 时，`remoteDefender` 只从 `FIND_HOSTILE_STRUCTURES` 中选择 `STRUCTURE_INVADER_CORE`。对 Core 使用单体 `rangedAttack`，不使用可能波及其他结构的 `rangedMassAttack`；既不复用通用战争结构目标列表，也不选择玩家 spawn、tower、rampart 等结构。

替代方案是复用 `meleeAttacker`，但该角色会按战争目标序列攻击多类敌对结构，不满足“不得攻击玩家结构”的边界。

### 4. 可见消失立即结束 Core 清理

当任务仍为 Core 防御原因且目标房可见、Core 已不存在时，若没有 NPC creep 或已确认的玩家攻击，任务立即恢复 `active`，移除 defender/scout config 与对应队列项。现存 defender 因任务不再 `defending` 而沿既有路径返回来源房并 `suicide` 回收。

如果此时仍有合法 creep 威胁，则切换到原有 `npc_invader` 或 `player_aggression` 防御原因，而不是误报完成。

### 5. 继续服从全局安全状态

来源房失效、进入 defense mode、任务变为 abandoned 或 `manual_war_pause` 时，沿用现有全量清理路径。高等级 Core、来源房容量不足等无法保证安全完成的情况保持 suspended，不自动升级成战争任务。

## Risks / Trade-offs

- [只支持 level 0 Core] → 高等级 Stronghold 仍会暂停外矿；这是避免单兵送死和误攻其他结构的刻意边界，后续应由独立战争能力扩展。
- [依赖 scout 保持视野] → 没有 Observer 的来源房会占用一个廉价 scout config；失去视野时系统会等待而非盲派 defender。
- [固定 5,300 容量门槛绑定当前 profile] → 为 `remoteDefender` profile 与门槛增加测试；未来修改 body 时需同步复核最小伤害预算。
- [Core 消失后立即恢复] → 只在房间可见且重新检查其他合法威胁后执行，避免无视野误判。

## Migration Plan

1. 扩展类型、Core 分类与状态迁移，并补齐 runtime 测试。
2. 扩展 `remoteDefender` 的 Core 单体目标逻辑与角色测试。
3. 本地完成 Jest、TypeScript、构建及严格 OpenSpec 校验。
4. 本变更不在子任务中部署；后续部署后观察 E6N57 从 `suspended/hostile_structures` 迁移到 `defending/npc_invader_core`、单 config 入队以及 Core hits 下降。
5. 回滚时恢复本变更代码即可；旧任务仍可被原逻辑识别为 `hostile_structures` 并暂停，不需要 Memory 迁移。

## Open Questions

无。level 1+ Stronghold 的编队、boost 与结构拆除策略明确留待独立变更。
