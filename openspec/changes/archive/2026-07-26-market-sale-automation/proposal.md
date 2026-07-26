## Why

现有资源控制在未配置市场参数时会默认开启基础矿物直卖，且缺少强制价格底线、生产承诺保护和统一终端仲裁，已经在线上产生明显低于正常市场水平的成交。帝国同时存在多房间满仓、中央合成卸载受阻的问题，需要一个既能安全释放库存，又不会以容量压力为理由贱卖或破坏生产链的自动出售能力。

## What Changes

- **BREAKING** 将资源控制的出售默认行为改为 fail-closed：未显式选择运行模式、出售白名单、每资源绝对底价和信用保护时不执行任何出售。
- 新增统一的市场自动出售规划与执行域，由 `resourceControl` 负责唯一的出售副作用；所有市场成交必须经过共享 market/terminal arbiter，工厂、合成、Hub、boost/战争链路只发布需求、保护量或出售意图。
- 新增生产兼容的帝国可售量账本，扣除资源底仓、生产与预测需求、关键出站任务、carrier/in-flight 承诺和托管卖单暴露；计划与执行前均重新校验。
- 新增稳健动态净价底线、交易能量影子成本、尘埃订单过滤和小批 Maker 报价；容量压力只能提高处理优先级，不能降低底价。直接成交仅保留为经过测试的纯候选算法，不接入首发运行时。
- 新增 `pendingCreate` 归属闭环和仅管理已确认自身订单 ID 的挂单生命周期、订单槽位/信用/滚动费用预算、失败退避、部分成交对账和安全撤单；首发自动化不主动扩量或调价。
- 新增 `off`、`shadow`、`maker`、`emergencyStop/draining/stopped` 运行状态以及安全回滚流程；保留的 `hybrid` 配置请求明确 fail-closed，不会退化成 Maker 或调用 `deal`。进入 off/shadow 前必须先排空托管订单、pending create/mutation 与 exposure，Shadow 模式禁止所有市场和 staging 写入。
- 退役 `factoryControl` 的独立出售副作用，并将 factory/boost 等现存市场购买入口纳入共享 arbiter；静态门禁禁止业务模块直接调用市场写 API。旧市场配置不能绕过新的 fail-closed 入口。
- 新增运行时观测与 monitor 投影，解释候选、可售量、底价组成、拒绝原因、费用、托管订单和熔断状态。
- 采用动态 live 前置条件选择灰度房间/资源，不硬编码中央 Hub；容量接收阈值调整作为独立变更，不与市场灰度同时上线。

## Capabilities

### New Capabilities

- `market-sale-automation`: 定义生产安全库存账本、价格保护、Maker-only 执行、托管订单生命周期、终端仲裁、观测、灰度和回滚合同。

### Modified Capabilities

无。

## Impact

- 主要影响 `src/runtime/resourceControl.ts`、`src/runtime/factoryControl.ts`、新的市场自动化模块、Memory 类型和 monitor 投影。
- 旧版仅设置 `resourceControl.market.enabled=true` 或 `factoryControl.market.enabled=true` 的配置将不再触发自动出售；必须迁移到显式模式与逐资源底价。
- 不引入外部运行时依赖；市场数据继续使用 Screeps `Game.market` API。
- 本次上线不提供自动直接成交、扩量或调价；`hybrid` 留待独立变更、独立审查和独立 live canary。
- 上线采用独立 worktree、Shadow、动态 canary、第二轮独立审查和实时验收；托管订单与 pending create 未清零时禁止回滚到不识别这些订单的旧代码，且旧 bundle 回滚前必须持久保留 `resourceControl.market.enabled=false` 与 `factoryControl.market.enabled=false`，防止旧版出售入口复活。
