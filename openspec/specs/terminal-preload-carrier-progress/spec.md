# terminal-preload-carrier-progress Specification

## Purpose
TBD - created by archiving change terminal-preload-carrier-progress. Update Purpose after archive.
## Requirements
### Requirement: 只有结构化容量救援 preload 可以越过普通 Energy

系统必须（MUST）仅在 CarrierTask 同时满足 producer=`resourceControl:preload`、type=`terminal_feed`、dispatchClass=`capacity_relief` 时，于普通非 critical Energy demand 之前尝试该 task。ResourceControl 必须（MUST）同时验证automatic ownership与capacity reason后才发布class；Carrier 不得（MUST NOT）解析 task id、resource 或 reason。dispatch class 必须（MUST）随 draft 原子刷新；无分类的新 draft 不得继承旧分类。classified Energy draft只可（MUST）包含当前capacity action的精确payload/fee缺口，不得（MUST NOT）补普通Terminal reserve或被market readiness扩大。

#### Scenario: Capacity relief 与普通 Lab Energy 同时存在

- **WHEN** 容量救援 cargo 已通过 staging admission并发布 classified step，且房间同时存在普通 Lab Energy demand
- **THEN** 空载 Carrier 必须先尝试容量救援 pickup

#### Scenario: Capacity action 的 Energy feed 使用相同类别

- **WHEN** accepted capacity action 需要从 Storage 搬运 Energy payload或手续费，且 classified Energy step 可执行
- **THEN** Carrier 必须按容量救援通道尝试该 step，且不得在 dispatch 层重新读取 `energyFloor/energyTarget/exportStart`

#### Scenario: 普通Terminal reserve不得搭便车

- **WHEN** Terminal Energy为0、普通reserve为20K，而非Energy capacity action只缺2K手续费
- **THEN** classified Energy step必须精确为2K，不得扩大为22K

#### Scenario: Market readiness不得扩大capacity step

- **WHEN** capacity batch与已授权market readiness同轮存在
- **THEN** 本轮market readiness必须按Terminal窗口冲突延后，classified Energy step不得被扩大

#### Scenario: 相同 producer 但没有 class

- **WHEN** `resourceControl:preload terminal_feed` 没有 `capacity_relief` dispatch class，且普通 Energy demand存在
- **THEN** 系统必须保持旧后台顺序，由普通 Energy先执行

#### Scenario: 其他 producer 不被提升

- **WHEN** 其他 producer 发布相同 type/class组合或普通 terminal feed，且普通 Energy demand存在
- **THEN** 系统必须保持旧后台顺序，不得授予容量救援通道

#### Scenario: Legacy聚合模式不伪造分类

- **WHEN** `terminalHeadroomRecoveryEnabled=false`，多个transfer task进入legacy按房间/资源聚合路径
- **THEN** 系统不得从已丢失的单一action provenance推断`capacity_relief` class

### Requirement: 即时房间安全需求与既有专用顺序必须保持

Tower Energy 必须（MUST）无条件优先于 classified preload。Spawn/Extension 仅在房间至少一个 active Spawn idle 时作为 immediate critical；所有 active Spawn 都在生产或只有 inactive Spawn时，允许 classified preload先取得一个 slice。PowerBank Boost、紧急 Lab cleanup、PowerSpawn supply、Nuker Ghodium 与 direct unmanaged PowerSpawn Energy 的既有前置顺序不得（MUST NOT）改变。

#### Scenario: Busy Extension 不得隐藏低能 Tower

- **WHEN** 所有 active Spawn忙碌、Extension缺能、Tower低于critical阈值且 classified preload可执行
- **THEN** target reader与Carrier必须先处理 Tower，不得领取 preload

#### Scenario: Active idle Spawn使Extension保持critical

- **WHEN** Extension缺能且至少一个 active Spawn idle，同时 classified preload可执行
- **THEN** Carrier必须先处理 room Energy

#### Scenario: 所有active Spawn忙碌时允许容量slice

- **WHEN** Extension缺能、所有 active Spawn都在生产、无更高优先级需求且 classified preload可执行
- **THEN** Carrier必须先尝试一个容量救援 pickup

#### Scenario: Inactive Spawn不制造立即需求

- **WHEN** 房间只有 inactive idle Spawn，或其他 active Spawn全部忙碌，同时 Extension与classified preload可执行
- **THEN** inactive Spawn不得使Extension抢占容量救援

#### Scenario: Direct PowerSpawn 保持前置

- **WHEN** 未由专用 board管理的 PowerSpawn Energy demand与classified preload同时可执行
- **THEN** Carrier必须先处理 PowerSpawn Energy

### Requirement: 容量救援 pickup 必须受任务量与目标容量约束

Classified preload 必须（MUST）复用 source inventory、market exposure、accepted snapshot与target delivery，并为每次 pickup 原子领取 task-step amount 与目标 Terminal共享容量。同 tick所有 Carrier 对同一 step 的 accepted withdraw总额不得（MUST NOT）超过 step amount；所有目标相同的 local cargo claim不得（MUST NOT）超过 Terminal物理余量。失败路径必须（MUST）释放两类 claim。

#### Scenario: 两个 Carrier 同 tick领取同一step

- **WHEN** 两个空载 Carrier同 tick尝试 amount小于两者总容量的 classified step
- **THEN** 两次 accepted withdraw总额不得超过 step amount

#### Scenario: Terminal剩余容量小于Carrier容量

- **WHEN** classified step大于Carrier空闲容量，但目标Terminal可领取余量更小
- **THEN** withdraw不得超过 source、step、Carrier与目标可用容量的最小值

#### Scenario: Pickup 后草案刷新

- **WHEN** Carrier accepted withdraw后board task被刷新或删除
- **THEN** Carrier必须依赖 accepted snapshot把 cargo送到原Terminal

### Requirement: 容量救援与普通工作必须双向有界进展

每次 classified capacity-relief pickup被接受后，该 Carrier下一次到达容量选择点时必须（MUST）跳过 classified relief并尝试低优先级pipeline。较低优先级pickup被接受或完整pass没有可执行候选后方可（MAY）消费yield；来源仅返回`ERR_NOT_IN_RANGE`时不得（MUST NOT）消费yield。通用后台board选择不得（MUST NOT）在该pass重新选中classified relief。Tower、active idle Spawn、PowerSpawn与Nuker等更高优先级任务仍可连续执行。

#### Scenario: 持续 relief 与普通 Energy 同时存在

- **WHEN** 单个 Carrier完成一次 classified pickup并再次空载，relief仍可执行且普通 Energy demand也可执行
- **THEN** 下一次低优先级 pass必须处理普通 Energy而不是再次领取 relief

#### Scenario: 让出时没有普通工作

- **WHEN** yield pass没有可执行的普通 Energy、后台board、dead-store或fallback工作
- **THEN** 系统可以空过该 pass，并在后续 source周期重新允许 classified relief

#### Scenario: 普通来源尚未到达

- **WHEN** yield pass已选中普通Energy或后台task，但其pickup仅因不在范围返回
- **THEN** yield标记必须保留，后续source周期必须继续该较低优先级工作而不得切回capacity relief

### Requirement: 未接受的 stale preload 不得污染普通 Energy

classified preload候选不可运行或 withdraw失败时，系统必须（MUST）在回落普通 Energy前清理其未接受的 ResourceControl terminal-feed assignment。清理不得（MUST NOT）依赖当前刷新后的draft仍带class；已存在accepted pickup snapshot时不得清除snapshot或改投cargo，其他producer的assignment也不得被误清。

#### Scenario: Stale Energy preload 后领取普通 Energy

- **WHEN** Carrier绑定的 classified Energy step变为不可运行且没有 accepted snapshot，随后普通 Energy pickup成功
- **THEN** 旧Terminal binding必须被清除，普通 Energy必须投向普通room target而非Terminal

#### Scenario: Preload withdraw失败后同次回落

- **WHEN** classified preload withdraw返回失败且普通 Energy source可执行
- **THEN** Carrier必须释放claim、清理未接受binding并在同次source调度继续普通Energy

#### Scenario: 同task id刷新为无class feed

- **WHEN** classified Energy pickup仅因不在范围保留assignment，下一轮同id被刷新为无class ResourceControl feed，随后Tower或普通Energy开始pickup
- **THEN** 系统必须清除未accepted旧binding，后续Energy不得被投递到Terminal
