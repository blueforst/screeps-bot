## Context

当前 `tsconfig.json` 同时被默认 `tsc`、ts-jest 和 Rollup 使用。基线解析得到 306 个仓库 root files：`src` 298 个、`test` 8 个，其中 128 个为测试文件；Rollup 的 TypeScript 插件会遍历配置解析出的全部文件，因此生产 build 也在检查测试。Jest 则独立发现 129 个 suite，其中唯一的 `scripts/monitor-service.test.ts` 不在当前 TypeScript include 内。

基线 `tsc --noEmit` 共装载 493 个 compiler inputs，三次中位 total 约 2.75 秒、TypeScript 内存约 584 MiB；Rollup 三次中位 wall time 约 2.83 秒、峰值 RSS 约 1.09 GiB。这些数值只用于同机方向性比较，不作为硬 SLA。

## Goals / Non-Goals

**Goals:**

- 让 Rollup 的 TypeScript root set 只包含生产 `src` 文件，不包含任何测试或 `scripts` 文件。
- 让默认 `npx tsc --noEmit` 继续覆盖生产与测试代码，并补上 monitor 脚本测试。
- 让生产构建不获得 Jest ambient globals，同时保留 Screeps、Node 与 Lodash 类型。
- 保持现有 alias、target、module 处理、source map、dist 输出、Jest 转译与 test discovery 行为。

**Non-Goals:**

- 不启用 `strict`、`isolatedModules`、`composite`、`incremental`、`NodeNext` 或其他新编译规则。
- 不拆分 `global.d.ts`，不重构 test harness，不为 `.mjs` monitor 本体新增静态检查。
- 不修改生产 TypeScript/JavaScript、Memory schema、main tick 顺序、部署版本或线上配置。
- 不新增 `tsconfig.base.json`、`tsconfig.test.json` 或独立 scripts leaf；未来出现非测试 TypeScript CLI 时再单独评估。

## Decisions

### 1. 根配置继续代表完整 workspace，build 配置只覆盖边界

保留 `tsconfig.json` 作为编辑器、默认 typecheck 与 ts-jest 自动发现的配置，只在 include 中加入 `scripts/**/*.test.ts`。新增 `tsconfig.build.json` 继承根配置，并显式覆盖 `types`、`include` 与 `exclude`。

相比立即引入 base/build/test/root 四层结构，这个切片无需修改 Jest raw path mapper 或 ts-jest 的配置查找，减少配置解析语义变化。`extends` 不合并 `types/include/exclude`，因此 build leaf 必须完整列出三者，不能依赖父配置的测试集合。

### 2. 生产 ambient types 保留 Node，只移除 Jest

build 配置使用 `types=[screeps,node,lodash]`。生产代码仍使用 `global`、`require` 与 Node 兼容类型；实测移除 Node 会产生大量诊断。Jest ambient 仅服务测试，应从生产 build 的类型环境中移除。

不显式设置 `module`：Rollup TypeScript 插件当前会为 bundle 选择兼容的 ES module 形式；在配置中固定 CommonJS 会改变或破坏该路径。

### 3. 工具消费入口保持单一且显式

Rollup 只把 `tsconfig` 参数从根配置切换到 `tsconfig.build.json`。Jest config 与 ts-jest 保持现状，继续消费根 `tsconfig.json`；alias、setup 与 transform 不迁移。新增 `typecheck:test` 与 `typecheck:build` 分别表达完整 workspace 与生产边界，并由 `typecheck` 组合执行两者。

### 4. 文件集合本身成为回归门禁

新增配置边界测试，通过 TypeScript compiler API 解析两个配置并断言：生产集合包含 `src/main.ts`、不含任意 `*.test.ts`/`test`/`scripts`；完整集合包含现有全部 TypeScript 测试和 `scripts/monitor-service.test.ts`；build types 不含 Jest。该测试同时读取 Rollup 配置，锁定它实际引用 build leaf，调用 Jest discovery 核对每个 TypeScript 测试，并扫描生产 TypeScript 与 `src` 内 legacy JavaScript，拒绝生产代码导入 `@mock/*`、测试或脚本模块。

Jest 基线 129 个既有 suite 必须全部保留；新增边界 suite 后总数增加属于预期，不能把“数量完全不变”误当成 discovery 兼容要求。

## Risks / Trade-offs

- [build leaf 漏掉生产声明或 Node ambient] → 生产 typecheck、Rollup build 与 `src/main.ts`/`global.d.ts` 文件集合断言共同门禁；显式保留 Node。
- [父配置测试选项未来泄漏到 build] → build 明确覆盖当前有边界含义的 `types/include/exclude`；若未来增加会改变 emit/module 的测试专属选项，必须另立 test leaf，而不是静默加入根配置。
- [新增 script test 后默认 tsc 暴露既有错误] → 只修测试源码或配置边界，不借机改生产逻辑；该文件当前已由 ts-jest 实际执行，因此静态纳入是收敛验证面。
- [Rollup 文件减少但 bundle 语义漂移] → 比较入口、输出模块数、source map、构建成功和既有全量 Jest，并确认 bundle 无残留 `@/`/`@mock/` require 且仍含 autoplanner 的 `runPlan`/`savePlanToMemory` 路径；本切片不部署到 shard。
- [性能数字受缓存/JIT影响] → 使用同机 warm 多次中位数，只报告 root/program file 数与方向性变化，不设单次时间硬门槛。

## Migration Plan

1. 先加入 build leaf、完整 include 与配置边界测试，分别运行两个 typecheck。
2. 将 Rollup 指向 build leaf，运行 build、Jest discovery、monitor suite 与全量 Jest。
3. 记录前后 compiler root/program file 数及方向性时间/内存；确认 Git diff 不含生产源码和生成物。
4. 该切片无需线上部署；若构建或测试语义异常，回退本提交即可，无 Memory 或数据迁移。

## Open Questions

无。
