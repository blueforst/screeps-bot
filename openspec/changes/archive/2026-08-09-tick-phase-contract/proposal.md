## Why

当前主循环通过固定顺序串联 37 个顶层 CPU phase，但完整顺序、关键生产者/消费者关系和失败语义只隐含在 `src/main.ts` 中，测试仅验证少量相对位置。后续架构拆分若缺少统一契约，可能在测试仍通过时改变同 tick 数据新鲜度、游戏 intent 或 fail-closed 行为。

同时，活跃的市场规格把经济阶段描述为“完整行为顺序”，却遗漏实际位于 `productionMonitor` 与 `hubPlanner` 之间的 `nukerControl`，需要以当前代码和已有 Nuker 需求为基线消除规格漂移。

## What Changes

- 新增完整的 tick phase 契约，记录当前 37 个顶层 phase 的精确顺序、关键数据依赖、模块加载初始化和成功路径末尾 `flush` 语义。
- 将主循环回归测试升级为完整顺序、phase 名唯一性和 Spawn/Creep 特殊 profiler wrapper 的精确验证。
- 修正市场自动化阶段要求，将 `nukerControl` 纳入当前经济链顺序。
- 明确任何 phase 增删、重排、异常隔离或动态调度均不属于本变更，必须独立分析影响并立项。
- 本变更不修改 `src/main.ts` 的运行逻辑，不改变 Memory schema、游戏 API、市场授权或线上配置，也不部署新 bundle。

## Capabilities

### New Capabilities

- `tick-phase-contract`: 规定主循环 phase 的 canonical 顺序、初始化边界、profiler wrapper 与失败传播基线。

### Modified Capabilities

无。本变更不修改已归档主规格；尚未归档的 `market-base-resource-all-rooms` delta 将直接对齐当前代码，避免跨活跃 change 的 `MODIFIED` 依赖。

## Impact

- 规格：新增 `tick-phase-contract`；同时修正尚未归档的 `market-base-resource-all-rooms` 内部阶段顺序文本。
- 测试：`src/main.test.ts` 将从正则提取后的局部相对断言升级为完整 canonical 顺序回归。
- 运行时：无；`src/main.ts`、Memory wire shape、phase 顺序、异常传播和 profiler 输出均保持不变。
- 线上：不发布 bundle，不重启现有 Terminal/Market CPU 与 Shadow 观察窗口。
