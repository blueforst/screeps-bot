## Why

RCL7 的高功率升级工当前由 hub 配置自动创建，无法按房间临时启停，也不符合常规任务的控制方式。它需要成为可在控制台手动发布的任务，并在房间到达 RCL8 后自行结束，避免继续占用出生、实验室和 creep。

## What Changes

- 新增按房间保存的手动 `upgrader` 任务，以及开始、停止和查询控制台命令。
- 将专用角色、配置名和出生档案从 `hubUpgrader` 更名为 `upgrader`；移除由 hub 配置自动派生该角色的行为。
- 仅当本房间现有 T3 `XGH2O` 总量足够强化本次尚未强化的 WORK 部件时，准备并要求强化；不足时立即使用未强化配置继续工作。
- 房间失去所有权、不是 RCL7，或到达 RCL8 时，自动撤销任务、出生队列、正在出生的 creep、现存 creep 与 boost 实验室占用。

## Capabilities

### New Capabilities

- `manual-upgrader-jobs`: 手动管理 RCL7 专用升级任务、可选本地 T3 强化及自动终止。

### Modified Capabilities

- 无。

## Impact

- 影响 `src/runtime/hubUpgradeControl.ts`、控制台操作命令、角色注册、出生档案、Memory 类型及相关测试。
- 现存 `hubUpgrader` 配置将在首次控制循环中被清理；之后需通过新控制台命令显式创建 `upgrader` 任务。
