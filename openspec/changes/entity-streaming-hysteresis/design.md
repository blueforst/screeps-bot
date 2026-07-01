## Context

项目目标是为 Godot 4.x colony/world simulation 增加实体加载/激活/清理的 hysteresis 缓存机制。上一版 camera-centered 方案会把镜头位置错误地当作世界感知范围：玩家把 Camera 平移到远处未知区域时，远处实体可能被加载、激活或显示；Camera 在边界附近移动也会造成 load/unload 抖动。

修正版将 streaming 的中心改为拥有 `HasVisionComponent` 的实体。Colonist、Base、未来哨塔/火把/侦察单位等 Vision Sources 决定 colony 当前能感知哪些 chunk；EntityStreamingSystem 只基于这些 vision chunks 计算 load/keep range。Camera 只负责从已加载/已知实体中按当前屏幕 rect 与 `view_z` 做最终绘制裁剪。

当前 P0 不做复杂实体反序列化/存盘卸载；EntityManager 仍可保存全量实体数据。Streaming 的“加载/卸载”语义是控制实体是否进入 active simulation set、EntityRenderIndex 与高频渲染/更新候选集合。

## Goals / Non-Goals

**Goals:**

- Entity streaming MUST 以 `HasVisionComponent` 实体为中心，而不是以 Camera 为中心。
- Colonist 与 Base MUST 默认拥有 `HasVisionComponent`，分别提供 12 cells 与 20 cells 的默认视野半径。
- Vision chunks MUST 按 z-level 分组并合并多个 vision sources。
- Entity load range MUST 小于 entity keep range，形成 hysteresis 缓存区。
- Camera 移动 MUST NOT 触发实体 load/unload；只有 vision source 创建、删除、跨 chunk 移动、半径变化、New Game/Load Game/debug force update 等触发 streaming dirty。
- EntityRenderIndex MUST 只索引 loaded/active renderable entities；VisibleEntityQuery 再按 Camera rect + `view_z` 查询当前屏幕可绘制实体。
- view_z 切换 MUST NOT 加载远处非视野实体，只影响当前渲染裁剪。
- DebugHUD、AgentInfoSystem 与 debug commands MUST 暴露 vision-centered streaming 状态与 regression。

**Non-Goals:**

- 不重写 ECS、EntityManager、Save/Load 或 WorldCell/chunk 存储。
- P0 不实现完整 Fog-of-War、last-known entity marker、跨 z 视野传播、光照遮挡或 line-of-sight 阻挡。
- P0 不把 Wall、Floor、Farm crop、Stockpile、ZoneData、Cliff/Ramp visual 等非 Entity 对象纳入 EntityStreamingSystem。
- 不让 Colonist、Base、当前选中实体、正在执行任务的实体等关键实体因为离开视野而停止核心逻辑。

## Decisions

### 1. Streaming 以 Vision Sources 为中心，不以 Camera 为中心

选择：`VisionSourceSystem` 收集所有带 `HasVisionComponent` 且 `provides_entity_streaming == true` 的实体，计算 `vision_chunks_by_z`，EntityStreamingSystem 基于它计算 load/keep ranges。

理由：Colony simulation 的“可感知区域”应由殖民者、基地、哨塔、火把、侦察单位等游戏内对象决定。Camera 是玩家观察工具，不应授予远处未知区域模拟/渲染资格。

替代方案：继续使用 camera visible chunks 作为 streaming center。拒绝，因为 Camera 平移会泄露未知实体、激活远处区域，并在边界处造成 load/unload 抖动。

### 2. `HasVisionComponent` 是 Vision Source 的唯一显式入口

选择：新增或复用 `res://scripts/ecs/components/HasVisionComponent.gd`：

```gdscript
extends RefCounted
class_name HasVisionComponent

var vision_radius_cells: int
var reveal_fog: bool
var provides_entity_streaming: bool

func _init(
	p_vision_radius_cells: int = 12,
	p_reveal_fog: bool = true,
	p_provides_entity_streaming: bool = true
) -> void:
	vision_radius_cells = p_vision_radius_cells
	reveal_fog = p_reveal_fog
	provides_entity_streaming = p_provides_entity_streaming
```

Colonist 默认 `vision_radius_cells = 12`，Base 默认 `vision_radius_cells = 20`。未来火把/哨塔/侦察单位可通过同一组件接入。

理由：组件化入口避免在 EntityStreamingSystem 里硬编码实体类型，也让后续扩展 vision source 更安全。

替代方案：EntityStreamingSystem 内部按 entity type 判断 Colonist/Base。拒绝，因为会把 vision policy 分散到 streaming 逻辑，未来扩展成本高。

### 3. VisionSourceSystem 负责 vision chunks，EntityStreamingSystem 负责 load/keep hysteresis

选择：拆分职责：

- `VisionSourceSystem`：发现 vision sources，计算每个 source 覆盖的 chunks，按 z 合并，记录 dirty reason 与 last moved source。
- `EntityStreamingSystem`：接收 `vision_chunks_by_z`，外扩得到 load/keep chunk sets，维护 loaded/active entity set。

理由：Vision 是感知/探索问题，Streaming 是实体生命周期/索引问题。拆开后 DebugHUD 与 AgentInfoSystem 也能分别展示 vision source 与 streaming 统计。

替代方案：把 vision 计算直接写进 EntityStreamingSystem。可行但耦合过高，会让 fog、known area、vision source dirty tracking 难以独立演进。

### 4. `EntityStreamingConfig` 使用 vision padding

选择：配置改为：

```gdscript
extends RefCounted
class_name EntityStreamingConfig

var vision_load_padding_chunks: int = 1
var vision_keep_padding_chunks: int = 3

var update_interval_ticks: int = 10
var max_load_per_update: int = 128
var max_unload_per_update: int = 128

var keep_non_current_z_loaded: bool = true

func validate() -> void:
	if vision_keep_padding_chunks <= vision_load_padding_chunks:
		vision_keep_padding_chunks = vision_load_padding_chunks + 1
```

含义：vision chunks 是 `HasVisionComponent` 当前覆盖的 chunks；load chunks 是 vision chunks 外扩 `vision_load_padding_chunks`；keep chunks 是 vision chunks 外扩 `vision_keep_padding_chunks`。

理由：配置名直接表达 streaming 源头是 vision，不再保留 camera padding 误导。

替代方案：沿用 `load_padding_chunks/keep_padding_chunks`。可用但语义不够明确，容易再次被接到 camera visible chunks。

### 5. Always Active 与 Vision-loaded 分类分离

选择：

- Always Active：Colonist、Base、当前选中实体、正在执行任务的实体、关键全局 controller entity。它们永远保留在 simulation active set，但渲染仍受 camera rect 影响。
- Vision-loaded：Tree、BerryBush、StoneBoulder、ResourcePile、ConstructionSite、Workbench、野生植物，未来动物/敌人按设计决定。它们进入 vision load range 才激活/加入 render index，离开 vision keep range 才清理。

理由：Colonist 离开屏幕或离开某个 vision range 不应停止饥饿、任务、移动等核心模拟；静态资源/建筑/采集对象适合通过 vision streaming 降低渲染与高频更新候选集合。

替代方案：所有实体都按 streaming 卸载。拒绝，因为会破坏核心模拟与任务执行。

### 6. Camera 只负责 VisibleEntityQuery / EntityRenderer culling

选择：Camera 移动只更新当前 screen visible entity list：

```text
EntityStreamingSystem -> loaded/active entity set
EntityRenderIndex -> loaded/active renderable entities
VisibleEntityQuery -> camera rect + view_z culling
EntityRenderer -> draw visible entities
```

理由：这样 Camera 移到未知远处时，可以显示 terrain/fog/unknown，但不会加载未被 colony vision 覆盖的实体，也不会显示未发现实体。

替代方案：Camera movement 顺便刷新 streaming。拒绝，因为与核心修正目标冲突。

### 7. view_z 不驱动 streaming

选择：Vision source 主要加载自身所在 z-level；不同 z 的 Colonist/Base 分别贡献不同 z 的 `vision_chunks_by_z`。Camera `view_z` 切换只影响 EntityRenderer 查询哪个 z 的 loaded visible entities。

理由：切换视角楼层不应让远处非视野实体被加载。跨 z 视野（open_space/stairs/ramp）留作后续扩展。

替代方案：view_z 切换时以 camera 层刷新 streaming。拒绝，因为仍会把 Camera/view_z 变成 loading center。

### 8. Redraw 只在可见影响时请求

选择：Vision source 移动导致 loaded set 改变时，只有影响当前 camera 可见区域或当前 visible draw list 时才请求 entity redraw；Camera 移动只更新 visible query，不触发 load/unload。新增 reason：`vision_streaming_changed`、`vision_source_moved_chunk`、`entity_left_keep_range`、`entity_entered_load_range`。

理由：减少离屏实体进入/离开 streaming range 时造成的不必要 redraw。

替代方案：任何 streaming change 都 redraw。简单但会放大离屏卸载带来的 redraw 成本。

## Risks / Trade-offs

- [Risk] 当前项目若还没有 FogSystem，Camera 移到未知区域时 terrain/unknown 的表现可能不完整 → Mitigation: P0 只强制 Camera 不参与 entity streaming，不要求 last-known marker 或完整 fog。
- [Risk] EntityManager 仍保存全量实体，内存不会因 P0 streaming 降低 → Mitigation: P0 明确只优化 active/render/high-frequency candidate set，真正序列化卸载留到后续。
- [Risk] Always Active 判定过宽会降低 streaming 收益 → Mitigation: 初版只列核心模拟必需实体，DebugHUD/AgentInfoSystem 暴露 active/loaded counts 便于调参。
- [Risk] Vision source dirty 漏标会造成 chunk index 或 render index stale → Mitigation: 在创建/删除/移动跨 chunk/半径变化/New Game/Load Game/debug force update 全部触发 dirty，并保留 `update_interval_ticks` 定时补偿。
- [Risk] 多个 z-level 与未来跨 z 视野可能复杂 → Mitigation: P0 按 source.z 分组，跨 z 传播作为后续扩展，不在本轮隐式实现。
