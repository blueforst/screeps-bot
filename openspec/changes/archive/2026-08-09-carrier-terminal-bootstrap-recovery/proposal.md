## Why

E7N58 当前 Storage 没有 Energy、没有本地 miner，Spawn/Extension 仅有 300/5,600 Energy；虽然 Terminal 尚有 42,209 Energy，通用 carrier pickup 的固定 50,000 Terminal 保底使其可取量为零，房间因此无法出生恢复生产链所需的 creep。需要一个显式、房间级且会自动退出的 bootstrap 通道，在不抽穿 Terminal 保底或跨房物流承诺的前提下打破该死锁。

## What Changes

- 新增显式 room-scoped Terminal bootstrap recovery flag；未启用的房间完全保持现有 50,000 Energy pickup reserve。
- flag 生效时，仅允许物理位于该房且 assigned room 相同的 carrier 为本房 Spawn/Extension 供能时，从 Terminal 使用高于 ResourceControl `terminalEnergyReserve` 的 Energy；这包括配置已经清理、按物理房间回退归属的现存应急 carrier。
- Terminal pickup 继续受 market exposure 与同 tick terminal action claim 约束，不改变跨房 transfer、市场或普通资源搬运语义。
- Terminal 最终 withdraw intent 必须受该 carrier 实际 pickup reservation claim amount 限制，避免同 tick 多 carrier 在未建立 market in-flight ledger 时重复消费同一份 reserve 余量。
- 使用连续多 tick 的可验证恢复证据自动删除 flag：非 spawning canonical managed carrier、本地 miner 均存活，且房间供能持续达到可持续门槛；单 tick Energy 偶然升高不得退出。
- 既有周期 Memory cleanup 会删除 flag 不为 true 的 recovery runtime entry，并收缩空容器。
- 为未启用、启用、reserve 底线、稳定自动退出和跨房不泄漏补充定向回归测试。

## Capabilities

### New Capabilities

- `carrier-terminal-bootstrap-recovery`: 定义房间级 Terminal Energy bootstrap 准入、安全保底、稳定恢复判定和自动退出合同。

### Modified Capabilities

- 无。

## Impact

- 运行时代码：`src/roles/carrier.ts`、`src/runtime/energyPickupReservation.ts` 及一个共享 bootstrap policy 模块。
- Memory：`Memory.cfg.energyPickup` 增加可选的 room-scoped recovery flag；`Memory.runtime` 增加可选的连续恢复观测，并由运行时自动清理。
- 测试与规格：carrier、pickup reservation/policy、周期 Memory cleanup 的定向 Jest 与 OpenSpec strict validation。
- 不改变主循环顺序、Terminal 跨房发送、market exposure、ResourceControl reserve、版本号或部署流程；部署后由 operator 显式激活 E7N58。
