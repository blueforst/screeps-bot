## Context

Defense Mode 是一个跨模块安全闩：当己方可见房间已有规划安全区，且房内存在符合现有危险谓词的 hostile creep 时，系统暂停殖民、救援、旗帜搬运、PowerBank、外矿和部分 Spawn 计划，并限制普通 Creep 离开安全区。它不判断 hostile 是否已经进入安全区；安全区存在只是启用该房防御合同的前提。

当前 heap cache 只有 `runDefenseMode()` 会按 `Game.time` 清空并填充，而 `isDefenseMode()` 只读 cache。主循环中 Flag、Cross-Shard、Rescue 与 PowerBank 等消费者早于 `defenseMode` phase，RemoteMining、SpawnPlanner 与 Worker 则晚于它，所以同一 tick 读取不同世代；global reset 后早期读取必然得到 `false`。

## Goals / Non-Goals

**Goals:**

- 任意消费者首次读取时得到 current-tick Defense Mode，而不是上一 tick 或未初始化值。
- snapshot 成功发布后，在安全区规划 revision 不变时，同一 Game/tick 内只扫描全部己方房间一次并复用同一结果；若 Room Planner 在早期 snapshot 后同 tick 更新 revision，固定 updater 最多原子发布一次第二代 snapshot。
- 保持危险 hostile、安全区和己方房间范围的现有判定不变。
- 保持公共 API、主循环 37-phase 顺序和 Memory schema 不变。

**Non-Goals:**

- 不移动 `defenseMode` phase，也不新增 tick phase。
- 不改变 HomeDefense、Tower、Spawn、Worker 或 movement 的业务规则。
- 不增加持久化 Defense Memory、遥测 schema 或 console API。
- 不在本切片处理主循环的依赖感知失败域。

## Decisions

### 1. 统一使用惰性 current-tick snapshot

新增内部 `ensureCurrentDefenseSnapshot()`。它以 `(Game.time, Game 对象身份)` 作为 epoch，并在 snapshot 中记录每个己方房间的安全区规划 revision（`roomPlanner.savedAt`）；epoch 变化时构建局部 `Map<string, boolean>`，完整成功后才原子替换当前 snapshot。`isDefenseMode()` 保证早期读取新鲜；`runDefenseMode()` 保留显式预热 API，并在固定 phase 核对已发布 revision 与当前 revision。

同一 epoch 内 revision 未变时，两个入口都复用 snapshot。若早期 reader 因无 layout 发布 `false`，而 `runRoomPlannerConstruction()` 随后同 tick 保存了新 layout，`runDefenseMode()` 检出 revision 变化后原子重建全房 snapshot。这样晚期 RemoteMining、Spawn、Worker 与 Creep safety gate 恢复旧实现已有的最新规划保护；早期消费者不会被追溯修改，因为它们读取时规划尚不存在。

选择一次构建全部己方房间，而不是逐房惰性计算，是为了让所有消费者共享同一 snapshot、保持每 tick 一次 `getMyRooms()` 遍历，并避免 updater 前后出现不同 cache 完整度。

选择只在固定 `runDefenseMode()` phase 核对 revision，而不是每次 `isDefenseMode()` 都遍历 revision，是为了让普通读取保持 O(1)。主循环中 Room Planner 位于该固定 phase 之前，之后没有新的规划写入者，因此它形成一个有界 generation barrier：正常 tick 一代，规划同 tick 变化时最多两代。

`Game` identity 用于区分测试或运行容器在相同 `Game.time` 下替换 Game 对象的情况；真实 shard 中 tick 仍是主要 epoch。该 identity 只负责让 Defense snapshot 自身失效，不改变 `TickContext` 的缓存合同；同 tick 替换 Game 的测试必须同时提供对应的新 TickContext，真实 global reset 则会一起重建模块与服务。

### 2. 保留 hostile 判定语义

`computeDefenseState()` 与 `getPlayerHostiles()` 不改：

- 无规划安全区时为 `false`；
- Source Keeper 排除；
- Invader 仅在有 WORK 或 HEAL 时纳入；
- 其他玩家 creep 只要有 ATTACK、RANGED_ATTACK、WORK 或 HEAL 中任一有效部件即纳入；
- snapshot 只包含 `TickContext.getMyRooms()` 返回的己方可见房间，未知或非己方 roomName 返回 `false`。

### 3. 原子提交，错误不发布半份 snapshot

snapshot 在局部 Map 中构建，只有全部房间成功计算后才替换 cache 和 epoch。若初次构建、revision 核对或第二代重建抛错，异常沿现有调用栈传播，并使旧 snapshot 失效；旧状态不会被伪装成当前 generation，下一次普通读取也会完整重试。

备选的逐房 catch + 默认 `true` 会引入新的错误隔离和日志合同，备选的默认 `false` 又不安全，因此均留给未来失败域变更。

### 4. 接受少量 CPU phase 归属变化

首次调用若发生在 `flagControl` 或 PowerBank，其扫描成本会记入该调用 phase；规划 revision 不变时，较晚的 `defenseMode` phase 只做轻量核对。若 Room Planner 同 tick 更新 revision，第二次扫描记入 `defenseMode` phase。线上基线显示该 phase 成本很小；部署观测关注总 CPU、相关 phase 和完整 tick，不以 `defenseMode` phase 自身下降作为性能收益。

## Risks / Trade-offs

- [计算错误可能比以前更早中止 tick] → 原子构建防止半份状态，失败时失效旧代以阻止 stale fallback；聚焦测试覆盖初次与 revision 重建失败，部署后观察完整 phase 与错误输出。依赖感知失败域另立变更。
- [CPU 从 defenseMode phase 移到早期消费者] → 记录为预期归属变化，比较总 CPU 与多 tick 均值，不用单 phase 下降宣称优化。
- [Game identity 比较依赖对象稳定性] → 同一函数调用保存当前 Game 引用；若 identity 改变则保守重建，不会返回旧 snapshot。
- [Room Planner 在早期 snapshot 后同 tick 首次生成安全区] → snapshot 记录规划 revision，固定 updater 检出变化后才原子重建；回归测试锁定晚期安全闩当 tick 恢复，额外扫描仅发生在 revision 变化 tick。
- [没有持久化观测字段] → 使用 deploy tag、CPU 完整 phase、现有行为测试和 live 无错误作为首轮验收；不为单一修复扩大 Memory wire shape。

## Migration Plan

1. 先补 characterization tests，证明当前早期读取失败，并锁定危险谓词兼容性。
2. 实现原子 current-tick snapshot，并运行 Defense、全部消费者相关测试、TypeScript、全量 Jest 和 build。
3. 独立复核后提交；记录父 commit `9592a3d` 与原线上 `e647683` 作为回滚点。
4. `npm run push` 部署新 commit，确认 shard1 deploy tag 更新；跨多个采样 tick 观察完整 phase、bucket、Spawn/Creep 与错误输出。
5. 若出现严重回归，部署 `e647683` 对应源码或 revert 本运行时提交并重新 push。

## Open Questions

无。Defense runtime telemetry 与依赖感知失败域明确不纳入本切片。
