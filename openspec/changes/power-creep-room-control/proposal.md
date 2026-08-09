## Why

当前机器人没有 Power Creep 运行时控制，无法自动调度其技能、续命和资源卸载，也没有把拥有 `OPERATE_EXTENSION` 的房间与 carrier、Power Spawn 物流联动起来。需要建立一套按 Power Creep 能力自动生效的控制链，让新增的 Operator 能稳定工作且不会把规则硬编码到单个房间。

## What Changes

- 新增 Power Creep 房间归属、能力发现、持久化任务队列和逐 tick 执行控制。
- 将 Power Creep 的同房移动接入通用寻路与交通推让；等待技能条件时允许普通 creep 将其推到附近空位，并尽量保持在技能影响范围内。
- 按既定优先级调度 `OPERATE_STORAGE`、交替 `REGEN_SOURCE`、`OPERATE_EXTENSION` 与冷却完成即入队的 `GENERATE_OPS`；拥有 `OPERATE_STORAGE` 时利用 200 tick 冷却重叠窗口提前回到 Storage，持续维持其 effect。
- 按已归属 Power Creep 的 `REGEN_SOURCE` 实际等级提高本房间 link miner 的 WORK 吞吐，并以先补后退方式平滑替换旧体型。
- 在 OPS 接近满载时，将其卸载到 storage，并保留 Power Creep 一半容量的 OPS。
- 在 Power Creep 寿命低于 200 tick 时插入最高优先级 `renew` 任务。
- 对分配了具备 `OPERATE_EXTENSION` 技能 Power Creep 的房间动态启用供能接管：carrier 不再给 Spawn 供能；Power Creep 正常运行时也不再给 Extension 供能，失效时仅恢复 Extension 供能。
- 在 carrier 任务板新增 Power Spawn 的 `power` 与 `energy` 批量补给任务，并在资源充足时自动执行 `processPower()`。

## Capabilities

### New Capabilities

- `power-creep-room-control`: Power Creep 的能力驱动房间控制、任务队列、技能执行、续命、OPS 物流、carrier 供能接管与 Power Spawn 自动加工。

### Modified Capabilities

无。

## Impact

- 新增 Power Creep 运行时模块及相关 Memory 类型。
- 调整主循环阶段、miner 动态体型与换代、carrier 任务板类型及 carrier 能源目标选择。
- 新增 Power Spawn 补给和加工控制及对应测试。
- 不新增第三方依赖；没有 `OPERATE_EXTENSION` Power Creep 的房间保持现有行为。
