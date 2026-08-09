## 1. 特征测试

- [x] 1.1 升级 inactive Spawn Planner 测试，锁定 active 接管后 inactive 副本被删除、全房恰好一个 owner
- [x] 1.2 覆盖 `spawnOnce.queuedAt` 原值迁移、全部 Spawn inactive fallback 与 active 重复的确定性 owner
- [x] 1.3 覆盖 spawning/missing 清理、不同配置不误去重，以及 unrelated/front 队列顺序

## 2. 队列所有权实现

- [x] 2.1 新增无 Memory schema 的房间级 `spawnQueueOwnership` 协调器
- [x] 2.2 在 `scheduleSpawnTasks` 的 producer 完成后、既有 priority sort 前接入所有权屏障

## 3. 本地验证与独立复核

- [x] 3.1 运行 Spawn Planner、mountSpawn、Emergency、War、Colonization、Cross-Shard 与 HomeDefense 聚焦测试
- [x] 3.2 运行 TypeScript、全量 Jest、Rollup build 和 OpenSpec strict validation
- [x] 3.3 独立复核 owner 选择、spawnOnce、spawning、全 inactive 与 phase 边界

## 4. 部署与线上观测

- [x] 4.1 提交运行时代码并记录父 commit 与部署 tag 回滚边界（代码回滚父提交：`ac31d0f`）
- [ ] 4.2 部署同一已验证 commit，确认 shard1 deploy tag 更新
- [ ] 4.3 观察 Spawn 失败诊断、队列深度、active spawning config 与完整 tick
