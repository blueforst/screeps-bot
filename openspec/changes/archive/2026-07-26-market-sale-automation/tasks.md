## 1. 安全入口与统一市场网关

- [x] 1.1 新增默认 `off` 的 `marketSaleAutomation` 配置、Memory 类型和 fail-closed 归一化
- [x] 1.2 新增 market action arbiter，统一封装成交、建单、扩量、调价、撤单与每房 terminal claim；首发自动出售只使用建单和撤单
- [x] 1.3 将 ResourceControl、Factory 和 Boost 的市场写调用迁移到 arbiter，并退役 Factory 独立出售路径
- [x] 1.4 添加覆盖全部生产 `src/**` 的静态架构测试，禁止 arbiter 之外直接调用市场写 API
- [x] 1.5 持久设置旧 ResourceControl 与 Factory market enabled=false 安全闩，并覆盖旧配置回归

## 2. 生产保护账本

- [x] 2.1 实现带 revision/observedAt/expiresAt 和稳定贡献 ID 的当 tick 保护账本
- [x] 2.2 收集 Factory target/组件/显式任务、活动及暂停 Synthesis、Hub、Boost/War 承诺
- [x] 2.3 收集所有关键 blocked outgoing、carrier/in-flight、resource reservations，并按合同去重
- [x] 2.4 收集托管订单 exposure、forecast buffer 和 terminal 实存，计算 protected/sellable
- [x] 2.5 对缺失、过期或不可解释的保护来源按资源 fail-closed，并投影拒绝原因
- [x] 2.6 修正 Hub distributed synthesis 余量语义，并按同房同产品稳定键去重 Synthesis/Hub 重复计划

## 3. 价格保护与候选选择

- [x] 3.1 实现完整日历史过滤、log-MAD 稳健参考、外部可信底价缓存和每日最大 5% 下调
- [x] 3.2 实现 hard/economic/history/ratchet 净价底线与市场精度向上取整
- [x] 3.3 实现尘埃/深度过滤、动态 energy shadow price，以及不接入生产执行器的直接成交净价/理论部分量纯算法
- [x] 3.4 实现 Maker 建单前 terminal、能量、保护量和 action budget 的 TOCTOU 重验

## 4. Maker 与托管订单生命周期

- [x] 4.1 实现小批 maker 报价、动态非 Hub canary 前置条件、持久唯一 canary lock 和逐候选拒绝原因
- [x] 4.2 实现 operator 排他 order-mutation lease/epoch/baseline hash、全局单 pendingCreate、immutable totalAmount/created tick 完整 tuple 唯一归属、无租约时 exact ID attestation、跨 tick mutation 围栏、连续零差集自动收敛、operator 歧义解除审计、仅自有 order ID、部分成交对账、self-exposure 排除、取消重建，以及 policy TTL/服务器 expiry/refund 分离；首发不主动 extend/reprice
- [x] 4.3 实现订单槽位预留、credit reserve、全局同 tick 费用 reservation、跨 tick 滚动费用预算，以及托管撤单失败退避
- [x] 4.4 实现 cancel pendingMutation 写前/确认协议、transactionId+orderId 幂等 fill 对账、milli-credit fee debt 定点摊销/舍入余数/取消继承、外部扩量/调价 gap 熔断，以及含 create prospective fee 向上取整的 post-action 净价不变量
- [x] 4.5 实现生产抢占前先取消并确认真实消失、必要时按新余量重建，以及同 tick Carrier/terminal action 原子预留，保证 carrier 不搬走未释放 exposure

## 5. 模式、停止与观测

- [x] 5.1 实现 `off/shadow/maker`；`hybrid` 请求明确 fail-closed，进入 off/shadow 前排空，Shadow 保证市场写、staging 和 reservation 均为零
- [x] 5.2 实现 `requested → draining → stopped`，连续确认全部 known order ID 消失、零 pending create/mutation、零 exposure 后才允许回滚
- [x] 5.3 新增有界 runtime/data 状态、拒绝原因、安全违规、费用和 terminal claim 观测
- [x] 5.4 扩展 monitor 投影并保持旧 runtime 缺字段输出 null

## 6. 验证与上线

- [x] 6.1 添加价格、历史异常、尘埃盘口、Maker 净价、prospective fee、milli-credit 取整、纯直接候选算法、TOCTOU 和舍入单元测试
- [x] 6.2 添加生产目标、暂停合成、blocked 关键任务、去重、stale ledger 和托管 exposure 测试
- [x] 6.3 添加订单额度、费用债务、滚动窗口、lease有效/过期/手工碰撞、pending create 长期唯一/零/多候选收敛、cancel pending mutation、外部调价 gap、部分成交、draining、手工订单保护和回滚测试
- [x] 6.4 添加多周期 terminal claim、Factory/Boost 回归、Shadow 零写、动态 canary 和 monitor 兼容测试
- [x] 6.5 运行聚焦测试、全量测试、`tsc --noEmit`、构建和 OpenSpec strict 验证
- [x] 6.6 完成独立 subagent 代码审查并关闭全部阻断发现
- [x] 6.7 合并至 `main`，部署旧 market disabled + 新模式 off 的安全版本并实时复核
- [x] 6.8 **取消并由 `market-direct-canary` 取代**：Maker Shadow 因 SELL 参考深度不足未形成合格 canary；未宣称完成 100 周期，保留零写 live 证据并由 follow-up Direct Shadow 重新累计独立资格
- [x] 6.9 **取消并由 `market-direct-canary` 取代**：未执行 Maker 市场写或成交；后续仅按独立 Direct capability、重新审查和 live canary 合同启用
