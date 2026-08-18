# Synthesis-only Shadow 部署前基线

## 采集边界

- 采集时间：`2026-08-18T08:29:05.530Z`
- shard：`shard1`
- 游戏 tick：`73085255`（ResourceControl/CPU 样本 tick `73085250`）
- 线上 tag：`2026.8.18-2+7384afb@2026-08-18T07:27:22.237Z`
- 当前本地 HEAD：`722ed8446ab1c1a346c2f77ad72970be5397558e`；该提交仅增加上一阶段验收文档，线上 bundle 对应代码 commit 仍为 `7384afb`
- 本轮只执行 Monitor、Git ancestry、bundle source/hash 与 OpenSpec 只读检查；没有写入 Game/Memory，也没有上传。

## P0/P1 运行基线

`production-logistics-liveness` 已完成并通过两个完整 Hub `planInterval`。本次复核仍为：

- Hub attempt `9064/inc1`，protection committed/valid/consistent，四组件 revision/incarnation/fingerprint 一致；
- `invariantViolations=[]`，config reconcile revision 为 `9064`；
- ResourceControl `capacityIndexBuildCount=1`；
- pending automatic task `5`、demand-covering incoming `5`；已出现 1 个 `automatic_source_depleted_timeout`，说明 canonical coverage reconciliation 仍在工作。

当前 receiver 状态：

```text
eligibleReceiverCount=7
receiverExcludedByReason={terminal_headroom:1}
```

8 房均为 `capacityState=normal`。E3N59、E7N57、W1N57 仍分别展示 `carrier_backlog`/`storage_full` 粘滞原因，未完成 offload 没有被提前计作 headroom。该数据可作为纯 Shadow 的只读容量比较输入，但不倒填 `terminal-headroom-recovery` 6.4：其专用连续恢复窗口仍未按原协议完成，任何 CapacityLease/contract authority canary 在该门槛关闭前禁止启用。

## CPU / Memory 门槛

当前 CPU Monitor 有 93 个部署后样本：

- ResourceControl 平均：`2.9601500645`
- 最新 ResourceControl：`2.7725115000`
- 最新 SynthesisControl：`1.2790960000`
- 最新 HubPlanner：`6.7196974000`
- 总 CPU 平均：`94.2224299118`
- bucket：`10000`（93 样本平均 `9998.62`，最低 `9872` 来自部署初始化样本）

Shadow live gate 使用相同 shard、稳定 tag、剔除 warmup 后至少 100 个连续可观测 tick。ResourceControl/Shadow p95 不得高于本次可比部署前窗口 10%，bucket 不得持续下降；`Memory.data.resourceControl.logistics` 与 `Memory.runtime.resourceControl.logistics` 序列化合计硬上限为 32 KiB。

部署前 runtime/data 均没有 `resourceControl.logistics`，Monitor 不得把字段缺失投影成空成功。

### 冻结的 ResourceControl pre-p95

为给后续纯 Shadow 窗口提供同口径上界，另冻结了一段未启用 logistics 的连续 Monitor 采样：

- 采集时间：`2026-08-18T09:19:31.177Z` 至 `2026-08-18T09:27:43.330Z`；
- CPU Monitor `sampleInterval=10`，共取得 14 个连续且去重的 ResourceControl 样本，tick `73086020` 至 `73086150`；
- 平均值：`2.302213`；nearest-rank p50：`2.071216`；p90：`3.339156`；
- nearest-rank pre-p95：`4.172600`，因此后续 `post p95 <= pre * 1.10` 的数值上限为 `4.589860`；
- 原始只读采集文件 SHA-256：`ddbff057851f88cb067d293fe68b081df7514b70a547ccc28a9ac1dd51503765`。

14 个值按 tick 顺序为：

```text
73086020 2.030145
73086030 1.676002
73086040 1.505066
73086050 2.317051
73086060 2.565206
73086070 1.694281
73086080 1.742445
73086090 1.817997
73086100 3.339156
73086110 2.362999
73086120 2.634292
73086130 2.071216
73086140 4.172600
73086150 2.302521
```

这段窗口只冻结部署前比较基准；它不替代部署后的 10 warmup + 100 measured tick，也不使 8.5a/9.4 自动完成。采集随后遇到 HTTP 429 即停止，没有使用绕过限流的凭据或继续请求。

## 冻结 Memory 边界

四个 canonical Memory branch 继续由 `test/memoryDeclarationBoundaries.test.ts` 冻结：

- cfg fingerprint：`37b13b84da74a619425e5188a485601d0c738891102f40d64d463355d6ae19f7`
- runtime fingerprint：`87e699ad2b4cc8504207669f9ab96109b46f4d0e5f26fd78086ef8ab4ea8ee1b`
- data fingerprint：`6dd4c88049dfdf31f86acb4d8095f219c068d9c0ccd735a283671d1dd9661bcb`
- analytics fingerprint：`8dc56bc39214dd02906c02dba674664c2a2441d01a341a7d1a4bff1993f97245`

本变更只能通过 `Memory.cfg/data/runtime.resourceControl.logistics` 的模块局部 intersection adapter 接入，不修改上述声明或 fingerprint。

## Local Dispatch 实际部署状态审计

`local-dispatch-ownership` 的实现 commit 为 `b76d4db7855e448192a9133675900084a8191da1`。只读审计结果：

- `git merge-base --is-ancestor b76d4db 7384afb` 返回 0；当前线上代码是该实现的后继；
- 线上 `default/main` 与本地 `dist/main.js` 均为 `3,979,178` bytes，SHA-256 均为 `aa3ceb79c897c576ed2e8b43ba292776503587ef080f9154641e564e952db4f0`；
- source map 包含 `dispatchOwnership/ref.ts`、`actorBinding.ts`、`workerSlot.ts`、`carrierAmountSlice.ts`、`carrierTaskBoard.ts` 与 `roles/carrier.ts`；TaskSystem runtime/model 未进入 bundle；
- 当前线上 8 房、9 Carrier、bucket `10000`，证明该完整 bundle 正在 shard1 运行。

因此旧 change 中“代码未部署”的现时描述已漂移。其专用 10 warmup + 90 measured rollout probe 没有追溯执行，8.1–8.4 不能倒填为完成；本 change 只把完整 `CarrierDispatchRef`、owner-aware board 和 `CarrierAmountSlicePort` 视为已部署基线，不再执行所谓首次全量切换。

## 首片零执行权门槛

Synthesis-only Shadow 上线前后必须保持：

- legacy task/executor 是唯一 `executionAuthority`；
- active contract、CapacityLease、StageWorkClaim 均为 0；
- Shadow 新增 terminal/market actor、claim、send/deal 均为 0；
- input 在 legacy task write 前冻结，或只按精确 task identity/本轮 delta self-exclude；
- matcher/comparator 的候选、详情、字符串与 Memory bytes 全部受硬上限约束；
- 任何未配对、输入漂移、超预算或 out-of-scope producer 均输出机器 reason，不得计作算法一致。
