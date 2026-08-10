## Why

`Memory.runtime.linkNetwork` 目前由 `linkControl` 负责初始化、刷新和读取，却由 `memoryCleanup` 独立解释同一路径并删除房间缓存，形成两个路径结构 owner。先把这个低风险、单一 shape 的分支收拢为领域 gateway，可以建立后续 Memory 领域拆分的模板，同时不改变 Link 分类、传能或主循环时序。

## What Changes

- 新增 LinkNetwork Memory gateway，集中提供无副作用读取、精确写入和按己方房间集合裁剪三种操作。
- 让 `linkControl` 通过 gateway 读取和写入每房间 Link 分类缓存；11-tick 刷新、位置 fallback、分类和传能逻辑保持不变。
- 让 `memoryCleanup` 通过 gateway 清理失去所有权房间的缓存；17-tick 调度与空容器语义保持不变。
- 新增行为 characterization 与架构门禁，禁止其他生产模块直接 lookup、replace 或 delete `Memory.runtime.linkNetwork` 路径成员。
- 不引入通用 Memory repository，不把 gateway 注册进 `RuntimeServices`，不修改 Memory 路径、字段 shape、schema 或主循环相位。

## Capabilities

### New Capabilities

- `link-network-memory-ownership`: 规定 LinkNetwork runtime cache 的唯一路径结构 owner、读写/裁剪语义以及 LinkControl 与清理阶段的兼容行为。

### Modified Capabilities

无。

## Impact

- 新增：`src/runtime/linkNetworkMemory.ts` 及其单元测试。
- 修改：`src/runtime/memoryService.ts` 增加无 singleton 副作用的 runtime root initializer；`src/runtime/linkControl.ts`、`src/runtime/memoryCleanup.ts` 改由 gateway 持有路径结构操作，并补充对应 characterization/架构测试。
- 保持不变：`Memory.runtime.linkNetwork[roomName]` 路径及 `{ updatedAt, senderIds, receiverIds }` shape、`ScreepsMemoryRuntime` 声明、`memoryCleanup → linkControl` 相位顺序、角色消费者 API、Link transfer intent 与 CPU action 记录。
- 不影响外部 monitor/console wire contract；不需要 Memory migration。
