## Context

通用 carrier 的 1:1 身体生成目前在常规 spawn profile、应急 `maxcarrier` 和 HAUL 旗帜搬运中分别实现，并都硬编码为最多 16 组，因此三条路径都会停在 800 容量。link miner 则由 `REGEN_SOURCE` 等级决定 WORK 数，但固定只有 6 个 CARRY，并按约 4 个非 MOVE 部件配置 1 个 MOVE。

本次调整必须遵守 Screeps 的 50 部件硬上限和房间能量预算，同时不能破坏现有 miner 先生成替代者、到达工位后再退役旧单位的交接流程。

## Goals / Non-Goals

**Goals:**

- 让所有通用 1:1 carrier 生成入口采用最高 1000 容量的同一策略。
- 让 link miner 固定拥有 400 携带容量，并按非 MOVE:MOVE 为 2:1 配速。
- 保留 carrier 的按能量缩放和 miner 的动态 WORK、去重排队与安全交接行为。
- 用边界测试锁定容量、比例、成本和关键入口的一致性。

**Non-Goals:**

- 不调整 `remoteMiningCarrier`、`powerBankHauler` 或其他具有专用身体策略的角色。
- 不改变 carrier 数量、任务优先级、寻路策略或任务板协议。
- 不为现役 carrier 增加立即淘汰逻辑；它们在原有换代窗口自然使用新体型。
- 本变更不包含部署或线上手工生成 creep。

## Decisions

### 共用通用 carrier 身体策略

新增单一 carrier 身体策略函数，以能量预算生成重复的 `[CARRY, MOVE]` 组。最大组数由 `1000 / CARRY_CAPACITY = 20` 得到，因此最高身体为 20 CARRY + 20 MOVE、40 部件、2000 能量；能量不足时按完整组向下缩放，不得超出预算。

`spawnProfiles.carrier`、`spawnProfiles.remoteCarrier`、应急 `maxcarrier` 和 HAUL 旗帜配置都调用该函数。相比在三处把 16 改成 20，共用函数能让容量、顺序和能量边界保持一致，并防止后续再次漂移。

### miner 容量与移动比例

link miner 的 CARRY 数固定为 `400 / CARRY_CAPACITY = 8`。WORK 数继续使用已有 `REGEN_SOURCE` 吞吐公式；MOVE 数改为 `ceil((WORK + CARRY) / 2)`，使所有非 MOVE 部件与 MOVE 的比例不超过 2:1。

例如无技能时为 6 WORK + 8 CARRY + 7 MOVE；4 级 `REGEN_SOURCE` 时为 12 WORK + 8 CARRY + 10 MOVE。最高技能等级下身体仍低于 50 部件，因此无需截断 WORK 或牺牲容量。

### 换代边界

miner 的目标身体顺序变化会被现有精确体型比较识别。Spawn Planner 继续先排入唯一替代者；只有新 miner 到达 Source 范围或单入口交接位置后，旧 miner 才会退役。carrier 不增加精确体型比较，以避免一次部署同时提前淘汰所有房间物流单位。

## Risks / Trade-offs

- [carrier 身体更贵且孵化更久] → 按房间能量预算缩放，并沿用现有基于身体长度计算的预孵化时间。
- [miner MOVE 增加会提高成本和孵化时间] → link miner 仅在具备相应基础设施的房间使用，且最高等级身体仍满足能量和 50 部件边界；保留先补后退避免采集空窗。
- [多个 carrier 入口产生不同身体] → 所有通用 1:1 入口调用同一策略，并对 profile、应急与 HAUL 路径建立回归断言。
- [把专用搬运角色误纳入统一上限] → 明确排除 `remoteMiningCarrier` 与 `powerBankHauler`，保留其吞吐和战术设计。

## Migration Plan

1. 本地完成定向测试、TypeScript 检查、构建及 OpenSpec 严格校验。
2. 后续部署时，miner 通过现有体型不匹配交接机制逐个换代；carrier 在正常临期换代时采用新上限。
3. 若线上出现能量或孵化拥堵，回滚到部署前版本；已生成的较大 creep 可继续工作至自然死亡，无需写入兼容数据。

## Open Questions

无；容量、比例和覆盖入口均已由本次请求明确。
