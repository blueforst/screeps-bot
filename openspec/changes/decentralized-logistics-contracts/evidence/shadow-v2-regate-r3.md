# Shadow v2 第三次重开窗口记录（2026-08-20，bundle 2026.8.20-2）

## 结论

用户明确授权后重开 Shadow。按规范先重新冻结 disabled pre 基线（p95 `3.110994`，110% 上限 `3.422093`），随后开启 Shadow 采集。**窗口在 16 个连续 epoch 后主动中止，未形成正式 10+100 判定，且本状态下正式窗口不可构造**，理由是双维度同时失败：

1. **CPU 数学不可达**：16/16 个 epoch 的 `gateUsed` 全部超上限（steady-state `5.246–9.900`，冷启动 epoch `19.856`；最小值为上限的 1.53 倍，中位数约 2 倍）；outer ResourceControl 分量单独（`3.047–5.343`）已达/超过上限。任何包含这 16 个样本的 100 样本窗口，其 nearest-rank p95 必然超限。
2. **配对口径阻断**：16/16 个 epoch 均含 `legacy_unpaired=1 + causal=no_donor` 差异（E1N57 `XLHO2/LHO2` 需求：legacy 因 `source_protection=6, same_room=1, feasible=0` 未行动，Shadow 宽松策略找到 donor，decisionDelta=`shadow_only_route`）。该类别不在冻结校验清单的合法 `byReason` 集合内（仅允许 `equal`/`expected_policy_difference`），因此每个样本都不可计为有效，10+100 有效窗口在当前需求状态下无法构造——与 `shadow-v2-regate-abort.md` 记录的类别一致，且本次证明其为持续性（16 连续）而非偶发。

mode 已回退并验证 `disabled`。本记录不更新 8.5a/9.1a/9.4 状态（三者保持未完成），不授权 `canary/enabled`。

## 基线冻结（同口径）

- disabled 模式、shard1、tag `2026.8.20-2+fbc442b@2026-08-20T05:21:01.858Z`，CPU Monitor `sampleInterval=10`；
- 14 个连续去重 ResourceControl 样本，tick `73129460..73129590`，cadence 校验通过；
- avg `2.495927`、p50 `2.446981`、p90 `3.021958`、**nearest-rank p95 `3.110994`**、110% 上限 **`3.422093`**；
- 原始只读采集：`monitor-data/shadow-v2-baseline3.jsonl`，SHA-256 `4c3ecf29c841a104fbc50dc44817b1d5a06bc27abd44243795b2378760ef5537`（不入库）；
- 14 值按 tick 序：`2.126830 / 2.545353 / 2.102796 / 3.021958 / 2.184892 / 3.110994 / 2.889415 / 2.188109 / 2.631580 / 2.179610 / 2.735235 / 2.446981 / 2.552740 / 2.226480`。

基线低于上一轮（`3.226146`），legacy 成本随需求状态波动；口径与原协议一致（disabled 下 Shadow `producerUsed=0`，outer phase 即 pre gateUsed）。

## 激活与观测

- 激活 console operation `6a86986bfd3679001367014f`（`ok=1`），Memory API 读回 `{"canaryScopes":[],"schemaVersion":1,"mode":"shadow"}`；
- 窗口期间 deploy tag 恒为 `2026.8.20-2+fbc442b@2026-08-20T05:21:01.858Z`（激活前、窗口后两次读回一致），单一 bundle；
- 16 个连续 epoch（tick `73129610..73129760`，cadence 10 校验通过），需求水位维持 8 intents/epoch；
- 每个 epoch 结构校验（除上述配对类别外）全部通过：schema v2、authority legacy、九项安全零、`unresolved=0`、matcher 单索引（`indexBuilds=1`、`candidateEvaluations=32`、`budgetExhausted=false`）、attestation 匹配、无 blocker/截断/inconclusive、Memory 合计 ~12.3KB（≤32KiB）、bucket `10000`、CPU 同 tick 对齐（`cpuTick===updatedAt`、`gateUsed=outer+producer` 双计排除 consumer）；
- 原始只读采集：`monitor-data/shadow-v2-gate-r3.jsonl`（24 次抓取、16 去重 epoch，含 1 次 mid-tick 未对齐记录被同 epoch 有效记录替换），SHA-256 `3ed994af0efe701198224ae3f4a65e8aa3da383e8500b9ed2c354822ccf75210`（不入库）；冻结明细见 `shadow-v2-regate-r3-metrics.tsv`。

三分量归因（剔除冷启动 epoch 73129610 后，n=15）：outer avg `3.852`（baseline 同期 legacy-only avg `2.496`，Shadow capture 在 outer 内新增约 `1.36`）、producer avg `3.013`、consumer avg `1.630`；gateUsed avg `6.864` vs 上限 `3.422093`。

## 中止决策依据

- 16 个连续完整 epoch 的 gateUsed 全部为上限的 1.53–5.80 倍；outer 与 producer 两分量各自单独超限或贴限（outer steady `3.047–5.343` vs cap `3.422`）；
- `legacy_unpaired + no_donor` 在 16/16 epoch 持续出现，冻结口径下样本全数无效，继续采集无法形成有效窗口，只消耗 API 配额（本日额度 1440，本窗口累计消耗约 210 次只读请求）；
- 与 `shadow-v2-regate-abort.md` 的结构性评估一致并进一步确认：在 8-intent 水位下 `gateUsed ≈ outer(含 capture) + producer ≈ 6.9`，上限 `3.42`，缺口为结构性（三分量叠加），producer 单侧优化不足以达标；新增第四维阻断为配对策略分歧（legacy 保守 donor 策略 vs Shadow 宽松策略的系统性 `shadow_only_route`）。

## 回退

- console operation `6a869ae1fd36790013670228`（`ok=1`）；
- 读回 cfg `{"canaryScopes":[],"schemaVersion":1,"mode":"disabled"}`；runtime `requestedMode=disabled`、`blocker=mode_disabled`、`effectiveAuthority=legacy`、九项安全计数全零、`violations=[]`。

## 下一步依据（不自行执行）

1. 与 regate-abort 相同：producer capture 与 legacy RC 索引共享、consumer 跨 epoch 复用、门槛经济学重估（intents 归一化或水位回落期重跑），任一路径均需结构改动 + 新 bundle + 重冻结基线 + 从零 10+100；
2. 新增：`legacy_unpaired/no_donor` 差异类别需要策略裁决——要么 legacy 收紧/放宽 donor 策略使两侧一致，要么在口径中把该类别论证为 expected（当前口径不允许），否则任何 CPU 达标的窗口仍会被配对校验阻断；
3. 重开 Shadow 仍需用户新的明确授权。
