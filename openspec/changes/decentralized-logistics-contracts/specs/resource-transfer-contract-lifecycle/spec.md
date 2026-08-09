## ADDED Requirements

### Requirement: Producer 必须发布幂等的最新状态型 intent

每个物流 producer 必须（MUST）以稳定 `(producer, demandKey)` 发布最新 offer/demand，并携带唯一 id、kind、room、resource、绝对 desired/available amount、显式 priority class、revision、observedAt、expiresAt 和可选 deadline/固定端点约束。同一个 key 同时最多只能有一个 active revision；系统不得（MUST NOT）把 heartbeat 或相同 revision 重放解释为新需求或实际进度。

#### Scenario: 相同 revision 重放无副作用

- **WHEN** producer 在两个周期发布完全相同的 demandKey、revision 和 desired amount
- **THEN** 系统必须保留同一 active intent，且不得新增合同、增加 remaining 或刷新 `lastProgressAt`

#### Scenario: 需求修订保留已交付进度

- **WHEN** 一个 demand 已交付 400、仍有 active commitment 300，producer 把同一 demandKey 的绝对目标从 1,000 修订为 1,200
- **THEN** matcher 只能为未覆盖的 500 创建新 commitment，且不得把已交付 400 写回任何合同的 remaining

#### Scenario: 需求缩小时撤销未执行增量

- **WHEN** producer 降低 desired amount，现有 delivered 加 active commitments 已超过新目标
- **THEN** 系统必须优先 supersede 尚未 staging 的最新合同余量，且不得回滚 delivered 或产生负数 commitment

#### Scenario: 过期 intent 不再匹配

- **WHEN** 当前 tick 已超过 intent.expiresAt 且 producer 未续订 revision
- **THEN** matcher 不得基于该 intent 创建新合同，但必须保留已有合同的可审计状态并按其生命周期处理

### Requirement: 房间物流事实必须新鲜且来自安全物理状态

每个 RoomLogisticsAgent 必须（MUST）发布本房最新库存可用量、P0 storage/terminal headroom、terminal ready tick 和交易费 energy budget，并携带 observedAt/expiresAt。automatic offer 必须扣除库存保护与 active source commitments；尚未完成的 offload 不得（MUST NOT）被发布为即时 headroom。matcher 不得使用过期房间事实。

#### Scenario: Source offer 扣除既有 commitment

- **WHEN** source 的保护后安全库存为 10,000，已有 automatic source commitments 7,000
- **THEN** RoomLogisticsAgent 发布的新增 available amount 不得超过 3,000

#### Scenario: 计划排空不提前增加 headroom

- **WHEN** receiver 只创建了 20,000 terminal offload 工作但 carrier 尚未完成
- **THEN** 发布的即时 headroom 必须仍以当前物理空闲和 P0 projection 为准，不得增加 20,000

#### Scenario: 过期房间事实被过滤

- **WHEN** offer 仍 active，但 source 房间事实已超过 expiresAt
- **THEN** matcher 不得基于该 source 创建新合同，直到 RoomLogisticsAgent 刷新事实

### Requirement: Matcher 必须进行安全且确定性的直接匹配

matcher 必须（MUST）只在 active intents 与当轮共享索引中匹配供需，并先过滤过期端点、same-room、automatic offer 业务保护库存不足、receiver 无安全 headroom、动作 ownership 交易费预算不足和 terminal 不可达候选。新 automatic intent 可以使用业务水位决定是否生成；已有合同的 staging/send 不得再次使用 room energy watermarks 否决。普通物流必须优先 source→target 直接路线；只有 intent 明确固定 Hub 时才能把 Hub 作为中转目标。相同输入必须（MUST）产生相同合同与排序结果。

#### Scenario: 同等安全候选选择低成本直达路线

- **WHEN** 两个 donor 都满足相同需求、优先级和 ready tick，其中一个直达目标的交易能耗更低
- **THEN** matcher 必须选择交易能耗更低的 donor，且不得默认先发往 Hub 再中转

#### Scenario: Hub 不可用不阻塞普通物流

- **WHEN** 配置的 Hub 房间不可见或无 terminal，但其他 source 和 target 的 intents、库存与 headroom 均有效
- **THEN** matcher 必须仍可为非 Hub 固定需求创建直接 TransferContract

#### Scenario: 保护库存优先于路线得分

- **WHEN** 最低交易成本 donor 的 automatic 安全可用库存为零，而另一个 donor 有安全 surplus
- **THEN** matcher 必须过滤第一个 donor并选择安全候选，不得用更优得分绕过库存保护

#### Scenario: 稳定键消除遍历顺序偏置

- **WHEN** 两个候选在所有业务与成本维度完全相等，但 Game room 枚举顺序发生变化
- **THEN** matcher 必须使用稳定 key 得出相同 source/target 选择

### Requirement: 业务优先级必须显式且具备条件式公平

每个 intent 与 contract 必须（MUST）携带显式 `priorityClass`，首版按 `deadline`、`capacity_emergency`、`survival_energy`、`operator`、`production`、`capacity_pressure`、`balance`、`market` 排序。executor 不得（MUST NOT）解析 reason 字符串决定顺序。aging 可以在非硬紧急 class 内提升等待任务，但不得越过 `survival_energy`；当更高优先级工作有限且合同持续可执行时，合同必须最终进入发送窗口。

#### Scenario: emergency 优先于普通均衡

- **WHEN** 同一 source 同时有可执行的 `capacity_emergency` 与更早创建的 `balance` 合同，且没有 aging 例外
- **THEN** matcher/Agent 必须先选择 `capacity_emergency`

#### Scenario: deadline 使用最早截止时间

- **WHEN** 两个 `deadline` 合同竞争同一 source terminal 且均安全可执行
- **THEN** 系统必须先选择 deadlineAt 更早的合同，再以等待年龄和稳定 key 打破平局

#### Scenario: 有限高优先级流量下不永久饥饿

- **WHEN** 一个 `balance` 合同持续满足库存、lease、fee 和 terminal 条件，且更高优先级工作只间歇出现
- **THEN** aging 与 per-source 调度必须使该合同在配置的有界等待策略内获得发送窗口

#### Scenario: 全局预算使用轮换 source

- **WHEN** 多个 source terminal 同时 ready，而安全工作预算不足以在一轮处理全部 source
- **THEN** 系统必须持久化 round-robin continuation，后续轮次不得总从同一 room 开始

### Requirement: TransferContract 必须保持身份、状态与数量守恒

TransferContract 必须（MUST）持久化身份、不可变路线、显式 priority、committed/remaining/delivered/staged、source commitment、状态、blocker、attempt、nextAttemptAt 和 lastProgressAt。active 状态只允许 `planned/staging/ready/blocked`，终态只允许 `done/cancelled/failed/superseded`；终态不得（MUST NOT）复活。合同必须始终满足 `committedAmount = deliveredAmount + remainingAmount`，active 合同必须满足 `0 <= stagedAmount <= remainingAmount`。

#### Scenario: 部分发送保持数量守恒

- **WHEN** committed=10,000、delivered=0、remaining=10,000 的合同成功发送 3,000
- **THEN** 系统必须原子更新为 delivered=3,000、remaining=7,000，committed 仍为 10,000

#### Scenario: 失败发送不伪造进度

- **WHEN** `terminal.send` 返回非 OK，或只发生 intent refresh、lease renewal、heartbeat
- **THEN** delivered 与 remaining 必须保持不变，系统只能更新 attempt/blocker/nextAttemptAt，且不得把 heartbeat 当作 `lastProgressAt`

#### Scenario: 合同路线不可原地修改

- **WHEN** automatic 合同需要从 receiver A 改道到 receiver B
- **THEN** 系统必须创建指向 B 的 successor，并将旧合同置为 superseded；不得修改旧合同的 targetRoom

#### Scenario: automatic source commitment 不得超卖

- **WHEN** 同一 source/resource 有多个 automatic 合同，新增合同会使 active source commitments 超过保护后安全可用库存
- **THEN** matcher 必须缩小或拒绝新增 commitment，且发送前还必须排除合同自身后再次重验

### Requirement: Blocker、重试与改道必须可恢复且可诊断

系统必须（MUST）使用机器可读 blocker 区分 receiver pressure/lease unavailable、source protection/depleted、staging、terminal cooldown、fee shortage、budget throttling 和非法 endpoint，并记录 blockedSince、attemptCount 与 nextAttemptAt。可恢复条件消失后合同必须自动重新申请 lease/进入窗口；automatic 合同长期无物理 staging/send 进展时必须终止或由 successor 取代，并记录原因。

#### Scenario: receiver 恢复后无需重建需求

- **WHEN** 合同因 receiver headroom 不足进入 blocked，随后 receiver 恢复且原 intent 仍 active
- **THEN** 系统必须清除对应 blocker、重新申请 CapacityLease 并继续原合同，无需 producer 创建新 demandKey

#### Scenario: cooldown 使用精确重试时间

- **WHEN** source terminal cooldown 为 7 ticks
- **THEN** 合同必须记录不早于 ready tick 的 nextAttemptAt，且在此之前不得按固定 10-tick 循环重复调用 send

#### Scenario: retarget 不产生双 receiver commitment

- **WHEN** automatic 合同满足改道条件并找到新 receiver
- **THEN** successor 必须先获得新 lease，再原子 supersede 旧合同并释放旧 lease，任一时刻不得让同一 remaining 同时成为两个可发送合同

#### Scenario: manual 合同保持人工语义

- **WHEN** manual 合同长期被容量或 cooldown 阻塞
- **THEN** 系统不得因 automatic TTL 自动取消或自动改道该合同，但可以让其 lease 过期并在条件恢复后重新申请

### Requirement: Legacy 迁移必须保证单一执行权和可回滚

系统必须（MUST）以 versioned、幂等迁移把 legacy resource-transfer task 映射为合同，并为每个需求保存唯一 `executionAuthority`。迁移、legacy skip 标记和合同创建必须原子完成；同一需求不得（MUST NOT）同时由 legacy executor 与 RoomLogisticsAgent 执行或重复扣减容量。survival energy、Hub/Synthesis/PowerBank/capacity producer 和 console transfer 最终都必须经过合同账本。

#### Scenario: 部分完成任务只迁移剩余量

- **WHEN** legacy task amount=10,000、remaining=2,500
- **THEN** 迁移合同必须记录 committed=10,000、delivered=7,500、remaining=2,500，并使 legacy executor 跳过该任务

#### Scenario: 重复运行迁移无副作用

- **WHEN** global reset 后迁移器再次看到同一个 legacyTaskId
- **THEN** 系统必须复用已有合同或迁移标记，不得创建第二个 active 合同

#### Scenario: survival energy 不再绕过合同

- **WHEN** 房间产生生存 energy deficit 且合同模式已对该 origin 启用
- **THEN** producer 必须发布 `survival_energy` intent，由合同/lease/Agent 执行，旧 direct-send 分支不得再调用 terminal

#### Scenario: 回滚不重放已交付量

- **WHEN** 合同模式回滚，active 合同 committed=10,000、delivered=6,000、remaining=4,000
- **THEN** 系统必须只物化 remaining=4,000 的 legacy task，终止合同 authority 并释放 lease/claim

### Requirement: 合同控制面必须提供有界观测

系统必须（MUST）投影 intent/contract 的 origin、priority、state、blocker、remaining、oldest age、状态耗时、source commitment、route cost、aging/budget skip、幂等与数量守恒违规，以及 matcher candidate evaluation/continuation 指标。终态详情必须有界保留，monitor 必须兼容没有这些字段的旧快照。

#### Scenario: 能定位长期无进展合同

- **WHEN** 一个合同在多个周期没有 staging 或 send 进展
- **THEN** runtime 必须报告其 blocker、blocked age、lastProgress age、nextAttemptAt、priority 与 source/target，而不是只报告 pending 总数

#### Scenario: 终态历史不会无限增长

- **WHEN** 已完成合同数量超过配置的详细审计保留上限
- **THEN** 系统必须保留聚合统计并裁剪最旧详情，active 合同不得被裁剪
