## Context

现有 carrier 只在本房 Spawn/Extension 有缺口时把 Terminal 纳入 Energy 来源，并通过 `TERMINAL_ENERGY_PICKUP_RESERVE=50_000`、pickup reservation、market exposure 和 terminal action claim 保护库存。E7N58 的 Terminal Energy 为 42,209，Storage Energy 为 0，房间只有一个空载 manual carrier 且没有 miner；固定 50,000 保底令 Terminal 的通用可取量为零，两座 Spawn 因 300/5,600 Energy 无法出生队首 creep。

`terminal-headroom-recovery` 处理的是跨房 receiver 容量与 Terminal staging，其设计明确不新增 carrier claim，也尚有独立线上观察任务；本次 bootstrap 是显式、短生命周期的房内供能能力，因此使用独立 change。

## Goals / Non-Goals

**Goals:**

- 允许 operator 只为指定房间开启 Terminal bootstrap，帮助现存 carrier 恢复本房 Spawn/Extension。
- 始终保留该房 ResourceControl `terminalEnergyReserve`，并继续服从 market exposure、pickup reservation 与 terminal action claim。
- 以连续、可测试且不依赖单 tick 偶然水位的证据自动撤销 flag。
- 保证一个房间的 flag 不会降低其他房间 Terminal 的 pickup reserve。

**Non-Goals:**

- 不自动扫描并开启所有低能房间，不硬编码 E7N58 永久名单。
- 不允许 worker、remote carrier 或普通 carrier 空闲回收路径任意抽取 Terminal。
- 不改变跨房 transfer、Terminal offload/feed、市场、room energy policy 或 carrier task 优先级。
- 不在本变更中执行 console 写入、部署或版本更新。

## Decisions

1. **使用显式 boolean room flag 与独立 runtime 观测。** Operator 通过 `Memory.cfg.energyPickup.terminalBootstrapRecoveryRooms[roomName] = true` 激活。运行时在 `Memory.runtime.energyPickup.terminalBootstrapRecovery[roomName]` 记录 `healthySince`、`lastObservedAt` 与 `lastRecoveryPickupAt`。相比硬编码房间或根据低能量自动启动，显式 flag 限制了授权范围；runtime 状态与 operator intent 分离，便于自动清理和回滚。
2. **只在本房 Spawn/Extension demand 路径降低 reserve。** carrier 的物理所在房间、assigned room 与 flag room 必须相同，且当前 delivery target 必须是本房 Spawn/Extension。普通 idle pickup、Tower/Lab、remote room 与其他资源路径继续使用原来的固定 50,000 reserve 或完全不包含 Terminal。
3. **恢复 reserve 取 ResourceControl 房间策略。** 激活时 Terminal 可用量为 `max(0, terminalEnergy - resolveRoomEnergyPolicy(roomCfg).terminalEnergyReserve)`，再与 market exposure 外余量取最小值；withdraw 前仍需取得 pickup reservation 和 market exposure claim，若同 tick 已有 Terminal action claim 则拒绝。最终 withdraw amount 取 creep free capacity、当前安全可用量、该 creep 实际 pickup reservation claim amount 与 market exposure claim amount 的最小值。这样 E7N58 可使用 42,209 中高于 20,000 的部分，但不能抽穿配置保底、重复消费其他 carrier 已领取的余量或消费市场已暴露库存。
4. **使用连续 25 tick 的稳定证据自动退出。** 健康条件同时要求：非 spawning canonical `<room>:carrier:0` managed carrier 存活、至少一个本地 managed `miner` 存活、`room.energyAvailable` 持续达到 `max(300, 50% * room.energyCapacityAvailable)`。每个 tick 至多记录一次观测；观测中断、任一条件失效或成功从 bootstrap Terminal 取能都会重置 `healthySince`。连续 25 tick 后删除 room flag 与 runtime 状态。相比单次满能量或只看 creep 存在性，这能证明生产和房内供能在一段窗口内不再依赖 Terminal bootstrap。
5. **扩展 pickup reservation 的可用量参数和只读 claim getter，而不改变旧调用。** `getPickupTargetEnergyAmount`、`reservePickupTarget` 与 `getReservedPickupTarget` 接受可选 Terminal reserve；未传参数时仍固定 50,000，`reservePickupTarget` 继续返回 boolean。新增 `getPickupReservationClaimAmount(creep, targetId?)` 在清理过期 claim 后返回本 creep 当前实际 claim，不创建或扩大 claim。只有 carrier Terminal 最终执行层读取该值，bootstrap 分支才传入 ResourceControl reserve，避免全局改变 worker、remote 或其他房间语义。
6. **将 orphan runtime 清理接入既有周期 Memory cleanup。** 每次现有 cleanup cadence 到期时，遍历 `Memory.runtime.energyPickup.terminalBootstrapRecovery`；仅保留对应 room flag 严格为 true 的 entry，删除 false、缺失或其他非 true intent 对应的 entry，并在清空后删除 `terminalBootstrapRecovery` 与空的 `energyPickup` 容器。该清理不替代 carrier loop 的即时自动退出，只为不再运行 carrier 或 operator 已撤销 flag 的房间提供最终一致性回收。

## Risks / Trade-offs

- [恢复条件过严导致 flag 停留较久] → flag 只能服务本房 Spawn/Extension，且始终保留 ResourceControl reserve；停留不会开放空闲搬运或跨房泄漏，安全优先于过早退出。
- [Terminal Energy 在恢复前降至 reserve] → 可用量归零，carrier 自动停止取能；本地 miner/物流继续积累 Energy，不会抽穿底线。
- [一次 Terminal pickup 期间恰好满足能量门槛] → 成功 pickup 会在同 tick 重置稳定窗口，不能把 bootstrap 自身制造的短时高水位当成恢复证据。
- [多个 carrier 同 tick 观测或竞争] → `lastObservedAt` 保证每 tick 单次推进；每个 Terminal withdraw intent 严格 cap 到该 carrier 的实际 pickup reservation claim。即使没有 market exposure、因此 exposure helper 不建立 in-flight ledger，同一可用余量也不会被重复领取。
- [operator 撤销 flag 后没有 carrier 再进入该房 loop] → 周期 Memory cleanup 按严格 `flag === true` 保留规则删除 orphan runtime，并收缩空容器。
- [房间不可见、失权或 carrier loop 中断] → 不推进连续窗口，也不授权取能；operator 可手工删除 flag，恢复代码不会猜测成功。

## Migration Plan

1. 部署代码但不自动写入任何 room flag，确认所有房间保持原 50,000 reserve 行为。
2. 根代理经用户授权后只为 E7N58 写入 `terminalBootstrapRecoveryRooms.E7N58=true`。
3. 只读观察 E7N58 Terminal 不低于 20,000、Spawn/Extension 恢复、canonical carrier 与 miner 出生，以及 flag 在连续健康窗口后自动删除。
4. 回滚时删除 E7N58 flag 并部署上一版本；可选 runtime 观测不会被旧代码读取。

## Open Questions

- 无。
