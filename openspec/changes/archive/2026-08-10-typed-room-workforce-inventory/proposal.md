## Why

当前 room workforce 只返回 `configName[]`，bootstrap 随后再次扫描 Source、Mineral 并通过字符串前缀重建 role/args；这让稳定身份、配置 payload 与生命周期对账分散在两个解释入口中。先引入一次性的 typed inventory，可以消除同一 phase 内的重复策略解释，同时保留现有 Memory、Spawn 队列、Creep 身份和跨 phase GC 语义。

## What Changes

- 新增带判别字段的房间 workforce inventory，显式描述 source、mineral、carrier、worker 配置的稳定 `configName`、role、args 与本地 slot/目标身份。
- 将 construction tier 的“保持/写入”效果显式化；Reserve 保持旧 tier，非 Reserve 继续在当前调用 phase 提交相同滞回结果。
- 让 `bootstrapRooms` 每房只构建一次 inventory，并以该对象完成配置 upsert、expected-set、source handoff 与 role-specific cleanup，不再重新判断 Source Link、Mineral 资格或通过 configName 前缀推断 payload。
- 暂时保留 `getExpectedManagedConfigNames(room)` 作为 17-tick GC 的兼容投影；每次调用独立构建 inventory，不做 tick/phase 缓存，从而保持 cleanup 与 task refresh 前后的现有差异。
- 恢复并新增 workforce/bootstrap characterization 和依赖边界门禁，锁定 configName、枚举顺序、RCL/Reserve/滞回、外援抑制及不同角色的退役策略。

## Capabilities

### New Capabilities

- `typed-room-workforce-inventory`: 定义临时 typed inventory、稳定身份、construction tier effect、bootstrap 单次消费及跨 phase 兼容边界。

### Modified Capabilities

无。

## Impact

- 主要影响 `src/runtime/roomWorkforce.ts`、`src/runtime/bootstrap.ts` 及对应测试；可能新增一份静态架构门禁。
- `src/runtime/memoryCleanup.ts` 继续消费兼容名称投影，本切片不改变 17-tick managed config GC。
- 不修改 `Memory.data.creepConfigs`、`RoomMemory.workerConstructionTier` schema、configName 格式、Spawn 队列 token、CreepMemory、spawnPlanner、main phase 顺序或角色行为。
- 不修正当前 source replacement/colonization support 的既有生命周期缺陷；这些行为变化在 typed inventory 稳定后另立小切片。
