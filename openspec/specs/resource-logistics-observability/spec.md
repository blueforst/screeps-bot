# resource-logistics-observability 规范

## Purpose

定义房间容量健康、完整资源转运积压、阻塞生命周期和容量缓解动作的持久化有界观测合同，确保 Monitor 能准确诊断非 Hub 任务。

## Requirements

### Requirement: 运行时分析暴露房间容量健康
系统 SHALL 持久化每个受控房间的容量状态、Storage 已用/剩余容量、Terminal 已用/剩余容量、Energy 状态、Energy floor 和真实 Terminal Energy reserve。

#### Scenario: 满仓房间可观测
- **WHEN** 受控房间的 Storage 或 Terminal 已满
- **THEN** 运行时分析报告对应剩余容量为零，且 `capacityState` 为 `emergency`

#### Scenario: Terminal reserve 准确
- **WHEN** 房间的 `energyFloor` 与 `terminalEnergyReserve` 值不同
- **THEN** 分析与 Terminal blocker 输出使用 `terminalEnergyReserve` 中的 Terminal reserve

### Requirement: Monitor 暴露全部 pending 转运任务
Monitor SHALL 从完整资源转运任务存储而非仅 Hub 子集推导 pending 数量和任务明细。每个 pending 任务 SHALL 暴露 origin、reason、remaining amount、task age、blocker、blocker age 和 last-progress age。

#### Scenario: 存在非 Hub 积压
- **WHEN** 存在 pending synthesis、power-bank boost、manual 或 capacity 任务，且没有 pending Hub 任务
- **THEN** Monitor 的 pending 数量包含全部这些任务并且不为零

#### Scenario: 阻塞任务可诊断
- **WHEN** pending 任务存在 blocker
- **THEN** Monitor 报告 blocker 名称和已阻塞 tick 数

### Requirement: 缓解动作和 blocker 聚合必须有界
系统 SHALL 报告最近容量缓解路径，以及逐房间 incoming、outgoing 和 blocker 数量，同时限制持久动作历史大小，并以有界次数扫描任务存储完成聚合。

#### Scenario: 缓解路径取得进展
- **WHEN** capacity-relief 发送成功
- **THEN** 来源房、接收房、资源、数量和交易成本出现在有界最近动作中

#### Scenario: 存在大量历史任务
- **WHEN** 大量 Terminal 历史任务与 pending 任务同时存在
- **THEN** 分析使用一次索引聚合，不得针对每个房间或资源指标重复扫描完整存储
