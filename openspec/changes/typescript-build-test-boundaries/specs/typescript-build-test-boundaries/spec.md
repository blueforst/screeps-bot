## ADDED Requirements

### Requirement: 生产构建使用独立 TypeScript 文件边界

系统必须（MUST）为 Rollup 生产构建使用专用 TypeScript 配置。该配置必须包含运行时 `src` TypeScript 与声明文件，必须排除共置测试、`test` 树与 `scripts` 树，并且不得（MUST NOT）向生产代码提供 Jest ambient types。Screeps、Node、Lodash、alias、target、source map 与 dist 输出语义必须保持可用。

#### Scenario: 生产文件集合不包含测试

- **WHEN** 使用生产配置解析 compiler root files
- **THEN** 集合包含 `src/main.ts` 与生产声明，但不包含任意 `*.test.ts`、`*.spec.ts`、`test/**` 或 `scripts/**`

#### Scenario: 生产 ambient 边界

- **WHEN** 使用生产配置执行 `tsc --noEmit`
- **THEN** Screeps、Node 与 Lodash 类型可用，Jest ambient 不在显式 `types` 集合中，且检查零诊断通过

#### Scenario: 测试与脚本依赖不进入生产 bundle

- **WHEN** 扫描生产配置包含的非测试 TypeScript 与 `src` 内由 Rollup 打包的 legacy JavaScript
- **THEN** 生产文件不得导入 `@mock/*`、测试目录、`scripts` 目录或测试模块；仅继承 alias 解析能力不得把测试文件带入 compiler 集合

### Requirement: 完整 workspace typecheck 覆盖全部测试源码

默认 `tsconfig.json` 必须（MUST）继续作为编辑器、默认 `npx tsc --noEmit` 与 ts-jest 的完整 workspace 配置。它必须包含 `src/**/*.ts`、`test/**/*.ts` 与 `scripts/**/*.test.ts`，并保留 Screeps、Node、Jest、Lodash types 以及现有 `@/*`、`@mock/*` alias。

#### Scenario: Monitor 脚本测试被静态检查

- **WHEN** 解析默认配置的 compiler root files
- **THEN** `scripts/monitor-service.test.ts` 与全部既有 TypeScript Jest suite 均在集合中

#### Scenario: 既有 Jest discovery 保持

- **WHEN** 用原 Jest config 列出和执行测试
- **THEN** 变更前的 129 个 suite 必须全部仍可发现和执行，新增配置边界 suite 可以使总数增加；配置门禁必须核对仓库中的每个 TypeScript 测试均被 Jest 实际发现

### Requirement: Rollup 与验证命令显式消费正确边界

Rollup 必须（MUST）显式读取生产配置；仓库必须提供分别检查完整 workspace 与生产 build 的可复跑命令。变更不得（MUST NOT）修改运行时入口、生产源码、Memory、部署分支或 bundle 输出格式。

#### Scenario: 双 typecheck 与 build 验证

- **WHEN** 运行完整 workspace typecheck、生产 typecheck 和 Rollup build
- **THEN** 三者全部成功，Rollup 只检查生产文件并继续生成单一 CommonJS `dist/main.js` 与 source map，bundle 不得残留未解析的 `@/` 或 `@mock/` require，并须继续包含 autoplanner 入口

#### Scenario: 文件边界回归被拒绝

- **WHEN** 未来配置让测试文件进入生产集合、让 monitor test 离开完整集合，或让 Rollup重新指向根配置
- **THEN** 配置边界测试必须失败并阻止该变更通过验证
