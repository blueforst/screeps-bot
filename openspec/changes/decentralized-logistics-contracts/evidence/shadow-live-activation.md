# Synthesis-only Shadow live 激活记录

## 受控配置变更

- 用户明确授权：将 live logistics mode 设为 `shadow`。
- shard：`shard1`。
- console operation：`6a843a4f0d475e0013a79b7a`，服务返回 `ok=1`、`insertedCount=1`。
- 写入表达式只在现有 `Memory.cfg.resourceControl.logistics` 上保留兄弟字段，并强制 `schemaVersion=1`、`mode="shadow"`；缺失时补 `canaryScopes=[]`。
- 验证到的 live 配置：

```json
{"canaryScopes":[],"schemaVersion":1,"mode":"shadow"}
```

token-authenticated `/api/user/memory` 当时仍为 HTTP 429，因此没有重试或使用 no-rate-limit 入口。最终验证改用用户已登录的 Chrome Screeps 页面，通过页面自身 Angular `$http` 认证拦截器执行两个精确只读 Memory path；没有读取、输出或复制浏览器 token/cookie。

## 首个有效 Shadow 快照

- deploy tag：`2026.8.18-3+06606da@2026-08-18T10:51:22.846Z`。
- runtime snapshot tick：`73087600`；`expiresAt=73087620`。
- `requestedMode=shadow`、`effectiveAuthority=legacy`。
- `available=true`、`complete=true`、`projectionTruncated=false`。
- in-scope：`synthesis_room=4`；out-of-scope：`synthesis_distributed_demand=4`。
- intent：total/active/fresh/paired/emitted 均为 `4`，stale/inputDrift/dropped 均为 `0`。
- comparison：`3 equal + 1 different + 0 unresolved`。
- 唯一差异为 `unsafe_candidate`：E7N57 的 UH2O/OH reagent，legacy donor 为 E7N58；差异维度为 donor/route。priority、coverage、receiver headroom、predicted staging 均一致。
- matcher：`indexBuilds=1`、`candidateEvaluations=8`、`budgetExhausted=false`。

可观察 safety 状态全部为零：

```text
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

Memory：data `2,430B`、runtime `2,556B`、合计 `4,986B`，`withinLimit=true`。Shadow 局部 CPU 投影为 capture `1.283`、total `3.138`。

CPU Monitor tick `73087620` 的 ResourceControl phase 为 `2.995784`，bucket `10000`。该单点低于冻结的 pre-p95 `4.172600` 与 110% 上限 `4.589860`，但单点不构成 p95 门槛证明。

## 后续 live gate 结果

本记录只证明 Shadow 激活与首个 epoch；后续已完成 10 warmup + 100 measured telemetry epochs，但正式 CPU 下界 p95 超过 110% 上限，且 v1 差异投影与 Monitor coherent-read 语义不足，因此 8.5a、9.1a、9.4 继续保持未完成，不授权 `canary/enabled`。完整数值与差异复核见 `shadow-live-100-sample-failure.md`。

mode 已于 tick `73089100` 回退为 `disabled`，console operation 为 `6a84532996c1fe0013ce8993`；验证配置为 `{canaryScopes:[],schemaVersion:1,mode:"disabled"}`，runtime 为 `requestedMode=disabled`、`effectiveAuthority=legacy`、`blocker=mode_disabled`，可观察 safety 继续为零。后续修复 bundle 必须重新冻结同口径基线并从零重跑 10 warmup + 100 measured，不得拼接或倒填本窗口。

## Shadow v2 重新激活（2026-08-19）

- 用户重新明确授权：开启 Shadow；未授权 `canary/enabled`。
- shard：`shard1`；console probe 在 tick `73104918` 确认 console 实际执行于 shard1。
- 当前 deploy tag：`2026.8.19-1+eb26197@2026-08-19T04:40:18.525Z`。
- console operation：`6a8536dc6b4b63001398a025`，服务返回 `ok=1`、`insertedCount=1`。
- 写入保留现有 logistics 兄弟字段并强制 `schemaVersion=1`、`mode="shadow"`；随后 Memory API 精确读回：

```json
{"canaryScopes":[],"schemaVersion":1,"mode":"shadow"}
```

首个完整 v2 epoch 为 tick `73104940`：

- `available/livenessAvailable/complete=true`，`snapshotAttestationMatched=true`，无 blocker、截断、torn read 或 inconclusive。
- 12/12 intents 全部 active、fresh、paired、emitted；stale/inputDrift/dropped/unresolved 均为 0。
- comparison 为 `8 equal + 4 expected_policy_difference`；causal code 为 `route_rank=1`、`source_protection=3`，没有 unsafe 或 unresolved。
- matcher `indexBuilds=1`、`candidateEvaluations=48`、`budgetExhausted=false`。
- data/runtime 合计 `14,698B`，`withinLimit=true`。
- CPU v2：producer `6.826`、consumer `3.172`、outer ResourceControl `6.944637`、正式 `gateUsed=13.770637`；bucket `10000`。

第二个只读确认 epoch 为 tick `73104970`：

- 12/12 intents 继续 fresh、paired，0 unresolved；comparison 为 `9 equal + 3 expected_policy_difference`，三项 causal code 均为 `source_protection`。
- matcher 继续单索引、无 budget exhaustion；Memory 合计降至 `13,766B`。
- CPU v2：producer `4.554`、consumer `1.860`、outer ResourceControl `5.055408`、`gateUsed=9.609408`；bucket `10000`。

两个 epoch 的 `effectiveAuthority` 均为 legacy，以下可观察记录持续为零：

```text
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
terminalClaims=[]
market safetyViolationCount=0
```

结论：Shadow v2 已成功重新激活，当前没有即时回滚条件；但前两个 warmup CPU 点均显著高于冻结的 `4.589860` 门槛，属于强预警而非通过证据。8.5a、9.1a、9.4 继续保持未完成；必须从本 bundle 重新取得完整 10 warmup + 100 measured 同 tick 样本，方可做正式结论。

## 后续 v2 10+100 gate 结果（2026-08-19）

本 bundle 的完整 10 warmup + 100 measured 窗口（tick `73111180..73112270`）已于同日完成：可观察 safety、Memory、bucket、结构配对与差异因果全部通过，但正式 CPU p95 `8.398820` 超出上限 `4.589860`（94/100 超标），9.4 判定失败；mode 已于 tick `73113300` 回退 `disabled`（operation `6a85a773fd36790013669c27`）。完整数值、新增 `receiver_capacity` causal code 记录与回退证据见 `shadow-v2-100-sample-failure.md`；冻结明细见 `shadow-v2-100-sample-metrics.tsv`。重新开启 Shadow 需要用户再次明确授权并按新 bundle 从零重跑。
