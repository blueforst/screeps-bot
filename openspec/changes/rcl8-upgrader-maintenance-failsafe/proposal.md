## Why

普通 RCL8 房间可由通用 worker 重置 controller 降级计时，因此常驻高规格专用 upgrader 会浪费出生能量和每 tick CPU；但房间进入 RESERVE 后通用 worker 配置会被撤销，完全移除专用 upgrader 又会留下 controller 最终降级的失效路径。需要一个只在降级计时进入风险窗口时启动的低成本兜底。

## What Changes

- 正常 RCL8 房间不再常驻专用 upgrader，继续由通用 worker 完成日常维护。
- 当 RCL8 `ticksToDowngrade` 降至启动阈值时，自动创建一个最小身材、无 boost 的 maintenance upgrader。
- maintenance 任务使用启停滞回：恢复到安全阈值后才清理任务、配置、队列、正在出生的 creep、存量 creep 与 boost 占用，避免阈值附近反复出生。
- RCL1–7 的现有自动 upgrader 策略、主循环 phase 顺序与通用 worker 策略保持不变。

## Capabilities

### New Capabilities

- `rcl8-upgrader-maintenance`: RCL8 controller 降级计时的低成本滞回恢复和全链清理合同。

### Modified Capabilities

- 无。

## Impact

- 影响 `src/runtime/hubUpgradeControl.ts`、`src/roles/upgrader.ts` 及其测试。
- 新增共享的 RCL8 maintenance 策略模块；不改变 Memory schema、控制台命令名称、spawn phase 顺序或市场自动化状态。
