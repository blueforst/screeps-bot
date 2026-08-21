# Tasks: market-dynamic-price-thresholds

> 状态：设计待用户审定，未开始实现。任务清单为初稿。

## 1. Permit re-sign 迁移操作（P0 前置）

- [ ] 1.1 实现迁移提案构建与校验（from/to 指纹、逐资源 delta、ledger 静默、单 canary 不变）
- [ ] 1.2 实现 accept re-sign（grant 新指纹重签、lifecycle/canary 证据原样携带、anchor 重铸 blocker=null、laneId 映射留档）
- [ ] 1.3 闩锁语义收紧：常量变更 + accepted migration → 不触发 rollback 闩锁；触发后可经迁移恢复
- [ ] 1.4 回归测试：模拟 2026-08-21 事故场景（常量变更无迁移 → 闩锁；带迁移 → 零资格损失）
- [ ] 1.5 演练：X r2→r3 微调实弹迁移，验证 cycles/canary 保留

## 2. bookFloor 订单簿分量（P1）

- [ ] 2.1 可执行 BUY 选取复用 firstRead book（零额外读取）
- [ ] 2.2 EMA 状态（~6h 时间常数、有界投影、bundle 升级不清零）
- [ ] 2.3 dynamicFloor 合成与日降幅守卫（maxDailyDynamicDrop）
- [ ] 2.4 单元测试：EMA 边界、走廊、只降不升、守卫击穿拒绝

## 3. 库存分量（P1）

- [ ] 3.1 surplusRatio 计算（保护账本 sellable / rollingMaxAmount）
- [ ] 3.2 inventoryFactor 线性映射（surplusLow/High 签名常量）
- [ ] 3.3 单元测试：盈余巨大/紧张/中间三档

## 4. 观察模式与投影（P2）

- [ ] 4.1 dynamicFloorMode: observe/enforce（签名层，默认 observe）
- [ ] 4.2 lastPlanningSnapshot 动态地板投影（分量、EMA、surplusRatio、走廊决策、若生效将选中的订单）
- [ ] 4.3 monitor 投影与每日轨迹汇总
- [ ] 4.4 observe 窗口 ≥1 天验收 → 用户确认 enforce

## 5. 收尾

- [ ] 5.1 Jest 预算归并（+新 cases 同时 -等量旧 cases，保持 ≤500）
- [ ] 5.2 openspec --strict 通过、subagent 影响范围审查、部署与线上验收
