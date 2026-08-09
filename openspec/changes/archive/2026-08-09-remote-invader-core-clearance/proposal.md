## Why

当前外矿状态机会把 Invader Core 归类为不可处理的敌对结构并长期暂停外矿，既不会生成清理单位，也无法在 Core 消失后及时恢复。shard1 的有效外矿 E6N57 已出现这一状态，因此需要把可安全处理的 Core 纳入现有外矿防御闭环。

## What Changes

- 仅在仍然有效的外矿任务目标房有视野时识别敌对 `STRUCTURE_INVADER_CORE`，不扫描或攻击任意非外矿房间。
- 对可由单只现有 `remoteDefender` 清理的低等级 Core 建立防御状态，并复用现有 creep config、spawn queue 与退役机制，避免引入独立作战体系或重复出生。
- 在 Core 尚处于无敌期、目标房失去视野、来源房进入 defense mode 或目标属于高等级危险 Stronghold 时保守等待/暂停，不盲目派兵，也不把无视野当作完成。
- Core 可见且消失、外矿任务取消、来源房失效或进入防御模式时，幂等清理 config 与队列；现存清理单位按现有回收路径安全退役。
- `remoteDefender` 只会为此任务攻击 Invader Core 与原有合法敌对 creep，绝不把玩家结构加入清理目标。

## Capabilities

### New Capabilities

- `remote-invader-core-clearance`: 定义有效外矿 Invader Core 的识别、单实例清理、视野门控、安全降级和生命周期清理契约。

### Modified Capabilities

无。

## Impact

- 主要影响 `src/runtime/remoteMining.ts` 的威胁分类与外矿防御状态机，以及 `src/roles/remoteDefender.ts` 的目标选择。
- 复用现有 `remoteDefender` body profile、creep config service、spawn planner、scout 与队列清理能力；不新增依赖或控制台接口。
- 增补 `remoteMining` 与 `remoteDefender` 定向测试，并通过 TypeScript、构建和 OpenSpec 严格校验。
