## MODIFIED Requirements

### Requirement: 首次 Direct Canary 只允许一笔小额成交
首次上线 SHALL 把 legacy canary policy 作为代码级 normalizer/active gate：allowlist 恰为 `[X]`、无 expansion grant、非 Hub/非 emergency、min order 1,000、min notional 600,000 credits、单笔最多 1,000、每周期一笔、累计确认一笔、raw orders 最多 1,000、eligible energy-priced orders 最多 200、transaction energy 最多 1,000、terminal energy reserve 至少 25,000、energy shadow hard floor 20、X hard/economic floor 均至少 600、forecast buffer 至少 100,000。第一笔确认后系统 MUST 自动进入不可由 legacy canary 配置解除的 `paused_for_review`，且该旧写路径永久退役。独立 `market-direct-continuous` capability MAY 只把精确 reviewed X outcome 作为 append-only permit 的历史种子；它不得清除 pause、复活旧 activation、继承一笔免费 canary 或把 X 资格扩散给其他资源。

#### Scenario: 首次安全成交
- **WHEN** legacy Direct Shadow 已完成 100 周期、operator 显式切换 `mode=direct`，且锁定 canary 出现安全机会
- **THEN** legacy 路径最多提交一笔不超过 1,000 X 的成交

#### Scenario: 第一笔已确认
- **WHEN** legacy canary confirmed count 达到 1
- **THEN** 状态进入 `paused_for_review`，Direct Shadow 不再累计资格且 `activationAuthorized=false`；legacy 路径永远不得执行第二笔

#### Scenario: 只改 Revision 或打开 Expansion
- **WHEN** 第一笔已确认后 operator 只修改 config revision、重跑 Shadow、提高 confirmed count 或打开 expansion
- **THEN** 系统仍必须零 legacy deal；只有独立 Continuous permit chain 的新执行路径可使用 reviewed evidence

#### Scenario: Continuous 精确承接 X
- **WHEN** 新 capability 验证唯一 X outcome 的完整 canonical digest、当前 engine/Direct fingerprint 与零 pending/gap
- **THEN** 系统必须先以零市场写方式构造 deterministic X genesis receipt/checkpoint/ledger head，再持久化引用该 head 的 epoch 1 genesis permit；permit 自校验完成后新路径才可使用已计入 X/global rolling ledger 的 outcome，legacy pause、count 和 audit history保持不变

#### Scenario: 其他资源试图继承 X
- **WHEN** H、Z 或其他资源被加入 execution table
- **THEN** 它们不得继承 X 的 Shadow 周期、canary、floor、quota 或 reviewed evidence，必须完成本资源 lifecycle

#### Scenario: 自动扩围
- **WHEN** 其他房间或资源出现更高价格
- **THEN** legacy canary 不得自动更换 room/resource；Continuous 也只能使用已签收 permit 的 explicit lanes

#### Scenario: 首发策略误配置
- **WHEN** legacy allowlist 增加其他资源、floor/buffer 下调、数量/次数/扫描/能量上限越界、打开 expansion grant，或 `maxDirectDealAmount < max(minDealAmount,minDirectOrderAmount)`
- **THEN** legacy 配置必须 invalid、资格清零且零 deal；不得把越界配置计作合格 Shadow

#### Scenario: Legacy State 被删除
- **WHEN** 首笔 canary 后 market Direct state/outcome/permit 任一关键持久证据缺失
- **THEN** 新 bundle 必须永久拒绝 fresh first-use canary并等待审计恢复；旧 `669bce3` 只有在受控回滚保留 v2 schema/unsupported marker 时 fail-closed，回滚期间不得删除或重建该 state
