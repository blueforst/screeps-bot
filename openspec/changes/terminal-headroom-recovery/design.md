## Context

当前容量均衡已经具备 `normal / pressure / emergency` 滞回状态、跨房容量泄压任务和房内 terminal feed/offload 任务，但三套判断没有形成同一个闭环：

- terminal 超过固定使用量 250,000 时才生成 offload，且最多排空到 250,000，即保留约 50,000 空闲；
- 受压房只有在 terminal 空闲达到 `terminalReliefTargetFreeCapacity`（默认 80,000）后才恢复为 `normal`；
- receiver admission 仅要求 `receiverTerminalMinFreeCapacity`（默认 50,000），Hub 又维护了一套独立的 receiver buffer；
- 普通跨房任务即使长期被 `receiver_capacity` 阻塞，仍可能预装载到 terminal，并作为受保护库存阻止排空。

2026-07-14 的线上只读快照中，帝国 storage 与 terminal 合计仍有 1,984,046 空闲，但 8 个房间中 7 个处于 pressure/emergency，且当时没有可用 receiver。E5N59、E6N59、E7N57 的 storage 合计有约 148 万空闲，terminal 却都停留在约 50,000 空闲附近；11 个自动任务中有 9 个被 `receiver_capacity` 阻塞。该现象说明系统缺少的不是总容量，而是可恢复、可预留且能被执行器使用的 terminal headroom。

本变更是止血型改造：保留现有 ResourceControl 任务模型和主循环顺序，只修复容量水位、receiver 计算与 staging admission。完整的房间意图、容量租约和 TransferContract 架构由后续 `decentralized-logistics-contracts` 变更负责。

## Goals / Non-Goals

### Goals

- 让 pressure/emergency 房间在 storage 有安全空间时能从约 50,000 terminal 空闲继续恢复到配置的恢复水位。
- 让 ResourceControl 与 Hub 使用同一份容量策略和同一套 receiver 可接收容量计算。
- 保证 receiver 的已承诺入站量和同 tick 预留不会超过真实安全容量。
- 只让健康且近期可执行的跨房任务占用 terminal staging 空间，并在条件失效时释放 staging。
- 提供足以定位“无 receiver”“粘滞水位”“阻塞 staging”和恢复进度的运行时观测。
- 在不增加全表重复扫描的前提下完成改造，保持 ResourceControl CPU 成本可控。

### Non-Goals

- 不在本变更中引入房间自治 agent、TransferContract、持久 lease 或 carrier claim。
- 不改变现有自动任务/手工任务持久格式、reason 优先级、任务 TTL 或 market 行为。
- 不改变 energy export、生存能量补给、矿物/T3/生产库存保护语义。
- 不把 Hub 从合成规划中移除，也不改变跨房生产链策略。
- 不重排 `src/main.ts` 的 Hub、Synthesis、Factory、ResourceControl 和 creep 执行阶段。

## Decisions

### 1. 建立共享的容量水位策略

从 `Memory.cfg.resourceControl.capacityBalancing` 规范化出一份纯数据 `CapacityHeadroomPolicy`，由 ResourceControl、Hub distribution 和运行时投影共同使用。默认值保持现状，但规范化后必须满足：

- terminal：`pressureFree <= receiverMinFree <= reliefTargetFree`；
- storage：`pressureFree <= reliefTargetFree <= receiverMinFree`；
- 所有值均限制在对应建筑容量范围内。

若用户配置不满足单调关系，按安全方向抬高后续水位并在 runtime 中记录 normalized 值，避免一个模块认为房间已恢复、另一个模块仍拒绝接收。

Hub 不再维护独立的 distribution receiver 常量，而是调用共享策略。现有配置字段继续有效，不引入破坏性迁移。

### 2. 受压 terminal 按恢复水位排空

terminal offload 的目标从固定 `TERMINAL_TOTAL_STORAGE_CAP` 改为由当前容量状态决定：

- `pressure` 或 `emergency` 房间以 `terminalReliefTargetFreeCapacity` 为目标；
- `normal` 房间保留现有日常 overflow 上限，避免无必要地反复搬运工作库存；
- 只有实际 storage 安全空闲允许时才生成 offload，预测中的 offload 不提前增加 receiver 可发送额度。

排空顺序保持非 energy 优先、energy 最后。下列库存不得被排空：当前发送窗口内已获 admission 的 staging、terminal energy reserve、已规划发送所需的交易费预算，以及现有生产/资源保护规则要求保留的库存。每个房间每轮仍使用有界的 carrier draft 和批次上限，避免 terminal 与 storage 间形成大规模抖动。

若 storage 无空间、所有库存均受保护或 carrier 长期没有完成 offload，房间继续保持 pressure/emergency，并在 runtime 中暴露具体恢复缺口和原因；不得伪造为 normal。

### 3. 以共享投影账本计算 receiver 容量

每次 `runResourceControl` 构建一次 room capacity index，包含：

- 当前 storage/terminal 的物理空闲；
- 规范化后的安全水位；
- 已通过本轮健康检查的待入站承诺；
- 本 tick 已规划或已发送的容量扣减；
- 本地 offload 的实际完成结果与仍待恢复的 headroom gap。

单个资源的可接收量取 terminal 总空闲、terminal 资源空闲和 storage 总空闲三者的安全下界，再扣除健康入站承诺与同 tick reservation。相同任务自身的承诺在重验时必须排除，避免自我重复扣减。

“健康入站承诺”必须仍处于 pending、来源与目标房间有效、没有 `receiver_capacity`/`source_depleted` 等失效 blocker，且尚未超过现有进度新鲜度窗口。长期失效任务不再永久占用 receiver 容量；它仍保留在任务账本中，由原有恢复/TTL 规则处理。

Hub distribution 在创建任务前使用同一个 index，并在每次计划后登记 reservation，因此多个 producer 在同一 tick 不能重复消费同一份 receiver headroom。尚未执行的本地 offload 只作为“可恢复 headroom”观测，不作为立即可发送容量。

### 4. 增加 terminal staging admission

为每个 source room 从现有已排序任务中选择一个有界发送窗口。任务只有同时满足以下条件时才可生成或保留 terminal feed：

- 任务为 pending，来源/目标/资源有效且来源总库存足够；
- receiver 已通过共享容量重验并取得本轮 reservation；
- 任务不是 `receiver_capacity`、`source_depleted` 或永久失败状态；
- 按现有优先级和创建时间排序后，任务能在当前或下一个本房 terminal 发送机会内执行；
- staging 后仍满足 terminal headroom、energy fee 和资源保护约束。

`insufficient_terminal_resource_or_fee` 需要拆成可诊断的 staging 判定：若缺的是 storage 中存在的发送资源且 fee 可满足，允许装载一个安全批次；若真实原因是 fee 不足、保护库存不足或来源总库存不足，则不装载。

feed 数量以任务剩余量、transfer batch、receiver reservation、terminal 安全空闲和来源可用库存的最小值为上限。下一轮条件失效时，`replaceCarrierTasksForProducerRoom` 必须移除旧 feed；由此释放的非 energy staging 可重新成为 offload 候选。同一资源在同一轮不得同时生成冲突的 feed 与 offload。

本变更仍沿用房间+资源聚合的 CarrierTask ID，不尝试解决多 carrier 持久 claim；该问题留给后续架构变更。

### 5. 增加恢复闭环观测

`Memory.runtime.resourceControl` 与 monitor 投影新增兼容性字段：

- 全局 `eligibleReceiverCount`、按 blocker 统计的 `suppressedStagingCount`；
- 每房 `desiredTerminalFreeCapacity`、`terminalRecoveryGap`、`recoverableOffloadAmount`；
- `stickyHeadroom` 及原因（storage_full、protected_inventory、carrier_backlog、no_offloadable_resource）；
- 当前 admitted staging 的资源、数量和对应任务数；
- capacity reservation 的 committed/remaining 摘要。

字段只用于观测，不成为调度的第二份状态源。monitor 对旧 runtime 快照缺少这些字段时必须保持兼容。

### 6. 每轮只构建一次索引

capacity index、pending commitment index 和 admitted staging window 在一次 ResourceControl 运行中构建并复用，替代 planner、executor、feed sync 各自扫描全部任务的做法。房间/资源距离与交易成本沿用现有缓存方式；本变更不增加“房间 × 房间 × 资源”的额外全量循环。

## Risks / Trade-offs

- **排空占用 carrier 吞吐**：受压房可能短期增加 terminal→storage 搬运。通过单轮批次上限、非 energy 优先和现有 task priority 限制影响。
- **配置规范化改变边界行为**：非单调的历史自定义值会被安全化。runtime 暴露规范化结果，并保留关闭新恢复逻辑的 feature flag 作为回滚手段。
- **过于保守地释放 staging**：任务可能在条件恢复后多等一个 ResourceControl 周期。相比长期占满 terminal，这个延迟可接受；下一轮必须自动恢复 feed。
- **承诺健康判断过期**：若新鲜度窗口太短，可能低估未来入站。安全性仍由每次 send 前重验保证；窗口必须复用现有任务生命周期常量并有回归测试。
- **真实 offload 依赖 carrier**：规划层无法保证搬运及时完成。因此不把计划中的 offload 计入即时 receiver 容量，并显式观测 carrier backlog。
- **P0 与后续合同模型重叠**：共享水位策略与容量投影会被 P1 复用；staging admission 的任务适配层在 P1 迁移完成后可删除。

## Migration Plan

1. 先加入共享策略、规范化测试和只读 capacity index，不改变执行路径。
2. 将 ResourceControl 与 Hub receiver 判断切换到共享 index，验证同 tick reservation 不超配。
3. 启用 pressure/emergency 动态 offload 和 staging admission，默认通过 `capacityBalancing.terminalHeadroomRecoveryEnabled` 开启，并保留关闭开关。
4. 更新 runtime/monitor 投影，在 live-like fixture 中验证 full→50k→80k→normal 的闭环和多周期无振荡。
5. 完成 TypeScript、单元/集成测试和构建后再部署；线上观察 receiver 数、阻塞年龄、恢复 gap、carrier backlog 与 ResourceControl CPU。
6. 若出现异常，关闭 feature flag 即回到旧 offload/staging 行为；共享策略与观测字段可保留。

现有 `Memory.data.resourceControl.tasks` 不迁移、不清空；旧 monitor 在新增可选字段下继续工作。

## Open Questions

无。默认水位沿用现有配置，P0 的作用是消除不一致和不可达状态；长期调度模型与优先级策略由后续变更决定。
