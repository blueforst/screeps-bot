## Context

Link 网络分类缓存自 `d27deca` 引入以来一直保存于 `Memory.runtime.linkNetwork[roomName]`。它的目的，是把每房 Link 按 Source sender 与 Storage/Controller receiver 分类并缓存 11 tick，避免角色目标选择和 Link 传能每 tick重复扫描位置；`memoryCleanup` 再每 17 tick回收已经失去所有权房间的缓存。

当前 `linkControl` 同时负责分类、缓存初始化/读写、位置 fallback、容器清理和传能，而 `memoryCleanup` 直接解释同一个 Memory 分支并删除成员。两处路径 lookup/replace/delete owner 使 wire 语义与领域行为分散，也让后续 Memory 重构容易在只读初始化、空容器处理或 TTL 上产生漂移。

约束如下：

- `Memory.runtime.linkNetwork[roomName]` 是已有持久化 wire，不得迁移路径或改变 shape。
- `memoryCleanup` 在 `linkControl` 之前运行的 phase 顺序属于已锁定行为。
- `isReceiverLink` 与 `isStorageReceiverLink` 是角色模块使用的领域 API；角色不应直接依赖 Memory gateway。
- `RuntimeServices` 是跨 tick singleton；本切片不把领域 gateway 注册为新的 service，也不改变其测试隔离语义。

## Goals / Non-Goals

**Goals:**

- 让 LinkNetwork gateway 成为 `Memory.runtime.linkNetwork` 唯一的生产路径 lookup/replace/delete 边界。
- 区分无副作用读取与按需写入：缓存不存在时的查询不得创建 `Memory.runtime`。
- 保持 11-tick 分类刷新、17-tick失房清理、位置 fallback、Link transfer intent 和空容器行为逐项等价。
- 建立可复用的领域 Memory gateway 模式，而不是继续扩张只有 `ensure*` 的通用服务。

**Non-Goals:**

- 不建立覆盖全部 `Memory.cfg/runtime/data/analytics` 的 repository。
- 不修改 Link 分类范围、receiver 优先级、fill threshold、Source container 清理或 CPU 记录。
- 不改变 Memory 声明、schema、数组顺序、对象 identity 或旧数据内容。
- 不把角色消费者改为直接读取 gateway。
- 不改变主循环 phase、cleanup interval 或 classify interval。

## Decisions

### 1. 使用三个窄领域操作，而不是暴露可变 store

新增 `linkNetworkMemory.ts`，仅暴露：

- `peekLinkRoomRuntime(roomName)`：返回现有对象引用或 `undefined`，不得初始化任何根。
- `writeLinkRoomRuntime(roomName, snapshot)`：按需确保 `Memory.runtime` 与 `linkNetwork` 后，原样写入 snapshot。
- `pruneLinkNetworkRuntime(ownedRoomNames)`：稳定遍历现有 key，删除非己方房间并返回删除数量。

不暴露 `getLinkNetworkStore()`。类型从现有 `Memory["runtime"]["linkNetwork"]` 声明推导，不复制第二份 shape；`peek` 以 deep-readonly 类型暴露同一运行时引用，`write` 后调用方视为已移交 snapshot 所有权，不得继续修改。该约束保护字段/数组的常规 TypeScript 调用面，同时保留现有对象 identity；本切片不通过 clone/freeze 改变运行时语义。

备选方案是继续给 `RuntimeMemoryService` 增加 link-specific 方法。拒绝该方案，因为它会让通用 root service 持有领域语义，并鼓励所有 Memory 访问汇聚为巨型 service。

### 2. gateway 不注册进 RuntimeServices

gateway 是无 heap 状态的模块级领域函数。写入时复用 `memoryService` 的纯 `ensureRuntimeMemoryRoot()` 统一根初始化；只读和裁剪直接查看现有 `Memory.runtime?.linkNetwork`，以保证没有只读写放大，也不会为独立 gateway 调用注册 `RuntimeServices` singleton。

备选方案是把 gateway 作为 `RuntimeServices` 成员。拒绝该方案，因为它增加 singleton 生命周期与测试 reset 面，却没有缓存或依赖注入收益。

### 3. LinkControl 保留领域判断，gateway 只管理持久化

`getRoomLinkRuntime` 继续决定何时分类；`isReceiverLink` 和 `isStorageReceiverLink` 继续负责 cached ID 与位置 fallback 的组合语义。它们只把底层读取替换成 `peekLinkRoomRuntime`。分类结果通过 `writeLinkRoomRuntime` 持久化。

这样角色模块仍依赖 Link 领域，而不是依赖 Memory 结构；gateway 不知道 Room、位置、Link 类型或分类周期。

### 4. 清理阶段只委托裁剪，不改变容器生命周期

`memoryCleanup` 删除本地 `cleanupLinkNetworkMemory`，在原调用点传入同一个 `ownedRooms` Set 调用 gateway。gateway 在最后一个房间被删除后保留空的 `linkNetwork` 对象，精确保持现状；它不删除 `Memory.runtime` 或做额外规范化。

### 5. 通过行为与架构双门禁锁定边界

行为测试锁定 absent peek、精确写入、裁剪计数、11-tick边界、位置 fallback、17-tick清理和 transfer intent。架构测试遍历生产 TypeScript/JavaScript AST，任何静态出现的精确 `linkNetwork` 标识符或字符串 key 只允许位于 gateway；声明文件和测试文件不作为运行时 owner。该门禁覆盖点访问、字符串下标、对象字面量、解构和静态常量 key；运行时拼接出的动态字符串不作为受支持的 Memory 访问协议。

## Risks / Trade-offs

- [Risk] `peek` 意外改用 `ensureRuntime()` 会让角色查询产生空 Memory 写入。→ 用 absent-root 单测断言查询前后 `Memory` 深度相等。
- [Risk] 抽取时把 `>= 11` 改成 `> 11` 或移动分类责任。→ 在 LinkControl characterization 中分别锁住 `<11` 复用与 `=11` 重算。
- [Risk] prune 顺手删除空容器，改变 raw Memory wire。→ 明确断言最后一项删除后 `linkNetwork` 仍为 `{}`。
- [Risk] gateway clone/sort snapshot，改变数组顺序或引用语义。→ write/peek 使用原对象引用，测试断言对象与数组顺序不变。
- [Risk] 架构门禁过宽阻止类型声明演进。→ 扫描生产 `.ts/.js` 的精确 slot 标识符/字符串，不扫描 `.d.ts`；未来 schema augmentation 仍由 Memory declaration ownership 规格约束。
- [Trade-off] `linkControl` 仍同时包含分类和 Link 执行逻辑。→ 本切片只确立持久化 owner；分类器/执行器拆分留作后续独立变更。

## Migration Plan

1. 先补 gateway、LinkControl 与 MemoryCleanup 的 RED characterization/架构门禁。
2. 新增 gateway，并机械迁移三类调用点；不修改 Memory 声明或主循环。
3. 运行定向 Jest、双 TypeScript typecheck、OpenSpec strict、全量 Jest 与 Rollup build。
4. 部署同一已验证 artifact，观察 `linkControl` phase CPU、成功 fixed-action 计数与原路径缓存更新；具体 sender→receiver 选择由 characterization 锁定，因为当前 telemetry 不持久化该 intent。
5. 如出现回归，回滚代码提交即可；没有 schema migration，也不需要修复现存 Memory。

## Open Questions

无。本切片的路径、shape、周期和调用顺序均以现行行为为准。
