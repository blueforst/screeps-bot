## Why

当前 Jest 回归套件已重新增长到约 1500 个实际用例，完整反馈成本与维护面再次膨胀；仓库在 2026-07 已验证过 500-case 的模块均衡方案，但此后测试文件与高风险能力显著增加，旧配额不能直接复用。现在需要重新建立一个可持续、可复跑且不牺牲文件级模块代表性的 500-case 上界。

## What Changes

- 将 Jest 最终实际执行口径精简为恰好 `500 passed, 500 total`，以 Jest 汇总而非源码正则计数为准。
- 保留当前每一个 Jest 可发现测试文件，且每个文件至少保留一个可执行代表性用例。
- 按生产风险、架构/ABI 门禁、近期变更、成功/边界/失败/清理生命周期覆盖分配剩余配额，优先删除重复参数变体、同结果格式断言和已被更高层合同覆盖的低价值用例。
- 不使用 `skip`、`only`、Jest 配置过滤、伪造 runner 计数或删除整个测试文件达成目标。
- 不修改生产代码、运行时行为、Memory ABI、构建入口、部署版本或线上配置；本 change 不需要上传 Screeps bundle。
- 增加可复跑的 suite-budget 门禁，防止后续无意突破 500 个实际 Jest 用例或遗失测试文件发现范围。

## Capabilities

### New Capabilities

- `bounded-jest-regression-suite`: 定义 500 个实际 Jest 用例的精确预算、全文件代表性、禁止绕过手段、风险保留原则与验证门禁。

### Modified Capabilities

- 无。

## Impact

- 受影响文件限于现有 `*.test.*`、新的测试预算门禁及本 change 的 OpenSpec 文档。
- Jest 配置、TypeScript 配置、生产源码和 Rollup 运行时依赖保持不变。
- 验收需要完整 Jest、workspace/production 双 typecheck、Rollup build、测试发现完整性、strict OpenSpec 与 diff 检查。
