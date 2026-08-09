## Why

新建 Power Creep 后，系统需要仅凭 PC 名称稳定找到同名己方房间，自动完成孵化和房间 Power 启用；同时当前所有能力房间都会运行 PowerSpawn 加工，与现阶段只允许 E4N58 消耗 Power 和 Energy 的运营策略不符。

## What Changes

- 将“PC 名称等于房间名”设为未归属 PC 的唯一自动发现规则；仅当同名房间可见、属于己方且拥有己方 PowerSpawn 时建立归属并尝试孵化，同时保留既有显式 `homeRoom` 兼容入口。
- 已孵化的同名 PC 在归属房间 Controller 尚未启用 Power 时，自动去重入队并执行 `enable_room`。
- 未归属 PC 缺少同名己方房间或己方 PowerSpawn 时保持 fail-closed，不回退到 PC 当前所在房间进行自动归属。
- 将运行时暴露的非有限 `ticksToLive`（线上实况为 `NaN`）视为未出生状态，避免 PC 永久停在无 `room`/`pos` 的边界。
- 将 PowerSpawn 的 `processPower()` 和相应资源补给限定为 E4N58；其他房间的 PowerSpawn 仅供 PC 孵化和续命。

## Capabilities

### New Capabilities

- `room-matched-power-creep-activation`: 规定同名房间归属、自动孵化、自动启用 Power，以及 PowerSpawn 加工房间限制。

### Modified Capabilities

无。

## Impact

- 影响 `src/runtime/powerCreepControl.ts` 的归属与生命周期调度。
- 影响 `src/runtime/powerSpawnControl.ts` 的加工和补给范围。
- 补充对应 Jest 回归测试；不修改 spawn/upgrader、版本号、凭据或线上 Memory。
