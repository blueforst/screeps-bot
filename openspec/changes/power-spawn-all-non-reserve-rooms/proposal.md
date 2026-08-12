## Why

当前 Power Spawn 加工被临时硬编码为仅允许 Hub 房间 E4N58，导致其他拥有 Power Spawn 和本地 Power 库存的非储备己方房间无法加工。现在需要让储备标志成为全体己方 Power Spawn 房间统一的加工门禁，使闲置 Power 能按房间就地转化为账号 GPL。

## What Changes

- 将 Power Spawn 加工发现范围从 E4N58 单房间扩展为所有当前可见、己方控制且拥有己方 Power Spawn 的房间。
- 非储备房间在至少拥有 1 Power 和 50 Energy 时每 tick 至多加工一次，并继续使用既有 20%/90% 滞回发布 Power/Energy 专用补给任务。
- `RESERVE` 或 `RESERVE_<room>` 继续作为权威停止条件：储备房间不加工，并清理既有专用补给任务。
- 移除 Power Spawn 加工对 `OPERATE_EXTENSION` Power Creep 能力的依赖；Power Creep 的孵化、续命和其他技能调度保持不变。
- 让普通 Carrier Energy 目标在非储备加工房间让位于专用 Power Spawn 补给任务，避免两条补给路径重复派工。
- 更新主规格与回归测试，覆盖非 Hub、无 Power Creep、储备切换及无己方 Power Spawn 的边界。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `power-creep-room-control`: 将 Power Spawn 加工及专用补给从 E4N58 专属策略改为所有非储备己方 Power Spawn 房间策略，并取消 `OPERATE_EXTENSION` 能力前置条件。

## Impact

- 影响 `src/runtime/powerSpawnControl.ts` 的房间发现、加工与任务清理范围。
- 影响 `src/roles/energyTargets.ts` 的 Power Spawn 普通 Energy 目标让位策略。
- 更新 `src/runtime/powerSpawnControl.test.ts`、`src/roles/energyTargets.test.ts` 和 `openspec/specs/power-creep-room-control/spec.md` 的合同与回归覆盖。
- 不新增 Memory schema，不改变主循环 phase 顺序，也不修改 Power Creep 生命周期、市场资源暴露保护或储备标志语义。
- 部署后 Power 与 Energy 的消耗会从单一 Hub 扩展到所有符合条件的房间；回滚本变更即可恢复 E4N58 单房间加工。
