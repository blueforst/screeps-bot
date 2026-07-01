## 1. Operational Area 基础数据与组件

- [ ] 1.1 新增 `res://scripts/operational_area/OperationalAreaConfig.gd`，包含 Base/Colonist active/warm 半径、active/warm chunk padding、`update_interval_ticks` 与配置校验。
- [ ] 1.2 新增 `res://scripts/operational_area/OperationalAreaState.gd`，定义 `ACTIVE`、`WARM`、`FROZEN` 状态常量与状态比较/序列化辅助。
- [ ] 1.3 新增 `res://scripts/operational_area/OperationalAreaSourceComponent.gd`，包含 `source_kind`、`active_radius_cells`、`warm_radius_cells`、`enabled` 与默认初始化。
- [ ] 1.4 新增 `res://scripts/operational_area/OperationalChunkIndex.gd`，封装按 z-level 的 active/warm chunk set、去重、subset 校验、count 与 bounds 统计。
- [ ] 1.5 在组件注册、组件常量或 EntityManager component 工具中接入 `OperationalAreaSourceComponent`，保持与现有 `VisionSourceComponent` 并存。

## 2. Base / Colonist Source 挂载

- [ ] 2.1 在 `scripts/ecs/EntityFactory.gd` 的 Base 创建路径挂载 `OperationalAreaSourceComponent`，默认 `source_kind = &"base"`、active 96、warm 128。
- [ ] 2.2 在 `scripts/ecs/EntityFactory.gd` 的 Colonist 创建路径挂载 `OperationalAreaSourceComponent`，默认 `source_kind = &"colonist"`、active 32、warm 48。
- [ ] 2.3 在 Base/Colonist 加载恢复路径确保缺失 source component 的旧存档实体补齐默认组件。
- [ ] 2.4 保留 Base/Colonist 现有 `VisionSourceComponent` 行为，确认 Vision 不被 OperationalArea 替代或删除。

## 3. OperationalAreaSystem

- [ ] 3.1 新增 `res://scripts/operational_area/OperationalAreaSystem.gd`，收集所有 enabled `OperationalAreaSourceComponent` 实体并生成 source 列表。
- [ ] 3.2 实现 source coord + radius cells 到矩形 covered chunks 的转换，使用项目 chunk size 常量处理负坐标 floor。
- [ ] 3.3 按 z-level 合并多个 source 的 active chunks 与 warm chunks，同 z 去重、不同 z 分离。
- [ ] 3.4 实现 `update_operational_area()`、`rebuild()`、dirty reason、last update tick 与 `update_interval_ticks` 补偿更新。
- [ ] 3.5 实现 `is_coord_active()`、`is_coord_warm()`、`is_coord_frozen()`、`is_chunk_active()`、`is_chunk_warm()` 与 `get_operational_state_for_coord()`。
- [ ] 3.6 实现 `get_active_chunks_by_z()`、`get_warm_chunks_by_z()`、source stats、bounds stats 与 active subset of warm 校验。
- [ ] 3.7 在 source 创建、删除、enabled/半径变化、跨 chunk 移动、New Game、Load Game、debug force rebuild 时标记 dirty。
- [ ] 3.8 将 `OperationalAreaSystem` 接入 `scripts/ecs/ECSRoot.gd`，确保在 logistics/job/farm/streaming 等高频系统之前可用。

## 4. Entity Streaming 与 Render Index 集成

- [ ] 4.1 调整或新增 `EntityStreamingSystem` operational-area 输入：从 `OperationalAreaSystem.get_active_chunks_by_z()` / `get_warm_chunks_by_z()` 获取 simulation/cache 范围。
- [ ] 4.2 将 ACTIVE chunks 内 eligible entities 加入 active simulation/render candidate set，并更新 `EntityRenderIndex`。
- [ ] 4.3 将 WARM chunks 内 eligible entities 保留 loaded/cache，但不加入高频任务发布范围。
- [ ] 4.4 将 FROZEN 区域 eligible entities 移出 active simulation set 与 `EntityRenderIndex`，保留 EntityManager 持久数据。
- [ ] 4.5 移除 Camera visible chunks 对 entity activation / streaming dirty 的驱动关系，Camera 移动不得触发 frozen entity 激活。
- [ ] 4.6 确认 `VisibleEntityQuery` 仍只从 loaded/active renderables 中按 camera rect + `view_z` 做最终裁剪。
- [ ] 4.7 保留 terrain/procedural chunk 显示能力，确保 Camera 移到作业域外时最多显示 terrain/unknown，不显示未激活实体。

## 5. Job / Work / Logistics / Farm 范围限制

- [ ] 5.1 在 `ColonistJobSystem`、任务池或统一任务扫描入口增加 ACTIVE coord filter，排除 WARM/FROZEN 目标。
- [ ] 5.2 在 `ConstructionJobSystem` 中限制 build task 只从 ACTIVE ConstructionSite 发布或领取。
- [ ] 5.3 在 `ProductionJobSystem` / Workbench craft 任务入口限制 workbench craft task 只在 ACTIVE coord 发布。
- [ ] 5.4 在 `WorkActionSystem` 与 tile/designation 任务入口限制 chop、break、harvest bush、plant_crop、harvest_crop、tile work 只在 ACTIVE coord 发布。
- [ ] 5.5 在 `FarmSystem` 中 P0 只更新 ACTIVE farm zones / crop cells；WARM/FROZEN 暂停逐 tick growth 与 plant/harvest task 发布。
- [ ] 5.6 在 `LogisticsIndexSystem` 或 `LogisticsQueryService` 中增加 ACTIVE 作业域过滤，限制 ResourcePile、Container、ConstructionSite、Stockpile/Base 候选。
- [ ] 5.7 在 Hunger/food lookup 路径中保持 Colonist always active，但食物资源查询只返回 ACTIVE 作业域内候选。
- [ ] 5.8 为 logistics/task active-area cache 增加 `rebuild_active_area()` 或等价刷新入口，并由作业域重建后调用。

## 6. Pathfinding Bounds

- [ ] 6.1 扩展 `scripts/ecs/systems/PathfindingSystem.gd` 或 `PathfindingQuery.gd`，支持 optional operational area bounds / allowed chunks。
- [ ] 6.2 普通自动任务路径默认限制在 ACTIVE chunks 加可配置 WARM margin 内。
- [ ] 6.3 对 FROZEN 远处自动任务目标在大范围 A* 展开前返回失败原因或不可达结果。
- [ ] 6.4 为玩家直接命令、agent command 或 debug command 提供显式 override，允许必要时放宽作业域 bounds。

## 7. Save / Load 重建流程

- [ ] 7.1 在 `EntitySaveSerializer.gd` 中保存 `OperationalAreaSourceComponent` 的 `source_kind`、active radius、warm radius 与 enabled 状态。
- [ ] 7.2 在实体恢复时重建 `OperationalAreaSourceComponent`，并对旧存档 Base/Colonist 执行默认组件补齐。
- [ ] 7.3 确保 active chunks、warm chunks、frozen chunks、runtime cache、stats 不写入存档。
- [ ] 7.4 在 `GameStateSerializer.restore_game_state()` 或 GameFlow load 完成后按顺序调用 `OperationalAreaSystem.rebuild()`、EntityStreaming rebuild、task/logistics active-area rebuild。
- [ ] 7.5 增加读档后一 tick 前的安全刷新，避免 Job/Logistics/Farm 使用旧 active-area cache。

## 8. DebugHUD / AgentInfo / Debug Commands

- [ ] 8.1 在 `DebugHUDPanelBuilder.gd` / panel registry 中新增默认隐藏的 Operational Area panel。
- [ ] 8.2 面板显示 Source count、Base sources、Colonist sources、Active chunks、Warm chunks、Frozen chunks estimated、Active entities、Warm cached entities、Camera inside active area、Selected coord state。
- [ ] 8.3 实现 `debug.dump_operational_area`，返回 sources、chunks、counts、bounds、config 与 dirty stats。
- [ ] 8.4 实现 `debug.toggle_operational_area_overlay`，绘制 ACTIVE 绿色透明 overlay、WARM 黄色透明 overlay、FROZEN 无 overlay。
- [ ] 8.5 实现 `debug.force_operational_area_rebuild`，强制作业域、streaming、task/logistics active-area cache 重建。
- [ ] 8.6 在 `AgentInfoSystem.gd` 输出 `operational_area` payload，包含 sources、active/warm chunk counts、selected coord state、camera coord state。

## 9. Regression 与手动验收表面

- [ ] 9.1 新增 `debug.run_operational_area_regression`，返回 `ok`、`stages`、`counts`、`warnings`、`errors`。
- [ ] 9.2 Regression 验证 New Game 后 Base 与 Colonist 均有 `OperationalAreaSourceComponent`。
- [ ] 9.3 Regression 验证 active chunks 与 warm chunks 计算成功，且 active chunks 是 warm chunks 子集。
- [ ] 9.4 Regression 在 ACTIVE 区域创建 ResourcePile / Tree / Farm / ConstructionSite，并验证任务与 logistics active query 可用。
- [ ] 9.5 Regression 在 WARM but not ACTIVE 区域创建 ResourcePile / Farm，并验证 P0 不发布高频任务、不返回 active logistics 候选。
- [ ] 9.6 Regression 在 FROZEN 区域创建 ResourcePile，并验证不进入 task pool、logistics active query 或 EntityRenderIndex。
- [ ] 9.7 Regression 移动 Colonist 到远处，验证作业域随 Colonist 扩展。
- [ ] 9.8 Regression 移动 Camera 到 FROZEN 区域，验证 Camera 不激活 frozen entities。
- [ ] 9.9 Regression 执行 Save / Load 或等价序列化恢复，验证作业域从 source components 重建。
- [ ] 9.10 运行 Godot 项目启动检查、相关 GDScript 静态检查/回归命令，并记录 `debug.run_operational_area_regression` 结果。

## 10. Documentation 与验收对齐

- [ ] 10.1 在架构文档或开发注释中说明 OperationalArea 与 Zone、Room、Vision 的区别。
- [ ] 10.2 标记 Warm area crop low-frequency simulation、connected operational area id、road/outpost network、跨作业域物流为 P1+。
- [ ] 10.3 对照 OpenSpec 验收标准逐项确认：新增文件存在、Base/Colonist source、三档状态、系统限制、Camera 行为、Save/Load、DebugHUD、AgentInfo、Regression、无启动报错。
