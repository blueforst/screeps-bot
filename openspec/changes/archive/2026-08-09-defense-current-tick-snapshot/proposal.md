## Why

`isDefenseMode(roomName)` 当前只读取由较晚 `defenseMode` phase 填充的 heap cache。位于该 phase 之前的 Colonization、Rescue、Flag Hauling 与 PowerBank 消费者会读到上一 tick 状态，global reset 后还会把未计算状态当作 `false`，导致同一 tick 的安全决策不一致。

## What Changes

- 将 Defense Mode cache 定义为 current-tick snapshot：首次读取或显式 `runDefenseMode()` 时，按当前 `Game` 和 tick 一次性计算全部己方可见房间。
- 保持 `isDefenseMode(roomName)` 与 `runDefenseMode()` 公共 API 不变；后者既是显式预热入口，也会在固定 phase 核对安全区规划 revision，仅当 Room Planner 在早期 snapshot 后同 tick 更新规划时原子发布第二代 snapshot，不重排主循环。
- 完整保留安全区为空、Source Keeper、Invader 与危险 body part 的现有判定语义。
- 增加“显式 updater 之前读取”、敌人出现/消失、跨 tick、global reset、两房隔离和同 tick 只计算一次的回归测试。
- 记录 CPU 归属变化：首次早期读取可能把原 `defenseMode` phase 的少量扫描成本归入 Flag/PowerBank 等调用 phase；正常 tick 只扫描一次，罕见的同 tick 规划 revision 变化最多扫描两次。

## Capabilities

### New Capabilities

- `defense-current-tick-snapshot`: 规定 Defense Mode 的 current-tick 新鲜度、缓存生命周期、判定兼容性与读取一致性。

### Modified Capabilities

无。

## Impact

- 运行时实现：`src/runtime/defenseMode.ts`，以及为 revision 核对提供只读边界的 `src/runtime/safeZone.ts`。
- 测试：`test/defenseMode.test.ts`，并回归所有 `isDefenseMode` 消费模块的现有测试。
- 行为消费者：Colonization、Cross-Shard Colonization、Rescue、Flag Hauling、PowerBank、Remote Mining、Spawn Planner、Worker Task Pool 与 Safe-Zone movement gate；它们无需改代码，但早期调用将从旧值改为 current-tick 值。
- 不变边界：`src/main.ts` 37-phase 顺序、Memory schema、角色协议、市场/物流授权与游戏 API。
- 线上：需要新 bundle；以当前 `e647683` 为回滚基线，部署后观察 deploy tag、完整 tick、CPU phase、Spawn/Creep 执行和错误输出。
