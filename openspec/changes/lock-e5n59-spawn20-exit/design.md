## Context

E5N59 的 Spawn20 位于 `(27,35)`。北侧 `(27,34)` 是连接房间主体的唯一可用出口；南侧 `(26,36)` 与 `(27,36)` 是被 Extension、Spawn 和天然墙包围的双格封闭区。当前 `mainSpawn` 未设置 `SpawnOptions.directions`，Screeps 因而按默认方向顺序寻找第一个不忙的相邻格。若北侧在出生完成 tick 被占用，默认回退会选择南侧封闭格。

该问题位于 Spawn executor 边界，且会影响 Spawn20 生产的所有角色。队列生产者、role 或寻路层都无法在 creep 已落入封闭区后提供合法逃逸路径。

## Goals / Non-Goals

**Goals:**

- 让 E5N59/Spawn20 仅通过北侧安全格完成出生。
- 北侧临时繁忙时使用 Screeps 原生延迟重试，而不是选择其他方向。
- 保持所有非目标 Spawn 与现有出生请求字段完全兼容。

**Non-Goals:**

- 不实现通用地形连通性或运行时 flood-fill。
- 不改变 Spawn 队列 owner、排序、body、名称、role、Creep Memory 或出生失败重试。
- 不为已经困在封闭区的 creep 增加寻路、自杀或结构拆除逻辑。

## Decisions

### 使用精确房间与 Spawn 名的静态策略

在 `mountSpawn` 内以 `room.name === "E5N59" && spawn.name === "Spawn20"` 识别布局特例，并返回新的 `[TOP]` 数组。房间与名称双重限定使规则的作用域可审计，也避免仅按名称误作用于测试或未来复用场景。

备选方案是按周边结构运行 PathFinder/flood-fill 自动判定安全出口。该方案会把布局分析、缓存失效与额外 CPU 引入每次出生路径，而当前只有一个已确认的固定布局例外，因此不采用。

### 在 `spawnCreep` 创建时写入 directions

`mainSpawn` 继续组装既有 memory，并仅在命中特例时给 options 增加 `directions: [TOP]`。策略位于所有角色共享的最低出生执行层，不需要在 carrier 或其他 role 中重复处理。

不在每 tick 对 `Spawning.setDirections` 发 intent；部署时若恰有旧版本启动的在途出生，则该次仍沿用原 directions，之后所有新出生均受保护。部署前检查目标 Spawn idle 可消除此一次性窗口。

### 非目标 Spawn 不携带 directions 字段

未命中特例时保持现有 options 形状，不显式传入 `undefined`，确保 Screeps 默认方向语义及现有单元测试边界不变。

## Risks / Trade-offs

- [Spawn20 改名、销毁重建或布局变化后静态策略可能过期] → 将房间与 Spawn 名写入测试和注释；布局变更时同步审查该策略。
- [北侧长时间被占会延长 Spawn busy] → 这是安全优先的预期代价；北侧是道路且通常只会短暂占用。
- [规则只覆盖一个已知布局] → 保持最小范围；出现第二个案例后再基于证据设计通用配置，而不是提前增加运行时复杂度。

## Migration Plan

1. 部署前确认 shard1 当前活跃且 E5N59/Spawn20 没有在途出生。
2. 发布包含新 directions 的 bundle。
3. 验证 `lastDeployTag`、E5N59 可见性及 Spawn20 运行状态。
4. 后续一次 Spawn20 出生可通过实时对象中的 `spawning.directions` 或完成落点进一步验收。

回滚时删除静态策略及对应测试并重新部署；没有 Memory 数据需要迁移或清理。

## Open Questions

无。
