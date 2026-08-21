# Design: v3 shadow 证据噪声容忍

## Context

- 观察 apply 入口：`applyMarketBaseResourceShadowObservations`（`src/runtime/marketBaseResourceAutomation.ts`）。
- incomplete 来源（同文件 full read 路径）：
  1. lane 级 BUY book blocker（`shadowBookBlockers`）；
  2. terminal 读取不完整（`market_base_terminal_incomplete`）；
  3. protection 账本不完整（`market_base_protection_incomplete`，`candidateProtectionComplete` 要求 revision 严格等于当前 tick 且未 blocked）；
  4. CPU ceiling 超限轮（`emptyResult` 在 `market_base_cpu_ceiling_exceeded` 时仅保留 incomplete 观察传入 apply）；
  5. 同 tick 重复观察哈希冲突（`conflicting_same_tick_shadow_observation`）。
- 既有重置通道（不受本变更影响）：tick rollback 检测在 apply 层内；lane 身份变化在 scope reconcile 层（`reconcileMarketBaseDerivedLanes` 的 stableFingerprint 冲突 → blocker/tombstone，不销毁其他 lane）。

## Goals / Non-Goals

- Goals：移除单轮采集噪声对周期证据的清零；保持 100 完整观察门槛与全部 fail-closed 写门禁不变。
- Non-Goals：不改观察轮转/cohort、CPU ceiling、双读、emptyResult 过滤、scope/permit/ledger canonical 合同；不引入 incomplete 宽限计数（持续性 incomplete 停涨即天然 fail-closed）；不动 v2 evaluator。

## Decisions

### D1: incomplete → no-op（保持 lane 原样）

清零的本义（spec 字面）是"配置变化把连续计数清零"。terminal/protection 单轮读取失败与 CPU 超限是采集噪声，不是配置变化；配置漂移已由 scope reconcile 的 fingerprint/revision 层权威处理。incomplete 轮不推进 `completeCycles` 已满足 fail-closed；额外清零只摧毁既有证据，无安全收益。

替换后 incomplete 分支直接 `return lane`：不改 cycles、不改 `lastCompleteTick`（它语义是"最近一次完整观察"）、不写 reset digest。持续 incomplete 的 lane 周期停涨，无法 qualified——失败方向与现状一致。

### D2: conflicting_same_tick 同样 no-op

同 tick 哈希冲突表示重入/合并异常。旧实现把冲突升级为 incomplete（清零）。冲突轮不推进即可；销毁历史证据同样超出必要惩罚。重入防护仍由 `previousTick === tick` 短路保证（同 tick 第二次观察不重复计数）。

### D3: tick rollback 清零保留

`tick < previousTick` 是真实的证据时序破坏（服务器回滚/global 重放），必须清零重来，保持原样。

### D4: 不改 `emptyResult` 的超限过滤

CPU 超限时 `emptyResult` 只把 incomplete 观察传给 apply。D1 之后这些观察是 no-op，过滤逻辑虽冗余但无害；保持最小 diff，不重排该路径。

## Risks / Trade-offs

- 风险：间歇性 incomplete 不再暴露为周期回退，观测上更难发现采集质量问题。缓解：`lastPlanningSnapshot.shadowBlockers` 诊断（bbd3aea/f39301c 引入）仍逐轮汇总 incomplete blocker 频次，digest 仍区分 `shadow-observation-v1`；evidence 观察通道不变。
- 风险：若某 incomplete 源实际隐含配置漂移（例如 protection unknown 由配置变化引起），scope reconcile 的 revision/fingerprint 检查是权威重置层，不依赖 observation 清零兜底。
- Trade-off：100 周期从"连续无噪声"弱化为"累计 100 次完整观察 + 期间身份/配置无漂移"。漂移清零语义未变（scope 层），观察质量门槛（非 incomplete 才计数）未变。

## Migration Plan

纯代码语义收紧，无 Memory 迁移：旧 lane 的 shadowEvidence 字段形状不变，直接沿用。部署后下一轮 incomplete 不再清零；已积累周期（live 当前 ~30+）继续向 100 推进。部署本身不触碰 scope/permit/ledger。

## Open Questions

- 无（监测数据回来后若发现清零另有主源——例如 scope 层频繁重建——另行立项，不并入本变更）。
