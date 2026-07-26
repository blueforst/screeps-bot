## Context

当前 shard1 的 Direct X canary 已完成唯一真实成交：

- request：`direct:72585530:E6N59:X`
- transaction：`6a65f8e1656d080013d32210`
- 实际成交：E6N59 向 BUY order 出售 1,000 X，694.963 credits，394 energy
- 实际单位能量净价：682.33136，高于 600
- 成交后 terminal energy：28,899，高于 25,000

该交易已由两次独立 live 审查确认；outcome、transaction、库存、能量和 credits 一致，pending/quarantine/exposure/gap 均为零。旧实现随后持久化 `directPausedForReview=true` 并撤销 activation，因而不能执行第二笔。

用户进一步明确：常态出售不能只覆盖 X。tick 72585950–72586072 的 live 盘点显示，首批安全范围应为 X/H/Z，而不是无差别开放全部 terminal 物资：

| Entry | Live stock / protected / sellable | 当前最高安全机会 | 14 日稳健参考 | 首版净底价 |
|---|---|---|---|---|
| X / E6N59 | 191,388 / 112,100 / 71,047 | 694.963，净约 682.331 | 569.551，95%=541.074 | 600 |
| H / E3N59 | 517,301 / 动态保护 / 明确 surplus | 642.408，净约 627.949 | 450.300，95%=427.785 | hard 428 / economic 451 |
| Z / E7N57 | 245,738 / 动态保护 / 明确 surplus | 约 35.920，当前不安全 | 44.506，95%=42.281 | hard 43 / economic 45 |

U/L/K 虽有大量库存，但当前 BUY 净价低于历史经济底线；O/G 与当前 OH/T3 生产和战略储备相关；Boost、中间物、Factory 商品、Energy、Power、ops、Pixel 尚无完整替代成本与保护合同。因此首版只为 X/H/Z 建立 explicit lanes，低价 Z 自动等待。

现有 Direct 候选先按 capacity pressure、sellable 与 terminal stock 选唯一房间，再看该资源盘口。这一顺序适合一次性结构 canary，不满足多资源“最高单位净价优先”。生产保护也尚未纳入 `mineralExportStart`、Factory resource floor，以及尚未形成 transfer/reservation 的 Synthesis donor demand。

开源对照固定到 Overmind commit `5eca49a0d988a1f810a11b9c73d4d8961efca889`：

- `TradeNetwork.effectiveBuyPrice()` 会把 terminal 交易能耗折算成 credits 后再选择最高有效 BUY price；
- `TerminalNetwork.handleExcess()` 先尝试内部调拨，确无内部需求才出售 excess，并轮换 terminal 控制每 tick 工作量；
- 但它使用固定 `0.01` energy-credit multiplier、可变成交量和“接近满仓时更激进出售”的阈值，也没有本方案的历史底价、生产承诺、双读、permit/WAL/rolling quota。

本方案只借鉴“以交易能耗修正价格”“内部生产/调拨优先”“终端网络集中调度”三点；底价、固定 1,000、全局 tuple 排序和全部 fail-closed 证据以本仓库 live 数据与安全合同为准，不照搬 Overmind 的激进容量出售。

## Goals / Non-Goals

**Goals:**

- 支持逐资源 `shadow → one-shot canary → review_paused → continuous`，X 可精确复用已审 canary。
- 对所有已授权 lane 的 BUY 机会按动作后单位净价全局排序，批量、库存和容量压力不覆盖价格优先。
- 为每资源和账户全局同时执行持久 cooldown/rolling quota；跨资源仍只有一个 active pending。
- 加强生产保护，让基础矿出售不侵占本地底仓、Factory、Synthesis、Hub、Boost/War、调拨与 in-flight。
- 用不可变 permit 链、单调 attempt sequence、hash-chain receipt 和 checkpoint 抵抗 global reset、部分写入、误删与旧 bundle 回滚。
- 部署默认零写，按 X→H→Z 的资源级证据分阶段启用。

**Non-Goals:**

- 首版不出售 Energy、Power、ops、Pixel、G/O、U/L/K、反应中间物、T2/T3、Battery/bars、Factory/Deposit/seasonal 商品。
- 不自动加入新房间或新资源；发现库存或高价不能改变 canonical execution table。
- 不恢复 Maker/hybrid 或任何 legacy seller。
- 不用容量压力、等待时间或大订单量降低逐资源净底价。
- 不在 rolling 余量小于 1,000 时主动缩小计划批次；只有服务器实际部分成交可小于 1,000。
- 不尝试让软件抵抗能同时修改代码、配置和所有持久证据的恶意 operator；任何持久证据缺失只允许审计恢复，绝不自动获得新 canary。

## Decisions

### 1. Canonical execution table 与逐资源生命周期

配置规范化为按 `entryId` 排序的 execution table。每个 entry 冻结：

- `entryId`、`resourceType`、`allowedRoomNames`
- `requireNativeMineral`（X reviewed exception 为 false，H/Z 为 true）
- `hardFloor`、`economicFloor`、`laneReserve`
- `minOrderAmount`、`minOrderNotional`、`maxDealAmount`
- `cooldownTicks`、`rollingWindowTicks`、`rollingMaxAmount`
- `rollingOpportunityReserveAmount`
- `maxRawOrdersScanned`、`maxEligibleOrdersPriced`
- `maxTransactionEnergy`、`terminalEnergyReserve`
- resource policy revision/fingerprint

首版精确值：

| entryId | Resource / rooms | Hard / economic | Lane reserve | Min notional | Per deal | Cooldown | 30k cap | Safe-opportunity reserve | Max tx energy | Terminal energy reserve |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `base-x-e6n59-v1` | X / `[E6N59]` / reviewed exception | 600 / 600 | 100,000 | 600,000 | 1,000 | 1,000 | 8,000 | 1,000 | 1,000 | 25,000 |
| `base-h-e3n59-v1` | H / `[E3N59]` / native required | 428 / 451 | 100,000 | 451,000 | 1,000 | 1,000 | 8,000 | 1,000 | 1,000 | 25,000 |
| `base-z-e7n57-v1` | Z / `[E7N57]` / native required | 43 / 45 | 100,000 | 45,000 | 1,000 | 1,000 | 5,000 | 1,000 | 1,000 | 25,000 |

全局 `rollingWindowTicks=30,000`、`rollingMaxAmount=12,000`、`minConfirmedIntervalTicks=1,000`、每周期最多一笔、全账户最多一个 active Direct pending。
三个 entry 的 `maxRawOrdersScanned=1,000`、`maxEligibleOrdersPriced=200`；预算按每个 resource book 独立执行。任一有写 grant 的 entry book 越界使本 tick 全局零写；suspended Shadow entry 越界只重置本 entry Shadow，不得污染其他 entry 的可写 scope。

每 entry 独立保存 Shadow revision/fingerprint、consecutive cycles、qualifiedAt、canary evidence 与 stage。X 只能用上面的精确既有 outcome digest 从 `review_paused` 进入 continuous；H/Z 必须各自完成 100 个完整 Shadow 周期，再最多一笔 canary，确认后只暂停该 entry 等待审查。新增或暂停某 entry 不得清除其他 entry 的历史或额度。suspended Shadow 的 pricing/history、terminal、book 与已知 scoped protection 是 entry-local evidence：不完整时只重置本 entry；shared energy、permit、ledger、account、arbiter 与未知作用域 protection 仍是全局证据，任一不完整时全局零写且 Shadow 不推进。一旦 entry 获得 canary/continuous 写 grant，其 entry-local 输入不完整也恢复为全局零写。

Shadow 的“连续周期”按连续完成的规划观测计数，而不是要求相邻 `Game.time`。ResourceControl/市场规划可按 `t,t+10,...` 采样；同 tick 重入必须幂等，没有发生观测的中间 tick 不清零，只有显式 `incomplete`、fingerprint 变化或 tick 回拨才重新开始。Continuous 的 pricing result cache TTL 必须为 `min(100, planningSnapshotMaxAgeTicks+1)`；在当前 10 tick 证据窗口下，age 10 可复用，age 11 必须刷新。Maker 仍保留原 100 tick cache，不受该收紧影响。

所有 lane 每 tick 还必须证明房间自有、非 Hub、capacity state 非 emergency、terminal 正常；`requireNativeMineral=true` 时房间 mineralType 必须与 entry resource 完全一致。X/E6N59 是唯一首版非原生例外，只能由精确 reviewed X evidence 授权。

备选方案是一个全局 allowlist 布尔值。它会让 X 资格隐式扩散到其他资源并使单一配置漂移重置全部历史，因此拒绝。

### 2. Permit 是 append-only successor chain

市场写授权不直接读取可覆盖的 `enabled` 布尔值。系统只允许 permit 冻结的 `executorShard=shard1` 执行 account market 写，并保存该 executor shard-scoped permit history；每个 permit 包含：

- 单调 `epoch` 与由 canonical 内容生成的 `permitId`
- account identity、`executorShard`、capability/schema revision
- engine assumption commit 与共享 Direct fingerprint
- 排序稳定的 execution table，以及各 entry 的允许 stage/grant
- reviewed canary 的完整 canonical digest，而非仅 request/transaction ID
- 全局 quota/cooldown
- `previousPermitId`、`previousLedgerHead`、创建 tick/operator authorization fingerprint

创建首个 v2 permit 前，系统只接受当前 live v1 state 的精确安全迁移：schema=1、唯一 reviewed X confirmed outcome、count=1、pause=true、零 pending/quarantine/gap。迁移只生成 `readyForPermit`，不会写市场。迁移必须用冻结的 `canonicalStableHashV1` 和 golden fixture 构造唯一 ledger 起点：

- 固定 receipt genesis sentinel 为 `market-direct-continuous:v2:receipt-genesis`，permit genesis sentinel 为 `market-direct-continuous:v2:permit-genesis`；
- 把唯一 legacy X transaction 映射为 `attemptSeq=1`、`permitEpoch=0`、`permitId=legacy-v1-reviewed-seed`、`executionPolicy=legacy_canary_seed` 的 confirmed receipt；其 order/transaction/evidence、E6N59/X、`transactionTime=72585530`、actual 1,000、energy 394、gross/net 与既有 canonical outcome 必须逐字段一致；
- `prevHash` 为 receipt genesis sentinel，`eventHash=canonicalStableHashV1(canonical receipt payload)`，`headHash=canonicalStableHashV1({domain:"receipt-head-v2",prevHash,eventHash})`；
- prune checkpoint 初始为 `prunedThroughSeq=0/prunedHeadHash=receipt genesis sentinel`，`finalizedAttemptSeq=1`、`nextAttemptSeq=2`，global/X lifetime 均为 count 1、amount 1,000；若 transaction 仍在 `[migrationTick-29,999,migrationTick]`，它同时进入 global/X rolling bucket；
- `coverageStartTick=migrationTick-29,999`，并把精确 v1 安全状态、migrationTick 与上述 seed receipt 纳入 migration attestation；同时写入精确 processed evidence key `6a65f8e1656d080013d32210:6a65e025656d080013ccad03` 并纳入 golden hash；permit epoch 1 的 `previousLedgerHead` 必须等于该确定性 seed ledger head。

状态保存 `currentPermitEpoch/currentPermitId/permitChainHead` 以及不可回退的 `permitEpochHighWater/permitChainHeadHighWater`；ledger checkpoint 镜像这两个 high-water。迁移完成但尚无 permit 时 current/high-water epoch 为 0、current ID 为空、chain head 为 permit genesis sentinel。首个 permit epoch 必须为 1，previous permit ID 为空且 previous permit head 必须为 permit genesis sentinel；successor epoch 必须恰为 high-water+1，并同时引用 current permit ID、permit chain head 与当前 ledger head。current pointer 必须始终指向最高连续 epoch 的 chain tip；删除最后一个 successor、回拨 pointer/high-water 或恢复旧 permit 都进入持久 `permit_conflict`。

相同 permitId 重复签收时也必须先验证 executor shard、完整 chain/checkpoint 和已存 canonical permit 内容，再 no-op；由于 ledger 可能已前进，不再拿该旧 permit 的 `previousLedgerHead` 与当前 ledger head 比较。只有全新 successor 才检查签收当下的 current ledger head，且签收前必须为零 pending/quarantine/gap/unmatched reservation。每个写 grant 的 `lifecycleEvidenceDigest` 必须与 current lifecycle 完整 canonical digest 精确一致；同 stage 下删改 evidence 也立即失去写权。H/Z 从 `review_paused` 进入 continuous 时，operator 提交的 reviewed digest 必须精确等于 ledger 中本 entry 唯一 confirmed-canary receipt binding，独立 review 身份另由 permit 的 operator authorization fingerprint 冻结。epoch 空洞、同 epoch 不同 digest、同 evidence 指向不同内容、previous head 不匹配、在其他 shard 复用 permit 或覆盖既有 permit 均进入持久 `permit_conflict`。permit 必须先完整落盘并自校验，之后才可准备 pending。

配置新增 entry、推进 entry stage 或收窄写授权时，operator 创建 successor permit。Successor 必须引用前一 permit 与当前 ledger head，完整继承 rolling receipts、lifetime counters、attempt/permit high-water 和旧 entry lifecycle/evidence；配置 revision 不能重置额度。Successor MAY 把某 entry 的 new-deal grant 收窄为 suspended，或在本资源证据齐全时推进 stage，但不得删除 entry 历史、降低已冻结安全阈值或把 suspension 当成 quota reset。恢复被收窄 grant 也必须签收新 successor 并继承全部历史。未签收的新配置不影响旧 permit 的历史，但为避免配置/permit 两套解释，任何市场写只使用当前 permit 冻结表，配置与 permit 不一致时全局零写。

### 3. 全局最高单位净价 tuple 排序

规划对当前 permit 中所有可写 entry 的每个 allowed room 与完整 BUY book 生成 tuple。每个 tuple 必须通过：

- current-tick 生产保护与 terminal 实存
- 计划量固定 1,000
- 订单 amount/remaining 与 per-entry min notional；名义额只按本次固定 1,000 可执行计划量乘以 gross price 计算，不按整张 BUY order 剩余量计算
- transaction energy、25,000 terminal reserve 与最大能耗
- 动态可信历史、hard/economic floor 与 amount=1 最坏单位净价
- per-resource/global cooldown 与 quota
- 自有订单、Maker exposure、arbiter、credits 与 pending 完整性

安全 tuple 全局按以下稳定顺序排序：

1. 精确动作后单位净价降序；
2. 计划总净额降序；
3. gross price 降序；
4. `resourceType / sellerRoom / orderId` 升序。

capacity pressure、sellable、terminal stock 和订单剩余量只决定 eligibility，不进入价格之前。resource/global quota 与下述 safe-opportunity reserve 也只决定 tuple 是否进入可写集合；在可写集合内部仍严格执行上面的单位净价顺序。规划读取和写前读取都必须对全部可写 entry/lane 完整成功；任何可写 book 超预算或读取不完整时全局零写。第二次完整读取必须重取所有可写 BUY books、order tuple/remaining、terminal cooldown/stock/energy、current-tick protection revision/sellable、credits、transaction energy、动作后单位净价、amount=1 最坏净价、resource/global quota/opportunity reserve、permit/head 与 pending/arbiter 状态。任一 writable/shared/global 字段变化、任一门禁失效或最佳 tuple 与规划 tuple 不完全一致时本 tick零写，不在同 tick 临时换单，避免缺少第三次完整重验。suspended Shadow 仍随该周期做 entry-local 二读观察：两读 evidence 不完全相同则只把该 Shadow 周期记为 `incomplete`，不进入 writable scope hash，也不阻断其他稳定可写 entry；生产/仲裁等待只能在该 Shadow entry 自身完整后记为 `production_priority_wait`。

### 4. 生产保护公式按“库存目标”和“消耗承诺”分层

每个 room/resource lane 的本地底仓为：

`localReserve = max(mineralFloor, mineralExportStart, factoryResourceFloor, laneReserve)`

保护量为：

`protected = max(localReserve, absoluteTarget) + consumptiveDemand + criticalOutgoing + carrierInFlight + boostWar + hubCommitments + otherMarketExposure`

其中：

- `absoluteTarget` 是该资源本身必须达到的库存目标；
- permit 的 lane reserve 即该 lane 的显式 forecast buffer，已经进入 `localReserve`，不得另加一次；
- `consumptiveDemand` 是生产其他产品会消耗的原料，不与 target 取 max；
- Synthesis active/paused/config target gap 在 donor binding 或 transfer 尚未建立时也必须形成稳定承诺；
- 同一计划的 runtime/config/Hub 多视图按稳定 ID 去重，并取同计划最大值；
- blocked transfer 在取消或合同过期前继续保护；
- donor 候选资源和房间集合完整、只是最终 donor 尚未绑定时，阻塞该资源的全部候选 donor lanes；其他资源只有在各自输入与全局 coverage 完整时才可继续；
- donor 候选集合本身 stale、不完整、损坏或无法确定受影响资源时，保护 collector 不完整，所有 Continuous entry 本 tick 全局零写；
- 其他已知作用域的来源 stale、不可分配或无法解释时，只把能完整界定的受影响 lanes 完全禁止出售；任何无法完整界定作用域的错误都全局零写。

该变化首先保证 X/H/Z；也是未来加入 U/L/K 或商品前的生产侧修复。Factory commodity 与反应产物仍排除，直到其替代成本和更完整组件需求模型另立变更。

### 5. WAL 使用单调 attempt sequence 与固定提交前缀

Direct state schema 升级。所有资源和房间共用一个 pending slot 与单调 `nextAttemptSeq`。pending 在 `deal` 前冻结：

- `attemptSeq`、`executionPolicy=canary|continuous`
- `permitId/epoch`、entryId 与 resource policy fingerprint
- seller room/resource、order tuple、计划量/能量/净价
- resource/global rolling window start、写前 used、planned reservations 与固定 limits
- 既有 Direct 的全部物理、transaction-window、energy-shadow 和保护证据

旧 v1 pending 永远按 legacy X canary 解释；当前 permit 不能追认它。

sequence 必须满足无空洞不变量：

- 无 pending 时 `nextAttemptSeq = finalizedAttemptSeq + 1`，并且 latest finalized receipt 已有匹配 processed evidence key；
- active 且尚未写 receipt 时 `pending.attemptSeq = finalizedAttemptSeq + 1` 且 `nextAttemptSeq = pending.attemptSeq + 1`；
- receipt 已写但 pending 尚待最后删除的唯一合法前缀为 `pending.attemptSeq = finalizedAttemptSeq`、`nextAttemptSeq = finalizedAttemptSeq + 1`，并且 outcome/receipt/hash 必须精确匹配。

任何其他组合都表示 pending 被删、seq 跳号或终态分叉，必须在任何新写前持久锁死。

每个 attempt 的终态提交顺序固定为：

1. 写带 `outcomeEventHash` 的 bounded audit outcome；该 hash 覆盖全部终态字段与 pending frozen evidence hash；
2. 写 finalized attempt receipt，推进 receipt hash-chain/head、attempt high-water、lifetime checkpoint，并原子更新 confirmed rolling receipt；
3. 写 processed transaction/evidence key；
4. 删除 pending 并释放 claim/reservation。

receipt 公共字段至少包含 permitId/epoch、attemptSeq、status、entry/resource/room、order/evidence key、`resolvedAt`、`retentionTick`、`outcomeEventHash`、`prevHash/eventHash/headHash`，且必须与自认证 outcome 全字段绑定。Confirmed 另外必须有 transaction key、权威 `transactionTime`、actualAmount/energy/net，且 `retentionTick=transactionTime`；failed/not_filled 不得伪造 transactionTime，`retentionTick=首次 resolvedAt`、actualAmount=0。rolling amount 与 confirmed cooldown 只读取 confirmed 的 transactionTime/actualAmount；所有终态 receipt 的链保留和裁剪统一读取 retentionTick。Confirmed 以实际量替换同 request 的 resource/global planned reservation，不双计；failed/not_filled 只有终态 receipt 完整落盘后才释放 reservation。

preflight 必须在任何市场规划前运行，并收敛任意合法提交前缀。pending 后的 config/permit proposal/stage 变化只阻止新规划；已有 pending 始终按冻结证据继续对账，只有冻结证据无法自校验时才进入 safety blocker。bounded outcome 已按规则裁剪但完整 receipt/head/checkpoint 仍可验证时是合法终态；仅当 receipt 不能由现存 outcome、pending 或连续 checkpoint 唯一证明、同 seq 不同 hash、processed key 缺失且无法从最新 receipt 幂等补齐、head 分叉或无法唯一补记时，才进入不可由普通配置清除的 safety blocker。

### 6. Coverage、裁剪和双层额度

rolling 窗口精确定义为 `[tick-29,999, tick]`。每个 confirmed receipt 同时进入对应 resource bucket 与 account-global bucket；仍在窗口内的 X canary 同时计入 X/global。准备新 pending 前：

- `resource confirmed actual + unmatched active planned + 1,000 <= resource cap`
- `global confirmed actual + unmatched active planned + 1,000 <= 12,000`

任一余量小于 1,000 都等待。服务器实际部分成交只按 actualAmount 消耗额度，但任何正成交都触发该 resource 与全局 1,000 tick cooldown。

为避免绝对 credits/unit 让低单价资源永久饥饿，每个处于 canary/continuous 且 current full read 存在至少一个“除 global quota 外全部门禁均通过”的安全 tuple 的资源，拥有 1,000 的 `rollingOpportunityReserveAmount`。其未满足量为：

`unmetOpportunityReserve(resource)=max(0,1,000-resourceWindowConfirmed-resourceUnmatchedPlanned)`

候选资源 `r` 只有在下面的 admission 也成立时才进入可写集合：

`globalConfirmed + globalUnmatchedPlanned + 1,000 + sum(unmetOpportunityReserve(other safe resources)) <= 12,000`

候选自己的 unmet reserve 由本次 1,000 消耗，不重复相加。没有安全 tuple、resource quota 不足、shadow/review_paused/suspended 的资源不占 opportunity reserve；一旦它后来出现安全机会，其他资源不得继续补满为它保留的下一个 global slot。首版三个 reserve 合计 3,000，小于 global cap；任何 successor 若使同时可写资源的固定 reserve 总和超过 12,000 必须 invalid。该机制只改变 quota admission，绝不能按订单量、库存或等待时间重排已准入 tuple。

ledger 保存单调 receipt seq、prev/head hash、`coverageStartTick`、prune checkpoint、lifetime count/amount（global + per resource）和至少 512 条 finalized receipts。每个 entry 首次 confirmed canary 还形成 `{entryId,attemptSeq,evidenceKey,receiptEventHash,reviewedEvidenceDigest}` 单调高水位；receipt 被裁剪时该高水位吸收到 checkpoint，并由绑定 `prunedThroughSeq/prunedHeadHash/confirmedCanaries` 的 `confirmedCanaryCommitment` 自校验。删除 top-level/checkpoint 两份高水位或回拨 lifecycle 都必须持久闭锁，不能产生第二笔 canary。只有 receipt 的 `retentionTick < tick-29,999` 且 checkpoint 已连续吸收其 seq/hash/lifetime/上述 canary commitment 时才可由满 512 ring 的追加路径裁剪；不存在可由调用方降低保留数的旁路。quota 仍只按 confirmed `transactionTime` 判断窗口。30,000 tick 内在 1,000 confirmed cooldown 下最多 30 个 confirmed；failed/not_filled 另有全局 `retryNotBefore=attemptAt+100`，512 条足以覆盖理论窗口。任何断链、逆序、重复冲突、窗口 coverage 不足或超理论界限均全局零写。

### 7. 状态缺失与旧 bundle 回滚永久 fail-closed

新 bundle 永久退役旧 `market-direct-canary` 写路径。v2 state/permit/ledger 缺失时不得创建“fresh canary”；只能设置 `direct_state_missing` 并等待审计恢复。完整删除 Memory 不会获得额外一笔免费 canary。

最低兼容 predecessor 固定为 `669bce3`。受控回滚 MUST 保留 v2 state，使该旧 normalizer 看见新 schema 并设置 unsupported blocker；它随后可能丢弃未知 Continuous 字段，所以新代码再次升级时若看见 schema1 + unsupported marker、confirmed count>1、非唯一 legacy outcome 或任一 rollback fingerprint，必须设置 `rollback_evidence_lost`，不得重新执行 v1→v2 bootstrap。旧代码本身无法防御 operator 在回滚期间连 schema/unsupported marker 一并删除，因此 pre-rollback 合同禁止删除或重建该 state；无法证明保留时不得运行旧 bundle。

不使用 RawMemory segment 保存第二副本；当前 telemetry 会覆盖 active segment 列表。安全性由 fail-closed migration、permit/receipt chain、checkpoint 和 operator evidence recovery提供。

### 8. 分阶段部署与启用

1. 隔离 worktree 实现并通过独立审查。
2. 部署时保留现有 live config，v2 仅迁移为 `readyForPermit`，零写。
3. 读取 live root/entry fingerprints、X evidence digest、ledger head，签收 permit epoch 1：
   - X：continuous；
   - H/Z：shadow。
4. X 可按 1,000/30,000/8,000 与 global 12,000 运行；H/Z 同时累计各自 100 个完整 Shadow 周期。
5. H/Z qualified 后，successor permit 可把一个 entry 推进 canary。它最多确认一笔后自动进入该 entry 的 `review_paused`，其他 entry 历史不变。
6. 独立审查实际 H/Z transaction 后，再用 successor permit 推进 continuous。Z 在净价低于 43/45 时无限等待，不因 qualified 而强卖。
7. `emergencyStop` 立即禁止新 pending，但 preflight 继续收敛所有资源 WAL。回滚前要求 pending/exposure/sync gap/staging/reservation 全零。

## Risks / Trade-offs

- [多资源读取增加 CPU] → 仅三个 explicit lanes；每 entry raw/eligible order scan 有界，可写 entry 超预算全局零写，suspended Shadow 超预算只重置本 entry，观测 CPU。
- [绝对 credits/unit 会让高价值资源长期优先] → 可写集合内部保持价格优先；每个当前确有安全机会的资源以 1,000 safe-opportunity reserve 防止永久饥饿，订单量和库存仍不能插队。
- [H/Z 新资源尚无真实 canary] → 各自 100 Shadow + one-shot + review，不继承 X。
- [生产需求尚未形成 transfer] → 直接从配置、target gap 和 donor 候选生成 consumptive commitment；无法唯一解释时禁售。
- [permit 配置复杂] → runtime 输出 canonical proposed permit/fingerprint；operator 只回填精确 ID，不手工重算。
- [Memory 体积增加] → bounded audit outcomes + 512 receipt ring + checkpoint；不保存完整盘口。
- [回滚会丢未知字段] → 回滚再升级永久锁死并要求 evidence recovery，不自动重建。
- [Z 当前价格不安全] → Shadow/continuous 都记录 `below_floor` 并零写，绝不以库存压力降价。

## Migration Plan

1. 冻结 `669bce3` legacy state fixture、live X outcome digest 与预期 migration hash。
2. 实现生产保护修复、canonical entry config、逐资源 Shadow 与全局 tuple 排序。
3. 实现 permit/attempt/receipt/checkpoint schema 和所有中断恢复测试。
4. 完成相关与完整测试、静态唯一写入口、OpenSpec strict 和独立 subagent review。
5. 合并 main、部署零写、核对 migration/permit proposal 与 live 库存/盘口。
6. 签收 epoch 1 并启用 X continuous + H/Z Shadow；验证 X 下一笔及 cooldown/rolling。
7. H/Z 各自达到 100 周期后按 successor permit、canary、独立复核和 continuous 顺序推进。
8. 任何 P0/P1 或 live 不一致时关闭新 permit 写、保留 WAL/ledger 证据并先完成对账。

## Open Questions

无。首批 execution table、底价、lane、资源级额度和全局额度均由当前 live evidence 固定；U/L/K 与其他商品必须另立 successor evidence。
