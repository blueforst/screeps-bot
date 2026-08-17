## ADDED Requirements

### Requirement: 完整 Jest 套件恰好执行 500 个用例

仓库必须（MUST）以完整 Jest JSON 结果为数量真值，并保持 `numTotalTests = 500`、`numPassedTests = 500`、failed/pending/todo 均为零。系统不得（MUST NOT）用源码文本声明数代替实际展开后的 case 数。

#### Scenario: 完整预算通过

- **WHEN** 在仓库根目录运行测试预算验证
- **THEN** Jest 完整执行全部发现 suite，并报告恰好 500 个 passed tests 和零 failed/pending/todo

#### Scenario: 参数化用例计入实际预算

- **WHEN** suite 使用 `it.each`、`test.each` 或其他 Jest 参数化形式
- **THEN** 每个实际展开的 assertion result 都必须计入该文件与全局 500-case 预算

### Requirement: 所有现有测试文件保持可发现和有代表性

仓库必须（MUST）保留精简基线中的全部 167 个 Jest 测试文件；每个文件必须至少执行一个用例，逐文件实际用例数必须与受版本控制的预算 manifest 一致。

#### Scenario: 文件发现集合完整

- **WHEN** 比较仓库测试文件、Jest `--listTests` 与完整执行结果
- **THEN** 三者包含相同的 167 个文件，且每个文件至少有一个 passed assertion result

#### Scenario: 单个 suite 被意外移除

- **WHEN** 某个测试文件不再被 Jest 发现或其预算降为零
- **THEN** 测试预算验证必须失败，即使其他 suite 仍使全局数量等于 500

### Requirement: 精简不得使用计数绕过手段

精简必须（MUST）通过保留代表性测试、移除重复 case 或显式保持 fixture 隔离的场景合并完成；不得（MUST NOT）使用 skip/only/todo、Jest 过滤、伪造 runner/reporter 计数、删除整个测试文件或修改 Jest discovery 配置。

#### Scenario: 跳过或待办用例被拒绝

- **WHEN** 完整结果包含 pending、todo 或非 passed assertion
- **THEN** 预算验证必须失败而不得把这些项目视为已精简用例

#### Scenario: 全局数字掩盖文件漂移被拒绝

- **WHEN** 全局仍为 500 但任一文件的实际 case 数偏离 manifest
- **THEN** 预算验证必须报告具体文件差异并失败

### Requirement: 高风险合同保持代表性回归

保留集必须（MUST）优先覆盖架构/ABI/ownership 边界、active OpenSpec 本地证据，以及每个高风险领域的成功、公开边界、失败/回退和清理/恢复语义。精简不得（MUST NOT）以测试数量下降宣称等价覆盖率或等比例执行时间收益。

#### Scenario: Active change 证据被保护

- **WHEN** 某个尚未完成归档的 change 依赖确定性测试作为本地证据
- **THEN** 对应核心生命周期、失效、fallback 与边界门禁在该 change 完成验收前保持可执行

#### Scenario: 普通 suite 分配代表性 case

- **WHEN** 一个行为密集 suite 需要压缩到其文件预算
- **THEN** 选择顺序必须优先保留成功、公开边界、失败/回退及释放/清理/恢复，而非仅保留相邻的同结果参数变体

### Requirement: 测试精简不改变生产与线上状态

变更必须（MUST）保持生产源码、Memory ABI、运行时入口、Jest/TypeScript 配置、部署版本与线上配置不变，并完成 workspace/production typecheck、Rollup build、strict OpenSpec 与 diff 检查。

#### Scenario: 本地验证完成

- **WHEN** 500-case 精简实现完成
- **THEN** 完整预算验证、`npm run typecheck`、`npm run build`、strict OpenSpec 与 `git diff --check` 全部成功

#### Scenario: 不触发 Screeps 部署

- **WHEN** 仅测试与预算资产发生变化
- **THEN** 不递增 package 版本、不上传 bundle，线上 deploy tag 与 Memory 保持不变
