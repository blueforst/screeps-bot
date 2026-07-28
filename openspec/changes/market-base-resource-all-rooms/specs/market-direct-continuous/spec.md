## MODIFIED Requirements

### Requirement: Continuous 必须使用 Canonical 多资源执行表
系统 MUST 先按 current permit 自带的 schema/hash revision 分派不可变 evaluator，禁止把历史 v2 payload 用 v3 默认字段重新规范化。

当 current permit 为 v2 时，canonical execution table 仍精确冻结 X/E6N59、H/E3N59、Z/E7N57 三个 entry，以及 v2 的 native、非 Hub、非 capacity emergency、单房间、floor/reserve/quota 合同；O/U/L/K 和其他房间不得由 v2 自动授权。

当 current permit 为 v3 时，旧 v2 resource table 只作为不可变历史 codec，不再定义 active scope。active scope MUST 由 `market-base-resource-all-rooms` 的七资源 ResourcePolicy、动态 RoomAdmissionPolicy、DerivedLaneLifecycle 与 exact SignedLaneGrant 派生；具备完整保护证据的非 native、Hub 或 capacity emergency lane MAY 参与，但不得获得更低 floor/reserve、更大 batch/quota 或排序加成。两个版本均固定单笔 1,000、account-global cooldown 1,000、全局单 pending、terminal 实存与交易能量修正后的净底价。

#### Scenario: V2 首批执行表
- **WHEN** current permit schema 为 v2
- **THEN** 表必须精确包含 X/E6N59 reviewed exception、原生 H/E3N59、原生 Z/E7N57 三个 entry；X/H/Z 的 hard/economic floor、buffer、notional、resource cap 与 v2 fingerprint 必须保持原值，O/U/L/K、其他房间、Hub 和 emergency 不得生成 v2 tuple

#### Scenario: V3 接管 Active Scope
- **WHEN** 首个合法 v3 successor 已签收
- **THEN** legacy X grant 必须已 suspended，active derived universe 只能由七资源和 current admission roster 形成；所有新 signed grant 首先为 shadow+suspended，v2 表不得再扩大、过滤或解释 v3 scope

#### Scenario: 跨版本配置扩围
- **WHEN** bundle 支持 v3 但 current permit 仍为 v2，或 raw config 增加七资源/动态房间而没有合法 v3 successor
- **THEN** v2 evaluator 只能继续其精确旧授权，v3 lifecycle 只能只读 Shadow；不得把新资源、房间或 Hub/emergency 条件隐式写入 v2 grant

#### Scenario: V3 非 Native、Hub 或 Emergency
- **WHEN** v3 lane 非本房原生矿、属于 Hub 或 capacity emergency，但具备 exact SignedLaneGrant、terminal 实存、current production protection、effective post-deal Energy reserve、quota 和净底价证据
- **THEN** v3 Direct MAY 将其作为普通安全 tuple；room class、native 属性和容量状态不得降低经济/事故门槛或改变价格排序

#### Scenario: 任一版本的共享事故上限
- **WHEN** v2 或 v3 entry/lane 参与规划
- **THEN** planned amount 必须恰为 1,000、全局只能有一个 pending、confirmed cooldown 必须为 account-global 1,000 tick，且所有历史 receipt/unmatched exposure 连续计入相应 quota

### Requirement: Receipt Chain 必须证明窗口 Coverage
系统 MUST 为所有终态 attempt 保存单调 sequence 与 `prevHash/eventHash/headHash`，并保存 coverageStartTick、prune checkpoint、finalized high-water、global/per-resource/room/lane lifetime count/amount。所有 receipt MUST 有 `resolvedAt/retentionTick`；confirmed 还必须有 transactionTime/actualAmount 且 retentionTick=transactionTime，failed/not_filled 不得伪造 transactionTime 且 retentionTick=首次 resolvedAt。每个 entry/lane 的 confirmed canary MUST 形成单调高水位；裁剪后 checkpoint 必须以绑定 pruned seq/head 与完整 canary map 的 canonical commitment 继续证明它。

rolling amount/cooldown 只读取 confirmed transactionTime/actualAmount。full receipt ring 固定为 512；裁剪统一读取 retentionTick，且只有 retentionTick 严格小于 `tick-29,999` 并已被 checkpoint 连续吸收 seq/hash/lifetime/canary commitment 后才可裁剪。prepare 新 pending 前 MUST 为 outcome 和 receipt 各预留一个终态槽；active pending 的恢复与 WAL 终态提交优先使用该槽，不能被容量门禁卡住。

#### Scenario: 窗口左边界
- **WHEN** transactionTime 等于 `tick-29,999`
- **THEN** receipt 仍在窗口并计入额度

#### Scenario: 严格移出窗口
- **WHEN** 任一 receipt 的 retentionTick 小于 `tick-29,999`
- **THEN** receipt 只有在 checkpoint 连续吸收后才可从 ring 裁剪；confirmed quota 是否移出窗口仍只由 transactionTime 决定

#### Scenario: Failed Receipt 长期裁剪
- **WHEN** failed/not_filled 没有 transactionTime 且其首次 resolvedAt 已小于 `tick-29,999`
- **THEN** retentionTick 必须等于该首次 resolvedAt，并允许在连续 checkpoint 吸收后裁剪，不得制造伪交易时间

#### Scenario: 第 51/65/201 笔
- **WHEN** audit outcome 或 receipt ring 发生多次有界裁剪
- **THEN** lifetime、rolling、high-water 和 hash head 必须保持准确，不得退回保留数组长度

#### Scenario: Canary Receipt 裁剪后删除高水位
- **WHEN** 某 entry/lane 的 confirmed canary receipt 已进入 checkpoint，随后 top-level 与 checkpoint 的 canary entry 同时丢失并回拨 lifecycle
- **THEN** confirmed-canary checkpoint commitment 必须失配并持久闭锁；不得恢复 fresh canary 或执行第二笔

#### Scenario: Ring 满时已有 Pending
- **WHEN** active pending 需要写 outcome/receipt，而 ring 已接近 50/512 上限
- **THEN** preflight 必须使用 prepare 时预留的终态槽完成 WAL；容量门禁只能拒绝下一笔新 pending，不能阻止当前 exposure 对账
