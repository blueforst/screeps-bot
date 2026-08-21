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

1. ~~**观察标签细分**~~（**已落地**，2026.8.20-11，commit 4a4cf19）：arbiter 被占且无安全候选的周期细分为 `wait_no_opportunity`（周期仍累计保证 qualified 推进，evidence digest 可辨识证据质量）。
2. **marketSale 与 RC 阶段时序**：marketSale 紧随 RC 执行使 arbiter 空窗稀少；如需提高真实成交频率，应在调度层评估时序（受 AGENTS.md 主循环顺序约束，需独立论证）。
3. **v3 scope core CPU**（每 full tick ~13.5）：56 lane 的 scope 重建含 ~300 次 canonicalStableHashV1；这些 fingerprint 进入 ledger/permit 权威合同，削减或缓存它们等于变更 canonical 语义，风险高于常规优化——保留为独立设计议题。

## 晋级验收安排（持续观察）

- 修复后实测速率 ~89 tick/周期（56 lane 轮转采样），100 周期 qualified 预计修复后 ~6.7 小时；tick 73135056 时全部 lane 已达 9 周期（跨部署连续，completeCycles 持久于 Memory.data）。
- 已设置一次性定时验收（400 分钟后）：读 live 直方图/stages/confirmedCanaries，结果追加至本文档"live 验证"章节；若出现新 blocker 如实记录并定位（只读，不改 src）。

### 中途手动验收快照（tick 73135106）

- cycles 直方图 `{"9":32,"10":24}`（采样相位差），stages 全部 shadow，max=10；`ledger.confirmedCanaries` 空（预期——canary 前置是 qualified）；snapshot blockers=null 持续无 incomplete。
- 判定：**晋级机制运转正常，qualified/canary 的预期时点（修复后 ~6.7 小时）尚未到达**；不手动篡改 lifecycle 绕过 100 周期证据（伪造验收且违反 permit 权威流程）。定时任务（automation-aa34e7c0）时点核算覆盖 qualified 预期 tick ≈73143160，将自动完成最终验收并回写本节。

### 最终验收结果（2026-08-21，tick 73152683，手动补录）

- 定时验收任务（automation-aa34e7c0）实际未执行（runCount=0、disabled、宿主侧未触发），本节为手动只读补录（api-console/api-read，仅写 `Memory.runtime.diagM*` 诊断字段，未改 src/配置）。
- **晋级未达成**：cycles 直方图 `{"32":24,"33":32}`（minC=32/maxC=33），stages 全部 shadow（56/56），`ledger.confirmedCanaries` 空，零成交持续。
- **机制本身健康**：各 lane `lastCompleteTick` 间隔 10–20 tick，实测周期速率 **~70 tick/周期**（RC `sampleInterval` 默认 10 × 7 个 resource-major cohort 轮转），快照 `blocker=market_base_no_writable_lane` 且持续无 incomplete——观察与周期累积按设计运转。
- **新发现：周期证据被反复整体清零**。自中途快照（tick 73135106，cycles≈10）至本次（tick 73152683，cycles≈32）共 17,577 tick，按 70 tick/周期应累计 ~250 周期，实际仅 +21。直方图紧凑单峰（32/33 相差 1）表明清零是"成串爆发后恢复"模式：最近一次全量清零约 32×70≈2,240 tick 前，其后稳定累积。结论：qualified 需要一段无清零事件的连续窗口（100 周期 ≈ 7,000 tick ≈ ~2 小时），而清零事件反复打断该窗口。
- **根因候选**（按代码路径排查，待 live 现场确认）：`applyMarketBaseResourceShadowObservations` 对 `incomplete` 观察清零该 lane；incomplete 的产生点为 terminal 读取不完整（`market_base_terminal_incomplete`）、protection 账本不完整（`market_base_protection_incomplete`）、BUY book 读取 blocker 与 CPU ceiling 超限轮的观察降级（`emptyResult` 在 `market_base_cpu_ceiling_exceeded` 时仅保留 incomplete 观察）。live p95 CPU ~19.5/25 ceiling 余量偏小，CPU 压力期连续超限可整批清零。
- **后续动作**：已启动本地只读监测（/tmp/market-cycle-monitor.mjs，每 ~75s 采样 cycles 直方图 + snapshot blocker/shadowBlockers/CPU/bucket，输出 /tmp/market-cycle-monitor.jsonl，监测 100 分钟）抓取下一次清零事件的当轮 blocker；根因确认后单独提交修复，本节只读验收不改 src。

### 修复部署与部署后验收（2026-08-21，tick 73153412）

- 修复已提交并部署：`5539ffc`（fix(market): stop collection noise from resetting v3 shadow cycle evidence，openspec change `market-v3-shadow-evidence-noise`）+ `c3026ad`（版本 `2026.8.21-2`，npm run push 已上传）。
- 监测窗口内（部署前）未再复现清零事件，cycles 32→38 稳步推进；CPU 峰值 19.3/25、outer session 偶发 1.7–1.95（常态 ~0.3），佐证超限清零风险真实存在。
- 部署后只读验收（tick 73153412）：cycles 直方图 `{"39":8,"40":40,"41":8}`——**跨部署无清零**（部署前读数 36–38），snapshot 正常更新（observedAt=73153410）、blocker=`market_base_no_writable_lane`（56 lane 仍 shadow，预期）、shadowBlockers=null、bucket=10000。
- 晋级预期：当前 ~40 周期，按 ~70 tick/周期还需 ~4,200 tick；按监测实测 ~3.5 s/tick（shard 满载）约 **4 小时**后首批 lane qualified；此后 permit grant → canary（1 笔真实 1,000 成交）→ review_paused → continuous。后续验收（qualified/canary/成交）由一次性定时任务回写本节。

### 监测闭环（2026-08-21 06:16，tick 73153514，100 分钟窗口结束）

- /tmp/market-cycle-monitor.jsonl 共 25 个采样（tick 73152734→73153514，跨度 780 tick，含部署切换点），**零清零事件**；cycles 32→42（`{"41":48,"42":8}`），+10/11 周期与理论速率 70 tick/周期完全吻合。
- 对比：修复前 17,577 tick 仅 +21 周期（等效 ~864 tick/周期，被成串清零打断）；修复后速率回归理论值且单调无回退——**修复在 live 生效的直接证据**。
- 窗口内 CPU 峰值 19.5/25（outer session 尖峰 1.9–2.8），未触发 ceiling 截断；若未来出现超限轮，新语义下其 incomplete 观察为 no-op，不再影响周期证据（shadowBlockers 诊断仍可见）。

### 部署后晋级验收（2026-08-21 18:51，tick 73158075，一次性任务 automation-2e7faf39 自动触发）

- 读数：cycles 直方图 `{"95":48,"96":8}`（56/56 lane 位于 95–96 周期），stages 全部 `shadow`；`ledger.confirmedCanaries` 空；recentActions 无新增成交条目（仅历史 v2 era 记录，tick ~72600391–72604731）；snapshot 健康（observedAt=73158060、blocker=`market_base_no_writable_lane`，全 shadow 期预期）。
- **判定：修复生效但窗口未满**。自部署（tick 73153412，cycles≈40）以来 4,663 tick 累积 ~55 周期，直方图 40→50→70→87→95–96 全程单调、零清零回退。
- 速率：近段实测 ~87.4 tick/周期（tick 73157459 avg 88.1 → 73158075 avg 95.1，616 tick / 7.05 周期），慢于理论 70——同期 shadow v2 gate 采样负载在 RC tick 上的观察已记录于 `shadow-v2-gate-attribution-v2.md`（非 shadow 单因子），晋升仅延迟不被阻断。
- 预计：剩余 4–5 周期 × ~87.5 ≈ ~440 tick（~26 分钟）后首批 lane 达 100 qualified（**~19:17–19:20**），随后 permit grant → canary（1 笔真实 1,000 成交）→ review_paused → continuous 由系统自动推进。最终验收（qualified/canary/成交）由本地接力监视在 ~19:32 手动回写本文件后续小节。