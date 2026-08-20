# Market base resource v3 自动化解锁（38 万 tick 零成交根因）

- 日期：2026-08-20
- 部署链：`2026.8.20-7`（scope 过滤 8bbe7e0）→ `2026.8.20-8`（shadowBlockers 诊断 f39301c）→ `2026.8.20-9`（claimed 解锁 401d2f9）→ `2026.8.20-10`（blocker detail 诊断 bbd3aea）

## 现场症状

- monitor 长期显示 marketSale 段 ~42 CPU/tick 且 `directBlocker=continuous_candidate_scope_unknown` stale 57 万 tick、零成交。
- v2 continuous 的 lastPlanningSnapshot 停在 tick 72752814（38 万 tick 前不更新）。

## 诊断过程（live 实证链）

1. **v2 snapshot 是陈旧遗留**：live migrationStatus=active，v3 base resource 分支接管，v2 分支不再执行；monitor 的 blocker 读的是遗留快照。
2. **v3 真实 blocker**：`market_base_no_writable_lane`——v3 snapshot 每 full planning tick 正常更新，8 条采样 lane 有 25 个合格订单，但 56 lane 全部 stage=shadow、completeCycles 恒 0（诊断直方图 `{0:56}`）。
3. **加了 shadowBlockers 诊断字段**（f39301c）后读到：8/8 采样 observation 全部 `lane_scope_invalid`（mode=batch_fallback）。
4. **terminalClaims 排查**：runtime terminalClaims 为空——claimed 并非来自 market 自己的锁，而是 scope 构建时 `terminal.claimed = arbiterBlocked`（marketBaseResourceAutomation.ts:7832），其中 `liveArbiterSnapshot().blocked` 含 **terminalClaims 非空**（4864-4880）——RC/synthesis 转运常年占用 terminal，marketSale 阶段紧随 RC（main.ts:76→77）执行时读到的几乎恒非空。

## 根因（自锁死循环）

terminal 恒被物流占用 → arbiterBlocked 恒 true → 所有 lane `terminal.claimed=true` → shadow 观察（伪 writable 纯函数推演）在 planner `!terminal.claimed`（marketDirectContinuousPlanner.ts:1397）撞 `lane_scope_invalid` → observation incomplete → completeCycles 清零 → 永远到不了 100 周期 → 永远无 writable lane → 永远零成交 → terminal 永远只被物流占用。

## 修复（401d2f9）

两处 synthetic writable 推演（planSingleShadowLane、tryPlanPureShadowBatch）在伪化 authorization 的同时清 `terminal.claimed`：claimed 是真实写路径的 tick 级互斥事实，对不落地的纯函数机会评估不适用。观察结果在 arbiter 被占时仍正确标注 `production_priority_wait`（与 v2 语义一致，周期正常累计）。

附带修复（8bbe7e0）：v2 路径 `toContinuousRuntimeCandidates` 过滤到执行表 scope——上游 compose 按 protection ledger 全量产出 56 键候选而执行表只有 3 lane，表外键曾让 v2 整轮 fail-closed（v2 历史 zero-deal 的成因之一；live 已切 v3，此为正确性修复）。

## live 验证

- 部署 2026.8.20-9 后：snapshot `blockers=null`（8/8 不再 incomplete），**completeCycles 直方图从 `{0:56}` → `{0:48, 1:8}`**——周期累计恢复。
- 晋级时间线：56 lane 轮转采样（8 lane/full tick），100 完整周期 ≈ 700 full planning tick ≈ 5.3 小时后首批 lane qualified；此后走 permit grant → canary（真实小额成交验证）→ continuous。
- 真实成交仍受双重 arbiter 把关（计划态 + marketActionArbiter 提交态重验），arbiter 长期被占时真实 plan 保持 fail-closed（预期行为）。

## subagent 影响范围审查（A–E 全部 PASS）

- A 资金安全：合成清零只影响观察管道；真实写路径由 scope 构建态与 `claimPreparedDirectMarketClaims`/`executePreparedDirectMarketDeal` 双重校验。
- B observation 语义：只对 incomplete 清零、production_priority_wait 累计与 v2 规范一致（MARKET_DIRECT_CONTINUOUS_REQUIRED_SHADOW_CYCLES=100）；canary 失败有单次消费与 review 回退，不会静默晋级。
- C scope 过滤：只影响 v2 分支（live 不执行），缺失维度语义与原版一致。
- D 诊断字段有界：key ≤120 字符、≤8 键/轮、被排除在 canonical 比较外。
- E 遗漏检查：全管线 claimed 读写清点无第三处阻断；grant/permit 晋级链不读 terminal claims。

## 已知残留（记录为后续项，非阻断）

1. **观察标签细分**（审查建议）：arbiter 被占且 safeCandidates 为空的周期可与"有候选仅等待"区分（如 wait_no_opportunity），避免纯 wait 周期计入 qualified 证据质量。
2. **marketSale 与 RC 阶段时序**：marketSale 紧随 RC 执行使 arbiter 空窗稀少；如需提高真实成交频率，应在调度层评估时序（受 AGENTS.md 主循环顺序约束，需独立论证）。
3. **v3 scope core CPU**（每 full tick ~13.5）：56 lane 的 scope 重建/哈希成本，独立优化项。
