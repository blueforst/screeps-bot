# 本地实现与验证证据

## 范围

- 验证日期：2026-08-17（Asia/Shanghai）
- 基线 HEAD：`0750c6e`
- 验证对象：heap-only multi-room travel segment、失效/生命周期、movement analytics 与 external telemetry 有界投影
- 未执行：版本更新、提交、`npm run push`、线上配置或 Memory 修改

## 确定性收益门禁

- 固定 fixture 中，同一 creep 连续 10 个稳定跨房 travel tick 的 `PathFinder.search` 从原行为的每 tick 一次收敛为 1 次 search + 9 次 segment hit。
- 长路径包含 fatigue/`ERR_TIRED` 时，idle lease 可以续租但不越过 hard expiry。
- `transitionIndex` 让实时下一房安全检查 O(1) 定位 transition；同 tick/同 room 的安全事实只计算一次。
- telemetry 对 room bucket 使用 snapshot-once hot-load 补形与 O(16R) recent-first top-K，不执行全量历史排序。

## 回归与构建

- 聚焦回归：5 suites / 136 tests 通过。
- 全量 Jest：167 suites / 1,491 tests 通过，0 failure。
- `npm run typecheck`：build/test 两套 TypeScript 配置通过。
- `npm run build`：通过；`dist/main.js` 为 3,952,896 bytes，source map 共 188 个 runtime source。
- bundle 可达性：包含 movement metrics/creepState/routing 与 externalTelemetry；仍不包含离线 `taskSystem` runtime sources。
- `npx openspec validate multi-room-travel-segment-cache --strict`：通过。
- `git diff --check`：通过。

## 独立审查

三条只读审查分别覆盖 correctness、hot-path/data ABI、tests/spec。审查提出的 cursor 回走、真实边界、transition 拓扑、实时安全门禁、TTL、Colonization 接管抖动、旧指标补形、remote telemetry、traffic `ERR_BUSY` 口径与 terminal error 等问题均已修复或明确收窄为既有路线政策；最终结论均为无遗留 P0/P1/P2。

## 证据边界

本文件只证明本地静态、确定性调用次数与回归结果，不证明 Screeps 线上 CPU 已下降。上线收益必须在获得明确部署授权后，用同 shard、同版本的完整新 120 样本窗口比较 pathing mean/p50/p95、creepWork、total CPU、bucket、search/hit/invalidation、stuck/repath/exit recovery 与世界负载。
