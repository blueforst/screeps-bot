## ADDED Requirements

### Requirement: 健康 RCL8 不常驻专用 upgrader
系统 SHALL 在己方 RCL8 controller 的 `ticksToDowngrade` 处于安全停止阈值 195,000 或以上时，不维护专用 upgrader 任务或配置。系统 SHALL 保留通用 worker 的既有日常升级路径。

#### Scenario: RCL8 处于安全计时区间
- **WHEN** 己方 RCL8 controller 的 `ticksToDowngrade` 大于或等于 195,000
- **THEN** 系统 SHALL 不创建专用 upgrader 任务或配置

#### Scenario: 房间刚达到 RCL8
- **WHEN** 现有 RCL1–7 专用 upgrader 的房间达到 RCL8 且计时处于安全停止阈值
- **THEN** 系统 SHALL 删除任务和配置，并取消相关队列、正在出生的 creep、存量 creep 与 boost 占用

### Requirement: RCL8 降级恢复使用双阈值滞回
系统 SHALL 在无现存任务且己方 RCL8 controller 的 `ticksToDowngrade` 小于或等于 175,000 时启动 maintenance 任务。任务启动后，系统 MUST 持续维护至计时大于或等于 195,000，随后执行全链清理。

#### Scenario: 降级计时到达启动阈值
- **WHEN** 己方 RCL8 没有专用 upgrader 任务且 `ticksToDowngrade` 小于或等于 175,000
- **THEN** 系统 SHALL 创建 maintenance 任务和一个 `[WORK, CARRY, MOVE]` 配置

#### Scenario: RESERVE 房间没有通用 worker
- **WHEN** 己方 RCL8 处于 RESERVE、没有通用 worker 且降级计时到达启动阈值
- **THEN** 系统 SHALL 独立于 worker 配置创建 maintenance 任务

#### Scenario: 恢复处于滞回区间
- **WHEN** maintenance 任务已经存在且 `ticksToDowngrade` 大于 175,000 但小于 195,000
- **THEN** 系统 SHALL 保留任务和配置，不得反复取消或重建

#### Scenario: 恢复达到停止阈值
- **WHEN** maintenance 任务已经存在且 `ticksToDowngrade` 大于或等于 195,000
- **THEN** 系统 SHALL 删除任务和配置，并取消相关队列、正在出生的 creep、存量 creep 与 boost 占用

### Requirement: RCL8 maintenance 不使用 boost
系统 SHALL 为 RCL8 maintenance 使用最小 200 能量身材，并 MUST NOT 创建、等待或保留 boost 准备。角色只有在任务、配置、房间所有权和恢复计时均有效时才能提交升级 intent。

#### Scenario: 创建 RCL8 maintenance 配置
- **WHEN** 系统为处于恢复窗口的 RCL8 创建专用 upgrader 配置
- **THEN** 配置 SHALL 使用 `[WORK, CARRY, MOVE]`、不包含 boost task 参数，并释放任何旧 boost 占用

#### Scenario: 健康 RCL8 存在 stale 配置
- **WHEN** RCL8 已达到停止阈值但仍有 stale 任务、配置或 creep
- **THEN** 角色 SHALL 停止 source、prepare 和 upgrade intent，控制循环 SHALL 清理 stale 运行资源

#### Scenario: 出生队列同时存在战争或紧急 carrier
- **WHEN** 已认证的 RCL8 maintenance 配置等待出生，且同房间存在战争任务或其他 spawn 的紧急 carrier
- **THEN** 系统 SHALL 将 maintenance 置于最高安全优先级并立即尝试出生，不得应用普通 upgrader 的跨 spawn 让行
