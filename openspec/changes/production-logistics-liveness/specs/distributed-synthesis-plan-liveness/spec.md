## ADDED Requirements

### Requirement: 每个 synthesis 房间在一个计划 revision 内最多承诺一个产品

分布式合成 planner 必须（MUST）把已分配房间作为硬排除条件，同一 Hub plan revision 的 `dispatchAssignments` 中每个 `roomName` 最多出现一次。写 reaction config、route、allocation ledger 或保护事实前必须再次验证该不变量；重复 assignment 必须让本轮 distributed plan fail closed。

#### Scenario: 链步骤多于可用房间

- **WHEN** 可执行链步骤数量大于 eligible synthesis 房间数量
- **THEN** planner 只能为每个房间选择一个产品，其余步骤保持未分配/blocked，不得复用房间生成第二个 active assignment

#### Scenario: 防御性校验发现重复房间

- **WHEN** planner 输出或测试注入的 assignments 含同一 roomName 的两个产品
- **THEN** 系统不得写任一相关 reaction config 或 route，并必须提交机器可读 invariant violation/invalid protection 结果

### Requirement: Hub 写入的 synthesis 配置必须带 owner 与 revision

HubPlanner 每次实际写入辅助房或 Hub 房的自动 reaction config 时必须（MUST）原子记录 `owner=hubPlanner`、`hubRoomName` 和当前 plan revision。新 revision 只能清理同一 Hub owner 的旧配置；不得（MUST NOT）清理 ownerless、人工或其他 owner 的配置。

#### Scenario: 当前 revision 刷新自动配置

- **WHEN** HubPlanner 在可重写房间写入本轮 assignment
- **THEN** reaction 与 plannerOwnership 必须同时反映当前 hubRoomName/revision，不得只更新其中之一

#### Scenario: 不再选择的旧自动配置

- **WHEN** 房间配置由同一 Hub 的旧 revision 拥有、当前 revision 不再分配该房且房间可安全重写
- **THEN** HubPlanner 必须清空自己拥有的旧 reaction 并释放 ownership

#### Scenario: 人工配置不被回收

- **WHEN** 当前未选择房间存在 ownerless、人工或其他 owner 的 synthesis 配置
- **THEN** HubPlanner 不得因 stale reconcile 删除或改写该配置

#### Scenario: Busy 旧配置延迟回收

- **WHEN** 同 Hub 旧 revision 配置不再被选择，但房间仍在 loading/synthesizing/unloading/cleanup
- **THEN** 系统必须保留当前运行配置、记录 skipped-busy，并在后续可重写 revision 再回收

### Requirement: Distributed synthesis liveness 必须可诊断且有界

`Memory.runtime.hub.distributedSynthesis` 必须（MUST）投影本轮 blockedTargets、assignment invariant violations 和 config reconciliation 摘要，并限制数组/房间明细大小。观测不得（MUST NOT）作为下一轮 planner 的事实来源。

#### Scenario: 资源不足导致部分目标未覆盖

- **WHEN** 硬唯一房间约束或全局原料不足使目标无法获得 assignment
- **THEN** runtime 必须保留对应 blocked target/未覆盖状态，不得仅因存在至少一个 assignment 就把全部 missingResources 清空

#### Scenario: 旧快照缺少新字段

- **WHEN** Monitor 读取没有 liveness/reconcile 字段的旧 runtime
- **THEN** Monitor 必须继续输出旧字段，并把新字段标记为不可用而不是伪造零违规
