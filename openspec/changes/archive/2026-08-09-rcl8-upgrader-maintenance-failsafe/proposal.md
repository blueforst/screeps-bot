## Why

普通 RCL8 房间已经没有继续积累 controller progress 的需求；继续为通用 worker 生成常驻 upgrade task，会让空闲 worker 持续消耗 intent 与寻路 CPU。完全移除升级能力又会留下 controller 最终降级的失效路径，因此需要取消 RCL8 通用 upgrade task，并只在降级计时进入风险窗口时启动低成本兜底。

## What Changes

- RCL8 不再创建通用 worker 的 `upgrade:<controllerId>` task；既有 stale task 立即停止解析为有效目标，并在下一次 task refresh 清理。
- 当 RCL8 `ticksToDowngrade` 降至启动阈值时，自动创建一个最小身材、无 boost 的专用 maintenance upgrader，而不是重新开放通用 worker upgrade task。
- maintenance 任务使用启停滞回：恢复到安全阈值后才清理任务、配置、队列、正在出生的 creep、存量 creep 与 boost 占用，避免阈值附近反复出生。
- RCL8 的 worker 数量与 build、repair、dismantle 等其他 task 保持不变；RCL1–7 的现有 upgrade task、自动 upgrader 策略和主循环 phase 顺序保持不变。

## Capabilities

### New Capabilities

- `rcl8-upgrader-maintenance`: RCL8 controller 降级计时的低成本滞回恢复和全链清理合同。

### Modified Capabilities

- 无。

## Impact

- 影响 `src/runtime/workerTaskPool.ts`、`src/runtime/hubUpgradeControl.ts`、`src/roles/upgrader.ts`、`src/runtime/spawnPlanner.ts` 及其测试。
- 新增共享的 RCL8 maintenance 策略模块；不改变 Memory schema、控制台命令名称、spawn phase 顺序或市场自动化状态。
