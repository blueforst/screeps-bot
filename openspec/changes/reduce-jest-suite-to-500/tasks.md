## 1. 基线与预算

- [x] 1.1 记录完整 Jest 的 167 suites / 1491 actual tests / 0 pending-todo-failed 基线、逐文件 actual count、参数化展开差异与 wall-clock 边界
- [x] 1.2 建立覆盖全部 167 文件且总和恰好 500 的逐文件预算 manifest，标记架构/ABI/ownership、active change 与高风险生命周期保护集合
- [x] 1.3 实现基于完整 Jest JSON 的预算验证脚本，校验发现文件集合、逐文件 assertion 数、全局 500 passed 以及零 failed/pending/todo

## 2. 模块均衡精简

- [x] 2.1 冻结 multi-room segment cache、本地 telemetry/main 证据与核心架构/ABI/ownership 边界 suite，确认其预算不低于保护矩阵
- [x] 2.2 精简 runtime 领域测试，优先保留成功、公开边界、fail-closed、容量/账本、清理/恢复与跨模块 lifecycle 场景
- [x] 2.3 精简 roles、movement、config、mount、visual、scripts 与根 test 目录，保持每文件至少一个可执行代表性用例
- [x] 2.4 处理 `it.each/test.each` 的实际展开预算，仅移除重复数据行或在显式重建 fixture 时合并场景
- [x] 2.5 静态确认未新增 skip/only/todo、未删除测试文件、未修改 Jest/TypeScript 配置、生产源码、版本或部署配置

## 3. 验证与审查

- [x] 3.1 对每个修改批次运行 focused Jest，并修复由测试依赖、hook 隔离或 unused helper 引起的回归
- [x] 3.2 运行完整预算门禁，取得 167/167 suites、500/500 passed tests、零 failed/pending/todo 与逐文件 manifest 全匹配
- [x] 3.3 运行 `npm run typecheck`、`npm run build`、strict OpenSpec validation 与 `git diff --check`
- [x] 3.4 独立审查保护矩阵、active change 证据、生产/Jest 配置零改动与可恢复回滚边界，修复后复验

## 4. 提交边界

- [x] 4.1 原子提交测试、预算门禁与本 change 文档；不得递增版本或 `npm run push`，并只读确认线上 movement deploy tag 未被改变
