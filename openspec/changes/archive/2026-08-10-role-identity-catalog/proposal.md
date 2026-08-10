## Why

27个持久化 creep role 目前同时手写在 `RoleName` 联合类型与 `memoryCleanup.VALID_ROLES`，而后者没有穷尽检查；历史上 `75e74c2` 与 `3555df7` 已两次因漏项而在17-tick清理中删除合法专用配置。先建立无运行时依赖的纯身份目录，可以消除最危险的双重来源，同时不把角色行为、身体或参数协议耦合进一个巨型 Catalog。

## What Changes

- 新增纯 `roleCatalog`，唯一列出 canonical role 及 `active/legacy` 生命周期状态，并由其键派生 `RoleName`。
- 从原 `@/types/system` 路径继续 re-export `RoleName`，保持所有现有 import ABI 与持久化字符串不变。
- 提供运行时 `isRoleName(value)`，让 MemoryCleanup 删除独立 `VALID_ROLES` 并使用同一身份来源判断 malformed/unknown-role config。
- 保留 `roleRegistry` 与 `spawnProfiles` 为职责独立的穷尽实现表；新增架构门禁验证三者 key 集合精确一致，Catalog 不依赖 roles/runtime/Game/Memory。
- 不类型化 `args`，不修改 configName、body、priority、prespawn、role factory、main phase 或17-tick清理调度。

## Capabilities

### New Capabilities

- `role-identity-catalog`: 规定 canonical role 身份、legacy 兼容、运行时识别、原 import ABI 以及 registry/profile/GC 的一致性边界。

### Modified Capabilities

无。

## Impact

- 新增：`src/types/roleCatalog.ts` 及 Catalog/架构测试。
- 修改：`src/types/system.ts` 从 Catalog 派生并 re-export `RoleName`；`src/runtime/memoryCleanup.ts` 使用 `isRoleName` 替代本地白名单。
- 验证但不迁移：`src/roles/index.ts`、`src/config/spawnProfiles.ts`、`mountSpawn`、`mountCreep`、SpawnPlanner 与现有配置生产者。
- Memory wire、27个 role 字符串、`CreepConfig`/`CreepMemory` shape、`hubUpgrader` legacy 兼容与运行时行为保持不变；无需数据迁移。
