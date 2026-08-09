## 1. 主循环契约测试

- [x] 1.1 在 `src/main.test.ts` 定义 37 项 canonical 顶层 phase 清单，并将源码提取结果改为精确数组断言
- [x] 1.2 增加 phase 名唯一性、模块加载注册位于 loop 外、`flush` 位于两个 executor 之后的回归断言
- [x] 1.3 保留并加强 Spawn room wrapper 与 Creep profiler wrapper 的特征测试

## 2. 规格与验证

- [x] 2.1 运行 `tick-phase-contract` 定向 strict validation 和 `src/main.test.ts` 聚焦测试
- [x] 2.2 运行 TypeScript、全量 Jest、Rollup build 与 `git diff --check`
- [x] 2.3 确认 diff 未修改 `src/main.ts`、业务模块或 Memory schema，并且本 change 不部署新 bundle
