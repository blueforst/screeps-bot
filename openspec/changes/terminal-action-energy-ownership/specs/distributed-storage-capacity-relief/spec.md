## MODIFIED Requirements

### Requirement: 生存与显式 Energy 转运使用受保护的总库存

系统 SHALL 从 Storage 与 Terminal 的 Energy 总量计算已存在跨房动作的 donor 可用量，同时保留 ordinary Terminal Energy reserve、有效生产预留、其他出站承诺、其他交易费用和市场 exposure。Donor `energyFloor`、`energyTarget` 与 `energyExportStart` 只可用于房间状态、本地高耗能任务、接收恢复需求或无任务自动平衡策略，不得再次否决 manual、Hub、Synthesis、War 或 capacity-relief 的已有任务。生存 Energy 支援 SHALL 先于自动容量缓解运行。

#### Scenario: Terminal-heavy donor 可以履行任务

- **WHEN** donor 的 Energy 总量高于全部显式所有权，即使 Storage Energy 单独低于 floor/target/exportStart
- **THEN** 超出显式所有权的部分可用于已存在的跨房任务

#### Scenario: 显式所有权优先

- **WHEN** 拟发送 Energy 或对应费用会穿透 ordinary Terminal reserve、production、其他 task/fee commitment 或 market exposure
- **THEN** 系统减少发送量或跳过发送

#### Scenario: Receiver target 只定义自动恢复需求

- **WHEN** 系统计算无任务自动 Energy 恢复需求
- **THEN** 可以继续使用 `energyTarget-storageEnergy`；已有显式 task 不得因该需求为零而被取消或截断
