## Why

当前已建成的 Nuker 没有独立补给任务，Ghodium 缺口也不会进入现有 Hub 合成链，导致结构长期保持空载。能量补给还必须服从房间 `RESERVE` 状态和既有能量安全目标，避免为了武器储备削弱房间运行。

## What Changes

- 自动发现己方 Nuker，并持续把 Ghodium 补至结构容量上限。
- 优先使用本房可搬运 Ghodium；本房不足时创建受现有资源物流约束的跨房转运任务。
- 将尚未装入 Nuker 的 Ghodium 容量缺口作为 Hub 生产链的附加需求，使 `ZK + UL -> G` 及其上游步骤能够补足账号级真实缺口，同时保留现有 T3 生产需求。
- 通过 Carrier 任务板发布 Nuker 资源补给，并为待搬运库存建立生产资源预留，防止市场或其他自动物流重复消费。
- 仅在目标房间不处于 `RESERVE` 状态时补充 Nuker Energy；补给量只使用房间能量目标、Terminal 储备及既有生产/发送承诺之上的安全余量。
- 记录每个 Nuker 的容量、缺口、储备状态、转运和补给状态，供部署后验证。

## Capabilities

### New Capabilities

- `nuker-resource-supply`: 定义 Nuker 的 Ghodium 生产/跨房转运/本地搬运闭环，以及受 `RESERVE` 和能量安全线约束的 Energy 补给。

### Modified Capabilities

无。

## Impact

- 新增 Nuker 控制阶段并接入 `src/main.ts` 的既有生产顺序。
- 扩展 Hub 链式规划，使其接收非 T3 的附加生产需求。
- 扩展 Carrier 任务类型和结构类型，复用现有任务执行、Terminal 仲裁、资源转运与生产预留机制。
- 新增 Nuker、Hub 规划、Carrier 优先级和主循环顺序测试；部署后读取 shard1 的真实 Nuker、任务、转运和合成状态。
