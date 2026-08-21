# Market 动态价格阈值（市场信号 + 库存状态驱动的出售地板）

## Why

当前 v3 出售地板 = max(签名常量 hardFloor/economicFloor, 市场历史 floor, ratchet)。历史/ratchet 分量已经市场驱动（日频历史、每日最多 -5% 单调衰减），但存在三个与用户目标（"根据市场和库存动态调整价格阈值"）冲突的结构问题：

1. **常量层无升级路径**：任何 hardFloor/economicFloor 调整（如 2026-08-21 的 X 600→480）都会使 permit 链 grant 指纹失效、触发 `market_base_v3_config_rollback_after_cutover` 永久闩锁，唯一恢复是全量状态重置并损失 ~8 小时资格重积累（已发生一次，见 `decentralized-logistics-contracts/evidence/market-automation-unlock.md`）。动态阈值意味着策略值会持续演进——没有迁移路径的动态化等于每次调整都重置。
2. **无当前市场信号**：ratchet 只随日频历史统计更新，对当日订单簿变化（如 X 出价 500→505 的日内回升）不响应；canary 已因"地板 600 vs 出价 500"空等，本质上把定价权交给了昨天的历史。
3. **无库存信号**：sellable（保护账本扣减后的真实盈余，如 X 的 141k vs 生产保护 100k）不参与定价——大量滞销盈余与稀缺线使用同一地板，违背库存管理直觉。

## What Changes

- **P0 前置：permit 链策略升级迁移路径**。新增 operator 操作（两步协议，与现行 propose/accept 同构）：以新策略指纹对全部 active grant **re-sign**，保留 lane lifecycle 证据、confirmed canary 高水位、ledger/WAL 与 permit 链历史；迁移提案必须声明新旧 `policyRevision` 对与逐资源地板 delta，accept 后 anchor 以 `activationBlocker: null` 重铸。迁移期间 fail-closed，迁移后零资格损失。本次 `market_base_v3_config_rollback_after_cutover` 闩锁语义收紧为"未经迁移操作的常量变更"，经迁移操作的变更不再闩锁。
- **P1：订单簿分量（日内有界）**。有效地板新增 `bookFloor` 分量：最优可执行 BUY（≥minOrderAmount、能耗合格）价格的短周期 EMA（建议 α 对应 ~6h）。`bookFloor` 只允许把有效地板**向下**拉到 `min(ratchet, bookEMA × (1 + listingBuffer))`（listingBuffer 为签名常量，如 3%），**永不低于 hardFloor**，且单日累计下移不超过签名的 `maxDailyDynamicDrop`（建议 15%/日，宽于 ratchet 的 5% 以便跟随市场，但仍受 hardFloor 与走廊约束）。ratchet 单调不降守卫不变——动态下移走 bookFloor 旁路，不触碰 ratchet 本体，避免破坏审计链。
- **P1：库存分量（走廊系数）**。每 lane 计算 `surplusRatio = sellable / max(rollingMaxAmount, laneReserve)`（保护账本后真实盈余相对滚动出售上限的倍数），映射到 listingBuffer 的有界调整：盈余 ≥N 倍（如 3×，即卖很多个窗口也卖不完）时取走廊下沿（更愿意降价出清）；盈余 ≤1× 时不下调（bookFloor 退化为纯市场 EMA）。系数与走廊上下界全部为签名常量。
- **P2：动态分量投影与验收**。`lastPlanningSnapshot` 新增有界动态地板投影（各分量值、EMA 状态、surplusRatio、采用的 corridor 决策），monitor 可观察。动态分量先以**观察模式**上线（只投影不生效）一个验收窗口，再经用户确认切换生效。
- 安全不变量全部保留：hardFloor 绝对底线、ratchet 单调不降、permit/WAL/arbiter 链、单 lane 单 canary、单笔 1,000 与滚动上限；动态分量不得放大成交额度（只调价格阈值）。

## Capabilities

### Modified Capabilities

- `market-direct-continuous`：地板计算加入 bookFloor/inventory 分量（有界、投影、观察模式开关）；permit 链新增 re-sign 迁移操作与其 fail-closed 语义。

## Impact

- 代码：`marketBaseResourcePolicy.ts`（策略结构 + 签名负载）、`marketBaseResourcePermit.ts`（迁移操作与验证）、`marketSalePricing.ts`（EMA/走廊计算）、`marketBaseResourceAutomation.ts`（投影）、monitor 投影、测试（预计 +15~25 cases，遵守 500 预算需同步归并）。
- 运维：一次迁移操作演练（用 X 480 r2 → r3 演示零损失升级）；观察模式窗口 ~1 天。
- 风险：permit 链语义变更是安全敏感面（re-sign 必须杜绝绕过 canary/生命周期证据）；动态分量错估可能导致贱卖——由 hardFloor + 走廊 + 观察模式三层兜底。
