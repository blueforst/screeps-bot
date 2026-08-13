## Why

现有 Hub RoomVisual 面板只展示合成进度、按来源房间聚合的任务数量和汇总 T3 余量，无法直接说明 Hub 是否健康、物流流向及阻塞原因；同时 overlay 每 tick 重复采集完整快照，现有 visual call 预算在线上也不能可靠计数。随着分布式合成、保护快照和资源转运可观测字段增加，需要把面板升级为异常优先、语义可靠且有明确运行成本上限的操作视图。

## What Changes

- 在 Hub 主面板顶部提供房间、Hub 状态、合成阶段和健康结论，并只在异常时展开缺料、错误、待规划、阻塞或保护快照异常。
- 将物流展示改为方向化任务摘要：import/reclaim 显示来源房间，export 显示目的房间，并携带资源、剩余量、年龄和阻塞原因。
- 将 T3 汇总余量改为逐化合物覆盖状态，分别表达 Hub 库存、Hub 底线和全网缺口，优先展示最严重缺口。
- 仅在存在可靠目标时绘制生产百分比；无目标时展示阶段与库存，不再使用固定 1,000 作为伪目标。
- 保留卫星房间本地生产面板，主面板只汇总分布式生产健康，避免恢复冗长的全量生产列表。
- 为通用 Panel 增加单次调用的动态半透明底板，并让绘制路径返回真实 visual call 使用量。
- 缓存 Hub visual model，按有限 tick 间隔或关键 revision/状态变化刷新采集结果，同时继续每 tick 绘制 RoomVisual。
- 对主面板和卫星面板实施真实调用预算与确定性截断，并补充正常态、异常态、方向、T3、缓存和预算测试。

## Capabilities

### New Capabilities

- `hub-visual-observability`: 定义 Hub 与卫星 RoomVisual 面板的健康摘要、方向化物流、逐化合物储备、可靠进度、自适应异常显示、缓存新鲜度及 visual call 预算合同。

### Modified Capabilities

无。

## Impact

- 主要修改 `src/runtime/hubProgress.ts`、`src/visual/panel.ts`、`src/visual/palette.ts` 及对应 Jest 测试。
- 保持 `hubPlanner`、`synthesisControl`、`resourceControl` 的执行所有权和 tick phase 顺序不变；不新增持久 Memory store 或迁移，现有 `Memory.analytics.hub` 仅增加向后兼容的观测字段；不改变任务、合成或市场行为。
- overlay 继续只读 `Game/Memory`，global heap 缓存丢失时可安全重建；低 CPU bucket 时仍跳过绘制。
- 不引入第三方依赖，不改变现有控制台命令返回合同。
