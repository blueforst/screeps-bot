# rcl8-upgrader-maintenance 规范

## Purpose

定义专用 upgrader 仅用于 RCL8 Controller 降级维护的最终合同，包括 175,000/195,000 滞回、普通 upgrader 非破坏性退役、maintenance provenance 与单实例出生保护。

## Requirements

### Requirement: RCL8 不保留通用 worker upgrade task
系统 SHALL NOT 为己方 RCL8 Controller 创建通用 worker 的 `upgrade:<controllerId>` task，无论 Controller 是否进入恢复窗口。既有 RCL1–7 upgrade task 在房间到达 RCL8 后 SHALL 立即停止解析为有效目标，并在下一次 task refresh 清理。系统 SHALL 保持 worker 数量以及 build、repair、dismantle 等其他 task 不变。

#### Scenario: 健康 RCL8 刷新 worker task board
- **WHEN** 己方 RCL8 Controller 处于安全计时区间并刷新 worker task board
- **THEN** 系统 SHALL NOT 创建通用 worker upgrade task

#### Scenario: RCL7 到达 RCL8 时 worker 仍持有 upgrade task
- **WHEN** Controller 从 RCL7 到达 RCL8，且通用 worker 仍持有旧 upgrade task
- **THEN** 系统 SHALL 立即拒绝该 task 的 target 与 upgrade intent，并在下一次 task refresh 删除 task

#### Scenario: RCL8 同时存在其他 worker task
- **WHEN** RCL8 房间存在 build、repair 或 dismantle 工作
- **THEN** 系统 SHALL 保留这些 task 的既有生成、优先级和分配行为，仅省略 upgrade task

#### Scenario: RCL8 进入降级恢复窗口
- **WHEN** 己方 RCL8 `ticksToDowngrade` 到达 maintenance 启动阈值
- **THEN** 系统 SHALL 由专用最小 upgrader 恢复 Controller，并 SHALL NOT 重新开放通用 worker upgrade task

### Requirement: 专用 upgrader 仅用于 RCL8 maintenance
系统 SHALL 仅为当前可见、己方且等级为 RCL8 的 Controller 维护专用 `upgrader`。系统 MUST NOT 为 RCL1–7 Controller 自动创建、手动创建或补产普通 `upgrader`；RCL1–7 的通用 worker Controller upgrade task SHALL 保持既有行为。

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
- **WHEN** RCL1–7 房间存在通用 worker 的 Controller upgrade task
- **THEN** 系统 SHALL 保留该 task 的生成、分配和执行语义

### Requirement: 普通 upgrader 非破坏性退役
系统 SHALL 清除普通 `upgrader` 的任务、配置、出生队列、尚未完成的 spawning 与 boost 占用。系统 MUST NOT 对已经出生的普通 `upgrader` 调用 `suicide()`；task/config 失效后，该 creep MUST 立即停止 prepare、source、移动和 upgrade intent，并按 TTL 自然退役。

#### Scenario: 部署时 RCL1–7 存在完整普通生产链
- **WHEN** RCL1–7 房间同时存在普通 upgrader task、配置、队列项、正在出生的 creep、live creep 与 boost 占用
- **THEN** 系统 SHALL 删除 task/config/队列项、取消正在出生、释放 boost，且 SHALL NOT 让 live creep 自杀

#### Scenario: 普通 upgrader 已经出生
- **WHEN** live 普通 upgrader 在 task/config 被撤销后执行角色逻辑
- **THEN** 系统 SHALL 不提交取能、移动、强化准备或 Controller upgrade intent，并 SHALL 让 creep 按 TTL 自然退役

#### Scenario: RCL7 到达健康 RCL8 时仍有大型普通 upgrader
- **WHEN** Controller 到达 RCL8 安全区间且旧普通 upgrader 已经出生
- **THEN** 系统 SHALL 清除其生产链但 MUST NOT 把该 ordinary creep 当作最小 maintenance creep 强制自杀

#### Scenario: 最小 ordinary upgrader 当前位于 RCL8
- **WHEN** 无 maintenance provenance 的 ordinary upgrader 身体恰为 `[WORK,CARRY,MOVE]` 且当前位于 RCL8 房间
- **THEN** 系统 MUST NOT 仅凭房间等级和身材调用 `suicide()`，该 creep SHALL 停工并自然退役

### Requirement: RCL8 maintenance 使用双阈值滞回
系统 SHALL 在无现存 maintenance task 且己方 RCL8 `ticksToDowngrade <= 175000` 时启动唯一 maintenance。任务启动后，系统 MUST 持续维护至 `ticksToDowngrade >= 195000`，随后执行 task、config、queue、spawning、live maintenance creep 与 boost 占用的全链清理。健康 RCL8 不得常驻专用 upgrader。

#### Scenario: 降级计时到达启动阈值
- **WHEN** 己方 RCL8 没有 maintenance task 且 `ticksToDowngrade` 小于或等于 175,000
- **THEN** 系统 SHALL 创建 maintenance task 和唯一的 `[WORK,CARRY,MOVE]` 配置

#### Scenario: RESERVE 房间没有通用 worker
- **WHEN** 己方 RCL8 处于 RESERVE、没有通用 worker 且降级计时到达启动阈值
- **THEN** 系统 SHALL 独立于 worker 配置创建 maintenance task

#### Scenario: 恢复处于滞回区间
- **WHEN** maintenance task 已存在且 `ticksToDowngrade` 大于 175,000 但小于 195,000
- **THEN** 系统 SHALL 保留 task/config，且不得反复取消、重建或创建重叠替补

#### Scenario: 恢复达到停止阈值
- **WHEN** 已认证 maintenance task 存在且 `ticksToDowngrade` 大于或等于 195,000
- **THEN** 系统 SHALL 删除 task/config/queue，取消 spawning、清理 live maintenance creep 并释放 boost 占用

#### Scenario: 健康 RCL8 没有任务
- **WHEN** 己方 RCL8 没有 maintenance task 且 `ticksToDowngrade` 大于 175,000
- **THEN** 系统 SHALL 不创建专用 upgrader

#### Scenario: 手动命令尝试提前启动 RCL8 maintenance
- **WHEN** RCL8 没有现存 maintenance task，且 operator 在 `ticksToDowngrade` 大于 175,000 时调用启动命令
- **THEN** 系统 SHALL 拒绝创建 task/config；手动入口 SHALL NOT 绕过自动启动阈值

#### Scenario: 已认证 maintenance 失去房间所有权
- **WHEN** maintenance provenance、canonical config 与 live creep 已存在，但归属房间失去所有权或 maintenance 失效
- **THEN** 系统 SHALL 立即执行 maintenance 全链清理，包括结束 live maintenance creep

### Requirement: RCL8 maintenance 使用最小无 boost 配置
系统 SHALL 为 RCL8 maintenance 使用 `[WORK,CARRY,MOVE]` 最小 200 Energy 身材，并 MUST NOT 创建、等待或保留 boost 准备。角色只有在 task、配置、房间所有权和恢复计时均有效时才能提交升级 intent。

#### Scenario: 创建 RCL8 maintenance 配置
- **WHEN** 系统为处于恢复窗口的 RCL8 创建专用 upgrader 配置
- **THEN** 配置 SHALL 使用 `[WORK,CARRY,MOVE]`、不包含 boost task 参数，并释放任何旧 boost 占用

#### Scenario: 健康 RCL8 存在 stale 配置
- **WHEN** RCL8 已达到停止阈值但仍有 stale task、配置或 creep
- **THEN** 角色 SHALL 停止 source、prepare 和 upgrade intent，控制循环 SHALL 清理 stale 运行资源

#### Scenario: 出生队列同时存在战争或紧急 carrier
- **WHEN** 已认证的 RCL8 maintenance 配置等待出生，且同房间存在战争任务或其他 spawn 的紧急 carrier
- **THEN** 系统 SHALL 将 maintenance 置于最高安全优先级并立即尝试出生，不得应用普通 upgrader 的跨 spawn 让行

### Requirement: Maintenance provenance 必须区分 ordinary creep
系统 SHALL 为新建 RCL8 maintenance task 持久化明确 provenance。系统只可迁移仍处于有效恢复窗口且同时具有 canonical 最小配置的旧版 active maintenance；不得仅凭 creep 身体或当前所在房间推断 provenance。

#### Scenario: 新建 maintenance task
- **WHEN** RCL8 在启动阈值创建 maintenance task
- **THEN** task 持久记录 maintenance provenance，并由 config 与角色门禁共同认证

#### Scenario: 旧版 active maintenance 迁移 provenance
- **WHEN** 无 provenance 的旧 task 同时具有 canonical 最小配置、己方 RCL8 Controller 且 `ticksToDowngrade` 小于 195,000
- **THEN** 系统 SHALL 写入 maintenance provenance并保持 task、config 与 spawning 连续运行

#### Scenario: Ambiguous ordinary 不迁移
- **WHEN** 无 provenance 的最小 upgrader 不满足 active RCL8 maintenance 的完整认证条件
- **THEN** 系统不得写入 maintenance provenance，也不得按 maintenance 立即结束其 live creep

### Requirement: RCL8 maintenance 出生必须保持单实例
系统 SHALL 将已完成出生的 non-spawning live maintenance 作为替补抑制依据，并清除同配置的遗留 queue 或正在 spawning 的重叠替补；唯一仍在 spawning 的 maintenance 本身不得被误认为完成实例而自取消。

#### Scenario: 唯一 maintenance 正在出生
- **WHEN** `Game.creeps` 已包含 `spawning === true` 的唯一 maintenance creep 且对应 Spawn 仍在出生
- **THEN** 系统 MUST NOT 把该 creep 当作已完成的 live 实例取消 spawning，并 MUST NOT 在后续 tick 重排同配置

#### Scenario: live maintenance 与重叠 replacement 并存
- **WHEN** 一个 non-spawning live maintenance 已存在且另一 Spawn 正在出生或排队同配置 replacement
- **THEN** 系统 SHALL 保留 live maintenance 并取消重叠 replacement

#### Scenario: live maintenance 接近寿命终点
- **WHEN** 已认证的 non-spawning live maintenance 仍存活但进入普通 upgrader 的预出生窗口
- **THEN** 系统 SHALL NOT 预出生重叠替补；现有 creep 死亡后才可重新排队
