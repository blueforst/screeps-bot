## MODIFIED Requirements

### Requirement: 当 tick 新鲜的生产保护账本
系统 MUST 在最终出售规划前主动收集当前 Factory、活动及暂停 Synthesis、Synthesis 配置 target/donor、Hub、Boost/War、关键出站、carrier/in-flight、resource reservation 和市场暴露。每个候选账本 MUST 带当前 tick revision、观测时间、TTL 和稳定贡献 ID。基础矿 lane 还 MUST 读取 `mineralFloor`、`mineralExportStart`、Factory resource floor 与 permit lane reserve；缺少任一适用来源时该 lane fail-closed。

#### Scenario: 后置 Producer 未发布也能保护
- **WHEN** War 或 HomeDefense 在主循环中晚于 ResourceControl 执行
- **THEN** collector 仍从当前配置、Game/Memory 事实和未过期承诺计算其资源保护量

#### Scenario: 非 ResourceControl 刷新 Tick 仍复核已有暴露
- **WHEN** 本 tick 不执行完整 ResourceControl 规划，但存在 managed 或 pending exposure
- **THEN** 系统仍生成 current-tick 轻量保护账本并复核；无法完整解释时立即进入安全撤单/排空，确认前继续保留 exposure

#### Scenario: 保护来源过期
- **WHEN** 候选资源的任一必要保护来源缺失、过期或 revision 不是当前 tick
- **THEN** 该房间资源本轮完全禁止出售，并记录 `protection_stale`

#### Scenario: Forecast Buffer 缺失或不足
- **WHEN** allowlist entry 没有有限正数的 lane/forecast buffer，或该值小于固定 1,000 计划批次
- **THEN** 配置或该 lane 必须 fail-closed，不得创建 Maker order 或 Direct pending

#### Scenario: 旧承诺无法去重
- **WHEN** 旧任务没有稳定合同 ID
- **THEN** 系统把它作为独立承诺保守计入，不得因无法去重而少保护

#### Scenario: Hub 分配余量不是生产需求
- **WHEN** distributed synthesis 完成分配后，`allocationLedger.roomCommitments` 表示已扣除本地 reserve、待收发和实际分配的剩余可用库存
- **THEN** collector 不得把该余量计入生产需求；只保护实际 dispatch、route、Hub 目标和显式 surplus 限制

#### Scenario: 同一合成计划的重复视图去重
- **WHEN** 同房同产品的生产计划同时出现在 Synthesis active/paused runtime、配置 target 与 Hub dispatch
- **THEN** collector 使用同一稳定计划键并按最大金额只计一次；同房不同产品的计划仍分别保护

#### Scenario: Donor Binding 尚未生成
- **WHEN** 活动或暂停 Synthesis target 仍有组件缺口，但 transfer/reservation/donor binding 尚未建立
- **THEN** collector 必须从 reaction 组件和 target gap 生成保守 consumptive commitment；候选资源/房间集合完整但最终 donor 未定时，该资源所有候选 donor lanes 禁售，其他资源仅在各自事实及全局 coverage 完整时可继续；候选集合 stale、不完整、损坏或无法界定受影响资源时全局零写

#### Scenario: Mineral 与 Factory 底仓
- **WHEN** room 同时配置 mineralFloor、mineralExportStart、Factory resource floor 与 permit lane reserve
- **THEN** 本地底仓必须取四者最大值，不得只读取较低的 mineralFloor

### Requirement: 可售量不得侵占生产与关键调拨
系统 SHALL 先计算 `localReserve=max(mineralFloor,mineralExportStart,factoryResourceFloor,laneReserve)`，再以 `protected=max(localReserve,absoluteTarget)+consumptiveDemand+criticalOutgoing+carrierInFlight+boostWar+hubCommitments+otherMarketExposure` 计算保护量，并以总库存减保护量得到可售量。绝对库存目标与生产其他产品会消耗的原料不得互相取 max；关键任务即使暂时 blocked，在取消或过期前仍 MUST 受保护。

permit `laneReserve` 就是该 lane 唯一的 forecast buffer，并且只在 `localReserve` 中计一次；任何 runtime/config 中同名或同稳定计划 ID 的 forecast 视图只能用于验证/取最大值，不得再作为额外加项叠加到 `protected`。

#### Scenario: Blocked 生产任务仍受保护
- **WHEN** 生产或手工出站任务因 receiver capacity、source、cooldown 或交易能量暂时 blocked
- **THEN** 其剩余量继续从可售量扣除

#### Scenario: 仅可丢弃自动任务过期后释放
- **WHEN** 自动 capacity-relief 任务被显式标记 disposable 且满足 TTL 失效条件
- **THEN** 系统才可以从市场保护量中释放其承诺

#### Scenario: 生产目标以下禁止出售
- **WHEN** Factory 成品或组件、活动/暂停合成原料、Hub 链路或 Boost/War 需求尚未满足
- **THEN** 系统不得出售保护范围内的库存

#### Scenario: 目标与消耗需求同时存在
- **WHEN** 同一 room/resource 既有本资源绝对库存目标，又会被另一生产计划消耗
- **THEN** 系统先以本地底仓和绝对目标取最大，再额外加上消耗需求；不得用单一 max 吞掉其中一项

#### Scenario: 同一市场 Pending 暴露
- **WHEN** Direct pending 已为某 room/resource 预留 1,000
- **THEN** protection 与 quota 只各计一次该 exposure，不得把同 request 的计划量重复扣减或遗漏

### Requirement: 动态 Canary 选择
Maker 与 legacy Direct MUST 保持各自 capability 的隔离 canary；legacy Direct 只保留既有单 X canary 历史且写路径退役。Continuous Direct MUST 不再从所有房间/资源动态扩围，而只在 current permit 的 explicit lanes 内为每个 entry 独立执行 Shadow/canary lifecycle。Maker、legacy Direct 和 Continuous 的 lock、revision、fingerprint、permit 与证据必须隔离。

#### Scenario: 中央 Hub 满仓且正在生产
- **WHEN** Hub 正在 loading、synthesizing 或 unloading，或处于 capacity emergency
- **THEN** 它不得被自动选择为 Maker/legacy Direct canary，也不得成为 Continuous lane

#### Scenario: 没有合格候选
- **WHEN** 所有 explicit lanes 均被生产、容量、terminal、能量、价格、quota 或账本条件拒绝
- **THEN** 系统保持等待并投影逐 lane 拒绝原因，不得放宽底线或加入新 lane

#### Scenario: Maker Canary 首次锁定后不自动扩围
- **WHEN** Maker 首次动态选择一个合格 room/resource
- **THEN** 持久锁定该唯一对象、强制有效 maxManagedOrders 为 1 且禁止 hybrid；该 lock 不授权 Direct

#### Scenario: 被锁 Maker Canary 暂时不合格
- **WHEN** 已锁定的 Maker room/resource 在后续 tick 不满足前置条件
- **THEN** 无暴露时系统等待；存在 managed/pending exposure 时立即安全 cancel/drain 并确认归零，同时保留原 Maker lock，不得自动改选第二候选

#### Scenario: Legacy Direct 历史迁移
- **WHEN** 新 capability 读取已确认的 E6N59/X legacy canary
- **THEN** 只能把精确 outcome digest 作为 X entry 的 permit seed；Maker lock、旧 Shadow count 或动态其他候选均不得继承

#### Scenario: Continuous 新 Entry
- **WHEN** H 或 Z entry 首次出现在 proposed execution table
- **THEN** 系统只在该 entry 的 allowed rooms 内累计独立 100 周期 Shadow，并不得因其他 entry 已 continuous 而跳过 canary/review

#### Scenario: 新房间出现更高净价
- **WHEN** 未在 permit allowed rooms 中的房间出现更高单位净价
- **THEN** 系统不得自动选择；必须通过新 evidence 与 successor permit 才能加入
