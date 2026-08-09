# resource-transfer-task-health 规范

## Purpose

定义资源转运任务从创建、阻塞、恢复、预留健康到自动过期的完整生命周期，以及 manual/automatic 来源和旧数据保守迁移合同。

## Requirements

### Requirement: 转运任务记录来源和进度
每个新转运任务 SHALL 记录其为 `manual` 或 `automatic`，并初始化 `lastProgressAt`。既有控制台任务 API SHALL 默认创建 manual 任务，系统规划器 SHALL 显式创建 automatic 任务。

#### Scenario: 控制台任务为 manual
- **WHEN** 用户通过既有控制台 API 创建转运
- **THEN** 任务 origin 为 `manual`

#### Scenario: 规划器任务为 automatic
- **WHEN** Hub、synthesis、power-bank boost、energy-support 或 capacity 规划创建转运
- **THEN** 任务 origin 为 `automatic`

### Requirement: 重试 blocker 具有明确生命周期状态
pending 任务 SHALL 使用 `blockedReason`、`blockedSince` 和 `lastProgressAt` 表示正常重试条件。支持的 blocker SHALL 包含 `receiver_capacity`、`source_depleted` 和 `insufficient_terminal_resource_or_fee`。

#### Scenario: Receiver capacity 阻止执行
- **WHEN** pending 任务在安全缓冲之上没有接收容量
- **THEN** 任务保持 pending，`blockedReason` 为 `receiver_capacity`，且首次阻塞 tick 保持稳定

#### Scenario: Source depletion 优先
- **WHEN** 可见来源房的 Storage 与 Terminal 对任务资源的库存总和为零
- **THEN** 在评估 receiver capacity 前将任务标记为 `source_depleted`

#### Scenario: 任务取得进展
- **WHEN** Terminal send 成功
- **THEN** 系统清除 blocker 字段，并把 `lastProgressAt` 与 `updatedAt` 都设为当前 tick

#### Scenario: Blocker 清除时不重建任务
- **WHEN** blocker 代表的条件恢复
- **THEN** 既有 pending 任务恢复为可执行，不创建重复任务

#### Scenario: 发送预算耗尽后仍刷新健康状态
- **WHEN** 较早转运已经耗尽共享发送预算，后续 pending 任务尚未轮到
- **THEN** 系统仍重新评估后续任务的 blocker 条件，但不尝试额外 Terminal send

#### Scenario: 发送失败保留未解决 blocker
- **WHEN** 带未解决 supply blocker 的任务达到可发送条件，但 Terminal 返回错误
- **THEN** blocker 及其原始 `blockedSince` 保持不变，直到后续独立健康检查观察到恢复或发送成功

### Requirement: 预留健康区分阻塞与虚假供给
因 receiver capacity 或临时 Terminal supply/fee 阻塞的 pending 任务 SHALL 继续作为有效 incoming/outgoing 预留。source-depleted 任务在超过配置宽限期后 SHALL 从健康 incoming supply 中排除，但仍保留在原始任务列表中可见。

#### Scenario: Capacity blocker 防止重复需求
- **WHEN** incoming 任务因 receiver capacity 阻塞
- **THEN** Hub 与 synthesis 的预留读取仍计入该任务剩余量

#### Scenario: 耗尽来源不计为 incoming 库存
- **WHEN** 使用默认值时，automatic incoming 任务已保持 source-depleted 100 tick
- **THEN** 有效 incoming 计算排除其剩余量

### Requirement: 自动停滞任务过期而 manual 任务保留
使用默认值时，系统 SHALL 在 automatic pending 任务连续 5,000 tick 没有成功发送，或连续 100 tick source-depleted 后取消任务。系统 SHALL NOT 对 manual 任务应用这两条自动存活期取消规则。

#### Scenario: Automatic 无进展超时
- **WHEN** automatic pending 任务超过 5,000 tick 没有取得进展
- **THEN** 系统以机器可读的 liveness reason 取消任务

#### Scenario: Automatic source-depleted 超时
- **WHEN** automatic pending 任务保持 source-depleted 超过 100 tick
- **THEN** 系统取消任务，防止其无限预留虚假 incoming supply

#### Scenario: 旧 manual 任务继续保留
- **WHEN** manual pending 任务年龄超过两项 automatic timeout
- **THEN** 除非用户取消或既有硬校验规则失败，该任务继续保持 pending

### Requirement: 旧任务迁移保守且幂等
系统 SHALL 按任务 schema version 对旧记录执行一次迁移。系统仅从已知自动生成 reason 前缀推断 automatic origin，未知或缺失 reason 一律按 manual 处理。

#### Scenario: 已知生成任务迁移
- **WHEN** 旧任务 reason 以 `hub:`、`synthesis:`、`auto:synthesis:`、`powerBankBoost`、`energy-support` 或 `capacity:` 开头
- **THEN** 任务变为 automatic 并初始化进度字段

#### Scenario: 未知旧任务受到保留
- **WHEN** 旧任务 reason 未知或缺失
- **THEN** 任务变为 manual，且不会被 automatic liveness cleanup 删除

#### Scenario: 再次运行迁移
- **WHEN** 当前任务 schema version 已记录后再次执行 reconciliation
- **THEN** 系统不得产生重复迁移或破坏性变化
