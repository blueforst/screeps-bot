## Why

v3 base-resource 市场自动化的 lane 晋级依赖 100 个完整 shadow 观察周期。2026-08-21 只读验收（`decentralized-logistics-contracts/evidence/market-automation-unlock.md` "最终验收结果"）发现：周期机制本身健康（实测 ~70 tick/周期），但 completeCycles 被反复整体清零——17,577 tick 内按速率应累计 ~250 周期，实际仅 +21，全部 56 lane 停留在 30 余周期，qualified/canary/continuous 与真实成交永远无法达成。

根因是 v3 从 v2 继承的观察清零语义与 v3 轮转采样组合后的结构性回归：

- v2 时代每 full read 全量观察全部 lane（3 lane），100 周期 ≈ 41 分钟，清零事件难以打断整个窗口；
- v3 改为 resource-major cohort 轮转（每 full read 8 lane、7 轮覆盖 56 lane），100 周期膨胀到 ~7,000 tick（约 3 小时），而清零事件频率不变；
- 当前实现把单轮采集噪声——terminal 读取瞬时不完整（`market_base_terminal_incomplete`）、protection 账本单轮 unknown（`market_base_protection_incomplete`）、BUY book blocker、CPU ceiling 超限轮的观察降级——一律按 `incomplete` 观察清零该 lane 已积累的全部周期证据；噪声成串爆发时（CPU 压力期、global reset 后首 tick、保护来源抖动）7 轮内即可清零全部 lane。

现行 `market-sale-automation` spec 对清零的字面要求是"任一相关**配置变化**必须把连续计数清零"。terminal/protection 的单轮读取失败与 CPU 超限不是配置变化，也不是 lane 身份变化（scope reconcile 的 stableFingerprint/tombstone 层已单独处理身份重置与配置漂移）；把它们当作证据作废事件超出了 spec 要求，且与失败方向相反——单轮 incomplete 本来就不推进计数，清零只会额外摧毁既有证据。

## What Changes

- v3 `applyMarketBaseResourceShadowObservations` 的 `incomplete` 分支从"清零该 lane 并重写 reset digest"改为 no-op：不推进 completeCycles、不更新 lastCompleteTick、不写 reset digest，lane 证据原样保留。持续性 incomplete 的后果从"周期归零"变为"周期停涨"，天然保持 fail-closed（永远到不了 qualified）。
- 同 tick 观察冲突（`conflicting_same_tick_shadow_observation`）同样降级为 no-op：冲突轮不推进即可，不再销毁历史证据。
- 保留两类真正的证据重置：tick rollback（时序破坏）与 lane 身份/scope 层重置（stableFingerprint 冲突、tombstone、scope 重建）——后两者本来就不经过 observation apply 层。
- 不改变：观察轮转与 cohort 选择、CPU ceiling 与双读门禁、`emptyResult` 的超限观察过滤、scope/permit/ledger 权威合同、v2 兼容 evaluator、25 CPU ceiling、市场写路径与零写约束。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `market-sale-automation`: 收紧 shadow 周期证据的重置条件——只有配置/身份/时序级别的证据作废事件才清零连续计数；单轮采集 incomplete 只中断推进、不作废旧证据。

## Impact

- 主要修改 `src/runtime/marketBaseResourceAutomation.ts`（observation apply 的 incomplete/conflict 分支）及其测试。
- 晋级安全性：qualified 仍要求 100 次非 incomplete 观察（wait 类照常累计，`wait_no_opportunity` 细分语义不变）；本变更不降低观察质量门槛，只移除与 spec 字面不符的噪声惩罚。
- 不修改 Memory canonical schema 中 lane lifecycle 的字段形状（shadowEvidence 仍为 completeCycles/lastCompleteTick/evidenceDigest 三键）。
