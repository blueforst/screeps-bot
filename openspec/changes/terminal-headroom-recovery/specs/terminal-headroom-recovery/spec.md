## ADDED Requirements

### Requirement: 共享且单调的容量水位策略

系统必须（MUST）从 `Memory.cfg.resourceControl.capacityBalancing` 生成一份由 ResourceControl、Hub distribution 和运行时投影共同使用的容量水位策略。terminal 水位必须满足 `pressureFree <= receiverMinFree <= reliefTargetFree`，storage 水位必须满足 `pressureFree <= reliefTargetFree <= receiverMinFree`，且所有水位必须限制在对应建筑的容量范围内。

#### Scenario: 默认水位被所有 producer 共用

- **WHEN** 用户未提供容量水位覆盖值，ResourceControl 与 Hub 在同一 tick 判断一个候选 receiver
- **THEN** 两者必须使用同一组规范化默认值，并对该房间得出一致的 admission 结果

#### Scenario: 非单调配置被安全规范化

- **WHEN** 用户提供的 terminal receiver 最小空闲高于恢复水位，或 storage 恢复水位高于 receiver 最小空闲
- **THEN** 系统必须按安全方向规范化为单调水位，并在 runtime 中报告实际生效值

### Requirement: 受压 terminal 必须能够到达恢复水位

当房间处于 `pressure` 或 `emergency`、terminal 空闲低于 `terminalReliefTargetFreeCapacity` 且 storage 有安全空闲时，系统必须（MUST）持续生成有界 offload 工作，直到 terminal 达到恢复水位或没有安全可搬资源。系统不得（MUST NOT）仅因 terminal 已回到固定 250,000 使用量就停止恢复。

#### Scenario: 50k 粘滞区继续排空

- **WHEN** 房间上轮处于 pressure，terminal 空闲为 50,000，恢复水位为 80,000，且 storage 可安全接收至少 30,000 非受保护资源
- **THEN** 系统必须继续生成 terminal offload，目标恢复缺口为 30,000，而不是把房间停留在 pressure

#### Scenario: 只搬运安全库存

- **WHEN** terminal 中同时存在普通非 energy、已获 admission 的发送 staging 和受保护 energy
- **THEN** offload 必须优先选择普通非 energy，且不得搬走已获 admission 的 staging、terminal energy reserve 或交易费预算

#### Scenario: storage 无空间时不虚假恢复

- **WHEN** terminal 低于恢复水位但 storage 没有安全空闲，且没有其他可搬资源
- **THEN** 系统不得增加即时 receiver 容量，房间必须保持 pressure/emergency，并报告 `storage_full` 或等价恢复阻塞原因

### Requirement: 容量状态必须形成无振荡滞回闭环

系统必须（MUST）仅在 storage 与 terminal 同时达到各自恢复水位后把既有 pressure/emergency 房间切换为 `normal`；normal 房间只有触及压力水位时才进入 pressure。未完成的 offload 计划不得（MUST NOT）被视作已经恢复的物理空闲。

#### Scenario: 计划 offload 不提前改变状态

- **WHEN** 系统已生成 terminal offload，但 carrier 尚未完成搬运，terminal 物理空闲仍低于恢复水位
- **THEN** 房间必须继续保持原容量状态，且不得被当作可用 receiver

#### Scenario: 达到双水位后恢复

- **WHEN** 上轮处于 pressure 的房间在当前快照中同时达到 storage 与 terminal 恢复水位
- **THEN** 系统必须将其切换为 normal，并允许其按 receiver admission 规则参与接收

#### Scenario: 恢复后不在边界反复切换

- **WHEN** 已恢复为 normal 的房间空闲量位于压力水位与恢复水位之间
- **THEN** 系统必须保持 normal，直到任一物理空闲触及对应压力水位

### Requirement: receiver 容量必须由共享投影账本安全扣减

系统必须（MUST）以 receiver 的 terminal 总空闲、terminal 资源空闲和 storage 总空闲的安全下界计算可接收量，并扣除健康入站承诺与本 tick 已登记 reservation。相同任务在重验自身时必须排除自身承诺；尚未完成的本地 offload 不得（MUST NOT）增加即时可接收量。

#### Scenario: 多 producer 不能重复消费 headroom

- **WHEN** Hub 与 capacity planner 在同一 tick 为同一 receiver 计划入站，且安全可接收量只够一个批次
- **THEN** 第一个成功 admission 的计划必须登记 reservation，后续计划只能使用剩余容量且总承诺不得超过安全可接收量

#### Scenario: 失效承诺不永久占用容量

- **WHEN** 一个待入站任务长期处于 `receiver_capacity`、`source_depleted` 或已超过进度新鲜度窗口
- **THEN** 该任务不得继续作为健康入站承诺扣减 receiver 容量，但其持久任务记录仍由现有生命周期规则保留或清理

#### Scenario: 发送前重新验证物理容量

- **WHEN** admission 后 receiver 的物理空闲因其他动作下降
- **THEN** executor 必须在 `terminal.send` 前重新计算安全可接收量，并在不足时阻塞任务而不是超配发送

### Requirement: 恢复状态必须可观测

系统必须（MUST）在 `Memory.runtime.resourceControl` 中提供兼容性的容量恢复观测，包括可用 receiver 数、每房目标 terminal 空闲、恢复缺口、可排空量、粘滞原因、容量承诺摘要和按原因统计的 staging 抑制数量。monitor 必须（MUST）兼容没有这些字段的旧快照。

#### Scenario: 无 receiver 时给出可诊断原因

- **WHEN** 当前没有任何房间通过 receiver admission
- **THEN** runtime 必须报告 `eligibleReceiverCount=0`，并能区分物理容量不足、仍在恢复、健康承诺耗尽和 staging/backlog 导致的 headroom 不足

#### Scenario: 旧 runtime 仍可投影

- **WHEN** monitor 读取一个不含新增容量恢复字段的旧 runtime 快照
- **THEN** monitor 必须继续输出既有字段，不得抛错或把缺失值伪造为已恢复
