## Why

专用手动 `upgrader` 的固定 2250 能量身材已能由 RCL6 房间出生。将任务起点从 RCL7 放宽至 RCL6，可更早进行集中升级，同时继续在 RCL8 自动终止。

## What Changes

- 将手动 `upgrader` 的有效发布和运行等级由仅 RCL7 改为 RCL6–7。
- 更新命令错误文本、角色有效性和回归测试；RCL8 自动终止保持不变。

## Capabilities

### New Capabilities

- `manual-upgrader-rcl6`: RCL6 起可发布固定身材的手动专用升级任务。

### Modified Capabilities

- 无。

## Impact

- 影响 `src/runtime/hubUpgradeControl.ts`、`src/roles/upgrader.ts` 及其测试。
