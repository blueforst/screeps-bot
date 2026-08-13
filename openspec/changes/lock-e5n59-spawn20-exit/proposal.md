## Why

E5N59 的 Spawn20 下方存在由建筑与天然墙围成的封闭双格；当唯一安全的北侧出口在 creep 完成出生的 tick 被占用时，Screeps 默认方向回退会把新 creep 放入封闭区并永久困住。该风险影响 Spawn20 生产的全部角色，需要在出生执行层阻止不安全回退。

## What Changes

- 为 E5N59 的 Spawn20 固定出生方向为 `TOP`，禁止新 creep 落入南侧封闭区。
- 北侧出口临时被占时保留原生出生重试语义，让 Spawn20 等待出口释放。
- 保持其他房间、E5N59 其他 Spawn、出生队列、body、role 与 Creep Memory 行为不变。
- 增加针对目标 Spawn 与非目标 Spawn 的回归测试。

## Capabilities

### New Capabilities

- `spawn-egress-safety`: 定义布局特例 Spawn 的安全出生方向及非目标 Spawn 的兼容边界。

### Modified Capabilities

无。

## Impact

- 代码：`src/mount/mountSpawn.ts`、`src/mount/mountSpawn.test.ts`。
- 运行时：仅 E5N59/Spawn20 的 `spawnCreep` options 增加 `directions: [TOP]`；北侧被占时可能延长该 Spawn 的 busy 时间。
- 状态与接口：不新增或迁移 Memory，不修改 Spawn 队列 wire、prototype ABI、main tick phase 或角色逻辑。
