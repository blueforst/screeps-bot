# Synthesis-only Shadow v2 10+100 live gate 失败记录（2026-08-19）

## 结论

`2026.8.19-1+eb26197` 的 Shadow v2 窗口已取得完整 10 warmup + 100 measured telemetry epochs（tick `73111180..73112270`，`sampleInterval=10`，全部 epoch 均有至少一次完全 coherent 的有效观测），可观察 safety、Memory、bucket、结构配对与差异因果机器证据全部通过，但 **9.4 live gate 的正式 CPU 门槛未通过**：100 个 measured `gateUsed` 的 nearest-rank p95 为 `8.398820`，超出冻结 pre-p95 `4.172600` 的 110% 上限 `4.589860` 约 83%，100 样本中 94 个超上限，中位数 `5.192` 亦超上限——失败是系统性的，不是尾部尖峰。8.5a、9.1a、9.4 继续保持未完成。

live mode 已于 tick `73113300` 验证回退为 `disabled`。未触发任何即时安全回滚条件；回退完全由正式 CPU p95 失败触发。

## 窗口与原始证据

- shard：`shard1`；deploy tag：`2026.8.19-1+eb26197@2026-08-19T04:40:18.525Z`，窗口内每轮核查未变更。
- cfg：`{"canaryScopes":[],"schemaVersion":1,"mode":"shadow"}`，窗口内无人工配置变化。
- warmup：10 个连续 epoch，tick `73111180..73111270`。
- measured：100 个连续 epoch，tick `73111280..73112270`；预期 cadence 序列无缺样、无跨 epoch 拼接。
- 原始 Monitor 抓取：`monitor-data/shadow-v2-gate.jsonl`，247 次 fetch、16,393,228 bytes，SHA-256 `a3c299549f66e3a9646fabb64314d43b4db5b1de1203d53d641ee00e113baa4b`（按约定不入库）。
- 仓库内持久去重明细：`shadow-v2-100-sample-metrics.tsv`，1 行表头 + 110 行（10 warmup + 100 measured），SHA-256 `9f9515cc62aff4e830be2a99e1d468fe21a031db4d85c9eaef95ec80164343a2`；每行冻结 tick、intents、comparison、causal codes、producerUsed/consumerUsed/outerResourceControlUsed/gateUsed、Memory bytes、bucket 与 matcher 计数，原始抓取消失后仍可独立复算全部聚合。

统计按 logistics runtime `updatedAt` 去重，每个 epoch 只在存在完全 coherent 记录（`snapshotAttestationMatched=true`、无 incoherent/inconclusive、CPU attribution 同 tick、`cpuGateEligible=true`）时计入；任何数值不做跨 tick 拼接。5 个 epoch（`73111220/73111290/73111890/73112120/73112420`，后一者在窗口外）的首个观测出现 CPU history 未对齐（`outerResourceControlUsed=null`），同 epoch 后续 15s 观测即恢复完全 coherent，属观测路径时序差，以同 epoch 有效观测计入，未拼接异 tick 数据。

Monitor 本次以 `--memory-interval-ms 15000` 起跑；中途确认 Screeps API 限流为日额度（1440/天，重置 `2026-08-20T04:48:08Z`）后，为避免窗口中段配额耗尽，为本仓库 `scripts/monitor-service.mjs` 增加默认关闭的 `--lean-memory` 开关（跳过 hub 与 direct market data 等 gate 无关 path 读取），并以 20s 间隔完成窗口。该开关不改变任何校验语义，monitor 聚焦测试通过。

## 已通过的门槛

100 个 measured epochs 全部满足：

```text
schemaVersion=2  requestedMode=shadow  effectiveAuthority=legacy
available/livenessAvailable/complete=true  blocker=null
projectionTruncated=false  snapshotAttestationMatched=true
snapshotIncoherent=false  inconclusive=false
active=fresh=paired=emitted=total（每 epoch 4/4）
stale=inputDrift=dropped=unresolved=0  intent.truncated=false
matcher.indexBuilds=1  budgetExhausted=false  cost evaluations 闭集预算内
nonLegacyAuthorityRecords=0
activeContracts=0  activeLeases=0  activeClaims=0
shadowArbiterActorRecords=0  shadowClaimRecords=0  shadowJournalRecords=0
shadowCarrierTaskRecords=0  shadowReceiverReservationRecords=0
violations=[]  market safetyViolationCount=0  terminalClaims=[]
```

- 差异：measured 共 400 in-scope 比较，`300 equal + 100 expected_policy_difference + 0 unsafe_candidate + 0 unresolved`；每个 material difference 均有完整 causal sample（candidate evaluated/feasible/rejection counts、双方 outcome、decisionDelta、方向）。
- Memory：logistics data+runtime 合计 `7,478..7,521` bytes（100/100 `withinLimit=true`，上限 32,768）。
- bucket：100/100 为 `10000`，first 20 与 last 20 median 均为 `10000`，无退化。
- CPU attribution：100/100 `attributionVersion=2`、`measurementAvailable=true`、`sampleTick=updatedAt=outer tick`、`consumerUsed<=outerResourceControlUsed`、`gateUsed=outerResourceControlUsed+producerUsed`（无双计）。

### 新增 causal code：`receiver_capacity`

100 个差异中 `source_protection=84`、`receiver_capacity=16`（后者集中在 tick `73112090..73112240`，E1N57 `XUH2O`/`XGHO2` reagent demand）。`receiver_capacity` 不在既有已知集合（`source_protection`/`route_rank`）内，本记录按以下依据计为机器可解释的 `expected_policy_difference`：

- decisionDelta 为 `both_no_route`：legacy 与 Shadow 均不产出路线，仅投影的 route/receiverHeadroom 维度不同；
- Shadow candidate trace 完整：`evaluated=8, feasible=0, receiver_capacity=7, same_room=1`；
- 这正是 v1 失败记录中 E7N57 `UH2O/OH` 被误标 `unsafe_candidate` 的同类现象（receiver terminal 低于 `receiverTerminalMin` 的硬 veto no-route），v2 按规范应投影为 `expected_policy_difference + primaryCause`，本次以 `receiver_capacity` 完成因果闭环。

稳健性：即使将这 16 个 epoch 全部剔除（n=84，剩余差异全部为 `source_protection`），p95 仍为 `8.398820`；且 gate 中位数 `5.192 > 4.589860`。CPU 失败结论与该口径选择无关。

## CPU 正式失败

```text
measured samples        100
gateUsed avg            5.677
gateUsed p50            5.192
gateUsed p95            8.398820   （上限 4.589860，超出 83.0%；pre-p95 4.172600，增幅 101.2%）
gateUsed max            15.861     （tick 73111420）
samples > 4.589860      94 / 100
```

分项（100 measured）：

```text
producerUsed   avg 2.830  p50 2.593  p95 3.404  max 12.546
consumerUsed   avg 0.971  p50 0.946  p95 1.208  max 2.581
outerRC        avg 2.848  p50 2.567  p95 3.603  max 12.605
```

warmup 10 点 gateUsed：`5.367/5.474/5.084/6.533/7.168/5.620/5.570/4.713/5.559/5.345`（不进入 p95）。

### 归因定位（live 证据）

- **Shadow 边际成本 ≈ producerUsed + consumerUsed ≈ 3.8 CPU/epoch**（4 intents/epoch）；外层 legacy ResourceControl（扣除 shadow consumer）avg ≈ 1.9。
- **producer 与 consumer 都过热，producer 是主要削减对象**：要在外层 p50 `2.567` 下满足上限，producer p95 必须 `<= ~2.02`，当前为 `3.404`（约需削减 40%+）；consumer p95 `1.208` 亦有约 1.0 的稳定空间可压缩，但单独压 consumer 不够。
- **producer 成本与输出体积无关**（corr(producerUsed, totalBytes) ≈ -0.04），与 candidate 评估数无关（本窗恒为 8）——成本在 capture/draft/fingerprint/codec/attach 等 Shadow-only 固定计算，而非数据规模；与 intents 数近似线性（此前 12-intent warmup 点 producer `4.554..6.826`，本窗 4-intent avg `2.830`，约 0.4–0.55 CPU/intent/epoch）。
- **尾部双源**：gate 最高的样本中，`73111830`（gate 15.78）由 producer 尖峰 `12.55` 驱动，`73111420`（gate 15.86）与 `73111710`（gate 11.04）由 outer ResourceControl 尖峰 `12.60/8.73` 驱动（shadow consumer 分别仅 1.13/0.98/1.46）；outer 单独 p95 `3.603` 本身不超上限，但与 producer 尖峰叠加推高 gate 尾部。
- 修复方向（待验证，不作为结论）：producer 侧 capture、draft/fingerprint、compact codec/attach 与重复序列化是任务书既列的怀疑点，本窗证据与其一致（固定计算成本、不随 bytes/candidates 缩放），但 segment 级定位需要新的 instrumentation 或本地 profiling bundle，live v2 runtime 只暴露 producer 总量。

## 回退证据

- 回退触发：正式 CPU p95 失败（上述），非即时安全条件。
- console operation：`6a85a773fd36790013669c27`，服务返回 `ok=1`、`insertedCount=1`；写入表达式原子保留 logistics 兄弟字段，仅强制 `schemaVersion=1`、`mode="disabled"`。
- Memory API 精确读回：`{"canaryScopes":[],"schemaVersion":1,"mode":"disabled"}`。
- runtime 验证 tick `73113300`：`requestedMode=disabled`、`effectiveAuthority=legacy`、`blocker=mode_disabled`、`available=false/complete=false`（关闭态预期）、九项 safety 计数全零、`violations=[]`。

## 下一次门槛

- 修复 bundle 版本号使用 `2026.8.19-2` 及以上；不得改动冻结 canonical Memory 根 `.d.ts`、主循环 phase 顺序、`test/memoryDeclarationBoundaries.test.ts`，Jest 预算保持 167 suites / 500 cases。
- 修复部署后不得自行重新开启 Shadow；需用户再次明确授权，并按规范重新冻结同口径 disabled pre 基线、从零执行 10 warmup + 100 measured；旧窗口不得拼接或倒填，本记录的 CPU、差异标签与因果样本不得追认为 8.5a/9.1a/9.4 通过。
