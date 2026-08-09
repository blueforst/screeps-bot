## Context

专用 upgrader 由 `runHubUpgradeControl` 维护 `Memory.data.manualUpgraders` 与 `<room>:upgrader:0` 配置，spawn planner 根据配置补产，角色再以 task/config/controller 三重门禁提交升级 intent。当前共享策略把所有己方 RCL1–7 controller 判为需要专用 upgrader，导致普通升级工持续存在；与此同时，RCL8 已有独立的 175,000/195,000 tick 最小 maintenance 合同。

本变更跨越策略、控制清理、出生规划和角色 fail-closed 四层。`bootstrapRooms` 与 `roomWorkforce` 只维护 harvester/miner/carrier/worker，不创建 upgrader，因此无需改变；RCL1–7 的 controller progress 仍可由通用 worker task 完成。

## Goals / Non-Goals

**Goals:**

- 让专用 upgrader 的唯一合法生产场景成为己方 RCL8 controller 的 maintenance 恢复窗口。
- 清除 RCL1–7 普通 upgrader 的持久任务、配置、排队、正在出生和 boost 占用，阻止补产。
- 让已经出生的普通 upgrader 停止 intent 后自然退役，不调用 `suicide()`。
- 原样保留 RCL8 maintenance 的双阈值、最小身材、无 boost、单实例、出生优先级和达到停止阈值后的即时清理。

**Non-Goals:**

- 不删除或改变 RCL1–7 通用 worker 的 `upgrade:<controllerId>` task。
- 不改变 worker 数量、bootstrap 管理角色、spawn phase 顺序或 RCL8 maintenance 阈值。
- 不修改 Power Creep、PowerSpawn、版本号、部署配置或普通 worker 的 Memory schema。

## Decisions

1. **把共享 dedicated-upgrader 策略收窄为仅 RCL8。** `shouldMaintainDedicatedUpgrader` 与 `isDedicatedUpgraderControllerRunnable` 对 RCL1–7 一律返回 false，只在己方 RCL8 上应用既有 175,000/195,000 滞回。相比在 Hub 控制器里增加一处等级判断，共享门禁可以同时约束任务创建、状态查询和角色 intent，避免 stale creep 继续工作。
2. **使用 task provenance 区分 ordinary 与 RCL8 maintenance。** `manualUpgraders[room].maintenance === true`、canonical `<room>:upgrader:0` 与最小身材必须同时成立，清理时才允许对 live creep 保留既有即时 `suicide()` 语义；一旦身份已标记，停止阈值、失去所有权、房间不可见或 controller 失效均不应阻止即时清理。仅凭 creep 当前位于 RCL8 且身体为 `[WORK,CARRY,MOVE]` 不足以证明来源；无 provenance 的 live creep 一律自然退役。旧版 active maintenance 只有在己方 RCL8、task 已存在、canonical 最小配置存在且 controller 仍低于 195,000 tick 时才一次性补 marker，健康旧 ordinary task 不迁移。
3. **spawn planner 对 upgrader 采用严格认证。** `upgrader`/legacy `hubUpgrader` 只有通过 `isRcl8MaintenanceUpgraderConfig` 才能进入补产判断；普通或伪造配置即使暂时残留也不会重新排队。主要的队列和 spawning 清理由 Hub 控制器完成，planner 的拒绝作为同 tick 的第二层保护。
4. **单实例抑制只统计非 spawning live creep。** Screeps 会在出生期间把 creep 放入 `Game.creeps`；若只判断同配置 creep 数量，当前 9-tick maintenance 会被误判为已有 live 实例并取消自身 spawning。planner 只有发现 `spawning !== true` 的同配置 creep 时，才清队列或取消另一只重叠 replacement；唯一正在出生实例依靠 `isConfigSpawning` 去重并连续完成出生。
5. **保留控制台命令名称，但取消 RCL1–7 启动能力。** `startUpgrader` 对非 RCL8 返回明确的 maintenance-only 错误；RCL8 仍共享自动启动阈值，不能通过手动入口绕过 175,000 tick。这样避免保留隐藏的普通 upgrader 生产入口，同时不破坏 console API 的注册形态。
6. **删除不可达的普通 upgrader 生产与 boost 分支。** Hub 控制只生成固定 `RCL8_UPGRADER_MAINTENANCE_BODY` 且总是无 boost 配置，降低未来误恢复普通生产的可能；历史 boost 占用仍在清理时释放。

## Risks / Trade-offs

- [现存普通 upgrader 会继续占用 creep 数量直至寿命结束] → task/config 立即失效，角色不再寻路、取能或升级；以短期空闲 creep 换取不强制自杀的安全退役。
- [控制循环在 spawn planner 前异常中断时可能留下旧队列] → planner 对普通 upgrader 配置 fail closed；下一次正常 Hub 控制再删除队列、取消 spawning 与配置。
- [将普通 upgrader 与 maintenance 误分类] → 即时自杀要求 task provenance、canonical config 与最小身材全部匹配；只有 provenance 迁移阶段要求当前 controller 为己方 runnable RCL8，缺失任一身份条件均自然退役。
- [正在出生的 maintenance 每 tick 自我取消并重新排队] → replacement 抑制排除 `creep.spawning === true`，并用连续 tick 测试锁定唯一 spawning 实例不被取消。
- [低等级房间升级速度下降] → 这是本变更的预期资源策略；通用 worker upgrade task 保持可用，未取消 controller progress 路径。

## Migration Plan

1. 首个控制 tick 仅为仍处于 `<195,000` 恢复窗口且具有 canonical 最小配置的旧 RCL8 maintenance task 写入 `maintenance: true`；健康 RCL8 的旧 ordinary task 不迁移。
2. 删除所有 RCL1–7 `manualUpgraders` 记录和普通/legacy upgrader 配置，清理 queue、取消正在出生并释放 boost。
3. 已出生的普通 upgrader 因共享角色门禁停止所有工作，等待 TTL 自然结束；不会被重新补产。
4. 只读确认 RCL1–7 无 task/config/queue/spawning，RCL8 唯一 spawning maintenance 连续完成，且 175,000/195,000 边界仍符合既有测试合同。
5. 回滚时恢复上一代码版本；旧版本会忽略可选 provenance 字段并按其原策略运行。

## Open Questions

- 无。
