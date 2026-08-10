## Why

Worker 与 Carrier 的派工身份目前都在写路径丢失了 canonical scope：Worker assignment 只保存裸 `taskId` 并在释放时扫描所有房间，Carrier board 与 assignment 只按 `room + taskId` 定位，导致不同 producer 的同名任务会静默覆盖或让既有 carrier 误绑定。统一任务基础层已经建立完整 `WorkRef` 和只读 projection，本切片需要把本地派工的写 ownership 收敛到同一身份边界，同时保留 Worker slot 与 Carrier 同 tick 数量切片的不同生命周期。

## What Changes

- 新增独立于只读 TaskSystem adapter 的 Local Dispatch Ownership 层，只共享完整 room-scoped `WorkRef`、精确比较、expected-ref/CAS 语义和只读 binding DTO；不新增通用 TaskManager。
- Worker assignment 使用 `worker-work / workerTaskPool / room / localId` 完整引用，slot acquire/release 成为双向索引的唯一写入口，去除跨房间裸 ID 扫描；现有三 tick world projection、sticky assignment、评分、安全区、完成 predicate 和释放时机不变。
- Carrier board 改为 producer-owned room snapshot，真实存储身份包含 `room + producer namespace + localId`；assignment 使用完整 producer-scoped ref，同房不同 producer 的相同 localId 可以同时存在、分别刷新和分别绑定。
- Worker slot claim 与 Carrier `same_tick_amount` slice 分别提供类型化端口；Carrier 现有 tick/Game ledger、失败 release、intent `OK` 后 commit、accepted cargo snapshot 和 hard-lane priority 均保留。
- 将 Worker/Carrier 的生产读取切到无 ensure 的 read port，并让只读 adapters 基于同一完整 ref 证据投影；TaskSystem adapter 公共接口继续只有 `system + snapshot`。
- 保留现有领域 producer、role 入口和外部 replace/list/assign/release API 作为兼容 gateway；不新增 Memory schema、private/public global、main phase或 console API。
- 增加 identity、双向 slot、producer collision、sticky selection、reset/cleanup、accepted cargo、same-tick amount handle、架构依赖、CPU/扫描次数和真实 producer/consumer 的 characterization 与回归门禁。
- **显式身份修正**：Worker跨房同localId的lookup/release与派工房scope漂移必须精确隔离；过去被同房另一producer同localId静默覆盖的Carrier task必须同时存在。Carrier accepted-cargo、market protection与production commitment稳定键也必须携带完整ref，不能在下游再次按裸taskId合并。这些修正必须独立测试、记录rollout风险，并在`terminal-headroom-recovery`、`market-base-resource-all-rooms`、`market-direct-continuous`和`market-scope-core-read-cpu`的现有线上观察全部完成并冻结结论前禁止部署。
- 明确排除 `TransferContract`、`CapacityLease`、持久 `StageWorkClaim`、`RoomLogisticsAgent`、terminal/market 仲裁、Energy pickup reservation、destination capacity claim、统一 priority、通用 execute/complete/cleanup；这些仍由各自领域和 `decentralized-logistics-contracts` 拥有。

## Capabilities

### New Capabilities

- `local-dispatch-ownership`: 定义 Worker/Carrier 完整本地派工身份、owner-scoped board、精确 binding，以及分层的 Worker slot 与 Carrier same-tick amount ownership 端口。

### Modified Capabilities

- `unified-task-system-contract`: 允许独立 mutation port 使用 canonical WorkRef，同时保持 TaskSystem adapters 只读；把 Carrier 同 localId 场景从“报告底层碰撞”修改为“不同 producer 精确共存”。
- `task-status-projection`: Worker claim 以完整 ref 双向闭合，Carrier projection 读取 owner-scoped board，并对合法的跨 producer 同 localId 输出两条无碰撞记录。

## Impact

- 核心影响文件：`src/runtime/workerTaskPool.ts`、`src/runtime/carrierTaskBoard.ts`、`src/runtime/creepAssignmentState.ts`、`src/roles/worker.ts`、`src/roles/carrier.ts`、`src/runtime/taskSystem/adapters/{workerWork,carrierLogistics}.ts`，以及新的 `src/runtime/dispatchOwnership/`。
- 直接 consumer/producer：main、MemoryCleanup、room workforce、telemetry、Synthesis、Factory、ResourceControl、Boost、MineralExtraction、Nuker、PowerSpawn、PowerBankBoost、market protection与market continuous reader；`market-sale-automation`相关稳定贡献ID与全保护场景作为显式回归范围，但不在本change重复修改其被其它active change占用的主requirement。
- 必须保持关键主循环顺序、十二个 private global 槽位、Memory 写集合、Worker/Carrier priority 与 action 行为；本切片会进入生产 bundle，验证目标改为来源 allowlist 和 CPU/扫描预算，而不是继续要求 bundle hash 完全相等。
- `decentralized-logistics-contracts` 保持独立 active change；本切片不能创建其任何持久合同、lease、claim、恢复或执行 authority。
- 代码可以完成并提交，但线上部署必须等待`terminal-headroom-recovery`、`market-base-resource-all-rooms`、`market-direct-continuous`与`market-scope-core-read-cpu`的live/Shadow/CPU/保护账本归因窗口全部完成并冻结结论；“重置基线后尚在观察”不是通过条件。
