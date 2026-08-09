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

### Requirement: 本地 offload 必须安全承诺目标 Storage 容量

系统必须（MUST）在生成 terminal offload 时从 Storage 物理安全空闲中扣除已经接受取货、正在由 carrier 携带且仍绑定该目标的 cargo。carrier 必须（MUST）在发出 withdraw intent 前重新验证目标真实空闲，并原子领取目标共享容量和 task step 剩余额度；多个 carrier 不得（MUST NOT）重复消费同一份容量。

#### Scenario: 规划扣除已接货与在途 cargo

- **WHEN** Storage 物理安全空闲为 1,000，已有 600 cargo 由 live carrier 绑定该 Storage
- **THEN** 新生成的 terminal offload 总量不得超过 400

#### Scenario: 多资源共享同一 Storage 余量

- **WHEN** 两个 terminal offload step 分别搬运不同资源，但目标 Storage 只有 1,000 总空闲
- **THEN** 两个 step 与其同 tick carrier claims 的合计不得超过 1,000，而不得按资源各领取 1,000

#### Scenario: 普通直接投递与 offload 共享目标余量

- **WHEN** `carrierStorageOnlyMode` Energy 回存或无 board task 的非 Energy cleanup 与 terminal offload 在同 tick 投递/领取同一 Storage，且两者资源可以不同
- **THEN** 普通投递必须在 transfer 前按同一目标容量账本缩量，所有 accepted transfer 与 offload pickup 的合计不得超过目标总空闲

#### Scenario: 已 seed 的普通投递不重复扣减自身

- **WHEN** carrier 的 `carrierPlanMode=deliver` cargo 已在 tick 初始化时作为同一 Storage 的在途承诺，随后该 carrier 发出直接 transfer intent
- **THEN** 系统必须复用该 carrier 自己的已承诺额度并扣除其他 claimant，不得二次扣减自身或错误阻塞该 transfer

#### Scenario: 多个已 seed 投递原子分配物理执行额度

- **WHEN** 多个 carrier 的普通投递均已 seed 到同一 Storage，且其总在途承诺超过当前物理空闲
- **THEN** 系统必须按同 tick 先到顺序缩量分配 transfer 执行额度，所有 accepted transfer 合计不得超过物理空闲；失败执行必须释放额度供后续 carrier 使用

#### Scenario: 所有 Storage 交付入口共用执行额度

- **WHEN** carrier 通过 committed snapshot、pending step、task refresh fallback、assigned terminal offload、late snapshot 或普通 planned delivery 任一路径向 Storage 发出 transfer
- **THEN** 系统必须按结构类型统一经过目标容量 claim，不得存在绕过已 seed 执行额度的直接 Storage transfer

#### Scenario: 缩量 snapshot 交付保留 provenance

- **WHEN** accepted terminal offload snapshot 携带 600，但同 tick 只领取并接受 400 的 Storage transfer 执行额度
- **THEN** 系统必须保留该 snapshot 的目标、资源、任务类型 provenance 与 assignment，供剩余 200 在后续 tick 继续交付；不得回落到普通物流目标

#### Scenario: pickup 前余量下降时原子缩量

- **WHEN** task 生成后 Storage 余量下降，carrier 到达 Terminal 时只剩 300 可承诺容量，而 step 与 creep 均允许取 800
- **THEN** carrier 最多 withdraw 300；若可承诺容量为零则不得发出 withdraw intent

#### Scenario: 多 carrier 不重复领取 step

- **WHEN** 两个 carrier 在同 tick 选择同一个 amount=800 的 terminal offload step
- **THEN** 两者获得的目标容量 claim 与 withdraw intent 合计不得超过 800

#### Scenario: intent 失败与 live 生命周期释放 claim

- **WHEN** withdraw 返回 `ERR_NOT_IN_RANGE`/其他失败，或持有 claim 的 creep 后续死亡、cargo 消失或任务被清理
- **THEN** 未接受的 claim 必须立即释放，已接受/在途承诺必须在下一 tick 按 live creep 与物理 Store 快照重建且不得形成永久占用

#### Scenario: 普通直接投递失败释放 claim

- **WHEN** Storage 直接投递在 claim 后抛出异常、返回 `ERR_NOT_IN_RANGE` 或其他非 `OK` 结果
- **THEN** 未接受的目标容量必须立即释放；仅 `OK` intent 可以把缩量后的 claim 保留到 tick 结束

#### Scenario: 已取 cargo 在目标变满后保持任务语义

- **WHEN** carrier 已接受 terminal offload 取货，但目标 Storage 在交付前变满或 board task 被刷新
- **THEN** carrier 必须保留 pickup snapshot 并继续绑定原目标，系统必须停止新的 offload pickup 并报告 `storage_full`、`carrier_backlog` 或等价 blocker；不得把 cargo 静默送往非任务能量目标

#### Scenario: 源 Terminal 消失不丢失 accepted provenance

- **WHEN** carrier 已接受 terminal offload 取货，随后源 Terminal 消失、board task 被刷新且目标 Storage 已满
- **THEN** carrier 必须仅凭 accepted snapshot provenance 继续绑定原 Storage，不得清除 snapshot 或把 Energy cargo 回落到普通供能

#### Scenario: blocker 使用扣除在途承诺后的有效容量

- **WHEN** Storage 仍有物理安全空闲，但该空闲已被 live carrier 的本地 offload cargo 全部承诺，terminal 仍存在恢复缺口
- **THEN** planner 必须停止生成新的 offload，runtime 必须报告 `storage_full`、`carrier_backlog` 或等价容量 blocker，而不得误报 `protected_inventory` 或 `no_offloadable_resource`

### Requirement: normal terminal 必须保留日常接收窗口

启用 `terminalHeadroomRecoveryEnabled` 时，normal 房间必须（MUST）通过有界 offload 默认保留 60,000 terminal 空闲，且不得（MUST NOT）改变接收账本的 `terminalPressureFreeCapacity` 安全保留。若配置的 `receiverTerminalMinFreeCapacity` 高于 60,000，则日常卸货目标必须至少达到该水位。关闭该功能时，系统必须恢复旧的 250,000 terminal 使用量卸货阈值。

#### Scenario: E4N58 同形水位提供 20k 接收窗口

- **WHEN** normal 房间 terminal 已用 249,051、storage 有安全空闲、接收账本安全保留为 40,000 且恢复功能开启
- **THEN** 系统必须生成 9,051 的有界 terminal offload，使目标空闲达到 60,000，并在安全保留之上形成 20,000 可承诺接收窗口

#### Scenario: 功能关闭时保留旧阈值

- **WHEN** `terminalHeadroomRecoveryEnabled=false` 且 terminal 已用恰好 250,000
- **THEN** 系统不得仅因 normal 60,000 日常水位生成 offload

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
