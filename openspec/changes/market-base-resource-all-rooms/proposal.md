## Why

当前 Continuous Direct 只把 X/E6N59、H/E3N59、Z/E7N57 三条单房间 lane 写入 canonical execution table；线上其他房间即使持有大量基础矿物和正常 BUY 订单，也不会进入规划。与此同时，E6N59 等 seller terminal 的能量补给目标低于市场写门槛，Hub 保护快照会间歇过期，导致已授权 lane 长期安全等待。

## What Changes

- 将可自动出售资源严格冻结为七种基础矿物 `H/O/U/L/K/Z/X`。Energy 只作为生产与交易燃料；G、Deposit 原料、Power、ops、Pixel、所有反应中间产物、T1/T2/T3、Boost、Factory/Commodity 与 seasonal 资源均永久不进入候选。
- Permit 冻结“自有、可见、controller.my、具有 terminal”的自动房间准入规则和最大房间/lane 上界；当前八房及未来新房自动派生只读 seller lifecycle。新房无需仅为加入 roster 再签 successor，但必须从独立 `Shadow + suspended` 开始；Canary/Continuous 仍只能由至少后续两次 exact successor 完成“登记 suspended → 授予写权”。
- **BREAKING**：把 v2 的“一个 entry 只执行 `allowedRoomNames[0]`”升级为多房间 lane 合同；兼容读取器只能让旧 v2 permit 继续其原有精确授权，不得被新 bundle 隐式解释为全房间授权，扩围必须签收 v3 successor。
- 新资源、新发现房间、terminal/ownership 实例变化，或改变 Hub/native/floor/reserve 条件时都必须使用新的不可变 policy/lane ID，并从 `Shadow + suspended` 开始；不得用既有 X/E6N59 outcome 或旧 policy fingerprint 直接授权新 lane。
- 每个资源只读取一次可信历史和完整 BUY book，再为各房间计算独立 transaction-energy-adjusted 单位净价；最终仍按最高安全单位净价全局排序，订单剩余量、库存量或容量压力不得覆盖价格优先级。
- 允许 capacity pressure/emergency 房间以及 Hub 在“本 lane 保护账本完整、确有显式可售余量、terminal 可执行”的前提下出售基础矿物；容量状态只能决定能否执行和释放空间，永远不能降低净底价、底仓或生产保护。
- 为 seller terminal 引入 current effective post-deal energy reserve；它同时保护 25,000 基线、普通 terminal reserve、生产承诺、pending Energy send 数量及全部内部发送手续费，并在其上再准备最大市场交易费。它只生成内部 Carrier 补给任务，不购买 Energy；补给不读取 room energy floor，但不得侵占生产承诺或已有 terminal action。
- 修复 Hub/合成保护证据的时序：早期 preflight 继续只负责 WAL 收敛，出售规划只使用 Hub、Synthesis、Factory、ResourceControl 全部运行后的 current planning snapshot；任何未知作用域或过期证据仍全局零写。
- 对七个资源和全部授权房间设置固定上界、去重缓存、仅 Shadow 使用的稳定轮转、可验证 prefix checkpoint 与有界观测；全部 writable lane 始终完整扫描。保持全局单 pending、固定 1,000、每周期最多一笔、global/resource/room/lane rolling quota、account-global 1,000 tick cooldown、写前双读和 append-only receipt/permit chain。
- 部署时先进入兼容迁移态：既有 v2 WAL/receipt/quota 继续按历史 permit 收敛，新 v3 lane 先零写；仅在测试、独立复审、对应 Shadow/Canary 证据和 successor permit 均通过后逐 lane 启用。Pixel generator、legacy ResourceControl seller 与 Factory seller 继续关闭。

## Capabilities

### New Capabilities

- `market-base-resource-all-rooms`: 定义七种基础矿物、自动准入的自有 terminal 房间、多房间最高净价规划、v2→v3 permit/WAL 迁移、生产侧能量准备和安全发布合同。

### Modified Capabilities

- `market-sale-automation`: 将 Direct 候选范围限定为显式基础矿物白名单，并允许具备完整生产保护证据的 Hub/容量紧急房间参与安全直售；补充 seller terminal 能量准备与 late planning snapshot 要求。
- `market-direct-continuous`: 将旧的三资源、单房、native/non-Hub/non-emergency 合同明确限定为 v2 compatibility evaluator；v3 的七资源、动态房间与 Hub/emergency 安全合同由本变更接管。

## Impact

- 主要影响 `marketDirectContinuousPolicy/Automation/Planner/Ledger`、`marketSaleConfig/Runtime/ProtectionAdapter`、`resourceControl`、Memory 类型、console controls、monitor 与相关 Jest。
- 持久状态需要新 schema/capability migration 和 successor permit；旧 receipt、quota、attempt sequence、processed keys、lifetime/high-water 必须原样继承。
- 不增加外部运行时依赖，不恢复 Maker/hybrid，不新增 `Game.market.deal` 调用点。
