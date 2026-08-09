# tick-phase-contract Specification

## Purpose
TBD - created by archiving change tick-phase-contract. Update Purpose after archive.
## Requirements
### Requirement: 主循环必须保持 canonical phase 顺序
系统 MUST 以当前代码为基线，按以下精确顺序执行每 tick 的 37 个顶层 CPU phase：`announceDeploy → marketSalePreflight → pixelGenerator → productionMonitor → nukerControl → hubPlanner → hubUpgradeControl → synthesisControl → factoryControl → mineralExtraction → resourceControl → marketSaleAutomation → hubProgressAnalytics → hubProgressOverlay → externalTelemetryExport → memoryCleanup → portalDiscovery → flagControl → crossShardSignals → interShardControl → warControl → powerBankObserver → powerBankHarvest → powerCreepControl → powerSpawnControl → roomPlannerConstruction → linkControl → coreDefense → defenseMode → homeDefense → towerControl → refreshWorkerTasks → bootstrapRooms → remoteMining → scheduleSpawnTasks → spawnWork → creepWork`。phase 名 MUST 唯一；本变更不得增删、合并或重排任何 phase。

#### Scenario: 完整成功 tick
- **WHEN** 主循环完整执行且没有 phase 抛出异常
- **THEN** 37 个顶层 phase 必须按 canonical 顺序各执行一次，随后执行 profiler `flush`

#### Scenario: phase 顺序发生漂移
- **WHEN** 任一顶层 phase 被增删、重命名、重复或移动
- **THEN** 完整顺序回归测试必须失败，且该拓扑变化必须通过独立 OpenSpec 说明影响范围

### Requirement: 模块加载初始化不得进入 tick phase
系统 MUST 在 tick loop 外且首次执行前完成 prototype mount、Global API、Console 命令与 Production API 注册，不得把这些注册加入每 tick canonical phase。

#### Scenario: 连续执行多个 tick
- **WHEN** 同一 global 生命周期内连续调用 loop
- **THEN** 注册逻辑不得因 tick 执行而重复，且 `spawn.work()` 与 `creep.work()` 在 executor phase 到来前必须可用

### Requirement: 特殊 executor profiler 边界必须保持
系统 MUST 保持 `spawnWork` 对每个 Spawn 使用 room 粒度 profiler wrapper，并保持 `creepWork` 对每个 Creep 使用 creep 粒度 profiler wrapper；这两个 wrapper 不得被普通零参 phase 调用替代。

#### Scenario: 多 Spawn 与多 Creep 执行
- **WHEN** 一个 tick 存在多个 Spawn 与多个 Creep
- **THEN** 每个 Spawn 和 Creep 的 `.work()` 必须继续在对应内层 profiler wrapper 中执行

### Requirement: 失败传播和 flush 基线必须保持
系统 MUST 保持当前 fail-fast 基线：任一顶层 phase 抛出异常时，异常继续传播到外层 error mapper，所有尚未执行的后续 phase 与成功路径 `flush` 均不执行；本变更不得增加逐 phase catch、回滚或失败后继续执行。

#### Scenario: 中间 phase 抛出异常
- **WHEN** canonical 顺序中的任一中间 phase 抛出异常
- **THEN** 后续 phase 与 `flush` 不得执行，且异常必须由现有外层 error mapper 处理
