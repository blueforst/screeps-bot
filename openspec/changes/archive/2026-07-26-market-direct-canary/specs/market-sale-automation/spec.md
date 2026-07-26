## MODIFIED Requirements

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
