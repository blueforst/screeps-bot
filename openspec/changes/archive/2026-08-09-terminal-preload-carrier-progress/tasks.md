## 1. 分类与优先级测试

- [x] 1.1 覆盖 classified capacity relief 在普通 Energy前执行，以及同producer无class/其他producer不被提升
- [x] 1.2 覆盖隐藏 Tower、active idle Spawn、all-busy active Spawn与inactive Spawn边界
- [x] 1.3 覆盖 board/direct PowerSpawn、Nuker Ghodium及既有专用顺序
- [x] 1.4 覆盖capacity Energy payload/fee不受房间watermark二次门控，且不夹带普通reserve/market readiness

## 2. 数量、公平与状态测试

- [x] 2.1 覆盖双Carrier同tickstep amount claim与Terminal destination capacity claim
- [x] 2.2 覆盖一次accepted relief后让给普通Energy/board，且out-of-range期间不在两来源间振荡
- [x] 2.3 覆盖withdraw失败fallback、out-of-range及same-id去class刷新后stale Energy不误送Terminal
- [x] 2.4 覆盖accepted snapshot在task刷新/删除后仍投递原Terminal

## 3. 最小实现

- [x] 3.1 为CarrierTask增加heap-only dispatch class，并仅由capacity staging admission发布
- [x] 3.2 在即时安全需求之后、普通Energy之前接入classified pickup
- [x] 3.3 为classified feed复用task amount与local destination capacity claim
- [x] 3.4 添加heap-only单次yield状态，并从后台filter排除classified relief
- [x] 3.5 选择性清理未接受classified assignment，保留accepted snapshot

## 4. 验证与独立复核

- [x] 4.1 运行Carrier、EnergyTargets、CarrierTaskBoard、ResourceControl/Capacity及相关消费者聚焦测试
- [x] 4.2 运行TypeScript、全量Jest、build、OpenSpec strict与diff check
- [x] 4.3 独立复核安全优先级、claim释放、公平状态与非目标producer兼容性

## 5. 部署与线上观察

- [x] 5.1 提交并部署同一已验证commit，记录父提交与deploy tag
- [x] 5.2 观察E7N58实际领取L、搬入Terminal并完成跨房发送
- [x] 5.3 确认Spawn/Extension/Tower供能、CPU及其他房Carrier board无严重回归
- [x] 5.4 评估严重异常与父提交回滚条件；本次未触发回滚

## 6. 线上验收记录

- 实现提交为 `4cb1bc8c9ae1cecc25ce13684cf9ce128a822789`，父提交/回滚点为 `afe2241288f56755dcd30b243183bae98676c357`；部署标签为 `2026.8.10-6+4cb1bc8@2026-08-09T22:11:40.229Z`。
- `E7N58` 在 Storage/Terminal Energy 分别仅约 `18.5k/37.4k`、仍低于房间 `120k/200k` 水位时，于 tick `72892050`、`72892060` 分别向 `E4N58` 发送 `1632`、`2293` L；tick `72892090` 剩余 `422` L 已 admission 且无 suppression，tick `72892110` 完成精确 `422` L 发送后 `pendingOutgoing=0`。
- room-objects 读数同时确认 `E7N58` Terminal L 已清零、`E4N58` Terminal 出现该批 `422` L；`E7N58` 两座 Spawn 与 50 座 Extension 均满能，Tower 为 `706/729/767`。
- 同一观察窗内其他房仍有 U/H/power 跨房路线，8 个房间均保有 Carrier；CPU bucket 保持 `10000`。最新单 tick CPU 为 `101.51/120`，后续样本为 `120.68/120`，高值主要来自既有 Market/CreepWork，未发现本变更引发的 P0/P1 回归，故未部署父提交。
