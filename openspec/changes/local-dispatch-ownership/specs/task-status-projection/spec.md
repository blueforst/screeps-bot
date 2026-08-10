## MODIFIED Requirements

### Requirement: Projection 保留 normalized activity 与原始领域状态
每条`WorkStatusView` MUST包含`WorkRef`、`activity`、`sourceState`、authority列表和issue列表；`activity` MUST仅使用`desired/available/claimed/running/blocked/terminal/unknown`，且 MUST NOT替代或回写原始领域状态。对于Local Dispatch来源，claim或producer证据 MUST以canonical完整ref闭合，不能仅凭compatibility localId推断。

#### Scenario: ResourceTransfer blocker 被投影但不转换来源
- **WHEN** v2 ResourceTransfer 记录为 `pending` 且带 `blockedReason`
- **THEN** projection activity 必须为 `blocked`、sourceState 必须仍为 `pending`、blocker 必须保留，来源 task 不得发生状态或时间戳写入

#### Scenario: Worker claim 只在完整 ref 证据闭合时展示
- **WHEN** Worker task的room-scoped ref、task assignee与creep canonical assignment三者双向一致
- **THEN** projection MAY标记为`claimed`并列出assignee authority；当assignment只有裸localId、scope/namespace不符或任一侧漂移时必须保留`active`sourceState、投影`unknown`并报告issue，不得修复来源assignment

#### Scenario: Carrier 同localId跨producer分别投影
- **WHEN**owner-aware Carrier read DTO包含同房、同localId但不同producer namespace的两条合法task
- **THEN**adapter必须输出两条不同WorkRef的available记录，不得覆盖、合并或发布`carrier-task-id-collision-risk`

#### Scenario: Carrier 不伪造顺序 step 或完成进度
- **WHEN** Carrier task 包含多个 transport step
- **THEN** adapter 必须把它们视为并列领域事实，不得按数组位置投影 sequential workflow 进度，也不得因 carrier delivery 推断 task terminal

### Requirement: Snapshot identity 与顺序确定性
统一snapshot MUST使用当前tick/shard observation context，并按`system → namespace → canonical scope → localId`确定性排序；相同来源事实的重复读取 MUST产生语义相同的identity、activity、sourceState、authority、issue与summary。Local Dispatch private storage的owner index或发布顺序不得替代该canonical comparator。

#### Scenario: 输入插入顺序不同但输出稳定
- **WHEN** 两个 fixture 具有相同记录但对象、owner index、Spawn或PowerCreep插入顺序不同
- **THEN** snapshot entries 和 summaries 必须得到相同的 canonical 顺序与计数

#### Scenario: local ID 特殊字符不破坏 identity
- **WHEN** localId、producer 或 scope 值含冒号、箭头或其他当前 config/task 命名字符
- **THEN** 结构化 WorkRef 与 canonical comparator 必须保持字段边界，不得依赖不可逆字符串 split 猜测 identity

#### Scenario: Exact duplicate dispatch ref fail-closed
- **WHEN**owner-aware read DTO意外含两条字段完全相同的Worker或Carrier WorkRef
- **THEN**snapshot必须按既有duplicate identity合同拒绝该system结果并输出有界诊断，不得由插入顺序选择一条

### Requirement: 首切片保持关闭态运行边界
统一snapshot、registry和领域adapters MUST NOT接入main tick、Memory、RawMemory segment、global console ABI或远程mutation API。Local Dispatch Ownership MAY由现有Worker/Carrier生产路径引用，但其到`taskSystem/model`的依赖 MUST仅为类型依赖，生产Rollup不得保留catalog、model运行时、registry、snapshot或adapters。

#### Scenario: 派工运行时与只读snapshot保持分层
- **WHEN**Jest直接调用统一snapshot且生产Worker/Carrier通过Local Dispatch command运行
- **THEN**测试必须验证完整projection合同，生产模块只能依赖dispatch command/read DTO而不得调用adapter或聚合snapshot

#### Scenario: Bundle只包含批准的派工来源
- **WHEN**Local Dispatch change执行Rollup build
- **THEN**bundle source inventory可以新增批准的dispatch ownership模块和直接caller，但不得出现taskSystem catalog/model/registry/snapshot/adapters运行时source，也不得扩大Memory写集合或main phase

#### Scenario: 意外生产引用阻止归档
- **WHEN**build graph显示TaskSystem runtime被意外保留、adapter进入生产决策或read DTO产生模块初始化副作用
- **THEN**本变更不得归档或部署，必须先删除反向依赖/副作用或以独立行为变更重新评估
