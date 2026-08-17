## Context

`moveToTargetRoom` 已经缓存 room-to-room route 的 next-room 结果，并会优先使用 Colonization 在 `Memory.data.colonization[targetRoom].cachedTravelPath` 中保存的固定全路径；但普通 Remote Mining/Remote Carrier 等动态跨房路径没有可复用的 step 数据。它们会在每个移动 tick 调用 `moveAlongMultiRoomPath`，执行一次 `PathFinder.search(maxOps=10000)`，随后只移动到 `search.path[0]`。

线上 shard1 的 CPU profiler 在本轮审计时保留了当前滚动 120 个采样摘要：`creepWork:pathing` 平均约 22.52 CPU，`creepWork` 平均约 40.10，总 CPU 平均约 97.10，bucket 的平均值和最小值均为 10,000；最新样本中一个 `remoteMiningCarrier` 单独消耗约 11.26 CPU。本地 monitor JSONL 去重出的 120 个历史采样点横跨多个版本和世界负载，只能用于尾部分布定向（pathing p50 约 16.05、p95 约 42.12），不能冒充同版本连续窗口。调用方虽然传入 `reusePath=10`，现实现只在 multi-room search 失败后的单房 fallback 使用该值。

现有 `global.__creepMovementState` 已为每个 creep 保存 heap-only `TravelState`，global reset 时自然丢失，dead-creep cleanup 会删除失效 owner。该位置适合保存派生路径数据，同时避免扩大 Screeps Memory 的序列化、迁移与兼容面。

## Goals / Non-Goals

**Goals:**

- 把一次成功 multi-room search 得到的当前房间连续路径段复用于后续移动 tick，使稳定跨房移动每房间段只需一次完整搜索。
- 每 tick 保留现有 next-room、固定路线与危险房选择；只缓存 step，不缓存路线授权结论。
- 以完整策略身份、短 TTL、卡住/偏离检测和房间边界实现可预测失效，并始终保留原搜索与 exit fallback。
- 通过确定性搜索调用次数和 movement analytics 证明缓存实际命中，而不是仅比较 Node/Jest wall-clock。

**Non-Goals:**

- 不建立跨 creep 共享路径、持久 Memory 路径库、Room/terrain 版本系统或跨 shard cache。
- 不改变 route priority、危险房判定、traffic push、role 行为、任务系统、Remote Mining 策略或主循环顺序。
- 不在本 change 修复 CPU profiler 的 inclusive phase/untracked 口径，也不优化 Market、Worker assignment 或 Carrier board。

## Decisions

### 1. Segment 属于 per-creep heap TravelState

在 `TravelState` 中保存可选 `multiRoomSegment`，内容为 canonical key、当前房间、detached `{x,y,roomName}` step、O(1) transition index、单调 cursor、规范化 reuse TTL、生成 tick、可续租 idle expiry 与不可续租 hard expiry。它与 actor 的 stuck/target 状态同生共死，不写入 creep Memory 或 `Memory.data`。

相比共享 cache，这避免不同起点、fatigue、traffic push 与动态占用策略互相污染；相比持久路径，它不增加 RawMemory 体积、迁移或 global-reset 真值问题。global reset 后首次请求重新搜索是明确接受的成本。

### 2. 只保留当前房间连续前缀与首个 transition step

成功 search 后，从 `search.path` 取当前房间的连续前缀，并最多附加紧随其后的第一个相邻房间 step。提取器限制最多 100 个 step，同时验证房内逐步相邻、跨边坐标与 `describeExits` 房间拓扑；合法对角跨边仍保留对应 intent。当前房间内 follower 以单调 cursor 只向前重接；站在出口时利用 transition step 产生跨房 intent。进入下一房间后 current-room key 必然变化；边界 tile 可以先走既有 `moveOffExit`，首次离开边界后的 pathing 请求重新搜索。

相比缓存整条多房路径，这会在每个房间边界支付一次搜索，但能让 next-room/危险房策略在边界重新生效，也把陈旧结构与可见敌情的影响限制在一个短 segment 内。

### 3. Key 覆盖所有会改变搜索/复用语义的输入

key 使用无歧义字段编码，包含 creep 当前 room、targetRoom、已选择 nextRoom、fixed/dynamic 模式、有序 routeRooms、去重排序后的 dangerousRooms，以及解析后的 travelRange、plainCost、swampCost、maxRooms、ignoreCreeps 和 reusePath。相同集合不同枚举顺序不得制造无意义 miss；有序 route 本身仍保持顺序语义。

每 tick 继续执行当前 next-room 选择和危险门禁，再比较 key。普通房内命中前通过 transition index O(1) 找到下一房，并重查 `getRoomStatus` 与当前可见敌对事实；同 tick/同 room 的只读安全事实复用一次 heap memo，避免多个 creep 重复扫描。已经进入既有 direct-exit 或 search-fallback 分支时仍保持原路线政策，本 change 不把缓存优化扩成危险房策略重写。目标、路线、avoid set、cost、range、maxRooms、occupancy 策略或复用策略任一变化都不得命中旧 segment。

### 4. 仅缓存静态占用策略，并保留快速自愈

只有 `reusePath>0` 且有效 `ignoreCreeps=true` 时保存 segment。`ignoreCreeps=false` 依赖当前 creep 占用，不得跨 tick 复用；stuck recovery 已把 `reusePath` 设为 0、`ignoreCreeps` 设为 false，因此必然走 fresh search。

segment 使用 20 tick idle TTL 下限，合法 hit 会按规范化 reuse TTL 续租，但绝不超过 150 tick hard expiry；reusePath 被规范化到有限的 0..50，避免 `Infinity` 或超大输入制造永久租约。连续卡住达到既有阈值、当前点无法接到 cursor 之后的相邻 step、key/room 不匹配、实时门禁失败或任一 TTL 到期时先删除 segment，再执行原 multi-room search。搜索 incomplete/empty、首 step 非本房严格相邻位置或 follower 无法解析 step 时继续走现有 closest-exit 与 `moveToTarget` fallback；已调用 `creep.move` 后得到的终态错误原样传播，避免同 tick 双 intent。

key 只在比较已有 segment，或 fresh search 成功并提取出合法 segment 后构造；失败搜索不支付序列化成本。若运行中出现优先级更高的 Colonization 持久路径，则先尝试持久 follower，只有成功重接后才释放旧 segment；持久路径无法从当前位置重接时继续使用合法 segment，避免每 tick 释放/重建抖动。

### 5. Analytics 只增加计数，不新增持久 trace

现有 heap-only movement bucket 增加 `multiRoomSearches`、`multiRoomSegmentHits` 与 `multiRoomSegmentInvalidations`。Search 计数只在实际调用 `PathFinder.search` 前增加；hit 表示缓存 follower 返回 `OK`、`ERR_TIRED` 或 `ERR_BUSY` 并避免了本次 search，不把它误作物理前进计数；invalidation 只在已有 segment 被明确丢弃时增加。计数饱和于安全整数，hot-load 旧 bucket 时缺失字段补零。每个 room 另记 heap-only 最近活动 tick；External telemetry 以 O(16×R) 有界选择优先投影最近活动的最多 16 个 owned/remote bucket，而非对全部历史 bucket 排序。该投影在 compact payload 中保留，但不导出逐 creep segment、不增加历史数组或持久 Memory。

## Risks / Trade-offs

- [segment 内结构或敌情变化造成短暂陈旧] → 只缓存当前房间、使用 idle/hard 双 TTL；每 tick仍重算 next-room/危险 set，并在命中前重查 transition room 的实时状态/可见敌情，阻塞后两 tick内强制 fresh path。
- [key 漏字段导致错误复用] → key builder 使用解析后的完整输入，并用逐字段变更测试覆盖 target/route/avoid/cost/range/maxRooms/occupancy/reuse。
- [traffic push 后 creep 不在精确 cursor] → follower 仅在 cursor 之后允许精确位置或距离 1 的重接；更远偏离立即失效，不尝试长距离跳接或回走 hairpin。
- [缓存扫描本身增加轻微 JS 成本] → segment 最多 100 step，cursor 让正常行程总扫描近似线性；仅在真正需要缓存或已有 segment 时构造 key，收益门禁使用 `PathFinder.search` 调用数。
- [新增 analytics 字段改变 telemetry shape] → movement heap snapshot 归一为 version 2，字段为 additive number，旧快照缺失时补零；external telemetry 本身仍为 version 2，不伪造历史值。

## Migration Plan

1. 先增加失败测试，锁定重复搜索、失效、跨房、fallback、global reset 与 analytics 计数。
2. 实现 heap-only segment 并运行 movement/role 定向测试、双 typecheck、全量 Jest、Rollup、strict OpenSpec 与 diff check。
3. 如获得明确部署授权，只发布代码，不修改线上 Memory/config；以同 shard 的完整新 120 样本比较 pathing mean/p50/p95、bucket、travel repath/exit recovery 与 hit/search 比。
4. 若 stuck/repath/exit recovery 增长、路线行为异常或 pathing 回归，回滚本 change 的代码提交；无需 Memory 清理或迁移回退。

## Open Questions

无。跨 creep 共享 segment、CPU profiler 数据合同与持久路线图均作为独立后续 change 评估。
