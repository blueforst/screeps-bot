## ADDED Requirements

### Requirement: CapacityLease 只能由 receiver 房间授予

CapacityLease 必须（MUST）仅由目标房间的 RoomLogisticsAgent grant、renew、consume 或 release。每个 lease 必须绑定唯一 contractId、receiverRoom、resource、amount、epoch、grantedAt、expiresAt 和 state，不得（MUST NOT）转让给另一合同或由 source/matcher 自行声明成功。

#### Scenario: Source 不能自授容量

- **WHEN** matcher 找到候选路线，但 receiver Agent 尚未批准 lease
- **THEN** 合同不得进入 ready/send 状态，source Agent 也不得把 matcher 预测当作有效容量授权

#### Scenario: Lease 不可被另一合同复用

- **WHEN** 合同 A 的 lease 仍 active，合同 B 引用相同 lease id 或 epoch
- **THEN** receiver Agent 必须拒绝合同 B，且记录 lease ownership invariant violation

### Requirement: Lease 总量不得超过 P0 安全可接收容量

receiver Agent 必须（MUST）以 P0 共享 headroom oracle 为容量来源，并同时扣除所有 active leases、未迁移且健康的 legacy commitments 和本 tick accepted sends。lease 必须同时占用 terminal/storage 共享总容量池和对应 resource-specific 容量；计划但未完成的 offload 不得（MUST NOT）增加可租容量。

#### Scenario: 不同资源共享同一总容量池

- **WHEN** receiver 总安全 headroom 为 10,000，已经分别为 H 和 O 授予 6,000 与 4,000
- **THEN** 即使 X 的 resource-specific free 仍很大，receiver 也不得再授予正数 lease

#### Scenario: 迁移期 legacy commitment 参与扣减

- **WHEN** receiver 有 8,000 安全 headroom，并有一个尚未迁移且健康的 legacy incoming commitment 3,000
- **THEN** 新 CapacityLease 的累计 amount 不得超过 5,000，且 legacy 迁移后不得被同时作为 legacy 与 lease 重复扣减

#### Scenario: 计划 offload 不提前出租

- **WHEN** receiver 已创建 terminal→storage offload 任务但 carrier 尚未完成，当前物理安全 headroom 为零
- **THEN** receiver Agent 不得授予正数 lease

#### Scenario: 同 tick 多申请原子扣减

- **WHEN** 两个合同在同 tick 依次申请同一 receiver 的最后一个 5,000 容量窗口
- **THEN** 第一个 grant 必须立即更新 projection，第二个申请只能看到剩余容量并不得导致 overlease

### Requirement: Lease 必须短期、可续约且不囤积 headroom

CapacityLease 必须（MUST）只覆盖合同当前或下一 source terminal send window 的一个安全批次。只有合同仍在该窗口、端点有效且持续满足安全条件时才能续约；renew 必须排除合同自身旧 lease。无续约 lease 必须自然过期，合同终态或 retarget 必须立即释放。

#### Scenario: Cooldown 远期合同不能长期占容量

- **WHEN** source terminal 多个 cooldown 周期内都不会进入当前/下一 send window
- **THEN** receiver 不得持续续约该合同的 lease，已有 lease 必须在 expiresAt 后释放

#### Scenario: 续约不重复扣减自身

- **WHEN** amount=3,000 的 active lease 在 headroom 只剩该 3,000 reservation 时续约
- **THEN** receiver 必须先排除该 lease 的旧 amount 再重验，成功续约后总 reservation 仍为 3,000 而不是 6,000

#### Scenario: Manual lease 过期但合同保留

- **WHEN** manual 合同的 lease 因长期 cooldown 过期
- **THEN** lease 必须释放，但 manual 合同不得被自动取消，并可在重新进入发送窗口后申请新 epoch

### Requirement: Send 前必须重验 lease 与物理 headroom

有效 lease 只代表 reservation，不代表物理容量仍然存在。source Agent 在 `terminal.send` 前必须（MUST）让 receiver Agent/P0 oracle 重验 lease epoch、实际 terminal/storage headroom 和同 tick projection；任一条件不足时不得调用 send。

#### Scenario: Lease 后物理容量被其他动作占用

- **WHEN** lease 已授予，但发送前 receiver 的实际安全 headroom 降到 lease amount 以下
- **THEN** 合同必须进入可恢复 capacity blocker，且 delivered/remaining 不得变化

#### Scenario: 过期 epoch 不能发送

- **WHEN** source 持有旧 lease epoch，而 receiver 已让该 lease 过期并向其他合同授予新容量
- **THEN** source Agent 必须拒绝发送并重新申请 lease

### Requirement: Send 成功后的容量必须在同 tick 只计算一次

当 `terminal.send` 返回 OK 时，receiver Agent 必须（MUST）把对应 lease 转为 consumed，并在共享 projection 中保留本次到达的 debit，直到物理快照已反映该资源。系统不得（MUST NOT）因立即释放 reservation 而按旧快照二次出租，也不得在已应用 post-send delta 后再次重复扣减。

#### Scenario: 成功发送后不能二次出租旧空间

- **WHEN** receiver 最后 5,000 headroom 的 lease 被一次 5,000 send 成功消费，同 tick 又有新申请
- **THEN** 新申请必须看到零可用容量，即使 consumed lease 已不再是 active

#### Scenario: Post-send delta 与 consumed debit 不双扣

- **WHEN** 共享 capacity projection 已把成功到达的 2,000 应用到 receiver 快照
- **THEN** consumed lease 只能作为已核销标记，不得让可用容量额外再减少 2,000

### Requirement: Lease 必须可恢复、可排序且可观测

receiver Agent 必须（MUST）仅依赖 Memory 恢复 active leases，并按 priority、deadline/age 和稳定 contract key 确定性处理竞争申请。runtime 必须报告每房 granted/renewed/consumed/expired/rejected amount、lease oldest age、拒绝原因和 overlease invariant violations。

#### Scenario: Global reset 恢复 reservation

- **WHEN** global reset 发生在 lease grant 后、send 前
- **THEN** receiver Agent 必须从 Memory 恢复同一 lease/epoch，且不得把其 amount 重新出租

#### Scenario: 枚举顺序不影响 grant

- **WHEN** 两个同优先级申请的 Game/Memory 遍历顺序变化
- **THEN** receiver Agent 必须按 age 与稳定 contract key 得出相同 grant 顺序

#### Scenario: 无 lease 时能解释拒绝原因

- **WHEN** receiver 拒绝申请
- **THEN** runtime 必须区分 physical headroom、existing lease、legacy commitment、same-tick debit、pressure state 和 invalid endpoint
