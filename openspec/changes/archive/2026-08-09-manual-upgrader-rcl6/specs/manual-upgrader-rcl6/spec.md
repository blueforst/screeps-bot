## ADDED Requirements

### Requirement: RCL6 起支持手动专用升级
系统 SHALL 允许当前可见、己方且 controller 等级为 6 或 7 的房间发布和运行固定身材的手动 `upgrader` 任务。系统 SHALL 在房间达到 RCL8、失去所有权或不可见时终止任务。

#### Scenario: 发布 RCL6 任务
- **WHEN** 用户对己方 RCL6 房间执行开始命令
- **THEN** 系统 SHALL 保存任务并创建 `<room>:upgrader:0` 配置

#### Scenario: RCL8 自动终止保持不变
- **WHEN** 已发布任务的房间达到 RCL8
- **THEN** 系统 SHALL 删除任务并清理相关运行资源
