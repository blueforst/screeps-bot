## MODIFIED Requirements

### Requirement: 现有行为与 ABI 保持不变
统一TaskSystem foundation本身 MUST 保持37个main phase及顺序、Memory wire、private/public global ABI、console API、Worker/Carrier priority、assignment、producer refresh、domain lifecycle、Spawn queue、role topology、cleanup cadence与现有执行副作用不变。后续独立domain capability MAY 修改其明确列出的来源行为；这些变化必须由domain writer/command实现和验收，foundation adapter不得自行推断或执行。

#### Scenario: Foundation 不进入生产调度路径
- **WHEN** foundation完成并执行Rollup build
- **THEN** main、producer、planner、role、cleanup、spawn executor、ResourceControl与market executor不得依赖统一snapshot/adapters，规范化生产bundle必须与foundation基线保持等价

#### Scenario: 现存领域缺口不被Foundation顺手改写
- **WHEN** adapter遇到War、RemoteMining、Factory或Spawn尚未被独立domain capability闭合的歧义状态
- **THEN** 它只能保留来源状态并报告projection issue，不得推断新的终态、retry、retention、成员退役或资产清理行为

#### Scenario: 独立War capability闭合来源歧义
- **WHEN** War领域writer已按`war-workflow-lifecycle-ownership`显式完成terminal、pairing与owner release
- **THEN** War adapter可以移除对应历史ambiguity issue，但仍不得导入领域mutation API、读取执行资产来清理来源或改变其它domain行为
