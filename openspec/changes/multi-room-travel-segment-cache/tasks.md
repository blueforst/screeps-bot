## 1. 基线与失败测试

- [x] 1.1 记录 shard1 当前 120 样本的 total/creepWork/pathing/bucket、Remote Mining 热点和原调用链，明确 Node/Jest 只用于确定性调用次数而非 Screeps CPU 结论
- [x] 1.2 为同一 creep 在同房连续移动只搜索一次、只缓存当前房前缀与 transition step 编写失败测试
- [x] 1.3 为 target/next-room/fixed-dynamic/route/avoid/cost/range/maxRooms/reuse/ignoreCreeps、idle/hard TTL、live safety、stuck、cursor 偏离、真实跨房边界和 global reset 失效编写失败测试
- [x] 1.4 为原 closest-exit/single-room fallback、固定 Colonization cached path、非相邻 search step、合法对角 transition 和 traffic move result 编写或确认行为回归

## 2. Heap-only Segment 实现

- [x] 2.1 在 movement types/creep state 中定义 per-creep multi-room segment，保持 `Memory` 声明和持久 shape 不变
- [x] 2.2 实现延迟构造的无歧义策略 key、100-step 上限、单调 cursor、O(1) transition index、当前房间 segment 提取与拓扑校验 follower，危险房按集合规范化而 route 保持顺序
- [x] 2.3 将 segment hit/miss/invalidation 接入 `moveToTargetRoom`，对动态占用、idle/hard TTL、live safety、stuck、向前偏离和房间变化 fail-safe 回退原搜索
- [x] 2.4 增加饱和 multi-room search/hit/invalidation counters、snapshot-once hot-load 补形，以及 external telemetry totals/最近活动 remote-room O(16R) 有界投影与兼容测试

## 3. 性能与回归验证

- [x] 3.1 用固定 fixture 证明连续 10 个可复用 tick 的 `PathFinder.search` 从 10 次降为 1 次，且失效场景立即恢复搜索
- [x] 3.2 运行 movement、Remote Mining/Carrier、traffic、external telemetry 与 memory/ambient ABI 聚焦测试
- [x] 3.3 运行双 TypeScript typecheck、全量 Jest、Rollup build、`git diff --check` 与 strict OpenSpec validation
- [x] 3.4 独立审查最终 diff 的 P0/P1/P2、Memory ABI、route/danger/traffic/fallback、analytics 计数与 bundle 可达性，修复后复验

## 4. 部署与只读验收门禁

- [ ] 4.1 获得明确部署授权后再更新版本、原子提交并 `npm run push`；不得修改线上 Memory、route、telemetry 或 profiler 配置
- [ ] 4.2 只读确认 shard1 deploy tag、bucket、segment search/hit/invalidation 与 stuck/repath/exit recovery 无异常，出现行为回归立即回滚代码版本
- [ ] 4.3 收集完整新 120 样本窗口，与本 change 基线比较 pathing mean/p50/p95、creepWork、total CPU、bucket 和世界负载后再归档
