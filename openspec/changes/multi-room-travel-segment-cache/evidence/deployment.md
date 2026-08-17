# 部署与初始运行证据

## 部署前

- 只读快照时间：2026-08-17T12:20:39.141Z
- shard / tick：`shard1` / `73067025`
- 旧 tag：`2026.8.13-2+0750c6e@2026-08-13T08:40:31.431Z`
- CPU 120 样本：total 平均 `93.0529`，pathing 平均 `18.6077`，creepWork 平均 `36.1466`
- bucket：平均/最小均为 `10000`
- 最近样本：tick `73067020`，total `147.7636`，pathing `59.8949`，creepWork `77.9438`

## 提交与上传

- 版本：`2026.8.17-1`
- 实现提交：`84a9cb084704b68714f84fde403eb30784091e0c`
- 提交主题：`perf(movement): cache multi-room travel segments`
- `npm run push`：Rollup 成功，API 确认上传 1 个 module 到 Screeps `default` branch
- 未修改线上 Memory、route、telemetry 或 profiler 配置

## 首次只读运行确认

- 快照时间：2026-08-17T12:23:43.101Z
- shard / tick：`shard1` / `73067070`
- 新 tag：`2026.8.17-1+84a9cb0@2026-08-17T12:23:15.202Z`
- 首个 CPU 样本：tick `73067070`，bucket `10000`，total `92.1523`，pathing `23.9735`，creepWork `39.8671`
- 未观察到立即 bucket、主循环或 deploy-tag 异常，因此未触发回滚

## 初始证据边界

- 后续快照 `2026-08-17T12:26:07.013Z` 显示 global-reset 后已有 3 个纯新版本 CPU 样本：total 平均 `125.6291`、pathing 平均 `22.3467`、creepWork 平均 `39.0614`，bucket 平均/最小仍为 `10000`。
- 最近样本 tick `73067100`：total `151.3439`、pathing `21.0702`、creepWork `36.6632`；该 tick 的 total 尖峰主要来自 MarketSaleAutomation `68.1628` 与 HubPlanner `20.8001`，不能归因于本 change。
- 3 个样本不足以宣称 CPU 改善或回归；当前只支持“新版本持续执行、bucket 无压力、creepWork/pathing 未出现同步失控”的初步结论。
- external telemetry 保持关闭，monitor 未投影 heap-only movement search/hit/invalidation；本轮遵守“不修改线上配置”门禁，没有为取数临时开启 telemetry。

## Heap-only movement 只读验收

- 通过既有 Screeps console 只读表达式读取 `global.__movementAnalytics`，未写 Memory、route、telemetry 或 profiler 配置。
- tick `73067156`：travel requests `715`，multi-room searches `294`，segment hits `420`，invalidations `1`，fallbacks `0`，travel repaths `204`，exit recoveries `20`。在可比的 search/hit 请求中，segment hit ratio 为 `58.82%`。
- tick `73067330`：travel requests `2229`，multi-room searches `738`，segment hits `1487`，invalidations `10`，fallbacks `0`，travel repaths `400`，exit recoveries `71`。segment hit ratio 升至 `66.83%`；invalidation/travel request 为 `0.45%`，未观察到失效抖动或 fallback 增长。
- tick `73067175` 的到达态检查曾发现 1 条 `currentRoom` mismatch、0 条 expired segment；跨越 cleanup 周期后，tick `73067309` 为 traveling `10`、segments `6`、stuck actors `3`、mismatches `0`、expired `0`，该 mismatch 已按预期释放。
- tick `73067319` 的 3 个 stuck actor 均为 `segment: null`，说明 stuck 门禁会退出 segment cache；现有 repath/exit recovery 活动没有伴随 segment 持有或 invalidation/fallback 异常。
- 以上证据支持完成初始运行安全门禁 4.2，但只覆盖部署后的短窗口，不能替代完整 CPU 统计验收。

## 完整 120 样本验收

- 最终只读快照：`2026-08-17T13:50:30.683Z`，shard1 tick / CPU tick `73068390`；deploy tag 仍为 `2026.8.17-1+84a9cb0@2026-08-17T12:23:15.202Z`。
- CPU monitor 已填满 `120/120`，采样间隔 `10` ticks；最新 total `71.8481`，bucket `10000`。

同一 Memory CPU summary schema 的连续窗口均值（部署后窗口截止 CPU tick `73068390`）：

| 指标 | 部署前 120 | 部署后 120 | 变化 |
| --- | ---: | ---: | ---: |
| `creepWork:pathing` mean | `18.6077` | `15.1941` | `-18.34%` |
| `creepWork` mean | `36.1466` | `32.4203` | `-10.31%` |
| total mean | `93.0529` | `90.8679` | `-2.35%` |
| bucket mean / min | `10000 / 10000` | `10000 / 10000` | 不变 |

- 为使分位数可独立复算，`2026-08-17T13:58:33.251Z` 又以只读 console 固化当时 `global.__cpuMonitor.history` 的完整 ring 到 [`post-deploy-cpu-window.json`](post-deploy-cpu-window.json)。该文件保存 tick `73067320..73068510` 的 120 条唯一连续记录、deploy tag、采集边界，以及 median 和 nearest-rank p95 算法；没有写入线上 Memory/config/telemetry/profiler。
- 可复算 raw window 的 pathing mean / p50 / p95 / max 为 `16.5467 / 14.2800 / 37.3625 / 60.9995`；creepWork 为 `33.7360 / 31.8033 / 55.3331 / 78.8984`；total 为 `91.5031 / 88.9372 / 118.2846 / 131.3724`；bucket 的 mean / p50 / p95 / min / max 均为 `10000`。
- 部署前连续 120 summary 没有持久化原始 history，因此不能重建严格同窗口的旧 p50/p95。`pre-change-baseline.md` 中跨版本、跨世界状态历史去重窗口的 pathing p50 / p95 为 `16.0545 / 42.1165`；新 raw window 方向上分别低 `11.05% / 11.29%`，但该比较不是同版本因果 A/B，不能作为收益归因依据。

世界负载并非完全同构：

- 监控房间数保持 `8`；Worker `7 → 9`，Carrier `8 → 8`。
- stored Energy `1,653,501 → 1,619,439`，source Energy `21,040 → 32,700`。
- CPU monitor 的平均 fixed-action estimate `11.3283 → 10.5900`，下降约 `6.52%`。

## 验收结论

- pathing 与 creepWork 在完整新窗口中均明显低于部署前连续窗口，bucket 全程满值，且前述 heap search/hit/invalidation、stuck/repath/exit recovery 没有安全异常；无需触发回滚。
- 世界行为负载存在变化，尤其 fixed-action estimate 较低，因此不能把全部 CPU 差值纯归因于 segment cache；可确认的是本版本在当前世界负载下同时取得较低 pathing/creepWork 与安全 bucket。
- Task 4.3 的完整窗口、分位数、bucket 与世界负载比较已完成；本 change 已满足归档前证据门禁。
