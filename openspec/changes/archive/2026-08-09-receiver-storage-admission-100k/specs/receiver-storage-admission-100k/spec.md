## ADDED Requirements

### Requirement: Receiver minimum 必须独立于 capacity recovery target

Storage 水位必须（MUST）满足 `storagePressureFreeCapacity <= receiverStorageMinFreeCapacity` 与 `storagePressureFreeCapacity <= storageReliefTargetFreeCapacity`；`receiverStorageMinFreeCapacity` 与 `storageReliefTargetFreeCapacity` 之间不得（MUST NOT）存在隐式大小约束。默认值必须分别为 100,000、100,000 与 200,000。

#### Scenario: 默认100k receiver不会被抬回200k

- **WHEN** 用户未配置 capacity watermarks
- **THEN** effective Storage pressure、receiver minimum、relief target 必须为100k、100k、200k

#### Scenario: 自定义 receiver 低于 relief target

- **WHEN** pressure=100k、receiver minimum=120k、relief target=250k
- **THEN** effective receiver minimum 必须保持120k，不得被 normalizer 抬到250k

#### Scenario: receiver 低于 pressure

- **WHEN** receiver minimum 配置为80k而pressure为100k
- **THEN** effective receiver minimum 必须安全 clamp 到100k

### Requirement: Exact pressure threshold 必须是 normal 饱和边界

对 previous capacity state 为 normal 或缺失的房间，系统必须（MUST）只在 Storage 或 Terminal free 严格低于对应 pressure threshold 时进入 pressure；free 恰好等于 threshold 时保持 normal，但 safe receivable capacity 必须为零。任一结构 free<=0 仍为 emergency。

#### Scenario: Fresh Storage exact100k

- **WHEN** previous state 为 normal、Storage free=100k、Terminal 高于其 pressure threshold
- **THEN** 房间保持 normal，但不得获得正 receiver reservation

#### Scenario: Fresh Storage低于100k

- **WHEN** previous state 为 normal、Storage free=99,999
- **THEN** 房间进入 pressure

#### Scenario: Fresh Terminal exact40k

- **WHEN** previous state 为 normal、Terminal free=40k、Storage 高于其 pressure threshold
- **THEN** 房间保持 normal，但 Terminal safe receivable capacity 为零

### Requirement: 已受压房间继续使用恢复滞回

Previous state 为 pressure/emergency 时，系统必须（MUST）继续保持 pressure，直到 Storage 与 Terminal 同时达到各自 relief target。Exact pressure threshold 不得清除既有 pressure。

#### Scenario: 已受压房间在Storage150k

- **WHEN** previous state 为 pressure、Storage free=150k、Storage relief target=200k
- **THEN** 即使该数值高于 receiver minimum，房间仍为 pressure且不得接收

#### Scenario: 两个结构达到恢复水位

- **WHEN** previous state 为 pressure、Storage free>=200k且Terminal free>=80k
- **THEN** 房间恢复 normal，并可按 receiver minimum重新参与准入

### Requirement: Receiver safe capacity 必须精确保留100k

Normal receiver 的 Storage 可接收量必须（MUST）为 `max(0, storageFree-100,000)`，并继续与 Terminal safe capacity、物理结构 free 和所有共享 commitments 取最小值。Planner、ledger 与 executor 不得（MUST NOT）各自追加一单位 sentinel。

#### Scenario: Free150k接收50k

- **WHEN** normal receiver Storage free=150k、Terminal safe capacity至少50k且没有其他commitment
- **THEN** receiver 可以取得50k reservation并在发送后恰好保留100k

#### Scenario: Free100k不创建零任务

- **WHEN** normal receiver Storage free=100k
- **THEN** safe capacity必须为0，planner不得创建amount=0的task或lease

#### Scenario: 多任务共享50k

- **WHEN** free=150k的receiver已有30k健康incoming commitment
- **THEN** 后续所有任务的新增reservation合计不得超过20k
