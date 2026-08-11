## Why

War 工作流目前把 owner 记录、生产配置、Spawn 队列/在制项、存活成员与 Boost 授权分开维护，却没有一条领域级终态事务把它们收敛。结果是终态任务可能再次出兵、one-shot 编队损失后永久停在非终态、Colonization/GC/控制台可以绕过释放逻辑直接删 owner，且 standard 编队的第二个攻击者会等待不存在的同索引治疗者；这些歧义必须先由 War 领域解决，后续才能安全抽象跨工作流资产所有权。

## What Changes

- 为 War 建立显式的 owner identity 与领域生命周期合同，区分“停止生产”“释放 Boost”“成员退役”和“删除 owner”，并要求终态/取消路径幂等收敛。
- 将 `done`、`failed`、人工停止、Colonization 交接和 GC 清理统一接入 owner-scoped release；禁止在仍有 owner 资产时直接删除 `Memory.data.war` 记录。
- 为 one-shot generation 耗尽建立明确的 terminal transition 与机器可读失败原因，避免 deployed generation 每 tick空转。
- 将 standard/t3Duo 的成员配对写成显式配置事实；未配对的 standard 第二攻击者不得等待一个不存在的 healer。
- 更新 War 只读 projection：仅在来源仍存在真实歧义时报告 issue，已由领域合同闭合的状态不再保留旧 ambiguity 标记。
- 保持 main phase 顺序、War console 命令入口、现有 configName 形式、Spawn queue wire、Boost/role 领域边界和存活成员默认不自杀策略不变。

## Capabilities

### New Capabilities

- `war-workflow-lifecycle-ownership`: 定义 War owner、生产/Boost/成员资产、显式配对、终态转换、取消与 GC/Colonization 交接的领域合同。

### Modified Capabilities

- `unified-task-system-contract`: 澄清只读 foundation 不得替 War 推断生命周期，但可在 War 来源合同已闭合后移除对应历史 ambiguity issue；生产行为变化仍只由 War 领域 capability 授权。

## Impact

- 主要代码：`src/runtime/warControl.ts`、`src/roles/meleeAttacker.ts`、`src/roles/healer.ts`、`src/movement/traffic.ts`、`src/runtime/colonization.ts`、`src/runtime/memoryCleanup.ts`、`src/runtime/console/operationsCommands.ts`、`src/runtime/taskSystem/adapters/warWorkflow.ts` 与 War Memory 类型。
- 类型与测试：War Memory 类型、War/Colonization/MemoryCleanup/console/角色/projection 测试，以及防止 raw War owner 删除和隐式配对回归的架构门禁。
- 不新增通用 TaskManager，不把 TaskSystem adapter 接入生产决策，不提前实现 workflow-owned-assets 或 decentralized-logistics-contracts。
