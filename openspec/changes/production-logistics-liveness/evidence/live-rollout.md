# 线上部署与验收

## 部署记录

- shard：`shard1`
- 初版 commit：`1f3703e`（`fix(production): harden cross-room logistics liveness`）
- 初版 tag：`2026.8.18-1+1f3703e@2026-08-18T06:05:16.085Z`
- hotfix commit：`7384afb`（`fix(hub): preserve synthesis route progress`）
- 最终验收 tag：`2026.8.18-2+7384afb@2026-08-18T07:27:22.237Z`
- hotfix 故障时首选回滚 commit：`1f3703e`；更早稳定点为 `84a9cb0`

初版在保护快照、assignment 唯一性、Market 安全与 CPU 门槛上通过，但 raw transfer task 暴露同一 LO route 从 `817/101` 被覆盖为 `830/830`，随后取消并重建。由于该问题会抹掉已交付进度并造成跨周期翻摆，首轮 A/B/C 没有用于关闭 5.2，而是执行 `7384afb` roll-forward hotfix 后重新计时。

## Hotfix A/B/C 窗口

当前 Hub `planInterval=50`。选择三个常规边界：

| 边界 | tick | attempt revision | snapshot | assignment |
|---|---:|---:|---|---|
| A | `73084350` | `9046/inc1` | `observedAt=73084350`、`expiresAt=73084400`、committed/valid/consistent | `6/6` room 唯一 |
| B | `73084400` | `9047/inc1` | `observedAt=73084400`、`expiresAt=73084450`、committed/valid/consistent | `6/6` room 唯一 |
| C | `73084450` | `9048/inc1` | `observedAt=73084450`、`expiresAt=73084500`、committed/valid/consistent | `6/6` room 唯一 |

A→C 为 `100 tick`，严格覆盖两个完整 `planInterval`。三次 attempt 均在边界 tick 内开始并结束；四个 protection component 的 revision、incarnation 与 fingerprint 一致；`invariantViolations=[]`，`configReconcile.revision` 与 attempt revision 一致。ownerless/manual 配置继续列入 `foreignOwnerRooms` 并被保守保留，没有观察到越权覆盖。

## Route progress 原始账本

验收联合读取 Monitor、`runtime.hub`、`data.resourceControl.tasks`、`runtime.resourceControl` 与 Market journal，不以 Monitor 的 `remainingAmount` 单字段替代 progress 证明。

### 正增量与零增量连续性

同一 LO task 全窗保持 ID：

```text
73084200:2:LO:E3N59->E7N58
reason=synthesis:direct:LO
```

| 时点 | route decision | amount | remaining | delivered | updatedAt | lastProgressAt | status |
|---|---:|---:|---:|---:|---:|---:|---|
| A 前 | — | `1461` | `1461` | `0` | — | `73084200` | pending |
| A | `+1173` | `2634` | `2634` | `0` | `73084350` | `73084200` | pending |
| B | `0` | `2634` | `2634` | `0` | `73084350` | `73084200` | pending |
| C | `0` | `2634` | `2634` | `0` | `73084350` | `73084200` | pending |

A 的 `amount` 与 `remaining` 同增 `1173`，delivered 不变且 planner refresh 没有伪造 `lastProgressAt`。B/C 均无新 LO decision；同一 ID 被继续保留，没有 `cancelled_by_replan`、重复 active key、重建或 sawtooth。该任务因 E3N59 terminal energy 仅略高于 reserve，持续阻塞于 `insufficient_terminal_resource_or_fee`，因此 LO 成功发送分支未触发。

### 真实发送旁证

OH task `73084350:1:OH:E5N59->E7N58` 在 A 新建 `amount=547`；到 tick `73084370` 变为 `remaining=0`、`delivered=547`、`lastProgressAt=updatedAt=73084370`。这证明 ResourceControl 发送路径存活，且 progress 时间只随真实成功 send 推进。B/C 没有同键 active task，也没有 delivered 回退。

## Liveness、Market 与 CPU

- A/B/C 的 task summary 均为 `livenessAvailable=true`、`coverageExpiredIncoming=0`、`coverageExpiredByReason={}`；C 有 5 个 pending automatic task，按 destination/resource 检查没有重复 active demand。
- Market 在窗口内始终 `terminalClaims=[]`、`safetyViolationCount=0`；journal 最新成功动作仍为旧 tick `72604730`，部署窗口没有新增 Market 写入或旁路 Terminal side effect。
- global reset 首样本 tick `73084330` 为 `189.685 CPU / bucket 9872`，不纳入稳态结论。随后 bucket 恢复并在 A→C 保持 `10000`。代表样本：A 后 tick `73084370` 总 CPU `102.98`，B 后 tick `73084430` 为 `79.16`，C 精确 tick `73084450` 为 `97.41`；C 的 Hub/Synthesis/ResourceControl 分别为 `5.910/0.327/1.878`。未观察到持续 CPU 或 bucket 退化。

## 未自然触发的分支

- 默认 receiver-capacity coverage grace 为 `500 tick`，本窗口只有 `100 tick`，因此 coverage expiry 与其机器 reason 记为 `not-exercised`；确定性测试覆盖该路径。
- 旧 Hub endpoint、distributed-storage non-T3 surplus、已知不兼容/已知清空 direct consumer 在本窗口没有自然状态切换，记为 `not-exercised`；由聚焦回归锁定。
- same-revision helper replay 不在当前单 caller 主循环路径中，本窗口未触发；其持久幂等键留给后续 TransferContract provenance。

## 结论

`2026.8.18-2+7384afb` 通过两个完整 Hub 规划周期的 live 门槛：route 增量与交付进度单调、zero-delta commitment 不误取消、active demand 唯一、assignment room 唯一、protection consistent、Market/Terminal 无新增旁路，CPU 无显著回退。OpenSpec 5.2 可以关闭。
