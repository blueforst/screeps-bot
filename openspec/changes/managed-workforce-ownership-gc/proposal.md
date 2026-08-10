## Why

`memoryCleanup` 每 17 tick 会在 Worker task refresh 与 bootstrap 之前重算整套房间 workforce policy，并仅凭五角色白名单猜测配置 ownership。这个兼容补丁既造成同 tick 瞬时删建和额外 Room 扫描，也会误删尚未出生的手动 max-carrier；配置删除又晚于 queue cleanup，留下非原子的悬挂队列窗口。

上一切片已经让 bootstrap 以单一 typed inventory 解释可见 managed room 的 workforce 策略，因此现在可以把早期清理器收窄为真正的 ownership GC：bootstrap 负责策略，GC 只负责失去有效房间 owner 后的安全退役。

## What Changes

- 新增纯 `roomWorkforceIdentity` 边界，集中生成和解析五类 canonical workforce config identity，并以一致的 name/role/args/roomName 证明 bootstrap ownership。
- `memoryCleanup` 不再导入或调用 `roomWorkforce`、不再扫描 Source/Mineral/Construction/Worker task，也不再写 `workerConstructionTier`。
- 可见 `normal/industrial` 房间完全交给同 tick bootstrap 对账；可见 `reserved`、已失去 ownership、不可见或不存在的房间，其 canonical workforce config 进入显式退役。
- 退役前统一快照 live 与 `spawn.spawning -> Memory.creeps` 引用；在役/出生中配置仅 orphan，空闲配置才删除。
- orphan/delete 与所有 Spawn queue 中同名项的移除在一次 GC 调用内完成，保持无关队列 FIFO；手动、紧急和其他非 canonical 配置不再因 role 恰好相同而被删除。
- 删除仅供旧 managed GC 使用的 `getExpectedManagedConfigNames` 兼容投影；不新增 Memory/global schema，不改变 main phase、spawnPlanner 或各角色运行逻辑。

## Capabilities

### New Capabilities

- `managed-workforce-ownership-gc`: 定义 canonical workforce ownership、有效房间 owner、live/spawning guard，以及 config/queue 原子退役合同。

### Modified Capabilities

- `typed-room-workforce-inventory`: 将原“cleanup 与 bootstrap 各自重建兼容名称投影”改为“bootstrap 是唯一 workforce policy 解释者，cleanup 只依赖纯 identity”。

## Impact

- 主要代码：`src/runtime/memoryCleanup.ts`、`src/runtime/roomWorkforce.ts`、`src/runtime/runtimeServices.ts`，以及新增的纯 identity 模块。
- 测试：managed GC、manual max-carrier、reserved/lost room、live/spawning reference、跨 Spawn queue 原子性与静态依赖门禁。
- 行为修正：queued manual/special 配置不再被 role-only GC 误删；切换为 `reserved` 或失去房间 owner 后不再继续补产 canonical workforce creep。
- 保持不变：canonical configName 语法、持久 `CreepConfig` schema、bootstrap 角色专用 handoff/orphan/delete 语义、Spawn 优先级和 tick phase。
