## ADDED Requirements

### Requirement: Direct 必须显式授权且与 Maker 隔离
系统 MUST 以独立安全指纹和运行模式区分 Maker 与 Direct。`shadow` MUST 通过显式 `shadowStrategy` 选择被验证的策略；只有 `mode=direct` 才能授权主动成交。Maker、旧 Shadow 或 Hybrid 状态不得隐式调用 `deal`。

#### Scenario: 旧 Shadow 配置未声明策略
- **WHEN** 既有配置为 `mode=shadow` 且没有 `shadowStrategy`
- **THEN** 系统保持 Maker Shadow 兼容行为，不执行 Direct，也不继承任何 Direct 资格

#### Scenario: 显式 Direct Shadow
- **WHEN** 配置为 `mode=shadow`、`shadowStrategy=direct` 且 revision 有效
- **THEN** 系统执行完整 Direct 只读规划，同时市场写、terminal claim、market staging 和 reservation 必须为零

#### Scenario: 请求 Hybrid
- **WHEN** 配置模式为 `hybrid`
- **THEN** 系统继续 fail-closed，不得退化为 Maker 或 Direct

### Requirement: Direct Shadow 资格必须独立计算
系统 SHALL 为 Direct 保存与 config revision、`directSafetyFingerprint` 和 canary 绑定的连续 Shadow 周期。fingerprint MUST 把 `shadow(strategy=direct)` 与 active `direct` 规范化为同一 Direct 策略且 MUST NOT 包含生命周期 `mode`；旧 Maker Shadow 计数、旧策略、旧 revision 和旧 canary lock MUST NOT 用于授权 Direct。

#### Scenario: 冻结配置完成 100 周期
- **WHEN** 同一 Direct 配置、底价、批次、保护策略和 canary 策略连续完成至少 100 个完整 ResourceControl 周期
- **THEN** 系统可把 Direct Shadow 标记为已资格化，但仍不得在 `mode=shadow` 下写市场

#### Scenario: 配置或策略变化
- **WHEN** Direct 安全指纹、revision、canary 策略或有效策略发生变化
- **THEN** Direct 连续计数和旧 canary lock 必须清零，且旧 Maker 证据不得继承

#### Scenario: Shadow 直接激活 Direct
- **WHEN** 已资格化状态从 `mode=shadow, shadowStrategy=direct` 直接切换为 `mode=direct`，且 revision、安全指纹和 canary 均未变化
- **THEN** 系统必须保留刚完成的 Direct 资格；生命周期 mode 的允许激活边不得改变安全指纹或清零计数

#### Scenario: 经由其他模式再返回
- **WHEN** Direct Shadow 或 Direct 状态切到 `off`、`maker`、`hybrid` 或 `emergencyStop`，或者经由这些模式再返回 `direct`
- **THEN** 系统必须清零 Direct 资格并重新完成 Shadow；不得只因安全字段碰巧相同而恢复旧资格

#### Scenario: 安全等待计入周期
- **WHEN** 保护、历史、底价和 BUY 盘口读取都完整，但没有任何买单达到有效净底价
- **THEN** 系统记录 `safe_no_opportunity` 并把本周期计为完整 Shadow 周期，不得为凑满资格放宽底价

#### Scenario: 输入不完整
- **WHEN** 保护账本、可信历史、energy shadow、BUY 盘口读取或 pending 状态无法证明完整
- **THEN** 系统 fail-closed、清零连续计数并记录具体拒绝原因

### Requirement: Direct 结构候选与即时机会必须分离
系统 MUST 先根据 current-tick 生产保护和 terminal 事实选择唯一结构 canary，再从该 canary 的 BUY 盘口中选择即时成交机会。短生命周期买单是否存在不得决定结构 canary 是否可被 Shadow 评估。

#### Scenario: 有安全库存但暂无高价买单
- **WHEN** 非 Hub、非 emergency 房间存在明确可售量且底价可信，但当前 BUY 盘口全部低于净底价
- **THEN** 系统保留结构 canary、记录安全等待，不选择低价订单

#### Scenario: Pressure 房间释放容量
- **WHEN** 房间处于 pressure、生产保护完整、terminal 可用且可售量为正
- **THEN** 它可以成为 Direct 结构 canary；容量压力只能影响候选优先级，不能降低底价

#### Scenario: Hub 或 emergency 房间
- **WHEN** 候选是 Hub 或 capacity emergency
- **THEN** 首次 Direct canary 必须拒绝该候选

#### Scenario: 多个结构候选输入顺序变化
- **WHEN** 多个房间同时合格，且候选数组、对象键或 global reset 后的遍历顺序发生变化
- **THEN** 系统必须始终按 pressure 优先、sellable 降序、terminal stock 降序、room/resource 稳定升序锁定同一 canary；BUY 机会不得反向改变结构 lock

### Requirement: Direct 只消费实际可执行的 BUY order
系统 SHALL 只评估 current-tick 完整 BUY book 中有效的外部订单，并过滤自有订单、资源不符、无房间、无效价格/数量、低于最小订单量或最小名义金额的订单。Direct 不得使用 Maker 的跨 tick 订单缓存；单张订单不得写入长期可信价格状态。

#### Scenario: 单张高价真实买单
- **WHEN** 只有一张达到最小数量和名义金额的 BUY order，其动作后净价高于有效净底价
- **THEN** 该订单可以成为 Direct 机会，即使没有第二、第三张同样安全的买单

#### Scenario: 高价一单位诱饵
- **WHEN** BUY order 数量低于 `minDirectOrderAmount` 或实际可成交名义金额低于阈值
- **THEN** 系统拒绝该订单，且不得用它更新历史、ratchet floor 或 Maker 参考价

#### Scenario: SELL 侧深度不足
- **WHEN** SELL 侧 Maker 参考盘达不到订单数、房间数或累计深度门槛，但存在净价安全的真实 BUY order
- **THEN** SELL 侧不足不得阻塞 Direct Shadow 或 Direct 机会

#### Scenario: 缓存后出现更高净价买单
- **WHEN** 旧缓存中的订单仍安全，但 current-tick 完整 BUY book 新增了更高安全净价订单
- **THEN** Direct 必须重排并只选择当前最高安全净价；不得成交旧缓存中的较低订单

#### Scenario: BUY 订单扫描超预算
- **WHEN** current-tick raw BUY orders 超过 1,000、经 type/resource/room/own/amount/notional 且 `grossPriceMilli>=effectiveNetFloorMilli` 的便宜过滤后 eligible orders 超过 200，或完整读取失败
- **THEN** 系统必须拒绝整个周期并清零 Shadow 连续计数；尘埃单及 gross 已低于净底价的订单不占 200 张能量定价预算并记录具体拒因，但不得截断任一超限集合后声称选中了最高净价

#### Scenario: 存在自有市场订单
- **WHEN** 任一次 Direct write 前 `Game.market.orders` 存在任何 `remainingAmount>0` 的自有 BUY/SELL order（无论 active），或 Maker managed/pending/exposure 未归零
- **THEN** 系统只报告并等待，不自动取消订单，也不得调用 Direct deal

#### Scenario: Inactive 低价 SELL 仍有 remaining
- **WHEN** 自有低价 SELL order 当前 inactive 但 remainingAmount 大于 0，terminal 后续补货可能使其重新 active
- **THEN** 系统必须投影 `manual_sell_order_present` 并阻断 Direct；不得把 inactive 当作安全豁免

#### Scenario: 仅存在零 remaining 自有订单
- **WHEN** `Game.market.orders` 只有 `remainingAmount===0` 的自有订单，且 Maker pending/exposure 已归零
- **THEN** 该空订单本身不得阻塞 Direct，但 monitor 仍须观测；系统不得自动修改或取消它

### Requirement: Direct 必须允许安全部分成交
系统 MUST 按 `min(order.amount, sellableAmount, terminalStock, maxDirectDealAmount)` 计算实际成交量。订单无法吃下全局计划批次不得成为拒绝原因。

#### Scenario: 高价订单小于可售批次
- **WHEN** 安全可售量为 5,000，而最高净价 BUY order 只有 1,000
- **THEN** 系统把理论成交量设为 1,000，不得丢弃该订单转向能吃下 5,000 的低价订单

#### Scenario: 部分量低于最小成交量
- **WHEN** 计算后的实际成交量低于 `minDealAmount` 或 `minDirectOrderAmount`
- **THEN** 系统拒绝本轮并等待，不得扩大数量或选择低价单凑批次

### Requirement: Direct 必须按交易能量净价排序
系统 MUST 对每张订单按计划部分成交量计算交易能量。鉴于官方费用为 `ceil(amount*rate)` 且 `0<=rate<1`，系统 MUST 用 `calcTransactionCost(1)` 证明任意并发正部分量的最坏单位能耗。计划量和 amount=1 的最坏量都 MUST 使用保守 milli-credit 总额不变量比较：订单价格向下、effective energy shadow 与底价向上取整，并做 safe-integer/溢出检查。系统 SHALL 用整数商/余数精确比较 `netCreditsMilli/dealAmount`，再按总净额、gross price milli 和稳定 order ID 确定唯一机会；浮点展示值不得参与排序。

#### Scenario: 远处高标价净价更低
- **WHEN** 远处订单标价更高但扣除交易能量影子成本后的净价低于近处订单
- **THEN** 系统优先近处的更高净价订单

#### Scenario: 单位净价只差一个 milli
- **WHEN** 两张不同数量订单的精确单位净价只差一个 milli-credit 或余数项
- **THEN** 系统必须用整数商/余数选择真实更高者；不得因浮点近似、数量或总额更大错排

#### Scenario: X 的 665.8 买单
- **WHEN** X 的 BUY order 为 665.8 × 1,000，计划量与 amount=1 最坏量的保守 milli-credit 净价都不低于 600，且生产与 terminal 条件完整
- **THEN** 它必须作为可执行 Direct 机会被评估，不得因 SELL 侧只有两个有效房间或订单不足 5,000 而被排除

#### Scenario: 浮点边界
- **WHEN** 派生浮点展示值看似等于 600，但保守总额比较比底价少 1 milli-credit、发生非整除能耗或会溢出 safe integer
- **THEN** 系统必须拒绝；只有保守整数总额确实大于等于底价才可接受

### Requirement: Direct 永远不得穿透有效净底价
系统 MUST 以 hard floor、economic floor、可信历史底价和 ratchet floor 的最大值作为 Direct 有效净底价。容量、库存、SELL 报价、批次目标和 Direct 成交次数均不得降低该底价。

#### Scenario: 只有低价大单
- **WHEN** 最高可用 BUY order 的动作后净价低于有效净底价
- **THEN** 系统不得成交，并记录 `net_price_below_floor`

#### Scenario: 并发缩量会穿透底价
- **WHEN** 计划提交量的净价不低于有效净底价，但 amount=1 的最坏实际量因交易能量整数取整而低于底价
- **THEN** 系统必须在提交前拒绝该订单，并记录最坏实际数量和净价；不得等成交后再发现违规

### Requirement: Direct 能量影子价格不得被低配置压低
系统 MUST 使用 `max(energyShadowHardFloor, explicitEnergyShadowPrice, trustedFreshEnergyHistoryFloor, previousTrustedEnergyShadowPrice*0.95)` 作为有效能量影子价格。显式 override 只能抬高结果；必需历史或 ratchet 输入不可证明时 Direct MUST fail-closed。

#### Scenario: 低 override
- **WHEN** operator 配置的 energy shadow 低于可信新鲜历史或 energy ratchet
- **THEN** 系统必须使用更高的可信值，不得以低 override 抬高 Direct 净价

#### Scenario: 能量历史不可用
- **WHEN** 能量历史不完整、过期或无法形成可信 floor
- **THEN** Direct Shadow 本周期不合格且 active 不得成交，即使显式 override 为正

#### Scenario: 最高价单写前消失
- **WHEN** 已选最高净价订单在动作前消失或 tuple 变化
- **THEN** 本 tick 不得自动降级成交第二张订单；下一完整规划周期重新读取和排序

#### Scenario: SELL 参考价显著更高
- **WHEN** 稀疏 SELL 侧报价高于当前安全 BUY 净价
- **THEN** 系统不得用 SELL 报价降低或替代有效净底价，也不得仅因相对 SELL 折价而拒绝已经高于有效净底价的 Direct 机会

### Requirement: Direct 写前必须重验全部事实
系统 MUST 在同一 current-tick 保护 revision 下重读配置、canary、完整 BUY book、订单、全部自有订单、terminal 资源、terminal energy、cooldown、保护可售量、pending 状态和 arbiter claim。已选订单 MUST 在重排后仍为当前最高安全净价。任何事实无法证明时不得持久化 submitted 状态或调用 `deal`。

#### Scenario: 订单数量或价格变化
- **WHEN** `getOrderById` 返回的 type、resource、room、price 或 amount 与计划快照不一致
- **THEN** 系统拒绝本 tick，不得按旧快照调用 `deal`

#### Scenario: 写前出现更高净价订单
- **WHEN** 写前重读完整 BUY book 后，另一订单成为更高安全净价
- **THEN** 本 tick no-op，不得继续成交旧选择或同 tick 降级；下一完整周期重新规划

#### Scenario: 生产需求在写前上升
- **WHEN** current-tick 保护账本重验后可售量不足以覆盖计划成交量
- **THEN** 系统不得成交

#### Scenario: Terminal 已被其他动作占用
- **WHEN** ResourceControl、购买或其他生产动作已 claim 候选 terminal
- **THEN** Direct 本 tick 不得调用市场写 API

#### Scenario: 生产紧急购买优先
- **WHEN** 生产模块已经选出 current-tick 可执行订单、通过本地写前检查并声明 emergency buy/其他 market action intent，或已有账户级 market claim
- **THEN** 系统必须优先生产动作并让 Direct 等待；不得让 Direct 抢占生产紧急购买

#### Scenario: 只有需求但没有可执行生产订单
- **WHEN** 生产模块存在购买需求，但 current-tick 没有通过价格、数量、能量和订单重验的可执行订单
- **THEN** 生产模块不得声明空 market intent；Direct Shadow 可继续计完整周期，Direct 仍必须通过自身全部写前门禁

#### Scenario: 交易能量会穿透储备
- **WHEN** 实际 transaction energy 会使 terminal energy 低于配置储备
- **THEN** 系统不得成交

### Requirement: 所有 Direct 成交必须经过统一仲裁
系统 MUST 仅通过 market/terminal arbiter 调用 `Game.market.deal`。创建 prepared 后必须保守预留对应 terminal 和账户级 market claim；OK 或抛异常/未知结果时，账户级 claim 最多保持到 `attemptAt+1` 的最早 Direct preflight，只有明确非 OK 才可同 tick提前释放。preflight 后生产 market action 可以恢复，但必须尊重 active pending 的待售资源与 transaction-energy reservation并写入账户 action journal。generic Carrier、remoteCarrier、task-bound Carrier 或其他 terminal/market 动作不得使用 reservation 内库存或能量。

#### Scenario: Direct 成交返回 OK
- **WHEN** arbiter 对 Direct `deal` 返回 OK
- **THEN** 该房间 terminal 在本 tick 被 claim，后置 Carrier 不得撤取同一待成交资源或能量

#### Scenario: Deal 包装层抛异常
- **WHEN** pending 已 prepared，`Game.market.deal` 或包装层抛异常且上层 catch 后本 tick 继续
- **THEN** arbiter 必须保守保留 terminal 与账户级 market claim，完整资源/能量 exposure 继续生效，后置 terminal/market 使用者不得运行

#### Scenario: Gap 后出现生产紧急购买
- **WHEN** `attemptAt+1` 最早 preflight 已完成或 Direct 已进入 reconcile gap，随后出现 Factory/Boost/emergency buy
- **THEN** 系统必须允许生产动作按 arbiter 继续使用 reservation 之外的余额并记录 action journal；不得因 Direct gap 永久持有账户 claim，也不得释放 Direct exposure

#### Scenario: 静态架构扫描
- **WHEN** 测试扫描生产源码中的 `Game.market.deal`
- **THEN** 只有统一 arbiter 可以包含真实市场写调用

### Requirement: Direct 必须使用持久写前日志和保守 exposure
系统 MUST 在调用 `deal` 前持久化唯一 active pending Direct 记录，包含 config revision、安全指纹、canary、order tuple、数量、能量、计划/最坏 milli-credit 净额、底价、冻结的 `effectiveEnergyShadowPrice` 及其 components/observedAt、保护 revision、terminal/credits 前态、`attemptAt`、outgoing transaction key 基线/窗口、首个 post-attempt 物理观测与两个成功缺失观测 tick。active 状态只能为 `prepared/submitted/reconcile_gap`，三者的资源与能量 exposure MUST 保留到交易唯一确认、严格证明未成交或经审计 operator resolution。无法校验或恢复的 pending/容器原始证据 MUST 进入持久 quarantine，不得静默丢弃或进入 typed 算术。

#### Scenario: Deal 返回非 OK
- **WHEN** arbiter 返回非 OK
- **THEN** 系统先把 failed outcome 写入有界审计，再删除 active pending、释放本次 exposure；同 tick 不尝试第二张订单

#### Scenario: Deal 返回 OK
- **WHEN** arbiter 返回 OK
- **THEN** 系统依次持久化 resultCode、submittedAt，最后以 status=submitted 作为 commit marker；计划数量继续作为保守 exposure 进入生产保护，直到 outgoing transaction 唯一确认

#### Scenario: Deal 调用后的 CPU 中断
- **WHEN** 下一 tick 发现仍为 `prepared` 的跨 tick 记录，无法证明上一 tick 是在调用 deal 前还是调用后中断
- **THEN** 系统必须把它当作不确定已提交 intent，冻结新写、保留完整 exposure 并执行与 submitted 相同的交易对账；绝不得重新提交

#### Scenario: 已知 statement-boundary 半状态
- **WHEN** CPU 截断留下 submitted 但缺 submittedAt，或 prepared/submitted 已保存 changed 首物理观测
- **THEN** normalizer 只能分别恢复为 prepared 或 reconcile_gap；首个 unchanged observation 已落盘但 missing tick 未落盘时必须恢复其原 observedAt，其他未知半状态进入 quarantine

#### Scenario: Pending 容器损坏或缺失
- **WHEN** schema-v1 pending 容器缺失或为 null/primitive/array、quarantine 容器已存在但为非法形状，或单条 pending 无法完整校验；新增 quarantine 字段单纯缺失按空迁移
- **THEN** 系统必须保留 quarantine sentinel/原始证据、Direct 零写并将 pending/exposure/drain 按非零处理；由于无法可靠归属 room/resource，所有卖出候选和生产 Terminal 消费全局 fail-closed，直到 operator 修复

#### Scenario: 兼容容器或 Maker 持久记录损坏
- **WHEN** 顶层 market-sale container、present canonical Direct container、首次 legacy pending alias，或 Maker `managedOrders`/`pendingMutations` 容器/单条记录或 `pendingCreate` 不能通过完整 schema 与生成态交叉不变量校验；交叉不变量至少包含 pending-create `exposure === tuple.totalAmount`、按 tuple 精确重算的 create fee，且每条 pending mutation 必须有同 orderId 的完整 managed sibling并按 mutation kind 精确重算 prospective fee
- **THEN** 系统必须先完整构造对应原始 sentinel、非 qualification migration blocker 和清理后的 typed 状态，再以单次 canonical container assignment 同时提交；commit 前 CPU cut 保留原记录，commit 后 CPU cut 保留 quarantine；全局 market-sale write latch 必须在 Maker reconcile、prepared retry、drain cancel 和规划前成立，当前及后续 tick 只允许只读投影，不得抛错或调用 deal/create/extend/reprice/cancel；pending/exposure/drain 按非零处理且所有生产 Terminal 消费全局 fail-closed

#### Scenario: 安全空迁移与 blocker 优先级
- **WHEN** canonical Direct 状态缺失，且 legacy alias 同时缺失或是显式空对象
- **THEN** 系统可以初始化空 Direct 状态；但任何 present-but-malformed 值都不得按空处理，已有 qualification-only blocker 也不得掩盖后来发现的 pending/quarantine/market-data 结构损坏

#### Scenario: Qualification-only 损坏与完整 WAL 并存
- **WHEN** Shadow qualification 损坏但 Direct pending/WAL 本身完整
- **THEN** 系统必须清空未来成交资格并在当前 tick 禁止新 deal，但仍允许自动 outgoing 对账和 exact operator resolution 收敛 pending/exposure；归一化后的下一 tick 清除 qualification-only blocker，不能永久卡住回滚

#### Scenario: 同时已有 unresolved pending
- **WHEN** 存在跨 tick prepared、submitted 或 reconcile-gap Direct pending
- **THEN** 系统禁止新的 Direct 成交

### Requirement: Direct 成交必须以交易记录唯一对账
系统 SHALL 使用基线后新增的 `outgoingTransactions.transactionId + order.id` 幂等确认 Direct 成交。唯一记录 MUST 同时满足 `transaction.time===attemptAt`、`order.id/type/price`、from/to、resource 和 `0<actualAmount<=submittedAmount` 的完整 tuple；按实际量重算的取整能量与保守 milli-credit 净价 MUST 不低于写前底价。系统 MUST NOT 从历史同 tuple、terminal 总差额或订单剩余量猜测成交。

#### Scenario: 唯一交易记录匹配
- **WHEN** 下一 tick 出现唯一基线后新增、time 等于 attemptAt、order type 为 BUY、from/to/order/resource/price/amount 全部匹配的 outgoing transaction
- **THEN** 系统先写 confirmed outcome 与幂等 key，再清除整个一次性 intent 的 active pending/exposure并把 canary confirmed count 增加一次

#### Scenario: 并发导致实际部分成交
- **WHEN** 提交 1,000，但更近玩家先消耗同一订单，使本方唯一匹配实际成交为 1
- **THEN** 系统按实际量重算能量/净价、确认一次 canary 成交并释放整个 1,000 exposure（含未成交 999）；不得把差额视为仍在服务器排队或增加多次 confirmed

#### Scenario: 窗口内有历史同 tuple
- **WHEN** outgoing 窗口仍包含同 order/from/to/resource/price 的旧交易，但其 key 在基线中或 time 不等于 attemptAt
- **THEN** 系统不得用旧交易确认本次 pending

#### Scenario: 同 tick 多条可能匹配
- **WHEN** attemptAt tick 出现两条都满足基础 tuple 的新交易而无法唯一归属
- **THEN** 系统进入 reconcile gap；不得任选一条确认

#### Scenario: Intent 没有成交
- **WHEN** deal 返回 OK 或跨 tick 保持 prepared，`attemptAt+1` 的最早成功 preflight 持久证明窗口覆盖 attempt tick且 terminal resource/energy/cooldown/credits 四项前态均未发生预期变化，随后第二个不同成功 tick 仍无匹配 transaction
- **THEN** 系统先写 not_filled outcome，再删除 active pending、释放 exposure且不增加 confirmed count

#### Scenario: 缺失首个物理观测
- **WHEN** global reset、跳 tick、读取失败、窗口截断、重复同一 tick，或四项前态任一变化使 `attemptAt+1` 证据不完整
- **THEN** 系统必须进入 reconcile gap；不得仅因经过两个墙钟 tick 就释放 exposure

#### Scenario: 交易字段不一致或窗口缺口
- **WHEN** deal 返回 OK 后的缺失不满足上述严格 not_filled 证据，或交易窗口截断、重复、歧义或与 pending 字段不一致
- **THEN** 系统进入 `reconcile_gap`、保留保守 exposure并冻结全部 Direct 写，直到 operator resolution

#### Scenario: 重复读取已确认交易
- **WHEN** outgoing transaction 的幂等 key 已处理
- **THEN** 系统不得重复增加确认次数或重复释放 exposure

### Requirement: Direct gap resolution 必须有权威证据和审计
系统 MUST 提供默认拒绝的 Direct 专用 operator resolution API。resolution MUST 绑定 exact request/order，且只能用权威 outgoing transaction 完整 tuple 确认成交，或用覆盖 attemptAt 的权威无成交窗口加 terminal/credits 前后快照证明 not-filled；operator no-fill outcome MUST 保存完整窗口内容/边界与物理快照的稳定证据指纹。任意字段不符时 MUST 保留 reconcile gap 和完整 exposure。

#### Scenario: Exact transaction resolution
- **WHEN** operator 为 gap 提供可核验的 exact transactionId、engine tuple 和 evidence source，且实际保守净价不低于 pending floor
- **THEN** 系统必须复用自动确认的原子 finalize：写入含 operator/evidence/resolvedAt 的 confirmed outcome、幂等 key、confirmed count 只增加一次、释放 active pending/exposure，并在 count 达到 1 时同时进入不可配置解除的 `paused_for_review`

#### Scenario: 重复 Operator resolution
- **WHEN** operator 对同一 request/transaction key 重复提交 resolution
- **THEN** 系统不得重复增加 confirmed count、重复释放 exposure或离开 paused 状态

#### Scenario: 同时间同条数但证据内容变化
- **WHEN** 已有 operator not-filled outcome 后再次提交相同 observedAt 和交易条数，但窗口交易内容、边界或物理快照任一变化
- **THEN** 系统不得视为幂等重复；必须报告证据冲突并把 Direct 不可逆暂停

#### Scenario: 无法证明的强制清除
- **WHEN** operator 只要求清除、证据窗口不覆盖 attemptAt、tuple 冲突或净价无法证明
- **THEN** API 必须拒绝，reconcile gap 与 exposure 保持不变

### Requirement: Direct resolved outcome 必须有界且先记后删
系统 SHALL 把 `confirmed/failed/not_filled` 和 operator resolution 结果写入最多 50 条的审计环，并在 outcome 持久化后删除 active pending。只有 active `prepared/submitted/reconcile_gap` 计作 pending/exposure。

#### Scenario: 终态归档
- **WHEN** pending 被确认、明确失败或严格证明未成交
- **THEN** outcome 必须保留 request、transaction/evidence key、实际量/价/能量和 resolvedAt，active pending/exposure 变为零且不会永久阻塞 drain

### Requirement: 首次 Direct Canary 只允许一笔小额成交
首次上线 SHALL 把 canary policy 作为代码级 normalizer/active gate：allowlist 恰为 `[X]`、无 expansion grant、非 Hub/非 emergency、min order 1,000、min notional 600,000 credits、单笔最多 1,000、每周期一笔、累计确认一笔、raw orders 最多 1,000、eligible energy-priced orders 最多 200、transaction energy 最多 1,000、terminal energy reserve 至少 25,000、energy shadow hard floor 20、X hard/economic floor 均至少 600、forecast buffer 至少 100,000。第一笔确认后系统 MUST 自动进入本 change 内不可由配置解除的 `paused_for_review`。

#### Scenario: 首次安全成交
- **WHEN** Direct Shadow 已完成 100 周期、operator 显式切换 `mode=direct`，且锁定 canary 出现安全机会
- **THEN** 系统最多提交一笔不超过 1,000 X 的成交

#### Scenario: 第一笔已确认
- **WHEN** canary confirmed count 达到 1
- **THEN** 状态进入 `paused_for_review`，Direct Shadow 不再累计资格且 `activationAuthorized=false`；即使出现新的安全买单也不得执行第二笔

#### Scenario: 只改 revision 或打开 expansion
- **WHEN** 第一笔已确认后 operator 只修改 config revision、重跑 Shadow 或打开 `expansionGrant`
- **THEN** 系统仍必须零 deal；expansion 配置 invalid，只有未来独立 capability delta 和实现审查才能解除首发终态

#### Scenario: 自动扩围
- **WHEN** 其他房间或其他资源出现更高价格
- **THEN** 首次 canary 不得自动更换 room/resource 或增加成交次数

#### Scenario: 首发策略误配置
- **WHEN** allowlist 增加其他资源、floor/buffer 下调、数量/次数/扫描/能量上限越界、打开 expansion grant，或 `maxDirectDealAmount < max(minDealAmount,minDirectOrderAmount)`
- **THEN** 配置必须 invalid、Direct 资格清零且零 deal；不得把永久无机会或越界配置计作合格 Shadow

### Requirement: Emergency Stop 必须覆盖 Direct pending
`emergencyStop` MUST 立即禁止新 Direct 成交，并继续收敛所有 active prepared/submitted/reconcile-gap pending。market-sale 域 MUST 只以持久 `marketStaging` 与 `marketReservations` 两个 canonical 表表达 staging/reservation；live adapter MUST 每 tick汇总它们，任一非空或损坏状态都按非零处理。由于旧 bundle 与本版本均无这两个表的写入生产者，迁移时字段缺失等价于空表；生产 protection reservation 不得重复计入该域。旧 bundle 回滚门槛 MUST 同时要求 Direct pending、资源/能量 exposure、Maker pending/managed exposure、live staging 和 reservation 全部为零。

#### Scenario: Stop 时有 unresolved Direct
- **WHEN** operator 请求 emergency stop 且仍有跨 tick prepared、submitted 或 reconcile-gap Direct
- **THEN** 系统不得删除记录或假装 stopped；必须继续对账并保留 exposure

#### Scenario: 安全回滚
- **WHEN** 所有 Direct/Maker pending 与 exposure 均归零且连续两次 live 读取确认
- **THEN** 系统才可进入 stopped；旧 ResourceControl/Factory 出售闩必须继续为 false

#### Scenario: staging/reservation 状态损坏
- **WHEN** canonical market staging 或 reservation 表不是合法记录映射，或汇总发生 safe-integer 越界
- **THEN** 系统必须将对应活动量按非零处理、阻断连续零确认并投影 `market_domain_activity_invalid`

### Requirement: Direct 依赖的引擎语义必须固定审计
系统 MUST 以 Screeps engine commit `80977824199a596d174d392fd0cf8c458c21fcbd` 的交易费取整、actual underfill、transaction tuple/time、cooldown、改价 `_skip` 及 inactive order 可按实时状态重新 active 的语义作为显式 fixture。实现、mock 或上游相关语义变化时 Direct MUST fail-closed，更新 revision 并重新完成 Shadow。

#### Scenario: Engine fixture 漂移
- **WHEN** 本地 mock、语义 fixture 或激活前官方源码复核不再匹配固定审计版本
- **THEN** Direct 资格必须无效且零 deal；不得静默按旧的部分成交/对账假设运行

### Requirement: 市场观测必须保留最后完整规划证据
系统 SHALL 将当前生命周期状态与最后一次完整 ResourceControl 规划快照分开投影。非规划 tick MUST NOT 用空候选或空拒绝原因覆盖最后完整快照；快照必须带 observedAt、age、maxAge 和 stale 状态，其中 maxAge 固定等于 ResourceControl 规划间隔（当前 10 tick），`age<=maxAge` 为 fresh，`age>maxAge` 为 stale。

#### Scenario: 非规划 tick
- **WHEN** 当前 tick 没有运行完整 ResourceControl 规划且不存在需要每 tick 重验的 exposure
- **THEN** monitor 继续显示最后规划候选和拒绝原因，并把 age 增加；不得显示为本 tick 新鲜

#### Scenario: Stale 边界
- **WHEN** planning snapshot age 等于 maxAge 或等于 maxAge+1
- **THEN** 前者必须仍为 fresh，后者必须为 stale；runtime 与 monitor 不得使用不同阈值

#### Scenario: Direct 机会可观测
- **WHEN** Direct Shadow 选择或拒绝 BUY order
- **THEN** monitor 有界展示 BUY 订单数/扫描上限、不同房间、深度、最高原始价、选中数量、transaction energy、planned/worst net、energy shadow 组成和最终接受/拒绝原因；remaining>0 的自有订单分别显示 `manual_sell_order_present` / `manual_buy_order_present`

#### Scenario: Maker 与 Direct 证据分离
- **WHEN** SELL 参考盘不可信而 BUY 侧存在安全 Direct 机会
- **THEN** monitor 分别显示 Maker 的 SELL 深度拒绝和 Direct 的安全机会，不得合并为一个 `depth_untrusted`
