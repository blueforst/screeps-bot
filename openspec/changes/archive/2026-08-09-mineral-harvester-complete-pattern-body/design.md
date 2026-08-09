## Context

`spawnProfiles.mineralHarvester` 复用 `twoToOneWorkMoveBody`。该函数当前只按能量计算组合数，先生成所有 `WORK + WORK + MOVE`，再交给 `clampByCapacity` 逐部件截断。能量足够 17 组时会生成 51 部件，裁剪器保留前 50 个部件，形成 16 个完整组合外加两个 WORK。

自动 bootstrap 创建的 mineralHarvester 配置不写显式 `body`，spawn planner 和 Spawn mount 都会读取该 profile。因此根因位于身体生成器，不需要修改配置、队列或 role。

## Goals / Non-Goals

**Goals:**

- 同时按能量预算和 50 部件上限计算可容纳的完整组合数。
- 高能量房间固定生成 16 组、48 部件、`32 WORK + 16 MOVE`。
- 保证预算跨过临界点时只增加完整组合，不追加残缺 WORK。

**Non-Goals:**

- 不修改 mineralHarvester 的采集行为、换代时机或数量。
- 不重写通用裁剪器，也不改变显式配置了 `body` 的手工 creep config。
- 不尝试用剩余两个部件槽位组成其他比例的混合身体。

## Decisions

### 1. 在组合数量层同时应用能量和部件上限

组合数取 `min(floor(energyCapacityAvailable / 250), floor(50 / 3))`，并保留现有至少一组的正常房间兜底。这样传给裁剪器的序列最多 48 部件且成本不超过预算，裁剪器不会再切开组合。

相比先生成再按三部件切片，该计算直接表达两个独立预算；相比改造通用 `clampByCapacity`，它不会改变其他 role 允许逐部件裁剪的既有行为。

### 2. 50 部件上限下保留两个空槽

16 个完整组合已经占用 48 部件。剩余两个槽位不足以容纳下一组，因此不使用；目标身体为 `32 WORK + 16 MOVE`，成本 4000。

相比追加两个 WORK，该身体维持每两个非 MOVE 部件一个 MOVE，避免增加疲劳却没有对应移动能力。

### 3. 不修改自动 spawn config

bootstrap 继续创建无显式 body 的 `mineralHarvester` 配置，Spawn mount 与 spawn planner 继续从同一个 profile 解析目标身体。这样队列估算和实际 spawn 使用完全相同的 48 部件结果。

## Risks / Trade-offs

- [高能量房间少两个 WORK] → 这是移除残缺组合的预期结果；完整 2:1 移动比例优先于名义 WORK 数。
- [留下两个未使用部件槽] → 不存在满足既定三部件组合的合法填充，测试固定该行为以防再次追求 50 部件。
- [显式 body 配置不受影响] → 手工配置本来就具有覆盖优先级，本变更只修复自动管理 profile。

## Migration Plan

无需 Memory 迁移。部署后新出生或自然替换的自动 mineralHarvester 使用 48 部件身体；回滚代码即可恢复旧 profile。

## Open Questions

无。
