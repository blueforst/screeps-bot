# Tasks: market-dynamic-price-thresholds

> 状态：P0/P1/P2(核心) 已实现并通过测试（commit b7b9a5d、4440518）；
> 剩余：live 迁移演练、observe 窗口验收、Jest 预算归并。

## 1. Permit re-sign 迁移操作（P0 前置）

- [x] 1.1 实现迁移提案构建与校验（from/to 指纹、ledger 静默、armed canary 拒绝）— b7b9a5d
- [x] 1.2 实现 accept re-sign（grant 新指纹重签、shadowEvidence 原样携带、anchor 重铸 blocker=null、laneId 保持）— b7b9a5d
- [x] 1.3 闩锁语义：迁移 propose/accept 可在 rollback 闩锁态执行（恢复路径=迁移而非重置）；历史 permit 校验改为自洽（重算内嵌指纹），仅铸造绑定当前常量 — b7b9a5d
- [x] 1.4 回归测试：r2 世界 + 迁移 → 零资格损失/cycles 保留/链校验通过；cfg 未采纳拒绝；armed canary 拒绝；source_changed 拒绝 — b7b9a5d
- [ ] 1.5 演练：X r2→r3 实弹迁移（部署 → cfg → 迁移），验证 cycles/permit 保留

## 2. bookFloor 订单簿分量（P1）

- [x] 2.1 可执行 BUY 选取复用 firstRead book（collectFullRead 资源循环提取 eligible 最高价，零额外读取）— 4440518
- [x] 2.2 EMA 状态（~6h tick 时间常数、间隔自适应 α、首观测 seed、状态存 runtime 投影不清零）— 4440518
- [x] 2.3 dynamicFloor 合成与日降幅守卫（min against ratchet 只降不升、hardFloor 下限、日锚 15%/day）— 4440518
- [x] 2.4 单元测试：EMA seed/衰减/无效回退、地板合成 + 跨日锚限幅、无盈余退化纯 ratchet — 4440518

## 3. 库存分量（P1）

- [x] 3.1 surplusRatio 计算（protection sellable / lane rolling cap，聚合到资源级取最大）— 4440518
- [x] 3.2 inventoryFactor 线性映射（surplusLow=1/surplusHigh=3 签名常量）— b7b9a5d 策略表 + 4440518 接线
- [x] 3.3 单元测试：factor 0.75 中档 / 1 满档 / 0 无盈余三档 — 4440518

## 4. 观察模式与投影（P2）

- [x] 4.1 dynamicFloorMode: observe/enforce（签名层，默认 observe）— b7b9a5d 策略表
- [x] 4.2 state.dynamicFloorProjection（每资源 bookEma/lastObservedPrice/dynamicFloor/inventoryFactor/surplusRatio/日锚）— 4440518
- [x] 4.2a 接线测试：成功 run（含选中订单路径）写入投影 — 4440518
- [ ] 4.3 monitor 每日轨迹汇总（"若生效将选中的订单"投影）
- [ ] 4.4 observe 窗口 ≥1 天验收 → 用户确认 enforce

## 5. 收尾

- [x] 5.1 Jest 预算归并（522→恰好 500，test:budget PASSED，commit 561f887）
- [ ] 5.2 openspec --strict 通过、部署与线上验收（部署/迁移/重资格/canary 已完成；strict 校验待跑）
