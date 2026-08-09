## Why

当前专用 `upgrader` 控制会为所有己方 RCL1–7 房间持续创建和补产升级工，已经不再符合现阶段的资源分配策略。普通 controller 升级继续由通用 worker task 承担，专用 `upgrader` 只需保留 RCL8 降级计时维护这一安全职责。

## What Changes

- **BREAKING**：RCL1–7 不再自动或通过手动命令创建、补产专用 `upgrader`。
- 控制循环清除 RCL1–7 普通 upgrader 的 task、配置、出生队列、正在出生的 creep 与 boost 占用；已经出生的普通 upgrader 不自杀，停止提交升级 intent 后自然退役。
- RCL8 maintenance task 使用显式 provenance 标记；旧版 active maintenance 仅在 canonical 最小配置与运行窗口均通过认证时迁移，避免仅凭 creep 所在房间和身材误杀 ordinary upgrader。
- Spawn planner 只允许通过严格认证的 RCL8 maintenance upgrader 进入或保留在出生链路，拒绝 stale 普通 upgrader 配置被重新排队。
- 正在出生的唯一 maintenance creep SHALL 被视为合法实例，不得因单实例抑制逻辑自我取消；只有另有非 spawning live maintenance 时才取消重叠替补。
- 保持 RCL8 maintenance 的 175,000/195,000 tick 滞回、最小 `[WORK, CARRY, MOVE]` 身材、无 boost、最高安全出生优先级与停止清理语义不变。
- 保持 RCL1–7 通用 worker 的 controller upgrade task、worker 数量策略、bootstrap 管理角色与主循环 phase 顺序不变。

## Capabilities

### New Capabilities

- `rcl8-maintenance-only-upgraders`: 规定专用 upgrader 仅服务于 RCL8 controller maintenance，并定义普通 upgrader 的非破坏性退役合同。

### Modified Capabilities

- 无。

## Impact

- 影响 `src/runtime/upgraderPolicy.ts`、`src/runtime/hubUpgradeControl.ts`、`src/runtime/spawnPlanner.ts`、`src/roles/upgrader.ts` 及其定向测试。
- 为 `Memory.data.manualUpgraders[room]` 增加可选 `maintenance: true` provenance；不修改普通 worker task、bootstrap 管理配置、Power Creep/PowerSpawn、版本号、部署流程或外部依赖。
