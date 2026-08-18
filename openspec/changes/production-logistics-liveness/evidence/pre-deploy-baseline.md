# 部署前只读基线

## Hotfix `2026.8.18-2` 刷新

- 当前线上 bundle：`2026.8.18-1+1f3703e@2026-08-18T06:05:16.085Z`
- `-2` 首选线上回滚 commit：`1f3703e`；它已通过 assignment/protection/Market/CPU 两周期安全门槛，但仍包含下述 route progress reset，因此只作为热修部署故障时的短期恢复点。
- 更早已验证 bundle commit：`84a9cb0`。该版本同样包含自 `af1763dd` 起存在的 route overwrite/cancel-recreate 缺陷，不能作为修复该问题的方案。
- 首轮部署观察边界：A=`73083150`/rev9022、B=`73083200`/rev9023、C=`73083250`/rev9024；三轮均为 7 assignments/7 unique rooms、`invariantViolations=[]`、protection committed/valid/consistent，Market safety violation 为 0，bucket 为 10000。
- 首轮未通过完整 5.2：同一 LO route 在 B 为 `amount=817/remaining=101`，C 被同 ID 覆盖为 `830/830`；随后又出现取消/重建。`-2` hotfix 必须从新的 A/B/C 重新计两个完整 `planInterval`，不得复用首轮窗口。
- `-2` live 验收除 Monitor 外必须读取 raw `data.resourceControl.tasks` 与 `runtime.resourceControl.lastActions`；只有出现跨 revision 同 ID route witness 才能宣称 progress 语义已线上触发，否则记录 `not-exercised`。

## 采集边界

- 采集时间：`2026-08-18T05:47:50.028Z`
- shard：`shard1`
- 游戏 tick：`73082815`
- 当前线上 bundle：`2026.8.17-1+84a9cb0@2026-08-17T12:23:15.202Z`
- 本地实现基线 / 工作树回滚点：`a8530c50113164b9f65c73a3cb444bc50743091e`
- 若后续部署本 change，线上回滚目标是当前已验证 bundle commit `84a9cb0`；回滚后必须重新只读确认 deploy tag。
- 本轮只执行 `npm run monitor:once` 和三个 `GET /api/user/memory` 路径读取；未运行 console probe、Memory 写入、上传或部署。

## 跨房任务与容量

当前只有一个 pending automatic transfer：

```text
id=73079550:1:XGH2O:E7N57->E4N58
reason=hub:reclaim:XGH2O
remaining=2390
age=3260
blocker=insufficient_terminal_resource_or_fee
blockerAge=3260
lastProgressAge=3260
```

E7N57 terminal Energy 为 `19,505`，低于 `20,000` reserve；terminal free capacity 为 `48,830`，低于 `60,000` desired headroom。ResourceControl 报告 `eligibleReceiverCount=7`，仅一房因 `terminal_headroom` 排除。这是本 change 部署后 coverage/liveness 对照的主要样本，不应误写成全局 storage shortage。

旧 bundle 尚无新 taskSummary 字段，Monitor 正确投影：

```text
livenessAvailable=false
demandCoveringIncoming=null
coverageExpiredIncoming=null
coverageExpiredByReason=null
```

## Hub、合成配置与保护

- Hub status：`importing`
- protection revision：`9015`
- committed protection：`valid=true`、`consistent=true`、planMode=`distributed`
- 旧 runtime 有 8 个 dispatch assignments，按 roomName 检查无重复房间。
- 8 个 synthesis room config 的 `plannerOwnership` 均缺失；`blockedTargets`、`invariantViolations`、`configReconcile` 也缺失。这是旧 bundle 的预期兼容状态，不能当作“零违规已通过”。
- 当前 stages：7 房 `synthesizing`，E7N58 为 `synthesizing` 且有 1 个 pending task，E4N58 为 `synthesizing` 且有 1 个 pending task；W1N57 仍为 `unloading`，`lastError=lab_contaminated_waiting_clear`。

## CPU / bucket 基线

- 120 tick `resourceControl` 平均 CPU：`3.059171183333577`
- 最新 tick `resourceControl` CPU：`2.7317160002421588`
- 最新 tick `hubPlanner` CPU：`0.025439699878916144`
- 120 tick总 CPU 平均：`94.42547100332061`
- bucket：`10000`

这些数值只构成部署前观察，不是 post-change 性能证明。部署后必须使用同一 shard、稳定 deploy tag 和可比窗口观察至少两个 Hub `planInterval`。

## 明确 live 门槛

本 change 尚未部署。未经用户明确 deploy gate，不执行 `npm run push`。部署后仍需验证：

1. coverage-expired automatic task 不再占 demand，旧任务按机器原因取消，且同一需求没有两个 active coverage；
2. 每个 assignment room 唯一，foreign/ownerless config 不被误删，Hub-owned revision 单调；
3. committed protection 继续 valid/consistent；
4. Terminal/Market action 数量与既有 arbiter ownership 无新增旁路；
5. ResourceControl/Hub CPU 与 bucket 相对本基线无显著回退。
