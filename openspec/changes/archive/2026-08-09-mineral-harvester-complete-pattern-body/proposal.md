## Why

`mineralHarvester` 先按能量生成重复的 `WORK + WORK + MOVE` 组合，再由通用裁剪器逐部件截到 50。高能量房间因此会把 51 部件裁成 `34 WORK + 16 MOVE`，在完整 48 部件组合后追加两个残缺 WORK，破坏既定的 2:1 移动比例并降低移动效率。

## What Changes

- mineralHarvester 身体只按完整的 `WORK + WORK + MOVE` 组合增长，同时受能量预算和 50 部件上限约束。
- 50 部件不足以容纳下一完整组合时保留 48 部件的 16 组最佳身体，不再用残缺组合填满剩余槽位。
- 增加能量临界值与高能量 50 部件边界回归测试。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `creep-body-capacity-policy`: 增加 mineralHarvester 完整身体组合、能量边界与部件上限约束。

## Impact

- 修改 `src/config/spawnProfiles.ts` 中 mineralHarvester 使用的身体生成器。
- 扩展 `src/config/spawnProfiles.test.ts` 的身体组成与预算边界覆盖。
- 不改变 bootstrap 配置名、spawn queue、role、Memory schema 或已存在 creep；后续自然换代时使用新体型。
