## Why

线上房间仍有约 198 万总空闲容量，但 terminal 水位策略会把受压房停在约 50,000 空闲，而容量状态要求恢复到 80,000 空闲才重新成为正常接收方。该粘滞区与阻塞任务的预装载共同耗尽了可用接收通道，导致大量 `receiver_capacity` 阻塞和满仓房无法继续泄压。

## What Changes

- 让本地 terminal 排空目标与容量状态恢复水位使用同一份配置；受压房在 storage 有安全空间时持续排空到恢复水位，而不是停在固定 250,000 使用量。
- 统一 ResourceControl 与 Hub 的 receiver storage/terminal 安全容量计算，消除重复硬编码阈值。
- 用物理空闲、健康入站承诺、同 tick 预留和本地排空能力计算可接收容量，避免将实际可用房间永久排除，也避免重复预留。
- 仅为接收方仍安全、任务当前可执行或可在下一个发送槽执行的跨房任务生成 terminal feed；释放由长期容量阻塞任务占用的 staging 空间。
- 细分容量阻塞与 terminal 恢复状态的运行时观测，报告无合格 receiver、粘滞水位、阻塞 staging 和恢复进度。
- 增加 full → 50k free 粘滞区、protected-only terminal、blocked staging、receiver 恢复和多周期无振荡的回归覆盖。
- 保持当前 energy export、矿物/T3/生产保护、任务优先级、市场规则和主循环阶段顺序不变。

## Capabilities

### New Capabilities

- `terminal-headroom-recovery`: 让 storage/terminal 水位、receiver admission 和本地排空形成可恢复的闭环，并保证安全容量不被突破。
- `resource-transfer-staging-admission`: 只允许健康且近期可执行的跨房任务占用 terminal staging 空间，并在 blocker 变化时及时释放或恢复装载。

### Modified Capabilities

无。仓库当前没有已同步到 `openspec/specs/` 的基线物流能力规格。

## Impact

- 主要运行时代码：`src/runtime/resourceControl.ts`、`src/runtime/hubPlanner.ts` 和共享容量策略模块。
- 房内物流：`src/runtime/carrierTaskBoard.ts` 及 resource-control terminal feed/offload producer，但不新增 creep role。
- 类型与观测：`src/global.d.ts`、`Memory.runtime.resourceControl`、`scripts/monitor-service.mjs`。
- 测试：resource-control 水位/容量回归、Hub receiver 容量一致性、blocked staging 与 live-like 多房间恢复场景。
- 不新增外部依赖，不改变 console transfer API，不执行市场清仓。
