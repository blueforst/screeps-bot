## Why

当前同一个 `tsconfig.json` 同时承担 Rollup 生产构建、编辑器/默认 TypeScript 检查和 Jest 转译：生产构建因此会纳入共置的 `src/**/*.test.ts`，而仓库根下真实运行的 `scripts/monitor-service.test.ts` 又不在默认 TypeScript 检查范围内。这个边界既增加构建成本，也会让“构建通过”和“全部测试源码已静态检查”表达不同且不完整的事实。

## What Changes

- 建立显式的生产构建 TypeScript 配置，只包含运行时 `src` 源码并排除测试文件，同时移除生产构建不需要的 Jest ambient types。
- 保留默认 `tsconfig.json` 作为完整仓库测试/编辑器检查入口，并把 `scripts/**/*.test.ts` 纳入静态检查。
- 让 Rollup 明确使用生产构建配置；为生产与完整仓库 typecheck 提供可复跑的命令和静态边界门禁。
- 保持入口、alias、Screeps/Node/Lodash 类型、输出目录、source map、Jest test discovery 与部署产物语义不变。

## Capabilities

### New Capabilities

- `typescript-build-test-boundaries`: 定义生产构建、完整测试 typecheck 与 Jest discovery 的文件集合、ambient types 和兼容门禁。

### Modified Capabilities

无。

## Impact

- 影响 `tsconfig.json`、新增生产构建配置、`rollup.config.js`、`package.json` 以及一份配置边界测试。
- 不修改 `src` 生产逻辑、Memory、全局 API、main tick 顺序、部署分支或外部依赖。
- 验证需要分别运行生产 typecheck、完整仓库 typecheck、Jest discovery/边界测试、全量 Jest 与 Rollup build，并比较构建前后的 TypeScript 文件集合。
