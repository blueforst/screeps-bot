## Why

当前 X 市场存在高于 600 信用底价的可执行买单，但首发市场自动化只验证 Maker 卖单：Shadow 依赖 SELL 侧参考深度，Direct 买单排序仅停留在纯函数测试层，导致 E6N59 已有 72,047 X 可售、最高买单为 665.8 × 1,000 时仍持续零候选、零 Shadow 进度。系统还会在非 ResourceControl 规划 tick 清空上一次候选和拒绝原因，使真实卡点难以持续观测。

## What Changes

- 新增显式 Direct 策略与 Direct canary 运行模式；Maker 与 Direct 使用独立资格、Shadow 证据和安全指纹，既有 Maker 行为不被隐式改写。
- 将现有 Direct 纯候选算法接入只读 Shadow：按实际可部分成交量计算交易能量净价，优先最高净价买单；没有达到底价的买单时记录安全等待，而不是转向低价大单。
- Direct 资格不再依赖 SELL 侧 Maker 深度，也不要求多张同价安全买单；Shadow 资格依赖可信历史、显式绝对/经济底价和完整 current-tick BUY 盘口读取，只有实际写入时才要求真实可执行买单及动作前重验。
- 新增 Direct 写前日志、市场/terminal 仲裁、生产保护与订单 TOCTOU 重验、成交后 transaction 对账、失败退避和保守 exposure 生命周期。
- 修复市场观测投影：非规划 tick 保留最后一次完整规划快照及其 tick/age，同时分别展示 Maker 卖盘、Direct 买盘、候选净价和安全等待原因。
- 首次上线仅允许动态锁定一个非 Hub、非 emergency 房间的 X canary，单笔最多 1,000；完成 100 个冻结配置的 Direct Shadow 周期和独立审查后才允许 Direct 写入。
- 容量压力只影响候选优先级，不降低 600 的 X 底价；若最高买单消失、净价跌破底价或生产保护变化，则本轮不成交。

## Capabilities

### New Capabilities

- `market-direct-canary`: 定义生产安全的部分 Direct 成交、独立 Shadow 资格、写前/对账生命周期、可观测性和首次 X canary 上线合同。

### Modified Capabilities

- `market-sale-automation`: 保留首发 Maker-only 的历史边界和既有 Maker 行为，但明确在其已部署、旧 Maker canary 被本变更取代并归档后，只有满足 `market-direct-canary` 全部资格与灰度合同的显式 `direct` 模式可以调用主动成交；`hybrid` 仍 fail-closed，Maker canary lock 不得隐式转为 Direct 资格。

## Impact

- 主要影响 `src/runtime/marketSaleRuntime.ts`、`marketSaleAutomation.ts`、`marketSalePricingAdapter.ts`、`marketActionArbiter.ts`、Memory 类型和 monitor 投影。
- 新增 Direct 策略配置、持久化 pending/reconcile 状态、聚焦单元/集成测试和静态市场写门禁测试。
- 实现前先把已部署的 `market-sale-automation` 变更中未执行的 Maker live canary 任务明确标记为“由本 Direct canary 取代”，同步并归档该前置变更，再应用本变更对 canonical capability 的 delta；不把未发生的 Maker 成交写成已验收。
- 部署仍使用现有单 bundle 与 `npm run push`，不新增外部依赖。
- 旧 `resourceControl` 与 `factoryControl` 出售闩继续保持关闭；Maker 托管订单与 Direct 成交共享 terminal action claim，但 Direct 不需要用于归属自建订单的 mutation lease。
