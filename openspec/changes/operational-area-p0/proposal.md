## Why

当前连续 / 无限 WorldCell 世界已经具备实体、任务、物流、农田、路径和渲染等基础系统，但高频模拟边界仍容易被 Camera、全图扫描或单一 vision/streaming 范围间接驱动，导致任务发布、物流查询、实体激活和作物更新向无限地图扩散。

本变更引入 `OperationalArea`（作业域）作为运行时模拟边界：由 Base、Colonist 等殖民网络节点动态形成 ACTIVE / WARM / FROZEN 三档范围，让游戏保持连续无限世界，同时把高频模拟限制在 colony 当前可运营区域附近。

## What Changes

- 新增 `OperationalArea` 作业域能力：作业域不是 Entity、不是 ZoneData、也不是固定据点地图，而是运行时 chunk 集合与模拟状态边界。
- 新增 `OperationalAreaConfig`、`OperationalAreaSourceComponent`、`OperationalAreaState`、`OperationalAreaSystem`、`OperationalChunkIndex` 等脚本约定。
- Base 与 Colonist 默认成为 `OperationalAreaSource`：Base 提供较大稳定 active/warm 半径，Colonist 提供较小移动 active/warm 半径。
- 新增 ACTIVE / WARM / FROZEN 三档语义：ACTIVE 运行高频模拟，WARM 保留 loaded/cache 但 P0 不主动发布高频任务，FROZEN 不进入任务池、物流撮合、EntityRenderIndex 或详细 AI。
- 将 entity streaming 从 vision/camera-centered 进一步调整为 operational-area-centered：`OperationalAreaSystem` 输出 active/warm chunks，`EntityStreamingSystem` 据此维护 loaded/active/render index。
- Camera 不再触发实体 activation 或 streaming；Camera 只从 loaded/active entities 中按 camera rect 与 `view_z` 做最终渲染裁剪。
- JobSystem、FarmSystem、LogisticsIndex 和普通自动任务 pathfinding MUST 受 ACTIVE 作业域限制，避免跨无限地图扫描、撮合或搜索。
- DebugHUD、AgentInfoSystem 与 debug commands 暴露作业域 sources、chunk counts、coord state、overlay 与 regression 结果。
- Save/Load 保存实体上的 `OperationalAreaSourceComponent`，但不保存 active/warm chunk runtime cache；读档后重建作业域、streaming、任务池和物流索引。

## Capabilities

### New Capabilities
- `operational-area-simulation-boundary`: 动态作业域模拟边界能力，覆盖 source component、active/warm/frozen chunk 计算、系统集成、调试输出、回归验证与 Save/Load 重建语义。

### Modified Capabilities

## Impact

- 影响 Godot 4.x 脚本层：`res://scripts/operational_area/`、实体组件目录、EntityManager/EntityStreamingSystem/EntityRenderIndex、JobSystem/TaskPool、HaulSystem/LogisticsIndex、FarmSystem、PathfindingSystem、Save/Load、DebugHUD、AgentInfoSystem、debug command registry。
- 影响 Base/Colonist 创建与加载路径：需要挂载默认 `OperationalAreaSourceComponent`，并与已有 `HasVisionComponent` 并存。
- 影响上一轮 `vision-centered-entity-streaming` 设计：Vision 继续表达可见/迷雾/探索，OperationalArea 成为 P0 entity activation 与高频模拟边界的上游。
- 不引入传统 Room、SettlementSite、FixedMap、ColonyMap，不删除无限地图生成，不重写 ECS、JobSystem 或复杂 outpost/road 网络。
