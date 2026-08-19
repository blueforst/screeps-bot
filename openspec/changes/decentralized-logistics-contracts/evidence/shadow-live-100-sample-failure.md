# Synthesis-only Shadow 10+100 live gate 失败记录

## 结论

`2026.8.18-3+06606da` 的首个 `synthesis_room`-only Shadow 窗口已取得完整的 10 warmup + 100 measured telemetry epochs，但 **9.4 live gate 未通过**：可观察 safety、Memory、bucket 与结构配对均通过，正式 CPU 下界 p95 明确超限，且 v1 comparison 缺少足以闭环差异的因果字段。该窗口不得用于开启 contract/lease/claim authority，也不得在后续补字段后被事后追认为通过。

live mode 已于 tick `73089100` 回退为 `disabled`。8.5a、9.1a、9.4 继续保持未完成。

## 窗口与原始证据

- shard：`shard1`。
- deploy tag：`2026.8.18-3+06606da@2026-08-18T10:51:22.846Z`，窗口内未变更。
- warmup：10 个连续 telemetry sample，tick `73087720..73087810`，`sampleInterval=10`。
- measured：100 个连续 telemetry sample，tick `73087820..73088810`，`sampleInterval=10`；预期序列无缺样。
- 原始 Monitor 抓取：`/tmp/screeps-shadow-live-6a843a4f.jsonl`，289 次 fetch，`26,282,360` bytes。
- 原始文件 SHA-256：`c51013dc5b8aa399bfa585d08607db8278c3b19d2945fad8078cd17dd133164e`。
- 仓库内持久去重明细：`shadow-live-100-sample-metrics.tsv`，100 行 measured data 加 1 行表头；SHA-256：`e7c3431d6781b2067b13a7b8d3dfc4e293b97b7b88f863bf4283198f08f8cb75`。

统计先按 CPU sample tick 去重，并只在 logistics runtime `updatedAt` 与 CPU latest tick 相同的记录上计算；任何跨 tick 记录均不做数值拼接。持久 TSV 冻结每个 tick 的 outer ResourceControl、producer 下界 `captureUsed`、逐行 old gate、旧 Shadow CPU、Memory bytes、bucket、comparison 与 safety 摘要，使 `/tmp` 原始抓取消失后仍可独立复算本记录的所有正式聚合。

## 已通过的门槛

100 个 measured epochs 的可观察安全状态持续为：

```text
effectiveAuthority=legacy
nonLegacyAuthorityRecords=0
activeContracts=0
activeLeases=0
activeClaims=0
shadowArbiterActorRecords=0
shadowClaimRecords=0
shadowJournalRecords=0
shadowCarrierTaskRecords=0
shadowReceiverReservationRecords=0
violations=[]
```

其余通过项：

- 100/100 runtime 为 `available=true`、`complete=true`，没有 projection truncation；
- 共 230 个 in-scope legacy comparisons，结构计数为 `114 equal + 16 expected_policy_difference + 100 unsafe_candidate`，聚合 `unresolved=0`；
- logistics data+runtime 最大 `5,148` UTF-8 bytes，100/100 小于 `32,768` bytes；
- bucket 100/100 为 `10000`，first 20 与 last 20 median 均为 `10000`；
- matcher 每个 epoch 只建一次索引，未出现 candidate budget exhaustion。

这些结果只证明既有可观察状态；它们不扩张为未 instrument 的瞬时 attempt 证明。

## CPU 正式失败

冻结 pre-p95 为 `4.172600`，110% 上限为 `4.589860`。首版 runtime 的 `captureUsed` 只覆盖 producer capture，遗漏交错 demand/fingerprint/legacy observation/merge/fee 与最终 reconcile/encode/attach 等仅由 Shadow 引入的 Synthesis 分段，因此本窗口能计算的最保守同口径下界为：

```text
oldGateLowerBound = cpuMonitor.latest.phases.resourceControl + logistics.cpu.captureUsed
```

对每个 tick 先求和、再取 nearest-rank p95，结果为：

```text
measured samples          100
oldGateLowerBound avg     4.542797
oldGateLowerBound p95     5.623637
oldGateLowerBound max    13.962051  (tick 73088610)
samples > 4.589860       33 / 100
```

post p95 相对 pre 增加 `34.7754%`，并高出允许上限 `22.5231%`。即使只使用不完整的 producer 下界也已正式失败，不能用单独的 outer ResourceControl p95 `3.683443` 或旧 `logistics.cpu.used` p95 `3.194000` 替代 gate。

后续规范归因为：

- `producerUsed`：Synthesis 中所有仅因 Shadow 发生的分段总和；
- `consumerUsed`：ResourceControl 内 Shadow decode/match/project 子区间；
- `shadowUsed=producerUsed+consumerUsed`：只用于定位 Shadow 自身成本；
- `gateUsed=完整 ResourceControl phase+producerUsed`：正式 rollout gate。`consumerUsed` 已包含在完整 ResourceControl phase 中，严禁再次相加。

归因升级后，cfg/data 继续为 schema v1，只有 logistics runtime 升为 schema v2。module-local tick-bound segmented meter 必须在既有 logistics runtime owner 分支持久化 exact `{attributionVersion,sampleTick,measurementAvailable,producerUsed,consumerUsed}`；正式 post 样本必须为 `attributionVersion=2`、`measurementAvailable=true`。CPU Monitor history 仍只提供 outer ResourceControl phase，不能新增第三个 Shadow analytics owner。正式 gate 必须把 runtime attribution 与同 tick CPU history outer phase、logistics `updatedAt` coherent 关联，不得从 `summary.latestTick` 或不同 tick 拼接。runtime v1 与旧 `{captureUsed,used}` 仅作历史兼容展示，不能进入新的 10+100 或倒填新 gate。

## 差异因果未闭环

100 条 `unsafe_candidate` 的复核结果：

- 其中 99 条是 E7N57 的 `UH2O/OH` demand。legacy 与 Shadow 都没有输出 route，差异维度为 route/headroom；同窗 E7N57 `terminalFreeCapacity=43,682`，低于 `receiverTerminalMin=50,000`。同步房间事实支持“Shadow 采用更保守 receiver veto”的解释，但 v1 sample 没有投影 exact blocker/candidate disposition，所以这只能算解释性证据，不能算机器因果闭环；而且双方无路线本就不应归类为 `unsafe_candidate`。
- 唯一另一个 `unsafe_candidate` 位于 tick `73087970`，demand 为 E5N59 `OH/O`：legacy donor/route 为 E3N59，Shadow unmatched，差异为 donor/route。v1 没有保存 Shadow unmatched exact reason、canonical candidate rejection counts 或 legacy-source disposition，无法事后判定为什么 E3N59 被拒绝。

因此 `unresolved=0` 只是旧分类器的结构结果，不等于所有差异已解释。修复后的 bounded sample 必须同时包含 `decisionDelta`、双方 outcome、amount/action/fee、起点 receiver eligibility/headroom，以及 candidate evaluated/feasible/rejected 与 exact rejection counts；当且仅当 legacy outcome 为 route 时，还必须包含与 legacy sourceRoom 一致的 disposition，legacy no-route 时该字段必须 absent/null not-applicable。已知 hard veto 的 no-route 应投影 `expected_policy_difference + shadow_more_conservative + primaryCause`；`unsafe_candidate` 只保留 Shadow 实际提出路线且与冻结 safety evidence 冲突的情况。

## Monitor 跨请求 torn read

原始 fetch 中出现 5 次 runtime attested data bytes 与随后读取的 data logistics 实际 bytes 不一致：

```text
tick 73087870  1639 / 1640
tick 73088240  1639 / 1640
tick 73088460  1639 / 1638
tick 73088640  1643 / 1644
tick 73088670  1642 / 1644
```

该模式符合 Monitor 跨请求落在相邻 producer epoch 的 torn read，不是游戏内 compact store 自身漂移。另有 3 次 analytics CPU latest 比 logistics runtime `updatedAt` 落后 10 tick，分别为 `73087760/73087770`、`73087930/73087940`、`73088510/73088520`（CPU/runtime）；这属于 CPU path 时序差，不能与更新后的 logistics runtime 拼成 gate 样本。

Monitor 必须采用有界 coherent pairing：以 runtime logistics `updatedAt` 和 compact `p` 中唯一 `synthesisControl:room` producer snapshot 的 `observedAt` 为 epoch，并验证 attested `dataBytes` 等于 data logistics 实际 UTF-8 bytes；配对后仍执行既有 compact canonical、producer total/emitted/dropped/truncated 与完整性校验，不增加新的 runtime producer attestation 字段。每轮固定读取 `R1 -> D -> R2`，D 与 R1/R2 任一端配对则采用对应端；初始 bracket 跨 epoch且无配对时，只允许再执行一轮完整 `R1' -> D' -> R2'`，总上限为 4 次 runtime 与 2 次 data 读取。第二轮仍跨 epoch时投影 `snapshotIncoherent=true/inconclusive=true/snapshotAttestationMatched=false` 与 retry/skew 并 fail closed；任一 bracket 内所有可读 R1/D/R2 epoch 相同、没有 epoch skew但 bytes 仍不等时，以 `snapshotIncoherent=false/inconclusive=false/snapshotAttestationMatched=false` 作为真实 attestation failure，不能启动下一轮。CPU gate 另要求 CPU history、attribution 与 runtime 为同一 tick。

## 回退证据与下一次门槛

- 回退 console operation：`6a84532996c1fe0013ce8993`。
- 验证 tick：`73089100`。
- live cfg：`{canaryScopes:[],schemaVersion:1,mode:"disabled"}`。
- runtime：`requestedMode=disabled`、`effectiveAuthority=legacy`、`available=false`、`complete=false`、`blocker=mode_disabled`；9 项 safety 均为 0，`violations=[]`。关闭态 unavailable/incomplete 是预期行为。

下一次 live gate 必须先部署补全 CPU 归因、差异因果和 coherent-read 的新 bundle，重新冻结同口径 disabled pre 基线，然后从零执行至少 10 warmup + 100 measured tick。旧窗口与新窗口不得拼接；旧 CPU、旧差异标签或离线补解释均不得追认为 8.5a/9.1a/9.4 通过。
