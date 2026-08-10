## 1. 基线与 RED 门禁

- [x] 1.1 固化当前线上 dynamic managed config/live-spawning-queue/tier/room-type 与 cleanup/bootstrap CPU 基线，不把 27 或 29 写成恒定数量
- [x] 1.2 新增 queued manual max-carrier、reserved/lost room、五角色 live、两种 spawning、孤立 Memory/queue-only 的 managed GC RED 矩阵
- [x] 1.3 新增多 Spawn 重复 queue 原子过滤、无关 FIFO、幂等与 cleanup 后 queue/config 引用完整性 RED/property 门禁
- [x] 1.4 翻转静态架构门禁：cleanup 不得依赖 roomWorkforce/policy，identity 不得依赖 runtimeServices/Game/Memory，compatibility projection 必须消失

## 2. Canonical workforce identity

- [x] 2.1 实现纯 `roomWorkforceIdentity` formatter/parser/payload proof，覆盖五角色、room、discriminator、canonical slot 与 orphan roomName
- [x] 2.2 让 `buildRoomWorkforceInventory` 只通过共享 formatter 生成 configName/deprecatedConfigName，保持现有 identity、payload 与顺序
- [x] 2.3 增加 round-trip、manual/special namespace、role/args/room mismatch、canonical namespace 冲突测试

## 3. Ownership GC 与安全退役

- [x] 3.1 在 destructive cleanup 前建立 live/spawning config 与 spawning creep name 快照，并保护精确 in-flight `Memory.creeps`
- [x] 3.2 用 visible owned managed owner 集合替换 expected workforce 重算；managed room 跳过，reserved/lost/unseen room 进入退役
- [x] 3.3 以单次稳定 queue filter + live/spawning orphan + idle delete 实现原子退役，保持无关 FIFO和重复执行幂等
- [x] 3.4 删除 `getExpectedManagedConfigNames` 与五角色 role-only GC，更新 inventory/tests 的名称观察入口

## 4. 验证与审查

- [x] 4.1 运行 identity/memoryCleanup/roomWorkforce/bootstrap/emergencySpawning/spawnPlanner/main 定向测试与双 typecheck
- [x] 4.2 运行全量 Jest、Rollup build、bundle alias/autoplanner 检查、OpenSpec strict 与 `git diff --check`
- [x] 4.3 完成至少两轮独立审查，处理 P0/P1 及会造成假绿的关键 P2 后复验

## 5. 部署与收口

- [ ] 5.1 提交并部署同一 implementation commit，记录父提交与上一 runtime tag 作为回滚点
- [ ] 5.2 至少跨过一个 51-tick cleanup/task-refresh 重合点，核对 dynamic identity、live/spawning、queue、tier、manual/reserved 状态和 CPU
- [ ] 5.3 同步主规格、归档 change 并提交文档；若触发回滚条件则先恢复父提交并保留证据
