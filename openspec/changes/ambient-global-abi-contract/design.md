## Context

`src/global.d.ts` 是外部模块：它含有 `import type` 并以 `export {}` 结束。因此文件顶层的 `declare namespace NodeJS { interface Global ... }` 只是模块局部命名空间，并没有扩展全局 `NodeJS.Global`。当前 `@types/node` 又将 `global` 声明为 `typeof globalThis`，所以真正给 `global.foo` 提供类型的是 `declare global` 中的 ambient 变量；底部约 250 行镜像从未生效，且已经与真实安装面漂移。

生产源码当前写入 100 个 bot-owned `global` 属性。其中 88 个是玩家可调用的公共命令或规划入口，12 个是实现细节的 heap 状态。另有 4 个 Rollup 替换的构建常量只存在于编译环境，不是运行时赋值语句。公共安装面目前漏声明 `memoryAudit`、`memoryAuditRaw` 和 7 个市场操作命令，同时 `RP` 与 `spawnMaxCarrier` 的声明和真实实现不一致。

安装时序不是统一的：Autoplanner 入口在模块求值时安装，常规命令在 main/global reset 注册，市场操作命令在每次 preflight 注册。声明层必须表达这一区别，但本切片不能重排任何 runtime phase。

## Goals / Non-Goals

**Goals:**

- 让 `declare global` 成为公共 bot ABI 与构建常量的唯一可信声明入口。
- 使每个公共生产安装名都恰有一个 ambient 声明，并迫使新槽位显式分类。
- 让补充/修正的命令签名直接跟随真实导出，避免局部交叉类型继续掩盖漂移。
- 删除从未生效的 Node 镜像和模块局部 `_`，同时保持 TypeScript 与 Rollup 构建无诊断。
- 以 bundle 规范化字节等价证明本切片不改变运行时。

**Non-Goals:**

- 不把扁平命令迁到 `global.bot.*` 等命名空间，也不建立运行时 manifest。
- 不把私有 heap 状态公开为稳定 ABI，亦不迁移其缓存所有权。
- 不把生产访问从 `global` 改写为 `globalThis`。
- 不调整命令注册、preflight、mount 或 Autoplanner 的执行时序。
- 不处理只读调试槽 `__roomVisualCalls` 的 runtime 生命周期，也不修订 Memory schema。

## Decisions

### 1. 以真实写入面而不是历史镜像定义 ABI

架构测试扫描生产可达的 TypeScript 与 `src` 下 legacy JavaScript。公共安装只承认对非空静态 `global.foo`、`global["foo"]` 或声明时由前一稳定根初始化的 `const` alias 链执行简单 `=` 赋值，且赋值右侧不得是 `undefined`、`null` 或 `void`；`as`、non-null 与 `satisfies` 等透明包装不改变判定。条件/复合赋值、更新运算、删除、解构写入与 `for-in/of` 写入均不构成安装。公共槽位出现这些 mutation 时直接失败，即使同名简单赋值同时存在也不能抵消末态风险；只有精确私有槽位白名单可使用其既有生命周期 mutation。扫描结果减去精确的 12 个私有槽位后，必须与 `declare global` 中的变量集合（再排除 4 个构建常量）完全相等。

`global` alias 只用于可静态追踪的直接属性安装，不得通过默认参数、后置赋值、参数、返回值、`bind`、`valueOf()`、解构或重赋值逃逸；`Object`/`Reflect` 间接 mutation、动态或空属性也不受支持。`globalThis` 及其 alias 的任何非类型位置使用同样失败。无法证明为静态、无条件安装的协议一律 fail-closed，要求先单独定义可审计合同。

私有槽位固定为：

- `__runtimeServices`
- `__cpuMonitor`
- `__productionSamples`
- `__creepMovementState`
- `__movementAnalytics`
- `__carrierTaskBoard`
- `__carrierTaskClaims`
- `__creepAssignmentState`
- `__pickupReservations`
- `__workerTaskBoard`
- `colours`
- `roomPlanCache`

构建常量固定为 `__BUILD_VERSION__`、`__BUILD_GIT_HASH__`、`__BUILD_TIME__`、`__BUILD_TAG__`。采用精确集合而非名称前缀启发式：新增公共命令漏声明会失败，新增私有 cache 也必须在评审中明确分类。

未采用手写 88 项公共清单作为第二真源；它容易与实现和声明同时漂移。测试以生产赋值作为事实源，以小而稳定的“私有/构建例外集合”明确边界。

### 2. 只删除死声明，不激活 `NodeJS.Global`

删除文件顶层 `declare namespace NodeJS { interface Global ... }`、`LoDashStatic` import 和模块局部 `declare const _`。不得把该接口移动到 `declare global`，否则会让一份历史漂移的声明突然生效。平台提供的 `Game`、`Memory` 与 `_` 仍由 Screeps/Node/Lodash 环境类型负责，本项目只声明自己安装的属性。

### 3. 新增命令从实现导出派生类型

`memoryAudit` 与 `memoryAuditRaw` 在常规命令注册阶段必装，使用非可选的 `typeof import("@/runtime/consoleCommands").<name>`。7 个市场命令仅在 preflight 执行后安装，使用 `typeof import("@/runtime/marketSaleAutomation").<name> | undefined`，与已有市场控制入口的冷 heap 语义一致。

这样声明不复制 `OperatorResult`，也不需要把模块内局部类型提升为新的公共类型。导入是纯类型查询，不生成运行时依赖；build/workspace TypeScript Program 必须同时验证无循环诊断。

### 4. 对历史手写签名做最小纠正

- `RP(room, showPlan?)` 接受可选布尔预览参数，返回结构布局或 `false`；不把失败改写成 `undefined`。
- `spawnMaxCarrier(roomName)` 是格式化控制台命令，只返回字符串。
- `spawnMaxCarrierRaw(roomName)` 保留结构化成功对象或错误字符串。

其余公共签名不在本切片重写为 `typeof import`，避免把一次所有权清理扩大为全量 ABI 迁移。

### 5. 静态门禁覆盖 TS、legacy JS 与声明作用域

测试必须：

- 扫描 build Program 内全部生产 TypeScript；
- 额外扫描 `src/**/*.js`，因为 `allowJs=false` 时 Autoplanner JS 不在 TypeScript Program，却仍进入 Rollup 图；
- 要求 build Program 内全部生产 TypeScript（含声明文件）均为 external module，避免 script 顶层值静默扩展全局；
- 只读取真正 `declare global` 内的 ambient `var`/`const`，并拒绝其中的 function/class/enum/namespace/import-equals、script 顶层值与 `export as namespace`；纯 interface/type 仍可存在；
- 禁止生产声明在 `NodeJS` 直接成员或 dotted namespace 重新引入 `NodeJS.Global` 镜像，但不得误报 `NodeJS.Nested.Global` 或名为 `Global` 的普通属性；同时禁止模块局部 `_`；
- 用编译契约验证新增导出类型、市场可选性、`RP` 和 carrier 两个入口。

测试只分析可证明的静态、无条件安装；动态计算属性、间接 value escape 或其他未支持写入协议不属于允许的安装方式，未来出现时门禁应失败并要求先建立可审计协议。

## Risks / Trade-offs

- [AST 扫描器漏掉 alias、末态 mutation 或 legacy JS] → 同时覆盖直接属性、字符串属性、稳定 alias、条件/复合/删除/更新/解构写入、value escape 与声明作用域 mutation fixture；JS 独立遍历 `src`。
- [把私有 cache 误当公共 API] → 私有集合使用显式名称白名单，新名字必须经架构评审，不使用 `__` 前缀自动豁免。
- [`typeof import` 引入类型循环] → 在 build 与 workspace 两个 Program 中执行零诊断门禁；类型查询不产生 bundle 模块。
- [市场命令在 cold heap 被过度承诺] → 保留 `| undefined`，不改变注册时序。
- [纯声明改动仍意外影响产物] → 构建后规范化动态 `BUILD_TAG`，要求 bundle 与基线摘要完全一致且 source map 不含声明/测试模块。

## Migration Plan

1. 先提交 RED 架构测试，证明死镜像、9 个缺失声明和 2 个错误签名均可被观察。
2. 机械删除死声明，补齐派生类型并修正两处签名。
3. 运行 build/workspace typecheck、聚焦与全量 Jest、OpenSpec strict 和 Rollup 字节等价校验。
4. 本切片无需 Screeps 部署；若需回滚，单提交恢复 `src/global.d.ts` 与对应架构测试即可，无 Memory 或 runtime 状态迁移。

## Open Questions

无。本切片不决定未来是否迁移到命名空间或 manifest；该决策须在运行时安装所有权统一后另立变更。
