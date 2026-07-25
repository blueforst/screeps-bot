## Context

当前 `hubUpgrader` 由 `Memory.cfg.hub` 自动选择 RCL7 房间，角色自身也依赖该配置。它无法通过控制台临时发布或停止，且旧名称掩盖了其实际用途。该角色是固定 15 WORK 的专用升级 creep，不属于普通 worker 的任务池。

## Goals / Non-Goals

**Goals:**

- 用持久化的手动任务记录控制每个房间一个专用 `upgrader`。
- 在 RCL7 运行，在 RCL8、失去所有权、视野不可用或手动停止时清理全部运行资源。
- 仅使用本房间可用的 `XGH2O` 判断一次完整强化是否可行；缺量时不创建或等待运输，直接未强化运行。
- 为控制台提供可读的开始、停止和状态接口。

**Non-Goals:**

- 不将此专用 creep 改造成普通 worker，也不改变普通 worker 的升级任务。
- 不自动跨房运输或合成 T3，不取消其他系统已创建的资源运输任务。
- 不保留旧的 `hubUpgrader` 兼容运行路径。

## Decisions

1. 在 `Memory.data.manualUpgraders` 以房间名为键保存任务，而非直接把配置写入 creep 配置表。任务记录能在刷新、重载和 RCL8 后清楚地区分用户意图与运行产物。
2. `startUpgrader(roomName)` 仅接受当前可见、己方且 RCL7 的房间；`stopUpgrader(roomName)` 立即清理运行产物。自动控制循环也会在不再满足 RCL7 时做同样的清理并删除记录。
3. 配置名使用 `<room>:upgrader:0`，角色名与出生档案均为 `upgrader`。这是一次显式迁移；旧 `hubUpgrader` 在控制循环中清理，防止两种专用 creep 并存。
4. T3 判定把 storage、terminal 和己方实验室中的 `XGH2O` 相加，与仍需强化的有效 WORK 部件乘以 `LAB_BOOST_MINERAL` 比较。足量时才传入 boost 任务并调用实验室准备；任意不足时释放该任务的实验室占用并使用未强化参数。
5. 角色以其自身 `configName` 验证任务和 RCL7 controller，而不再读取 hub 配置。这样手动任务的有效性只有一个来源。

## Risks / Trade-offs

- [旧配置迁移会终止已有 hubUpgrader] → 首次控制循环统一取消、清队列并自杀旧角色；部署说明明确新的手动命令。
- [T3 分散在 terminal 或实验室但实验室准备暂时失败] → 只有总量足够时才要求强化；准备失败时现有 boost 流程仍会等待，不会误降级一只已经被要求强化的 creep。
- [控制台错误输入] → 开始命令验证房间可见、归属和 RCL7，并返回明确错误；停止命令对不存在任务返回错误。
