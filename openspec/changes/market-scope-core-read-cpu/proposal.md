## Why

V3 base-resource 市场规划在全量 Shadow、无可写 lane、无订单评分的稳态下，仍反复在 `scope_core_read1` 前后触发 CPU 截断；现有里程碑又是从 outer 起点累计，尚不能把这段成本误称为 lane/scope 重建。现在需要在不放宽 25 CPU、双读、CAS 与零写门禁的前提下，消除 marker 前 config mismatch 与 operator authorization 的重复 canonical 成本，并用可归因证据验证收益。

## What Changes

- 将 raw V3 config 的“字段/集合是否精确匹配”与“生成 canonical fingerprint”拆开；scope read 不再为只读取 mismatch reasons 重算成功路径 canonical hash。只有 resolver 自己构造、完成全部 exact 校验、递归冻结并登记私有 provenance 的 canonical config 才可复用代码级不可变 operator fingerprint；clone、自建对象、accessor 或任一偏差仍走非 canonical 完整计算或 fail-closed。
- trusted floors、pricing-ratchet successor builder、room observations 与 post-plan canonical 验证保持原路径；本轮不以 source identity、相同 value/date 或 frozen snapshot 跳过 ratchet build/hash。
- 以现有 `cpuAfterScopeCore - cpuAfterOuterSession`、确定性 config/operator canonical-hash 调用次数、本地 profile 和线上完整窗口验收；不扩展持久 trace schema，并保持所有 lane Shadow/suspended、所有市场写面为零。
- 明确排除 production donor/protection、订单簿与 terminal 评分、WAL/claim/deal、permit 签收以及 Canary/Continuous rollout。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `market-sale-automation`: 收紧 V3 scope-core 的 config canonical/provenance 证明复用、动态事实双读、CPU 归因与零写验收要求。

## Impact

- 主要影响 `marketBaseResourcePolicy.ts`、`marketSaleConfig.ts`、`marketBaseResourceAutomation.ts` 及其定向测试；不改 monitor wire shape。
- 不改变 Memory canonical schema、市场生命周期、资源/房间/lane 集合、生产与物流合同，也不启用任何市场写入。
