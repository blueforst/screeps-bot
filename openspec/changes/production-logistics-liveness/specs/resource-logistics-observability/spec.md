## ADDED Requirements

### Requirement: 生产需求覆盖与计划 reconcile 必须可观测

系统必须（MUST）在有界 runtime/Monitor 投影中同时报告 raw pending task、仍覆盖生产需求的 incoming、coverage-expired automatic task、按 blocker 的过期原因、distributed synthesis blocked targets、duplicate-assignment 拒绝，以及 Hub-owned config 的刷新/清理/skipped-busy/foreign-owner 数量。观测构建必须复用当轮 task/assignment 索引，不能针对每个房间重复全表扫描。

#### Scenario: 旧任务仍在审计但不再覆盖需求

- **WHEN** receiver-capacity automatic task 已达到 coverage grace、尚未被终态 TTL 清理
- **THEN** Monitor 必须把它计入 raw/coverage-expired 审计，但不得计入 demand-covering incoming

#### Scenario: 配置 reconcile 延迟

- **WHEN** 旧 Hub-owned synthesis config 因房间 busy 未能在本轮清理
- **THEN** runtime 必须报告 skipped-busy 房间/数量和 revision，使操作者能区分安全延迟与 orphan 配置

#### Scenario: 投影历史保持有界

- **WHEN** 多个 plan revision 连续产生 blocked target 或 reconcile 结果
- **THEN** runtime 只保留当前摘要和配置上限内的最近明细，不得无限追加事件日志
