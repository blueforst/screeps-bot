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

- [ ] 5.1 提交并部署同一已验证commit，记录父提交与deploy tag
- [ ] 5.2 观察E7N58实际领取L、搬入Terminal并完成跨房发送
- [ ] 5.3 确认Spawn/Extension/Tower供能、CPU及其他房Carrier board无严重回归
- [ ] 5.4 严重异常时部署父提交
