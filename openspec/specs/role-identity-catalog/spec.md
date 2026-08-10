# Role Identity Catalog 规格

## Purpose

定义持久化 creep role 身份、active/legacy 生命周期、运行时类型证明与兼容导出边界，防止类型、行为表、身体表和 MemoryCleanup 的角色集合再次漂移并误删合法配置。

## Requirements

### Requirement: Catalog 是 canonical role 身份唯一来源
系统 MUST 在无运行时依赖的 Role Catalog 中精确声明27个 canonical role：`harvester`、`mineralHarvester`、`miner`、`carrier`、`worker`、`upgrader`、`hubUpgrader`、`scout`、`claimer`、`colonizerHarvester`、`colonizerWorker`、`meleeAttacker`、`healer`、`homeDefender`、`crossShardClaimer`、`crossShardColonizerHarvester`、`crossShardColonizerWorker`、`flagScout`、`remoteCarrier`、`remoteMiningCarrier`、`powerBankScout`、`powerBankAttacker`、`powerBankHealer`、`powerBankHauler`、`remoteMiningReserver`、`remoteWorker`、`remoteDefender`。`RoleName` MUST 由 Catalog own keys 派生，不得另行手写联合类型。

#### Scenario: 枚举 canonical role
- **WHEN** 调用方读取 Catalog own keys
- **THEN** 集合与上述27项精确相等、无重复、无缺失且无额外 role

### Requirement: active 与 legacy 生命周期兼容
Catalog MUST 将 `hubUpgrader` 标记为 `legacy`，其余26个 role 标记为 `active`。legacy role MUST 仍属于合法 `RoleName` 与运行时 `isRoleName`，其生产/退休策略不得由 generic Catalog 自动决定。

#### Scenario: 识别 hubUpgrader
- **WHEN** 调用方检查 `hubUpgrader` 的身份与生命周期
- **THEN** 它是合法 RoleName、`isRoleName` 返回 true，状态为 legacy，现有 HubUpgrade 领域继续决定其迁移与清理

### Requirement: 运行时 role proof 必须 fail closed
`isRoleName(value)` MUST 以 TypeScript type predicate `value is RoleName` 提供，并只接受 Catalog 的 own string keys。未知字符串、非字符串以及对象原型属性名 MUST 返回 false。

#### Scenario: 识别合法 active role
- **WHEN** 输入 Catalog 中任一 active role 字符串
- **THEN** `isRoleName` 返回 true

#### Scenario: 收窄未知输入
- **WHEN** TypeScript 调用方用 `isRoleName(value)` 检查 `unknown` 输入
- **THEN** true 分支中的 `value` 被收窄为 `RoleName`

#### Scenario: 拒绝未知或原型 role
- **WHEN** 输入未知字符串、`constructor`、`toString`、`__proto__`、null、undefined、number 或 object
- **THEN** `isRoleName` 返回 false且不抛异常

### Requirement: 原 RoleName import ABI 保持兼容
`@/types/system` MUST 继续导出由 Catalog 派生的 `RoleName`；`CreepConfig`、`CreepApi` 与现有调用者无需迁移 import 路径。role 字符串、args、Memory shape 和 configName MUST NOT 因目录引入而改变。

#### Scenario: 现有模块导入 RoleName
- **WHEN** mount、runtime、global declaration 或测试继续从 `@/types/system` type-import `RoleName`
- **THEN** build/test typecheck 通过且类型精确等于 Catalog keys

### Requirement: Registry、Profile 与 GC 共享身份集合
`roleRegistry` 与 `spawnProfiles` MUST 继续分别覆盖全部 Catalog role 且不得包含额外 key。MemoryCleanup MUST 使用 `isRoleName` 判断配置 role，不得维护独立合法角色白名单；它 MUST 保留 Catalog active/legacy role，并继续删除未知 role。

#### Scenario: 三个角色表保持一致
- **WHEN** 架构门禁比较 Catalog、roleRegistry 与 spawnProfiles 的 own keys
- **THEN** 三个排序后集合精确相等

#### Scenario: 清理合法配置
- **WHEN** 17-tick清理遇到任一 Catalog role 的配置
- **THEN** generic unknown-role cleanup 不因 role 身份删除该配置

#### Scenario: 清理未知配置
- **WHEN** 17-tick清理遇到 role 不属于 Catalog 的配置
- **THEN** generic unknown-role cleanup 按现有行为删除该配置

### Requirement: Catalog 保持低层无依赖
Role Catalog MUST NOT 导入 role factory、spawn profile、runtime service 或其他生产模块，也不得读取 Game、Memory、global 或 Screeps runtime constant。Catalog 仅可承载 canonical role identity 与 active/legacy 状态。

#### Scenario: 静态检查 Catalog 依赖
- **WHEN** 架构门禁解析 Catalog 源文件
- **THEN** 不存在 import/require、Game/Memory/global/runtime/roles/spawnProfiles 引用或身份之外的策略字段
