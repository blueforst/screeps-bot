## ADDED Requirements

### Requirement: V3 必须只授权七种基础矿物
系统 MUST 以正向白名单精确限定 `H/O/U/L/K/Z/X`，并在 permit 中冻结 resource catalog revision、排序后的 allowlist 与 `energy=fuel_only_never_sell`。原始配置出现 Energy、G、Deposit、Power、ops、Pixel、反应产物、T1/T2/T3、Boost、Factory/Commodity、seasonal 或未知资源时 MUST 整体 fail-closed，不得静默过滤后继续。

#### Scenario: 七种基础矿物完整通过
- **WHEN** raw config 的资源与 threshold key 精确覆盖 `H/O/U/L/K/Z/X` 且没有额外项
- **THEN** normalizer 必须生成稳定排序的 canonical catalog 和 fingerprint

#### Scenario: 混入禁止资源
- **WHEN** raw config 在合法七种资源之外混入 Energy、G、OH、XUH2O、Power、ops、silicon、battery 或未知字符串
- **THEN** 整份 v3 配置必须无效、零 candidate、零 staging、零 pending、零市场写

#### Scenario: 高价禁止资源
- **WHEN** 禁止资源出现远高于所有基础矿物的 BUY order
- **THEN** 它不得进入历史缓存、book、lane、tuple、permit grant、receipt 或 opportunity reserve

### Requirement: V3 底价与 Ratchet 必须有签名 Bootstrap
系统 MUST 排除官方 rolling stats 的 2026-07-14 左端 partial 和 2026-07-28 当前日 partial，只使用 checked-in 的 2026-07-15 至 2026-07-27 共 91 条稳定官方日数据、冻结算法 fingerprint 和 canonical JSON SHA 证明七资源初始底价。首个 v3 successor MUST 显式签入 `historyDate=2026-07-27` 及 H/O/U/L/K/Z/X 的初始 observed/ratchet floor `433.765/128.524/45.939/168.132/100.914/41.623/559.430`；运行时不得隐式初始化或降低静态 hard/economic floor。

#### Scenario: 合法 Bootstrap
- **WHEN** 首个 v3 successor 的日期、七资源数值、算法 blob 与 checked-in evidence digest 全部精确匹配
- **THEN** ratchet high-water 可以从该记录建立，effective floor 仍取 hard/economic/history/ratchet 最大值

#### Scenario: Canonical Evidence 可独立复算
- **WHEN** verifier 读取 checked-in canonical JSON 的完整 UTF-8/LF 字节
- **THEN** SHA-256 必须为 `b290a5972cc9bab04b09351dc42c057ec2c85d1555eedead2e72b19092b7b232`，且对 91 条日数据重跑冻结算法必须精确得到 accepted/rejected、referencePrice、trusted95 和 policy；任一不匹配时 build/permit 均零写

#### Scenario: Rolling 两端 Partial
- **WHEN** 官方 API 的最老返回日或当前日仍随 rolling window/当日交易变化
- **THEN** verifier 必须排除两端，不能把 7/14 或 7/28 当作完整日签入 bootstrap；静态 economic floor 不得因 O 的新 trusted95 较低而从 145 下调

#### Scenario: 缺失或重写 Bootstrap
- **WHEN** bootstrap 缺资源、缺 digest、日期倒退、数值变化、重复初始化或 ratchet/checkpoint 回拨
- **THEN** v3 必须全局零写并持久记录 blocker，不得从当前较低市场数据自动补值

### Requirement: Permit 必须冻结自动房间准入和完整 Lane 上界
系统 MUST 使用不可变 ResourcePolicy、RoomAdmissionPolicy、SellerRoomState、DerivedLaneLifecycle 与 SignedLaneGrant 派生完整 resource-room lane 集。permit MUST 冻结 `owned-visible-terminal-v1`、account identity、controller.my/visibility/owned terminal 条件、`autoAdmit=true`、`maxRooms=16`、`maxKnownRoomNames=32` 与 active `maxLanes=112`；稳定 shared fingerprint 只包含 catalog/admission/derivation/engine revision 和上界，current roster/derived lane-set 只进入当 tick 两次 full read、pending 与 monitor。

#### Scenario: 首个 V3 Runtime Roster
- **WHEN** 首个 v3 successor 被规范化且 live observation 与 2026-07-28 快照一致
- **THEN** current roster 必须精确派生为 E1N57、E3N59、E4N58、E5N59、E6N59、E7N57、E7N58、W1N57，E4N58 为 Hub、其余为 normal，并生成 56 条 shadow+suspended lane；若部署时已漂移，则必须按实际 observation 派生并要求该实际 fingerprint 被复审，不得硬编码、截断或伪造 56 条

#### Scenario: 新房间自动准入
- **WHEN** Game 新出现可见、controller.my、owner identity 匹配且拥有 terminal 的房间，且未超过上界
- **THEN** 系统必须自动创建新的 room instance 和七条只读 DerivedLaneLifecycle，状态为 shadow+suspended；无需仅为加入 roster 签 successor，但不得自动创建可写 SignedLaneGrant

#### Scenario: Room Instance 变化
- **WHEN** 房间经历 admitted→not-admitted→admitted、同账户同 terminal 重新占领、terminal 重建、owner 改变或 normal→Hub→normal
- **THEN** 系统必须先递增不可回退 roomIncarnationHighWater，再用 incarnation 与 previousInstanceId 生成从未使用的新 roomInstanceId；旧 lane 变为 suspended tombstone，新 lane 从 Shadow 重新开始

#### Scenario: Room Incarnation 回拨
- **WHEN** current room state、per-room incarnation high-water、previous-instance chain 或 tombstone checkpoint 缺失、不一致或回拨
- **THEN** 系统必须全局零写，不得把属性重新变回 A 的实例解释为历史 A grant

#### Scenario: Roster 或 Lane Set 不一致
- **WHEN** 房间重复、超上界，或第二次读取的 current roster/派生 lane 集与第一次不一致
- **THEN** 本 tick 必须全局零写并记录 scope blocker

#### Scenario: 非自有或无 Terminal
- **WHEN** permit 中某 writable room 不再自有、不可见或没有 terminal
- **THEN** 该 writable scope 不完整并全局零写；不得从剩余房间降级成交

### Requirement: 新 Policy 和 Lane 必须从 Suspended Shadow 开始
新增资源、房间、lane，或 resource/room/shared fingerprint 变化时 MUST 使用新不可变 ID 并进入 `shadow+suspended`。自动派生 lifecycle 不是授权；上一份 signed permit 是中央校验的唯一 prior。旧 grant MUST 保留为 suspended tombstone，旧 X/E6N59 outcome、其他房间或其他资源的证据不得继承。

#### Scenario: 新 Grant 中央校验
- **WHEN** successor 含 prior permit 不存在的 grant
- **THEN** append 层必须要求其 stage=shadow 且 newDealGrant=suspended；即使 proposal 层传入 canary/continuous 也必须拒绝

#### Scenario: 自动新 Lane 晋级
- **WHEN** 未来新 lane 已有 100 个完整 Derived Shadow observation，但上一份 signed permit 尚无该 grant
- **THEN** 第一份 successor 只能登记 suspended grant，至少下一份连续 successor 在重验该 lifecycle digest 后才可授予 one-shot Canary；runtime state 不得充当 prior permit

#### Scenario: 原地扩大旧 Policy
- **WHEN** successor 沿用旧 policyId 但新增房间、降低 floor/reserve、改变 Hub/native 条件或放宽 quota
- **THEN** permit 必须拒绝并保持 current tip 不变

#### Scenario: 100 个完整 Shadow 观测
- **WHEN** 同一最终 policy/room-instance/admission/shared fingerprint 下某 lane 完成 100 个递增 tick 的完整观测
- **THEN** 它可以进入 qualified；其他房间 roster 变化不得清零该 lane，未采样 tick 不清零，同 tick 重入不重复计数，显式不完整或本 lane fingerprint 变化必须清零

#### Scenario: One-shot Canary 和复审
- **WHEN** qualified lane 获得 canary grant
- **THEN** 它最多提交一笔固定 1,000；confirmed 后自动 review_paused，只有 successor 绑定该 receipt 的完整审查 digest 才能进入 continuous

#### Scenario: 同资源切换 Canary
- **WHEN** v3 lane 将获得某资源的 canary grant而 legacy/current 仍有同资源写 grant
- **THEN** successor 必须先 suspend 旧 grant，不得让两个同资源 policy 同时可写

### Requirement: V2 到 V3 必须无损迁移
系统 MUST 继续按 frozen v2 codec 验证 v2 permit、pending、outcome、receipt，并以当前 v2 opaque permit/head/ledger head 作为 v3 successor 前驱。历史 v2 event 没有 record-level version：仅当 outer ledger/current permit 为 v2，或该 seq 不高于首个 v3 successor 认证的 `v2EventCutoverCheckpoint`，且 raw 字段集合精确匹配 v2 codec 时，缺 discriminator 的 record 才可分类为 `legacy-v2-implicit` 并按原始 v2 payload/domain 验证。validator 禁止补 version/default 后验 hash。cutover 后所有新 event MUST 显式带 schema/hash revision。迁移不得创建新 genesis、重哈希旧事件、删除历史或重置 attempt、quota、lifetime、processed key 和 high-water。current tip、epoch/head high-water、cutover/ledger checkpoint 与 chain length MUST 原子一致。

#### Scenario: 兼容 Bundle 上线
- **WHEN** 新 bundle 首次读取当前 epoch 1 v2 state
- **THEN** current head 仍为 v2 时，旧 X/E6N59 只能由冻结 v2 evaluator 继续其精确既有授权，新增 v3 lifecycle 保持只读；v2 evaluator 不得读取 v3 shared/roster/policy

#### Scenario: 首个 V3 Successor
- **WHEN** WAL 已静止且首个 v3 successor 精确引用 current v2 opaque tip
- **THEN** 它必须认证 lastV2AttemptSeq/OutcomeSeq、v2 receipt head 与 ledger checkpoint 的 event cutoff，在同一提交中 suspend legacy X，并把 current v3 grants 全部登记为 shadow+suspended；不得修改旧 event 或建立 legacy bridge

#### Scenario: 无 Discriminator 的历史 V2 Event
- **WHEN** raw pending/outcome/receipt 没有 record-level version，但字段集合精确为 frozen v2、hash 按原始 v2 bytes 有效且 seq 不高于 authenticated cutoff
- **THEN** validator 必须只把它分类为 legacy-v2-implicit；不得把 schemaVersion 或 v3 默认字段写回 record 后再计算

#### Scenario: Cutover 后伪装 V2
- **WHEN** seq 高于 cutoff 的 event 缺 discriminator、旧 event 含未知/补写 version 字段，或 outer/cutover high-water 任一不一致
- **THEN** 系统必须持久 block，不能把新 event 按 legacy v2 domain 接受

#### Scenario: WAL 非静止时签收
- **WHEN** pending、quarantine、gap 或 unmatched reservation 任一非零
- **THEN** v3 successor 必须拒绝，旧 pending 继续按其冻结的历史 permit 对账

#### Scenario: Mixed Chain 损坏
- **WHEN** 旧 payload 任一 bit 改变、旧 head 被重算、event cutoff 改变、epoch 不是 highWater+1、state/checkpoint/high-water 任一单边回拨或 mixed chain 出现 gap
- **THEN** 系统必须进入持久 conflict blocker，current tip 不得移动；相同 epoch/content/ID 重签只能幂等 no-op

#### Scenario: 迁移后额度连续
- **WHEN** 同一 resource/room 在 v2 和 v3 policyId 下均有 receipt
- **THEN** rolling/lifetime 必须按真实 resource+sellerRoom 聚合，不得因 policyId 变化获得新额度

#### Scenario: 旧 Pending 遇到新 Permit
- **WHEN** v2 pending 尚未终态而 current code 已支持 v3
- **THEN** preflight 必须使用 pending 冻结的 v2 permit/policy/room/resource 解释交易，不得用新 current permit 重解释或释放 exposure

#### Scenario: Pending 存续时动态 Scope 改变
- **WHEN** historical pending 存续期间新房加入、房间离开、ownership 丢失或 terminal 重建
- **THEN** recovery 必须继续按 pending 冻结的 historical admission/roster/lane/permit 对账；current scope 变化只能阻止新 deal，historical permit 缺失或损坏时必须保留 exposure 并持久 block

### Requirement: 多房间 Direct 必须选择全局最高安全单位净价
系统 MUST 对全部 writable lane 和 BUY order 生成固定 1,000 tuple，并按交易能量修正后的单位净价、总净额、gross price 降序，再按 resource/room/orderId 升序稳定排序。订单量、库存量、容量压力与配置顺序不得排在价格之前。

#### Scenario: 同资源跨房间
- **WHEN** 同一 BUY order 可由两个 seller room 安全成交且近端房间单位净价更高
- **THEN** 系统必须选择近端 lane，不得固定使用 allowed rooms 的第一项

#### Scenario: 小高价单与大低价单
- **WHEN** 两张订单都至少可成交 1,000，较小订单的动作后单位净价更高
- **THEN** 系统必须吃较高单位净价订单，剩余量不得提供优先级

#### Scenario: 多资源同时安全
- **WHEN** 不同基础矿物的多个 lane 同时通过 floor、protection、terminal 和 quota
- **THEN** 系统必须在所有已准入 tuple 中全局排序，不按资源或房间遍历顺序选单

#### Scenario: Planned 与 Worst Unit 双门槛
- **WHEN** 1,000 计划净价安全但 amount=1 的最坏单位净价低于有效 floor，或交易能量超过 1,000
- **THEN** tuple 必须拒绝，不得缩量或改用 gross price

#### Scenario: 写前最佳 Tuple 改变
- **WHEN** 第二次 full read 中非选中 lane 变为更优，或任一 roster/lane/book/order/terminal/protection/energy/quota/permit/head/arbiter/production fact 改变
- **THEN** 本 tick必须零写，不得换次优单或沿用旧 snapshot

#### Scenario: BUY Book 重复与冲突
- **WHEN** 同一次资源 book 出现同 ID 同 canonical 内容、同 ID 不同内容、跨资源复用 ID或 resource/type 不匹配
- **THEN** 同 ID 同内容只能去重计一次；其余情况使对应 book 不完整，存在该资源 writable lane 时本 tick 全局零写

#### Scenario: 自有 BUY Order 排除
- **WHEN** book 中存在可由 current account identity 明确识别的自有 BUY order
- **THEN** 该订单必须在 tuple 前排除，但其存在本身不使外部 book 不完整；若 account/order owner 事实缺失而无法可靠排除自有订单，book 才必须标记不完整

#### Scenario: 第二读不得复用缓存对象
- **WHEN** 第一读已经取得可信 book 并准备进入写前复核
- **THEN** 第二读必须重新调用市场 API、构造独立 snapshot 和 transaction-cost memo；即使缓存 age 合法也不得复用第一读对象

### Requirement: Lane 完整性必须按写权限分级 Fail-closed
任一 writable lane 的 terminal、book、protection 或 lifecycle 不完整 MUST 使本 tick 全局零写；suspended Shadow lane 的已知局部不完整 MAY 只重置该 lane。shared 或未知作用域证据不完整 MUST 全局零写。

#### Scenario: Writable Lane 局部缺失
- **WHEN** 某可写 lane 缺 protection、terminal 或完整 book，而其他 lane 有安全高价机会
- **THEN** 系统仍必须全局零写，不能跳过缺失 lane

#### Scenario: Suspended Shadow 局部缺失
- **WHEN** 只有某 suspended Shadow lane 的 scoped terminal/protection 不完整且 shared facts 完整
- **THEN** 只清零该 lane Shadow；其他 writable scope 可以继续完整规划

#### Scenario: 未知生产范围
- **WHEN** Hub、Factory、Synthesis、Boost/War、transfer 或 reservation collector 无法把缺失事实精确界定到 lane
- **THEN** 全部 Shadow 不推进且全局零写

### Requirement: Hub 和容量紧急房间只能出售被证明的基础矿物余量
capacity pressure/emergency MUST NOT 降低 floor、reserve、batch 或 quota。Hub lane 只有在一个全量、原子替换、所有子字段绑定相同 planRevision/configFingerprint 的 committed Hub protection snapshot 中，allocation residual、显式 base-mineral surplus 和全部生产保护均完整时才能形成 sellable amount。adapter 不得从 legacy Hub runtime 的分散字段拼接或重认证保护。

#### Scenario: Emergency Terminal 已有安全库存
- **WHEN** emergency 房间 terminal 已有至少 1,000 基础矿物、成交能量充分、保护后 surplus 充分且 lane 已获写 grant
- **THEN** Direct MAY 按正常净价和额度出售以释放空间；成交后 Energy 仍必须满足 current effective post-deal reserve，capacity state 不得提供价格或排序加成

#### Scenario: Emergency 需要额外搬运
- **WHEN** emergency 房间基础矿物只在 storage，terminal 实存不足
- **THEN** 本变更不得为市场创建矿物 staging，必须等待现有物流/空间恢复

#### Scenario: Hub Committed Residual
- **WHEN** E4N58 的 current committed allocation ledger 给出该基础矿物 residual available supply
- **THEN** Hub sellable 必须不超过 residual、terminal 实存、lane reserve 和其他保护扣减后的最小值

#### Scenario: Hub Snapshot 全量替换
- **WHEN** 新计划从 distributed 转为 fallback/blocked、某资源 residual 缩小或本轮没有某字段
- **THEN** planner 必须在局部以显式空数组/空映射构造完整 next snapshot，并在末尾整包替换；无 current residual 的资源 sellable 必须为零，不得沿用上一 revision

#### Scenario: Hub 提交中途异常
- **WHEN** 构造 synthesis/route/allocation/surplus 任一步异常或子字段 revision 不一致
- **THEN** 系统必须发布 invalid empty/unavailable 终态并保持市场 fail-closed，不能把旧 snapshot 局部修改后重新标 valid

#### Scenario: Hub 新 Attempt 早退或 CPU Cut
- **WHEN** cadence/needsPlan 已触发实际规划，但随后 room/structure 校验 early return、throw、CPU cut 或部分写失败
- **THEN** planner 必须已在任何早退前递增 attempt high-water 并使旧 snapshot 不可接受，且在单出口/finally 中以同 revision 发布 blocked/failed invalid empty snapshot；不得遗留 in_progress 或复用旧 fresh residual

#### Scenario: Hub 计划无效
- **WHEN** committed marker 缺失/过期、配置指纹变化、房间不可见、规划异常或事实结构不合法
- **THEN** Hub source 必须全局 fail-closed；不得只删除 `needsPlan` 检查后继续

### Requirement: Seller Terminal 必须安全准备交易能量
ResourceControl MUST 每 tick 发布 current `effectivePostDealEnergyReserve=max(25,000, ordinaryTerminalEnergyTarget + unresolvedEnergySendAmount + unresolvedInternalSendFees + terminalScopedProductionEnergyCommitments)`，各贡献按 stable ID 去重；readiness target 为该 reserve 加 1,000 最大市场手续费。普通 Energy feed 与 readiness MUST 在同一 per-room pass 合并为单一 desired target，再与 staging/offload/claim 仲裁，并且每房每 tick只执行一次包含全部生产与 readiness drafts 的整包 task replacement。Direct 两次 full read 都 MUST 重算并要求 `terminalEnergy-actualTransactionEnergy >= effectivePostDealEnergyReserve`。

#### Scenario: E6 Live 回归
- **WHEN** E6N59 terminal energy=23,653、used=255,102、没有更高生产/发送 reserve、storage energy 足够且计入全部当 tick draft 后 terminal free 仍至少 40,000
- **THEN** 系统必须生成精确 2,347 Energy 的 readiness carrier task

#### Scenario: 补给会侵占安全量
- **WHEN** 合并普通 staging/feed 与 readiness 后 terminal free 低于 40,000、storage energy 低于 floor+生产承诺、room 为 emergency、terminal 无容量或已有冲突 claim
- **THEN** readiness feed 必须拒绝，市场 lane 等待且不得降低 current effective post-deal reserve

#### Scenario: Existing Feed 与 Readiness 合并
- **WHEN** 同房同 tick 已有普通 Energy feed，market readiness 又要求更高目标
- **THEN** 系统必须按 stable task ID 原位提升为 `max(ordinaryTarget, marketTarget)` 的单一 feed，amount 不得相加，最终整包 replace 中原有其他生产 drafts 不得丢失

#### Scenario: Staging 或 Offload 冲突
- **WHEN** combined non-Energy staging 占用 headroom，或 Energy offload/terminal claim 与 readiness 冲突
- **THEN** 系统必须先用统一 draft 集合解析；Energy offload 不得降穿 effective reserve，无法同时满足时 readiness 让位且 Direct 等待，不能用第二次 replace 覆盖 staging/offload

#### Scenario: Draft Replacement 原子性
- **WHEN** per-room final draft 集合构造失败、出现 duplicate ID 或 readiness-only replace 将丢失既有生产 draft
- **THEN** 本 tick 不得提交部分/第二份集合，市场必须零写并保留可恢复状态；每房 producer 的 replacement 调用次数最多一次

#### Scenario: 当前发送或生产承诺高于 25k
- **WHEN** survival、pending Energy send、pending non-Energy send fee 或 terminal-scoped production commitment 使 effective post-deal reserve 高于 25,000
- **THEN** readiness target 必须相应提高，且 normal/pressure/emergency lane 的实际成交均不得把 terminal Energy 降到该 current reserve 以下；emergency 只能等待已有能量满足

#### Scenario: Energy Reserve 两读变化
- **WHEN** 第一读后新增内部发送费或生产 Energy 承诺，使第二读 effective reserve 改变
- **THEN** 本 tick 必须零写，不得沿用第一读的 25,000 基线

#### Scenario: 市场未授权
- **WHEN** market off/emergencyStop 或房间不在 current permit
- **THEN** ResourceControl 不得因本 capability 额外预装 Energy

### Requirement: V3 必须保持单 WAL 和多层 Quota
全部资源与房间 MUST 共享一个 pending、每 tick最多一个市场写和固定 1,000 事故批次。rolling window MUST 同时执行 global 12,000、resource policy cap、room 5,000、lane 3,000；聚合键精确为 global=全部、resource=`resource`、room=`sellerRoom`、lane=`resource+sellerRoom`，不得按可替换 policyId/instance 分桶。系统 MUST 保留 account-global 1,000 tick confirmed cooldown 和 global retry backoff，并连续计入 v2/v3 confirmed actual 与 unmatched planned reservation。

#### Scenario: 多 Lane 同时准备
- **WHEN** 两个或更多 lane 同 tick 都有安全机会
- **THEN** 只能由全局最佳 tuple 创建一个 pending，其他 lane 不得准备第二条 WAL

#### Scenario: 任一层额度不足
- **WHEN** global/resource/room/lane 任一 remaining 小于 1,000
- **THEN** 对应新交易必须等待，不得主动缩量

#### Scenario: 跨版本和部分成交聚合
- **WHEN** v2 receipt、v3 receipt、partial actual 与 unmatched pending 同处窗口
- **THEN** confirmed 只按 actual amount、unmatched 按 planned 1,000 同时计入四层；切换 policyId、room incarnation 或 terminal 不得获得新额度

#### Scenario: Global Cooldown 不得降级为 Lane Cooldown
- **WHEN** 任意房间/资源刚确认一笔 v2 或 v3 receipt，另一 lane 同时有高价机会
- **THEN** 在 account-global 1,000 tick confirmed cooldown 结束前不得创建新 pending；global retry backoff 也不得被切换 lane 绕过

#### Scenario: 七资源机会保留
- **WHEN** 七种资源均有 pre-global-quota safe tuple
- **THEN** admission 必须为尚未满足的每种资源保留 1,000，但最终已准入 tuple 仍严格按单位净价排序

#### Scenario: WAL 提交顺序
- **WHEN** pending 被唯一确认
- **THEN** 必须依次持久化 outcome、receipt/head/checkpoint/lifetime、processed key，最后删除 pending；任一 CPU cut 必须可幂等恢复

### Requirement: 多房间规划的 CPU 与观测必须有界
系统 MUST 每个 resource 每次 full read 最多读取一次 BUY book，并在房间间复用；raw/eligible 上限为 1,000/200，全部 eligible books 合并后的 distinct orderRoom 上限为 128。transaction-cost memo 以 `(amount,sellerRoom,orderRoom)` 去重，因此单次 full read 的合法最坏上限精确为 `2×16×128=4,096`；market planning CPU ceiling 为 25。全部 writable lane MUST 每轮完整扫描且绝不轮转/截断；超限 MUST 在 tuple evaluation 前零写。suspended Shadow MUST 按冻结 catalog resource-major、资源内 opaque laneId 排序构造不跨资源的最多 8-lane cohort；边界以全部 active lane 固定分块后再过滤 Shadow，持久 cursor 必须版本化绑定 `(resource,laneId)` cohort anchor。

#### Scenario: 八房同资源
- **WHEN** 同一资源在八个房间都有 lane
- **THEN** 一次 full read 的 `getAllOrders` 调用仍只能为一次，不能按房间重复

#### Scenario: Budget 超限
- **WHEN** raw orders、eligible orders、distinct orderRoom=129、transaction-cost evaluations、room/lane 上界或 CPU 任一超限
- **THEN** 整个 writable scope 必须零写并记录 bounded blocker，不得用已扫描前缀选单

#### Scenario: Transaction-cost 合法最坏值
- **WHEN** 16 个 seller rooms、128 个 distinct order rooms 和 planned/worst 两种 amount probe 同时存在
- **THEN** unique evaluation 精确为 4,096 并可继续；新增第 129 个 distinct orderRoom 必须在计算前零写

#### Scenario: Shadow 稳定轮转
- **WHEN** roster 稳定且依赖/CPU 完整
- **THEN** 每轮 sampled Shadow 必须只属于一个资源；56/112 条 suspended Shadow lane 必须分别在最多 7/14 个完整 planning cycles 内各采样一次，9 房必须按每资源 `8+1` 在 14 周期覆盖 63 lane；legacy/删除 cursor 必须稳定迁移且不得永久饥饿

#### Scenario: Writable 晋级不重排 Shadow Cohort
- **WHEN** 某 cohort 的 active lane 晋级 writable 或其 anchor 本身已 writable
- **THEN** cohort 仍按全部 active lane 的原固定 chunk 定界，只过滤 suspended lane 作为 Shadow sample；writable lane 仍进入正式全量 planner，cursor 可继续绑定该 writable anchor

#### Scenario: Shadow CPU Cut
- **WHEN** 某批 Shadow 已选中，但候选身份扫描、批/逐 lane planner 或 transaction-energy 在形成完整 observation 前超过 CPU ceiling
- **THEN** 身份扫描必须至少每 32 条 order 检查一次同一 CPU 窗口，planner 必须在调用前后检查；该批不推进、不清零、不计完整周期，cursor 也不得把它们当作已完成跳过，未执行逐 lane fallback 时 mode 不得标成 `batch_fallback`；writable scope 若存在则本 tick 零写

#### Scenario: 纯 Shadow 无机会批量复核
- **WHEN** 本轮同一资源 cohort 的全部采样 lane 都是 suspended Shadow、没有 writable lane，局部 incomplete 的 preObserved 与 terminal/protection/book 完整的 ready 子集互斥并精确覆盖 sampled lane，且 collector 证明 `eligible=0`
- **THEN** 系统 MAY 使用一次 planner 调用复核最多 8 条 ready lane，同时保留 preObserved reset；必须让每条 ready lane 都进入完整 planner 校验、为 detached book 使用一次性 capability，并且只有无 blocker、无候选、无能耗回调、无 isolated lane、artifact 与 lane/resource/room/instance 覆盖完全一致时才投影逐 lane 完整 observation；candidate-only order identity 与 tuple Set 检查次数必须为零，批结果不得进入双读、WAL、claim 或 deal

#### Scenario: 纯 Shadow 有候选的 Ready 子集批量复核
- **WHEN** 本轮没有 writable lane、同一资源 cohort 的全部 sampled lane 均为 suspended Shadow，部分 lane 已形成 terminal/protection/book 局部 incomplete reset，其余 exact ready 子集对应的 collector `eligible>0`
- **THEN** 系统 MAY 对该 ready 子集执行一次 planner，但不得传 detached normalization capability，必须要求 artifact observer 为 `false`；preObserved 与 ready 必须互斥且精确覆盖 sampled lane，只有经冻结 book/order identity、`resource+sellerRoom+laneId` 唯一映射、tuple 子集关系和 callback/budget 闭合验证的 `safeCandidates` 可投影 observation，`selected`/`admittedCandidates`、synthetic writable 和正式 planner entry 均不得进入双读、WAL、claim 或 deal；模式按该 cohort collector 的 eligible 计数判定，ready 子集自身无候选也不得退回 capability 快路径

#### Scenario: Shadow 批量复核异常
- **WHEN** `eligible=0` 批调用出现意外候选/transaction-energy 回调，或任一批调用出现异常、artifact 模式错误、callback 数量不符、lane/book/order 映射或 exact-ready 覆盖不完整
- **THEN** 系统必须丢弃全部批结果并用新签的一次性 capability 回退到原逐 lane planner；若此时已超过 25 CPU，则不得强制回退、推进 cursor 或保留安全 observation

#### Scenario: Candidate Batch 原生能耗 CPU Cut
- **WHEN** 候选批规划的任一 transaction-energy memo miss 在原生计算前或后越过同一 25 CPU ceiling
- **THEN** 系统必须立即停止后续原生计算，整批不回退、不推进 cursor、不保留安全 observation，并保持正式 selection、WAL、claim 与 deal 全为空

#### Scenario: 无 Writable Lane 不生成写证据
- **WHEN** full read 完成且 `plannerEntries` 为空
- **THEN** 系统 MAY 省略只供写前双读使用的整本 book/terminal/protection evidence 深哈希，但仍必须完成订单 clone、scope、terminal、protection、CPU 和 Shadow planner 校验；只要存在 writable lane 就必须恢复完整双读证据

#### Scenario: Cache 不发生白名单抖动
- **WHEN** 七种基础矿物与 Energy history 均被缓存
- **THEN** 八项必须在固定 cache 上界内稳定工作，禁止资源不能触发第九项 eviction

#### Scenario: Monitor 有界
- **WHEN** 56 条 lane 与大量订单持续运行
- **THEN** monitor 必须展示 catalog/roster/lane-set、permit、lifecycle、quota、best tuple、Hub marker、energy readiness、CPU blocker、Shadow planner mode/invocation count/实际 transaction-energy evaluation count/evaluated Shadow resource count/candidate identity order checks 的有界摘要，不得持久化 lane×order 原始矩阵；evaluated Shadow resource count 表示每次 full read 的 cohort distinct resource 宽度，双读取最大值而不累加，candidate identity order checks 则按两读实际检查量累加

#### Scenario: Resource Cohort 不代表 Mixed Ready
- **WHEN** 任一资源出现 writable lane 且同资源仍有多条 suspended Shadow lane
- **THEN** 正式 writable universe 和全局单位净价排序不得被 cohort 缩窄；在 same-resource mixed 双读通过独立 25 CPU 活性门禁前不得授予 Canary/Continuous，CPU 超限仍须零 WAL、零 claim、零 deal

### Requirement: V3 持久历史必须有不可复活的硬上界
系统 MUST 固定 active rooms 16、known room names 32、active lanes 112、recent room tombstones 64、recent lane tombstones 224、连续 full permit suffix 64、full receipts 512、outcomes 50、rejection samples 32、monitor samples 64。receipt 只有 `retentionTick < tick-29,999` 且已被连续 checkpoint 吸收时才可裁剪。历史压缩 MUST 形成 canonical prefix checkpoint，绑定覆盖范围、first/last ID、prev/head hash、epoch/incarnation/canary high-water、累计 quota/lifetime 与 prefix commitment。

PermitPrefixCheckpoint MUST 保存 pruned-through epoch/head 和仍被 retained receipt/current review 引用的 permit binding。binding source set 只能是：最多 512 条 retained receipts 各一个引用，以及最多 112 条 active derived lanes 各一个 current review 引用；suspended/tombstone/legacy historical state 只能保存 checkpoint digest，不得额外 pin full permit/binding。因此 `maxReferencedPermitBindings=624`，第 625 个 unique binding MUST 在 append/compaction 前 fail-closed。binding 被认证后 MAY 释放对应 full permit pin，active pending 的 historical permit 禁止释放。

系统 MUST 始终满足 `retainedPermitCount=min(64,totalChainLength)` 和 `prunedThroughEpoch + retainedPermitCount = permitEpochHighWater = totalChainLength`；存在 pruned prefix 时 retained suffix 第一条 predecessor 精确链接 checkpoint head。

#### Scenario: 被引用记录达到上界
- **WHEN** current permit、pending、review evidence 或 retained receipt pin 的记录使下一 append 超过固定容量
- **THEN** 新 permit/attempt admission 必须在写入前拒绝并全局停写，不得删除仍被引用记录或临时扩大 ring

#### Scenario: Permit Binding 释放 Full Pin
- **WHEN** 超过 64 次 successor，旧 permit 仅被 retained receipt 或 current review evidence 引用且没有 active pending
- **THEN** compactor 必须先把 permitId/epoch/selfHash/grantDigest/reviewDigest 写入受认证 prefix binding map，再裁剪 full record；引用消失后 binding 只能随下一原子 checkpoint 删除

#### Scenario: Binding Map 边界
- **WHEN** 512 个 retained-receipt refs 与 112 个 active-lane current-review refs 形成 624 个 unique bindings
- **THEN** checkpoint MAY 提交；任一 suspended/tombstone/legacy state 试图增加引用或出现第 625 个 unique binding时，compaction/append 必须在修改 state 前 fail-closed

#### Scenario: 第 65 次及更多 Successor
- **WHEN** permit chain 到达 epoch 65、129 或更高
- **THEN** full records 必须始终为连续 64 条 suffix，prunedThrough+retainedCount/highWater/totalChainLength 恒等，首 retained predecessor 链接 checkpoint，current tip 等于 suffix 末条

#### Scenario: 前 64 个 Epoch
- **WHEN** totalChainLength 尚小于 64
- **THEN** retainedPermitCount 必须等于 totalChainLength、prunedThroughEpoch=0，不能伪造不存在的 prefix checkpoint

#### Scenario: 重签已裁剪 Epoch
- **WHEN** operator 重签 `epoch <= prunedThroughEpoch` 的旧 permit
- **THEN** 系统必须确定性返回 `pruned_epoch_not_replayable` 且 state 不变，不得恢复 full record或 fresh grant；幂等 no-op 只适用于 retained suffix 中完整记录仍存在的相同 epoch/content/ID，若 pruned 提交内容与仍保留 binding 冲突则进入持久 conflict

#### Scenario: Pending 预留终态槽
- **WHEN** 系统准备新的 pending
- **THEN** 必须先证明 outcome/receipt ring 各有一个可用或可合法裁剪的预留槽；active pending 后续对账和终态 append 始终使用该槽，不得因达到 512/50 上限而先返回并永久卡住 exposure

#### Scenario: Tombstone 压缩后尝试复活
- **WHEN** 已裁剪 room/lane ID 被当作 fresh lifecycle 使用，或 checkpoint/per-room incarnation high-water 被删除、冲突或回拨
- **THEN** 系统必须拒绝并持久 block；被裁剪 ID、stage、canary high-water、fingerprint 与 incarnation 的历史承诺不得丢失

#### Scenario: 原子 High-water
- **WHEN** current tip、permit prefix/suffix/binding、epoch/head high-water、ledger checkpoint、room incarnation map 或 chain length 任一不一致
- **THEN** 所有新写必须停止，不能通过重算 current state 或丢弃历史自愈
