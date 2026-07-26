## 1. 冻结迁移证据与配置合同

- [x] 1.1 冻结 `669bce3` v1 Direct state、唯一 X canary outcome、canonicalStableHashV1、确定性 v2 genesis receipt/checkpoint/head、rollback unsupported state 的 golden fixtures 与 digest
- [x] 1.2 定义 X reviewed exception、H/Z native-only canonical entry、按固定 1,000 计划量计算的逐资源 floor/buffer/executable-notional/quota 和 global 30k/12k policy
- [x] 1.3 扩展 Memory/config 类型与不可降级 normalizer；未授权资源、房间、阈值放宽和表排序漂移全部 fail-closed
- [x] 1.4 实现 shared fingerprint、resource fingerprint、canonical evidence digest 与 stable permitId
- [x] 1.5 覆盖配置缺字段、增删 lane、换房、逐资源/共享参数漂移和旧配置兼容单测

## 2. 修复多资源生产保护

- [x] 2.1 将 mineralExportStart、Factory resource floor 和 permit lane reserve 纳入 local reserve
- [x] 2.2 把 absolute target 与 consumptive demand 分层，按新 protected 公式计算 sellable
- [x] 2.3 从 Synthesis active/paused/config target gap 生成 donor transfer 前的稳定组件承诺并去重 Hub/runtime 多视图
- [x] 2.4 保留 blocked transfer、carrier/in-flight、Boost/War、Hub 和 market exposure；实现已知候选 donor resource 作用域阻断与未知作用域全局零写
- [x] 2.5 增加 X/H/Z 及 mineral/export/factory/donor/target+consumption 的保护回归测试

## 3. 逐资源 Lifecycle 与 Permit Chain

- [x] 3.1 将精确安全 v1 state 单向迁移为 v2 `readyForPermit`，永久退役 legacy Direct 写路径
- [x] 3.2 实现每 entry 的 100-cycle Shadow、qualified、one-shot canary、review_paused、continuous 状态机
- [x] 3.3 只允许 X 用精确既有 outcome digest 形成 reviewed seed；H/Z 不得继承 X 资格
- [x] 3.4 实现 shard1 单 executor、append-only permit history、连续 epoch/permitId、current/high-water chain tip、previous permit/head、完整 evidence 与 entry grants
- [x] 3.5 实现相同签收在 ledger 前进后的幂等 no-op、冲突签收持久 blocker、零 pending/reservation successor 门槛及 rolling/lifetime/high-water 继承
- [x] 3.6 覆盖新增资源不撤销旧历史、stage 推进、grant 安全收窄/恢复、shared fingerprint 全 entry 失效、permit/config 不一致、state 缺失与冲突 recovery 测试

## 4. 全局最高单位净价规划

- [x] 4.1 对 current permit 的全部 `(entry,allowed room,BUY order)` 生成固定 1,000 tuple
- [x] 4.2 按单位净价、总净额、gross price、resource/room/orderId 全局稳定排序，移除容量/库存/批量的价格前置
- [x] 4.3 对所有参与 entry 完整双读 book/order/terminal/protection/credits/energy/net/quota/permit/arbiter；任一字段变化、book 超预算/不完整或最佳 tuple 变化时本 tick 零写
- [x] 4.4 保留 per-entry hard/economic/history/amount=1 最坏净价、能量保留、订单名义额和手工订单门禁
- [x] 4.5 覆盖同资源跨房、跨资源、远距高 gross、低价大单、高价小单、Z executable-notional 两端、稳定 tie-break 与低价 Z 等待
- [x] 4.6 验证可执行生产购买 intent 优先，空生产需求不发布 intent，真实 deal 仍只有 arbiter 入口

## 5. 单调 WAL、Receipt Chain 与双层 Quota

- [x] 5.1 新增全局单 pending、无空洞 attemptSeq/next/high-water 不变量，并在 pending/outcome 冻结 permit/entry/resource 与 resource/global quota snapshot
- [x] 5.2 固定 `outcome → receipt/head/checkpoint → processed key → delete pending` 提交顺序
- [x] 5.3 实现所有合法 CPU-cut 前缀的 preflight 幂等恢复；不合法 outcome/receipt/head 组合进入持久 blocker
- [x] 5.4 实现 finalized receipt seq/prevHash/eventHash/headHash、所有状态 retentionTick、confirmed transactionTime/非 confirmed 首次 resolvedAt、512 ring、coverageStart 与 prune/lifetime checkpoint
- [x] 5.5 同时计算 per-resource/global confirmed actual + unmatched pending reservation；余量不足 1,000 时等待
- [x] 5.6 实现部分成交 reservation 替换、confirmed 1,000 cooldown、failed/not_filled 终态释放与 100 tick retry backoff
- [x] 5.7 实现每个当前有 pre-global-quota safe tuple 的可写资源 1,000 opportunity reserve，并覆盖 X>H>Z 的 90,000 tick 无饥饿、无安全机会不占位和订单价格顺序不变
- [x] 5.8 覆盖窗口 `[tick-29999,tick]` 两端、第 51/65/201 笔、跨房/资源、重复 key、断链、分叉、逆序、global reset
- [x] 5.9 覆盖 genesis processed key、H/Z receipt 已提交但 lifecycle 尚未投影的 CPU-cut，以及 permit 各合法/非法签收前缀

## 6. 观测、停止与回滚

- [x] 6.1 runtime/monitor 展示 permit epoch/id/head、entry lifecycle/lane/floor、Shadow、best tuple、双层 quota/opportunity reserve admission、coverage/high-water/blocker
- [x] 6.2 Emergency Stop 禁止新 pending 但继续收敛所有资源 WAL/exposure/reservation
- [x] 6.3 保持 legacy ResourceControl/Factory seller 与 Pixel generator 关闭，并添加静态/运行时安全闩测试
- [x] 6.4 用 `669bce3` old-normalizer golden fixture 验证保留 v2 state 的受控回滚 fail-closed；明确旧 bundle 删除该 state 超出软件保证，再升级识别 `rollback_evidence_lost`
- [x] 6.5 验证新 bundle 下 Direct state/permit/ledger/outcome/processed keys 各类删除不会产生 fresh canary，并区分 outcome 合法自然裁剪

## 7. 验证、复审与 Live 分阶段启用

- [x] 7.1 运行相关 Jest、生产保护/购买/arbiter 回归、TypeScript、build、diff check 与 OpenSpec strict
- [x] 7.2 运行完整 Jest，记录套件/测试数和冻结 diff
- [x] 7.3 由独立 subagent 审查生产保护、全局排序、permit/WAL/coverage、旧 bundle 与所有故障注入，修复全部 P0/P1
- [ ] 7.4 合并 main 并部署零写，核对 shard1 deploy tag、v2 migration、X digest、proposed permit 与零 pending/gap
- [ ] 7.5 签收 epoch 1：X continuous、H/Z Shadow；验证 X 首笔持续成交及其后 global/resource cooldown
- [ ] 7.6 等待 H/Z 各自 100 个完整 Shadow 周期；核对逐 entry count/fingerprint/低价拒绝
- [ ] 7.7 用 successor permit 推进 H canary，独立复核实际净价/库存/生产/ledger 后再推进 H continuous
- [ ] 7.8 Z 只在出现高于 43/45 的安全盘口时推进 canary；否则保持安全等待，不阻塞 X/H continuous
