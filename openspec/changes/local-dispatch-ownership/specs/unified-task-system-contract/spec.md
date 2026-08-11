## MODIFIED Requirements

### Requirement: Work identity 必须包含 system、namespace 与结构化 scope
统一层与经批准的Local Dispatch Ownership层 MUST 使用`{system, namespace, scope, localId}`组成`WorkRef`；namespace MUST来自领域owner/producer的稳定身份且不得通过解析localId反推，scope MUST是可判别的结构化room、actor、cross-room、shard-room、object或global scope。统一层和本地派工写路径 MUST NOT假定裸`task.id`在所有system、scope或producer之间全局唯一。

#### Scenario: 相同 local ID 不发生跨系统碰撞
- **WHEN** Worker、Carrier 和 Factory 各自出现相同 `localId`
- **THEN** 三条 `WorkRef` 必须保持不同 identity，查询、排序和状态汇总不得互相覆盖

#### Scenario: 同房不同 Carrier producer 精确共存
- **WHEN** 同一房间两个 Carrier producer 发布相同本地 task ID
- **THEN** board、dispatch binding与projection identity必须以namespace区分producer并同时保留两条工作，不得覆盖、误绑定或继续报告已修复的底层碰撞风险

### Requirement: Adapter 首切片只有只读能力
`TaskSystemAdapter` MUST只暴露system identity与snapshot读取能力；它 MUST NOT提供通用execute、assign、claim、cancel、complete、delete、transition、TTL cleanup、repository upsert或asset release方法。后续需要owner reconciliation时 MAY在`taskSystem/`之外实现使用canonical WorkRef的独立、领域化mutation port，但adapter、registry和snapshot不得导入或暴露该写端口。

#### Scenario: Adapter 不能成为旁路写入口
- **WHEN** 调用方获得任意 Task System adapter
- **THEN** 其公共接口必须无法修改来源 store、触发 Screeps intent、清除任务、分配 creep 或改变领域状态

#### Scenario: 独立派工端口不污染adapter
- **WHEN** Worker slot或Carrier same-tick slice通过Local Dispatch Ownership写入
- **THEN**写操作必须从领域role/producer进入独立command port，TaskSystem adapter仍只能消费隔离read DTO并保持`system + snapshot`接口

#### Scenario: 领域继续拥有写语义
- **WHEN** Carrier producer replace snapshot、ResourceTransfer 重复提交加量、Workflow 转换或 Spawn producer upsert config
- **THEN** 这些写操作必须继续通过原领域入口执行，统一 adapter 不得改写或重新解释其幂等语义

### Requirement: 现有行为与 ABI 保持不变
统一TaskSystem foundation本身 MUST保持37个main phase及顺序、Memory wire、private/public global slot名称、console API、Worker/Carrier priority与action、producer refresh、domain lifecycle、Spawn queue、role topology、cleanup cadence和现有执行副作用不变。后续独立domain capability MAY修改其明确列出的来源行为，但必须由domain writer/command实现和验收。Local Dispatch MAY改变private heap内部identity表示，并仅修复完整ref身份错误：Worker跨房同localId的lookup/release、actor派工房scope漂移，以及Carrier跨producer同localId的board/binding/downstream稳定键隔离；除此之外行为 MUST保持不变。系统 MUST保留现有领域gateway与compatibility localId字段，且foundation adapter不得自行推断或执行，不得把TaskSystem runtime变成生产决策依赖。

#### Scenario: Foundation 不进入生产调度路径
- **WHEN** foundation完成并执行Rollup build
- **THEN** main、producer、planner、role、cleanup、spawn executor、ResourceControl与market executor不得依赖统一snapshot/adapters，规范化生产bundle必须与foundation基线保持等价

#### Scenario: Local Dispatch进入生产但TaskSystem仍不调度
- **WHEN** Local Dispatch实现完成并执行Rollup build
- **THEN**批准的dispatch ownership与直接caller可以进入bundle，但taskSystem catalog/model/registry/snapshot/adapters不得作为运行时source进入生产图；main、planner、ResourceControl与market executor不得读取统一snapshot决定行为

#### Scenario: 完整ref身份修正是唯一授权的派工行为变化
- **WHEN**Worker出现跨房同localId或派工房scope漂移，或者同房不同producer发布相同Carrier localId
- **THEN**Worker lookup/release必须精确隔离并在当前房重选，Carrier两条工作及其downstream稳定键必须独立；除此之外hard lane、sticky选择、step选择、amount claim、accepted cargo delivery、Worker评分与既有release条件必须保持characterization结果

#### Scenario: 尚未闭合的领域歧义不被改写
- **WHEN** adapter遇到War、RemoteMining、Factory或Spawn尚未被独立domain capability闭合的歧义状态
- **THEN** 它只能保留来源状态并报告projection issue，不得推断新的终态、retry、retention、成员退役或资产清理行为

#### Scenario: 独立War capability闭合来源歧义
- **WHEN** War领域writer已按`war-workflow-lifecycle-ownership`显式完成terminal、pairing与owner release
- **THEN** War adapter可以移除对应历史ambiguity issue，但仍不得导入领域mutation API、读取执行资产来清理来源或改变其它domain行为

#### Scenario: 现存领域缺口不被顺手改写
- **WHEN** ownership或adapter遇到Worker reset空窗、Carrier cargo reset、普通任务无amount slice或其它既有歧义
- **THEN**它只能保持当前领域降级或报告issue，不得发明持久恢复、统一claim、终态、retry、retention或资产清理行为
