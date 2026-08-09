## Why

当前 Nuker Energy 只有在 Storage 达到 `energyTarget` 后才会创建补给任务。E6N59 等非储备房间即使仍显著高于生存 `energyFloor` 且 Terminal 也有安全余量，也会因略低于目标水位而得到 `safeEnergy = 0`，长期无法利用空闲 Carrier 渐进填充 Nuker。

同时，Nuker Energy 的“低优先级”目前仅依赖数值 `40` 小于现有任务，缺少结构性隔离；单个任务还会一次预留全部安全余量。需要把它收敛为受生存底线保护、单 Carrier 批次、只在物流空闲窗口执行的后台任务。

## What Changes

- 非 `RESERVE` 房间在 Storage 不低于 `energyFloor` 时即可使用 Storage 高于 floor、Terminal 高于 reserve 的本地 Energy；继续扣除生产预留、pending outgoing 和其他 Carrier 承诺。
- 单次 Nuker Energy 任务及对应 production reservation 最多为标准 Carrier 容量 1000，避免后台任务长期占用大额库存。
- 对同一任务建立仅当前 tick 有效的原子执行额度；多个 Carrier 的成功 pickup 与普通携能 fallback 合计不得超过任务及步骤额度，失败路径必须释放未消费 claim。
- 将 Nuker Energy priority 降为 0，并从通用 Carrier task 竞争中结构性排除；仅在普通 Energy、所有正常任务板任务、dead-store 清理和既有 replacement retirement 门禁之后接受新 pickup。
- 尚未 withdraw 的旧 Nuker Energy assignment 可被新正常任务覆盖；已接受的 withdraw 仍按快照交付。
- 保持 `RESERVE` 禁止新任务、Terminal reserve、全部既有承诺保护和不创建跨房 Energy 的合同；不加入 aging 或完成时限。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `nuker-resource-supply`: 调整非储备 Energy 的安全水位、单批上限、结构性最低优先级和空闲窗口可执行合同。

## Impact

- 修改 `src/runtime/nukerControl.ts` 的 Energy 安全余量、计划批次和 priority。
- 修改 `src/runtime/carrierTaskBoard.ts` 与 `src/roles/carrier.ts`，增加瞬时执行额度并调整任务选择分层，但不改变持久 Memory schema 或主循环阶段。
- 扩展 NukerControl、Carrier role 和 Carrier task board 的回归测试。
