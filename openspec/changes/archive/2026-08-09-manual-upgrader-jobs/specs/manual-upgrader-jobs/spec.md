## ADDED Requirements

### Requirement: 手动发布专用升级任务
系统 SHALL 提供控制台命令，为当前可见、己方且 RCL7 的房间创建一个持久化的专用 `upgrader` 任务；该任务 SHALL 创建固定 15 WORK、5 CARRY、10 MOVE 的单个配置，且不依赖 hub 配置。

#### Scenario: 发布有效房间的任务
- **WHEN** 用户对一个己方 RCL7 房间执行开始命令
- **THEN** 系统保存该房间的手动任务，并在控制循环中创建 `<room>:upgrader:0` 配置

#### Scenario: 拒绝非 RCL7 房间
- **WHEN** 用户对不可见、非己方或非 RCL7 的房间执行开始命令
- **THEN** 系统 SHALL 不创建任务并返回明确错误

### Requirement: 根据本地 T3 选择强化
系统 SHALL 统计任务房间的 storage、terminal 与己方实验室中的 `XGH2O`。只有总量足以覆盖所有尚未强化的有效 WORK 部件时，系统才 SHALL 准备 boost 并要求 `upgrader` 强化；否则 SHALL 以未强化配置运行且释放该任务的 boost 实验室占用。

#### Scenario: 本地 T3 足量
- **WHEN** 房间的 `XGH2O` 总量不少于本轮所需强化量
- **THEN** 配置 SHALL 包含 boost 任务并请求实验室准备

#### Scenario: 本地 T3 不足
- **WHEN** 房间的 `XGH2O` 总量小于本轮所需强化量
- **THEN** 配置 SHALL 不包含 boost 任务，且 creep SHALL 不因等待 T3 而停止工作

### Requirement: 自动和手动终止任务
系统 SHALL 在任务房间到达 RCL8、失去所有权、不可见或用户执行停止命令时，删除任务记录和配置，并取消相关出生、移除队列项、结束现存 `upgrader` creep 与释放该任务的 boost 实验室占用。

#### Scenario: 房间到达 RCL8
- **WHEN** 已发布任务的控制器等级变为 8
- **THEN** 系统 SHALL 在控制循环中终止任务及其全部运行资源

#### Scenario: 用户停止任务
- **WHEN** 用户对已发布房间执行停止命令
- **THEN** 系统 SHALL 立即终止任务及其全部运行资源

### Requirement: 查询手动任务状态
系统 SHALL 提供控制台状态命令，返回指定房间或所有房间的手动 `upgrader` 任务、有效配置及当前 creep 摘要。

#### Scenario: 查询全部任务
- **WHEN** 用户执行未传入房间名的状态命令
- **THEN** 系统 SHALL 返回所有已发布任务的状态摘要
