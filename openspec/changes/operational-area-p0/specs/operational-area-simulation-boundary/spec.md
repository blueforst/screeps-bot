## ADDED Requirements

### Requirement: OperationalArea defines runtime simulation boundary
系统 SHALL 提供 `OperationalArea` 作业域作为运行时模拟边界 / chunk 集合，并 SHALL NOT 将作业域实现为 Entity、ZoneData、Room、SettlementSite、FixedMap 或 ColonyMap。

#### Scenario: OperationalArea is not player-drawn zone
- **WHEN** 玩家创建 Stockpile Zone、Farm Zone 或未来 Room
- **THEN** `OperationalArea` MUST NOT 作为 ZoneData 被创建、保存、编辑或渲染为玩家功能区

#### Scenario: OperationalArea is runtime-derived state
- **WHEN** New Game 或 Load Game 完成实体恢复
- **THEN** 系统 MUST 从有效 source entities 重算 active chunks、warm chunks、bounds 与 stats

### Requirement: OperationalAreaSourceComponent declares source contribution
系统 SHALL 提供 `OperationalAreaSourceComponent`，声明实体是否参与作业域、source kind、active radius、warm radius 与 enabled 状态。

#### Scenario: Base has operational area source
- **WHEN** 新建或加载 Base 实体
- **THEN** Base MUST 拥有 enabled 的 `OperationalAreaSourceComponent`，`source_kind` 为 `base`，`active_radius_cells` 为 96，`warm_radius_cells` 为 128

#### Scenario: Colonist has operational area source
- **WHEN** 新建或加载 Colonist 实体
- **THEN** Colonist MUST 拥有 enabled 的 `OperationalAreaSourceComponent`，`source_kind` 为 `colonist`，`active_radius_cells` 为 32，`warm_radius_cells` 为 48

#### Scenario: Vision component remains separate
- **WHEN** Base 或 Colonist 同时拥有 `VisionSourceComponent` 与 `OperationalAreaSourceComponent`
- **THEN** Vision MUST 继续用于可见/迷雾/探索，OperationalArea MUST 用于模拟范围，二者 MUST NOT 互相删除或替代

### Requirement: OperationalAreaConfig provides default radii and update cadence
系统 SHALL 提供 `OperationalAreaConfig`，包含 Base/Colonist active/warm 半径、active/warm chunk padding 与 `update_interval_ticks` 默认值。

#### Scenario: Default config values are available
- **WHEN** 创建默认 `OperationalAreaConfig`
- **THEN** `base_active_radius_cells` MUST 为 96，`base_warm_radius_cells` MUST 为 128，`colonist_active_radius_cells` MUST 为 32，`colonist_warm_radius_cells` MUST 为 48，`active_chunk_padding` MUST 为 0，`warm_chunk_padding` MUST 为 1，`update_interval_ticks` MUST 为 10

#### Scenario: Invalid warm radius is corrected
- **WHEN** 配置中的某个 warm radius 小于对应 active radius
- **THEN** 配置校验 MUST 将 warm radius 修正到不小于 active radius，并 MUST 记录 warning 或 debug stats

### Requirement: OperationalAreaSystem calculates active and warm chunks by z
系统 SHALL 提供 `OperationalAreaSystem`，收集所有 enabled source，根据 source coord 与半径计算矩形 chunk 覆盖，并按 z-level 合并为 active chunks 与 warm chunks。

#### Scenario: Multiple sources merge into one operational area
- **WHEN** 同一 z-level 上存在 Base 与多个 Colonist sources
- **THEN** `OperationalAreaSystem` MUST 合并它们贡献的 active chunks 与 warm chunks，并 MUST 对重复 chunks 去重

#### Scenario: Sources on different z stay separated
- **WHEN** sources 位于不同 z-level
- **THEN** `OperationalAreaSystem` MUST 按 z-level 分组输出 active/warm chunks，且 MUST NOT 把一个 z-level 的 chunks 混入另一个 z-level

#### Scenario: Active chunks are subset of warm chunks
- **WHEN** 作业域重算完成
- **THEN** 每个 z-level 的 active chunk set MUST 是对应 warm chunk set 的子集

### Requirement: OperationalArea state queries expose ACTIVE WARM FROZEN
系统 SHALL 支持 ACTIVE、WARM、FROZEN 三档状态查询，并 SHALL 使用 active > warm > frozen 的优先级。

#### Scenario: Active takes precedence over warm
- **WHEN** 某个 coord 或 chunk 同时包含在 active 与 warm set 中
- **THEN** `get_operational_state_for_coord()` MUST 返回 `active`

#### Scenario: Warm coord is not active
- **WHEN** 某个 coord 位于 warm set 但不位于 active set
- **THEN** `is_coord_warm()` MUST 返回 true，`is_coord_active()` MUST 返回 false，状态 MUST 为 `warm`

#### Scenario: Outside warm is frozen
- **WHEN** 某个 coord 不位于 active set 或 warm set
- **THEN** `is_coord_frozen()` MUST 返回 true，状态 MUST 为 `frozen`

### Requirement: OperationalArea updates are dirty-driven and rebuildable
系统 SHALL 在 source 创建、删除、enabled 状态变化、半径变化、跨 chunk 移动、New Game、Load Game 或 debug force rebuild 时标记作业域 dirty，并 SHALL 支持强制重建。

#### Scenario: Colonist movement expands operational area
- **WHEN** Colonist 移动到原 Base 作业域外的新 chunk
- **THEN** 系统 MUST 标记作业域 dirty，并在下一次更新后让该 Colonist 周围 chunks 进入 active/warm 作业域

#### Scenario: Periodic update catches missed dirty event
- **WHEN** dirty 标记被遗漏但 `update_interval_ticks` 到达
- **THEN** `OperationalAreaSystem` MUST 执行补偿更新以避免长期 stale chunk sets

### Requirement: Entity streaming is centered on operational area
系统 SHALL 让 `EntityStreamingSystem` 以 `OperationalAreaSystem` 输出的 active/warm chunks 为中心维护 loaded/cache、active simulation set 与 EntityRenderIndex。

#### Scenario: Active chunk entities enter active render index
- **WHEN** eligible entity 位于 ACTIVE chunk
- **THEN** 该实体 MUST 进入 active simulation/render candidate set，并且可渲染实体 MUST 加入 `EntityRenderIndex`

#### Scenario: Warm chunk entities remain cached without high frequency tasks
- **WHEN** eligible entity 位于 WARM 但不位于 ACTIVE
- **THEN** 该实体 MAY 保留 loaded/cache 状态，但 MUST NOT 因此进入高频任务发布或领取范围

#### Scenario: Frozen entities leave active render index
- **WHEN** eligible entity 位于 FROZEN 区域
- **THEN** 该实体 MUST NOT 位于 active simulation set 或 `EntityRenderIndex`，并 MUST NOT 因 Camera 移动被激活

### Requirement: Camera only performs final render culling
系统 SHALL 让 Camera 只负责从 loaded/active entities 中按 camera visible rect 与 `view_z` 进行最终绘制裁剪，并 SHALL NOT 让 Camera 触发作业域、entity activation 或 streaming 更新。

#### Scenario: Camera movement does not activate frozen entities
- **WHEN** Camera 移动到 FROZEN 区域
- **THEN** 该区域实体 MUST NOT 因 Camera 移动而进入 active simulation、EntityRenderIndex、任务池或物流查询结果

#### Scenario: Renderer still culls by camera rect
- **WHEN** ACTIVE 区域内存在多个 loaded renderable entities
- **THEN** `VisibleEntityQuery` 与 renderer MUST 仍按 camera rect 与 `view_z` 返回当前屏幕可绘制实体

### Requirement: Job and work systems only publish active area tasks
系统 SHALL 限制 JobSystem、ConstructionJobSystem、ProductionJobSystem、WorkActionSystem 与相关任务池只发布、领取或分配 ACTIVE 作业域内的高频任务。

#### Scenario: Active build task is available
- **WHEN** ConstructionSite 位于 ACTIVE coord 且材料/条件满足
- **THEN** build task MAY 被发布并进入可领取任务池

#### Scenario: Warm target does not publish high frequency task
- **WHEN** plant_crop、harvest_crop、build、chop、break、harvest bush 或 workbench craft target 位于 WARM 但不位于 ACTIVE
- **THEN** P0 MUST NOT 将该 target 发布为可领取高频任务

#### Scenario: Frozen target is excluded from task pool
- **WHEN** task target 位于 FROZEN coord
- **THEN** 该 target MUST NOT 进入任务池、任务扫描结果或自动分配结果

### Requirement: Logistics queries are limited to active operational area
系统 SHALL 限制 `LogisticsIndexSystem` 与 `LogisticsQueryService` 只返回 ACTIVE 作业域内的资源、容器、施工点、Stockpile/Base 物流候选。

#### Scenario: Construction delivery searches active resources only
- **WHEN** ACTIVE ConstructionSite 需要 wood
- **THEN** logistics query MUST 只在 ACTIVE 作业域内搜索 wood ResourcePile、Stockpile、Base 或 Container 候选

#### Scenario: Warm resource is not matched in P0
- **WHEN** ResourcePile 位于 WARM 但不位于 ACTIVE
- **THEN** P0 logistics query MUST NOT 返回该 ResourcePile 作为自动 haul、construction delivery 或 food search 候选

#### Scenario: Frozen resource is invisible to logistics
- **WHEN** ResourcePile 位于 FROZEN 区域
- **THEN** 该 ResourcePile MUST NOT 进入 active logistics query 结果

### Requirement: FarmSystem updates active farms only in P0
系统 SHALL 在 P0 只更新 ACTIVE 作业域内的 farm zones / crop cells，并 SHALL 只从 ACTIVE coord 发布 plant/harvest tasks。

#### Scenario: Active crop grows and publishes tasks
- **WHEN** Farm crop 位于 ACTIVE coord
- **THEN** FarmSystem MAY 正常更新 crop growth，并 MAY 在条件满足时发布 plant_crop 或 harvest_crop task

#### Scenario: Warm crop low frequency simulation is deferred
- **WHEN** Farm crop 位于 WARM 但不位于 ACTIVE
- **THEN** P0 MUST 暂停逐 tick growth 与 plant/harvest task 发布，并 MUST 将 warm low-frequency crop simulation 留作 P1

#### Scenario: Frozen crop is not ticked
- **WHEN** Farm crop 位于 FROZEN coord
- **THEN** FarmSystem MUST NOT 对该 crop 执行逐 tick growth 或高频任务发布

### Requirement: Pathfinding supports operational area bounds for automatic tasks
系统 SHALL 为普通自动任务 pathfinding 增加默认作业域 bounds，允许在 ACTIVE chunks 加可选 WARM margin 内搜索，并 SHALL 允许玩家直接命令或 debug 命令显式放宽范围。

#### Scenario: Automatic job path stays inside operational bounds
- **WHEN** Colonist 为自动任务寻路
- **THEN** PathfindingSystem SHOULD 限制搜索在 ACTIVE 作业域或配置允许的 WARM margin 内

#### Scenario: Far frozen target is rejected early
- **WHEN** 自动任务目标位于 FROZEN 区域且没有 explicit override
- **THEN** PathfindingSystem SHOULD 在大范围 A* 展开前返回失败或不可达原因

### Requirement: Save and load rebuild operational area from source components
系统 SHALL 保存实体上的 `OperationalAreaSourceComponent`，并 SHALL NOT 保存 active chunks、warm chunks、frozen chunks、runtime cache 或 stats。

#### Scenario: Source component is persisted
- **WHEN** 保存包含 Base 与 Colonist 的游戏
- **THEN** Save/Load MUST 持久化每个 source entity 的 source kind、active radius、warm radius 与 enabled 状态

#### Scenario: Runtime chunks are rebuilt after load
- **WHEN** 读档恢复实体完成
- **THEN** 系统 MUST 调用作业域重建流程，并 MUST 基于恢复后的 source entities 重算 active/warm chunks

#### Scenario: Dependent systems rebuild after operational area
- **WHEN** Load Game 完成作业域重建
- **THEN** EntityStreamingSystem、任务池/JobSystem 与 LogisticsIndex MUST 使用最新 active/warm 作业域重建或刷新 active-area cache

### Requirement: DebugHUD exposes operational area state
系统 SHALL 在 DebugHUD 中提供默认隐藏的 Operational Area panel，展示 sources、chunk counts、entity counts、camera/selected coord state 与 overlay 状态。

#### Scenario: Panel shows operational area stats
- **WHEN** DebugHUD Operational Area panel 打开
- **THEN** 面板 MUST 显示 Source count、Base sources、Colonist sources、Active chunks、Warm chunks、Frozen chunks estimated、Active entities、Warm cached entities、Camera inside active area、Selected coord state

#### Scenario: Overlay distinguishes active and warm chunks
- **WHEN** `debug.toggle_operational_area_overlay` 开启 overlay
- **THEN** ACTIVE chunks MUST 以绿色透明 overlay 显示，WARM chunks MUST 以黄色透明 overlay 显示，FROZEN 区域 MUST 不显示 overlay

### Requirement: AgentInfoSystem exports operational area payload
系统 SHALL 在 AgentInfoSystem snapshot 中输出 `operational_area` JSON payload，包含 sources、active/warm counts、selected coord state 与 camera coord state。

#### Scenario: Agent snapshot includes sources
- **WHEN** AgentInfoSystem 生成 world snapshot
- **THEN** `operational_area.sources` MUST 包含每个 source 的 `entity_id`、`type`、`coord`、`active_radius_cells`、`warm_radius_cells`

#### Scenario: Agent snapshot includes state counts
- **WHEN** AgentInfoSystem 生成 world snapshot
- **THEN** `operational_area` MUST 包含 `active_chunk_count`、`warm_chunk_count`、`selected_coord_state`、`camera_coord_state`

### Requirement: Debug commands inspect and validate operational area
系统 SHALL 提供 `debug.dump_operational_area`、`debug.toggle_operational_area_overlay`、`debug.force_operational_area_rebuild` 与 `debug.run_operational_area_regression`。

#### Scenario: Dump command returns current state
- **WHEN** 调用 `debug.dump_operational_area`
- **THEN** 系统 MUST 返回 sources、active chunks、warm chunks、counts、bounds 与 config 摘要

#### Scenario: Force rebuild recomputes chunks
- **WHEN** 调用 `debug.force_operational_area_rebuild`
- **THEN** 系统 MUST 立即重算作业域，并 MUST 触发依赖的 streaming/task/logistics active-area refresh

#### Scenario: Regression validates P0 acceptance
- **WHEN** 调用 `debug.run_operational_area_regression`
- **THEN** 返回结果 MUST 包含 `ok`、`stages`、`counts`、`warnings`、`errors`，且 stages MUST 覆盖 sources_exist、active_subset_of_warm、active_area_tasks_enabled、warm_area_no_high_freq_tasks、frozen_area_not_active、colonist_extends_area、camera_does_not_activate_frozen、save_load_rebuild
