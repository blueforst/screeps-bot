## 基线快照

记录时间：2026-08-10，基线分支 `codex/architecture-optimization`，父提交 `45d471b`。

### 身份集合

- `src/types/system.ts` 的手写 `RoleName` 联合类型共有27项。
- `src/roles/index.ts` 的 `roleRegistry` 与 `src/config/spawnProfiles.ts` 的 own keys 均为同一27项，并分别以 `Record<RoleName, ...>` 获得编译期穷尽检查。
- `src/runtime/memoryCleanup.ts` 的独立 `VALID_ROLES` Set 当前也为同一27项，但没有从 `RoleName` 派生。
- `hubUpgrader` 是唯一 legacy 身份；它继续映射到 upgrader 行为与既有身体，只用于兼容遗留配置。其余26项均为 active。

精确 role 集合：

`harvester`、`mineralHarvester`、`miner`、`carrier`、`worker`、`upgrader`、`hubUpgrader`、`scout`、`claimer`、`colonizerHarvester`、`colonizerWorker`、`meleeAttacker`、`healer`、`homeDefender`、`crossShardClaimer`、`crossShardColonizerHarvester`、`crossShardColonizerWorker`、`flagScout`、`remoteCarrier`、`remoteMiningCarrier`、`powerBankScout`、`powerBankAttacker`、`powerBankHealer`、`powerBankHauler`、`remoteMiningReserver`、`remoteWorker`、`remoteDefender`。

### 已知历史风险

- `75e74c2`：向 `VALID_ROLES` 补回 `mineralHarvester`、`homeDefender`、`flagScout`，避免17-tick清理删除合法专用配置。
- `3555df7`：向 `VALID_ROLES` 补回 `remoteMiningCarrier`、`remoteMiningReserver`。
- `6fcf423`：修复 `powerBankScout` 的错误 factory 绑定；这证明 key 集合一致只能保证身份完整，不能替代行为绑定测试。

### 本切片保持不变的边界

- `CreepConfig.role`、`CreepMemory.role`、configName、`args: string[]`、body、priority、prespawn 与 Memory wire 不变。
- `roleRegistry`、`spawnProfiles` 的实现和值顺序不迁移；`mountCreep`、`mountSpawn`、SpawnPlanner 与 main phase 不改。
- MemoryCleanup 仍每17 tick执行，generic unknown-role cleanup、queue cleanup 与 managed ownership GC 的调用顺序不改。
