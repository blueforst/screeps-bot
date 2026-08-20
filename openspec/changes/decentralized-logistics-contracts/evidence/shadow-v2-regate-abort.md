# Shadow v2 re-gate 中止记录（2026-08-20，bundle 2026.8.20-1）

## 结论

用户授权后在优化 bundle `2026.8.20-1+2bb3aa5@2026-08-20T04:55:10.965Z` 上重跑 live gate。按规范先重新冻结 disabled pre 基线（`3.226146`，110% 上限 `3.548761`），随后开启 Shadow 采集新窗口。**窗口在 3 个 epoch 后主动中止，未形成正式 10+100 判定**：连续 4 个可观测 epoch（含重激活 epoch）的 `gateUsed` 全部为上限的 2.6 倍以上，且 outer ResourceControl 与 producerUsed 两分量各自单独超限——在当前需求水位（8 intents/epoch）下该门槛在数学上不可达，继续采集只消耗配额。mode 已回退并验证 `disabled`。

## 新基线冻结（同口径）

- disabled 模式、shard1、tag `2026.8.20-1+2bb3aa5`，CPU Monitor `sampleInterval=10`；
- 14 个连续去重 ResourceControl 样本，tick `73128650..73128780`，cadence 校验通过；
- avg `2.745246`、p50 `2.730239`、p90 `3.110219`、**nearest-rank p95 `3.226146`**、110% 上限 **`3.548761`**；
- 原始只读采集：`monitor-data/shadow-v2-baseline2.jsonl`，SHA-256 `3304327438dfce81ebad30e8c027000200f715ffc19a1cc335fe0162ce89d3e1`（不入库）；
- 14 值按 tick 序：`2.710582 / 2.787961 / 3.110219 / 2.353125 / 2.988172 / 2.281351 / 3.226146 / 2.841915 / 2.730239 / 3.107789 / 2.760059 / 2.713269 / 2.373802 / 2.448815`。

基线低于旧窗（`4.172600`）与同 bundle 的 strict-read 优化及环境差异一致；口径与原协议一致（disabled 下 Shadow `producerUsed=0`，outer phase 即 pre gateUsed）。

## 激活与观测

- 激活 console operation `6a868ccafd3679001366fd37`（`ok=1`），Memory API 读回 `{"canaryScopes":[],"schemaVersion":1,"mode":"shadow"}`。
- 重激活 epoch `73128800`：schema v2、authority legacy、九项安全零、`cpuGateEligible=true`、producer `10.132` / consumer `6.725`（冷启动）。
- 窗口 epoch `73128810`、`73128820`（另含 `73128800`）：

```text
tick      intents  outerRC   producer  consumer  gateUsed   (上限 3.548761)
73128800      8     9.6388    10.132     6.725    19.7708
73128810      8     4.9413     4.560     1.873*    9.5003
73128820      8     5.3469     3.932     1.993*    9.2789
* consumer 由 outer 差值近似，仅作参考
```

- 全部 epoch 结构校验通过（paired 8/8、unresolved=0、attestation 匹配、matcher 单索引、Memory 合计 ~7.5KB、bucket 10000）。
- **差异新类别**（记录、不静默接受）：E1N57 `XLHO2/LHO2` demand 为 `legacy_unpaired + shadow_only_route + shadow_more_permissive + causal=no_donor`——legacy 未行动而 Shadow 有可行 donor（`evaluated=8, feasible=1, source_protection=6, same_room=1`）。机器证据完整，但 `legacy_unpaired` 不在已知合理类别集合内，且 9.4 要求 "in-scope legacy 全部配对"；若正式窗口出现该类别，按现有口径不能计为通过样本。
- 中止决策依据：3+1 个 epoch 的 gateUsed 为上限 2.6–5.6 倍；outer（4.94–9.64）与 producer（3.93–10.13）各自单独超上限 `3.548761`；intents 由旧窗 4 升至 8。窗口未完成 10+100，本记录不构成正式 p95 判定，也不更新 8.5a/9.1a/9.4 状态。

## 回退

- console operation `6a868d9c6b4b630013994192`（`ok=1`）；
- 读回 cfg `{"canaryScopes":[],"schemaVersion":1,"mode":"disabled"}`；runtime `requestedMode=disabled`、`blocker=mode_disabled`、`effectiveAuthority=legacy`、九项安全计数全零、`violations=[]`。

## 结构性评估（下一步依据）

当前 8-intent 水位下 `gateUsed ≈ legacy outer 2.75 + shadow consumer ≈1.9 + producer ≈4.2 ≈ 8.8`，上限 `3.549`——**三项分量都需要结构性削减**，producer 单侧优化（本轮已 -26%~-46%）不足以达标：

1. **producer**（~4.2 @8 intents）：进一步削减需让 capture 与 legacy ResourceControl 索引共享快照/容量上下文（当前每 epoch 重复扫描），属结构改动。
2. **consumer**（~1.9 @8 intents）：matcher/projection 随 intents 线性，可做索引跨 epoch 复用。
3. **legacy outer**（~2.75）：与 Shadow 无关的既有成本，是基线本身。
4. 或重新评估门槛经济学（如 intents 水位回落时重跑、或按 intent 数归一化），需用户决策。

### 顺带排查的全局优化点（不属 gate，属总 CPU 预算）

- **market 复杂体 ~42 CPU/tick（总预算 ~94 的 45%）且零成交**：`marketSaleAutomation` avg 34.9 + `marketSalePreflight` avg 7.4；base V3 planning 每 10 tick 全量扫订单簿（19–22 CPU）却持续 `market_base_no_writable_lane`；direct-continuous planning 已 stale 375,890 tick（blocker `continuous_candidate_scope_unknown`），三条 lane 全部 not_safe/suspended、quota used=0。建议作为独立优化/spec 工单处理。
- `creepWork` avg 35.0（pathing 17.5 / intent 9.9）为最大单项，涉及移动层缓存策略，风险中等。

## 下一次窗口

- 若继续追求 9.4，需先完成上述结构性削减并部署新 bundle，再重新冻结基线、从零 10+100；本中止窗口不得拼接或倒填。
- 重开 Shadow 仍需用户明确授权。
