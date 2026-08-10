## ADDED Requirements

### Requirement: Bootstrap 必须独占 workforce policy 解释

`bootstrapRooms` 必须（MUST）是 visible owned managed room 的唯一 workforce policy 解释者。17-tick cleanup 只可依赖纯 canonical identity 和有效 room owner，不得（MUST NOT）构建 inventory、投影 expected names、读取 Worker task board 或提交 construction tier effect。

#### Scenario: Cleanup 与 task refresh 同 tick

- **WHEN** Game tick 同时命中 17-tick cleanup 与 3-tick Worker task refresh
- **THEN** cleanup 不得提前删除或创建 managed-room workforce config，refresh 后 bootstrap 以当前 task board 构建一次 inventory 并提交最终结果

#### Scenario: Cleanup 不产生 workforce policy 副作用

- **WHEN** periodic cleanup 处理任意数量的 managed config
- **THEN** 它不得扫描房间 Source、Mineral、Construction Site，不得创建/读取 Worker task board，也不得写 `workerConstructionTier`

#### Scenario: Compatibility projection 被移除

- **WHEN** 生产代码与测试需要观察 expected managed identities
- **THEN** bootstrap 使用 `RoomWorkforceInventory.configs`，且系统不得保留供 cleanup 重建 policy 的 `getExpectedManagedConfigNames` 入口

## REMOVED Requirements

### Requirement: 跨 phase 兼容投影不得共享缓存

**Reason**: 兼容投影会让 cleanup 在错误 phase 重算 workforce policy并产生瞬时删建；canonical ownership GC 已替代其唯一生产用途。

**Migration**: cleanup 改为消费纯 identity 与有效 room owner；bootstrap 和 characterization tests 直接使用 typed inventory，不再跨 phase 投影 expected names。
