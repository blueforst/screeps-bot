## ADDED Requirements

### Requirement: 策略常量升级迁移
系统 SHALL 提供与 permit propose/accept 同构的两步 operator 迁移操作，以新策略指纹对全部 active lane grant 重签（re-sign）并保留 lane lifecycle 证据、confirmed canary 高水位、ledger/WAL 与 permit 链历史；未经该迁移的策略常量变更在 cutover 后 MUST 维持 `market_base_v3_config_rollback_after_cutover` fail-closed 闩锁，且闩锁的恢复路径 MUST 是迁移操作而非状态重置。

#### Scenario: 常量变更未经迁移
- **WHEN** 部署 bundle 的策略常量与链尾 grant 指纹不一致且不存在 accepted 迁移提案
- **THEN** 系统触发 rollback 闩锁、零写 fail-closed；propose 普通提案被拒

#### Scenario: 迁移操作零资格损失
- **WHEN** operator 以 from/to policyRevision 与逐资源地板 delta 提交迁移并 accept，且 ledger 无 pending、单 canary 坑位不变
- **THEN** 全部 grant 以新指纹重签，lane 的 completeCycles、stage、canary/review 绑定原样保留；anchor 以 activationBlocker=null 重铸；无 lane 回退到 shadow 0 周期

#### Scenario: 迁移提案与部署不符被拒
- **WHEN** 提案声明的 resourceFloorDeltas 与当前常量 diff 不一致，或 from 指纹与链尾不匹配
- **THEN** 提案被拒绝且不留部分状态

### Requirement: 动态价格阈值（订单簿 + 库存分量）
有效地板 SHALL 在签名常量界内由动态分量有界调整：`bookFloor` 取最优可执行 BUY 价格的短周期 EMA，只允许把有效地板向 `min(ratchetFloor, bookEMA × (1 + listingBuffer × inventoryFactor))` 方向下探，MUST NOT 低于 hardFloor，单日累计下移 MUST NOT 超过签名的 maxDailyDynamicDrop；`inventoryFactor` 由保护账本 sellable 相对滚动上限的 surplusRatio 有界映射。动态分量 MUST 只调价格阈值，MUST NOT 放大成交数量或绕过单 lane 单 canary、单笔 1,000 与滚动上限。

#### Scenario: 盈余巨大时下探走廊
- **WHEN** 某 lane 的 surplusRatio ≥ 签名 surplusHigh 且 bookEMA 显著低于 ratchet
- **THEN** 有效地板下探至走廊允许的最低值但不低于 hardFloor，且不触碰 ratchet 本体（ratchet 单调守卫不变）

#### Scenario: 盈余紧张时不下探
- **WHEN** surplusRatio ≤ 签名 surplusLow
- **THEN** inventoryFactor 为 0，bookFloor 不产生下探，有效地板退化为现行 max(hard, economic, history, ratchet)

#### Scenario: 日降幅守卫
- **WHEN** 市场急跌使 bookEMA 单日隐含下移超过 maxDailyDynamicDrop
- **THEN** 动态下移被钳制在日限内，超出部分次日起继续，任何路径都不得击穿 hardFloor

#### Scenario: 观察模式
- **WHEN** 签名层 dynamicFloorMode 为 observe
- **THEN** 系统投影 dynamicFloor 各分量、surplusRatio 与"若生效将选中的订单"，但 planner 合成仍使用现行地板；模式切换本身必须经迁移操作
