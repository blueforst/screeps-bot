## Why

成熟房间的通用 carrier 当前被限制为 16 组 `CARRY + MOVE`，最大只能搬运 800 资源；link miner 也只有 300 容量且移动部件偏少。现有上限没有利用房间能量容量，也不足以覆盖当前物流与 `REGEN_SOURCE` 提升后的吞吐需求。

## What Changes

- 将通用 carrier 的身体上限扩大到 1000 容量，并保持 `CARRY:MOVE = 1:1`。
- 让常规 profile、应急 `maxcarrier` 和 HAUL 旗帜搬运共用同一体型上限，避免旁路继续停留在 800 容量。
- 将 link miner 的携带容量扩大到 400，并按“非 MOVE 部件:MOVE = 2:1”配置移动部件。
- 保留 miner 的 `REGEN_SOURCE` 动态 WORK 计算与先补后退换代机制。

## Capabilities

### New Capabilities

- `creep-body-capacity-policy`: 规定通用 carrier 与 link miner 的容量、部件比例、能量约束和体型切换行为。

### Modified Capabilities

无。

## Impact

- 影响 `src/config/spawnProfiles.ts`、应急 carrier 与 HAUL 旗帜搬运的身体生成入口，以及对应回归测试。
- 新 carrier 的最高身体为 20 `CARRY` + 20 `MOVE`，需要 2000 能量与 120 tick 孵化时间。
- miner 目标体型会变化；现有体型不匹配检查将安排新单位，并沿用到位后再退役旧单位的安全交接流程。
