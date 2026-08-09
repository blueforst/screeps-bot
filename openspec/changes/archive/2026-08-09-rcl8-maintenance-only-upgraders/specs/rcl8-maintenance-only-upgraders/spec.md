## ADDED Requirements

### Requirement: 专用 upgrader 仅用于 RCL8 maintenance
系统 SHALL 仅为当前可见、己方且等级为 RCL8 的 controller 维护专用 `upgrader`。系统 MUST NOT 为 RCL1–7 controller 自动创建、手动创建或补产普通 `upgrader`；RCL1–7 的通用 worker controller upgrade task SHALL 保持既有行为。

#### Scenario: RCL1–7 控制循环刷新
- **WHEN** 己方 RCL1–7 房间执行 upgrader 控制循环
- **THEN** 系统 SHALL 不创建 `manualUpgraders` task 或 `<room>:upgrader:0` 配置

#### Scenario: 手动尝试启动普通 upgrader
- **WHEN** operator 对己方 RCL1–7 房间调用 upgrader 启动命令
- **THEN** 系统 SHALL 拒绝请求并返回明确的 RCL8-maintenance-only 错误，且不得写入 task 或配置

#### Scenario: spawn planner 看到普通 upgrader 配置
- **WHEN** spawn planner 遇到未通过 RCL8 maintenance 严格认证的 `upgrader` 或 legacy `hubUpgrader` 配置
- **THEN** 系统 MUST NOT 将其加入出生队列或创建替补

#### Scenario: RCL1–7 通用 worker 升级
- **WHEN** RCL1–7 房间存在通用 worker 的 controller upgrade task
- **THEN** 系统 SHALL 保留该 task 的生成、分配和执行语义

### Requirement: 普通 upgrader 非破坏性退役
系统 SHALL 清除普通 `upgrader` 的任务、配置、出生队列、尚未完成的 spawning 与 boost 占用。系统 MUST NOT 对已经出生的普通 `upgrader` 调用 `suicide()`；task/config 失效后，该 creep MUST 立即停止 prepare、source 和 upgrade intent，并自然退役。

#### Scenario: 部署时 RCL1–7 存在完整普通生产链
- **WHEN** RCL1–7 房间同时存在普通 upgrader task、配置、队列项、正在出生的 creep、live creep 与 boost 占用
- **THEN** 系统 SHALL 删除 task/config/队列项、取消正在出生、释放 boost，且 SHALL NOT 让 live creep 自杀

#### Scenario: 普通 upgrader 已经出生
- **WHEN** live 普通 upgrader 在 task/config 被撤销后执行角色逻辑
- **THEN** 系统 SHALL 不提交取能、移动、强化准备或 controller upgrade intent，并 SHALL 让 creep 按 TTL 自然退役

#### Scenario: RCL7 到达健康 RCL8 时仍有大型普通 upgrader
- **WHEN** controller 到达 RCL8 安全区间且旧普通 upgrader 已经出生
- **THEN** 系统 SHALL 清除其生产链但 MUST NOT 把该普通 creep 当作最小 maintenance creep 强制自杀

#### Scenario: 最小 ordinary upgrader 当前位于 RCL8
- **WHEN** 无 maintenance provenance 的 ordinary upgrader 身体恰为 `[WORK,CARRY,MOVE]` 且当前位于 RCL8 房间
- **THEN** 系统 MUST NOT 仅凭房间等级和身材调用 `suicide()`，该 creep SHALL 停工并自然退役

### Requirement: RCL8 maintenance 合同保持不变
系统 SHALL 在无现存 maintenance task 且己方 RCL8 `ticksToDowngrade <= 175000` 时创建唯一的 `[WORK, CARRY, MOVE]` 无 boost upgrader，并在 task 存在时维持至 `ticksToDowngrade >= 195000`。达到停止阈值、失去所有权或 maintenance 失效时，系统 SHALL 保持既有 task/config/queue/spawning/live creep/boost 全链即时清理语义。

#### Scenario: RCL8 到达启动阈值
- **WHEN** 己方 RCL8 没有 maintenance task 且 `ticksToDowngrade` 等于 175000
- **THEN** 系统 SHALL 创建一个 `[WORK, CARRY, MOVE]`、无 boost 参数且具备既有最高安全出生优先级的配置

#### Scenario: RCL8 位于滞回区间
- **WHEN** maintenance task 已存在且 `ticksToDowngrade` 大于 175000 但小于 195000
- **THEN** 系统 SHALL 保留 task/config，并 SHALL NOT 创建重叠替补

#### Scenario: 旧版 active maintenance 迁移 provenance
- **WHEN** 无 provenance 的旧 task 同时具有 canonical 最小配置、己方 RCL8 controller 且 `ticksToDowngrade` 小于 195000
- **THEN** 系统 SHALL 写入 maintenance provenance 并保持 task/config/spawning 连续运行

#### Scenario: 唯一 maintenance 正在出生
- **WHEN** `Game.creeps` 已包含 `spawning === true` 的唯一 maintenance creep 且对应 spawn 仍在出生
- **THEN** 系统 MUST NOT 把该 creep 当作已完成的 live 实例取消 spawning，并 MUST NOT 在后续 tick 重排同配置

#### Scenario: live maintenance 与重叠 replacement 并存
- **WHEN** 一个非 spawning live maintenance 已存在且另一 spawn 正在出生或排队同配置 replacement
- **THEN** 系统 SHALL 保留 live maintenance 并取消重叠 replacement

#### Scenario: RCL8 达到停止阈值
- **WHEN** maintenance task 已存在且 `ticksToDowngrade` 大于或等于 195000
- **THEN** 系统 SHALL 删除 task/config/queue，取消 spawning、清理 live maintenance creep 并释放 boost 占用

#### Scenario: 健康 RCL8 没有任务
- **WHEN** 己方 RCL8 没有 maintenance task 且 `ticksToDowngrade` 大于 175000
- **THEN** 系统 SHALL 不创建专用 upgrader
