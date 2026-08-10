# Ambient Global ABI Ownership 规格

## Purpose

定义 bot-owned `global` 公共控制台 ABI、私有 heap 状态与构建常量的单一声明所有权、可静态审计的安装协议，以及纯声明变更不影响运行时产物的边界。

## Requirements

### Requirement: 公共 global 安装与 ambient 声明一一对应

系统 MUST 将生产源码静态安装的每个公共 bot global 属性恰好声明在有效的 `declare global` 中，并且 MUST 不为未安装的 bot 公共属性保留 ambient 变量声明。生产 TypeScript 与进入 Rollup 的 legacy JavaScript MUST 同时纳入安装面核对。

#### Scenario: 当前公共安装面完整对应

- **WHEN** 架构门禁扫描生产 TypeScript、legacy JavaScript 与所有生效的生产声明
- **THEN** 实际公共安装名集合与 ambient bot 变量集合完全相等
- **AND** 每个名字在有效全局作用域中只有一个声明所有者

#### Scenario: 新公共命令漏声明

- **WHEN** 生产代码新增一个静态 `global` 属性安装但未增加对应 ambient 声明
- **THEN** 架构门禁失败并报告缺失名称

#### Scenario: 未安装的 ambient 命令

- **WHEN** 声明新增一个既非构建常量、也无生产安装的 bot ambient 变量
- **THEN** 架构门禁失败并报告多余名称

#### Scenario: 公共安装协议可静态证明

- **WHEN** 生产代码安装公共 bot global 属性
- **THEN** 安装必须使用静态属性名与无条件的简单 `=` 赋值，右侧不得是 `undefined`、`null` 或 `void`，并且只可经直接 `global` 或稳定 `const` alias 完成
- **AND** 条件/复合赋值、更新、删除、解构写入、`for-in/of` 写入、动态/空属性、`Object`/`Reflect` 间接 mutation、`valueOf()`、`globalThis` 使用或其他 global value escape 必须使架构门禁失败
- **AND** 同名简单赋值不得掩盖后续公共删除或 mutation
- **AND** 只有精确私有槽位白名单可保留其既有生命周期 mutation

### Requirement: 私有 heap 状态与构建常量显式分类

系统 MUST 将私有 heap 状态从公共 ABI 比对中排除，但该排除 MUST 使用精确名称集合而非前缀启发式。系统 MUST 将 4 个 Rollup 构建常量与生产 `global` 写入分开核对。

#### Scenario: 当前私有状态集合

- **WHEN** 扫描器遇到 `__runtimeServices`、`__cpuMonitor`、`__productionSamples`、`__creepMovementState`、`__movementAnalytics`、`__carrierTaskBoard`、`__carrierTaskClaims`、`__creepAssignmentState`、`__pickupReservations`、`__workerTaskBoard`、`colours` 或 `roomPlanCache`
- **THEN** 这些属性被归类为实现私有状态而不成为公共 ABI
- **AND** 其余生产写入不得因 `__` 前缀而自动豁免

#### Scenario: 当前构建常量集合

- **WHEN** 门禁读取 `__BUILD_VERSION__`、`__BUILD_GIT_HASH__`、`__BUILD_TIME__` 与 `__BUILD_TAG__`
- **THEN** 这些名称必须存在于有效 ambient 全局作用域
- **AND** 它们不要求生产源码出现 `global` 赋值

#### Scenario: 新 global 槽位未经分类

- **WHEN** 生产代码新增一个不在公共声明或精确私有集合中的 global 写入
- **THEN** 架构门禁失败，要求变更显式决定其所有权

### Requirement: 失效 Node 镜像不得作为声明入口

系统 MUST 仅使用有效的 `declare global` 扩展 bot-owned 全局 ABI，并 MUST 不在项目生产声明中保留或重新引入 `NodeJS.Global` 镜像。外部模块顶层的 Lodash `_` 声明 MUST 不作为 bot ABI 声明存在。

#### Scenario: 声明作用域审计

- **WHEN** 架构门禁遍历生产声明文件
- **THEN** `NodeJS` namespace 不得直接声明名为 `Global` 的成员，也不得声明 dotted `NodeJS.Global`
- **AND** `NodeJS.Nested.Global` 或普通成员属性名 `Global` 不得被误报为镜像
- **AND** `src/global.d.ts` 不导入 `LoDashStatic`，也不存在模块局部 `_` 变量声明

#### Scenario: 唯一有效的 bot ambient value 入口

- **WHEN** 架构门禁遍历 build Program 的生产 TypeScript 与声明作用域
- **THEN** 所有生产 TypeScript 都是 external module
- **AND** bot ambient value 只可由 `declare global` 中的变量声明提供
- **AND** script 顶层值、`declare global` 内的 function/class/enum/namespace/import-equals 与 `export as namespace` 必须使门禁失败
- **AND** 纯 interface/type 声明仍可保留

#### Scenario: 平台全局保持原来源

- **WHEN** build 与 workspace TypeScript Program 解析 `global`、`Game`、`Memory` 与 Lodash `_`
- **THEN** 它们继续由现有平台依赖声明提供
- **AND** 项目不得为了本变更改写运行时 `global` 访问方式

### Requirement: 控制台命令签名反映真实导出与安装时序

系统 MUST 为 `memoryAudit`、`memoryAuditRaw`、`grantMarketSaleMutationLease`、`revokeMarketSaleMutationLease`、`attestMarketSalePendingCreate`、`resolveMarketSalePendingCreateAbsence`、`expandMarketSaleCanary`、`emergencyStopMarketSaleAutomation` 与 `marketSaleAutomationStatus` 提供由真实导出派生的 ambient 类型。常规命令 MUST 在类型上必需；全部 16 个仅于 preflight 注册的市场命令 MUST 允许 cold heap 的 `undefined`，条件 mount 标记 `__screepsMounted` 也 MUST 允许未安装状态。

#### Scenario: Memory 审计命令类型

- **WHEN** TypeScript 使用 `global.memoryAudit` 或 `global.memoryAuditRaw`
- **THEN** 其函数类型与 `@/runtime/consoleCommands` 对应导出双向兼容
- **AND** 调用方不需要处理 `undefined`

#### Scenario: 市场操作命令冷 heap

- **WHEN** TypeScript 在市场 preflight 尚未运行的 heap 上读取新增的 7 个市场操作命令
- **THEN** 每个属性类型包含 `undefined`
- **AND** 其非空函数类型与 `@/runtime/marketSaleAutomation` 对应导出双向兼容

#### Scenario: 条件 mount 标记

- **WHEN** Screeps 构造器尚不可用或 prototype 尚未完成挂载
- **THEN** `global.__screepsMounted` 的类型允许 `undefined`

#### Scenario: RP 真实调用合同

- **WHEN** 调用 `global.RP(room, true)` 或省略第二参数
- **THEN** TypeScript 接受调用
- **AND** 返回类型为结构布局或 `false`，不得声明为 `undefined`

#### Scenario: Carrier 命令与 Raw 命令分层

- **WHEN** 调用 `global.spawnMaxCarrier(roomName)`
- **THEN** 返回类型为字符串
- **AND** `global.spawnMaxCarrierRaw(roomName)` 仍返回结构化成功对象或错误字符串

### Requirement: 声明切片不改变运行时产物

本变更 MUST 不修改 runtime 安装语句、安装顺序、Memory 数据或控制台命令名称。Rollup 产物移除动态构建标签后 MUST 与变更基线逐字节等价，source map MUST 不包含声明或架构测试模块。

#### Scenario: 构建等价验证

- **WHEN** 使用相同源码基线分别在变更前后执行 Rollup 构建，并规范化动态构建标签
- **THEN** bundle 摘要完全一致
- **AND** source map 的运行时模块集合不增加声明文件或测试文件

#### Scenario: 双 TypeScript 边界验证

- **WHEN** 分别运行 build 与 workspace TypeScript Program
- **THEN** 两者均无诊断
- **AND** 新增的类型查询不生成运行时依赖
