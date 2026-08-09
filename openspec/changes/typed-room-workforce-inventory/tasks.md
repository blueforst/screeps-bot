## 1. 基线与门禁

- [x] 1.1 记录当前线上 managed config/queue/tier/role/CPU 基线与本地定向测试基线（shard1 tick 72892850：29 configs、空 queues、8 房 tier=0、bootstrap CPU 1.25；本地相关 6 suites / 41 tests）
- [x] 1.2 恢复 RCL/滞回/normal-repair/Reserve/linked source/Mineral/supported room/source handoff/Worker drain/Carrier shrink characterization（6 suites / 65 tests）
- [x] 1.3 新增架构 RED 门禁，证明 bootstrap 当前仍直接重复解释 sourceLink、Mineral、Reserve 与 prefix payload（8 项违规按预期失败）

## 2. Typed inventory

- [x] 2.1 定义 `RoomWorkforceInventory`、四类判别 config spec 与 `preserve/set` construction tier effect
- [x] 2.2 将 Worker tier/数量计算拆成无 RoomMemory 写入的 decision，并新增不创建空 task store 的只读 selector
- [x] 2.3 实现每次调用独立观察的 inventory builder、tier effect apply 与 names 兼容投影，保持 configName/payload/顺序

## 3. Bootstrap 单次消费

- [x] 3.1 让 bootstrap 每房只构建一次 inventory，并以 kind/spec 驱动 upsert、expected membership 与 source handoff
- [x] 3.2 保留 colonization/rescue 后置 source suppression、各角色不同 cleanup 及 17-tick GC 兼容语义
- [x] 3.3 让架构门禁转绿，确认 bootstrap 不再直接导入或查询 sourceLink、Mineral eligibility、Reserve/prefix payload

## 4. 验证与审查

- [x] 4.1 运行 roomWorkforce/bootstrap/memoryCleanup/workerTaskPool/spawnPlanner/main 定向测试、双 typecheck 与全量 Jest（131 suites / 837 tests）
- [x] 4.2 运行 Rollup build、bundle alias/autoplanner 检查、OpenSpec strict 与 `git diff --check`
- [x] 4.3 两轮独立审查均为 P0=0/P1=0；补齐 cross-phase/GC、RCL8 effect 与静态 ownership 门禁后复验

## 5. 部署与收口

- [ ] 5.1 提交已验证切片并部署同一 commit，保留父提交作为直接回滚点
- [ ] 5.2 连续观察至少 51 tick，比较 29 个 managed configs、queue 唯一性、tier/role count、source 生产与 bootstrap CPU
- [ ] 5.3 同步主规格并归档 change；记录后续 GC ownership 解耦和 source correctness changes
