## 1. Vision Source 基础设施

- [ ] 1.1 新增或复用 `HasVisionComponent`，包含 `vision_radius_cells`、`reveal_fog`、`provides_entity_streaming` 字段与默认初始化逻辑。
- [ ] 1.2 在 Colonist 创建/加载路径挂载 `HasVisionComponent`，默认 `vision_radius_cells = 12`、`provides_entity_streaming = true`。
- [ ] 1.3 在 Base 创建/加载路径挂载 `HasVisionComponent`，默认 `vision_radius_cells = 20`、`provides_entity_streaming = true`。
- [ ] 1.4 建立 vision source 分类规则，确保未来哨塔、火把、侦察单位和其他 `HasVisionComponent` 实体可通过同一组件参与 streaming。

## 2. VisionSourceSystem

- [ ] 2.1 新增或整理 `res://scripts/vision/VisionSourceSystem.gd`，发现所有有效 `HasVisionComponent` 实体并生成 vision source 列表。
- [ ] 2.2 实现 source coord + `vision_radius_cells` 到 covered chunks 的转换，并使用 `GameConstants.CHUNK_SIZE` 计算 chunk bounds。
- [ ] 2.3 按 z-level 合并多个 vision source 的 chunk set，输出 `vision_chunks_by_z`，同 z 去重、不同 z 分离。
- [ ] 2.4 在 vision source 创建、删除、跨 chunk 移动、半径变化、New Game、Load Game、Teleport/debug move 时标记 dirty。
- [ ] 2.5 增加 `update_interval_ticks` 定时补偿，避免每帧全量 streaming，同时防止 dirty 漏标长期 stale。

## 3. EntityStreamingSystem 与 Hysteresis

- [ ] 3.1 新增或整理 `EntityStreamingConfig`，使用 `vision_load_padding_chunks = 1`、`vision_keep_padding_chunks = 3`、`keep_non_current_z_loaded = true` 等配置。
- [ ] 3.2 实现配置校验：当 `vision_keep_padding_chunks <= vision_load_padding_chunks` 时自动修正为 `vision_load_padding_chunks + 1` 并记录 warning。
- [ ] 3.3 新增或整理 `EntityStreamingSystem.update_streaming_from_vision(vision_chunks_by_z)`，由 vision chunks 外扩得到 load chunks 与 keep chunks。
- [ ] 3.4 实现进入 vision load range 才加载/激活实体并加入 active/render candidate set。
- [ ] 3.5 实现离开 vision load range 但仍在 vision keep range 内时保留 loaded/cache 状态，不 unload。
- [ ] 3.6 实现离开 vision keep range 后清理 vision-loaded entities，并从 EntityRenderIndex 移除。
- [ ] 3.7 保证 EntityManager 仍保存持久实体数据，P0 不做复杂反序列化/存盘卸载。

## 4. Entity 分类与索引集成

- [ ] 4.1 实现 Always Active 分类：Colonist、Base、当前选中实体、正在执行任务的实体、关键全局 controller entity 永远保留核心 simulation active。
- [ ] 4.2 实现 Vision-loaded 分类：Tree、BerryBush、StoneBoulder、ResourcePile、ConstructionSite、Workbench、野生植物按 vision load/keep range 进入或离开 active/render candidate set。
- [ ] 4.3 排除非 Entity 世界数据：Wall、Floor、Farm crop、Stockpile、ZoneData、Cliff/Ramp visual 不进入 EntityStreamingSystem。
- [ ] 4.4 移动实体跨 chunk 时更新全局 entity chunk index，并在 vision source 跨 chunk 时触发 vision streaming dirty。
- [ ] 4.5 调整 EntityRenderIndex，使其只索引 loaded/active renderable entities，而不是全世界所有实体。

## 5. Camera、view_z 与渲染裁剪

- [ ] 5.1 移除 Camera visible chunks 对 entity streaming load/unload 的驱动关系，Camera 移动不得标记 streaming dirty。
- [ ] 5.2 调整 VisibleEntityQuery，使其只从 EntityRenderIndex 的 loaded/active renderables 中按 camera rect + `view_z` 筛选当前屏幕实体。
- [ ] 5.3 确保 Camera 移动到未知远处时不会加载、激活或显示未被 colony vision 覆盖的实体。
- [ ] 5.4 确保 camera `view_z` 切换只影响 render culling，不触发远处非视野实体加载。
- [ ] 5.5 调整 redraw 请求：只有 streaming 改变影响当前 camera 可见结果时才请求 entity redraw。
- [ ] 5.6 增加 redraw reason：`vision_streaming_changed`、`vision_source_moved_chunk`、`entity_left_keep_range`、`entity_entered_load_range`。

## 6. DebugHUD、AgentInfoSystem 与 Debug Commands

- [ ] 6.1 在 DebugHUD streaming panel 显示 Vision Sources、Vision Chunks、Load Chunks、Keep Chunks、Loaded Entities、Active Entities、Visible Entities、Camera Visible Entities、Load Padding、Keep Padding、Last Vision Source Moved。
- [ ] 6.2 在 AgentInfoSystem 输出 `entity_streaming.mode = "vision_centered"`、`vision_sources`、chunk counts、loaded counts、camera visible counts 与 padding 配置。
- [ ] 6.3 新增或修改 `debug.dump_vision_sources`，返回当前 vision source 列表、坐标、类型、z 与 vision radius。
- [ ] 6.4 修改 `debug.dump_entity_streaming`，返回 vision-centered streaming 状态，而不是只显示 camera chunks。
- [ ] 6.5 新增或修改 `debug.force_vision_streaming_update`，强制 VisionSourceSystem + EntityStreamingSystem 立即重算。

## 7. Regression 与验证

- [ ] 7.1 新增 `debug.run_vision_centered_streaming_regression`，创建 Colonist + Base，并确认二者拥有 `HasVisionComponent`。
- [ ] 7.2 在远处多个 chunks 生成/模拟大量实体，验证 Camera 单独移动到该区域时 `far_entities_loaded_by_camera_only == 0`。
- [ ] 7.3 将 Colonist 移动到远处区域附近，验证 vision chunks 更新且远处实体进入 load range 后被加载。
- [ ] 7.4 将 Colonist 稍微移出 load range 但仍在 keep range 内，验证实体不 unload。
- [ ] 7.5 将 Colonist 移出 keep range，验证实体 unload 并从 EntityRenderIndex 移除。
- [ ] 7.6 将 Camera 回到基地，验证 streaming 仍以 vision sources 为中心，不以 camera 为中心。
- [ ] 7.7 运行 Godot 项目启动检查，确认无启动报错。
- [ ] 7.8 运行相关 GDScript 静态检查/单元测试/回归命令，并记录 `debug.run_vision_centered_streaming_regression` 返回结果。
