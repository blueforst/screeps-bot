# 变更前基线

## 当前线上滚动摘要

采样时间：2026-08-17T11:04:56.907Z；`selectedShard=shard1`；latest tick `73065885`；deploy tag `2026.8.13-2+0750c6e@2026-08-13T08:40:31.431Z`。

`Memory.analytics.cpuMonitor` 的当前 120 样本滚动摘要：

- total CPU：mean `97.09838941336105`，max `163.9010768001899`，EMA `96.42653249381542`
- `creepWork`：mean `40.09928867250952`
- `creepWork:pathing`：mean `22.524422526633135`
- `creepWork:decision`：mean `3.433047009051855`
- bucket：mean/min 均为 `10000`
- 最新 tick 的最高 room-role 是 E5N59 的一个 `remoteMiningCarrier`：`11.257684299955145` CPU

该摘要是当前线上窗口的主基线，但只提供 mean/max，不提供该窗口的 p50/p95。

## 本地历史分布补充

对 `monitor-data/snapshots.jsonl` 按 cpu sample tick 去重并取最后 120 个已有采样点，范围为 tick `72864030..73065880`：

- pathing：mean `18.32018669000331`，p50 `16.05448779999915`，p95 `42.116478299722075`，max `62.852331099995354`
- total：mean `103.52829297750576`，p50 `98.81871630004025`，p95 `159.2956688000013`，max `212.4172919000001`
- bucket min `9883`

这些点横跨多个版本和世界状态，不是当前 deploy 的连续 120 样本窗口，不能用于因果前后比较；只用于说明 pathing 存在长尾。部署后 p50/p95 必须从同一新版本收集的完整新窗口重新计算。

## 静态调用链

```text
gameLoop
  -> creep.work
  -> remoteMiningCarrier / remoteCarrier / remoteWorker / ...
  -> moveToTargetRoom
  -> moveAlongMultiRoomPath
  -> PathFinder.search(maxOps=10000)
  -> 仅消费 search.path[0]
```

`moveToTargetRoom` 只为 Colonization fixed route 尝试持久 `cachedTravelPath`。普通动态跨房调用即使传入 `reusePath=10`，成功的 multi-room search 也不会保存 path，所以下一 tick 会重新执行完整 search。

## 证据口径

- Screeps CPU 收益只能由同 shard、同 deploy 窗口的 profiler/monitor 证明。
- Jest 中 `PathFinder.search` 的调用次数用于证明算法工作量从“每 tick 一次”收敛为“每房间 segment 一次”。
- Node/Jest wall-clock、构建耗时和历史混合快照不得写成线上 CPU 改善。
