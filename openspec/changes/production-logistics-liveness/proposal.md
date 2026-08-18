## Why

当前生产链会把长期 `receiver_capacity` 阻塞的跨房任务继续当作有效入站，从而让 Hub/Synthesis 误判“需求已被服务”；分布式合成又允许同一房间在同一计划中承诺多个产品，但运行配置只能保存一个反应。两者会把物流阻塞伪装成生产已覆盖，并让路线、保护账本与实际产线分叉，因此必须先修正这层 P0 正确性，才能安全进入 TransferContract/Matcher Shadow。

## What Changes

- 为资源转运任务增加统一的 demand-coverage liveness 判定：`receiver_capacity` 仅在有界重试窗口内占用需求，超过窗口后仍保留原任务审计，但允许生产侧重新选择 donor/路线；`source_depleted` 延续现有宽限与过期语义。
- 让 Synthesis 缺口、pending 统计、Hub route/replan 与保护观测共用同一判定，避免不同消费者各自解释“健康入站”。
- 为分布式合成增加同一 plan revision 下“每房最多一个 active product”的硬不变量；重复分配必须在写配置、路线和保护事实前 fail closed。
- 为 Hub 管理的辅助房反应配置增加 owner/revision 元数据，只回收当前 Hub 版本拥有的计划，不误删人工配置或其他 owner 的配置。
- 投影 blocked target、coverage-expired task、duplicate-assignment 拒绝和计划 reconciliation 结果，保持历史与扫描成本有界。
- 保持现有主循环顺序、legacy ResourceTransferTask 执行权、Terminal/Market arbiter、CarrierTaskBoard 和市场定价不变；本变更不新增 `terminal.send`、deal 或 live 配置动作。

## Capabilities

### New Capabilities

- `distributed-synthesis-plan-liveness`: 规定分布式合成每房唯一 assignment、Hub-owned 配置 revision/reconcile、重复计划 fail-closed 与 blocked-target 观测。

### Modified Capabilities

- `resource-transfer-task-health`: 将 `receiver_capacity` 入站承诺从无限期健康改为有界 demand-coverage 租期，并统一生产消费者的健康判定。
- `resource-logistics-observability`: 增加 coverage 过期、生产 blocked target、重复 assignment 和 Hub 配置 reconcile 的有界诊断字段。

## Impact

- 主要修改 `src/runtime/logistics/resourceTransferTasks.ts`、`src/runtime/synthesisControl.ts`、`src/runtime/hubPlanner.ts` 及其测试。
- 通过 owner-local versioned adapter 读取/写入可选 cfg/runtime 字段并扩展 Monitor 投影；四个 canonical Memory 根声明受 protected fingerprint 冻结，本 change 不绕过该门禁修改声明、不新增 Global API，也不重排 `src/main.ts` phase。
- 为 `decentralized-logistics-contracts` 提供可信的 legacy/production Shadow 基线；不实现 TransferContract、CapacityLease、RoomLogisticsAgent 或持久 StageWorkClaim。
