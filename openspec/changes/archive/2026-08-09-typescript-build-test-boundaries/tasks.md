## 1. 基线与边界门禁

- [x] 1.1 记录当前 tsc compiler inputs/root tests、Jest discovery 与 Rollup time/RSS 的同机基线
- [x] 1.2 新增配置边界测试，覆盖 production/full file set、ambient types、Jest discovery、Rollup config 引用与生产 TS/legacy JS 不得导入 test/scripts/@mock

## 2. TypeScript 配置分离

- [x] 2.1 将 `scripts/**/*.test.ts` 纳入根 `tsconfig.json` 的完整 workspace typecheck
- [x] 2.2 新增 `tsconfig.build.json`，只保留生产 `src` 文件和 Screeps/Node/Lodash ambient types
- [x] 2.3 让 Rollup 显式使用 build 配置，并新增完整 workspace 与生产 typecheck 命令

## 3. 兼容与性能验证

- [x] 3.1 运行双 typecheck 与 file-list 断言，确认 full 覆盖 monitor test、build 不含 test/test mock/scripts
- [x] 3.2 运行配置边界与 monitor 聚焦测试、Jest discovery 和全量 Jest，确认原129个suite全部保留
- [x] 3.3 运行 Rollup build，确认单 bundle/source map、无 unresolved alias 且 autoplanner 入口仍在
- [x] 3.4 用同机 warm 多次中位数记录 build/typecheck 文件数、时间与内存方向性变化，并完成 TypeScript、OpenSpec strict 与 diff check
- [x] 3.5 独立复核 Jest/Node ambient、Rollup plugin、autoplanner 与无运行时改动边界

## 4. 收口

- [x] 4.1 提交同一已验证配置切片（`1782b6a`）；因无生产源码或部署产物语义变化，不执行 shard 部署
- [x] 4.2 同步主规格并归档 change（`2026-08-09-typescript-build-test-boundaries`）

## 验证证据

- 变更前：默认 TypeScript Program 493 个文件（仓库 306、测试 128、monitor test 0），Jest 129 suites；tsc 三次 warm 中位 total 2.75 秒、内存约 584 MiB，Rollup wall 中位 2.83 秒、RSS 约 1.09 GiB。
- 变更后：build 配置 174 roots / 351 program files，完整 workspace 308 roots / 495 program files；monitor test 已纳入，build 中测试、scripts、`@mock` 与 Jest ambient 均为 0。
- 全量 Jest：130 suites / 804 tests 全部通过；配置边界与 monitor 聚焦为 2 suites / 7 tests。
- build tsc 的 warm total 约 2.37–2.59 秒、内存约 405–407 MiB；Rollup warm wall 中位约 2.52 秒、RSS 约 917 MiB。仅作同机方向性记录，不作为 SLA。
- 固定构建常量后，根配置与 build 配置生成的 197 模块、代码与 source map 逐字节一致；规范化动态 build tag 后 bundle SHA-256 均为 `afba3cfdc177fc4b2cc4bccffa4b09635dc82684e91572ab8c00e837ea60a550`。
- `npm run typecheck`、`npm test -- --runInBand`、`npm run build`、`node --check scripts/monitor-service.mjs`、目标 OpenSpec strict 与 `git diff --check` 全部通过；三轮独立终审均为 P0/P1/P2 = 0。
