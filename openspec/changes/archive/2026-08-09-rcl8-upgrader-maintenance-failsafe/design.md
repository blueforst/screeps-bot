## Context

当前控制循环会为每个己方房间维护一个专用 upgrader，同时 worker task board 也会为所有己方 controller 创建低优先级 upgrade task。RCL8 不再需要持续 controller progress，保留任一常驻升级路径都会重复消耗 CPU、出生能量或 boost 检查；但完全删除升级能力又不具备长期降级安全性。RCL8 的最大降级计时为 200,000 tick，每点升级能量可恢复 100 tick，适合取消通用 upgrade task，并使用低频、低规格的专用恢复机制。

## Goals / Non-Goals

**Goals:**

- 安全计时区间内让 RCL8 不承担通用 worker upgrade task 或专用 upgrader 的常驻 CPU。
- 降级计时进入风险窗口时，自动启动不依赖 boost 的最小专用 upgrader。
- 使用滞回避免阈值附近反复创建、取消和出生。
- 保留 ownership loss、恢复完成和 stale 配置的全链 fail-closed 清理。
- 保持 worker 数量、build、repair、dismantle 和 RCL1–7 upgrade task 行为不变。

**Non-Goals:**

- 不改变 RCL1–7 的专用 upgrader 策略。
- 不修改 worker 数量、RESERVE、build/repair/dismantle task、spawn phase 顺序或 RCL1–7 controller 升级优先级。
- 不引入新的持久化 schema、console 命令或 boost 类型。

## Decisions

1. **使用 175,000/195,000 tick 双阈值。** 无现存 maintenance 任务时，`ticksToDowngrade <= 175000` 才启动；任务存在后持续运行至 `ticksToDowngrade >= 195000`。175,000 tick 提供充足的出生与能源恢复余量，20,000 tick 的恢复带约需 200 个成功升级动作，能在一个最小 creep 生命周期内完成，同时避免单次 upgrade 后立即清理。相比常驻小 creep，该策略在健康 RCL8 上保持零专职 creep；相比单阈值，它不会抖动。
2. **复用任务存在性作为滞回锁存。** `Memory.data.manualUpgraders[room]` 已是任务来源，只需结合当前 controller 计时判断继续或清理，不增加 schema 字段。部署时健康 RCL8 的既有全尺寸任务会因计时处于停止阈值而自动清除。
3. **RCL8 maintenance 固定使用 `[WORK, CARRY, MOVE]` 且禁用 boost。** 200 能量身材足以持续净恢复 controller 计时；不扫描/预约 boost 可减少 CPU，并避免低能量 RESERVE 房间被 T3 资源阻塞。
4. **角色运行门禁与控制器策略共享。** 控制循环和 `upgraderRole` 使用同一策略常量；任何 task/config/controller mismatch 都停止 intent。普通 RCL8 的 stale creep 不得升级，已认证的恢复任务在停止阈值前可以升级。
5. **清理保持全链幂等。** 达到停止阈值、失去所有权或房间不可见时，删除任务/config，并取消队列、正在出生的 creep、存量 creep 与 boost 占用。
6. **已认证的 maintenance 配置使用最高出生安全优先级。** 只有 exact `<room>:upgrader:0`、最小身材、现存任务、己方 RCL8 和恢复窗口同时成立时，spawn planner 才将其置于队首；spawn 执行器不得因战争能量预留或其他 spawn 的紧急 carrier 而让行。相比所有 upgrader 提权，这不会改变 RCL1–7 的出生排序。
7. **RCL8 永久省略通用 worker upgrade task。** `workerTaskPool` 只为己方 RCL1–7 创建 `upgrade:<controllerId>`；RCL8 即使进入恢复窗口，也仍不创建通用 task，而由专用 maintenance upgrader 直接提交 intent。任务目标解析和完成判断同步把 RCL8 视为无效，确保 RCL7→RCL8 后旧分配无需等待下一次三 tick refresh 就 fail closed；build、repair、dismantle 的生成和评分路径不变。
8. **RCL8 maintenance 不做重叠预出生。** 已有 live maintenance creep 时不为同一配置预出生替补；其死亡后才重新排队。175,000 tick 的启动余量足以覆盖最多一个出生间隙，并保证同时最多只有一个维护 creep；RCL1–7 upgrader 的既有预出生策略不变。

## Risks / Trade-offs

- [房间在 175,000 tick 内始终无法筹集 200 出生能量] → 该房间已处于更广泛的生产失效；保留 175,000 tick 余量、绕过普通 spawn 让行，并在部署后观察 controller 计时和任务创建。
- [通用 worker 将计时推过停止阈值时 maintenance 正在出生] → 同一控制循环执行幂等取消和清理，避免重复 creep。
- [RCL7→RCL8 后旧 worker upgrade task 在 refresh 间隔内仍被持有] → target 解析与完成判断立即拒绝 RCL8，下一次最多三 tick 的 refresh 再删除 task。
- [maintenance 不预出生导致短暂无 upgrader] → 175,000 tick 启动余量远大于 200 能量 creep 的出生与补位时间；以不重叠换取严格单实例。
- [复用任务存在性无法区分人工任务] → RCL8 仅允许在停止阈值以下启动；健康 RCL8 的旧任务统一清理，RCL1–7 行为不变。
- [阈值常量未来需要调参] → 常量集中在独立策略模块，并由边界测试锁定。

## Migration Plan

1. 部署后旧 RCL8 worker upgrade 分配立即停止解析为有效目标，并在下一次 task refresh 清理；健康 RCL8 的旧专用任务及运行资源同时清理。
2. 只读确认健康 RCL8 无专用配置，低计时 fixture 能创建唯一最小无 boost upgrader，RCL8 build/repair/dismantle task 仍存在。
3. 持续观察 controller 计时、upgrader 配置和 CPU；市场自动化继续保持 Shadow。
4. 回滚时部署上一代码提交即可；本变更不增加 Memory 字段，残留任务会被旧控制循环按既有规则接管。

## Open Questions

- 无。
