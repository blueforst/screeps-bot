## ADDED Requirements

### Requirement: Canonical Task System Catalog
系统 MUST 以一个无 Screeps runtime 依赖的 Catalog 精确登记 `worker-work`、`carrier-logistics`、`power-creep-action`、`resource-transfer`、`factory-command`、`remote-mining-workflow`、`colonization-workflow`、`rescue-workflow`、`flag-hauling-workflow`、`cross-shard-colonization-workflow`、`war-workflow`、`power-bank-workflow` 和 `spawn-production` 十三个 canonical system；`TaskSystemId` MUST 由 Catalog own keys 派生，不得另行手写联合类型。

#### Scenario: Catalog key 与类型保持同源
- **WHEN** 编译器或架构测试读取 Task System Catalog
- **THEN** Catalog own keys 必须与独立声明的十三项 canonical oracle 完全相等，`TaskSystemId` 必须接受每个 canonical key且拒绝未知 key

#### Scenario: 原型属性不是合法 system ID
- **WHEN** 运行时 guard 收到 `constructor`、`toString`、`__proto__`、空字符串、对象或其他未知值
- **THEN** guard 必须 fail-closed 返回 false，且不得读取继承属性作为 Catalog entry

### Requirement: Catalog 只描述模型能力
每个 Catalog entry MUST 明确声明 model、durability、scope、reconcile、claim 和 domain owner；Catalog MUST NOT 包含领域 payload、Memory path resolver、优先级数值、timeout、状态转换、Screeps intent、body、pathing 或执行函数。

#### Scenario: 同名 Task 被正确分类
- **WHEN** Catalog 描述 Worker、Carrier、ResourceTransfer、PowerBank 与 Spawn Production
- **THEN** 它们必须分别保持可重建 dispatch projection、owner snapshot、本领域持久 command/workflow 和 desired actor production 的类别差异，不得被归为同一种持久 Task store

#### Scenario: 纯 Catalog 不读取游戏环境
- **WHEN** 在没有 `Game`、`Memory`、`RawMemory`、`global`、Screeps 常量或领域模块的环境加载 Catalog
- **THEN** Catalog 和 runtime guard 必须可正常工作且不得产生任何模块或环境副作用

### Requirement: Work identity 必须包含 system、namespace 与结构化 scope
统一层 MUST 使用 `{system, namespace, scope, localId}` 组成 `WorkRef`；namespace MUST 来自领域 owner/producer 的稳定身份且不得通过解析 localId 反推，scope MUST 是可判别的结构化 room、actor、cross-room、shard-room、object 或 global scope。统一层 MUST NOT 假定裸 `task.id` 在所有 system、scope 或 producer 之间全局唯一。

#### Scenario: 相同 local ID 不发生跨系统碰撞
- **WHEN** Worker、Carrier 和 Factory 各自出现相同 `localId`
- **THEN** 三条 `WorkRef` 必须保持不同 identity，查询、排序和状态汇总不得互相覆盖

#### Scenario: 同房不同 Carrier producer 可区分
- **WHEN** 同一房间两个 Carrier producer 发布相同本地 task ID
- **THEN** projection identity 必须以 namespace 区分 producer 并报告现有底层碰撞风险，不得把两者伪装成一个已确认 owner 的工作

### Requirement: Authority 支持多角色而非单 owner 字段
统一 authority MUST 至少区分 producer、workflow owner、executor、assignee、lease owner 和 queue owner，并 MUST 允许一条工作同时关联多个 authority；generation 与 component MUST 作为可选结构化身份，而不是拼接后由公共层反向解析。

#### Scenario: Logistics authority 不被压扁
- **WHEN** 未来 TransferContract 同时存在 demand producer、receiver lease owner、source executor 与 carrier claimant
- **THEN** 统一类型必须能分别表达这些 authority，且不得选择任一角色作为覆盖其他角色的通用 `ownerId`

#### Scenario: Combat generation 保持领域身份
- **WHEN** War 或 PowerBank 同一 task 同时存在不同 generation/component 的成员或资产
- **THEN** owner reference 必须能保留 generation/component，公共层不得把 generation 当作普通 retry attempt

### Requirement: Adapter 首切片只有只读能力
`TaskSystemAdapter` MUST 只暴露 system identity 与 snapshot 读取能力；本切片 MUST NOT 提供通用 execute、assign、claim、cancel、complete、delete、transition、TTL cleanup、repository upsert 或 asset release 方法。

#### Scenario: Adapter 不能成为旁路写入口
- **WHEN** 调用方获得任意 Task System adapter
- **THEN** 其公共接口必须无法修改来源 store、触发 Screeps intent、清除任务、分配 creep 或改变领域状态

#### Scenario: 领域继续拥有写语义
- **WHEN** Carrier producer replace snapshot、ResourceTransfer 重复提交加量、Workflow 转换或 Spawn producer upsert config
- **THEN** 这些写操作必须继续通过原领域入口执行，统一 adapter 不得改写或重新解释其幂等语义

### Requirement: Plan、授权和市场事务不注册为通用 Task
Synthesis/Hub plan、Energy pickup reservation、resource reservation、receiver capacity ledger、local destination claim、terminal action claim 与 market order/WAL/pending transaction MUST NOT 被登记为独立 canonical Task System 或迁入通用 store。统一 projection MAY 将其作为 task 的关联事实或 authority 展示，但 MUST 保留原 owner 与执行网关。

#### Scenario: Hub plan 不成为第二执行源
- **WHEN** Hub dispatch/route/allocation projection 与其派生的 Synthesis config 或 ResourceTransfer 工作同时存在
- **THEN** 只有原 Synthesis/ResourceTransfer source of truth 可以驱动执行，Hub plan 不得作为重复可领取 task 发布

#### Scenario: Market WAL 不受通用 cleanup
- **WHEN** 存在 prepared Direct、mutation lease、account claim 或不确定外部交易
- **THEN** 通用 Task 层不得完成、取消、过期或删除该事务，且不得绕过 market action arbiter

### Requirement: Spawn Production 通过 adapter 接入但不实现有限 Task
`CreepConfig`、`SpawnMemory.spawnList`、native `spawn.spawning` 与 live Creep MUST 保持现有四层生产管线；普通 config 在 spawn 成功后 MUST 继续表达 desired actor/replacement policy，不能因统一 Task completion 语义被删除。

#### Scenario: Live creep 与 replacement queue 可并存
- **WHEN** 同一普通 config 同时有 live creep 和合法 prespawn replacement queue entry
- **THEN** Spawn adapter 必须保留两项事实，且统一层不得将 queue 视为重复已完成 task 删除

#### Scenario: 一次生产成功不终结普通 config
- **WHEN** `spawnCreep` 对普通 config 返回 `OK`
- **THEN** 现有 queue ack、config retention、CreepMemory 与后续 replacement 行为必须保持不变，统一层不得写 terminal status

### Requirement: Logistics contract 领域所有权保持独立
统一 Task Core MUST NOT 定义或实现 latest intent matcher、TransferContract 数量守恒、CapacityLease 算法、StageWorkClaim 恢复、RoomLogisticsAgent、terminal/market 仲裁或物流 priority policy；这些能力 MUST 继续由 `decentralized-logistics-contracts` 及其领域模块拥有。

#### Scenario: 当前 v2 与未来 contract 都可被投影
- **WHEN** ResourceTransfer 来源仍为 v2 task 或未来切换为 TransferContract
- **THEN** 对应领域 adapter 可以更换 projection 映射，而统一 identity/activity 协议无需接管物流执行或复制持久 claim

#### Scenario: 通用 claim 不替代容量 lease
- **WHEN** receiver headroom、source commitment、carrier cargo 与 terminal window 同时需要授权
- **THEN** 通用层不得用一个 nullable claim 字段代替物流领域的独立 authority、数量、TTL、物理重验和 reset 恢复合同

### Requirement: 现有行为与 ABI 保持不变
本变更 MUST 保持37个 main phase 及顺序、Memory wire、private/public global ABI、console API、Worker/Carrier priority、assignment、producer refresh、domain lifecycle、Spawn queue、role topology、cleanup cadence 与现有执行副作用不变。

#### Scenario: Foundation 不进入生产调度路径
- **WHEN** foundation 完成并执行 Rollup build
- **THEN** main、producer、planner、role、cleanup、spawn executor、ResourceControl 与 market executor 不得依赖统一 snapshot/adapters，规范化生产 bundle 必须与基线保持等价

#### Scenario: 现存领域缺口不被顺手改写
- **WHEN** adapter 遇到 War、RemoteMining、Factory 或 Spawn 的既有歧义状态
- **THEN** 它只能保留来源状态并报告 projection issue，不得推断新的终态、retry、retention、成员退役或资产清理行为
