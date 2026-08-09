## Why

shard1 的 120 样本窗口中，`marketSalePreflight` 与 `marketSaleAutomation` 合计平均消耗约 43.7 CPU，占总 CPU 均值约 44.9%；当前 V3 首次 scope read 的累计 CPU 多次达到 28.8–42.7，并在订单评分前越过 25 CPU 硬门。只读 profile 进一步确认主要成本来自同一 outer session 内重复 canonical 配置、授权与 ratchet 校验，以及 runtime status 对同一 Continuous ledger 的重复完整验证，而不是当前 8 房 56 lane 的重建本身。

## What Changes

- 为一次 V3 outer automation session 建立私有、不可持久化的静态认证上下文：配置 mismatch、operator authorization 与 current ratchet 只认证一次，并绑定 exact state/session；两次 planning read 继续分别读取并校验 trusted floors、room observations、production protection、orders、terminal、quota 与 arbiter 事实。
- 将 Continuous runtime quota 状态投影改为一次 ledger 验证、一次 retained receipt 聚合、批量生成全部 entry quota，移除同一只读状态投影中的重复 full-ledger audit。
- 增加调用次数、第二读变化、canonical malformed input、CPU cut 与零 commit/claim/deal 回归，证明性能复用没有扩大写授权。
- 保持 25 CPU ceiling、Shadow/Canary/Continuous 门禁、WAL 与 `commit → claim → deal` 顺序不变；本轮不启用任何真实市场交易。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `market-sale-automation`: 补充同一 tick canonical 工作复用、动态事实双读隔离、批量只读 quota 投影与 CPU 安全验收要求。

## Impact

- 主要影响 `src/runtime/marketBaseResourceAutomation.ts`、`src/runtime/marketDirectContinuousLedger.ts`、`src/runtime/marketSaleAutomation.ts` 及其定向测试。
- OpenSpec 仅修改既有 `market-sale-automation` capability；不扩展 `market-base-resource-all-rooms` 的 rollout 范围，也不触碰 `market-production-donor-contract`、通用物流 Agent 或当前未提交的 upgrader/hub/colonizer 改动。
- 线上验证仍在 shard1 全 `shadow+suspended` 状态进行，要求 managed order、pending mutation、terminal claim 与 deal 均为零。
