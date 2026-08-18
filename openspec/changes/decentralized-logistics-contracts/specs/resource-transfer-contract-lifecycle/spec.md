## ADDED Requirements

### Requirement: Producer 必须发布幂等的最新状态型 intent

每个物流 producer 必须（MUST）以稳定 `(producer, demandKey)` 发布最新 offer/demand 语义 draft 与 TTL，包括 kind、room、resource、绝对 desired/available amount、显式 priority class 和可选 deadline/固定端点约束。caller 不得（MUST NOT）拥有或选择 id、generation、revision、observedAt、expiresAt；这些生命周期字段必须由 store 物化。同一个 key 同时最多只能有一个 active revision：同一未过期生命周期内的同语义 heartbeat 必须保留 generation/revision 并只单调延长 freshness；语义变化必须由 store 原子写入 revision+1；过期后再次发布或 inactive→active 必须分配新的全局单调 generation 与 intent id，并从新生命周期的 revision 1 开始。heartbeat 不得创建新 commitment、改变 delivered/remaining 或刷新实际进度。

#### Scenario: 同语义 heartbeat 保留 store revision

- **WHEN** producer 在两个周期为同一 demandKey 发布完全相同的语义 draft 与有效 TTL
- **THEN** store 必须保留同一 id、generation 和 revision，只单调延长 observedAt/expiresAt freshness，且不得改变绝对需求、新增合同、增加 remaining 或刷新 `lastProgressAt`

#### Scenario: 语义变化由 store 原子递增 revision

- **WHEN** producer 在同一未过期生命周期为同一 demandKey 改变 desired amount、priority、deadline 或端点约束，即使输入对象夹带伪造 revision
- **THEN** store 必须忽略 caller 对 revision 的选择并将已存 revision 原子加一，不得保留、回退或跳到 caller 指定的 revision

#### Scenario: 过期或重新激活开始新 generation

- **WHEN** intent 已过期后再次发布，或 active=false 的 intent 重新以 active=true 发布
- **THEN** store 必须分配新的全局单调 generation 与 intent id，并从新生命周期的 revision 1 开始，不得复用旧 identity

#### Scenario: 需求修订保留已交付进度

- **WHEN** 一个 demand 已交付 400、仍有 active commitment 300，producer 把同一 demandKey 的绝对目标从 1,000 修订为 1,200
- **THEN** matcher 只能为未覆盖的 500 创建新 commitment，且不得把已交付 400 写回任何合同的 remaining

#### Scenario: 需求缩小时撤销未执行增量

- **WHEN** producer 降低 desired amount，现有 delivered 加 active commitments 已超过新目标
- **THEN** 系统必须优先 supersede 尚未 staging 的最新合同余量，且不得回滚 delivered 或产生负数 commitment

#### Scenario: 过期 intent 不再匹配

- **WHEN** 当前 tick 已超过 intent.expiresAt 且 producer 未发布有效 heartbeat 或新语义 draft
- **THEN** matcher 不得基于该 intent 创建新合同，但必须保留已有合同的可审计状态并按其生命周期处理

### Requirement: 纯 Shadow 必须默认关闭并保持 legacy 唯一执行权

物流模式必须（MUST）为 `disabled | shadow | canary | enabled`，默认及未知 mode/schemaVersion 必须 fail closed 为 `disabled`。纯 `shadow` 中 legacy executor 必须保持每个 demand 的唯一 `executionAuthority`；Shadow 只能写入有界 latest-state intent/comparator/runtime，不得（MUST NOT）创建 active TransferContract、CapacityLease 或 StageWorkClaim，不得修改 legacy task/authority，也不得向 terminal/deal arbiter 新增 actor、claim 或 side effect。legacy 本身的正常 staging/send/deal 不是 Shadow side effect，不得因此被禁止或报告违规。

首片的零新增副作用验收必须（MUST）在相同 fixture 上比较 `disabled` 与 `shadow`：除 `Memory.data.resourceControl.logistics`、`Memory.runtime.resourceControl.logistics` 外，legacy transfer task、CarrierTaskBoard、terminal/account claim 与 journal、receiver reservation、terminal/store 及其他 Memory 投影必须没有可观察差分，terminal.send 与 deal mock 不得出现 Shadow 新增调用。live 投影只可声明 `effectiveAuthority=legacy`、active contract/lease/claim store 为零、无 Logistics Shadow actor/claim/journal 记录与可观察 invariant violation；在没有跨模块 mutator-boundary instrumentation 时，系统不得（MUST NOT）把硬编码零值或净状态相等宣称为已经证明“瞬时发生后又回滚、释放或失败的 attempt 从未发生”。

首个可部署 Shadow 的唯一 in-scope origin 必须是 `synthesis_room`，由 typed `synthesisControl` producer/hook 标记，对应 room reaction legacy reason `synthesis:<room>:<product>`；系统不得（MUST NOT）用 reason 前缀猜测 scope。该 origin 的首片 `priorityClass` 必须为 `production`，并与 legacy rank 2 做语义对照；没有显式 deadlineAt 时不得从 stage/missing/reason 猜测 `deadline`。`synthesis_distributed_demand`（`synthesis:direct:*`、`synthesis:hub-route:*`、`synthesis:resupply:*`）、`synthesis:surplus:*` 和 `auto:synthesis:*` 必须显式投影 `out_of_scope` 与具体 reason，不得进入首片 comparator 的 in-scope coverage 分母或获得 authority。

#### Scenario: Reason 前缀不能扩大首片 scope

- **WHEN** typed Hub producer 产生 `synthesis:direct:X` decision，同轮 typed `synthesisControl` producer 产生 `synthesis:<room>:<product>` decision
- **THEN** 只有后者必须进入 `synthesis_room` in-scope comparator，前者必须记为 `out_of_scope/synthesis_distributed_demand`

#### Scenario: Room synthesis 不伪造 deadline

- **WHEN** `synthesis_room` demand 没有显式 deadlineAt，但 room 处于 acquiring 或 missing 状态
- **THEN** Shadow priority 必须仍为 `production`，并将其与 legacy rank 2 判为语义一致，不得升为 `deadline`

#### Scenario: 默认配置不启动 Shadow

- **WHEN** logistics mode 缺失、schemaVersion 不支持或 mode 不在规范枚举中
- **THEN** 系统必须按 `disabled` 处理，不发布 P1 intent、不运行 comparator、不修改 authority，并投影 fail-closed blocker

#### Scenario: Shadow 不取得执行权

- **WHEN** `synthesis_room` Shadow 候选与 legacy donor/route 一致且所有安全条件成立
- **THEN** 系统仍只能写 comparator 结果，active contract/lease/claim 必须为零，legacy authority 不变；同 fixture 的 `shadow` 相对 `disabled` 不得产生非 logistics 可观察状态差分，send/deal mock 不得出现新增调用

#### Scenario: 净状态不能伪装成瞬时 attempt 证据

- **WHEN** 首片尚未在 arbiter、CarrierTaskBoard、receiver reservation、authority/contract/lease/claim writer 与 direct send/deal gateway 布设统一 attempt instrumentation
- **THEN** runtime/monitor 只能报告可观察 authority/store/actor/claim/journal/invariant 状态，不得把零字段或运行后状态相等解释为已经排除中途发生后被回滚、释放或失败的 attempt

#### Scenario: 后续 Synthesis origin 显式排除

- **WHEN** 同一轮出现 distributed direct/hub-route/resupply、surplus 或 compatibility planner decision
- **THEN** runtime 必须记录其 `out_of_scope` origin/reason 和数量，不得把它们算成首片 in-scope match 或静默遗漏

### Requirement: Synthesis Shadow 必须使用写前冻结输入与精确 legacy 配对

`synthesis_room` producer 必须（MUST）在任何 legacy task create/merge/cancel 之前冻结不可变 intent、room facts、P0 headroom/fee/ready tick 与健康 legacy commitments，并在同轮捕获实际 legacy decision。matcher 必须只读该写前冻结输入。若某调用点只能使用写后任务库，系统只能根据 stable comparison key 与精确 legacy decision/task identity 排除已配对的自身 incoming/outgoing/capacity commitment；不得（MUST NOT）按 reason 前缀、房间+资源或整类 Synthesis 任务宽泛排除。

Shadow comparator 必须比较 donor、route、priority、demand coverage、receiver headroom、`predictedStagingEligibility` 和 CPU。`predictedStagingEligibility` 只是基于冻结 P0 admission 输入的预测，不是实际 staging、StageWork、lease 或 claim 证据。

Shadow 输入/结果必须（MUST）只写入独立 logistics owner 分支，不得（MUST NOT）修改 `synthesisControl.rooms[].missing`、donor bindings、`hub.needsPlan`、legacy pending/action 投影或任何被生产/market 读取的旧事实。

#### Scenario: 写前冻结防止新 legacy task 自我遮蔽

- **WHEN** `synthesis_room` 在本轮为缺口创建或 merge legacy task
- **THEN** matcher 必须使用 legacy 写入前的 demand/commitment/headroom 事实，新 task 不得让 Shadow 需求伪装为已覆盖

#### Scenario: 写后回退只精确排除配对任务

- **WHEN** 某调用点必须从已包含本轮 legacy 写入的 task store 构建 comparator 输入
- **THEN** 系统必须只排除 stable comparison key 指向的精确 legacy task/delta，其他同房同资源 commitment 仍必须参与安全计算

#### Scenario: predicted staging 不产生实际工作

- **WHEN** Shadow 候选在冻结 P0 输入下被判定可预装
- **THEN** runtime 可记录 `predictedStagingEligibility=true`，但不得创建 Carrier task、StageWork、CapacityLease、claim 或容量 reservation

#### Scenario: Shadow 投影不污染生产输入

- **WHEN** Shadow matcher 计算出与 legacy 不同的 donor 或 residual demand
- **THEN** 差异只能写入 logistics comparator DTO，不得修改 synthesis missing/binding、触发 Hub 重规划或让 market 把 Shadow residual 当真实缺口

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

系统必须（MUST）以 versioned、幂等迁移把 legacy resource-transfer task 映射为合同，并为每个需求保存唯一 `executionAuthority`。迁移、legacy skip 标记和合同创建必须原子完成；同一需求不得（MUST NOT）同时由 legacy executor 与 RoomLogisticsAgent 执行或重复扣减容量。`canary` 必须同时以不可变 contract origin 和 sourceRoom 命中 allowlist，不得仅因 targetRoom 命中就转移 authority。survival energy、Hub/Synthesis/PowerBank/capacity producer 和 console transfer 最终都必须经过合同账本。

回滚必须（MUST）使用带 requestId、scope.origins、scope.sourceRooms 和持久 phase 的 versioned request，phase 单向为 `requested -> quiescing -> materializing_legacy -> restoring_legacy_authority -> completed`，可进入 `failed` 并以同 requestId 幂等重试。global reset 不得遗失请求或把未完成 phase 伪造为 completed。

#### Scenario: 部分完成任务只迁移剩余量

- **WHEN** legacy task amount=10,000、remaining=2,500
- **THEN** 迁移合同必须记录 committed=10,000、delivered=7,500、remaining=2,500，并使 legacy executor 跳过该任务

#### Scenario: 重复运行迁移无副作用

- **WHEN** global reset 后迁移器再次看到同一个 legacyTaskId
- **THEN** 系统必须复用已有合同或迁移标记，不得创建第二个 active 合同

#### Scenario: Canary 必须同时命中 origin 与 sourceRoom

- **WHEN** canary allowlist 包含 `synthesis_room` 和 sourceRoom A，而两个同 origin 候选分别从 A 与 B 发送到同一 targetRoom
- **THEN** 只有 sourceRoom A 的需求可转移为 contract authority，B 必须继续由 legacy 执行，targetRoom 相同不得扩大 canary

#### Scenario: Retarget 不重新命中 canary

- **WHEN** 一个未命中 sourceRoom canary 的 demand 发生 receiver retarget，新 targetRoom 处于其他 canary 路线
- **THEN** 系统必须仍按原 demand 的不可变 origin/sourceRoom 保留 legacy authority，不得借 retarget 切换执行权

#### Scenario: survival energy 不再绕过合同

- **WHEN** 房间产生生存 energy deficit 且合同模式已对该 origin 启用
- **THEN** producer 必须发布 `survival_energy` intent，由合同/lease/Agent 执行，旧 direct-send 分支不得再调用 terminal

#### Scenario: 回滚不重放已交付量

- **WHEN** 合同模式回滚，active 合同 committed=10,000、delivered=6,000、remaining=4,000
- **THEN** 系统必须只物化 remaining=4,000 的 legacy task，终止合同 authority 并释放 lease/claim

#### Scenario: Global reset 后续跑回滚 phase

- **WHEN** 回滚 request 已在 `materializing_legacy` 幂等物化了部分 remainder 时发生 global reset
- **THEN** 系统必须从同 requestId/phase 恢复，复用已物化的 legacy identity，不得重放 delivered、创建重复 task 或提前标记 completed

### Requirement: 合同控制面必须提供有界观测

系统必须（MUST）投影 mode/schemaVersion、Shadow in-scope/out-of-scope、legacy 配对率、donor/route/priority/coverage/headroom/predicted-staging 差异 reason、`effectiveAuthority`、active contract/lease/claim store 数量、可观察 actor/claim/journal/invariant 状态，以及 intent/contract 的 origin、priority、state、blocker、remaining、oldest age、状态耗时、source commitment、route cost、aging/budget skip、幂等与数量守恒违规和 matcher candidate evaluation/continuation 指标。终态详情必须有界保留，monitor 必须兼容没有这些字段的旧快照。只有接入对应 mutator-boundary instrumentation 后，字段才可被称为跨模块 attempt 计数；首片不得用声明常量代替该证据。

首个纯 Shadow 必须（MUST）在剔除至少 10 个 warmup 可观测 tick 后，以部署前同口径基线收集至少 100 个连续 measured tick。包含 Shadow 成本的 ResourceControl phase post p95 CPU 必须不超过 pre p95 的 110%；`Memory.data.resourceControl.logistics` 与 `Memory.runtime.resourceControl.logistics` 的 UTF-8 JSON 序列化字节数合计必须在每个 measured tick 不超过 32 KiB。

#### Scenario: Shadow 独立 CPU 和 Memory 门槛

- **WHEN** `synthesis_room`-only Shadow 部署并完成 10 warmup + 100 连续 measured tick，期间 deploy tag 稳定且无 reset/人工 mutation
- **THEN** post p95 必须 `<= pre p95 * 1.10`，每个 measured tick 的 logistics data+runtime 必须 `<= 32768 bytes`；本地 disabled-vs-shadow 差分与 send/deal mock 必须无新增可观察 mutation/call，live 必须持续为 `effectiveAuthority=legacy`、active contract/lease/claim store 为零、无 Logistics Shadow actor/claim/journal 记录和可观察 invariant violation，且不得把这些净状态扩张为未布设探针的瞬时 attempt 证明

#### Scenario: 能定位长期无进展合同

- **WHEN** 一个合同在多个周期没有 staging 或 send 进展
- **THEN** runtime 必须报告其 blocker、blocked age、lastProgress age、nextAttemptAt、priority 与 source/target，而不是只报告 pending 总数

#### Scenario: 终态历史不会无限增长

- **WHEN** 已完成合同数量超过配置的详细审计保留上限
- **THEN** 系统必须保留聚合统计并裁剪最旧详情，active 合同不得被裁剪
