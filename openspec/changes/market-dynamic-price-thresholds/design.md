# Design: market-dynamic-price-thresholds

## D1 结构/动态分层（核心决策）

签名层（permit 指纹绑定，改动走迁移操作）只保留**结构与界**：hardFloor、listingBuffer 走廊 `[floor, ceiling]`、maxDailyDynamicDrop、库存映射系数、EMA 周期。动态层（不进签名、无需 re-sign）：history/ratchet（现状）+ bookFloor EMA + surplusRatio。

理由：把"会随市场变化的数值"塞进签名常量会使迁移操作高频化，违背 permit 链低频、可审计的本意；分层后日常动态调整零链上操作，仅结构再调参（如改 hardFloor、走廊宽度）才迁移。

## D2 Permit re-sign 迁移操作

- 入口：`proposeMarketBaseResourcePolicyMigration({ fromPolicyRevisions, toPolicyRevisions, resourceFloorDeltas })` → `acceptMarketBaseResourcePermitMigration(proposalId)`（命名待实现定稿）。
- 提案校验：from 必须与现行链尾 grant 指纹一致（防跳版）；to 由当前常量派生；resourceFloorDeltas 与常量 diff 逐字一致（防提案与部署不符）；ledger 无 pending、无 quarantined；单 canary 坑位不变。
- accept 效果：新 permit epoch，全部 active grant 以新指纹 re-sign（laneStableFingerprint、lifecycleEvidenceDigest、canary/review 绑定原样携带）；anchor 重铸 `activationBlocker: null`；scope 以新 sharedPolicyFingerprint 重建，lane 身份以 (room, resource) 映射保留 lifecycle（laneId 摘要含策略指纹会变——迁移映射表随提案签名留档）。
- 闩锁语义：`market_base_v3_config_rollback_after_cutover` 仅在"常量变更且链尾指纹不匹配且无 accepted migration 提案"时触发；触发后恢复路径 = 迁移操作（而非重置）。
- 审计：迁移是显式 operator 动作，audit 记录 from/to 指纹、delta、时间与授权来源；一票回滚 = 再迁移回旧值（不新增瞬时布尔开关）。

## D3 bookFloor 分量

- 输入：每 full planning tick 已读取的 BUY 订单簿（复用 firstRead 的 book，零额外 CPU 读）；取"最优可执行"（≥minOrderAmount、能耗 ≤maxTransactionEnergy、价格 >0）价格 `p_t`。
- EMA：`ema_t = α·p_t + (1−α)·ema_{t−1}`，α 按 full-planning tick 折算到 ~6h 时间常数；EMA 状态存 runtime 投影（≤ 有界），bundle 升级不清零（seed 用首个观测）。
- 合成：`dynamicFloor = max(hardFloor, min(ratchetFloor, bookEMA × (1 + listingBuffer × inventoryFactor)))`；有效地板 = max(economicFloor, historyFloor, dynamicFloor)。bookFloor **只降不升**地板上界（min against ratchet），避免订单簿尖峰抬高地板造成自我锁定。
- 日降幅守卫：`dynamicFloor` 相对前日快照的下移 ≤ maxDailyDynamicDrop；ratchet 衰减语义独立不变。

## D4 库存分量

- `surplusRatio = protectionSellable / max(rollingMaxAmount, 1)`（每 lane、每保护账本刷新时更新）。
- `inventoryFactor ∈ [0, 1]`：surplusRatio ≥ surplusHigh（如 3）→ 1（全额走廊下探）；≤ surplusLow（如 1）→ 0（不下探）；中间线性。系数进签名层。
- 语义：盈余巨大 → 接近市场出清价也卖；盈余接近滚动上限 → 不为卖而降。

## D5 观察模式与验收

- 签名层新增 `dynamicFloorMode: "observe" | "enforce"`（默认 observe；切换 = 一次迁移操作）。
- observe：投影计算 dynamicFloor 与"若生效将选中的订单"，不参与 planner 合成；monitor 每日汇总轨迹（多少 tick 会触发、价格差多少）。
- 验收：observe 窗口 ≥1 天且轨迹无守卫击穿 → 用户确认 enforce；迁移操作先用 X r2→r3（仅走廊参数微调）演练零资格损失，再承接今天事故场景的回归测试（常量变更 + 迁移操作 → 不闩锁、cycles 保留）。

## D6 测试与预算

新增预计 +15~25 cases（迁移操作正反例、EMA/走廊/库存边界、观察模式投影、闩锁语义回归）； Jest 预算 500 需按 `reduce-jest-suite-to-500` 约定归并等量旧 cases（优先合并参数化重复的 market 用例）。
