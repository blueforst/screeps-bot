## 1. 线上事实与归属边界

- [x] 1.1 只读核对 shard、PC 名称、同名房间、PowerSpawn 和 Controller Power 状态
- [x] 1.2 将同名合格房间设为未归属 PC 的唯一自动发现入口，并移除当前位置自动回退

## 2. Power Creep 生命周期

- [x] 2.1 验证未出生同名 PC 只从同名己方 PowerSpawn 孵化
- [x] 2.2 补充 Controller 未启用时自动入队、执行 `enable_room` 及无 PowerSpawn fail-closed 回归测试

## 3. PowerSpawn 加工范围

- [x] 3.1 将 PowerSpawn 加工和对应补给限定为 E4N58，不影响其他房间的 PC 孵化与续命
- [x] 3.2 补充 E4N58 保持加工、非 E4N58 禁止加工和补给的回归测试

## 4. 验证

- [x] 4.1 运行相关 Jest、TypeScript 类型检查、构建和 `git diff --check`
- [x] 4.2 运行 `openspec validate room-matched-power-creep-activation --strict`

## 5. 未出生 TTL 边界修复

- [x] 5.1 记录 shard1 tick 72882087 的 E6N59 `ticksToLive=NaN`、无 `room`/`pos` 线上证据
- [x] 5.2 将 null、undefined 和非有限 TTL 统一视为未出生，同时保留有限 TTL=0/正数语义
- [x] 5.3 补充 NaN 自动孵化及有限 TTL 边界回归测试
- [x] 5.4 运行相关 Jest、TypeScript、构建、diff check 和 OpenSpec strict validate
