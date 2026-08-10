## Context

角色字符串同时是 TypeScript 词汇、`CreepConfig.role`/`CreepMemory.role` 持久化 ABI、行为工厂 key、默认身体 key，以及17-tick MemoryCleanup 的合法性判据。当前27项集合虽然一致，但来源分散：`RoleName`、`roleRegistry`、`spawnProfiles` 与 `VALID_ROLES` 各自维护。

其中 registry/profile 使用 `Record<RoleName, ...>`，编译器能检查缺项；`VALID_ROLES` 只是无类型约束的运行时 Set。历史提交 `75e74c2` 曾补回 `mineralHarvester/homeDefender/flagScout`，`3555df7` 又补回 `remoteMiningCarrier/remoteMiningReserver`，证明新角色漏入 GC 白名单会删除合法配置。另一个历史问题 `6fcf423` 是 `powerBankScout` 绑定到错误实现，说明身份完整性与实现正确性必须分开治理。

强兼容约束：

- role 字符串与 `@/types/system` 的 `RoleName` 导出路径不可改变。
- `hubUpgrader` 虽不再生产，仍是清理旧配置所需的 legacy ABI。
- `CreepConfig.args` 是 `string[]` 且会复制到活体 memory；本切片不得重排或判别联合化。
- configName 中的片段不等于 runtime role，不能通过名称反推身份。
- Catalog 不得导入 role factory、spawn body、runtime service、Game 或 Memory，否则 MemoryCleanup 会发生层级反转。

## Goals / Non-Goals

**Goals:**

- 建立唯一的 canonical role 身份与 active/legacy 生命周期状态来源。
- 从 Catalog key 派生 `RoleName`，并由同一来源提供运行时 `isRoleName`。
- 删除 MemoryCleanup 的独立白名单，阻止未来合法 role 因漏同步被 GC。
- 保持 registry 与 spawn profile 的职责分离，同时用架构门禁锁定 key 集合一致。

**Non-Goals:**

- 不设计 `RoleArgsMap`、role-aware config builder 或判别联合 `CreepConfig`。
- 不把 factory、body、priority、prespawn、outbound/defense 分类塞入 Catalog。
- 不修正或重排 SpawnPlanner 特殊角色策略。
- 不从 configName 推断 role，不统一所有配置 writer。
- 不移除/改名 `hubUpgrader`，不修改 main phase 或 cleanup interval。

## Decisions

### 1. Catalog 只保存身份与生命周期状态

新增 `src/types/roleCatalog.ts`：

```ts
export const ROLE_CATALOG = Object.freeze({
  harvester: "active",
  // ...
  hubUpgrader: "legacy",
} as const);

export type RoleName = keyof typeof ROLE_CATALOG;
```

其余26项为 `active`。字符串值比嵌套 metadata 对象更小，也避免调用方把 Catalog 当作新的策略中心。`Object.freeze` 防止 cold heap 后被 console/模块意外改写顶层身份表。

备选方案是一个字符串 tuple。拒绝该方案，因为 legacy 状态仍需第二张表；map 可以同时表达身份与最小生命周期元数据。

### 2. 运行时判定使用 own-property proof

`isRoleName(value)` 先要求 string，再用 `Object.prototype.hasOwnProperty.call(ROLE_CATALOG, value)`。它不得使用 `value in ROLE_CATALOG`，否则 `constructor/toString/__proto__` 等原型名可能被误判合法。

MemoryCleanup 直接调用该 helper。未知或 malformed role 仍按原行为删除；Catalog 中 active/legacy role 均保留。清理顺序、配置引用、队列和 managed ownership GC 均不变。

### 3. 保持 `@/types/system` 作为兼容出口

`system.ts` 以 type-only import 使用 Catalog 的 `RoleName`，并从原模块 re-export。所有现有调用者继续从 `@/types/system` 导入，不需要全仓机械改路径；Catalog 本身不反向依赖 system，因此无循环。

### 4. Registry 与 profile 保持独立实现表

`roleRegistry` 决定行为工厂，`spawnProfiles` 决定默认身体，它们不是同一职责。两者继续用 `Record<RoleName, ...>` 获得编译期穷尽检查；Catalog 不导入它们。

架构测试在运行时比较 Catalog/registry/profiles 的 sorted own keys，并静态检查 Catalog 无 import、无 Game/Memory/global/runtime/roles 引用。绑定到哪个具体 factory/body 仍由现有行为测试负责，不能由 key 集合测试替代。

### 5. legacy 是合法身份，不等于可继续生产

`hubUpgrader` 标记 `legacy`，`isRoleName("hubUpgrader")` 仍返回 true。这样旧配置不会被 generic unknown-role cleanup 误删；是否创建/迁移/退休该角色继续由 HubUpgrade 领域控制。本切片不把 lifecycle status 接入 SpawnPlanner 或 producer。

## Risks / Trade-offs

- [Risk] system re-export 造成 type cycle。→ Catalog 无 import，system 只 type-import/re-export；用 build/test双typecheck与依赖审查验证。
- [Risk] Catalog 变成策略垃圾桶。→ 架构规格只允许 identity/lifecycle；priority/body/args 分类明确为非目标。
- [Risk] key一致门禁只能证明完整性，不能证明正确绑定。→ 保留 factory/body行为测试，并记录 `6fcf423` 为不同问题域。
- [Risk] prototype key 被运行时 guard 接受。→ 使用 `hasOwnProperty.call`，用 `constructor/toString/__proto__` 负例锁定。
- [Risk] legacy status 被误用于自动生产。→ 本切片没有 lifecycle consumer；仅 GC 使用 `isRoleName`，HubUpgrade 行为不变。
- [Trade-off] SpawnPlanner 中角色策略仍是并行维护。→ 先消除有历史数据损失证据的 GC 双重来源；策略分类另立 OpenSpec。

## Migration Plan

1. 记录27项基线与历史回归，先增加 Catalog/架构/GC RED 门禁。
2. 新增 Catalog，从其 key 派生/re-export `RoleName`，迁移 MemoryCleanup。
3. 运行 Catalog、MemoryCleanup、mountCreep/mountSpawn、spawnProfiles、SpawnPlanner 定向测试、双typecheck、全量 Jest 与 Rollup build。
4. 部署后只读确认 deploy tag、合法配置角色集合与17-tick GC前后无合法配置损失；不写 Memory。
5. 回滚只需恢复代码提交；role 字符串与 Memory schema未变化，不需数据迁移。

## Open Questions

无。RoleArgs 与 SpawnPlanner policy catalog 均后置为独立变更。
