# market-sale-automation 规范

## Purpose

提供已部署的生产安全 Maker-only 自动出售前置能力，统一生产保护、净价底线、托管订单生命周期与应急排空合同。
## Requirements
### Requirement: 自动出售默认关闭且显式授权
系统 MUST 在缺少显式运行模式、资源 allowlist、逐资源绝对净价底线或信用保护时禁止自动出售。旧 `resourceControl.market.enabled` 与 `factoryControl.market.enabled` MUST NOT 绕过该入口。

#### Scenario: 配置缺失时不出售
- **WHEN** 新市场自动化配置不存在或目标资源没有显式 hard floor
- **THEN** 系统不得新建 deal/create/extend/reprice 或 market staging，并记录 fail-closed 拒绝原因；唯一允许的市场写是为既有托管暴露执行安全撤单及其归属/变更对账

#### Scenario: 空白名单保持为空
- **WHEN** `sellResources` 被显式配置为空数组
- **THEN** 系统不得回退到默认基础矿物列表

### Requirement: 旧 bundle 安全闩
系统 MUST 在迁移、停止与回滚期间持续保持 `Memory.cfg.resourceControl.market.enabled=false` 与 `Memory.cfg.factoryControl.market.enabled=false`，防止旧 bundle 恢复任一旧出售入口。

#### Scenario: 回滚旧 bundle 前保留安全闩
- **WHEN** 新系统已完成 draining 并准备部署旧 bundle
- **THEN** ResourceControl 与 Factory 的旧 market enabled 字段均仍为 false，且部署流程验证后才允许继续

### Requirement: 市场写入口统一
系统 SHALL 仅允许共享 market action arbiter 直接调用 `deal`、`createOrder`、`extendOrder`、`changeOrderPrice` 与 `cancelOrder`。Factory、Boost、Hub、Synthesis 和其他业务模块 MUST 通过意图或该 arbiter 工作。

#### Scenario: 静态架构门禁
- **WHEN** 测试扫描全部 `src/**` 生产源码中的市场写 API，并排除测试/mock 和 arbiter 自身
- **THEN** 除统一 arbiter 文件外不得发现直接调用

#### Scenario: 同房单 tick 单主动终端动作
- **WHEN** 某房 terminal 已由购买、出售或内部发送成功 claim
- **THEN** 同 tick 其他主动 terminal/market 动作必须被拒绝

### Requirement: 当 tick 新鲜的生产保护账本
系统 MUST 在最终出售规划前主动收集当前 Factory、活动及暂停 Synthesis、Hub、Boost/War、关键出站、carrier/in-flight、resource reservation 和托管订单暴露。每个候选账本 MUST 带当前 tick revision、观测时间、TTL 和稳定贡献 ID。

#### Scenario: 后置 producer 未发布也能保护
- **WHEN** War 或 HomeDefense 在主循环中晚于 ResourceControl 执行
- **THEN** collector 仍从当前配置、Game/Memory 事实和未过期承诺计算其资源保护量

#### Scenario: 非 ResourceControl 刷新 tick 仍复核已有暴露
- **WHEN** 本 tick 不执行完整 ResourceControl 规划，但存在 managed 或 pending exposure
- **THEN** 系统仍生成 current-tick 轻量保护账本并复核；无法完整解释时立即进入安全撤单/排空，确认前继续保留 exposure

#### Scenario: 保护来源过期
- **WHEN** 候选资源的任一必要保护来源缺失、过期或 revision 不是当前 tick
- **THEN** 该房间资源本轮完全禁止出售，并记录 `protection_stale`

#### Scenario: Forecast buffer 缺失或不足
- **WHEN** allowlist 资源没有有限正数的 forecast buffer，或该值小于一笔 Maker 安全批次
- **THEN** 配置或该候选必须 fail-closed，不得创建或继续保留托管卖单

#### Scenario: 旧承诺无法去重
- **WHEN** 旧任务没有稳定合同 ID
- **THEN** 系统把它作为独立承诺保守计入，不得因无法去重而少保护

#### Scenario: Hub 分配余量不是生产需求
- **WHEN** distributed synthesis 完成分配后，`allocationLedger.roomCommitments` 表示已扣除本地 reserve、待收发和实际分配的剩余可用库存
- **THEN** collector 不得把该余量计入生产需求；只保护实际 dispatch、route、Hub 目标和显式 surplus 限制

#### Scenario: 同一合成计划的重复视图去重
- **WHEN** 同房同产品的生产计划同时出现在 Synthesis active/paused runtime 与 Hub dispatch
- **THEN** collector 使用同一稳定计划键并按最大金额只计一次；同房不同产品的计划仍分别保护

### Requirement: 可售量不得侵占生产与关键调拨
系统 SHALL 以总库存扣除资源底仓、生产目标与组件、forecast buffer、Boost/War、Hub 链路、所有关键出站、carrier/in-flight 和托管订单暴露后计算可售量。关键任务即使暂时 blocked，在取消或过期前仍 MUST 受保护。

#### Scenario: blocked 生产任务仍受保护
- **WHEN** 生产或手工出站任务因 receiver capacity 或交易能量暂时 blocked
- **THEN** 其剩余量继续从可售量扣除

#### Scenario: 仅可丢弃自动任务过期后释放
- **WHEN** 自动 capacity-relief 任务被显式标记 disposable 且满足 TTL 失效条件
- **THEN** 系统才可以从市场保护量中释放其承诺

#### Scenario: 生产目标以下禁止出售
- **WHEN** Factory 成品或组件、活动/暂停合成原料、Hub 链路或 Boost/War 需求尚未满足
- **THEN** 系统不得出售保护范围内的库存

### Requirement: 托管卖单暴露与生产抢占闭环
系统 MUST 将托管卖单剩余量作为持久 soft reservation。新订单计算 SHALL 扣除所有其他订单暴露；维护某订单时 MUST 排除自身暴露。生产需要抢占时 MUST 先取消并确认真实订单消失，随后才可按最新安全余量新建更小订单；确认前 carrier 不得搬走对应 terminal 暴露。

#### Scenario: 自订单不重复扣减
- **WHEN** 系统重新计算某个托管订单的安全剩余量
- **THEN** open exposure 中排除该订单自身，仅扣除其他托管订单

#### Scenario: 生产需求上升
- **WHEN** 新鲜保护账本使已有托管订单不再安全
- **THEN** 系统请求取消并持续保留 exposure，直到真实订单消失；如仍有余量再另建更小订单

#### Scenario: 同 tick 多个 Carrier 读取同一 Terminal
- **WHEN** 两个或更多 Carrier 在同一 tick 尝试从同一 terminal/resource 取货
- **THEN** 每个 accepted withdraw intent 必须原子预留本 tick 可用量，后续 Carrier 只能看到扣除该预留后的余额；失败 intent 释放，成功 intent 保留到 tick 结束

#### Scenario: Terminal send 与后续 Carrier 同 tick
- **WHEN** ResourceControl 或其他 actor 的 terminal action 已成功占用该房间
- **THEN** 后续 Carrier 不得再按动作前旧 store 从该 terminal 取货；跨 tick 后只按新 store 和自动清零的 intent reservation 重算

#### Scenario: 非完整采样 tick 提高价格底线
- **WHEN** 已有托管订单存在，而 operator 提高 hard/economic floor，或当前可信底价缓存无法证明订单净价安全
- **THEN** 系统在本 tick 以 live price、remaining 和 fee debt 重验 post-action 不变量；不满足或无法证明时立即安全撤单

#### Scenario: 被动部分成交对账
- **WHEN** 外部玩家在两个 tick 之间部分吃掉卖单
- **THEN** 系统按真实 terminal 实存和订单剩余量更新暴露、成交进度与费用摊销，不减少生产保护量

### Requirement: Create Order 归属必须无歧义
系统 MUST 在调用 `createOrder` 前要求 operator 授予覆盖请求至归属窗口的排他 order-mutation lease，并持久记录 lease epoch、pending create、现有订单 ID baseline/hash、唯一请求 ID、包含 immutable totalAmount 与 created tick 的完整订单 tuple、费用与 exposure。全局同时最多一个 pending create；create 成功后 MUST 等待 lease 有效窗口内新增订单 ID 的唯一完整匹配，才能自动转为托管订单。

#### Scenario: 唯一新增订单匹配
- **WHEN** 排他 lease 从请求 tick 到归属 tick 持续有效、baseline hash 未变、没有意外 order delta，且新增 ID 差集中恰有一个订单完整匹配 type、resource、room、price、immutable totalAmount 和 created tick
- **THEN** 系统把该 ID 迁移到 managed orders 并清除对应 pending create

#### Scenario: 租约缺失或发生手工订单变更
- **WHEN** lease 缺失/过期、baseline hash 异常、出现意外 ID，或 operator 声明窗口内发生手工订单 mutation
- **THEN** 系统撤销自动认领并 fail-closed；即使 tuple 唯一也必须由 operator 对 exact order ID attestation，系统不得自动收养或取消

#### Scenario: 归属结果为零或多个
- **WHEN** 新增订单差集没有候选或存在多个完整匹配候选
- **THEN** 系统 fail-closed、告警并保留 pending exposure/fee，绝不猜测、收养或修改可疑订单

#### Scenario: 连续确认没有新增订单
- **WHEN** 当前全部 order ID 相对 baseline 的差集在两个不同 Game.time 连续读取为零，且系统已记录 credits、订单费、terminal 与 outgoing transaction 对账
- **THEN** 系统可把 pending 标记为 `filled_or_absent` 并清除其 exposure

#### Scenario: 多候选由 Operator 解除
- **WHEN** 新增差集存在 tuple 不匹配或多个完整匹配候选
- **THEN** 仅允许 operator 明确指定一个通过 baseline 与完整 tuple 校验的 ID 进行认领，或逐个处理候选并等待所有候选 ID 连续两次从 live orders 消失；所有决议与 snapshot 必须持久审计

#### Scenario: Pending Create 的跨 tick 全局围栏
- **WHEN** `createOrder` 返回 OK 且 pending 尚未唯一归属或审计收敛
- **THEN** 跨 tick 禁止任何后续 create、extend 或 reprice，只允许归属对账与取消已确认 managed order

### Requirement: 稳健且不可递归下调的净价底线
系统 MUST 以 hard floor、economic floor、可信历史底价和上次可信外部底价的有界下调值取最大值。历史参考 MUST 只来自满足完整日、样本量、成交量、新鲜度和异常过滤要求的外部历史。

#### Scenario: 历史异常时冻结
- **WHEN** 历史样本不足、过期、被 MAD 过滤为异常或与可信盘口显著偏离
- **THEN** 系统冻结上一可信外部值或暂停该资源，不得按 tick 连续乘以下调比例

#### Scenario: 每完整日最多下降百分之五
- **WHEN** 新的完整市场日产生更低但可信的外部参考
- **THEN** 可信底价在该日最多向下调整一次且幅度不超过 5%

#### Scenario: 报价向上取整
- **WHEN** 净底价换算为挂单报价
- **THEN** 系统按市场允许精度向上取整，浮点与舍入后仍不得低于底价

### Requirement: 订单簿和历史异常过滤
系统 SHALL 忽略尘埃订单和深度不足的盘口，并对历史完整日使用稳健统计。自有订单价格 MUST NOT 成为长期可信参考。

#### Scenario: 极低尘埃单
- **WHEN** 订单簿出现数量低于参考阈值的极低卖单
- **THEN** 该订单不得降低历史或 maker 报价底线

#### Scenario: 高价一单位诱饵
- **WHEN** 买盘存在极小数量的异常高价订单
- **THEN** 它不得写入长期参考价或改变 Maker 报价；首发运行时也不得因此调用 `deal`

### Requirement: 首发生产执行仅允许 Maker
`market-sale-automation` 首发版本 MUST 只创建或安全撤销小批托管 sell order。后续只有在独立 `market-direct-canary` capability 已部署、Maker managed/pending/exposure 与所有 `remainingAmount>0` 的自有订单均归零，并完成其显式 Direct Shadow、资格、canary 和写前合同后，`mode=direct` 才可调用主动 `deal`。`hybrid` 配置请求 MUST 始终 fail-closed，不得隐式退化成 Maker 或 Direct；Maker 路径和直接成交纯候选算法本身均不构成 Direct 写授权。

#### Scenario: 请求 Hybrid
- **WHEN** 配置模式为 `hybrid`
- **THEN** 系统记录 `hybrid_not_implemented`，按 `off` 的排空合同工作，不创建 Maker 订单也不执行 `deal`

#### Scenario: 已有托管单失去安全条件
- **WHEN** 托管订单的价格、保护量、配置 revision、可信参考或账本不再满足要求
- **THEN** 系统安全撤单并等待真实消失；Maker 路径不得主动扩量、调价或直接成交

#### Scenario: 容量压力下低于底价
- **WHEN** 房间处于 pressure 或 emergency，但没有满足有效底价的安全 Maker 或 qualified Direct 机会
- **THEN** 系统不得挂牌或成交，并记录价格拒绝与容量告警；压力不得降低任一底价

#### Scenario: 后续显式 Qualified Direct
- **WHEN** `market-direct-canary` 的独立 revision/fingerprint/canary 已完成 100 个 Direct Shadow 周期、通过审查并从合法 Shadow 边显式切到 `mode=direct`
- **THEN** 系统只可按该 capability 的 current-tick 最高净价、部分成交、pending/reconcile 和首笔暂停合同执行 Direct；不得继承 Maker 资格或托管订单状态

### Requirement: Maker-only 小批托管订单
系统 SHALL 使用小额托管 sell order，并以可信日成交量和配置批次限制暴露。新建挂单的预计净收入 MUST 覆盖有效净底价和全部未摊销费用。

#### Scenario: 创建安全小批订单
- **WHEN** 非 Hub、非 emergency 房间满足新鲜保护账本、terminal、能量、价格、额度和信用条件
- **THEN** 系统只创建不超过安全 surplus、批次上限和可信日成交量比例的托管卖单

#### Scenario: 同 tick Terminal 已被内部发送占用
- **WHEN** ResourceControl 或其他生产动作已成功 claim 候选房间 terminal
- **THEN** 本 tick 不得创建该房间的 Maker 订单；下一 tick 只能按发送后的 current-tick 库存与保护账本重新规划

#### Scenario: 建单写前库存重验
- **WHEN** 计划已生成但 terminal 资源量、energy、free capacity 或保护可售量在写前不再覆盖计划暴露
- **THEN** 系统不得持久化 pending create 或调用 `createOrder`

#### Scenario: 价格需要变化
- **WHEN** 已有托管订单不再满足当前安全报价
- **THEN** 系统先撤单并确认消失；首发不得用 extend 或 reprice 追价

#### Scenario: 新订单包含 prospective fee
- **WHEN** 系统为数量 q 的新卖单计算报价 p
- **THEN** 必须满足 `p*q-ceilMilli(0.05*p*q) >= effectiveNetFloor*q`

#### Scenario: 取消后的费用债务
- **WHEN** 托管订单取消时仍有未摊销费用
- **THEN** 该费用转入同资源 carried fee debt，由后继订单覆盖；系统不得丢弃债务或降低底价

### Requirement: 订单槽位、Credit 和滚动费用保护
系统 MUST 只管理持久账本中明确拥有的订单 ID，并实施最大托管订单数、手工订单槽位预留、credit reserve、全局同 tick 费用 reservation 与真正跨 tick 的滚动费用预算。

#### Scenario: 订单槽位不足
- **WHEN** 创建订单会突破 `maxManagedOrders` 或 `minFreeOrderSlots`
- **THEN** 系统不得创建、不得取消手工订单，并记录拒绝；只在后续完整 ResourceControl 周期重新评估

#### Scenario: 费用会穿透信用保护
- **WHEN** `credits - 本 tick 已预留费用 - 新费用 < creditReserve`
- **THEN** 系统不得创建订单

#### Scenario: 跨 tick 费用预算
- **WHEN** 滚动窗口内累计费用已达到预算
- **THEN** 后续 tick 仍不得新增费用，直到旧记录离开窗口

### Requirement: 撤单必须写前记录且外部变更 fail-closed
系统 MUST 为 cancel 创建持久 pending mutation，记录变更前价格、totalAmount、remainingAmount、保守 exposure 与 tick。同一订单同 tick最多一个 mutation。自动化 MUST NOT 主动 extend/reprice；若托管订单出现没有本系统 pending 记录的外部 totalAmount 或 price 变化，必须冻结 fee-sensitive 写并要求 exact order ID 的 operator 处理。

#### Scenario: 外部扩量或调价与部分成交并发
- **WHEN** 托管订单的 totalAmount 或 price 出现未授权变化，且 remaining 同时因被动成交下降
- **THEN** 系统仍标记 external mutation gap、保留保守 exposure，不得把变化误认为纯成交或自动接管

#### Scenario: 被动成交费用对账
- **WHEN** 托管订单 remaining 降低
- **THEN** 系统仅以 `outgoingTransactions.transactionId + order.id` 幂等确认成交量与实际价，并按 milli-credit 固定点比例摊销 fee debt、保留舍入余数；不得从 terminal 总差额或 `0.05*成交价*数量` 猜测

#### Scenario: 交易记录窗口存在缺口
- **WHEN** live remaining 与可见 outgoing transactions 无法一致对账或交易窗口已截断
- **THEN** 系统标记 `reconcile_gap` 并冻结 create 等 fee-sensitive 写，只允许安全取消和继续对账

#### Scenario: Cancel 返回 OK 但订单仍存在
- **WHEN** cancel API 返回 OK 而 live orders 仍包含该 ID
- **THEN** pending mutation 和全部 exposure 保持，不得视为已取消

#### Scenario: Pending mutation 阻止重复写
- **WHEN** 某订单已有未确认 mutation
- **THEN** 系统不得对该订单执行第二个 mutation，只能读取并对账

#### Scenario: Policy TTL 与服务器自然到期分离
- **WHEN** 托管订单达到本地 policy cancel tick
- **THEN** 系统发起显式 cancel 并按不退款处理；不得把它记为服务器自然到期

#### Scenario: 服务器自然到期
- **WHEN** 外部权威证据明确确认订单由服务器自然到期、订单已从 live orders 消失，且返费金额已完成 credits/refund 对账
- **THEN** 系统仅按已核验返费冲减 fee debt，并记录 `server_expired`；公开 `Order.created` game tick 不得用于推导自然到期

#### Scenario: 无法解释的订单消失
- **WHEN** 订单消失无法由成交、pending cancel 或服务器到期唯一解释
- **THEN** 系统标记 `unknown_disappearance/reconcile_gap`，冻结 fee-sensitive mutation，不得猜测退款或成交

### Requirement: Emergency stop 必须排空后才可回滚
系统 MUST 通过 `requested → draining → stopped` 状态机停止。`draining` MUST 重试且只取消已确认托管订单、解析 pending create/mutation，并在两个不同 Game.time 连续 live 读取确认所有已知 managed order ID 均从 `Game.market.orders` 消失（不论 active 标志）、pending create/mutation、market staging、reservation 和 exposure 均为零后进入 `stopped`；任一非零项、新订单或新 mutation MUST 重置确认计数。

#### Scenario: 取消请求成功但订单仍存在
- **WHEN** cancel API 返回成功但下一次读取仍看到托管订单
- **THEN** 系统保持 draining 和 exposure，不得删除元数据或允许代码回滚

#### Scenario: Pending Create 在 Draining 中收敛
- **WHEN** emergency stop 遇到 pending create
- **THEN** 系统必须通过连续零差集证据，或 operator 认领后取消并连续确认消失，使 pending 最终安全归零；不得仅等待或静默删除

#### Scenario: 手工订单保留
- **WHEN** emergency stop 执行且账户中存在非托管手工订单
- **THEN** 系统不得取消或修改该订单

#### Scenario: 安全回滚门槛
- **WHEN** 计划回滚到不识别托管订单的旧 bundle
- **THEN** 只有状态为 stopped、连续确认全部 known managed ID 消失、pending create/mutation 与 market staging/reservation/exposure 归零且两项旧 market disabled 安全闩仍在时才允许部署；手工订单不计入零值门槛且必须保持不变

### Requirement: Shadow 模式绝对零写
系统 SHALL 在 Shadow 模式执行与 active 模式相同的账本、价格和候选规划，但 MUST 禁止所有市场写 API、market staging 和 market reservation。

#### Scenario: Active 转入 off 或 shadow
- **WHEN** maker/hybrid 请求切换到 off/shadow，或配置缺失/无效时仍存在订单、pending create/mutation、staging、reservation 或 exposure
- **THEN** 系统先进入 requested/draining；只有排空并达到 stopped 后才正式进入目标模式

#### Scenario: Shadow 观察 100 周期
- **WHEN** 与 canary 完全相同的候选资源、价格底线、信用/费用、批次、历史和 canary 策略配置已冻结为 revision，且 Shadow 在该 revision 连续运行至少 100 个 ResourceControl 周期
- **THEN** 市场写调用和 staging 数均为 0，且所有候选都有接受或拒绝原因；任一相关配置变化必须把连续计数清零

#### Scenario: Shadow 覆盖异常输入
- **WHEN** Shadow 遇到历史不足或异常盘口
- **THEN** 它记录相同的 fail-closed 决策，且不产生任何副作用

### Requirement: 动态 Canary 选择
Maker 与 Direct 均 MUST 按各自 capability 的 live 前置条件确定性选择 canary，不得把 Maker canary lock 直接继承为 Direct lock 或资格。首批候选 MUST 为非 Hub、非 capacity emergency、terminal 正常且有明确 surplus 和可信价格的允许资源；两种策略的 lock、revision 和证据必须隔离。

#### Scenario: 中央 Hub 满仓且正在生产
- **WHEN** Hub 正在 loading、synthesizing 或 unloading，或处于 capacity emergency
- **THEN** 它不得被自动选择为首个 Maker 或 Direct canary

#### Scenario: 没有合格候选
- **WHEN** 所有房间均被生产、容量、terminal、能量、价格或账本条件拒绝
- **THEN** 系统保持等待并投影逐候选拒绝原因，不得放宽底线

#### Scenario: Maker Canary 首次锁定后不自动扩围
- **WHEN** Maker 首次动态选择一个合格 room/resource
- **THEN** 持久锁定该唯一对象、强制有效 maxManagedOrders 为 1 且禁止 hybrid；该 lock 不授权 Direct，直到 Maker 完成验收或安全 drain

#### Scenario: 被锁 Maker Canary 暂时不合格
- **WHEN** 已锁定的 Maker room/resource 在后续 tick 不满足前置条件
- **THEN** 无暴露时系统等待；存在 managed/pending exposure 时立即安全 cancel/drain 并确认归零，同时保留原 Maker lock，不得自动改选第二候选

#### Scenario: 从 Maker 转入 Direct Canary
- **WHEN** operator 采用本 follow-up capability 启动 Direct Shadow
- **THEN** 系统必须先证明 Maker managed/pending/exposure 和所有 remainingAmount>0 的自有订单全零，再按 Direct 自己的确定性排序建立新 lock；Maker lock、Shadow count 或 revision 均不得继承

### Requirement: 运行时观测有界且兼容旧版本
系统 SHALL 投影模式、阶段、账本 revision、可售量、底价组成、候选净价、拒绝原因、费用、订单、terminal claim、退避和安全违规，并限制历史日志大小。Monitor 对旧 runtime 缺失字段 MUST 返回 null。

#### Scenario: 旧 runtime 无新字段
- **WHEN** monitor 读取尚未包含市场自动化字段的 Memory
- **THEN** 输出 null 或明确 unavailable，不得伪造零值

#### Scenario: 安全违规
- **WHEN** 计划或执行检测到低于底价、侵占保护量、非托管订单变更或重复 terminal action
- **THEN** `safetyViolationCount` 增加、资源熔断；若该资源已有 managed/pending exposure，必须进入安全 cancel/drain，而不只是拒绝新动作

### Requirement: Invocation 内静态认证与动态双读必须分层
系统 MUST 在一次 V3 outer automation invocation 内至多执行一次 normalized config mismatch、operator authorization fingerprint 与 current pricing-ratchet canonical 认证，并把结果绑定到 exact frozen runtime session。系统仍 MUST 对 trusted floors、room observations、production protection、orders、terminal、quota、arbiter 与 outgoing window 执行原有 fresh read 和双读一致性门禁；静态认证结果不得持久化或成为新的写授权。

#### Scenario: 稳定 outer session 复用静态认证
- **WHEN** 同一次 invocation 的 state、permit chain、current ratchet 与 normalized config 在两次 planning read 间保持 exact 不变
- **THEN** config/operator/current-ratchet canonical 认证只执行一次，而两次 live room、protection、book、terminal 与 write-context read 均独立发生

#### Scenario: Session source 被替换
- **WHEN** callback 或 outer root replacement 在 planning 完成前替换 state scope、permit chain、ledger 或 current ratchet
- **THEN** exact runtime mismatch 必须使本轮 fail-closed，且不得产生 pending、canonical commit、claim 或 deal

#### Scenario: 第二读动态保护变化
- **WHEN** 第二读仅改变任一 lane 的 protection contribution 或其他动态事实，而静态配置与 permit 保持不变
- **THEN** 系统必须拒绝两读 evidence，清空最终 selection，并保持零 pending、零 commit、零 claim、零 deal

### Requirement: 已认证稳定 Scope 快路不得跳过 live room 事实
系统 SHALL 仅在 opaque runtime session 绑定的 exact frozen scope 已更新到当前 tick，且本次独立采集的全部 admitted room observation 与 frozen seller-room basis 精确一致时复用该 scope。任一 owner、terminal、Hub 分类、房间增删、observation shape 或唯一性变化 MUST 回到完整 reconcile 或 fail-closed；第一读 observation MUST NOT 供第二读复用。

#### Scenario: 当前 tick 房间 basis 完全稳定
- **WHEN** 当前读独立采集的 room name、controller owner、terminal identity、ownership 与 room class 全部匹配已认证 frozen scope
- **THEN** 系统可跳过重复 checkpoint/tombstone/lane 静态重验并复用 exact scope，后续动态市场事实仍按本读重新收集

#### Scenario: 同 tick Terminal 或 Hub 分类变化
- **WHEN** 任一可见房间在 outer reconcile 后改变 terminal identity、controller owner 或 Hub 分类
- **THEN** 稳定快路必须失配，系统执行完整 reconcile 或以 scope blocker 结束，且不得提交 planning 正向进度

#### Scenario: 第二读新增或移除房间
- **WHEN** 两次 planning read 之间 admitted room 集合发生增删
- **THEN** 第二读不得复用第一读 scope，最终计划必须 incomplete 且零市场写

### Requirement: Continuous Quota 状态必须批量验证与投影
系统 SHALL 为 bounded、resource 唯一的 quota request 集合对同一 Continuous ledger 执行一次完整验证和一次 rolling receipt 聚合，再生成逐资源 snapshot。批量结果 MUST 与相同输入下的单资源 quota 字段逐项一致；invalid ledger、非法 limit、重复/空 resource 或越界 batch MUST 整批返回 unavailable。

#### Scenario: 三资源 Runtime 状态投影
- **WHEN** runtime status 为冻结 execution table 的三个资源请求同一 tick quota
- **THEN** 系统只完整验证一次 ledger，并返回与逐资源单读相同的 confirmed、pending、remaining、cooldown 与 retry 字段

#### Scenario: Pending 仅归属一个资源
- **WHEN** ledger 存在未匹配 pending，且其 resource 只命中 batch 中一个 request
- **THEN** global unmatched planned 必须出现在全部 snapshot，而 resource unmatched planned 只出现在匹配资源

#### Scenario: 任一 Batch 输入非法
- **WHEN** quota batch 包含重复 resource、空 resource、负 limit、无效 tick 或超过固定上界
- **THEN** 整批必须 fail-closed 为 unavailable，不得返回部分 quota 或改变 ledger

### Requirement: 市场 CPU 优化不得放宽写安全门禁
系统 MUST 保持 market-base outer 25 CPU ceiling、CPU raw high-water、canonical malformed-input、双读、WAL 与 `commit → claim → deal` 门禁不变。性能验收 MUST 同时证明本地 canonical 工作减少和 shard1 Shadow 多 tick CPU 改善；单个低 CPU tick 不得自动满足 Canary/Continuous 启用条件。

#### Scenario: 优化后 CPU Cut
- **WHEN** 任一阶段的真实 CPU 高水位仍越过 25、读数回拨或读数无效
- **THEN** 系统必须按原 cut phase fail-closed，并保持原 reset-only/pending 语义以及零未授权 claim/deal

#### Scenario: Shadow 线上验收
- **WHEN** 新 bundle 部署到 shard1 并采集性能样本
- **THEN** 全部 lane/grant 必须继续为 `shadow+suspended`，managed order、pending mutation、terminal claim 与 deal 均为零，并至少用多个完整 planning tick 及完整 120 样本窗口比较前后 CPU
