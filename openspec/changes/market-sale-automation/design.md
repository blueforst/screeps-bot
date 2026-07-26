## Context

当前 `resourceControl` 在配置缺失时默认开启市场，并以空价格下限直卖基础矿物；`factoryControl` 和未接入主循环的 `boostControl` 也各自拥有直接 `Game.market.deal` 路径。不同模块没有共享订单、费用或 terminal action claim。线上已经出现 H、K、L、X、Z 等资源以显著异常低价成交，同时帝国 8 个房间没有合格接收方，多个 Storage/Terminal 满载，Hub 合成卸载受阻。

现有主循环顺序为 Hub、合成、工厂、资源控制，战争/防御模块在资源控制之后。市场执行器不能假设后置 producer 已在本 tick 发布保护量，必须在执行前主动读取当前配置、Game 状态、持久任务和带 TTL 的承诺。现有 `resourceControl` 已拥有跨房调拨 context、terminal busy 集合和全局动作预算，是统一出售执行域的合适宿主。

## Goals / Non-Goals

**Goals:**

- 默认不卖；只有显式模式、白名单、逐资源绝对底价、信用保护和新鲜保护账本齐备时才允许动作。
- 在不破坏工厂、活动/暂停合成、Hub、boost、战争、手工调拨和终端能量预算的前提下计算真实可售量。
- 首发生产执行仅允许小批 Maker；容量压力永不降低价格底线。
- 统一所有市场写入口和每房每 tick terminal action claim，退役工厂独立出售器。
- 只管理本自动化创建的订单，费用、额度、暴露、部分成交、外部订单变化、过期和回滚均可审计。
- 支持零写 Shadow、动态 canary、紧急排空和跨旧 bundle 的安全闩。

**Non-Goals:**

- 本变更不调整 `receiverStorageMinFreeCapacity`，不把容量阈值变化与市场 canary 同时上线。
- 不自动出售 energy、power、battery、商品、中间物或 T3；首版默认仅允许显式列出的基础矿物。
- 不在本变更中启用自动直接成交、订单扩量或调价；`hybrid` 与 direct executor 必须经后续独立变更、审查和 live canary。
- 不复制 Overmind、TooAngel 或 SlothBot 的实现和历史硬编码价格。
- 不自动修改用户手工创建的市场订单。
- 不在本变更中重写全部生产规划器；生产模块继续保持现有职责，但市场会主动收集并校验它们的当前事实。

## Decisions

### 1. 新配置入口与旧版安全闩

新增 `Memory.cfg.marketSaleAutomation`，模式为：

- `off`：仅在托管订单、pending create/mutation、market staging/reservation/exposure 全部为 0 后成立。
- `shadow`：仅在完成同样排空后成立；完整收集账本、报价和候选，但禁止 `deal/create/extend/change/cancel` 及 market staging。
- `maker`：仅创建和安全撤销小额托管卖单；首发不主动扩量或调价。
- `hybrid`：保留的配置值；本变更中请求该模式会记录 `hybrid_not_implemented` 并按 `off` 排空，不会隐式退化成 Maker，也不会调用 `deal`。
- `emergencyStop`：进入 `requested → draining → stopped`，只取消托管订单并清空 market staging/exposure。

新入口默认目标为 `off`。配置缺失、无效，或从 maker/hybrid 请求切到 off/shadow 时，若仍有任一托管订单、pending create/mutation、market staging/reservation/exposure，系统自动进入 fail-safe `requested → draining → stopped`；只有排空后才进入目标模式。因此未确认市场意图存在期间不会把状态伪装成 off/shadow。

无论新模式如何，部署迁移和紧急停止都将持久设置旧字段 `Memory.cfg.resourceControl.market.enabled=false` 与 `Memory.cfg.factoryControl.market.enabled=false`；两项在回滚旧 bundle 前继续保留，防止旧版 ResourceControl 默认值或历史 Factory 配置重新启用出售。

选择独立入口而非继续扩展旧 market 配置，是为了让旧配置不能意外穿过新的 fail-closed 合同。

### 2. 唯一市场写网关与 terminal action arbiter

新增 `marketActionArbiter`，全仓只有该文件允许调用：

- `Game.market.deal`
- `Game.market.createOrder`
- `Game.market.extendOrder`
- `Game.market.changeOrderPrice`
- `Game.market.cancelOrder`

网关按 tick 清理内存态，成功的主动成交会 claim 对应 room terminal；ResourceControl 内部发送和后续市场动作必须查询同一 claim。Factory/Boost 的购买如暂时保留，只能经网关执行并受同一 claim；它们的出售路径直接退役。新增静态架构测试扫描全部生产源码 `src/**`，仅排除测试/mock 文件和 arbiter 自身，禁止网关之外出现市场写 API。

被动卖单由其他玩家主动成交，不消耗本方主动成交预算，但会改变 terminal 实存和订单剩余量；每 tick 对账处理这种外部变化。

### 3. 两阶段执行和当 tick 保护账本

市场自动化属于 ResourceControl 执行域，但分为两个阶段：

1. **最早 reconcile**：在生产副作用前运行，只处理托管订单真实状态、policy TTL、紧急排空和旧安全闩；不声称此时已经拥有本 tick 的完整生产账本。
2. **最终 protection guard + planner/executor**：在 Hub、合成、工厂和 ResourceControl 规划之后立即收集当前事实，先重验全部已有 exposure；保护增加、资源不足或账本不可证明时安全撤单，随后才允许规划小批 Maker 订单。取消未确认前暴露始终保持。

完整 ResourceControl 规划有自身调度间隔，但托管订单可以在任意 tick 被动成交。因此只要存在 managed 或 pending exposure，运行时每 tick 都必须对对应房间/资源执行轻量 current-tick collector；若本 tick 无法生成完整保护账本，就立即请求安全撤单/排空，并在确认消失前继续保留 exposure。每个 managed order 同时用 live price、live remaining 和未摊销 fee debt 重验当前 hard/economic/可信历史底价不变量；operator 提高底价、配置签名变化或可信价格缓存无法证明安全时，本 tick 就撤单，不能等待下一次完整 ResourceControl 周期。由于 protection guard 位于生产规划之后，ResourceControl 的 terminal send 与 Carrier 的终端取货还必须在各自动作边界独立扣除 market exposure；这样本 tick 的物理 intent 也不能抢占尚未确认释放的挂单库存。

最终 collector 每 tick 为候选 `room/resource` 生成：

```text
MarketProtectionEntry {
  revision: Game.time
  observedAt: Game.time
  expiresAt
  totalStock
  hardReserve
  forecastBuffer
  protectedOutgoing
  carrierOrInFlight
  managedExposure
  sourceContributions[]
}
```

collector 不依赖后置模块“本 tick 已发布”这一假设，而是主动读取：

- Factory 当前 target、组件展开、显式任务和生产配置；
- Synthesis 活动计划、reaction target、`boostPause.pausedPlan`、reagent/product 库存目标；
- Hub chain/T3 目标、distributed synthesis allocation/route 和 `marketSellSurplus`；
- Boost/War 配置、活动任务、`resourceReservations` 和带 TTL 的 runtime 承诺；
- 所有 pending 的关键手工/生产/boost/战争出站任务，包括暂时 blocked 的任务；
- carrier board 的剩余步骤、in-flight 承诺；
- 活跃托管订单暴露。

每个贡献使用稳定去重键：reservation 使用 holder/key，transfer 使用 task ID，carrier 使用 task/step ID，managed exposure 使用 order ID。相同合同的重复视图只计一次；没有稳定 ID 的旧记录按独立承诺保守计入，绝不因无法去重而少保护。

任一必要来源缺失、`observedAt/expiresAt` 过期、revision 不等于当前 tick，或 collector 无法解释候选资源时，该 `room/resource` 完全禁止出售并记录 `protection_stale`。每个 allowlist 资源都必须显式配置有限正数的 `forecastBuffer`，且不得小于 `makerBatchAmount`；它带相同 revision/TTL。缺失、为零、非有限值或小于一批时配置直接 fail-closed。

### 4. 可售量与托管暴露

```text
protected =
  max(roomFloor,
      productionTarget + componentDemand + boostWarDemand,
      hubOrFactoryTarget)
  + forecastBuffer
  + protectedOutgoing
  + carrierOrInFlight

grossSurplus = max(0, totalStock - protected)
newExposureCapacity = max(0, grossSurplus - openManagedExposure)
```

新订单只能使用 `newExposureCapacity`。订单维护自身时从 `openManagedExposure` 中排除该 order ID，防止自我重复扣减。实际动作量还必须受 terminal 当前实存、单笔上限、能量预算和全局/房间 action budget 限制。

托管卖单暴露是生产可抢占的 soft reservation，但在订单确认取消前，carrier 不得搬走或分配这部分 terminal 库存。单纯读取 `store - exposure` 不足以覆盖 Screeps 同 tick intent：每个 terminal/resource 的 Carrier withdraw 必须先做按 `Game.time + Game identity` 自动清零的原子 in-flight reservation，失败释放、OK 保留到 tick 末；同房已有成功 terminal action claim 时，后续 Carrier 不得再使用 intent 前旧 store。Screeps 没有原地缩量 API，因此生产需求增加时只能请求 cancel；最终 guard 确认订单真实消失后才释放 exposure，随后如仍有安全余量再创建更小的新单。若外部被动成交，下一 tick 以真实 terminal 实存和订单剩余量对账，任何差异都优先减少可售量而非生产保护量。

Hub T3 只允许使用 `Memory.runtime.hub.marketSellSurplus`；基础矿物 Hub 资源首版不参与 canary。所有关键 blocked outgoing 在取消或合同过期前继续保护；只有显式 `disposable` 的自动 capacity-relief 任务满足 TTL 失效条件后才能释放。

### 5. 价格底线与异常过滤

有效净底价：

```text
effectiveNetFloor =
  max(hardFloor,
      economicFloor,
      trustedHistoryFloor,
      previousTrustedFloor * 0.95)
```

- `hardFloor` 对每个 allowlist 资源强制显式配置，缺失即拒绝。
- `economicFloor` 可选，只包含生产/回购替代成本与安全利润；订单费用债务单独进入 post-action 净收入不变量，避免重复计费。
- `trustedHistoryFloor` 只来自 `Game.market.getHistory` 的完整日：至少 5 个有效日，每日交易数/成交量达标，在 `log(avgPrice)` 上进行 MAD 异常过滤，并以受限 `sqrt(volume)` 权重求稳健中位数。
- `previousTrustedFloor` 只保存满足上述条件的外部历史值，绝不写入自有订单价或派生 floor。每个完整市场日最多向下更新一次且最大 5%；历史缺失、过期或异常时冻结上一可信值或暂停，不按 tick 连续递乘。
- 所有报价按市场价格精度向上取整，浮点与舍入不得穿透底价。

直接成交净价的纯候选算法：

```text
directNet = buyOrder.price
  - transactionEnergyPerUnit * energyShadowPrice
```

候选按 `directNet` 排序，并可计算 `min(order.amount, safeAmount)` 的理论部分量。该算法用于研究、测试和后续 direct executor 的安全边界；本次首发运行时不调用它执行 `deal`。

挂单最低报价同时考虑历史费用债务和本次 prospective fee。首发每次 create 都必须满足 post-action 不变量；fee ledger 同时为未来 extend/reprice 保留相同的纯计算能力，但本次运行时不会发起这两类动作：

```text
candidatePrice * postRemaining
  - (feeDebtBefore + prospectiveFee(action, candidatePrice))
  >= effectiveNetFloor * postRemaining
```

其中：

```text
create:     prospectiveFee = 0.05 * candidatePrice * newAmount
extend:     prospectiveFee = 0.05 * currentPrice * addAmount
up-reprice: prospectiveFee = 0.05 * (candidatePrice - currentPrice) * currentRemaining
down-price: prospectiveFee = 0
```

系统按市场 tick 向上寻找满足不变量的最小价格；新建订单因此至少要求 `candidatePrice >= effectiveNetFloor / 0.95`。被动成交必须使用 `outgoingTransactions.transactionId + order.id` 作为幂等键确认成交量和实际价，并与 live remaining 核对；不能从 terminal 总差额猜测，因为 carrier/生产也会改变库存。交易窗口截断或两侧不一致时标记 `reconcile_gap`，冻结 create 和未来任何 fee-sensitive mutation，只允许安全取消与继续对账。

Fee debt 以 milli-credit 整数保存，按 `floor(feeDebtMilli * filledAmount / preRemaining)` 随已填数量精确定点摊销，舍入余数继续留在 remaining debt，不能用 `0.05 * fillPrice * amount` 重新猜测。取消不退费，未摊销余额转入该资源的 `carriedFeeDebt`，由后继订单继续覆盖；若债务使安全报价失去可信市场深度，该资源暂停而不是丢弃债务或降低底价。尘埃订单、小样本历史和深度不足的盘口不参与长期参考价。

Screeps 订单费用按 0.001 credit 精度向上计费，因此 `prospectiveFee` 使用 `ceil(rawFee * 1000) / 1000`；post-action 不变量使用取整后的真实费用，而不只对报价取整。

### 6. 首发 Maker-only 与后续 Direct 边界

Maker 默认使用非 Hub、非 emergency、terminal 正常、能量储备充足、当前实存和 ledger surplus 明确的房间。每个资源小批挂单，且不超过可信日成交量的配置比例。

建单写前先检查共享 arbiter：只要候选房间本 tick 已被内部发送、购买或其他动作 claim，就拒绝本轮创建。随后重读 terminal 的候选资源、energy 和 free capacity，并确认 current-tick protection sellable 仍覆盖完整新 exposure；任一条件变化都不得先写 `pendingCreate`。

本次首发只执行 create/cancel。现有订单价格、保护量、配置 revision、可信参考或账本任一失效时，系统撤单并等待确认，不通过 extend/reprice 追价；需要新的安全报价时，在旧订单确认消失后重新创建。

`hybrid` 请求始终 fail-closed，并留下明确拒绝原因。未来 direct executor 至少仍需同时满足 `directNet >= effectiveNetFloor`、相对 Maker 净价折扣门槛和动作前订单/terminal 重验，但这些条件不构成本次已交付能力。容量 pressure 只允许提高采样频率和处理优先级；任何状态都不能放宽 `hardFloor/economicFloor`。没有安全价格时等待、内部搬运、暂停生产或报警，不 fire sale。

Canary 不硬编码房间或资源。候选必须满足：非 Hub、非 capacity emergency、terminal cooldown 为 0、能量与 free capacity 安全、无关键出站/生产冲突、保护账本当前 tick 新鲜、可信价格与深度有效。第一次选择后把唯一 `roomName/resource` 持久锁定到 `canaryLock`，有效 `maxManagedOrders=1` 且禁止 hybrid/direct；在完成验收或 operator 明确扩围前，跨 tick 不得自动改选第二个候选。被锁候选暂时不合格且没有暴露时只等待；若已有 managed/pending exposure，则立即对该订单进入安全 cancel/drain，确认归零后继续保留 canary lock 等待恢复，不转移灰度对象。每个拒绝原因写入 runtime，任何价格或保护安全违规都连接到相同的 cancel/drain 路径。

### 7. 托管订单、额度和费用账本

持久状态放在 `Memory.data.marketSaleAutomation`：

- 仅本程序创建的 `managedOrders[orderId]`
- `createdAt/lastSeenAt/lastRemainingAmount/lastFillAt/policyCancelAtTick/serverCreatedTick`
- `roomName/resource/price/originalAmount/remainingExposure`
- 已付费用、已摊销费用、最近调价、重试和 backoff
- 真正跨 tick 的滚动费用记录
- 各资源 `lastTrustedFloor` 与外部历史日期
- `pendingCreate`：调用前的订单 ID baseline、唯一请求 ID、完整 order tuple、暴露、费用和状态
- `pendingMutations[orderId]`：首发 cancel 的写前快照、请求参数、保守暴露和确认状态；类型为未来 extend/reprice 保留但首发不产生这些动作
- `carriedFeeDebt[resource]` 与幂等 fill-delta 对账键
- `orderMutationLease`：operator 授予的排他市场订单变更租约、epoch、有效期和 baseline hash

`Game.market.createOrder` 只返回 ScreepsReturnCode，不返回 order ID。自动建单前必须有 operator 显式授予且覆盖“请求 tick 至归属 tick”的排他 `orderMutationLease`；租约期间 operator 承诺不通过控制台/UI 创建、扩量、调价或取消任何市场订单。创建前系统持久化 `pendingCreate`、租约 epoch 与当时全部自有 order ID；全局同时最多存在一个 pending create。create 返回 OK 后，直到它唯一归属或按审计协议收敛为止，跨 tick 禁止后续 create/extend/reprice，只允许 reconcile 以及取消已确认的 managed order。

只有租约持续有效、baseline hash 未变、差集中没有意外 ID，且“新增 ID 差集 + type/resource/room/price/immutable totalAmount/created tick 完整 tuple”唯一匹配一个订单时，系统才可自动迁移到 `managedOrders`；可变的 `remainingAmount/amount` 只用于部分成交对账，不参与创建归属。租约缺失/过期、出现意外 order delta 或 operator 声明发生手工变更时，立即撤销自动认领能力并进入 fail-closed；此时即使 tuple 唯一也必须由 operator 对 exact order ID 做 attestation，系统不得自行猜测。

歧义解除必须可审计且最终可收敛：

- 当前全部 order ID 与 baseline 的差集在两个不同 `Game.time` 连续读取为 0 时，证明没有未知新订单仍存在；系统记录 credits、订单费、terminal 实存和 outgoing transaction 对账后，可把 pending 标记为 `filled_or_absent` 并清除 exposure。
- 有效排他租约覆盖整个窗口且差集中恰有一个完整 tuple 匹配时自动认领；无有效租约时必须 operator attestation。
- 差集中存在 tuple 不匹配或多个匹配时，系统 fail-closed，绝不自动收养、修改或取消。operator 只能通过显式 resolution API 指定一个满足 baseline 差集与完整 tuple 校验的 order ID 进行认领，或逐个识别/处理候选后，等待候选 ID 全部从 live orders 消失并连续两次确认，再把 pending 标记为 `operator_reconciled`。
- 每次人工 resolution 持久记录 operator action、候选 ID、前后 live snapshot 与 tick。未满足上述证据时不能清除 pending；手工订单始终受保护。

首发 cancel 使用 write-ahead `pendingMutation`；账本也能识别订单被外部扩量/调价，但自动化本身不主动发起 extend/reprice：

- 调用前记录 order ID、真实基线 `price/totalAmount/remainingAmount/active`、请求参数、预期费用和 exposure。
- 返回非 OK 时记录失败并按无副作用结果清理或退避；返回 OK 时保留 pending，同一 order 同 tick 只允许一个 mutation。
- 后续 tick 读取真实订单确认：cancel 以 ID 消失为准。若 live `totalAmount` 或 `price` 出现没有本系统 pending 记录的外部变化，即使与部分成交并发，也标记 external mutation gap、冻结 fee-sensitive 写并要求 exact order ID 的 operator 处理；系统不得猜测或自动接管。
- emergency stop 先对账已有 pending mutation，再对已确认托管订单发 cancel；stopped 要求 pending mutation 全部归零。

本地 policy TTL 与服务器自然到期严格分离：`policyCancelAtTick` 只触发显式 cancel，不能冒充服务器 expiry。公开 `Game.market.orders[].created` 是 game tick，不是可用于推导自然到期的服务器时间戳，因此实现只记录 `serverCreatedTick`，绝不由它计算 expiry。显式 cancel 不假设退款；只有外部权威证据明确确认自然到期，且实际返费已通过 credits/refund 对账时，才能冲减 fee debt 并记录 `server_expired`。订单消失按 `filled`、`policy_cancelled`、`server_expired` 或 `unknown_disappearance` 分类；无法以 pending mutation、transaction 与已核验返费唯一解释时进入 `reconcile_gap`，不得猜测费用或释放 fee-sensitive 状态。

默认最多 3 个托管订单，并保留至少 5 个空闲订单槽位。首发在任何创建前计算新增费用，并通过全局同 tick reservation；未来若实现扩量或涨价，也必须经过同一合同：

```text
Game.market.credits - reservedFeesThisTick - newFee >= creditReserve
```

同时不得超过滚动费用预算。订单额度、费用、credits 或 API 能力未知时 fail-closed。槽位或 credits 前置条件不足时只记录拒绝，并在后续完整 ResourceControl 周期重新评估；托管订单 cancel 失败使用有界退避。只能变更持久账本中匹配的 order ID，手工订单永不修改。

### 8. Emergency stop 与可回滚性

状态机：

1. `requested`：禁止新 deal/create/extend/reprice/staging，同时设置旧 ResourceControl 与 Factory market enabled 为 false。
2. `draining`：重试取消且只取消已确认托管订单；按 pending create 歧义解除协议自动证明 absent/filled，或等待 operator 明确认领后再取消，绝不猜测；取消请求成功不等于完成，继续读取 `Game.market.orders`。
3. `stopped`：至少在两个不同 `Game.time` 连续 live 读取确认所有已知 managed order ID 均已从 `Game.market.orders` 消失（不论此前 `active` 标志）、pending create/mutation 为 0、market staging/reservation/exposure 为 0。任一非零项、新订单或新 mutation 都会把连续确认计数重置为 0。

只有达到 `stopped` 后才允许部署不识别托管订单的旧 bundle，或正式进入 off/shadow。回滚后两项旧安全闩继续保留。取消失败或 pending create 归属歧义进入告警和退避，不能删除元数据伪装成完成。

### 9. 观测与有界状态

`Memory.runtime.marketSaleAutomation` 记录：

- mode/phase/revision/updatedAt
- 每资源 stock/protected/forecast/exposure/sellable
- floor 各组成、历史可信度、候选净价
- `rejectedByReason`
- managed order/slot/credit/rolling fee 摘要
- terminal claims、backoff、draining 连续确认数
- 有界 recentActions 和 `safetyViolationCount`

Monitor 对旧 runtime 缺字段返回 `null`，不伪造 0。Shadow 必须产生同样的规划与拒绝解释，但市场写调用和 staging 数必须为 0。

## Risks / Trade-offs

- [保护账本漏读后置战争/防御需求] → collector 主动读取当前事实并要求 current-tick revision；缺失或 stale 时按资源 fail-closed。
- [被动成交发生在两 tick 之间] → 只挂牌预测缓冲后的真实 surplus，暴露持久化，每 tick 最早对账；差异只减少 surplus。
- [挂单费用沉没导致实际净价跌破底价] → 按剩余数量摊销全部未回收费用；需要新价格时撤单确认后重建，不在首发中扩量或调价。
- [订单槽位或 credits 被手工操作改变] → 每次动作前读取真实订单/credits，保留槽位和 credit reserve，未知时不动作。
- [统一网关改变旧购买路径] → Factory/Boost 购买仍可调用网关，但会被单 terminal claim 和显式配置约束；回归测试覆盖。
- [历史市场发生制度性跳变] → 每日最多下调 5%，历史与盘口显著偏离时暂停而非连续追跌。
- [CPU/Memory 增长] → 订单簿缓存、完整日历史缓存、有界日志和最多 3 个托管订单；Shadow 记录 CPU 基线后再激活。

## Migration Plan

1. 部署前显式写入并验证旧 `Memory.cfg.resourceControl.market.enabled=false` 与 `Memory.cfg.factoryControl.market.enabled=false`，在全部 known managed ID 消失、pending create/mutation 与 market exposure 归零前不宣称新模式已进入 `off`。
2. 部署代码，确认旧直卖、Factory 出售和网关静态门禁生效；全部 known managed ID 应不存在，手工订单保持不变。
3. 先在 Shadow 中完成参数调优，再冻结与 canary 完全相同的候选资源、hard/economic floor、credit/fee、批次、历史和 canary 策略配置并生成 `shadowConfigRevision`。只有该 revision 下连续至少 100 个 ResourceControl 周期才计入验收；任一相关配置变化立即把计数清零。要求零市场写、覆盖历史不足/异常盘口、所有候选均有接受或拒绝原因。
4. 根据 live 条件动态选择一个非 Hub 房间和一个基础矿物进入小批 `maker` canary；不能同时改容量阈值。
5. 验证至少一次订单创建/部分成交或缩短 policy TTL 的显式撤单清理，再逐资源、后逐房扩围；T3、商品、energy、power、battery 保持禁用。
6. `hybrid`/direct executor 另开独立 change，在重新审查 direct TOCTOU、交易能量预算和 live canary 后才可实现；本次版本保持 fail-closed。
7. 回滚时先进入 `emergencyStop`，达到 `stopped` 且连续 live 确认全部 known managed ID 消失、pending create/mutation、market staging/reservation/exposure 归零后再回滚 bundle；手工订单保留，两项旧 market disabled 闩保持。

## Open Questions

无。基础矿物 hard floor、credit reserve、滚动费用预算和 canary 资源的具体数值先在 Shadow 调优，随后冻结 revision 并重新开始连续 100 周期验收，不作为代码默认值。
