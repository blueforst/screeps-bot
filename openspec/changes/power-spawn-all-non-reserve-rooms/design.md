## Context

当前 `runPowerSpawnControl` 从 `listOperateExtensionRoomCapabilities()` 发现房间，再以 `POWER_SPAWN_PROCESS_ROOM_NAME = "E4N58"` 二次过滤，因此“非储备”只是 E4N58 的附加门禁，不是全房间加工策略。线上 shard1 在 tick 72948534 可见 E4N58、E5N59、E6N59、W1N57 均有己方 Power Spawn；后三个房间的 Power Spawn 为空，但本地 Storage 分别有可加工 Power，说明现有限制确实留下了可就地加工的库存。

Power Spawn 专用补给由 `powerSpawnControl` 在主循环的同名 phase 发布到 carrier task board，随后 Carrier 在 creep work phase 消费。普通 Energy 目标选择还会把未由 Power Creep 策略接管的 Power Spawn 当作直接投递目标；扩大专用补给范围时必须同步调整该路径，否则无 `OPERATE_EXTENSION` PC 的房间会绕过 20%/90% 滞回。

## Goals / Non-Goals

**Goals:**

- 所有当前可见、己方控制且拥有己方 Power Spawn 的非储备房间都自动加工 Power。
- 加工与专用 Power/Energy 补给不再要求房间存在 `OPERATE_EXTENSION` Power Creep 能力。
- 继续复用 `isRoomInReserveMode`、既有资源阈值、市场暴露保护、carrier task board 和任务清理机制。
- 让普通 Energy 目标在专用加工策略有效时跳过 Power Spawn，维持单一补给所有权。
- 不改变主循环顺序，不新增持久状态，部署后可通过结构库存连续变化直接验收。

**Non-Goals:**

- 不改变 Power Creep 的归属、孵化、续命、技能调度或 Controller Power 启用逻辑。
- 不跨房调拨 Power 或 Energy，不新增市场购买，也不为缺少 Power Spawn 的房间自动建造结构。
- 不为 Power Spawn Energy 增加 `energyFloor` 等新资源安全线；本次沿用现有库存可用性和 `RESERVE` 门禁。
- 不修改现有 OpenSpec 活动变更中的市场、Terminal headroom 或 dispatch ownership 合同。

## Decisions

### 以己方房间和己方 Power Spawn 作为加工发现源

`runPowerSpawnControl` 按房间名稳定排序遍历 `Game.rooms`，只接受 `room.controller.my`、非储备且能找到己方 Power Spawn 的房间。加工集合不再从 Power Creep 能力缓存派生，也不保留 E4N58 常量。

只删除 E4N58 判断但继续遍历 `listOperateExtensionRoomCapabilities()` 的方案不能满足“所有非储备房间”：没有对应 PC 或 PC 不具备 `OPERATE_EXTENSION` 的房间仍会被静默排除。改用显式配置 allowlist 也会重新引入需要人工维护的第二门禁，因此不采用。

### 加工与专用补给共享同一房间资格

每个合格房间继续在 Power Spawn 至少有 1 Power 和 50 Energy 时调用一次 `processPower()`。同一 phase 使用既有 20% 低水位触发、90% 高水位停止的 `power_spawn_supply` 草案补充 Power 和 Energy；Power 优先从 Terminal、再从 Storage 取，Energy 优先从 Storage、再从 Terminal 取，Terminal 仍扣除市场出售暴露量。

进入储备、失去己方控制、Power Spawn 消失或房间不再可见时，该房间不进入本 tick 有效集合，`pruneCarrierTasksForProducer` 清理旧任务。这样加工和搬运不会出现不同范围。

### 普通 Energy 投递显式让位于非储备加工策略

`powerSpawnControl` 导出轻量的房间加工资格判断，`energyTargets` 在已经发现己方 Power Spawn 后复用该判断。非储备加工房间跳过普通 Power Spawn Energy 目标，只由专用 task board 按滞回补给；储备房间继续遵循既有 Power Creep Energy 策略，不在本变更中扩大专用补给。

直接保留普通 Energy 投递虽然也能让结构获得 Energy，但会在每次加工产生 50 Energy 缺口后持续补给，绕过 20%/90% 滞回，并可能与专用任务的容量 claim 竞争，因此不采用。

### 保持无持久迁移的即时切换

资格完全由当前 `Game.rooms`、己方结构与 Flag 决定，不写入 Memory。新 bundle 生效后的首个 tick 即可为所有合格房间发布任务；回滚旧 bundle 后，旧版有效集合只保留 E4N58，并在下一 tick 清理其他房间的专用任务。

## Risks / Trade-offs

- [多个房间同时开始消耗 1 Power + 50 Energy/tick，账号资源支出增加] → 这是本次目标的直接结果；保留每房每 tick 一次上限、资源实存检查和逐房 `RESERVE` 紧急停止。
- [新开放房间的 Carrier 同时需要处理其他生产/防御任务] → 沿用现有 priority 150、task board claim 和 20%/90% 滞回，不改变其他任务优先级。
- [普通 Energy 路径与专用任务重复] → 对所有非储备加工房间显式跳过普通 Power Spawn 目标，并加入无 PC 能力房间回归测试。
- [遍历可见房间增加少量固定 CPU] → 账号当前仅有少量己方房间；按 tick 一次遍历并稳定排序，避免为此引入 Memory/cache 复杂度。
- [房间临时失去可见性或控制权] → fail-closed，不加工，并通过 producer prune 清理旧任务。

## Migration Plan

1. 先落地 OpenSpec delta、定向测试和实现，运行相关 Jest、TypeScript、构建、diff check 与 OpenSpec strict validate。
2. 运行全量 Jest，确认 Carrier、Power Creep、Power Spawn 和主循环契约无回归。
3. 创建单一 Git 提交并执行 `npm run push` 上传游戏分支。
4. 通过 `monitor:once` 验证 shard1 的新 `lastDeployTag`，再以只读 room-objects 快照观察至少两个非 Hub 非储备 Power Spawn 获得 Power 并连续消耗。
5. 若出现异常，回退该提交并重新 `npm run push`；无需回滚 Memory schema 或清理迁移数据。

## Open Questions

无。
