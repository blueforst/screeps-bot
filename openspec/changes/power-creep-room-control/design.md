## Context

项目当前仅在普通 creep 主循环中执行角色逻辑，`Game.powerCreeps` 没有运行时控制器。carrier 的通用能源目标会直接选择 Spawn、Extension 和 Power Spawn，而 carrier 任务板尚不支持 Power Spawn。当前 Operator 名为房间名，可用作一次性的通用归属引导，但运行逻辑不能包含具体房间白名单。

## Goals / Non-Goals

**Goals:**

- 为每个已归属房间的 Power Creep 提供可持久化、可去重、按优先级执行的任务队列。
- 自动完成初次孵化、房间启用、续命、OPS 生成/卸载和已确认的三类经济技能调度。
- 从 Power Creep 的实际技能生成房间能力，而不是硬编码房间。
- 让具备 `REGEN_SOURCE` 能力的房间按技能等级扩展 link miner 的有效采集吞吐。
- 让具备 `OPERATE_EXTENSION` 能力的房间切换 carrier 供能策略，并通过 carrier 任务板补给和运行 Power Spawn。
- 在单元测试、类型检查、构建和真实 shard 上验证行为。

**Non-Goals:**

- 本次不自动使用 `OPERATE_FACTORY` 或 `OPERATE_OBSERVER`。
- 本次不根据路径距离调整任务时间或优先级。
- 本次不改变没有具备 `OPERATE_EXTENSION` Power Creep 的房间行为。

## Decisions

### Power Creep 归属和能力表

`PowerCreepMemory.homeRoom` 是归属的持久化事实。首次没有该字段时，若 Power Creep 名称对应一个可见、己方且拥有 Power Spawn 的房间，则自动采用并写入；已孵化但尚未归属的 Power Creep也可采用其当前满足条件的房间。该引导是通用约定，不包含具体房间名。

每 tick 从所有已归属 Power Creep 的 `powers` 构建房间能力缓存，同时记录房间内最高的 `PWR_OPERATE_EXTENSION` 和 `PWR_REGEN_SOURCE` 等级。房间是否进入 Extension 接管模式仍仅取决于前者；当前位置只决定 Extension 是否可安全交由 PC，而不决定房间归属。

### REGEN_SOURCE 与 miner 吞吐

link miner 的目标 WORK 数从房间归属 PC 的最高 `REGEN_SOURCE` 等级推导，不依赖具体房间名，也不依赖某一时刻 Source effect 是否恰好存在。计算使用游戏常量：基础 Source 平均产量为 `SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME`，技能额外平均产量为对应等级 `POWER_INFO[PWR_REGEN_SOURCE].effect / period`，再除以 `HARVEST_POWER` 并向上取整。无该技能时继续使用现有 6 WORK 基线；1 至 5 级分别需要 7、9、10、12、14 WORK。

miner 保留现有 6 CARRY 缓冲，并按原体型约每 4 个非 MOVE 部件配置 1 MOVE。4 级最终体型为 `12 WORK + 6 CARRY + 5 MOVE`；增加无助于吞吐的 CARRY 不在本轮范围内。

当目标体型与现役 miner 不一致时，Spawn Planner 即使在旧 miner 寿命尚长时也安排一个新体型替代者。旧 miner 仅在新体型 creep 完成孵化并进入可交接范围后才自毁：通常要求替代者进入 Source 范围 1；若 Source 只有一个可站工位且被旧 miner 占据，则允许替代者在旧 miner 已位于 Source 范围 1 时从其相邻格交接。这样不会在孵化或长途寻路期间断采，同时避免单入口地形形成换代死锁；排队或孵化期间利用既有去重规则避免重复替换。

### 持久化任务队列

队列保存在各自 `PowerCreepMemory.tasks` 中。任务具有稳定 ID、类型、优先级、创建时间和可选目标 ID；插入以稳定 ID 去重，并按优先级降序、创建时间升序选择。生命周期任务高于技能任务；技能内部 `OPERATE_STORAGE` 最高，`REGEN_SOURCE`、`OPERATE_EXTENSION`、`GENERATE_OPS` 平级。

执行器每 tick 处理一个队列任务，并通过项目通用的同房路径跟随与交通协调移动到目标。资源暂时不足的技能任务保留但不阻止可运行的 `GENERATE_OPS`，避免 `OPERATE_STORAGE` 因缺少 100 OPS 形成死锁。

### Power Creep 交通协调

通用交通占位从仅识别普通 `Creep` 扩展为识别己方 `Creep | PowerCreep`。同房移动中的 PC 记录与普通 creep 相同的路径请求状态，因此后来执行的普通 creep 不会错误地把它当作静止障碍；等待中的 PC 没有活动路径，可由普通 creep 使用既有推让协议移动到相邻可走位置。

Storage 维护任务存在时，为 PC 保存以 Storage 为中心、技能实际 range 为半径的工作锚点。推让位置评分优先选择仍在锚点范围内的空位；若不得不被推出范围，下一 tick 的维护控制会通过通用寻路返回范围内。跨房移动不在本次交通适配范围内，仍保留原生移动兜底。

### 生命周期和 OPS

未孵化的已归属 Power Creep 会在归属房间 Power Spawn 可用时调用 `spawn()`。房间尚未启用 Power 时插入 `enable_room`；`ticksToLive < 200` 时插入最高优先级 `renew`。

`GENERATE_OPS` 冷却为零即入队。OPS 达到容量 90%，或剩余容量不足以下一次生成量时，插入卸载任务；任务向归属房间 storage 转移，使 PC 最终保留约 50% 容量的 OPS。

### 技能调度

`OPERATE_STORAGE` 是持续维护技能。Storage 尚无 effect 时，即使暂时缺 OPS 或技能仍在冷却，也保留最高普通优先级任务并让 PC 回到范围 3 内；此时只允许更高优先级生命周期任务和用于解除 OPS 短缺的 `GENERATE_OPS` 越过该任务，不再为 `REGEN_SOURCE`、`OPERATE_EXTENSION` 离开 Storage。

Storage effect 持续 1000 tick、技能冷却 800 tick。已有 effect 时，冷却期间正常处理其他任务；冷却归零后立即重新插入维护任务，利用剩余约 200 tick 提前回到 Storage 并等待。有效 effect 尚未结束时不得提前施法；effect 消失后的第一个可执行 tick 立即续上并重新开始周期。

`REGEN_SOURCE` 保存稳定排序的两个 Source ID 和下一目标索引。仅当下一目标没有有效 `REGEN_SOURCE` effect 且技能冷却完成时入队；只有 `usePower()` 返回 `OK` 才切换索引，因此形成 A、B、A、B 的交替序列并避免提前刷新。

`OPERATE_EXTENSION` 在技能冷却完成且房间 Extension 存在能量缺口时入队，目标依次选择有能量的 storage、terminal、container。

### Carrier 供能接管

对已归属且具备 `OPERATE_EXTENSION` 的房间，carrier 永远跳过 Spawn，主动放弃其能量容量；当 PC 已孵化、位于归属房间、房间 Power 已启用且控制心跳新鲜时，carrier 同时跳过 Extension。PC 暂时不可用时只恢复 Extension，不恢复 Spawn。

Power Spawn 在这些房间中退出通用能源目标，统一由任务板管理，避免通用供能和显式任务重复派工。

### Power Spawn 补给和加工

任务板新增 `power_spawn_supply` 类型和 `power_spawn` 结构种类。控制器仅遍历具备上述房间能力的房间；Power 或 Energy 低于自身容量 20% 时发布补至满仓的稳定任务步骤。Power 优先从 terminal 获取、Energy 优先从 storage 获取，并复用现有 terminal 市场暴露保护。

Power Spawn 补给优先于普通 Lab/Factory 补料，但低于防御性 Tower 供能和既有紧急清空任务。每 tick 在 Power Spawn 至少有 1 Power 和 50 Energy 时调用一次 `processPower()`。

## Risks / Trade-offs

- [PC 名称与房间不匹配且没有持久化归属] → 不自动派遣，避免错误房间副作用；可在 Memory 中设置 `homeRoom` 后接管。
- [PC 离线时 Extension 能量不足] → 控制心跳失效即恢复 Extension carrier 供能。
- [Storage effect 结束时 PC 距离过远或 OPS 不足] → 在冷却归零后的重叠窗口提前回到范围内；effect 缺失时暂停其他普通目标技能，仅放行 `GENERATE_OPS` 补足 OPS。
- [等待中的 PC 占据主干道路] → 将 PC 纳入通用交通占位和推让，并用技能范围工作锚点约束优先让路位置。
- [Spawn 不再补能导致可用上限降低] → 这是明确接受的策略；仅对具备对应 PC 能力的房间生效。
- [Power Spawn 小额高频补给浪费 carrier] → 采用 20%/90% 低高水位批量补给，单次任务仍按补至满仓计算搬运量。
- [miner 体型升级时直接淘汰旧单位造成断采] → 先孵化目标体型，确认其抵达 Source 范围 1；单入口矿点则确认其抵达旧工位相邻格后再交接。
- [部署后 PC 自动孵化和启用房间产生生产动作] → 先完成全量测试，再推送并通过实时数据观察队列、PC、Power Spawn 和 carrier 行为；回滚可重新推送上一版本。

## Migration Plan

1. 部署新代码后，名称匹配归属房间的现有 Power Creep 自动写入 `homeRoom` 并尝试孵化。
2. 首次进入房间后自动执行 `enable_room`，随后开始技能调度。
3. 观察至少一个技能/物流周期；异常时推送部署前版本，carrier 会因控制心跳消失恢复 Extension 供能。

## Open Questions

无；本轮已确认的行为足以实施。
