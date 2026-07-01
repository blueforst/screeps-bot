## ADDED Requirements

### Requirement: Vision sources drive entity streaming
系统 SHALL 以拥有 `HasVisionComponent` 且 `provides_entity_streaming == true` 的实体作为 entity streaming 的中心，并 SHALL NOT 以 Camera 位置、Camera visible chunks 或 Camera view rect 作为实体加载/激活/清理范围的中心。

#### Scenario: Camera movement does not load unknown entities
- **WHEN** Camera 移动到 Colonist、Base 或其他 vision source 视野未覆盖的远处 chunk
- **THEN** 该远处 chunk 内的实体 MUST NOT 因 Camera 移动而被加载、激活、加入 EntityRenderIndex 或绘制

#### Scenario: Vision source movement loads nearby entities
- **WHEN** Colonist 或其他 `HasVisionComponent` 实体移动到新的 chunk 并使远处实体进入 vision load range
- **THEN** 这些实体 MUST 被加载/激活并加入 active/render candidate set

### Requirement: HasVisionComponent defines vision contribution
系统 SHALL 提供或复用 `HasVisionComponent`，用于声明实体的视野半径、是否揭示 fog、以及是否参与 entity streaming。

#### Scenario: Colonist has default vision component
- **WHEN** 新建或加载 Colonist 实体
- **THEN** Colonist MUST 拥有 `HasVisionComponent`，默认 `vision_radius_cells` 为 12 且 `provides_entity_streaming` 为 true

#### Scenario: Base has default vision component
- **WHEN** 新建或加载 Base 实体
- **THEN** Base MUST 拥有 `HasVisionComponent`，默认 `vision_radius_cells` 为 20 且 `provides_entity_streaming` 为 true

### Requirement: VisionSourceSystem calculates chunk coverage by z
系统 SHALL 提供 `VisionSourceSystem`，发现所有有效 vision sources，按实体坐标与 `vision_radius_cells` 计算覆盖 chunks，并按 z-level 合并为 `vision_chunks_by_z`。

#### Scenario: Multiple sources merge on same z
- **WHEN** 同一 z-level 上存在多个 `HasVisionComponent` 实体
- **THEN** VisionSourceSystem MUST 合并它们覆盖的 chunks，并去重后提供给 EntityStreamingSystem

#### Scenario: Sources on different z stay separated
- **WHEN** 不同 z-level 上存在 Colonist 或 Base vision sources
- **THEN** VisionSourceSystem MUST 按各自 z-level 分组输出 vision chunks，且不得把一个 z-level 的 vision chunks 混入另一个 z-level

### Requirement: EntityStreamingConfig enforces vision load keep hysteresis
系统 SHALL 使用 `vision_load_padding_chunks` 与 `vision_keep_padding_chunks` 配置，并 SHALL 在配置校验时确保 `vision_keep_padding_chunks > vision_load_padding_chunks`。

#### Scenario: Invalid keep padding is corrected
- **WHEN** `vision_keep_padding_chunks <= vision_load_padding_chunks`
- **THEN** 配置校验 MUST 将 `vision_keep_padding_chunks` 自动修正为 `vision_load_padding_chunks + 1`，并 SHOULD 记录 warning

#### Scenario: Default padding creates hysteresis
- **WHEN** 使用默认 EntityStreamingConfig
- **THEN** `vision_load_padding_chunks` MUST 为 1，`vision_keep_padding_chunks` MUST 为 3，load range MUST 小于 keep range

### Requirement: Entities load inside vision load range and unload outside vision keep range
系统 SHALL 基于 `vision_chunks_by_z` 外扩计算 load chunks 与 keep chunks，并 SHALL 只在实体进入 vision load range 时加载/激活，在实体离开 vision keep range 时清理/卸载。

#### Scenario: Entity enters load range
- **WHEN** 某个 vision-loaded entity 位于 vision load chunks 内且尚未 loaded
- **THEN** EntityStreamingSystem MUST 将其标记为 loaded/active，并将可渲染实体加入 EntityRenderIndex

#### Scenario: Entity remains cached between load and keep range
- **WHEN** 已 loaded entity 离开 vision load range 但仍位于 vision keep range 内
- **THEN** EntityStreamingSystem MUST 保留该实体的 loaded/cache 状态，并 MUST NOT unload 它

#### Scenario: Entity leaves keep range
- **WHEN** 已 loaded vision-loaded entity 离开 vision keep range
- **THEN** EntityStreamingSystem MUST 将其移出 loaded/active render candidate set，并从 EntityRenderIndex 移除

### Requirement: Camera only performs final render culling
系统 SHALL 让 Camera 只负责从已 loaded/active/known entities 中按 camera visible rect 与 `view_z` 筛选当前屏幕可绘制实体。

#### Scenario: VisibleEntityQuery filters loaded entities
- **WHEN** Camera rect 或 `view_z` 变化
- **THEN** VisibleEntityQuery MUST 只查询 EntityRenderIndex 中已 loaded/active 的实体，并按 camera rect + `view_z` 返回 visible entities

#### Scenario: View z change does not stream unknown entities
- **WHEN** Camera `view_z` 切换到没有 vision source 覆盖的 z-level 或远处区域
- **THEN** EntityStreamingSystem MUST NOT 因该 `view_z` 切换加载远处非视野实体

### Requirement: Always active entities keep core simulation
系统 SHALL 将 Colonist、Base、当前选中实体、正在执行任务的实体和关键全局 controller entity 视为 always active，使其核心模拟不因离开 vision range 或 camera view 而停止。

#### Scenario: Offscreen colonist keeps simulation
- **WHEN** Colonist 离开当前 Camera visible rect
- **THEN** Colonist 的饥饿、任务、移动等核心模拟 MUST 继续运行，且渲染仍由 Camera culling 决定

#### Scenario: Vision-loaded resources can leave render index
- **WHEN** Tree、BerryBush、StoneBoulder、ResourcePile、ConstructionSite 或 Workbench 离开 vision keep range
- **THEN** 它们 MAY 被移出 active/render candidate set，但 EntityManager 中的持久实体数据 MUST 保留

### Requirement: Non-entity world data is excluded from entity streaming
系统 SHALL NOT 将 Wall、Floor、Farm crop、Stockpile、ZoneData、Cliff/Ramp visual 等非 Entity 世界数据纳入 EntityStreamingSystem。

#### Scenario: WorldCell structure is not streamed as entity
- **WHEN** Wall 或 Floor 位于 vision load range 内或外
- **THEN** EntityStreamingSystem MUST NOT 将其作为 Entity 加载、激活、清理或加入 EntityRenderIndex

### Requirement: Streaming updates are dirty driven
系统 SHALL 避免每帧全量遍历所有实体做 streaming，并 SHALL 在 vision source 创建、删除、跨 chunk 移动、视野半径变化、New Game、Load Game、Teleport/debug move 或 force update 时标记 streaming dirty。

#### Scenario: Camera movement does not mark streaming dirty
- **WHEN** 只有 Camera 平移、缩放或切换 screen rect
- **THEN** EntityStreamingSystem MUST NOT 因此标记 streaming dirty 或执行 load/unload pass

#### Scenario: Colonist moves to a new chunk
- **WHEN** Colonist 从一个 chunk 移动到另一个 chunk
- **THEN** VisionSourceSystem MUST 标记 dirty，EntityStreamingSystem MUST 在下一次允许的 streaming update 中重算 vision/load/keep ranges

### Requirement: EntityRenderIndex contains only loaded active renderables
系统 SHALL 让 EntityRenderIndex 只索引当前 loaded/active 的可渲染实体，而不是索引全世界所有实体供每次 visible query 全量筛选。

#### Scenario: Far unknown entities are absent from render index
- **WHEN** 远处实体不在任何 vision load range 或 keep cache 内
- **THEN** 该实体 MUST NOT 出现在 EntityRenderIndex 的 active renderable candidates 中

### Requirement: Redraw is requested only for visible impact
系统 SHALL 在 vision-based streaming 改变当前 camera 可见结果时请求实体 redraw，并 SHALL 避免离屏 loaded/unloaded 变化无条件触发可见 redraw。

#### Scenario: Offscreen unload does not redraw current screen
- **WHEN** 某个离开 vision keep range 的实体不在当前 Camera visible rect 内
- **THEN** 系统 SHOULD NOT 因该实体卸载触发当前屏幕 entity redraw

#### Scenario: Visible streaming change redraws entities
- **WHEN** vision source 移动导致当前 Camera visible rect 内的 loaded/visible entity set 改变
- **THEN** 系统 MUST 请求 entity redraw，并使用 `vision_streaming_changed`、`vision_source_moved_chunk`、`entity_left_keep_range` 或 `entity_entered_load_range` 等 reason

### Requirement: Debug and agent telemetry expose vision-centered streaming
系统 SHALL 在 DebugHUD、AgentInfoSystem 和 debug commands 中暴露 vision-centered entity streaming 状态。

#### Scenario: DebugHUD shows vision-centered stats
- **WHEN** DebugHUD streaming panel 打开
- **THEN** 面板 MUST 显示 Vision Sources、Vision Chunks、Load Chunks、Keep Chunks、Loaded Entities、Active Entities、Visible Entities、Camera Visible Entities、Load Padding、Keep Padding、Last Vision Source Moved

#### Scenario: AgentInfoSystem exports entity streaming payload
- **WHEN** AgentInfoSystem 生成状态 JSON
- **THEN** 输出 MUST 包含 `entity_streaming.mode = "vision_centered"`、`vision_sources`、`vision_chunk_count`、`load_chunk_count`、`keep_chunk_count`、`loaded_entities`、`visible_entities_camera`、`load_padding_chunks`、`keep_padding_chunks`

#### Scenario: Debug commands support vision streaming inspection
- **WHEN** 调用 debug commands
- **THEN** 系统 MUST 提供 `debug.dump_vision_sources`、`debug.dump_entity_streaming`、`debug.force_vision_streaming_update`、`debug.run_vision_centered_streaming_regression`

### Requirement: Vision centered regression validates camera independence and hysteresis
系统 SHALL 提供 `debug.run_vision_centered_streaming_regression`，验证 Camera 不驱动实体加载、vision source 驱动加载、以及 load/keep hysteresis 生效。

#### Scenario: Regression passes core stages
- **WHEN** 运行 `debug.run_vision_centered_streaming_regression`
- **THEN** 返回结果 MUST 包含 `ok`、`stages`、`counts`、`warnings`、`errors`，且 stages MUST 覆盖 `vision_sources_found`、`camera_does_not_load_unknown_entities`、`colonist_movement_loads_entities`、`inside_keep_range_does_not_unload`、`outside_keep_range_unloads`、`camera_not_streaming_center`

#### Scenario: Camera-only far movement loads no far entities
- **WHEN** regression 将 Camera 移动到远处实体区域但 Colonist/Base 视野不覆盖该区域
- **THEN** `far_entities_loaded_by_camera_only` MUST 等于 0
