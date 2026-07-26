## Context

当前部署 `2026.7.26-2+abbad70` 已将旧 ResourceControl/Factory 出售入口关闭，并以 Maker-only 市场自动化运行 Shadow。2026-07-26 的 shard1 实时证据显示：

- E6N59 有 192,388 X，总保护量 112,100，Terminal 中有 72,047 X，保护账本给出的可售量为 72,047；
- X 的 hard floor 与 economic floor 都是 600，14 个完整历史日可信，可信历史底价为 541.074；
- BUY 盘口最高有效订单为 665.8 × 1,000，SELL 盘口只有两个达到 1,000 数量门槛的不同房间；
- 现有 Shadow 将 `trustedDepth` 绑定到 SELL 侧 Maker 参考盘，因达不到 3 单、3 房间和 3,000 深度而拒绝全部房间；
- `rankDirectBuyOrders` 已能计算部分成交和交易能量净价，但没有生产运行时调用方；
- ResourceControl 只在采样 tick 生成完整候选，后续 tick 会用空输入覆盖 runtime 投影，导致 monitor 通常显示空候选和空拒绝原因。

Direct 是主动成交：本方选择他人的 BUY order、指定确切成交量和房间，并承担 terminal 交易能量。它不创建自有订单，因此没有 Maker 的建单费、订单 ID 归属和 mutation lease 问题，但仍需要生产保护、动作前订单重验、terminal 仲裁、持久写前状态和成交对账。

## Goals / Non-Goals

**Goals:**

- 对高于有效净底价的真实 BUY order 进行部分成交，优先最高交易能量净价，而不是要求单张订单吃下整个计划批次。
- 将 Direct Shadow 与 Maker Shadow 解耦；SELL 侧深度不足不得阻塞 Direct 机会。
- 单张高价 BUY order 可以成为 Direct 机会，但绝不成为长期价格参考；历史、hard/economic floor 继续决定安全底线。
- 复用当前 tick 的生产保护账本，并在写前重验订单、库存、terminal energy、配置、canary 和 arbiter claim。
- 为主动成交建立可审计、可对账、可 emergency-stop 的持久生命周期。
- 首次只执行一次、最多 1,000 X 的动态 Direct canary，确认成交后自动暂停等待复核。
- 非规划 tick 保留最后一次完整诊断快照，让 operator 能持续看到真实卡点。

**Non-Goals:**

- 不实现 Maker 与 Direct 自动混合、订单梯度扫单或同 tick 多订单连续成交。
- 不降低 X 的 hard/economic floor，不以容量压力、SELL 侧稀疏或高库存为理由接受低价。
- 不自动出售 Hub、capacity emergency 房间或未进入 allowlist 的资源。
- 不复活旧 `resourceControl.market`、`factoryControl.market` 或其他业务模块的直接市场写入口。
- 不在本变更中自动扩围到第二个房间、第二种资源或第二笔确认成交。
- 不把单张高价 BUY order 写入可信历史、ratchet floor 或 Maker 参考价格。

## Decisions

### 1. 显式区分生命周期模式与 Shadow 策略

配置新增：

```text
mode: off | shadow | maker | direct | hybrid | emergencyStop
shadowStrategy: maker | direct
maxDirectDealAmount
maxDirectDealsPerCycle
minDirectOrderAmount
minDirectOrderNotional
maxDirectRawOrdersScannedPerCycle
maxDirectEligibleOrdersPricedPerCycle
maxDirectTransactionEnergy
directCanaryMaxConfirmedDeals
energyShadowHardFloor
planningSnapshotMaxAgeTicks
```

`mode=shadow` 且缺少 `shadowStrategy` 时保持现有 Maker 兼容行为。`mode=direct` 是新的显式写授权；它不会由 `shadow`、`maker` 或 `hybrid` 隐式进入。`hybrid` 继续 fail-closed。

Direct 资格使用独立的 `directSafetyFingerprint`。它把 Shadow 与 active Direct 都规范化为同一个 `strategy=direct`，包含 config revision、所有底价、历史阈值、Direct 数量/能量限制、canary 策略、allowlist 和生产保护策略，但明确不包含生命周期 `mode`。因此唯一允许保留资格的模式边是同一 revision、同一 fingerprint、同一 canary 下的 `shadow(strategy=direct) -> direct`；切到 `off`、`maker`、`hybrid`、`emergencyStop`，或经由这些模式再返回，均清空资格。Maker Shadow 证据不能用于 Direct；任一 fingerprint 字段变化都清空 Direct Shadow 连续计数和旧 canary lock。

选择独立 Direct 模式而不是把 `maker` 改成“机会好时直接成交”，是为了保证部署后不会因盘口变化突然切换副作用类型。

### 2. 将结构候选与即时成交机会分离

每个完整 ResourceControl 周期先从保护账本生成结构候选：

```text
DirectStructuralCandidate {
  roomName
  resource
  protectionRevision
  terminalStock
  sellableAmount
  effectiveNetFloor
  capacityState
  terminalCooldown
  terminalEnergy
  rejectionReasons[]
}
```

结构候选只验证生产、房间、terminal、历史和底价事实，不要求当前必须存在高价 BUY order。Direct canary 从无结构拒绝的候选中动态锁定唯一 `room/resource`；首版仍排除 Hub 和 capacity emergency，但允许 pressure，因为成交会释放容量且不能降低底价。多个结构候选必须按 `pressure 优先 -> sellableAmount 降序 -> terminalStock 降序 -> roomName 升序 -> resource 升序` 确定性排序，BUY 机会只能在结构 lock 完成后评估，不得反向改变 canary；输入排列、global reset 或对象遍历顺序不得改变 lock。

锁定后再生成即时机会：

```text
DirectOpportunity {
  orderId
  orderRoomName
  orderPrice
  observedOrderAmount
  dealAmount
  transactionEnergy
  effectiveEnergyShadowPrice
  energyShadowComponents
  energyShadowObservedAt
  netCreditsMilli
  worstCaseNetCreditsMilli
}
```

没有达到净底价的 BUY order 是 `safe_no_opportunity`，不是规划失败。只要市场读取、可信历史、底价和保护账本完整，该周期仍可计入 Direct Shadow。这避免要求同一张短生命周期买单连续存在 100 个规划周期。

### 3. Direct 不使用 SELL 参考深度作为硬门禁

Maker 需要 SELL 侧可信参考盘来决定挂单价格；Direct 以对手 BUY order 的确定报价立即成交，二者风险不同。Direct 的长期底价继续来自：

```text
effectiveNetFloor =
  max(hardFloor,
      economicFloor,
      trustedHistoryFloor,
      previousTrustedFloor * 0.95)
```

交易能量也必须使用不能被低配置压低的可信价格：

```text
effectiveEnergyShadowPrice =
  max(energyShadowHardFloor,
      explicitEnergyShadowPrice,
      trustedFreshEnergyHistoryFloor,
      previousTrustedEnergyShadowPrice * 0.95)
```

`explicitEnergyShadowPrice` 只能抬高结果，不能替代或压低可信新鲜历史；历史、ratchet 或 hard floor 任一必需输入缺失时 Direct fail-closed。首发 `energyShadowHardFloor=20`，仍以更高的实时可信历史值为准。

Direct 盘口只过滤：

- 非 BUY、资源不符、无房间、无效价格或无效数量；
- 自有订单；
- `amount < minDirectOrderAmount`；
- `price * executableAmount < minDirectOrderNotional`；
- 动作后净价低于 `effectiveNetFloor`；
- 超出 terminal energy 或配置能量预算。

Direct Shadow 和 active 每个完整规划周期都必须绕过 Maker 的 100-tick 订单缓存，读取 current-tick 完整 BUY book；写前重读并重排同一资源的 current-tick BUY book，证明已选订单仍是最高安全净价。先对最多 1,000 张 raw order 做 O(N) 的 type/resource/room/own/amount/notional 和 `orderPriceMilli >= effectiveNetFloorMilli` 确定性便宜过滤；尘埃单及 gross 已低于净底价、无需能量即可证明不安全的订单不占能量定价预算，并记录 `gross_below_floor`。只有通过基础过滤的 eligible orders 才进入能量计算，首发最多 200 张。raw 超过 `maxDirectRawOrdersScannedPerCycle`、eligible 超过 `maxDirectEligibleOrdersPricedPerCycle`、读取失败或盘口发生不可解释变化时，本 tick fail-closed，不得截断后选择或继续吃旧缓存中的较低价单。

每次 Direct write 前还要求 `Game.market.orders` 中不存在任何 `remainingAmount>0` 的自有 BUY/SELL order（无论 `active`），Maker managed/pending/exposure 全零，且旧出售入口关闭。官方引擎会在 terminal 库存、credits 或容量条件后续恢复时把 inactive order 重新 active；因此带 remaining 的休眠低价 SELL/BUY 仍可能在之后异步成交。检测到这类订单时分别投影 `manual_sell_order_present` / `manual_buy_order_present` 并等待，绝不自动取消。只有 `remainingAmount===0` 的空订单可保留观测且不阻塞 Direct。

首版不要求“至少 3 张净价安全 BUY order”。单张订单不会改变长期参考，只能按其确切报价成交；对手在动作前撤单只会令重验失败或 `deal` 返回非 OK，不会产生低价滑点。Direct BUY book 的订单数、不同房间和深度仍投影为观测信息，但不作为单张安全成交的替代底价。

现有 `directDiscountRatio` 不再要求 Direct 相对稀疏 SELL 参考价达到某个比例。首版只比较经过能量影子成本后的确切净价与有效净底价；否则当前 665.8 的真实买单会被 1,120.638 的稀疏卖盘错误阻塞。

### 4. 部分成交并按净价严格排序

每张订单的理论成交量为：

```text
dealAmount =
  min(order.amount,
      protection.sellableAmount,
      terminal.resourceStock,
      maxDirectDealAmount)
```

`order.amount` 小于全局可售量不是拒绝条件。只有 `dealAmount` 小于 `minDealAmount` 或 Direct 最小订单量时才拒绝。

交易能量必须按该订单和该实际数量计算：

```text
directNetPrice =
  order.price
  - calcTransactionCost(dealAmount, sourceRoom, order.roomName)
    / dealAmount
    * effectiveEnergyShadowPrice
```

由于 Screeps 市场处理器可能把已提交数量缩小为任意正整数，提交量的单位净价安全并不自动证明实际部分量安全。官方交易费是 `ceil(amount * rate)`，其中 `0 <= rate < 1`；对任意正整数数量，单位能耗 `ceil(amount*rate)/amount <= 1`，跨房交易在 `amount=1` 时恰为 1，同房为 0。因此无需对每张订单做 O(amount) 枚举，精确最坏单位能耗可用一次 `calcTransactionCost(1, ...)` 证明：

```text
worstCaseActualNetPrice =
  order.price
  - calcTransactionCost(1, sourceRoom, order.roomName)
    * effectiveEnergyShadowPrice
```

所有安全比较使用现有 milli-credit 保守整数合同，不直接比较浮点净价。订单收入按允许精度向下取整，energy shadow 与有效底价向上取整；对计划量和最坏数量都必须满足：

```text
floor(order.price * 1000) * amount
  - transactionEnergy * ceil(effectiveEnergyShadowPrice * 1000)
  >= ceil(effectiveNetFloor * 1000) * amount
```

只有计划量与 `amount=1` 的最坏不变量都成立才可提交。候选持久保存整数 `netCreditsMilli`、`worstCaseNetCreditsMilli` 和 amount；浮点净价只用于展示。比较单位净价时先比较 `floor(netCreditsMilli/amount)`，商相同时只对两个小于 amount 的余数做交叉乘法，避免大总额交叉乘法溢出；任何 safe-integer 边界失败都拒绝。每周期对最多 1,000 张 raw order 做便宜过滤，再对最多 200 张 eligible order 以每张常数次能量计算完成全量排序；超预算整周期 fail-closed。这样既不会因并发缩量、浮点误差或排序近似穿透/错排，也不会产生“订单数 × 成交量”的 CPU 放大。

候选排序顺序为：

1. 用整数商/余数精确比较的 `netCreditsMilli / dealAmount` 降序；
2. `netCreditsMilli` 降序；
3. 向下取整后的原始 `orderPriceMilli` 降序；
4. 稳定的 `order.id` 升序。

每个完整规划周期只选择第一张订单。若它在写前变化或失败，本 tick 不自动降级到第二张；下一完整周期重新读取和排序。这样不会因最高价单刚好消失而在同 tick 意外成交到明显更低的备选单。

### 5. 写前重验与统一 terminal 仲裁

Direct executor 只在以下条件全部成立时写入：

- `mode=direct`、配置有效，且 Direct Shadow 证据的 revision、`directSafetyFingerprint`、canary 与当前值完全匹配；
- 已锁定唯一 canary，且确认成交数未达 canary 上限；
- 当前为完整 ResourceControl 规划 tick；
- 保护条目 revision/observedAt/expiresAt 都等于当前 tick；
- 排除已有 pending Direct exposure 后仍有足够 sellable amount；
- current-tick BUY book 重读与完整重排仍把同一个 order ID 选为最高安全净价，且 `getOrderById(orderId)` 的 type/resource/room/price/amount 与计划完全一致并可覆盖成交量；
- `Game.market.orders` 中没有任何 `remainingAmount>0` 的自有 BUY/SELL order（无论 active），Maker managed/pending/exposure 全零，且不存在已经选出 current-tick 可执行订单并通过本地写前检查的生产 emergency buy 或其他市场 action intent；只有需求但没有安全订单不得产生空 intent；
- 重新计算后的完整提交量 transaction energy、energy reserve、保守 milli-credit 净价，以及 `amount=1` 的 `worstCaseNetCreditsMilli` 都安全；
- terminal 当前资源量、cooldown 和 energy 足够；
- 该房间本 tick 没有 terminal claim，且账户级 market arbiter claim 可被 Direct 独占到 `attemptAt+1` 的最早 preflight；之后长期只保留资源/能量 reservation 与账户 action journal；
- 全局 Direct action budget 和同房动作预算均未用完；
- 没有 unresolved pending Direct、reconcile gap 或 emergency stop。

调用必须经过 `marketActionArbiter.executeMarketDeal`。新建 `prepared` 时即保守预留本房 terminal 与账户级 market claim；返回 OK 或调用抛出/结果不确定时，该账户级 claim 只保持到 `attemptAt+1` 的最早 Direct preflight（它必须先于其他市场动作运行），只有明确返回非 OK 才可同 tick 提前释放。完成首个 preflight 后释放账户级 claim，让 Factory/Boost/emergency buy 恢复；若首个证据缺失则 Direct 进入 gap，但不能无限期阻塞生产购买。pending exposure 仍同时预留待售资源和 `transactionEnergy`，后置 generic Carrier（包括 terminal-energy withdraw）、remoteCarrier、Synthesis、购买和其他 terminal/market 使用者只能使用扣除 reservation 后的余量。Direct executor 之外的生产源码仍不得直接调用 `Game.market.deal`。生产模块只有在选出 current-tick 可执行订单并通过本地价格、数量、能量与订单重验后，才在 `executeMarketDeal` 紧前声明 intent；此时必须优先生产、Direct 本轮等待。只有需求但没有安全订单时不得制造空 intent 或永久清零 Shadow。gap 期间生产市场动作可以继续，但全部写入账户 action journal，且不得释放 Direct exposure 或恢复 Direct 写。

### 6. Pending Direct 写前日志和成交对账

调用前持久化唯一 `pendingDirectDeals[requestId]`：

```text
PendingDirectDeal {
  requestId
  status: prepared | submitted | reconcile_gap
  configRevision
  directSafetyFingerprint
  canaryRoomName
  resource
  orderId
  orderRoomName
  observedOrderPrice
  observedOrderAmount
  dealAmount
  transactionEnergy
  effectiveEnergyShadowPrice
  energyShadowComponents
  energyShadowObservedAt
  netCreditsMilli
  worstCaseActualAmount: 1
  worstCaseNetCreditsMilli
  effectiveNetFloor
  effectiveNetFloorMilli
  protectionRevision
  terminalResourceBefore
  terminalEnergyBefore
  terminalCooldownBefore
  creditsBefore
  preparedAt
  attemptAt
  outgoingTransactionKeysBefore[]
  outgoingWindowBefore
  firstPostAttemptObservation?
  successfulMissingObservationTicks[]
  submittedAt?
  resultCode?
}
```

同一 Direct store 还保存 `quarantinedPendingDirectDeals`。它接收无法通过完整 schema 校验或 statement-boundary 恢复的原始 pending/容器证据，也承接首次兼容迁移时损坏的顶层 market-sale container、canonical Direct container、legacy pending alias，以及损坏的 Maker `managedOrders`/`pendingMutations` 容器或单条记录和 `pendingCreate`。完整校验不仅检查容器/字段类型，还检查生成态交叉不变量：Maker managed remaining/exposure、mutation pre/requested/conservative exposure、按动作/价格/数量精确重算的 prospective fee 和同 orderId managed sibling，以及 pending-create baseline hash/keys、时间窗、精确 create fee 和 `exposure === tuple.totalAmount`；近似合法但欠保护或低报 fee debt 的对象与 orphan pending mutation同样必须隔离。合法 CPU cut 若留下 orphan 也宁可要求 operator 收敛，不能把未知 SELL mutation 当作零 exposure。损坏记录绝不能流入定价、投影或生命周期算术：实现先在局部完成完整 schema 校验和新状态构造，再以一次 canonical market-sale container assignment 同时提交 quarantine/blocker 与 typed 清理。CPU 若在 commit marker 前中断，原记录仍在；若在其后中断，原始 sentinel 已与清理一同持久化。quarantine 非空或 intent/market-data 相关 migration blocker 存在时，Direct 与 Maker 均零写；这个 latch 必须在 Maker reconcile、prepared retry、drain cancel 和规划之前成立，只允许只读投影保守 exposure/drain，不能借 emergencyStop 自动撤单。由于损坏记录无法可靠归属 room/resource，生产保护和所有 Terminal 消费全局 fail-closed，直到 operator 用权威证据修复。只有 canonical Direct 与 legacy alias 同时缺失或 alias 为显式空对象时才能初始化空状态；present-but-malformed 绝不能当成空迁移。仅 Shadow qualification 计数损坏不阻断生产，也不得掩盖后来发现的结构损坏：当前 tick 清空资格并阻止新 deal，但完整 Direct pending 仍继续自动或 exact-operator 对账；归一化后的下一 tick 清除 qualification-only blocker，允许从零重新跑 Shadow。

`attemptAt` 在调用前固定为当前 `Game.time`；同时保存提交前 `outgoingTransactions` 的有界 key 基线与窗口边界。同 tick 只有创建该 `requestId` 的 executor 可以把新建的 `prepared` 记录提交一次。`deal` 明确返回非 OK 时先把 `failed` outcome 写入有界审计历史，再从 active pending 删除并释放 exposure；同 tick 不尝试第二张订单。返回 OK 时依次写 `resultCode`、`submittedAt`，最后才把 `status=submitted` 作为 commit marker，其数量和能量作为保守 exposure 继续进入保护账本，直到下一 tick 的最早 preflight 读取 `Game.market.outgoingTransactions`。

交易只能由同时满足下列条件的唯一新记录确认：

- transaction key 不在 `outgoingTransactionKeysBefore` 中且尚未被幂等处理；
- `transaction.time === attemptAt`；
- `order.id/type/price` 分别等于 pending order、`ORDER_BUY` 和 observed price；
- `from === canaryRoomName`、`to === orderRoomName`、resource 一致；
- `0 < actualAmount <= dealAmount`；
- 在同一 attempt tick 内只有这一张记录匹配；多张匹配视为归属歧义。

市场处理器可能因更近玩家先成交、买方剩余容量或信用变化，把实际成交量缩小到任意正数。唯一匹配后，用实际数量重新计算取整交易能量，并按 pending 冻结的 `effectiveEnergyShadowPrice`、components/observedAt 与底价做保守 milli-credit 总额核对。通过后把 `confirmed` outcome 写入有界审计、confirmed count 只增加一次、释放整个一次性 intent 的资源与能量 exposure，不把未成交余量视为仍在服务器排队；例如提交 1,000 实际成交 1 时释放其余 999，但仍只算一笔确认。实际净价低于底价、数量超限、历史同 tuple 记录、同 tick 多条匹配或其他字段不一致一律进入安全违规与 `reconcile_gap`。

任何跨 tick 仍为 `prepared` 的记录都视为“可能已经调用 deal、但在写回 submitted 前 CPU 中断”的不确定 intent，与 `submitted` 同等冻结新写并进入对账；系统绝不能重新提交它。normalizer 只恢复实现明确产生的 statement-boundary 半状态：`submitted` 但缺 `submittedAt` 恢复为 `prepared`；prepared/submitted 已保存 changed 首观测时恢复为 `reconcile_gap`。其他未知半状态一律进入 quarantine。首次成功缺失观测必须发生在 `attemptAt + 1`，持久保存 observedAt、transaction window 是否完整、terminal resource/energy/cooldown/credits 与前态的逐项比较结论；若 CPU 在首个 unchanged observation 后、missing tick 写入前中断，该 observation 的 observedAt 必须恢复为第一个成功 tick，不能用后续 tick 替换。只有 outgoing 窗口明确覆盖 attempt tick，且两个不同 tick 的成功读取都没有唯一匹配交易，第一 tick 四项前态完全未发生该 intent 的预期变化，才能写入 `not_filled` outcome、删除 active pending 并释放 exposure。两次成功 tick 必须逐个持久记录；重启、跳过首个 tick、重复读取同一 tick、窗口已截断或任一状态差异无法唯一解释时不得用墙钟时间猜测，必须进入 `reconcile_gap`。

`pendingDirectDeals` 只保存 active 的 `prepared/submitted/reconcile_gap`，三者都计入待售资源和交易能量 exposure。`confirmed/failed/not_filled` 以及 operator resolution 结果移入最多 50 条的 `directDealOutcomes` 审计环；先持久化 outcome 再删除 active pending，保证 drain 可以达到真实零且结果可追溯。

提供 Direct 专用、默认拒绝的 `marketSaleApi.resolveDirectPending`。它必须指定 exact request/order，且只能接受两类可核验证据：当前或 operator 捕获的权威 outgoing transaction 快照中的 exact transactionId/完整 engine tuple；或覆盖 `attemptAt` 的权威无成交窗口加保存的 terminal/credits 前后快照。API 必须重新做数量、价格、实际能量净价和幂等核对，持久记录 evidence source/key、operator、resolvedAt 与结果；operator no-fill 还必须持久化完整窗口内容、边界和物理快照的稳定 `operatorEvidenceFingerprint`。只有 operator、evidence key 和该指纹均完全相同才是幂等重复；同 observedAt/交易条数但交易内容或物理快照变化必须视为证据冲突并不可逆暂停。证据只能证明 `confirmed` 或 `not_filled`，不能直接“清除”。operator-confirmed 必须复用自动确认的同一个原子 finalize：幂等 key、confirmed count 只增加一次，并在达到 1 时同时进入不可配置解除的 `paused_for_review`；重复 resolution 不得再次计数。证据缺失、相互矛盾或无法覆盖时间窗时保持 `reconcile_gap` 和完整 exposure。resolution 成功后仍需连续两 tick 证明 active pending/exposure 为零，才可完成 emergency stop 或旧 bundle 回滚。

Screeps 官方引擎在同一市场处理周期内若 BUY order owner 请求改价，会先把该订单标记为 `_skip`，随后忽略针对它的 deal intent；成交记录使用处理周期中的订单价格。因此同 tick 改价应表现为零成交，而不是低价滑点。实现仍必须以实际 outgoing transaction 价格做最终安全核对，不能只依赖这一引擎细节。

Direct 没有 create fee 或 fee debt，不复用 Maker 的 pending create/mutation 语义；但 emergency stop 和旧 bundle 回滚门槛必须同时要求 pending Direct 与 Direct exposure 为零。

### 7. Direct Shadow 资格是“安全决策完整”，不是“机会持续存在”

Direct Shadow 每个完整 ResourceControl 周期运行与 active Direct 相同的：

- 保护账本和结构候选；
- BUY 订单读取、过滤、实际部分量、能量和净价计算；
- canary 选择；
- 写前重验的只读版本；
- pending/reconcile 前置条件检查。

满足以下条件时记为一个完整 Direct Shadow 周期：

- 配置 revision/`directSafetyFingerprint` 与上周期一致；
- 唯一结构 canary 已锁定且本周期仍可解释；
- 保护账本、历史和 energy shadow 新鲜可信；
- BUY order API 读取成功；
- 每张被接受或拒绝的订单都有原因；
- 结果是安全机会或 `safe_no_opportunity`；
- 市场写、terminal claim 和 market staging 全为零。

SELL 侧 Maker 深度不足不得让 Direct Shadow 清零。配置变化、保护缺失、市场读取失败、安全不变量失败或出现未知 pending 状态时，计数清零。

Direct active 至少需要 100 个连续完整周期。资格状态还要记录最后一次合格的生命周期状态；仅允许从合格的 `shadow(strategy=direct)` 直接切到 `direct` 时保留。旧 Maker Shadow 计数、旧 revision、经过其他 mode 的状态或旧 canary lock 不能继承。

### 8. Canary 首次确认成交后自动暂停

首发 Direct canary 配置固定：

- allowlist 必须恰为 `[X]`，且 `expansionGrant=false`；
- 动态选择一个非 Hub、非 emergency 房间；
- `minDirectOrderAmount=1,000`；
- `minDirectOrderNotional=600,000 credits`；
- `maxDirectDealAmount=1,000`；
- `maxDirectDealsPerCycle=1`；
- `directCanaryMaxConfirmedDeals=1`；
- `maxDirectRawOrdersScannedPerCycle=1,000`；
- `maxDirectEligibleOrdersPricedPerCycle=200`；
- `maxDirectTransactionEnergy=1,000`；
- `terminalEnergyReserve>=25,000`；
- `energyShadowHardFloor=20`，且可信新鲜历史必须可用；
- X hard/economic floor 均不低于 600；
- forecast buffer 不低于 100,000；
- 旧 ResourceControl/Factory 出售保持关闭。

normalizer 和 active gate 必须把上述首发 policy 当作代码级安全合同，而不是部署建议；资源扩展、数量/次数超限、floor/buffer/terminal energy reserve 下调、`maxDirectDealAmount < max(minDealAmount,minDirectOrderAmount)`、扫描预算越界或 expansion grant 打开均使配置无效、资格清零且零 deal。后续扩围另开 change。

第一笔交易确认后状态进入 `paused_for_review`，它在本 change 内是不可由配置解除的持久终态。系统继续对账和投影，但 Direct Shadow 不再累计资格且 `activationAuthorized` 始终为 false；即使出现新的高价买单、只修改 config revision、重跑 100 个 Shadow 周期或打开 `expansionGrant` 也不得执行第二笔。只有未来独立 OpenSpec/capability delta 和重新实现审查才能扩围。

### 9. 保留最后完整规划快照

runtime 分离：

- `currentLifecycle`：本 tick 的模式、drain、pending、exposure、claim 和安全违规；
- `lastPlanningSnapshot`：最后一次完整 ResourceControl 规划的候选、拒绝原因、策略、revision、observedAt 和价格簿摘要；
- `planningSnapshotAge`：当前 tick 与 `observedAt` 的差；
- `planningSnapshotMaxAgeTicks`：固定等于 ResourceControl 规划间隔（当前为 10 tick）并纳入 safety fingerprint；
- `lastDirectOpportunity`：选中订单的价格、数量、净价、能量和安全/等待原因。

非规划 tick 不再把 `lastPlanningSnapshot` 覆盖为空。`age <= planningSnapshotMaxAgeTicks` 为 fresh，`age > planningSnapshotMaxAgeTicks` 为 stale；monitor 必须显示阈值和年龄，不能把旧证据伪装成当前 tick。投影仍保持有界：每候选只保留摘要，订单簿只保留计数、深度、最佳价和最终选中订单，不保存完整市场订单列表。

### 10. 部署与回滚

部署顺序：

1. 将已部署 `market-sale-automation` 的未执行 Maker live canary 任务明确记为由本变更取代，先同步/归档该前置 change，再验证本 change 对 canonical capability 的 MODIFIED delta。
2. 独立 worktree 完成实现、聚焦测试、完整测试、类型检查、构建和静态市场写门禁。
3. 独立 subagent 审查实现；所有 P0/P1/P2 关闭后合并 main。
4. 部署新 bundle，但保持 `mode=shadow`、`shadowStrategy=direct`、新 revision 和 Direct 零写；Pixel、旧 ResourceControl/Factory 出售、Maker/其他出售写关闭。Factory/Boost/emergency buy 等生产购买继续经 arbiter 运行，不因 Shadow 被关闭。
5. 实时验证确定性 canary、E6N59 或当时真实合格房间的可售量、current-tick BUY 净价与持续诊断投影。
6. 同一冻结配置累计 100 个 Direct Shadow 周期，复核零写、零安全违规和 pending 全零。
7. 独立审查 live Shadow 证据后，在 revision、`directSafetyFingerprint` 和 canary 均不变化的前提下显式切换 `mode=direct`；该允许的激活边不得清零资格，首次最多成交 1,000 X。
8. 等待并确认唯一 outgoing transaction；按 confirmed actualAmount、transaction price、实际取整 energy 与 pending 冻结的 `effectiveEnergyShadowPrice` 重算保守 `actualNet`，要求不低于 pending 的 `effectiveNetFloor`，同时核对 worst-case 预检、保护量和 terminal 状态；系统自动暂停。

紧急停止把 Direct mode 切换为 `emergencyStop`：禁止新 deal，继续对账全部 active `prepared/submitted/reconcile_gap` pending。market-sale 域只允许 `Memory.data.marketSaleAutomation.marketStaging` 与 `marketReservations` 两个 canonical 持久表表达 staging/reservation；本版本没有写入生产者，旧 bundle 也从未有这两个状态的生产者，因此字段缺失等价于已证明的空迁移状态。live adapter 每 tick 仍必须读取并汇总这两个表，任一非空或损坏记录均按非零处理并阻断 `stopped`，不得再用调用点常量伪造零值。生产侧 reservation 属于 protection ledger，不得在这里重复计数。

只有 active pending、Direct 资源/能量 exposure、Maker pending/managed exposure、上述 live staging/reservation 全为零，并连续两次确认后才能回滚旧 bundle。旧出售安全闩在整个过程中保持 false。

## Risks / Trade-offs

- [单张高价订单可能瞬间撤销] → 动作前按 exact order ID/tuple 重验；失败时本 tick 不降级成交其他订单。
- [单张高价订单是诱饵] → 它不能改变任何长期底价；只有确切报价在动作时仍存在且净价达标才成交，最坏结果是订单撤销导致零成交。
- [交易返回 OK 但对账记录缺失] → 保留 pending exposure、进入 reconcile gap 并冻结后续 Direct 写。
- [压力房间同时有生产调拨] → 只在 current-tick 保护账本完整且 terminal 未被 arbiter claim 时成交，成功后阻塞后置 Carrier/terminal 动作。
- [100 周期期间盘口机会消失] → `safe_no_opportunity` 仍证明决策链安全；资格不依赖短期订单持续存在。
- [当前 600 底价未来不合适] → 底价是显式配置且 revision 绑定；修改会清空 Shadow 证据，不会静默生效。
- [诊断快照保留导致误读陈旧状态] → 同时投影 observedAt/age/stale，当前生命周期与上次规划证据分开显示。
- [Direct 释放容量但错卖生产资源] → 继续以生产保护和 forecast 为第一门禁；容量压力不参与降价，也不能覆盖保护量。

## Migration Plan

1. 新字段全部可选解析；旧配置保持 Maker Shadow 行为。
2. 部署迁移初始化空 `pendingDirectDeals`、Direct Shadow 计数和持久 planning snapshot，不继承旧 Maker 资格。
3. 先写入 `shadowStrategy=direct` 和新 config revision，保持 `mode=shadow`。
4. live 验收完成前不写 `mode=direct`。
5. 回滚时先 emergency stop 并证明所有 Direct/Maker pending 与 exposure 已归零；旧市场安全闩继续保持关闭。

## Sources / Engine Assumptions

本设计固定审计 Screeps engine commit `80977824199a596d174d392fd0cf8c458c21fcbd`：

- [`calcTerminalEnergyCost` 的 `ceil(amount * rate)` 公式](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/utils.js#L657-L659)；
- [market deal 的实际量缩小、交易能量重算、transaction time/from/to/order tuple 与 terminal cooldown](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/global-intents/market.js#L260-L397)；
- [处理尾部按实时库存/credits/capacity 刷新 order active](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/global-intents/market.js#L540-L585)；
- [同周期改价订单 `_skip` 与 deal intent 跳过](https://github.com/screeps/engine/blob/80977824199a596d174d392fd0cf8c458c21fcbd/src/processor/global-intents/market.js#L150-L255)。

实现必须把这些语义做成独立 engine-semantics fixture/回归测试，并在 live Direct 激活审查中重新核对官方 source commit。若 fixture、上游相关语义或本地 API mock 变化，Direct 资格 fail-closed，必须更新 change/revision 并重跑 Shadow；不得静默沿用旧假设。

## Open Questions

无。首次 canary 的资源、底价、最大数量、确认笔数和 Shadow 周期均已按当前 live 证据收敛；后续扩围必须提交独立 OpenSpec/capability delta、重新实现并通过审查，不能仅由 operator 配置解除。
