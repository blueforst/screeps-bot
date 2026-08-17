# 500-case 精简结果

## 选择口径

- 旧提交 `69d4f3e` 的 500-case 结果同样来自代理/机械精简，仅作为数量历史，不作为当前保留测试的质量依据。
- 本轮从 `47478c2` 的 167 suites / 1491 tests 全绿基线重新选择，依据当前生产合同、active OpenSpec、本地架构/ABI/ownership 门禁，以及成功、公开边界、失败/回退、清理/恢复五类语义。
- 15 个 `protected-full` suite 共 131 cases 原样保留；其中 multi-room travel 证据为 `routing.segmentCache` 56、`externalTelemetry` 12、`main` 6。
- 24 个 `high-risk` suite 保留 117 cases；128 个普通 suite 保留 252 cases。所有 167 个文件至少保留 1 case。
- 参数化 catalog 在单个带标签测试内保留完整 13 个 TaskSystem ID、27 个 role ID 等枚举断言；需要合并的 role/runtime fixture 在每轮显式重置。

## 完整 Jest 预算门禁

- 命令：`npm run test:budget`
- 仓库测试文件、Jest `--listTests` 与完整执行结果三方集合一致：167 files
- 结果：167/167 suites、500/500 tests 全部通过，failed/pending/todo 均为 0
- 验证器独立硬锁 167 suites / 500 passed / zero failed-pending-todo，从 `47478c2` 派生测试文件集合与 15 个 protected suite 内容 hash，并以 TypeScript AST 拒绝 only/skip/todo
- 逐文件 `assertionResults.length` 与 `test/test-suite-budget.json` 全部一致
- 最终死代码清理后的冻结树观察耗时：51.580 秒（前一冻结轮为 48.189 秒）；该波动再次说明 case 数不是 wall-clock 等比例收益指标
- 首轮曾以 500 passed 命中数量，但 12 个 suite 因空 describe 残留被 Jest 拒绝；移除 74 个不含测试后代的空容器后，12/12 focused suite 与完整门禁均通过

## 静态与构建验证

- `npm run typecheck`：workspace/production 双 TypeScript 配置通过
- `npm run build`：Rollup build 通过；未设置部署目标，未上传 bundle
- `npx openspec validate reduce-jest-suite-to-500 --strict`：通过
- `git diff --check`：通过
- 无测试文件删除，无 skip/only/todo，无 Jest/TypeScript 配置改动
- TypeScript code-fix 应用 703 处死 import/声明清理 edit；额外 noUnused 审计对非 protected 测试为 0，protected 原样基线仍保留 3 条历史诊断
- package 版本保持 `2026.8.17-1`；生产源码、Memory ABI 与线上配置零改动

## 回滚

- 本 change 为测试-only；revert 最终提交即可恢复 1491-case 父版本，不需要 Memory 迁移或 Screeps 部署。

## 独立终审

- 独立审查先后发现并关闭 manifest target 自洽绕过、Jest modifier alias、Local Dispatch active-contract、PowerSpawn、Market 与 monitor 主路径缺口。
- 最终增量复核结论：P0/P1/P2 均为 0；15 个 protected suite 与 `47478c2` 内容一致，非 protected 测试 noUnused 为 0。
