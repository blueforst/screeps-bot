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

### Requirement: Distributed route replan 必须保留已完成进度

分布式合成 allocation ledger 必须（MUST）把健康 pending route 的 `remainingAmount` 计入 receiver inventory 并从 donor inventory 扣除，因此同 route key 的新 route decision 表示尚未被既有 pending 覆盖的增量需求。upsert 必须把该增量同时加入累计 `amount` 与 `remainingAmount`，不得（MUST NOT）把 `remainingAmount` 重置为新 decision amount、改变既有 `amount - remainingAmount` 已交付量，或把 planner refresh 记作实际 transfer progress。本轮 route decisions 只是新增缺口，不是完整 route 期望集合；coverage-healthy pending route 是已经签发的有界数量承诺，不得仅因本轮零增量而缩量或取消。

#### Scenario: 健康 route 已部分完成后出现增量需求

- **WHEN** 同 key 健康 automatic route 已交付一部分、仍有 pending remainder，下一 plan revision 又产生新的正数 route decision
- **THEN** 系统必须复用原任务并将新 decision 作为增量加入 `amount`/`remainingAmount`，同时保持已交付量与 `lastProgressAt` 不变

#### Scenario: Pending remainder 已覆盖本轮新增缺口

- **WHEN** 健康 direct route 没有出现在本轮增量 decisions，且 receiver 的当前有效产品仍使用该 resource 或产品来源不可可靠判定
- **THEN** 原任务必须原样保持 pending，不得刷新或取消其 `amount`、`remainingAmount` 与 `lastProgressAt`

#### Scenario: Hub fallback 或 busy 旧产线继续生效

- **WHEN** Hub fallback config 或未入选但不可重写的 busy 旧 config 仍执行使用该 resource 的产品
- **THEN** 系统必须从实际继续生效的 config/runtime 产品保留该 route，不得因其 room 未出现在本轮 dispatchAssignments 而取消

#### Scenario: Direct route 与当前产品不再兼容

- **WHEN** receiver 的当前 assignment 已切换为不使用旧 route resource 的产品
- **THEN** 系统必须把该 direct route 以 `cancelled_by_replan` 取消，因为产品不兼容是独立于增量集合的可靠 stale 证据

#### Scenario: Hub-owned room 在本 revision 明确清空

- **WHEN** 可见且 owner-compatible 的 synthesis 房间在本 revision 已安全清空 reaction，当前没有 fallback/busy 产品继续生效
- **THEN** 该房间是“已知无 consumer”而不是“consumer 未知”，旧健康 direct route 必须以 `cancelled_by_replan` 回收

#### Scenario: Consumer 不可见或归属未知

- **WHEN** direct route 的 receiver 不在本轮可见 owner-compatible 房间集合，且没有可靠产品或清空事实
- **THEN** 系统不得把未知误判成无 consumer，必须让已签发的健康 remainder 完成或由既有 liveness TTL 退出

#### Scenario: Hub transit route 缺少 consumer provenance

- **WHEN** 健康 `synthesis:hub-route` task 指向当前 Hub、没有出现在本轮增量 decisions，且旧 task 未记录可重验的下游 consumer provenance
- **THEN** 系统不得仅按 key 缺失取消，必须让任务完成或由既有有界 liveness TTL 退出；若 endpoint 指向旧 Hub，则必须以 `cancelled_by_replan` 回收

#### Scenario: Distributed storage 停止 non-T3 surplus 集中

- **WHEN** `distributedStorage=true` 且旧健康 `synthesis:surplus` task 搬运的是 non-T3 资源，或 surplus endpoint 已不是当前 Hub
- **THEN** 系统必须以 `cancelled_by_replan` 取消，因为当前 policy/Hub identity 已提供该 route 不再有效的可靠证据；指向当前 Hub 的 T3 或非 distributed-storage surplus 在缺少 provenance 时继续保守完成

#### Scenario: Coverage-expired route 等待 canonical reconciliation

- **WHEN** route 已不再覆盖需求且本轮没有同 key 新增 decision
- **THEN** Hub replan 不得抢先写入 `cancelled_by_replan`，必须由 ResourceControl reconciliation 保留对应 `automatic_*_timeout` 机器原因
