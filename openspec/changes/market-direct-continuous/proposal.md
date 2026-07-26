## Why

Direct X canary 已完成真实成交并通过独立复核，但当前实现按设计永久停在 `paused_for_review`，且只允许 E6N59/X。用户现已明确授权常态化自动出售多种商品；系统需要在不恢复旧低价 seller、不侵占生产链资源的前提下，把一次性 X 证据升级为逐资源、可审计、有限速的 Direct 自动出售能力。

## What Changes

- 新增 canonical 多资源执行表。首批仅纳入三个经过 live 库存、生产承诺、原生矿类型、14 日历史与 BUY 盘口复核的 lane：
  - X / E6N59：hard/economic floor 600/600，lane buffer 100,000，30,000 tick 内最多 8,000；
  - H / E3N59：原生 H，hard/economic floor 428/451，lane buffer 100,000，30,000 tick 内最多 8,000；
  - Z / E7N57：原生 Z，hard/economic floor 43/45，lane buffer 100,000，30,000 tick 内最多 5,000。
- 三个 lane 均固定单笔 1,000、确认间隔 1,000 tick；全资源合计 30,000 tick 最多 12,000，跨资源/跨房间仍只有一个 active Direct pending。每个当前确有安全机会的 canary/continuous 资源在 global quota admission 中保留 1,000，避免 X/H 的绝对单价让 Z 永久饥饿；已准入订单内部仍严格按单位净价排序。
- X 精确复用已审 transaction `6a65f8e1656d080013d32210` 作为 reviewed canary。H/Z 各自执行 `100 个完整 Shadow 周期 → 单笔 canary → 资源级 review pause → continuous permit`；新资源不得继承 X 的价格、额度或资格。
- 所有授权写入不可变 permit 链：permit 绑定 shard/account、epoch、完整 reviewed evidence digest、engine/Direct fingerprint、排序稳定的执行表、全局限额与前一 permit/ledger head。配置或 allowlist 漂移不会重置旧额度；successor permit 必须继承账本。
- 所有成交写入单调 attempt/WAL 与 hash-chain receipt：固定 `outcome → receipt/head/checkpoint → processed evidence key → 删除 pending` 的提交顺序，任一中断先在 preflight 幂等收敛；缺口、分叉、冲突或 coverage 不足均持久锁死新写。
- 候选不再先按库存、容量或订单批量选资源/房间。系统对所有已授权 `(resource, seller room, BUY order)` 计算动作后单位净价，按单位净价、总净额、gross price 和稳定键全局排序；两次完整读取的最佳 tuple 变化时本 tick 零写。
- 强化生产保护：lane reserve 同时纳入 `mineralFloor`、`mineralExportStart`、Factory resource floor；将绝对目标与消耗性需求分开计算，并保护尚未生成 transfer 的 Synthesis donor、Hub、Boost/War、blocked transfer、carrier/in-flight 与既有 exposure。
- 部署默认零写；旧 `resourceControl.market`、`factoryControl.market` 和 Pixel generator 保持关闭。新 bundle 丢失 permit/ledger 时不得重新获得“首笔 canary”；回滚到 `669bce3` 及再升级必须 fail-closed。
- 首版明确排除 Energy、Power、ops、Pixel、G/O、U/L/K、所有反应中间物/T2/T3、Battery/bars/Factory/Deposit/seasonal 商品。后续只能通过新 evidence 与 successor permit 分批加入。

## Capabilities

### New Capabilities

- `market-direct-continuous`: 定义逐资源 lifecycle、canonical permit、全局最高单位净价调度、双层滚动额度、单调 WAL/hash-chain、恢复、观测与分阶段启用。

### Modified Capabilities

- `market-direct-canary`: 保留旧 X canary 为只读历史种子，永久退役其旧写路径，并允许新 capability 用精确 outcome digest 承接；其他资源必须独立 Shadow/canary/review。
- `market-sale-automation`: 强化多资源生产保护来源与可售量公式，Direct continuous 使用显式 lane 而非旧单 canary 动态扩围。

## Impact

- 代码：`marketSaleConfig`、`marketSaleProtectionAdapter`、`marketSaleProtection`、`marketSaleDirectShadow`、`marketSaleDirectAutomation`、`marketSaleDirectPending`、runtime/monitor、Memory 类型。
- 状态：Direct schema 升级；新增 permit history、逐资源 lifecycle、单调 attempt sequence、receipt hash-chain、滚动 checkpoint 与全局/资源 quota。
- 测试：生产保护来源、跨资源全局排序、逐资源资格、permit successor、所有 WAL 中断前缀、第 51/65/201 笔、Memory 删除/回滚 golden fixture、完整 Jest/TypeScript/build/OpenSpec。
- Live：先部署为未授权，核对 migration genesis ledger 与 policy fingerprint；签收 epoch 1 genesis permit（X continuous、H/Z Shadow）。X 可先进入 continuous；H/Z 分别在完成 canary 与独立审查后追加 successor permit。
