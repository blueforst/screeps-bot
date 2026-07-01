## Context

本变更的目标项目是 Godot 4.x colony simulation，实际 Godot 工程位于 `/Users/forst/code/godot_project/test/test/`；当前仓库用于保存 OpenSpec 规划工件。现有 Godot 工程已经有连续 / 无限 WorldCell + chunk 世界、Colonist/Base Entity、VisionSource、EntityRenderIndex/VisibleEntityQuery/WorldRenderer、Job/Haul/Reservation、Stockpile/Farm/Workbench/ConstructionSite/ResourcePile、PathfindingSystem、LogisticsIndexSystem、Save/Load、AgentInfoSystem/DebugHUD。

当前需要新增的不是传统据点地图，也不是 Zone 或 Room，而是运行时模拟边界：`OperationalArea`（作业域）。作业域由 Base、Colonist 和未来 outpost/road/depot 等殖民网络节点动态形成，用于控制哪些 chunk 进入高频模拟、哪些 chunk 只保留缓存、哪些 chunk 冻结。Camera 只能影响最终屏幕绘制，不再影响 entity activation、task publishing、logistics matching 或 chunk/entity streaming。

现有架构中的关键集成点：

- `scripts/ecs/ECSRoot.gd`：中心 tick order，当前依次运行 Occupancy、Logistics、Status/Hunger、Job、Movement、WorkAction、Construction、Production、Haul、Farm、Vision 等系统。
- `scripts/ecs/EntityFactory.gd`：创建 Base、Colonist、ResourcePile、ConstructionSite、Workbench 等实体。
- `scripts/ecs/components/VisionSourceComponent.gd`：已有视野组件，P0 保留 Vision 与 OperationalArea 并存。
- `scripts/world/ChunkManager.gd` 与 `scripts/world/WorldConfig.gd`：已有 camera/radius chunk lifecycle、fog 与 spawn radius 常量。
- `scripts/rendering/EntityRenderIndex.gd`、`scripts/rendering/VisibleEntityQuery.gd`、`scripts/ecs/systems/EntityRenderSystem.gd`、`scripts/world/WorldRenderer.gd`：当前渲染索引与 camera culling 管线。
- `scripts/ecs/systems/ColonistJobSystem.gd`、`scripts/building/ConstructionJobSystem.gd`、`scripts/production/ProductionJobSystem.gd`、`scripts/ecs/systems/WorkActionSystem.gd`、`scripts/ecs/systems/HaulSystem.gd`：任务发布、领取与执行。
- `scripts/logistics/LogisticsIndexSystem.gd` 与 `LogisticsQueryService.gd`：ResourcePile、Container、ConstructionSite、Stockpile 查询入口。
- `scripts/ecs/systems/FarmSystem.gd`：crop growth 与 plant/harvest 任务入口。
- `scripts/ecs/systems/PathfindingSystem.gd`：普通自动任务路径搜索入口。
- `scripts/save/GameStateSerializer.gd` 与 `scripts/save/EntitySaveSerializer.gd`：实体组件保存与恢复。
- `scripts/debug/DebugHUDPanelBuilder.gd`、`scripts/agent/AgentInfoSystem.gd`、`scripts/agent/AgentDebugCommandSystem.gd`：调试面板、agent snapshot 与 debug commands。

## Goals / Non-Goals

**Goals:**

- `OperationalArea` MUST 成为运行时模拟边界 / chunk 集合，而不是 Entity、ZoneData、Room 或固定 SettlementSite。
- Base 与 Colonist MUST 默认拥有 `OperationalAreaSourceComponent`；Base 提供稳定大半径，Colonist 提供移动小半径。
- 系统 MUST 支持 ACTIVE / WARM / FROZEN 三档状态，且 active chunks MUST 是 warm chunks 子集。
- `OperationalAreaSystem` MUST 收集 source、计算 active/warm chunks、按 z 合并、提供 coord/chunk 状态查询，并在 source 跨 chunk 移动或重建时 dirty。
- Entity streaming MUST 以 operational area 为中心：ACTIVE 进入 active simulation/render index，WARM 保留 loaded/cache，FROZEN 移出 active/render index。
- Camera MUST NOT 触发 entity activation、streaming、task publishing 或 logistics matching；Camera 只做 camera rect + `view_z` 的最终绘制裁剪。
- JobSystem、ConstructionJobSystem、ProductionJobSystem、WorkActionSystem、HaulSystem、FarmSystem 和 LogisticsIndex/Query MUST 只从 ACTIVE 作业域发布、领取或查询高频任务资源。
- 普通自动任务 pathfinding SHOULD 使用 active chunks 加可选 warm margin 作为默认 bounds，避免远处目标导致大范围 A* 搜索。
- Save/Load MUST 保存实体上的 `OperationalAreaSourceComponent`，但 MUST NOT 保存 active/warm chunk runtime cache；读档后重建作业域与依赖索引。
- DebugHUD、AgentInfoSystem 和 debug commands MUST 暴露作业域状态，并提供 `debug.run_operational_area_regression`。

**Non-Goals:**

- 不引入传统 Room、SettlementSite、FixedMap、ColonyMap 或局部据点地图。
- 不删除或削弱连续 / 无限 WorldCell 地图生成。
- 不把 `OperationalArea` 设计为玩家绘制的 ZoneData，也不进入 ECS Entity 列表。
- 不删除现有 `VisionSourceComponent` 或 fog/vision 概念；Vision 继续负责可见/探索，OperationalArea 负责模拟范围。
- P0 不实现复杂 outpost、road network、watchtower、torch、depot 的完整扩展逻辑，只预留 `source_kind`。
- P0 不实现 WARM crop 低频差量结算；Warm area crop low-frequency simulation 留作 P1。
- P0 不做跨作业域物流或远距离 colony network routing。
- P0 不重写整个 ECS、JobSystem、Save/Load、WorldRenderer 或 PathfindingSystem。

## Decisions

### 1. 作业域是 runtime boundary，不是 Entity / ZoneData / Room

选择：新增 `res://scripts/operational_area/` 下的 runtime system 与数据对象：`OperationalAreaConfig`、`OperationalAreaState`、`OperationalAreaSourceComponent`、`OperationalAreaSystem`、`OperationalChunkIndex`。其中 `OperationalAreaSourceComponent` 是实体组件；`OperationalAreaSystem` 和 chunk sets 是运行时派生状态。

理由：作业域表示“殖民网络当前可运营的模拟边界”，不是玩家画出来的功能区，也不是建筑房间。它需要被 Job/Logistics/Farm/Streaming/Pathfinding 查询，但不应参与 ZoneData 保存、建筑规划或 UI zone 编辑。

替代方案：把作业域做成 `ZoneData` 或 `SettlementSite`。拒绝，因为会把动态扩张边界误导为固定据点/功能区，并与 Stockpile/Farm Zone 的玩家绘制语义混淆。

### 2. Base / Colonist 通过 `OperationalAreaSourceComponent` 形成作业域

选择：新增组件：

```gdscript
extends RefCounted
class_name OperationalAreaSourceComponent

var active_radius_cells: int
var warm_radius_cells: int
var enabled: bool
var source_kind: StringName

func _init(
	p_source_kind: StringName = &"",
	p_active_radius_cells: int = 32,
	p_warm_radius_cells: int = 48
) -> void:
	source_kind = p_source_kind
	active_radius_cells = p_active_radius_cells
	warm_radius_cells = p_warm_radius_cells
	enabled = true
```

Base 默认 `source_kind = &"base"`、`active_radius_cells = 96`、`warm_radius_cells = 128`。Colonist 默认 `source_kind = &"colonist"`、`active_radius_cells = 32`、`warm_radius_cells = 48`。

理由：组件化 source 入口避免在 `OperationalAreaSystem` 中硬编码实体类型，也保留 future `outpost`、`road_node`、`watchtower`、`torch`、`depot` 扩展点。

替代方案：直接在 system 内按 `EntityTypes.BASE` / `EntityTypes.COLONIST` 扫描。可快速实现，但会把未来 source 类型扩展变成系统硬编码。

### 3. ACTIVE / WARM / FROZEN 以 chunk set 表达，状态优先级 active > warm > frozen

选择：`OperationalAreaSystem` 根据每个 source 的 coord 与半径计算矩形 chunk 覆盖，按 z-level 合并到 `active_chunks_by_z` 与 `warm_chunks_by_z`。如果 coord/chunk 同时属于 active 与 warm，查询返回 ACTIVE。

理由：chunk set 是现有渲染、streaming、pathfinding 与 world cache 最自然的粗粒度边界。P0 使用矩形覆盖比圆形精确计算更简单、稳定、便于 regression。

替代方案：逐 cell 精确圆形覆盖。拒绝作为 P0 默认，因为会增加查询成本和边界复杂度；未来可以在 chunk 粗筛后加 cell 精筛。

### 4. `OperationalAreaConfig` 管理半径、padding 与更新节流

选择：新增配置默认值：

```gdscript
var base_active_radius_cells: int = 96
var base_warm_radius_cells: int = 128
var colonist_active_radius_cells: int = 32
var colonist_warm_radius_cells: int = 48
var active_chunk_padding: int = 0
var warm_chunk_padding: int = 1
var update_interval_ticks: int = 10
```

配置校验 MUST 保证 warm radius >= active radius，且 warm padding >= active padding。`load_padding_chunks < keep_padding_chunks` 的 entity streaming hysteresis 约束继续由 streaming config 保证。

理由：Base 与 Colonist 半径需要可调；tick 节流避免每帧全量重算，同时 dirty 标记保证 source 跨 chunk 时及时更新。

替代方案：把常量散落在 EntityFactory 与各 system 中。拒绝，因为后续调参、DebugHUD 展示和 save/load regression 会变难。

### 5. EntityStreaming 改为 operational-area-centered

选择：`EntityStreamingSystem` 从 `OperationalAreaSystem.get_active_chunks_by_z()` 与 `get_warm_chunks_by_z()` 获取范围，而不是从 Camera visible chunks 或单纯 vision chunks 获取范围。ACTIVE chunks 中的 eligible entities 进入 active simulation/render index；WARM chunks 保留 loaded/cache；FROZEN chunks 移出 active/render index。

理由：Vision 表达“可见/探索”，OperationalArea 表达“可运营/高频模拟”。玩家可以看见或探索过某地，但不代表该处仍应高频运行任务、物流或渲染候选索引。

替代方案：沿用上一轮 vision-centered streaming 作为 simulation boundary。拒绝作为最终 P0 目标，因为用户明确要求 OperationalArea 是模拟边界，Vision 只决定可见/迷雾/探索。

### 6. Camera 只做最终渲染裁剪

选择：Camera 移动只影响 `VisibleEntityQuery` 的 camera rect + `view_z` 筛选。`EntityRenderIndex` 只索引 loaded/active renderables，作业域外实体不会因为 Camera 移动而加入索引或进入 active simulation。

理由：Camera 是观察工具，不是 colony network 节点。Camera 移到 frozen area 可以显示 procedural terrain 或未知区域，但不能激活未知实体、发布任务或泄露资源。

替代方案：Camera 继续参与 chunk/entity streaming。拒绝，因为会重现远处激活与全图扩散问题。

### 7. 高频系统通过 active-area filter 限制输入集

选择：在系统边界处添加 active-area 查询，而不是重写系统内部：

- Job/Construction/Production/WorkAction 只发布或领取 target coord ACTIVE 的任务。
- FarmSystem P0 只更新 ACTIVE farm zones / crop cells，并只发布 ACTIVE plant/harvest。
- LogisticsIndex/QueryService 只返回 ACTIVE coord 内的 ResourcePile、Container、ConstructionSite、Stockpile/Base 候选。
- Hunger food lookup 仍运行在 Colonist always-active tick 内，但食物查询限制在 ACTIVE 作业域。
- Pathfinding 普通自动任务默认限制到 ACTIVE chunks + optional WARM margin；debug/player direct command 可显式放宽。

理由：边界过滤是最小正确改动，可以避免重写 JobSystem/LogisticsIndex/FarmSystem，同时明确 P0 行为。

替代方案：让每个系统维护自己的 “active set”。拒绝，因为会产生多个不一致的边界与 stale cache 风险。

### 8. Save/Load 只保存 source component，派生 chunk cache 读档后重建

选择：`EntitySaveSerializer` 保存/恢复 `OperationalAreaSourceComponent`。`OperationalAreaState`、active chunks、warm chunks、stats、dirty cache、streaming loaded set 都不持久化。`GameStateSerializer.restore_game_state()` 后调用 `OperationalAreaSystem.rebuild()`，再触发 EntityStreaming、TaskPool/JobSystem、LogisticsIndex 重建。

理由：chunk sets 是实体位置与配置的派生结果，保存它们会产生 stale state 与版本迁移问题。

替代方案：保存 active/warm/frozen chunk sets。拒绝，因为读档后 source 位置、配置或 chunk size 变化会导致缓存不可信。

### 9. DebugHUD / AgentInfo / Debug Commands 是验收表面

选择：新增 Operational Area panel 与 commands：`debug.dump_operational_area`、`debug.toggle_operational_area_overlay`、`debug.force_operational_area_rebuild`、`debug.run_operational_area_regression`。AgentInfoSystem 输出 `operational_area` JSON payload。

理由：作业域是运行时边界，必须可观测。Regression 是本轮手动 QA 的核心表面，能验证 source、active/warm subset、warm/frozen 不发布任务、Camera 不激活实体、Save/Load 重建。

替代方案：只靠日志或 DebugHUD 文本。拒绝，因为不利于自动化验收与 agent 调试。

## Risks / Trade-offs

- [Risk] 当前 ChunkManager 仍可能以 Camera radius 管理 terrain chunk cache → Mitigation: P0 明确 Camera 不驱动 entity activation；terrain/procedural chunk cache 可暂时保留独立策略，后续再拆为 terrain cache 与 entity simulation cache。
- [Risk] LogisticsIndex 如果仍全量 rebuild，只在 query 时过滤，性能收益有限 → Mitigation: P0 先保证行为正确；任务中增加 `rebuild_active_area()` 或 active candidate cache，逐步降低全量扫描。
- [Risk] FarmSystem 暂停 WARM/FROZEN growth 会让离开作业域的作物停滞 → Mitigation: 这是 P0 明确简化；Warm low-frequency/delta settlement 标记为 P1。
- [Risk] Colonist 作为移动 source 可能让作业域分裂成多个岛，普通物流跨岛路径仍需避免 → Mitigation: P0 不做跨作业域物流；active query 可先按 active membership 限制，后续增加 connected area id。
- [Risk] Pathfinding bounds 过窄可能阻断合理绕路 → Mitigation: 自动任务默认 active + warm margin；玩家直接命令/debug command 可放宽，并在失败原因中暴露 out_of_operational_area。
- [Risk] Save/Load restore 顺序不当会导致读档后一 tick 使用旧任务/物流缓存 → Mitigation: restore 后强制顺序执行 `OperationalAreaSystem.rebuild()` → streaming rebuild → task/logistics rebuild，再允许 simulation tick。
