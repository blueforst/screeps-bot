## Context

线上 shard1 当前部署为 `2026.7.26-6+b8833fb`。Continuous Direct 的 v2 permit 只授权 X/E6N59 写入，并为 H/E3N59、Z/E7N57 保存 suspended Shadow；实现仍在三处只读取 `allowedRoomNames[0]`。因此 E1N57 的 X、E3N59 的 H、E4N58 的 X、E5N59 的 U、E7N57 的 Z、E7N58 的 L、W1N57 的 K 等大量原矿不会作为 seller lane 参与。

2026-07-28 的 live 证据还显示两个独立生产侧阻断：

- `hubPlanner` 提交计划后，`synthesisControl` 可在同 tick 设置 `needsPlan=true`；保护采集器把这个“下一轮重规划请求”误判为当前 Hub 证据过期，形成间歇性的 `protection_stale:hub`。
- E6N59 terminal energy 为 23,653。ResourceControl 的普通目标为 20,000，而 Direct 要求成交后至少保留 25,000 且单笔交易能量不超过 1,000，预成交就绪目标应为 26,000。普通 terminal feed 又受 used-cap 250,000 限制，当前 terminal used 255,102，因而不会补足缺口。

市场直售已经有 append-only permit、单 pending WAL、固定 1,000、最高单位净价、生产保护和 rolling quota。新设计扩展这些合同，不恢复旧 seller，也不重建账本。

## Goals / Non-Goals

**Goals:**

- 将 `H/O/U/L/K/Z/X` 七种基础矿物扩展到当前和未来自动发现的自有 terminal 房间，并以冻结的准入规则、上界和独立 lane 生命周期保持可审计授权。
- 对同资源多房间与跨资源机会统一比较交易能量修正后的单位净价。
- 允许具备完整保护证据的 Hub/容量紧急房间通过高价安全直售释放空间。
- 修复 Hub committed protection 与 replan request 的时序混淆，并为 seller terminal 安全准备交易能量。
- 无损继承 v2 permit/receipt/WAL/quota/lifetime/high-water，新增范围必须重新 Shadow、Canary 和复审。

**Non-Goals:**

- 不出售 Energy、G、Deposit 原料、Power、ops、Pixel、反应中间物、T1/T2/T3、Boost、Factory/Commodity 或 seasonal 资源。
- 不让新发现房间立即继承 continuous；它只自动获得进入 Shadow/Canary 流程的权限。
- 不因容量压力、等待时间、大库存或大订单降低任一净底价。
- 不在本变更中为市场专门把待售矿物从 storage 搬入 terminal；terminal 实存不足时等待现有物流释放/搬运。
- 不恢复 Maker/hybrid、legacy ResourceControl seller、legacy Hub/T3 seller 或 Factory seller。

## Decisions

### 1. 使用正向基础矿物白名单和冻结的逐资源 Policy

v3 permit 固定：

- `resourceCatalogRevision=base-mineral-v1`
- canonical allowlist 为排序后的 `H/K/L/O/U/X/Z`
- `energyDisposition=fuel_only_never_sell`
- raw config 只要包含白名单外资源、额外 threshold key、重复项或未知项，整体 fail-closed；不能先静默过滤再判断合法。

初始资源 policy 排除官方 rolling stats 的左右 partial 边界，只采用 2026-07-15 至 2026-07-27 共 13 个已复核稳定完整日的现有 log-MAD/加权中位数算法，可信历史取 95% 后向上取整。逐日 transactions/volume/avgPrice、accepted/rejected days、算法参数、reference price、95% 结果与 canonical JSON SHA 全部冻结在 [floor-bootstrap-evidence.md](evidence/floor-bootstrap-evidence.md)。算法实现基线为 commit `b8833fbbfc5a4ff96e99a70a8711d3e36f43a4fc` 的 `src/runtime/marketSalePricing.ts`，Git blob `f55503b3d45352e14513e9928706251c82992ecc`。既有 X/H/Z 阈值不降低；O/U/L/K 使用同一算法，但 O 因左边界波动保守维持高于新 history floor 的静态门槛：

| Resource | hard / economic net floor | 30k resource cap | lane reserve | min 1,000 notional |
|---|---:|---:|---:|---:|
| H | 428 / 451 | 8,000 | 100,000 | 451,000 |
| O | 138 / 145 | 5,000 | 100,000 | 145,000 |
| U | 44 / 46 | 5,000 | 100,000 | 46,000 |
| L | 161 / 169 | 5,000 | 100,000 | 169,000 |
| K | 96 / 101 | 5,000 | 100,000 | 101,000 |
| Z | 43 / 45 | 5,000 | 100,000 | 45,000 |
| X | 600 / 600 | 8,000 | 100,000 | 600,000 |

每个 policy 继续要求可信历史和持久 ratchet；有效净底价为 hard、economic、history、ratchet 的最大值。首个 v3 successor 必须显式签入 `floor-bootstrap-v1`：`historyDate=2026-07-27`，H/O/U/L/K/Z/X 的 `observedFloor=ratchetFloor` 分别为 `433.765/128.524/45.939/168.132/100.914/41.623/559.430`，并绑定 checked-in canonical JSON SHA。运行时不得隐式 bootstrap。ratchet 状态及其 high-water/fingerprint 纳入 resource lifecycle、permit 和 checkpoint；缺失、回拨、日期倒退、digest 不一致或重复 bootstrap 时只允许零写审计恢复，不能以较低历史重新初始化。

所有资源固定 `maxDealAmount=1,000`、`maxRawOrders=1,000`、`maxEligibleOrders=200`、`maxTransactionEnergy=1,000`、`terminalEnergyReserve=25,000`、`cooldown=1,000`、opportunity reserve 1,000；七个 policy 的 cooldown 字段必须相同并由 account-global 门禁统一执行，绝不按 lane 独立计时。备选的“只靠实时最高买价”会重新引入 0.x/1.x 异常成交，拒绝。

### 2. Permit 冻结自动房间准入规则和派生 Lane 上界

一个资源只有一个 active `ResourcePolicy`，房间不是复制的 resource entry。v3 使用：

- `ResourcePolicy { policyId, resource, class, floors, reserve, quota, limits, fingerprint }`
- `RoomAdmissionPolicy { revision, accountIdentity, controllerMyRequired, visibilityRequired, terminalRequired, autoAdmit, maxRooms, fingerprint }`
- `SellerRoomState { roomInstanceId, roomName, incarnation, previousInstanceId, roomClass, controllerOwner, terminalId, status, fingerprint }`
- `DerivedLaneLifecycle { laneId, resourcePolicyId, roomInstanceId, stage, shadowEvidence, status, fingerprint }`
- `SignedLaneGrant { laneId, resourcePolicyId, roomInstanceId, stage, newDealGrant, evidenceDigest, fingerprint }`
- `LaneDerivationPolicy { revision, maxKnownRoomNames, maxLanes, fingerprint }`

Permit 冻结 `owned-visible-terminal-v1` admission policy：只有当前 `Game.rooms` 中可见、controller.my、owner 与 account identity 一致且 terminal 为自有结构的房间自动准入。当前首个 runtime roster 为：

`E1N57, E3N59, E4N58, E5N59, E6N59, E7N57, E7N58, W1N57`

E4N58 标记 `roomClass=hub`，其余为 `normal`。`maxRooms=16`、`maxKnownRoomNames=32`、`maxLanes=112`；若部署时观测仍匹配该快照，七资源笛卡尔积精确为 56 条 lane；若已发生漂移，必须按同一 admission policy 重新派生并把实际 roster/lane-set fingerprint 纳入复审，不能截断或伪造为 56 条。resource catalog、admission/derivation 算法 revision、engine revision 和上界属于稳定 permit/shared fingerprint；current roster 与 current lane-set 只属于本 tick 双读、pending 和 monitor 的动态 scope fingerprint。其他房间加入或离开不得改变稳定 shared fingerprint，也不得清零未变化 lane。

未来符合规则的新房无需仅为 roster 扩围签 successor。自动产生的是只读 `DerivedLaneLifecycle(shadow+suspended)`，不是 permit 中的可写 grant；Canary/Continuous 唯一写权限仍来自 successor 的 exact `SignedLaneGrant`。

每个曾见 roomName 保存不可回退的 `roomIncarnationHighWater`。首次准入取 generation 1；从 admitted→not-admitted→admitted，或 owner、terminalId、roomClass 任一发生 discontinuity 时，必须先原子递增 high-water，再以 `roomName + incarnation + previousInstanceId + controllerOwner + terminalId + roomClass + admissionRevision` 生成新 roomInstanceId。即使属性出现 A→B→A、同账户同 terminal 重新占领，也不得复用旧 ID。当前 state、incarnation high-water、tombstone checkpoint commitment 或 previous-instance chain 缺失、冲突、回拨时全局零写。旧 room/lane state 转为 suspended tombstone；压缩后由不可回退 checkpoint 和 per-room high-water 防止复活。`maxLanes=112` 只计算 active derived lanes；legacy v2 scope、tombstone 和 permit history 受各自上界约束，不占 active lane 配额。超过任一上界时全局零写，不能截断 roster。

### 3. 新 Lane 不继承旧 X 证据

兼容读取器继续按 v2 embedded payload 验证当前 epoch 1 permit、ledger 和历史 pending；在 current permit 仍为 v2 时，旧 X/E6N59 只能由冻结的 v2 evaluator 维持原来的精确 continuous scope，绝不读取 v3 catalog、admission、roster、lane lifecycle 或 shared fingerprint。v3 不创建新 genesis，不重哈希旧 receipt，也不重置 attempt sequence、processed keys、rolling/lifetime 或 high-water。

v3 permit、pending、outcome、receipt 各自携带不可变 `schemaVersion/hashRevision`；但 live v2 pending/outcome/receipt 的 raw record 历史上没有 record-level discriminator，不能给它们补字段后再验 hash。

唯一 cutover 规则为：

- current permit/outer ledger 仍为 v2 时，raw event 缺 record discriminator、字段集合精确匹配 frozen v2 codec 且 seq 不高于当时 v2 high-water，分类为 `legacy-v2-implicit`，直接按原始 v2 bytes/payload/domain 验证；未知字段也必须拒绝；
- WAL quiescent 的首个 v3 successor 在外层写受认证的 `v2EventCutoverCheckpoint { outerLedgerSchema:2, lastV2AttemptSeq, lastV2OutcomeSeq, v2ReceiptHeadHash, v2LedgerCheckpointHash }`，它不写回旧 record，也不进入旧 event hash；
- cutover 后，只有 `seq <= authenticated cutoff` 的无 discriminator 历史记录可继续按 v2 验证；任何 `seq > cutoff` 的无 discriminator 记录、cutoff 不一致或尝试给旧 record 补 version 都是持久 conflict。所有 v3 新记录必须显式带版本。

validator 据此按记录自身显式版本或受认证 legacy cutoff 分派 canonical payload/domain。v3 permit head 直接链接持久 v2 opaque tip；首个 v3 epoch 必须为 `permitEpochHighWater+1`。current tip、epoch/head high-water、cutover checkpoint、ledger checkpoint 与 chain length 在一次状态提交中原子一致，任一旧 payload bit flip、旧 head 重算、单边回拨或 mixed-version gap 都进入持久 blocker。

签收首个 v3 successor 时：

- predecessor 必须引用当前 v2 permit/head 和当前 ledger head；
- pending、quarantine、gap、unmatched reservation 必须全零；
- 旧 v2 grant 作为历史记录保留但必须在同一 successor 中 suspended；首个 v3 successor 后允许出现暂时全局零写，不设置 legacy bridge；
- current derived lane 全部登记为 `shadow+suspended` 的 `SignedLaneGrant`；未来自动准入只先生成 DerivedLaneLifecycle，不自动修改 permit；
- append 层必须遍历全部 next grants，强制 `prior signed grant missing`、policy/room/shared fingerprint 变化时只能 suspended。

每条新 lane 在最终相同 policy/room-instance/admission/shared fingerprint 下完成 100 个完整 Shadow 观测。DerivedLaneLifecycle 可以在首个 v3 successor 前只读累计，但不能授权交易；首个 v3 successor 只能登记 suspended，至少下一份连续 successor 才能在重验 lifecycle digest 后授予 canary，因此未来 lane 从自动加入到 Canary 至少需要两次 successor。上一份 signed permit 是唯一 prior，runtime lifecycle state 不能替代 prior grant。

其他房间加入/离开不会清零未变化 lane；未被采样不清零，显式不完整、tick 回拨或该 lane 相关的稳定 fingerprint 变化才清零。qualified 后每次只允许一个 lane 获得 one-shot canary，最多成交 1,000；confirmed 后该 lane 自动 `review_paused`。只有独立复审其实际净价、库存、能量、生产承诺、receipt 和 quota，并签收 successor permit，才可进入 continuous。

切换同资源的新 canary 时必须先 suspend 旧写 grant，避免 legacy X 与 v3 X 同时写。用户本次授权用于批准这套扩围流程和后续 exact permit，不替代每条 lane 的运行证据。

### 4. 多房间 Planner 使用共享 Book 和完整可写 Scope

每次 full planning：

1. 对七种资源各读取一次可信历史和完整 BUY book；同资源所有房间共享同一不可变 book snapshot。同 ID 同 canonical 内容只计一次；同 ID 内容冲突、跨资源重复、resource/type 不匹配或无法排除自有订单时该 book 不完整。写前第二读必须重新调用 API 并构造独立 snapshot/object，不能复用第一读缓存或 memo。
2. 为 permit 中全部 lane 读取 ownership、terminal、capacity、Hub class、保护、quota 与 lifecycle。
3. suspended Shadow lane 的局部不完整只重置自身；任一 writable lane 的 terminal/book/protection 不完整，或任一 shared/未知作用域证据不完整，本 tick 全局零写。
4. 只有 `sellableAmount>=1,000`、terminal 实存至少 1,000、cooldown 0、能量和 quota 完整的 writable lane 才生成 tuple；无可售量的完整 lane 是安全无机会，不需要伪造候选。
5. 对每个 `(resource, seller room, BUY order)` 精确计算 1,000 与 amount=1 的交易能量/净价，均须高于有效净底价并满足订单量、名义额、transaction-energy 和成交后 terminal reserve。
6. 先按单位净价、总净额、gross price 降序，再按 resource/room/orderId 升序稳定排序。订单剩余量、库存量、capacity state 和配置顺序不得排在价格之前。
7. 写前重新读取完整 writable lane universe、动态 roster、book/order、terminal、protection、energy、quota、permit/head、arbiter 和 production intent；任何变化或最佳 tuple 改变都零写，不换次优单。全部 writable lane 每轮必须完整扫描，绝不轮转或截断；超预算时整轮零写。

只有 suspended Shadow 可按排序 laneId 使用持久 cursor 轮转，`maxShadowLanesPerCycle=8`。在 roster 不变且 CPU/依赖完整时，56/112 条 active lane 分别最多 7/14 个完整规划周期被采样一次；roster 改变时 cursor 以最后 laneId 的稳定后继重映射，不能跳过前缀。未采样 lane 不推进也不清零；CPU cut/依赖不完整的采样不算完整观测，cursor 仅在该批 observation 形成终态后推进。

容量 emergency 不再单独降低经济资格。Direct deal 若只消耗 terminal 中现有基础矿物与交易能量，且保护/底价/terminal 均完整，可以释放空间；它不能因为 emergency 获得更低 floor、更大 batch 或更宽 quota。

### 5. Hub 使用 committed protection，不以 `needsPlan` 判旧证据失效

Hub plan 增加原子式全量快照提交语义：

- cadence/`needsPlan` 决定本 tick 真正开始规划后，必须在任何 room/structure/CPU 校验和早退之前递增 `protectionAttemptHighWater`，写入 `currentProtectionAttempt={attemptRevision, startedAt, status:in_progress, valid:false}`。adapter 只接受 planRevision 等于 current attemptRevision 且 attempt status=committed 的 snapshot，因此一旦新 attempt 开始，旧 snapshot 即使 TTL 尚新鲜也不得再用于市场；
- 在局部构造完整、不可变的 `nextCommittedHubProtectionSnapshot`。它必须显式包含同一 `planRevision/configFingerprint` 下的 marker、synthesis config、transfer tasks、distributed assignments/routes、allocation ledger、base-mineral surplus；本计划没有的数组/映射必须写空值，不能沿用旧字段；
- distributed、fallback 和 blocked 的成功路径都必须在函数末尾整包替换 committed snapshot 后才清 `needsPlan`。中途异常则整包发布 invalid empty snapshot 或 `protectionUnavailable`，不得把旧 residual 重新标 valid；
- 整个实际 planning body 必须由 `try/finally` 或等价单出口保护：room 不可见/非自有、缺 storage/terminal/lab、普通 early return、throw、CPU cut 和部分写失败都必须把同 attemptRevision 终结为 blocked/failed 的 invalid empty snapshot。只有整包 success commit 可把 attempt 置 committed；不得遗留 in_progress 后继续接受旧 snapshot；
- adapter 只接受 fresh、valid、config fingerprint 一致、所有子字段 revision 一致且事实结构合法的 committed snapshot，不再从 legacy `runtime.hub.distributedSynthesis/allocationLedger/marketSellSurplus` 拼装市场保护；
- `synthesisControl` 同 tick 设置 `needsPlan=true` 只请求下一轮规划，不撤销上一份仍新鲜的 committed protection；当前 Synthesis active/paused/transfer 事实仍由各自 collector 叠加保护；
- marker 缺失、过期、配置漂移、房间不可见、结构缺失、规划异常或未知作用域事实继续全局 fail-closed。

首次部署 marker 缺失时强制下一 tick 规划，不等待普通 cadence。

Hub 基础矿物只允许使用 current committed snapshot 中该 Hub 房间、同 planRevision 的 allocation residual available supply，并再受 lane reserve、显式 outgoing、Carrier/in-flight、Factory/Synthesis/Boost/War 与 terminal 实存限制。当前计划没有 residual、residual 缩小或 fallback/blocked 写空 residual 时，Hub 对应 sellable 必须立即为零，不能复用旧值。`baseMineralSurplus` 对白名单基础矿物投影这个上限；白名单外既有 surplus 字段不能形成现代候选。Hub 的派生 lane 仍须独立 Shadow/Canary，不能因普通房间通过而继承资格。

### 6. ResourceControl 只为市场手续费做有界 Energy Readiness Feed

ResourceControl 每 tick 为 seller room 发布带 revision、稳定贡献 ID 和 TTL 的：

`productionAndTransferReserve = ordinaryTerminalEnergyTarget + unresolvedEnergySendAmount + unresolvedInternalSendFees + terminalScopedProductionEnergyCommitments`

`effectivePostDealEnergyReserve = max(25,000, productionAndTransferReserve)`

`marketTerminalEnergyTarget = effectivePostDealEnergyReserve + maxTransactionEnergy`

所有 contribution 必须按稳定 ID 去重。两次 full read 都必须重算并要求 `terminalEnergy - actualTransactionEnergy >= effectivePostDealEnergyReserve`；缺失、过期、回拨或两读变化视为 shared/writable blocker。没有额外生产/发送承诺时基线 target 为 26,000。

ResourceControl 必须先在同一个 per-room planning pass 中合并普通 Energy feed 与 market readiness 为单一 `desiredTerminalEnergy=max(ordinaryTarget, marketTarget)`，再与其他 resource staging/offload 一起仲裁并一次性生成最终 drafts。market readiness 不创建第二 producer/重复 task，也不单独调用 replace：

- 同 stable task/contribution ID 只计一次；
- existing ordinary Energy feed 原位提升到合并目标，不叠加 amount；
- Energy offload 不得把 terminal 降到 effective reserve 以下；若生产优先 offload/staging/terminal claim 与 readiness 无法同时满足，则 readiness 让位并阻止 Direct；
- non-Energy staging/offload 和全部已接受 draft 先共同占用物理 headroom，之后再检查 40,000；
- 每房每 tick 只允许一次 `replaceCarrierTasksForProducerRoom` 等价整包提交，提交集合同时包含原有生产 drafts 与 readiness；任何构造失败保留安全旧状态并零市场写，不能用只有 readiness 的集合覆盖生产任务。

若普通 used-cap 规则会阻止补给，只允许一个专用 energy egress exception，且必须同时满足：

- room 非 capacity emergency；
- 只补到精确目标，不预装额外能量；
- 补后 terminal free capacity 在计入本 tick 所有普通 staging/feed draft 与 market readiness draft 后仍至少为 `terminalPressureFreeCapacity=40,000`；
- storage energy 在扣除补给后仍不低于 room energy floor 加 current production commitments；
- terminal 有真实物理容量，且没有冲突 terminal/market claim。

市场 off/emergencyStop、房间不在 permit/derived lifecycle、证据无效或任一条件失败时不创建额外任务。该任务只从本房 storage 搬 Energy，不购买 Energy。E6N59 在没有更高生产/发送 reserve 的 live 夹具应生成精确 2,347 energy feed；E1/E4/E7N58/W1N57 等 emergency 房间不使用该例外，只能在自身 terminal 已满足 current effective post-deal reserve 与实际手续费时直售。

ResourceControl 早于 live market runtime 执行，因此 readiness authorization 必须读取 `Memory.data.marketSaleAutomation.directAutomation` 的 canonical permit/state，经无副作用的纯 versioned reader 校验；不得读取同 tick 尚未发布的 `Memory.runtime.marketSaleAutomation`，也不得让 ResourceControl 反向导入 market runtime/protection adapter 形成循环依赖。

### 7. WAL、Quota 与事故预算跨版本连续

全局仍只有一个 pending、每 tick 最多一个 market write、固定计划量 1,000。v3 pending/outcome/receipt 各自使用独立冻结的 schema/hash revision；hash 覆盖 historical permit ref、resource policy、room incarnation/lane、当时 admission/roster/lane-set、两次 full-read、planned/worst-unit net、transaction energy 与四层 quota。第一条 v3 receipt 的 prevHash 必须是现存 v2 receipt opaque head，不能重建前缀。

pending 恢复只能使用其冻结的 historical permit 与 historical dynamic scope。pending 后新房加入、房间丢失、terminal 重建或 current roster 改变，只阻止新 deal，不得释放、重写或改用 current permit 解释旧 exposure；historical permit 缺失/损坏时必须保留 pending/reservation 并进入持久 blocker。

30,000 tick 窗口同时执行：

- global cap 12,000；
- 表中 resource cap；
- room cap 5,000；
- lane cap 3,000；
- account-global confirmed cooldown 1,000，并保留 global retry backoff。

四层聚合键冻结为：global=全部；resource=`resource` 跨房/跨 policy；room=`sellerRoom` 跨资源/跨 incarnation；lane=`resource+sellerRoom` 跨 policy/instance。confirmed partial 只按 actual amount 计入；unmatched pending 在四层均按 planned 1,000 保留，直到唯一对账。global confirmed cooldown 由全部 v2/v3 confirmed receipt 的最新 tick 计算，不能误降为逐 lane cooldown；retry backoff 同样为 global。七个资源各 1,000 opportunity reserve 合计 7,000，小于 global cap，仍能防止低绝对单价资源永久饥饿，但不改变已准入 tuple 的价格排序。

WAL 提交顺序保持 `outcome → receipt/head/checkpoint/lifetime → processed key → delete pending`。任何 CPU cut、未知返回、歧义 transaction、chain gap 或 permit conflict 继续 fail-closed。

### 8. CPU 和 Memory 必须有硬上界

- allowlist 七资源加 Energy history 恰好占当前 8-resource cache 上限；未知第九种资源必须被原始配置拒绝。
- 每次 full read 每资源最多一次 `getAllOrders`，最多七次；写前第二读使用独立 snapshot，理论最多 14 次，而不是 `resource × room`。
- 每资源 raw/eligible 上限为 1,000/200；全部 eligible book 合并后的 distinct `orderRoom` hard cap 为 128，超过则在 tuple evaluation 前整轮零写，不能截断订单或目的房间。transaction-cost memo 以 `(amount,sellerRoom,orderRoom)` 去重。
- 单次 full read transaction-cost evaluation hard cap 为 `2 amounts × 16 seller rooms × 128 distinct order rooms = 4,096`；因此所有合法 scope 的最坏值与 cap 闭合。超限整轮零写，不能截前 N 个继续成交。
- market planning 从开始到 prepare 前 hard CPU ceiling 为 25；超过后零写并投影 bounded telemetry。
- active rooms 16、known room names 32、active lanes 112、recent room-instance tombstones 64、recent lane tombstones 224、full permit records 64、full receipts 512、outcomes 50、rejection samples 32、monitor samples 64。任何仍被 current permit、pending、review evidence 或 retained receipt 引用的对象必须 pin；pin 将使下一次新 permit/attempt admission 在超界前拒绝并停写，不能先丢引用。
- receipt 继续遵守既有 30,000 tick coverage：`retentionTick >= tick-29,999` 或未被连续 checkpoint 吸收的记录不得裁剪。prepare pending 前必须预留一个 outcome/receipt 终态槽位；active pending 的恢复/终态提交始终可使用该预留槽，不能因 ring 满而卡住 WAL。没有可裁剪记录或预留槽时只拒绝新 pending，不影响历史 pending 对账。
- permit/receipt/tombstone 历史只能通过 canonical prefix checkpoint 压缩。permit full-record ring 必须始终是 current tip 结尾的连续 64-epoch suffix；`PermitPrefixCheckpoint` 冻结 `prunedThroughEpoch/lastPrunedPermitId/lastPrunedPermitHead/prefixCommitment`，并保存仍被 retained receipt 或 current review evidence 引用的 `referencedPermitBindings { permitId, epoch, selfHash, grantDigest, reviewDigest }`。每条 retained receipt 最多引用一个 permit（上限 512），每条 active lane 最多保存一个 current review reference（上限 112），因此 binding map hard cap 为 `maxReferencedPermitBindings=624`；字段长度和 digest 格式也由 codec 固定。第 625 个 unique binding 必须在 compaction/append 前 fail-closed。引用进入受认证 binding map 后可释放 full permit pin；active pending 引用永远不能靠 checkpoint 释放，必须等 WAL 收敛。
- permit 结构恒等式必须为 `retainedPermitCount=min(64,totalChainLength)` 且 `prunedThroughEpoch + retainedPermitCount = permitEpochHighWater = totalChainLength`；`prunedThroughEpoch>0` 时首条 retained permit 的 predecessor 必须精确等于 checkpoint last-pruned ID/head，suffix 内逐条连续，current tip 等于 suffix 末条。binding 不再被 retained receipt/review 引用后只可在下一次原子 checkpoint 中删除。
- 相同 epoch/content/ID 的幂等 no-op 只适用于 full record 仍在 retained suffix 的 permit。对 `epoch <= prunedThroughEpoch` 的旧 permit 重签一律返回确定性 `pruned_epoch_not_replayable` 且不改变 state，即使 binding 仍存在也不能重建 full record、当作 fresh grant或移动 tip；若提交内容与仍保留 binding 冲突，则持久 conflict。checkpoint、suffix、binding map、current tip/high-water/ledger checkpoint/room incarnation map/chain length 任一单边缺失或回拨时全局零写。
- 其他 checkpoint 必须冻结 schema、覆盖范围、first/last ID、prev/head hash、incarnation/canary high-water、累计 quota/lifetime 与 prefix commitment；被裁剪 room/lane ID 永不得作为 fresh lifecycle 重用。
- room/lane/order/rejection 观测均使用上述固定长度；不得把 lane×order 原始矩阵写入 Memory。
- 新 Hub `baseMineralSurplus` 只能被 v3 Direct protection adapter 读取；legacy ResourceControl/Hub seller 必须有代码级永久闩，配置误开也不能消费该字段或调用市场写入口。

## Risks / Trade-offs

- [lane 的资格与 Canary 周期较长] → suspended Shadow 每轮稳定采样最多 8 条、56/112 条分别最多 7/14 个健康周期覆盖一次，每次只启用一个 canary；优先处理当前确有大额 surplus 的 E1/X、E3/H、E4/X、E5/U、E6/X、E7N57/Z、E7N58/L、W1/K。
- [静态 economic floor 可能在市场长期下跌后减少成交] → 保守等待符合“不超低价出售”；任何下调仍需新 policyId、证据和 successor permit。
- [允许 emergency/Hub 出售扩大运行面] → 不改变底价/批次/额度，要求 exact terminal 实存、current protection 与独立 lane lifecycle；Hub 额外受 committed residual cap。
- [25 CPU ceiling可能在盘口极大时停止交易] → 停止是安全结果；共享 book、memo 和 bounded scan 防止正常盘口重复开销。
- [v2/v3 mixed-version 增加迁移复杂度] → 版本化校验历史事件，不重算旧 hash；部署、successor、canary 各阶段都要求 WAL quiescent 和独立复审。

## Migration Plan

1. 在隔离 worktree 实现兼容读取器、v3 schema、Hub committed marker、Energy readiness feed、白名单 raw validator、多-lane planner 与 monitor；默认不生成 v3 写 grant。
2. 运行定向/完整 Jest、TypeScript、build、静态唯一写入口、OpenSpec strict，并由独立 subagent 复审。
3. 合并 main 并部署；确认 tag、Pixel/legacy sellers 关闭、v2 permit/ledger/head/attempt/quota 原样、零新 pending，且 Hub committed marker 在首个完整计划后有效。
4. 兼容 bundle 在 current head 仍为 v2 时可继续按冻结 v2 evaluator 执行 legacy X，同时只读积累 v3 DerivedLaneLifecycle。WAL 完全静止后提出首个 v3 successor：同一提交 suspend legacy X，冻结七资源/admission/floor bootstrap，并把 current derived lanes 全部登记为 `shadow+suspended`；此刻允许暂时全局零写。
5. 观察至少 100 个完整 Shadow 观测和两个 Hub planInterval；核对无 `protection_stale:hub` 伪阻断、E6 精确 energy readiness、CPU/Memory 上界与逐 lane 拒绝原因。
6. 至少用下一份 successor 逐 lane生成 one-shot canary grant；每笔 confirmed 后独立复核净价、生产、terminal、receipt 和 quota，再用后续 successor 进入 continuous。任何失败只 suspend 对应 lane；shared/unknown 失败全局停写。
7. 回滚只通过 emergency stop 或 successor suspension；不得恢复旧 Memory、删除 v3 evidence 或回拨 epoch/high-water。旧 bundle 仅在所有 v3 grants/pending/exposure 安全排空并确认其兼容性后部署。

## Open Questions

无。Deposit 原料明确不属于本次“基础矿物”范围；未来如需出售，必须以独立 capability 补齐 Factory 替代成本、floor 与 Shadow/Canary。
