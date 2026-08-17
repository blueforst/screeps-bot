## Context

仓库曾在提交 `69d4f3e` 通过代理/机械精简将 120 个 Jest suite 降到 500 个实际用例；此后没有删除旧 suite，但新增 47 个测试文件，并在原文件中继续增加回归。旧 500 只证明历史上达到过该数量，不是人工挑选的质量 oracle，也不得参与本轮保留优先级。当前完整基线为 167/167 suites、1491/1491 tests 全部通过。源码包含 1192 个直接 `it/test`、67 个 `it.each/test.each` 模板；参数化模板展开为 299 个实际 case，因此文本声明数不是可靠预算口径。

本次精简发生在 `multi-room-travel-segment-cache` 线上 120 样本验收期间。测试改动与线上采样互相独立：不重建或上传 bundle，不改变当前 deploy tag，也不得删去该 change 尚在使用的确定性回归证据。测试 case 数量主要是维护与报告预算，不等价于 wall-clock 性能；现有少数慢 suite 即使用例很少仍占据主要执行时间。

## Goals / Non-Goals

**Goals:**

- 将完整 Jest 实跑结果固定为 167 suites、恰好 500 个 passed tests。
- 每个当前测试文件至少保留一个可执行用例，并在模块间保持代表性。
- 冻结当前架构、ABI、ownership 及尚未完成验收 change 的核心门禁；其余 suite 按风险保留成功、公开边界、失败/回退及清理/恢复场景。
- 提供机器可复跑的逐文件预算清单与基于 Jest JSON 的验证脚本。
- 完成 workspace/production 双 typecheck、Rollup build、strict OpenSpec 与 diff 检查。

**Non-Goals:**

- 不以 case 数下降推断覆盖率或执行时间同比下降。
- 不修改生产源码、Memory ABI、Jest/TypeScript 配置、运行时入口、版本号或线上配置。
- 不重写生产 API 来迁就被保留的测试。
- 不在本 change 中部署 Screeps bundle或改变正在运行的 movement change。

## Decisions

### 1. Jest JSON 是唯一数量真值

完整 `jest --runInBand --json` 的 `numTotalTests`、`numPassedTests`、pending/todo/failed 以及每个 `testResults[].assertionResults` 是验收口径。源码正则既会漏掉 `.each`，也会误计普通 `RegExp.test()`，仅可用于辅助盘点。

替代方案是按 `it(`/`test(` 文本声明计数；该方案当前会把 1491 个实际 case 误报为其他数字，因此拒绝。

### 2. 使用逐文件 manifest，而不是隐式全局数字

新增测试预算 manifest，列出全部 167 个 Jest 文件的期望实际 case 数并保证总和为 500。验证脚本运行完整 Jest、比较发现文件集合、逐文件 assertion 数与全局状态，并拒绝 pending/todo/failed。这样未来增长需要显式重新分配预算，不会靠删掉另一个模块的用例偷偷抵消。

替代方案是只检查全局 500；它允许某个 suite 消失后由另一个 suite 补足数字，无法保护模块代表性，因此拒绝。

### 3. 先保护合同，再分配剩余风险预算

预算按以下顺序构造：

1. 每个现有 suite 至少保留一个实际 case。
2. 完整冻结当前核心架构/ABI/ownership 边界，以及尚在验收的 multi-room travel segment 本地证据 suite。
3. 其余 suite 先获得最多两个代表性 case。
4. 将剩余配额分配给跨 tick/跨房生命周期、fail-closed、容量/账本、清理/回滚、Spawn/War/Market/TaskSystem 等高风险行为，直至总和恰好 500。

文件内优先级依次为：当前 active change 回归、正常成功路径、公开阈值/容量/TTL 边界、错误输入与失败回退、释放/清理/恢复、跨模块 ownership。仅参数不同且终态相同的变体最先移除；catalog/validator 的表驱动穷举只有在能放入单个带标签循环且保持独立断言语义时才合并。

### 4. 不用计数绕过手段

不得使用 `.skip`、`.only`、`.todo`、Jest path/testName 过滤、custom runner/report 伪造、删除测试文件或修改 Jest 配置达成 500。保留的参数化测试按实际展开数占用预算；合并多个场景时必须显式恢复原 fixture 隔离，不能默认一次 `beforeEach` 等价于多次。

### 5. 测试精简与线上验收解耦

本 change 只提交测试与验证资产，不递增版本、不 `npm run push`。movement change 的 120 样本继续从线上 tag `2026.8.17-1+84a9cb0` 收集，完成后在原 change 中记录 CPU A/B 与归档结论。

## Risks / Trade-offs

- [删除 66.5% case 可能损失分支覆盖] → 使用保护集合、逐文件预算和五类语义选择矩阵；完整测试通过只证明保留集一致，不夸大覆盖率等价。
- [参数化测试的实际数与源码定义不一致] → manifest 与验收脚本只消费 Jest assertion 结果。
- [合并场景破坏 beforeEach/mock 隔离] → 默认删重复 case 而非机械合并；确需合并时在循环中显式重建 fixture，并单独复跑该 suite。
- [精简后仍未明显加速] → 明确 case budget 是维护目标；慢测试优化另立 change，禁止为追求 wall-clock 删除高风险快 case。
- [并行线上等待导致证据混淆] → 不修改或部署生产 bundle，测试提交与线上 tag 分开记录。

## Migration Plan

1. 保存 167/1491 完整通过基线与逐文件 actual count。
2. 生成总和 500 的风险配额 manifest并锁定保护集合。
3. 在隔离分支按不重叠文件组精简，逐组运行 focused Jest。
4. 运行完整预算验证，要求 167 suites、500 passed、0 pending/todo/failed。
5. 运行 `npm run typecheck`、`npm run build`、strict OpenSpec 与 `git diff --check`，并确认生产源码/Jest 配置零改动。
6. 提交测试-only change；不部署。

回滚只需 revert 该测试提交或从其父提交恢复测试文件与预算资产，不涉及 Memory 或线上迁移。

## Open Questions

- 无。用户已明确要求 500 个测试用例，并沿用此前选定的模块均衡保留策略。
