## ADDED Requirements

### Requirement: 每个房间必须只有一个 terminal side-effect owner

每个拥有 terminal 的房间每 tick 必须（MUST）由唯一 RoomLogisticsAgent 仲裁 `terminal.send`、会占用 terminal/cooldown 的 market action 和发送 staging window。其他 producer/executor 不得（MUST NOT）直接产生 terminal side effect；同一 terminal 在一个可用窗口最多执行一个获准动作。

#### Scenario: Survival energy 与普通合同竞争同一 terminal

- **WHEN** 同一房间同时有 `survival_energy` 和普通 transfer 合同
- **THEN** 两者必须进入同一个 Agent 队列并按显式 priority 仲裁，旧 direct energy 分支不得绕过 owner

#### Scenario: Market 与合同不能双重占用窗口

- **WHEN** 同一房间同时有可执行 sell deal 与 ready TransferContract
- **THEN** Agent 必须只执行一个 terminal action，并按显式 priority/market policy 记录另一个动作的等待原因

#### Scenario: Market 买入也必须通过本房容量检查

- **WHEN** market buy proposal 会向本房 terminal 写入资源
- **THEN** Agent 必须先用 P0 物理 headroom 与同 tick projection 限制买入量，且不得因 market action 绕过容量安全线

#### Scenario: Cooldown 房间不重复调用 side effect

- **WHEN** terminal.cooldown 大于零
- **THEN** Agent 不得调用 send/deal，并必须把下一可执行 tick 传播到合同或 market proposal

### Requirement: Staging window 必须绑定合同且复用 P0 安全规则

source Agent 只能（MUST）为持有有效 CapacityLease、位于当前或下一 send window 且通过 source/fee 重验的合同创建 `StageWork(contractId, resource, amount)`。amount 必须受合同 remaining、lease amount、transfer batch、source 安全库存和 terminal headroom 上限约束；同房同资源同轮不得（MUST NOT）同时生成冲突 feed/offload。

#### Scenario: 无 lease 不生成 StageWork

- **WHEN** 合同路线和库存有效，但 receiver 尚未授予 lease
- **THEN** Agent 不得为该合同创建或保留 StageWork

#### Scenario: 下一窗口允许预装一个批次

- **WHEN** 合同持有覆盖下一 terminal 窗口的有效 lease，且当前 cooldown 结束后它是本房最高顺位合同
- **THEN** Agent 可以预装不超过 lease/batch 的资源，但不得为更后面的合同耗尽 P0 terminal headroom

#### Scenario: Feed 与恢复性 offload 不冲突

- **WHEN** 某资源的合同失去 lease 且房间需要 P0 headroom recovery
- **THEN** Agent 必须撤销该合同的 StageWork，并允许 P0 offload；同轮不得重新 feed 相同资源

### Requirement: Carrier claim 必须持久、定量且可回收

每个 StageWork claim 必须（MUST）持久化 contractId、workId、creepName、claimedAmount、phase、claimedAt 和 leaseUntil。全部 active claims 的 amount 不得超过该工作待 staging 数量；claim 必须在成功交付、显式释放、creep 死亡或 lease 过期时回收。进程内 CarrierTaskBoard 不得成为唯一状态源。

#### Scenario: 两个 carrier 不会重复认领同一数量

- **WHEN** StageWork 只剩 1,000 待搬，两个 carrier 在同一 tick 请求任务
- **THEN** 两个 active claim 的合计不得超过 1,000，后一个 carrier 只能取得剩余量或无任务

#### Scenario: Global reset 后恢复 carrying claim

- **WHEN** carrier 已从 storage 取出资源但尚未交付 terminal 时发生 global reset
- **THEN** Agent 必须根据持久 claim、creep store 和建筑库存恢复 `carrying` 状态，不得重新分配相同 amount

#### Scenario: Creep 死亡后释放 claim

- **WHEN** claim 对应 creep 已不存在或 leaseUntil 已过期
- **THEN** Agent 必须释放未完成 claim，使剩余工作可重新分配，并记录可恢复资源位置或损失

#### Scenario: 已持货但合同失效时不误投

- **WHEN** carrier 正携带合同资源，而合同被 supersede 或 receiver lease 失效
- **THEN** Agent 必须将资源明确重分配给同资源已获 admission 的合同，或安全退回 storage/terminal；不得进入 generic energy delivery 或错误目标

### Requirement: Terminal staging 采用 aggregate 分配而非逐单位所有权

系统必须（MUST）把 terminal 内同资源视为可替代 aggregate，并保证所有 admitted contracts 的 staged allocation 总和不超过实际安全可用 terminal 库存。系统不得（MUST NOT）假设能够物理标记某一单位资源属于特定合同；合同取消或 supersede 时必须显式释放/重分配 aggregate allocation。

#### Scenario: Terminal 已有资源直接满足 staging

- **WHEN** terminal 已有 3,000 安全可用 X，当前合同只需 staging 2,000
- **THEN** Agent 可以分配 2,000 staged allocation 而无需 carrier 搬运，剩余 1,000 仍可供其他安全工作使用

#### Scenario: 多合同 allocation 不超过物理库存

- **WHEN** terminal 安全可用 H 为 5,000，两个 admitted 合同分别需要 4,000
- **THEN** staged allocation 总和不得超过 5,000，且只有当前/下一窗口合同可以占用分配

### Requirement: Send 必须经过最终重验并原子记录结果

调用 `terminal.send` 前，source Agent 必须（MUST）重验 contract active state、lease/epoch、receiver P0 headroom、source commitment/实际库存、staged amount、fee 和 cooldown。返回 OK 时必须在同一 tick 更新 delivered/remaining、staged allocation、lease consumption、source/receiver projection 和 action 观测；返回非 OK 时不得改变 delivered/remaining。

#### Scenario: 最终重验失败不发送

- **WHEN** staging 完成后 source 安全库存被生产消耗，或 receiver lease 已失效
- **THEN** Agent 必须设置对应 blocker 并跳过 send，合同数量守恒保持不变

#### Scenario: 成功发送只记一次进度

- **WHEN** send 返回 OK，随后同 tick runtime 投影与下一 tick reconciliation 都运行
- **THEN** delivered 只能增加一次，lease 只能消费一次，且重启后不得重复发送同一批次

#### Scenario: 短暂错误采用退避

- **WHEN** send 返回可恢复错误
- **THEN** Agent 必须增加 attempt、设置机器可读 blocker 与有界 nextAttemptAt，且在该 tick 前不得重复调用 send

### Requirement: Agent 调度必须条件式公平且不受固定全局发送瓶颈支配

全局 send/work budget 只能（MUST）作为 CPU 与安全护栏；可用 source 的选择必须使用持久轮换和显式 priority。每个 terminal 的 cooldown 是主要吞吐限制；当预算持续可用且更高优先级流量有限时，持续 ready 的 source/contract 必须最终执行。

#### Scenario: 多 source 可并行使用各自 terminal

- **WHEN** 三个不同 source terminal 均 cooldown=0、各自合同安全可执行，且 CPU budget 足够
- **THEN** 系统可以在同 tick 分别执行三个 terminal action，而不得因固定全局 1 个发送槽只选择第一个房间

#### Scenario: 预算不足时后续轮次补偿

- **WHEN** 本轮预算只处理三个 ready source 中的一个
- **THEN** runtime 必须记录另外两个 budget skip，下一轮 continuation 必须优先从未处理 source 继续

### Requirement: Agent 必须从 Memory 恢复并提供有界观测

RoomLogisticsAgent 必须（MUST）在 global reset、board refresh 或代码重载后仅凭 Memory、Game 建筑和 creep store 恢复合同窗口、lease、aggregate staging 与 claims。runtime/monitor 必须报告每房 ready tick、selected action、admitted/staged/claimed/orphan amount、stage/send throughput、claim expiry、失败/退避、双 owner/overclaim 违规、索引扫描和模块 CPU，并兼容旧快照。

#### Scenario: Reset 后不依赖 global board

- **WHEN** `global.__carrierTaskBoard` 丢失但 Memory 中存在 active contract、lease 和 carrying claim
- **THEN** Agent 必须重建可执行本地工作，且不得丢单、重复 claim 或重复 send

#### Scenario: 固定 fixture 的 CPU 回归受控

- **WHEN** 在相同 live-like fixture 上比较 P0 与合同模式的 ResourceControl p95 CPU
- **THEN** 合同模式目标不得超过 P0 10%，且测试/观测必须证明每房 Agent 没有各自全表扫描全部 intents/contracts

#### Scenario: 旧 monitor 快照保持兼容

- **WHEN** monitor 读取不含 Agent/claim 字段的 legacy 或 P0 runtime
- **THEN** monitor 必须继续输出既有物流数据，不得抛错或伪造 claim 已恢复
