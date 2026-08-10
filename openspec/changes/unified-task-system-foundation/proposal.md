## Why

项目中名为 task、queue、plan、assignment、contract 的模型已分散到 Worker、Carrier、PowerCreep、跨房物流、Factory、远程采矿、殖民、救援、战争、PowerBank 与 Spawn 等路径；它们缺少统一身份、所有权和只读观测边界，但实际又分别属于可重建派工视图、持久命令、领域工作流或生产意图。继续按“都叫 Task”直接合并，会破坏各自的持久化、完成、重试、claim、优先级和清理语义，因此需要先建立一个明确区分能力而非抹平差异的统一基础层。

## What Changes

- 建立 canonical Task System Catalog，登记现有可执行工作模型及其模型类别、持久性、scope、reconcile 方式、authority/claim 能力和领域 owner。
- 引入统一的 `WorkRef`、authority、activity projection 与只读 adapter 协议；统一层只描述身份和状态投影，不成为第二状态源。
- 为 Worker、Carrier、PowerCreep、ResourceTransfer、Factory、RemoteMining、Colonization、Rescue、FlagHauling、CrossShardColonization、War、PowerBank 和 Spawn Production 提供兼容 adapter，使调用方可以通过同一入口读取状态而无需理解各自底层路径。
- 明确把 Synthesis/Hub plan、资源 reservation、容量 ledger、action claim 和市场事务排除在通用 Task store 之外；它们只可作为 task 的计划、授权或执行依赖被引用。
- 增加架构和 characterization 门禁，冻结现有 main phase、Memory wire、global ABI、优先级、领域状态机、生产/完成/清理行为，并阻止统一 projection 被反向用作调度事实。
- 本切片不提供通用 `execute/cancel/complete/delete`，不迁移现有 store，也不新增全局 TaskManager；后续 Worker/Carrier dispatch、workflow owner cleanup 与 logistics contract 迁移必须分别通过领域 adapter 演进。

## Capabilities

### New Capabilities

- `unified-task-system-contract`: 定义 canonical 工作系统分类、统一身份/authority/能力元数据、adapter 边界及不得强行统一的领域语义。
- `task-status-projection`: 定义无副作用的统一状态投影、完整性/稳定性要求和只读聚合接口。

### Modified Capabilities

无。本切片不改变现有任务、工作流、生产意图、主循环、Memory 或 console 的行为契约。

## Impact

- 新增 `src/runtime/taskSystem/` 下的纯契约、Catalog、投影聚合与领域 adapter。
- 只读接入 `src/runtime/workerTaskPool.ts`、`carrierTaskBoard.ts`、`powerCreepControl.ts`、`logistics/resourceTransferTasks.ts`、`factoryControl.ts` 以及各持久 workflow store；必要时仅补无副作用 selector，不改变现有写入口。
- `CreepConfig`/`SpawnMemory.spawnList` 只通过 Spawn Production adapter 投影，不改成 Task record。
- `decentralized-logistics-contracts` 继续独占 `TransferContract`、`CapacityLease`、`RoomLogisticsAgent` 和持久 `StageWorkClaim` 的领域设计；本变更不复制其 lease、matcher 或执行器。
- 影响测试包括统一 Catalog/adapter 架构门禁、各来源的只读 projection fixture、malformed/reset 兼容和现有 Worker/Carrier/Spawn/Memory/tick-phase 回归。
