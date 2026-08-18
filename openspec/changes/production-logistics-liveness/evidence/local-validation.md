# 本地验证与独立审查

## 验证结果

- `npm run test:budget`：`167/167` suites、`500/500` tests，`JEST_TEST_BUDGET=PASSED`
- `npm run typecheck`：build/test 两套 TypeScript 配置通过
- `npm run build`：Rollup bundle 构建通过，未设置部署目标
- 聚焦回归覆盖 ResourceTransferTask、Synthesis、Nuker、Hub、Hub protection、ResourceControl capacity、Market arbiter/protection、Monitor 与 main phase
- `npx openspec validate production-logistics-liveness --strict`：通过
- `npx openspec validate decentralized-logistics-contracts --strict`：通过
- `git diff --check`：通过
- `src/main.ts` 无 diff；canonical phase 顺序与 Terminal/Market side-effect gateway 未改变
- `src/types/memory/{cfg,runtime}.d.ts` 无 diff；protected Memory declaration fingerprint 通过

## 初版独立审查

最终两路独立审查均报告 `P0=0、P1=0、P2=0`。审查中发现并已关闭：

- Hub import、卫星 T3 deficit 与 Nuker 仍读取 raw pending；
- foreign Hub 被自然 planner 重新插入 roomOrder、fallback 可能夺权；
- runtime reset 后 ownership revision 倒退；
- disabled Hub skipped-busy 不重试；
- Synthesis 对每个房间重复扫描全部 transfer tasks；
- Monitor 在 analytics 缺失或字段损坏时伪造 liveness 成功；
- P1 文档遗漏 Prepared Direct 专用 claim/execute/release gateway。

## Live 发现与 `2026.8.18-2` hotfix

首轮 `2026.8.18-1+1f3703e` 部署的 A/B/C 两周期安全门槛通过，但 raw task 证据发现同一 LO route 从 `817/101` 被覆盖为 `830/830`，随后又取消/重建。因此 5.2 未勾选，并执行 roll-forward hotfix：

- route 新 decision 复用 canonical automatic merge，`amount` 与 `remainingAmount` 同增，保持 `amount - remainingAmount` 与 `lastProgressAt`；
- coverage-healthy zero-delta route 作为已签发有界 commitment 保留，不从增量 decision 缺失猜测缩量；
- direct consumer 使用已知兼容、已知清空/不兼容、未知三态；Hub fallback 与 busy 旧产线从实际 config/runtime 恢复；
- 旧 Hub endpoint、distributed-storage non-T3 surplus 作为可靠 stale 证据回收；coverage-expired 终态原因留给 ResourceControl canonical reconciliation；
- 精确数量缩减、same-revision amendment 以及 distributed→fallback/disabled 的可审计合同迁移明确留给后续 TransferContract provenance。

hotfix 稳定树验证：

- `npm run test:budget`：`167/167` suites、`500/500` tests，未增加 Jest case；
- Hub/ResourceControl/TaskHealth 聚焦回归：`4/4` suites、`10/10` tests；
- `npx tsc --noEmit`、Rollup build、两份 OpenSpec strict 与 `git diff --check`：通过；
- 两路终审对 hotfix 实现报告 `P0=0、P1=0`。非阻断 P2 为：生产主循环之外的 same-revision helper 重放没有持久幂等键；测试用 precomputed zero-delta plan 锁定 writer/cleanup 合同，不宣称自然 planner 一定生成该 fixture。

## 已接受且明确记录的边界

- 新可选 Memory 字段由 owner-local adapter 访问，canonical ambient declarations 继续受 protected fingerprint 冻结；若未来要公开纳入 schema，需独立 Memory schema/budget change。
- duplicate/foreign assignment 已在相关 config、allocation 与 distributed route 写入前 fail closed；合法 Hub 计划后续的整条旧 import/config 写链仍不是通用事务，意外 snapshot 构建失败依赖 invalid protection 与部署观察门槛。
- 所有结果均为本地静态/测试或部署前只读证据，不等于部署后 live 验收。
