## Why

当前实体加载/激活/清理如果由 Camera 范围驱动，会把玩家镜头移动误当成 colony 感知能力，导致远处未知区域实体被加载、激活甚至显示，也会在边界附近造成频繁 load/unload、render index rebuild 和 redraw。

本变更将 entity streaming 的中心从 Camera 修正为拥有 `HasVisionComponent` 的实体（如 Colonist、Base、未来哨塔/火把/侦察单位），让 Vision Sources 决定 colony-aware/loaded/active 区域，Camera 只做最终屏幕渲染裁剪。

## What Changes

- 新增或整理 vision-centered entity streaming 能力：`HasVisionComponent` 实体提供 vision chunks，`EntityStreamingSystem` 基于 vision chunks 计算 load/keep range。
- 新增 `VisionSourceSystem`，负责发现 vision sources、按 z 合并 vision chunk set，并在 vision source 移动、创建、删除或视野半径变化时标记 dirty。
- 修正 `EntityStreamingConfig`：使用 `vision_load_padding_chunks` 与 `vision_keep_padding_chunks`，并强制 `vision_load_padding_chunks < vision_keep_padding_chunks`。
- 保留 hysteresis：实体进入 vision load range 才加载/激活/加入索引，离开更大的 vision keep range 后才清理。
- Camera 不再触发实体加载/卸载；Camera 只从 loaded/active/known entities 中按 camera rect + `view_z` 查询当前屏幕可绘制实体。
- Colonist、Base、当前选中实体、正在执行任务的实体等关键实体保持 always active；Tree、BerryBush、StoneBoulder、ResourcePile、ConstructionSite、Workbench 等按 vision streaming 激活/清理。
- DebugHUD、AgentInfoSystem 和 debug commands 输出 vision-centered streaming 统计与 regression 结果。
- 新增 regression：验证 Camera 移到未知远处不会加载实体，Colonist/Base vision source 移动才驱动实体加载，load/keep hysteresis 生效。

## Capabilities

### New Capabilities
- `vision-centered-entity-streaming`: 以 `HasVisionComponent` 实体为中心的实体加载、激活、清理、渲染候选索引、调试统计与回归验证能力。

### Modified Capabilities

## Impact

- 影响 Godot 4.x 脚本层：`scripts/vision/`、`scripts/entity_streaming/`、`scripts/ecs/components/`、EntityManager、EntityRenderIndex、VisibleEntityQuery、WorldRenderer/EntityRenderer、CameraController 集成点。
- 影响 Colonist/Base 创建或初始化逻辑：需要挂载默认 `HasVisionComponent`。
- 影响移动实体索引：vision source 跨 chunk 移动时需要更新 chunk index 并触发 streaming dirty。
- 影响 DebugHUD、AgentInfoSystem 与 debug command registry。
- 不重写 ECS，不重写 Save/Load，不把 Wall/Floor/Farm crop/Zone 等非 Entity 对象纳入 EntityStreamingSystem。
