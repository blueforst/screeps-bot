## Context

当前控制循环会为每个己方房间维护一个专用 upgrader。RCL8 日常已有通用 worker 的低优先级 upgrade task，常驻 15 WORK 专用 creep 会重复消耗 CPU、出生能量和 boost 检查；但自动 RESERVE 会撤销 worker 配置，所以简单删除 RCL8 专用任务并不具备长期降级安全性。RCL8 的最大降级计时为 200,000 tick，每点升级能量可恢复 100 tick，适合使用低频、低规格恢复机制。

## Goals / Non-Goals

**Goals:**

- 安全计时区间内让 RCL8 不承担专用 upgrader 的常驻 CPU。
- 在通用 worker 缺失或长期未升级时，自动启动不依赖 boost 的最小恢复 creep。
- 使用滞回避免阈值附近反复创建、取消和出生。
- 保留 ownership loss、恢复完成和 stale 配置的全链 fail-closed 清理。

**Non-Goals:**

- 不改变 RCL1–7 的专用 upgrader 策略。
- 不修改 worker、RESERVE、spawn phase 顺序或 controller 升级优先级。
- 不引入新的持久化 schema、console 命令或 boost 类型。

## Decisions

1. **使用 175,000/195,000 tick 双阈值。** 无现存 maintenance 任务时，`ticksToDowngrade <= 175000` 才启动；任务存在后持续运行至 `ticksToDowngrade >= 195000`。175,000 tick 提供充足的出生与能源恢复余量，20,000 tick 的恢复带约需 200 个成功升级动作，能在一个最小 creep 生命周期内完成，同时避免单次 upgrade 后立即清理。相比常驻小 creep，该策略在健康 RCL8 上保持零专职 creep；相比单阈值，它不会抖动。
2. **复用任务存在性作为滞回锁存。** `Memory.data.manualUpgraders[room]` 已是任务来源，只需结合当前 controller 计时判断继续或清理，不增加 schema 字段。部署时健康 RCL8 的既有全尺寸任务会因计时处于停止阈值而自动清除。
3. **RCL8 maintenance 固定使用 `[WORK, CARRY, MOVE]` 且禁用 boost。** 200 能量身材足以持续净恢复 controller 计时；不扫描/预约 boost 可减少 CPU，并避免低能量 RESERVE 房间被 T3 资源阻塞。
4. **角色运行门禁与控制器策略共享。** 控制循环和 `upgraderRole` 使用同一策略常量；任何 task/config/controller mismatch 都停止 intent。普通 RCL8 的 stale creep 不得升级，已认证的恢复任务在停止阈值前可以升级。
5. **清理保持全链幂等。** 达到停止阈值、失去所有权或房间不可见时，删除任务/config，并取消队列、正在出生的 creep、存量 creep 与 boost 占用。
6. **已认证的 maintenance 配置使用最高出生安全优先级。** 只有 exact `<room>:upgrader:0`、最小身材、现存任务、己方 RCL8 和恢复窗口同时成立时，spawn planner 才将其置于队首；spawn 执行器不得因战争能量预留或其他 spawn 的紧急 carrier 而让行。相比所有 upgrader 提权，这不会改变 RCL1–7 的出生排序。

## Risks / Trade-offs

- [房间在 175,000 tick 内始终无法筹集 200 出生能量] → 该房间已处于更广泛的生产失效；保留 175,000 tick 余量、绕过普通 spawn 让行，并在部署后观察 controller 计时和任务创建。
- [通用 worker 将计时推过停止阈值时 maintenance 正在出生] → 同一控制循环执行幂等取消和清理，避免重复 creep。
- [复用任务存在性无法区分人工任务] → RCL8 仅允许在停止阈值以下启动；健康 RCL8 的旧任务统一清理，RCL1–7 行为不变。
- [阈值常量未来需要调参] → 常量集中在独立策略模块，并由边界测试锁定。

## Migration Plan

1. 部署后首个控制 tick 清理 `ticksToDowngrade >= 195000` 的 RCL8 旧专用任务及运行资源。
2. 只读确认健康 RCL8 无专用配置，低计时 fixture 能创建最小无 boost 配置。
3. 持续观察 controller 计时、upgrader 配置和 CPU；市场自动化继续保持 Shadow。
4. 回滚时部署上一代码提交即可；本变更不增加 Memory 字段，残留任务会被旧控制循环按既有规则接管。

## Open Questions

- 无。
