## MODIFIED Requirements

### Requirement: 预留健康区分阻塞、物理承诺与需求覆盖

系统必须（MUST）使用唯一的 demand-coverage 判定供 Hub、Synthesis、入站 amount index 和 automatic merge/replan 使用。Manual pending 任务必须持续覆盖人工需求；automatic `source_depleted` 任务只在配置宽限期内覆盖；automatic `receiver_capacity` 任务只在配置的有界 coverage grace 内覆盖；其他 pending supply/fee blocker 延续 no-progress TTL。物理 receiver commitment 与 outgoing 库存保护可以使用更保守的独立安全判定，但不得被误当成生产需求已经服务的证据。

#### Scenario: Capacity blocker 在短期内防止重复需求

- **WHEN** automatic incoming 任务刚因 receiver capacity 阻塞且仍在 coverage grace 内
- **THEN** Hub 与 Synthesis 的需求覆盖读取继续计入该任务 remaining，且不得创建重复 active coverage

#### Scenario: Capacity blocker 超过 coverage grace

- **WHEN** automatic incoming 任务的 `receiver_capacity` blocker 持续达到配置 coverage grace
- **THEN** 该任务不得再计入生产需求覆盖或 automatic merge，并必须进入可审计取消流程，使 planner 可重新选择 donor/路线

#### Scenario: 耗尽来源不计为 incoming 库存

- **WHEN** 使用默认值时，automatic incoming 任务已保持 source-depleted 100 tick
- **THEN** demand coverage 计算排除其剩余量

#### Scenario: Manual capacity blocker 保留人工意图

- **WHEN** manual incoming 任务长期因 receiver capacity 阻塞
- **THEN** 系统不得按 automatic coverage grace 取消或从人工需求语义中移除它

### Requirement: 自动停滞任务过期而 manual 任务保留

使用默认值时，系统必须（MUST）在 automatic pending 任务连续 5,000 tick 没有成功发送、连续 100 tick source-depleted，或连续 500 tick receiver-capacity coverage 无法恢复后取消任务。系统不得（MUST NOT）对 manual 任务应用这三条 automatic 存活期取消规则。automatic merge 必须跳过已经达到任一取消条件的旧 pending task，即使本 tick reconciliation phase 尚未运行。

#### Scenario: Automatic 无进展超时

- **WHEN** automatic pending 任务超过 5,000 tick 没有取得进展
- **THEN** 系统以机器可读的 liveness reason 取消任务

#### Scenario: Automatic source-depleted 超时

- **WHEN** automatic pending 任务保持 source-depleted 超过 100 tick
- **THEN** 系统取消任务，防止其无限预留虚假 incoming supply

#### Scenario: Automatic receiver-capacity coverage 超时

- **WHEN** automatic pending 任务保持 receiver_capacity 达到默认 500 tick
- **THEN** 系统以 `automatic_receiver_capacity_coverage_timeout` 取消任务，保留终态审计并允许 planner 创建新的单一 active coverage

#### Scenario: Reconciliation 前不合并到过期任务

- **WHEN** HubPlanner 或 Synthesis 在本 tick ResourceControl reconciliation 之前发布相同 automatic route，而旧任务 coverage 已过期
- **THEN** create/merge 路径必须跳过旧任务并创建或复用仍健康的新任务，不得把新 amount 加到即将取消的旧任务

#### Scenario: 旧 manual 任务继续保留

- **WHEN** manual pending 任务年龄超过三项 automatic timeout
- **THEN** 除非用户取消或既有硬校验规则失败，该任务继续保持 pending
