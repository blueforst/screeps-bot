## Context

现有 `powerCreepControl` 已能从未设置 `homeRoom` 的 PC 名称引导归属，也已具备孵化、`enable_room` 和续命任务；但名称匹配失败后仍会回退到 PC 当前房间，可能让新建 PC 被错误房间接管。现有 `powerSpawnControl` 则会对所有具备 `OPERATE_EXTENSION` 能力的房间补给并运行 PowerSpawn。

线上 shard1 的只读数据表明：E4N58 有己方 PowerSpawn、同名 PC 且 Controller 已启用 Power；E6N59 有己方 PowerSpawn但 Controller 未启用 Power；W1N57 有同名 PC Memory，但房间没有 PowerSpawn。实现必须保留后者的 fail-closed 行为。

## Goals / Non-Goals

**Goals:**

- 对未归属 PC 仅用 PC 名称自动绑定同名己方 PowerSpawn 房间，同时保留显式 `homeRoom` 兼容入口。
- 复用现有持久化队列自动孵化 PC，并在必要时启用 Controller Power。
- 当前仅允许 E4N58 补给并运行 PowerSpawn 加工，其他 PowerSpawn 只承担 PC 生命周期动作。
- 对缺少可见己方同名房间或 PowerSpawn 的 PC 保持无副作用。

**Non-Goals:**

- 不创建、升级、删除或重命名 Power Creep。
- 不在线修改 Memory，也不在本变更中提交或部署。
- 不修改 Power Creep 技能选择、upgrader 或普通 Spawn 策略。

## Decisions

### PC 名称是未归属 PC 的唯一自动发现来源

`resolvePowerCreepHomeRoomName` 继续优先接受已显式持久化的 `homeRoom`，以兼容既有能力测试和手动归属。对于没有 `homeRoom` 的 PC，只检查 `Game.rooms[powerCreep.name]`：同名房间可见、Controller 属于己方且存在己方 PowerSpawn 时才持久化；否则返回 `null`，不再使用 PC 当前房间作为自动回退。

选择这一方案是因为名称约定可审计、确定且不会因 PC 途经其他房间发生漂移。完全让名称覆盖既有 `homeRoom` 会破坏显式归属兼容性；保留当前位置回退又会破坏自动绑定边界，因此只移除隐式位置回退。

### 生命周期沿用现有队列

未出生 PC 继续通过同名房间的己方 PowerSpawn 调用 `spawn()`；出生后继续由 `scheduleLifecycleTasks` 以稳定 ID `enable_room` 去重入队。执行器先尝试 `enableRoom()`，返回 `ERR_NOT_IN_RANGE` 时使用现有寻路到 Controller 范围 1。无需新增 Memory 结构。

### PowerSpawn 加工采用显式临时范围

定义当前加工房间集合，仅包含 E4N58。`runPowerSpawnControl` 仍从能力缓存发现房间，但只有允许加工的房间才进入补给和 `processPower()` 路径；其他房间的旧 `powerSpawnControl` carrier 任务被现有 prune 机制清除。

将补给与加工使用同一范围，是为了避免其他房间在不加工时仍持续占用 carrier 搬运 Power/Energy。PC 的孵化和续命属于 `powerCreepControl`，不依赖该加工范围。

## Risks / Trade-offs

- [未归属的非同名旧 PC 不再自动采用当前位置] → 可使用既有显式 `homeRoom` 配置；不恢复隐式位置回退。
- [同名房间暂时不可见时 PC 暂停控制] → 下一次房间可见且有己方 PowerSpawn时会自动恢复，避免向未经验证的目标执行生命周期动作。
- [E4N58 硬编码是临时策略] → 以单一导出常量集中表达，后续可改成显式配置或受控房间集合。
- [其他房间残留旧补给任务] → `pruneCarrierTasksForProducer` 以本 tick 有效房间集合清理。

## Migration Plan

1. 运行单元测试、类型检查、构建和 OpenSpec 严格校验。
2. 由父任务决定提交与部署；本子任务不修改版本号、不提交、不部署。
3. 部署后只读观察同名 PC 的 room/ageTime、Controller `isPowerEnabled`、各 PowerSpawn 库存和 `processPower` 消耗。
4. 如出现异常，回滚本变更即可恢复原有归属回退和全能力房间加工行为。

## Open Questions

无。
