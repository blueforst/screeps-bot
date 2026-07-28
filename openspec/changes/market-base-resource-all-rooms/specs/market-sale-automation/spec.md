## MODIFIED Requirements

### Requirement: 当 tick 新鲜的生产保护账本
系统 MUST 在最终出售规划前主动收集当前 Factory、活动及暂停 Synthesis、Hub committed plan、Boost/War、关键出站、carrier/in-flight、resource reservation 和托管订单暴露。每个候选账本 MUST 带当前 planning revision、观测时间、TTL 和稳定贡献 ID。Hub committed protection MUST 是局部构造后整包替换的全量 snapshot，所有子字段共享同一 planRevision/configFingerprint，缺项显式为空；adapter 不得从 legacy 分散字段拼装。Hub 的“下一轮重规划请求”不得单独使上一份仍新鲜且配置一致的 committed protection 失效；marker 缺失、过期、配置漂移、跨 revision 或事实异常仍 MUST fail-closed。

#### Scenario: 后置 producer 未发布也能保护
- **WHEN** War 或 HomeDefense 在主循环中晚于 ResourceControl 执行
- **THEN** collector 仍从当前配置、Game/Memory 事实和未过期承诺计算其资源保护量

#### Scenario: 非 ResourceControl 刷新 tick 仍复核已有暴露
- **WHEN** 本 tick 不执行完整 ResourceControl 规划，但存在 managed 或 pending exposure
- **THEN** 系统仍生成 current-tick 轻量保护账本并复核；无法完整解释时立即进入安全撤单/排空，确认前继续保留 exposure

#### Scenario: 保护来源过期
- **WHEN** 候选资源的任一必要保护来源缺失、过期、配置指纹不一致或没有有效 committed revision
- **THEN** 该房间资源本轮完全禁止出售，并记录 `protection_stale`

#### Scenario: Hub 同 Tick 请求重规划
- **WHEN** Hub 已完成并标记一份 current committed protection，随后 Synthesis 在同 tick 只设置 `needsPlan=true`
- **THEN** collector 必须继续使用上一份 committed Hub 事实并叠加当前 Synthesis 事实，不得仅因 request flag 产生 `protection_stale:hub`

#### Scenario: Hub 模式切换必须清空旧 Residual
- **WHEN** 新 Hub plan 从 distributed 转入 fallback/blocked，或新 residual 小于旧 residual
- **THEN** next committed snapshot 必须以显式空值/新值整包替换，market sellable 不得复用旧 allocation ledger 或 surplus

#### Scenario: Hub Attempt 开始即撤销旧 Snapshot 资格
- **WHEN** cadence/needsPlan 已触发新 attempt，随后发生 room/structure early return、throw 或 CPU cut
- **THEN** attempt high-water 必须已在早退前递增，adapter 必须拒绝旧 revision，并由单出口发布同 revision 的 blocked/failed invalid empty snapshot

#### Scenario: Legacy Hub Seller 不得消费新 Surplus
- **WHEN** v3 committed snapshot 发布基础矿物 surplus，而 legacy ResourceControl/Hub seller 配置被误开
- **THEN** legacy seller 必须由代码级永久闩保持零 candidate/零 staging/零 market write；该 surplus 只能进入 v3 Direct protection adapter

#### Scenario: Forecast buffer 缺失或不足
- **WHEN** allowlist 资源没有有限正数的 forecast buffer，或该值小于一笔安全批次
- **THEN** 配置或该候选必须 fail-closed，不得创建或继续保留市场暴露

#### Scenario: 旧承诺无法去重
- **WHEN** 旧任务没有稳定合同 ID
- **THEN** 系统把它作为独立承诺保守计入，不得因无法去重而少保护

#### Scenario: Hub 分配余量不是生产需求
- **WHEN** distributed synthesis 完成分配后，`allocationLedger.roomCommitments` 表示已扣除本地 reserve、待收发和实际分配的剩余可用库存
- **THEN** collector 不得把该余量计入生产需求；它只能作为 Hub 基础矿物 market surplus 的上界，且仍须扣除其他保护

#### Scenario: 同一合成计划的重复视图去重
- **WHEN** 同房同产品的生产计划同时出现在 Synthesis active/paused runtime 与 Hub dispatch
- **THEN** collector 使用同一稳定计划键并按最大金额只计一次；同房不同产品的计划仍分别保护

### Requirement: 动态 Canary 选择
Maker 与 Direct 均 MUST 按各自 capability 的 live 前置条件确定性选择 canary，不得把 Maker canary lock、其他资源或其他房间的资格直接继承。Maker 首批候选仍 MUST 为非 Hub、非 capacity emergency；Direct v3 的 Hub/emergency lane 只有在 explicit room/lane grant、完整 committed protection、独立 100-cycle Shadow 和 one-shot Canary 合同下才能参与。

#### Scenario: 中央 Hub 满仓且正在生产
- **WHEN** Hub 正在 loading、synthesizing、unloading，或处于 capacity emergency，且没有 v3 committed residual、lane Shadow/Canary 和 exact permit
- **THEN** 它不得被 Maker 或 Direct 自动选择

#### Scenario: V3 Hub 或 Emergency Lane 已完整授权
- **WHEN** Hub/emergency lane 具有 current committed protection、明确基础矿物 surplus、terminal 实存、可信净价、独立 lifecycle 和 exact permit grant
- **THEN** Direct MAY 选择它的小额 canary；容量状态不得降低 floor、reserve、batch 或 quota

#### Scenario: 没有合格候选
- **WHEN** 所有房间均被生产、容量、terminal、能量、价格、lifecycle 或账本条件拒绝
- **THEN** 系统保持等待并投影逐候选拒绝原因，不得放宽底线

#### Scenario: Maker Canary 首次锁定后不自动扩围
- **WHEN** Maker 首次动态选择一个合格 room/resource
- **THEN** 持久锁定该唯一对象、强制有效 maxManagedOrders 为 1 且禁止 hybrid；该 lock 不授权 Direct，直到 Maker 完成验收或安全 drain

#### Scenario: 被锁 Maker Canary 暂时不合格
- **WHEN** 已锁定的 Maker room/resource 在后续 tick 不满足前置条件
- **THEN** 无暴露时系统等待；存在 managed/pending exposure 时立即安全 cancel/drain 并确认归零，同时保留原 Maker lock，不得自动改选第二候选

#### Scenario: 从 Maker 转入 Direct Canary
- **WHEN** operator 采用 Direct follow-up capability 启动独立 Shadow
- **THEN** 系统必须先证明 Maker managed/pending/exposure 和所有 remainingAmount>0 的自有订单全零，再按 Direct 自己的 roster/lane/policy 建立资格；Maker lock、Shadow count 或 revision 均不得继承

## ADDED Requirements

### Requirement: Direct 原始资源配置必须拒绝额外项
Direct v3 raw validator MUST 精确验证基础矿物 allowlist 和全部 threshold maps；非法或额外资源不得被 normalizer 静默移除。

#### Scenario: 静默过滤攻击
- **WHEN** raw `sellResources` 或 hard/economic/forecast map 同时包含七种基础矿物和一个禁止资源
- **THEN** 配置必须整体无效并记录具体额外 key，不能规范化成看似合法的七资源配置

### Requirement: 市场 Seller Energy Readiness 不得侵占生产
ResourceControl SHALL 为已授权 Direct seller terminal 准备 current effective post-deal reserve 与最大交易费所需的 Energy。effective reserve MUST 至少为 25,000，并叠加/保护普通 terminal reserve、pending Energy send、其他内部发送手续费和 terminal-scoped production commitments；Direct 两次 full read MUST 保证实际成交后仍满足该 current reserve。补给 MUST 保持 room energy floor、合并全部当 tick drafts 后的 terminal headroom 和统一 action claim。

#### Scenario: 安全补给
- **WHEN** seller terminal 低于 readiness target 且本房 storage 有生产保护后的安全 Energy 与足够 terminal headroom
- **THEN** 系统只创建精确缺口的本地 Carrier feed，不购买 Energy

#### Scenario: Readiness 使用 Canonical State
- **WHEN** ResourceControl 早于本 tick live market runtime 执行
- **THEN** 它必须通过纯 versioned reader 校验 `Memory.data` 中的 canonical permit/state，不得依赖尚未发布的 runtime 投影或形成 market/protection 循环依赖

#### Scenario: 不安全补给
- **WHEN** 房间 emergency、补后 terminal free 不足、storage 会跌破保护量或 terminal 已被 claim
- **THEN** 不得创建 readiness feed，Direct 保持安全等待

#### Scenario: 生产或发送 Reserve 提高
- **WHEN** current pending send 或生产承诺使 effective post-deal reserve 高于 25,000
- **THEN** readiness target 必须在该 reserve 上再加最大市场手续费，实际 deal 不得只保留固定 25,000

### Requirement: 生产保护修复不得改变主循环阶段
系统 MUST 保持 `marketSalePreflight → pixelGenerator(disabled) → productionMonitor → hubPlanner → hubUpgradeControl → synthesisControl → factoryControl → mineralExtraction → resourceControl → marketSaleAutomation` 的完整行为顺序，并且每 tick 最多运行一次完整 Hub planner。Hub committed snapshot 与 replan request 的修复不得通过重排、跳过中间 producer 或增加第二次完整 Hub plan 实现。

#### Scenario: Main Phase Order 回归
- **WHEN** 执行一个包含 Hub replan、Synthesis 更新、ResourceControl readiness 和 live market planning 的 tick
- **THEN** 观测顺序必须精确保持 marketSalePreflight、disabled pixelGenerator、productionMonitor、hubPlanner、hubUpgradeControl、synthesisControl、factoryControl、mineralExtraction、resourceControl、marketSaleAutomation，且 Hub full planner 调用次数不超过一次
