## Context

容量策略包含三种不同水位：

- pressure threshold：新进入压力的下界，也是 receiver ledger 必须保留的最终安全空闲；
- receiver minimum：一个 normal 房间是否可进入候选集合；
- relief target：已经受压后退出滞回所需的恢复水位。

旧 normalizer 把 Storage 三者强制成 `pressure <= reliefTarget <= receiverMin`，等价于把准入门槛固定在恢复水位以上。用户需要的合同是 pressure=100k、receiver=100k、relief=200k：normal 房间可使用 100k 以上的空闲，而历史受压房仍需恢复到 200k。

旧 capacity-relief 为避免 `resolveCapacityState` 在 exact pressure threshold 使用 `<=` 重新进入 pressure，在 planning、ledger 和 executor 三层各减一。这既重复又使对外配置无法给出直观的可接收量。

## Goals / Non-Goals

**Goals:**

- 让 receiver minimum 与 relief hysteresis 独立配置和观测。
- normal Storage free=150k 时提供精确 50k safe capacity，free=100k 时为零。
- 使用统一边界消除多层 `-1`，保持 planner、ledger、executor 一致。
- 保持 already-pressure 房间的 200k/80k 恢复行为。

**Non-Goals:**

- 不改变 Storage/Terminal 建筑容量、capacity task batch/max、receiver 排序或市场行为。
- 不让 pressure/emergency 房间接收。
- 不修改 room Energy floor/target 或跨房动作 Energy ownership；后者由独立变更处理。
- 不自动覆盖所有用户自定义 receiver 值；只更新代码默认和本次明确授权的线上值。

## Decisions

### 1. Storage 水位只共享 pressure 下界

规范化关系改为：

```text
storagePressure <= receiverStorageMin
storagePressure <= storageReliefTarget
```

`receiverStorageMin` 与 `storageReliefTarget` 无大小关系。默认分别为 100k 与 200k。非法 receiver 值只向上 clamp 到 pressure，不再向上 clamp 到 relief target。

Terminal 原有 `pressure <= receiver <= reliefTarget` 保持，因为默认 40k/50k/80k 未被用户要求拆分。

### 2. 首次进入 pressure 使用严格下界

Emergency 仍在任一结构 free<=0 时成立。对 previous state 为 normal/undefined 的房间，只有 free 严格小于 pressure threshold 才进入 pressure。恰好等于 threshold 时状态保持 normal，但 `getReceiverSafeCapacity` 返回零，因此不能再创建 task/lease。

对 previous state 为 pressure/emergency 的房间，先执行原滞回判断；即使 free 恰好为 pressure threshold，也继续保持 pressure，直到 Storage/Terminal 同时达到 relief target。

这形成明确半开区间，允许 safe capacity 被完整使用到配置阈值而不在下一 tick 产生 normal→pressure 抖动。

### 3. Safe capacity 是唯一数量真相

Receiver ledger 继续以 `storageFree-pressure` 和 `terminalFree-pressure` 的较小值为总 capacity。Planner、reservation 与 executor 不再额外减一；任务数量仍经过 receiver ledger、task remaining、batch 和实际结构 free 的最终最小值。

free=100k 时结果是零，调用方必须跳过创建零 task/lease。free=150k、Terminal 不构成更小上限时结果是 50k。

## Risks / Trade-offs

- [更多 normal 房间进入候选集合] → receiver 仍需 normal、Terminal>=50k、共享 capacity reservation 有余量；上线先改 Energy ownership，再降低门槛。
- [exact threshold 状态语义变化] → 仅 previous normal/undefined 在精确阈值保持 normal；容量为零且不会再接收，already-pressure 滞回不变。
- [移除 sentinel 导致超配] → safe capacity、ledger 与 executor 使用同一整数上限，并用 exact100k/150k、多任务 commitment 测试锁定。
- [线上显式200k遮蔽新默认] → 部署后单独写100k并立即读取规范化 runtime policy验证。

## Migration / Rollback

1. 先实施并验证 terminal action Energy ownership，避免扩大 receiver 集合后 source 仍卡在旧 fee gate。
2. 落地 policy/sentinel 修改，运行 capacity 与 ResourceControl 全链路测试。
3. 部署同一 commit后把线上 receiver Storage minimum 从200k改为100k。
4. 观察 eligible/excluded receiver 数、capacity reservations、新 task routes 与目标房剩余容量。
5. 异常时先把线上值恢复200k，再部署父提交；无 schema 迁移。

## Open Questions

无。
