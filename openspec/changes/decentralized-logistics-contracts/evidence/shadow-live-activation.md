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

## 尚未完成的 live gate

本次记录证明 mode 已生效、首个 epoch 完整、execution authority 未变化且可观察副作用记录为零。它不替代剔除 10 warmup 后至少 100 个连续 measured CPU 样本：8.5a、9.1a、9.4 继续保持未完成，也不授权 `canary/enabled`。

若任何后续门槛失败，最小回退是把同一配置的 `mode` 设回 `disabled`；本次未执行回退。
