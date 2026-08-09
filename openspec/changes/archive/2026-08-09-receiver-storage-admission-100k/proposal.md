## Why

多房间 Storage 负载均衡的接收准入与容量恢复滞回目前被错误绑定：默认 receiver Storage 最小空闲为 300,000，线上覆盖为 200,000，normalizer 还强制 `receiverMin >= storageReliefTarget`。这使许多拥有 100k–200k 安全空闲的 normal 房间无法接收，E3N59/E7N58 只能看到极少数候选 receiver。

用户明确将两类水位拆开：receiver 只需保留 100,000 Storage 空闲；曾经进入 pressure 的房间仍需恢复到 200,000 才重新成为 normal。当前 capacity-relief 的三个 `-1` 哨兵还会把 free=150,000 的实际可接收量缩成 49,999，需要与边界语义一起收敛。

## What Changes

- 将 `receiverStorageMinFreeCapacity` 默认值改为 100,000。
- Storage 水位仅要求 `storagePressureFreeCapacity <= receiverStorageMinFreeCapacity` 与 `storagePressureFreeCapacity <= storageReliefTargetFreeCapacity`；receiver minimum 和 relief target 彼此独立。
- 新进入 pressure 的判断改为“严格低于 pressure threshold”；恰好等于阈值的 fresh/normal 房间保持 normal 但安全可接收量为零。
- 已处于 pressure/emergency 的房间继续使用原恢复滞回：Storage/Terminal 都达到 200,000/80,000 才恢复 normal。
- 移除 capacity-relief 接收计算中的一单位 sentinel，让 free=150,000 的 normal receiver 可以取得完整 50,000 Storage capacity reservation；free=100,000 时不得创建零数量 task/lease。
- Terminal 默认关系继续为 pressure 40,000、receiver minimum 50,000、relief target 80,000；同样使用严格低于 pressure 的首次进入边界，避免完整使用 safe capacity 后下一 tick 抖动。

## Capabilities

### New Capabilities

- `receiver-storage-admission-100k`: 定义 receiver minimum、capacity recovery hysteresis 与 exact-threshold 半开区间。

### Modified Capabilities

- `distributed-storage-capacity-relief`: 将默认 receiver Storage 准入从 300,000 改为 100,000，并明确与 200,000 恢复水位独立。

## Impact

- 运行时：`src/runtime/logistics/capacityHeadroom.ts` 和 ResourceControl capacity-relief 的 receivable/ledger/executor 上限。
- 测试：capacity policy、receiver ledger、ResourceControl 自动 relief、多周期 capacity regression 与 runtime observability。
- 线上配置：代码默认值不会覆盖现有 Memory 显式值；部署后需要把 `Memory.cfg.resourceControl.capacityBalancing.receiverStorageMinFreeCapacity` 从 200,000 明确改为 100,000，并记录旧值作为操作回滚点。
- 不变项：`storageReliefTargetFreeCapacity=200,000`、Terminal 40k/50k/80k 水位、receiver normal-state 要求、共享 reservation、max task amount、每轮 task 数、市场禁售与 phase 顺序均不改变。
- 回滚：代码可部署父提交；线上显式 receiver 100k 可独立恢复为 200k，不涉及 schema 迁移。
