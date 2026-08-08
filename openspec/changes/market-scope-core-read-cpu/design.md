## Context

当前 V3 full-planning 的 `cpuAfterScopeCore` 是从 outer `planningCpuStartedAt` 起累计的 primary milestone，不能把线上 27–29 CPU 全部归因给 `liveScopeForRead`。本地 10µs profile 给出一个可安全收敛的确定性热点：首次 static attestation 为了提取 config mismatch reasons，重复走成功 raw-config canonical hash 与 operator hash。pricing-ratchet unchanged 快路也曾显示局部收益，但它需要额外证明 source、Proxy、accessor、原型链 `toJSON` 与持久序列化语义；其风险与实现成本超过本轮收益，因此明确撤回，保留原每读 builder 与 post-plan canonical 终验。

现有安全边界不可改变：25 CPU high-water、两读隔离、fresh trusted floors/rooms/candidates、exact root CAS、WAL/claim/deal 顺序，以及所有 Shadow/suspended lane 的绝对零写。

## Goals / Non-Goals

**Goals:**

- 在不减少任何 config 字段/集合检查的前提下，避免 scope read 为 mismatch-only 判断生成未被消费的 raw-config canonical fingerprint。
- 只有 resolver 自己构造、完整校验、递归冻结并登记私有 provenance 的 canonical V3 direct config，才可复用模块初始化时生成的纯函数 operator fingerprint；非 provenance 输入不得命中。
- 用确定性调用计数、本地 profile、现有 outer milestone delta 与线上完整窗口验证真实收益和零写安全。

**Non-Goals:**

- 不缓存第一读的 trusted floors、room observations、candidate/protection、book、own orders、terminal、quota、arbiter 或 outgoing facts。
- 不优化或改写 pricing-ratchet source、successor builder、rollback 与 post-plan canonical 验证。
- 不改变 roster/lane/cursor、订单评分、production donor、terminal/staging、permit、WAL、claim/deal 或 rollout 生命周期。
- 不扩展现有 CPU trace/monitor wire shape，不通过移动 CPU 起点制造预算内假收益。
- 不启用 Canary 或 Continuous。

## Decisions

### 1. 分离 raw-config 精确校验与 canonical materialization

把 `validateMarketBaseResourceRawConfig` 的字段、资源集合和三组 threshold map 解析抽成内部纯解析结果。公开 validator 仍在成功时构造 canonical payload 与 fingerprint；`marketBaseResourceV3ConfigMismatchReasons` 只消费同一解析器的 reasons，不生成未使用的 fingerprint。

这样两条路径共享完全相同的 shape/value 规则，不会维护第二套“快速但较宽松”验证器。相比按对象 identity 缓存 validation result，此方案不依赖 Memory 对象不可变，也不会让原位 mutation 跨 tick 命中旧结论。

### 2. 仅对 resolver 私有 frozen provenance 使用代码级常量

模块初始化时从冻结的资源目录和 policy 常量构造 canonical V3 direct-safety fingerprint，并计算一次 operator-authorization fingerprint。resolver 先把 raw config 解析为 detached plain-data snapshot，再对规范化结果执行全部 scalar、catalog、revision、threshold 与 planning-validity 校验；只有全部通过时才递归冻结该 snapshot，并把 exact object identity 登记到模块私有 `WeakSet`。运行时只有这份 frozen provenance 命中时才返回模块常量。

这不是 Memory 自证字段或跨 tick 持久 cache。clone、spread、自建对象、accessor、Proxy 与任何未登记 identity 即使序列化值相同，也必须走带 non-canonical sentinel 的完整 fallback，且其字符串不得与 canonical direct fingerprint 碰撞。选择私有 frozen provenance，是为了避免可覆写数组方法、index getter 或验证期间原位 mutation 在多次 value-read 之间制造 TOCTOU；公开调用方不能仅凭相同可变值获得 operator 授权。

### 3. 保留 pricing-ratchet 原安全路径

每次 read 继续 fresh 获取并逐项验证 Energy 和七种 base resource trusted floors，随后无条件由既有 successor builder 从已验证 primitive 字段新建 ratchet。即使 value/marketDate 全部未变化，也不依赖 source identity、对象冻结或相同 projection 跳过 build/hash；post-plan 继续执行完整 canonical/permit 验证。这样本 change 不改变 rollback/fallback 携带的 ratchet 语义，也不新增会话开头 ratchet source 捕获、projection 复核或继承 `toJSON` 隔离合同；后者若需加强必须另立安全变更。

### 4. 不新增持久子 trace

归因使用现有 `cpuAfterOuterSession` 与 `cpuAfterScopeCore` 的差值、builder/hash 调用次数以及本地 profiler。线上比较同时报告 market automation、preflight、总 CPU、creep/pathing 与世界负载漂移；单 tick 不作为因果结论。

## Risks / Trade-offs

- [共享解析器重构导致 raw validator 返回漂移] → 对合法 canonical、缺项、额外项、重复资源、非法类型和阈值偏差做逐字段等价测试，并保留原 fingerprint fixture。
- [operator 常量错误或 provenance 误授予] → 测试固定“常量等于原算法结果”，并验证只有 resolver 构造且递归冻结的 canonical config 被登记；clone、spread、accessor、资源重排、任一阈值/版本变化都不走常量快路且不能获得授权。
- [把本地 ratchet 热点误当成安全授权] → 明确不交付 unchanged-ratchet 快路；profile 必须证明 ratchet builder/hash 调用次数保持基线。
- [Node profile 与 Screeps CPU 不同] → 本地只用于归因；部署后仍保留 Shadow/suspended 和零写，观察多个完整 planning tick 与完整滚动窗口。

## Migration Plan

1. 先以定向测试、TypeScript、build、strict OpenSpec 与相同 fixture profile 验证，并确认 ratchet 路径与基线一致。
2. 仅发布代码版本，不修改线上配置、permit 或 lane stage。
3. 发布后只读核对 tag、完整 planning、scope milestone delta、56/56 Shadow/suspended 与全部写面为零；样本不足时继续观察。
4. 若出现 config/ratchet blocker 增长、任何写面变化或 CPU 回归，回滚该代码提交；Memory 无迁移项。

## Open Questions

无。pathing 的 multi-room segment cache 作为独立后续变更，不与本轮市场安全合同混合。
