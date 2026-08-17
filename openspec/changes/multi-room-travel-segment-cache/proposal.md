## Why

shard1 当前 120 个 CPU 样本中 `creepWork:pathing` 平均消耗约 22.52 CPU；跨房移动在没有 Colonization 持久路径时，每 tick 都会执行一次最多 10,000 ops 的 `PathFinder.search`，却只消费首个 step。需要把一次搜索得到的当前房间路径段作为进程内可复用数据，避免 Remote Mining 等稳定路线重复支付完整搜索成本。

## What Changes

- 为每个 creep 的现有 heap-only movement state 增加带精确策略 key、单调 cursor、idle/hard TTL 和房间边界的跨房 travel segment；成功搜索后只缓存最多 100 个当前房间连续 step 以及必要的首个跨房 transition step。
- `moveToTargetRoom` 在每 tick 仍先重新解析 next room 与危险房门禁；仅当 creep、当前房间、目标、路线、危险集、cost/range/maxRooms 与动态占用策略完全匹配，且 transition room 的实时状态/可见敌情仍安全时复用 segment。
- 目标/路线/策略变化、TTL、连续卡住、向前 cursor 无法重接或进入下一房间时立即失效并走原搜索/fallback；`reusePath=0` 或 `ignoreCreeps=false` 的动态占用路径不缓存，非有限/超大 reuse 输入被有限规范化。
- 增加饱和的 movement analytics 计数，区分 multi-room search、segment hit 与 invalidation；hot-load 旧 bucket 每 snapshot 只补形一次，external telemetry 按最近活动以 O(16R) 有界投影 owned/remote room，并补充确定性调用次数、失效、跨房、global reset 和既有 fallback 回归测试。
- 不修改 Memory ABI、role/任务语义、路线优先级、主循环顺序、市场或物流合同。

## Capabilities

### New Capabilities

- `multi-room-travel-segment-cache`: 规定跨房路径段的 heap-only 身份、复用、失效、fallback 与可观测性合同。

### Modified Capabilities

无。

## Impact

- 主要修改 `src/movement/routing.ts`、`src/movement/types.ts`、`src/movement/creepState.ts`、`src/movement/metrics.ts`、`src/runtime/externalTelemetry.ts` 及对应测试。
- 复用 `global.__creepMovementState` 的自然 global-reset 清空与现有 dead-creep cleanup；不新增持久字段、迁移脚本或外部依赖。
- 线上行为风险局限于跨房移动路径复用；原 `PathFinder.search`、exit fallback 与 traffic intent 路径保留为失效后的回退。
