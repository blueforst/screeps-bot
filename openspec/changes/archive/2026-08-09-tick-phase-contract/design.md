## Context

`src/main.ts` 在模块加载时完成 prototype、全局 API、控制台命令与生产 API 注册；每个 tick 再创建 CPU profiler，按固定顺序执行 37 个顶层 phase，最后仅在完整成功路径调用 `flush()`。phase 之间通过 `Memory.cfg/runtime/data/analytics`、global heap cache、`TickContext` 和 Screeps intent 传递状态，没有事务回滚。

当前顺序测试通过正则读取 `main.ts`，但只验证市场链的少数相对位置及 Spawn wrapper。活跃市场规格又遗漏 `nukerControl`，使代码、测试和规格没有共同的 canonical 清单。

关键顺序目的如下：

| 边界 | 目的 | 不可随意移动的原因 |
| --- | --- | --- |
| 模块加载注册 | 在任何 tick 执行前挂载 `.work()` 并注册 console/API | 延后会使 executor 不可用；每 tick 重复会重复注册 |
| `marketSalePreflight → nukerControl → Hub → Synthesis/Factory → ResourceControl → Market live` | 先恢复安全状态和生成生产需求，再执行物流，最后按当前 tick 保护事实规划市场动作 | 前移消费者会读取旧状态，后移生产者会使保护量或 readiness 延迟一 tick |
| `memoryCleanup` 位于经济链之后、spawn/task producer 之前 | 让已完成经济阶段读取本轮旧状态，同时避免后续 scheduler 消费已失效配置 | 整体前移或后移都会改变本 tick 可见性 |
| `refreshWorkerTasks → bootstrapRooms → remoteMining → scheduleSpawnTasks → spawnWork → creepWork` | 先刷新需求并对账配置，再统一排队和执行 | 重排会漏掉本 tick 配置或让角色消费旧 task board |
| 单一外层错误边界 | 保留当前 fail-fast 行为和可映射 stack | 任一 phase 错误后继续执行，可能让下游消费半提交状态 |

## Goals / Non-Goals

**Goals:**

- 以当前 `main.ts` 为 canonical，固化全部 37 个顶层 phase 的精确顺序。
- 用可执行测试证明名称唯一、顺序完整，以及 Spawn/Creep 的内层 profiler wrapper 仍存在。
- 将市场顺序规格补齐 `nukerControl`。
- 为后续每个架构切片提供“未改变 tick 拓扑”的回归门禁。

**Non-Goals:**

- 不修改 `main.ts` 或任何运行时模块。
- 不引入 phase registry、DAG、拓扑排序、优先级、依赖注入或运行期开关。
- 不重排、增删或合并 phase。
- 不改变异常隔离、回滚、profiler `flush` 或 TickContext 缓存语义。
- 不部署 bundle，也不改变现有线上样本窗口。

## Decisions

### 1. 以 TypeScript AST 和测试常量表达契约

`src/main.test.ts` 保存显式 `canonicalTickPhaseOrder`，通过 TypeScript AST 只提取 `gameLoop` 函数体直接调用的顶层 `cpuProfiler.measure()`，并做精确数组比较。非字符串 phase、注释、gameLoop 外同形调用以及特殊 wrapper 不会伪装成合法 canonical phase。测试不导入 `main.ts`，避免触发 mount 和 console 注册副作用，也不会为了测试而改变生产 bundle。

备选方案是把 phase 改成运行时 registry 后直接导出；它会改变调用形态、闭包和 stack，超出“零运行时差异”目标，因此拒绝。

### 2. 只把顶层 phase 纳入 canonical 清单

Spawn/Creep 内部的 `measureRoomPhase`、`measureCreep` 继续由专门的源码特征测试保护，不混入顶层顺序。`flush()` 不是 phase，不进入 37 项数组，但测试必须证明它仍位于两个 executor 之后。

### 3. 当前代码优先于漂移的活跃 delta

`nukerControl` 已在生产代码与现有测试中位于 `productionMonitor` 和 `hubPlanner` 之间；主规格还要求 Nuker 需求触发 Hub 重规划。因此修改市场 delta，使它描述真实经济链，而不是据旧文本移动代码。

### 4. 后续拓扑变化必须独立立项

未来 Defense 前移、失败域隔离或 phase 拆分都必须单独说明当前逻辑目的、生产者/消费者、Memory/heap 新鲜度、intent、副作用和回滚方式，不能作为普通重构混入。

## Risks / Trade-offs

- [测试依赖源码形态] → 本切片刻意保持零运行时差异；未来若引入静态 manifest，应在独立变更中同时迁移测试，不允许先弱化完整顺序断言。
- [规格与测试重复维护清单] → 重复是有意的独立 oracle；任何差异会让 CI 失败并迫使评审说明拓扑变化。
- [完整顺序被误解为允许逐 phase catch] → 规格明确保留当前失败传播与成功路径 `flush`，异常隔离必须另立变更。
- [OpenSpec 活跃变更存在其他 strict 错误] → 对本 change 使用定向 strict validation，不借机修改无关变更。

## Migration Plan

1. 新增规格和完整顺序测试，不改生产代码。
2. 运行定向 OpenSpec strict、`src/main.test.ts`、TypeScript、全量 Jest 与 Rollup build。
3. 确认 `git diff` 不包含 `src/main.ts` 或业务模块，且构建产物只因常规 build tag 变化，不发布。
4. 若测试设计产生误报，回滚本 change 的规格与测试文件即可；线上无需操作。

## Open Questions

无。DefenseSnapshot、依赖感知失败域和运行时 phase manifest 均已明确后置到独立变更。
