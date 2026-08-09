## Why

当前 Power Creep 控制器会把目标上任何仍有效的同类 effect 都视为不可覆盖，导致 `OPERATE_STORAGE` 和 `REGEN_SOURCE` 即使 cooldown 已归零也继续等待。Screeps 允许同级或更低级的同类 effect 被立即覆盖，只有目标上的更高级 effect 会以 `ERR_FULL` 拒绝，因此应直接按 cooldown 刷新。

## What Changes

- 统一比较目标上有效同类 effect 的等级与当前 Power Creep 技能等级。
- 技能 cooldown 归零时，允许覆盖同级或更低级 effect；仅在目标存在更高级同类 effect 时等待。
- 更高级 effect 只阻断其对应任务；等待中的 `operate_storage` 不再排除其他可执行的 effect 任务。
- `OPERATE_STORAGE` 继续以普通技能最高优先级立即刷新；同 tick 同时就绪的 `REGEN_SOURCE` 在下一 tick 执行。
- `REGEN_SOURCE` 成功覆盖后立即轮换下一座 Source，失败或被更高级 effect 阻断时不轮换。
- 维护 workAnchor 跟随实际执行任务或本 tick 预定位目标，不再无条件指向 Storage。
- 更新旧的“等待同级 effect 结束”测试，并增加同级覆盖、更高级阻断、顺序刷新和无 effect 行为回归。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `power-creep-room-control`: 将 `OPERATE_STORAGE` 与 `REGEN_SOURCE` 的持续效果维护语义改为 cooldown 到即覆盖同级或更低级 effect，仅等待更高级 effect。

## Impact

- 运行时：`src/runtime/powerCreepControl.ts`
- 测试：`src/runtime/powerCreepControl.test.ts`
- 规范：`power-creep-room-control` 的 `OPERATE_STORAGE` 与 `REGEN_SOURCE` 要求
- 不新增依赖，不改变任务队列或 Memory 数据结构。
