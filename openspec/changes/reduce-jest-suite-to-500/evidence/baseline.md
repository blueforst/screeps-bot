# 精简前基线与预算

## 完整 Jest 基线

- 基线提交：`47478c2`
- 命令：`npx jest --config jest.config.cjs --runInBand --json`
- 结果：167/167 suites、1491/1491 actual tests 全部通过，failed/pending/todo 均为 0
- 观察耗时：77.492 秒；该值只用于描述完整反馈成本，不作为 500-case 的等比例性能承诺
- 目录分布：`src/runtime` 118 files / 1015 tests，`src/roles` 23 / 238，`src/movement` 5 / 78，根 `test` 13 / 76，其余目录 8 files / 84 tests

## 参数化与计数口径

- TypeScript AST：1192 个直接 `it/test`，67 个 `it.each/test.each` 模板
- 参数化模板展开为 299 个实际 cases，使实际 case 比逻辑定义多 232
- 旧文本正则会同时漏掉 `.each` 并误计普通 `.test()`，因此不得作为验收口径
- 唯一数量真值为完整 Jest JSON 的 summary 与逐文件 `assertionResults`

## 500-case 配额

- 167 个现有测试文件全部进入 `test/test-suite-budget.json`，每个预算至少为 1
- `protected-full`：15 files，131 cases 原样保留，包括 multi-room segment cache 的 `routing.segmentCache` 56、`externalTelemetry` 12、`main` 6，以及核心 architecture/ABI/ownership 边界
- `high-risk`：24 files，从 660 cases 收敛到 117，覆盖跨 tick/跨房 lifecycle、fail-closed、容量/账本、Spawn/War/TaskSystem/Dispatch 等领域
- `default-max-2`：128 files，从 700 cases 收敛到 252
- manifest 总计：167 files / 500 cases

## 证据边界

- case 数减少不等价于 branch coverage 或 wall-clock 同比例减少；少数慢 suite 即使用例数很少仍占据主要时间
- 本 change 不修改生产源码、Jest/TypeScript 配置、package 版本、Memory 或线上 deploy tag
