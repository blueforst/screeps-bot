## 1. 前置基线与版本化数据模型

- [ ] 1.1a 确认 `terminal-headroom-recovery` 的共享 oracle、本地回归、staging admission 和冻结 Memory 声明边界已实现并通过本地回归，且 `production-logistics-liveness` 已完成 demand coverage、单房单 assignment、Hub config ownership/reconcile 与 live 验收；记录纯 Shadow 的 P0 CPU/runtime 基线，并明确本项只授权零 authority Shadow，不声称 terminal-headroom 6.4 已通过
- [ ] 1.1b 在任何 `canary/enabled` 或 active contract/lease/claim 之前，完成 `terminal-headroom-recovery` 6.4 的部署前基线与至少两个恢复周期 live 验收；未关闭时 authority 模式必须 fail closed
- [x] 1.2 为默认 `disabled`、`shadow/canary/enabled`、未知 mode/schema fail-closed、按 `(origin, sourceRoom)` executionAuthority 以及带 requestId/scope/phase 的持久 rollback 请求编写失败测试；禁止 targetRoom-only canary 和瞬时布尔回滚事实
- [x] 1.3 在现有 owner 分支下定义局部 versioned control/rollback、latest intent、TransferContract、CapacityLease、StageWorkClaim、market proposal 与 runtime adapter 类型；首片 raw Memory 使用 `schemaVersion:1`/`compact-v1` canonical tuple wire，但公开 decoded DTO 与领域语义不变；不得直接扩大冻结的四个 Memory 根声明指纹
- [ ] 1.4 新增 versioned Memory store/control 初始化与有界清理模块，严格校验 compact tuple arity/index/enum/cursor/canonical re-encode；仅将完整合法的 expanded-v1 原子迁移为 compact-v1，编码或最终 raw UTF-8 超过 16 KiB 时 attach 前整体 fail closed；验证旧 Memory、缺字段和 global reset 下可幂等恢复，未完成 rollback request/phase 不得丢失或自动置 completed
- [x] 1.5 审计 `local-dispatch-ownership` 的 Git ancestry、bundle source 与 live deploy 证据，修正文档状态漂移；复用完整 `CarrierDispatchRef`、owner-aware board 和 `CarrierAmountSlicePort`，不得再次执行所谓首次全量切换

## 2. Intent 与显式优先级

- [ ] 2.1 为 `(producer,demandKey)` 单 active revision、caller 不提交/不拥有 revision、同语义 heartbeat 保留 store revision 并只单调延长 freshness、语义变化由 store 原子 revision+1、过期或 inactive→active 分配新 generation/id、绝对需求增减、TTL 和已交付量保留编写失败测试
- [ ] 2.2 实现 latest-state intent store、dirty/TTL 索引和 store-owned generation/revision reconciliation；忽略 caller 夹带的 revision authority，heartbeat 不得创建 commitment/刷新 progress，且不保存追加式 intent 日志
- [x] 2.3 建立现有 reason/origin 到 `deadline/capacity_emergency/survival_energy/operator/production/capacity_pressure/balance/market` 的显式映射及 golden tests；首片 scope 必须由 typed `synthesisControl` producer/hook 标记，只允许 `synthesis_room`/`synthesis:<room>:<product>` in-scope，固定映射 `production` 并与 legacy rank 2 做语义对照，不得猜测 deadline；distributed direct/hub-route/resupply、surplus 与 `auto:synthesis` 必须有稳定 `out_of_scope` reason
- [ ] 2.4 实现只读房间 offer/headroom/freshness 发布，复用 P0 oracle 并扣除保护库存、健康 legacy 与 active contract source commitments、动作 fee budget 与未完成 offload；纯 Shadow 不因发布房间事实获得 receiver authority

## 3. TransferContract 与 Matcher

- [ ] 3.1 为合同身份/不可变路线、`committed=delivered+remaining`、staged 上限、终态不可复活和只有 send OK 推进数量编写失败测试
- [ ] 3.2 实现 TransferContract store、幂等创建、状态转换、source commitment 聚合和有界终态审计
- [x] 3.3 为 Synthesis legacy 写前冻结输入/实际 decision 捕获、精确 task/delta self-exclusion、禁止 reason/room-resource 宽泛排除、安全候选过滤、Hub 缺失直达、交易成本、stable-key 决胜、deadline 与 priority 排序编写失败测试
- [ ] 3.4 实现只读写前快照、按 resource 索引的确定性贪心 matcher、direct route 选择、candidate budget 与 continuation cursor；Shadow 候选输出不得自动物化为 active contract
- [x] 3.5a 为 Shadow priority/deadline/cooldown ready tick、稳定 blocker 分类、candidate budget/continuation 和 `predictedStagingEligibility` 编写失败测试并实现纯 helper；不伪造持久 aging、retry 或实际 staging 进度
- [ ] 3.5b 为执行态 aging、per-source 条件式公平、机器可读 blocker、attempt/blockedSince/nextAttemptAt 和有界退避编写失败测试并实现持久调度 helper
- [ ] 3.6 实现 automatic successor/retarget，验证先获新 lease、再原子 supersede 旧合同且不会产生双 receiver commitment
- [ ] 3.7 保留 manual 合同的固定端点、无 automatic TTL/retarget 语义，同时验证其物理库存、容量和 fee 约束

## 4. Receiver CapacityLease

- [ ] 4.1 为 receiver-only grant、owner/epoch、共享总容量池、resource-specific 容量、legacy commitment 与同 tick 多申请编写失败测试
- [ ] 4.2 实现 CapacityLease store 和 receiver Agent grant/renew/release，复用 P0 capacity index 且 renew 时排除自身旧 lease
- [ ] 4.3 将 lease 限制为当前/下一 source send window 的一个批次，实现 TTL/终态/retarget 释放与 manual 重新申请
- [ ] 4.4 为 send 前物理重验、过期 epoch、send OK 后 same-tick consumed debit 和 post-send delta 不双扣编写失败测试并实现 projection 更新
- [ ] 4.5 增加 global reset lease 恢复、稳定申请排序和 overlease invariant 检查

## 5. RoomLogisticsAgent 与 terminal 单一所有权

- [ ] 5.1 为 Agent 单一 proposal 选择、既有 `marketActionArbiter` 每房 action claim、每窗口一个动作、cooldown、跨 source 并行和预算轮换编写失败测试；禁止新增第二套 terminal/account lock
- [ ] 5.2 实现 `RoomLogisticsAgent`，在现有 ResourceControl 阶段内统一选择合同 send 与 market proposal；send/普通 deal 委托 `executeTerminalSend`/`executeMarketDeal`，Prepared Direct 仍走其专用 claim/execute/release gateway；不改变主循环阶段顺序
- [ ] 5.3 把 market buy/sell 接成 Agent proposal，同时复用既有 arbiter、Terminal Energy ownership、定价、资源白名单、deal 上限和保护规则；锁定 Prepared Direct 的 requestId、`attemptAt+1` 与 unknown/throw 保守持有语义不变
- [ ] 5.4 把 survival energy direct send 改为 `survival_energy` intent/contract，并验证不再绕过 Agent 或重复消耗全局预算
- [ ] 5.5 实现 send 前 contract/lease/headroom/source/staged/fee/cooldown 最终重验和 OK/失败的原子进度、blocker、projection 更新

## 6. Contract-aware Staging 与 Carrier Claim

- [ ] 6.1 为有 lease 才 staging、当前/下一窗口、批次上限、aggregate terminal allocation 和 P0 feed/offload 冲突编写失败测试
- [ ] 6.2 以完整 `CarrierDispatchRef` 向既有 owner-aware `CarrierTaskBoard` 发布 `StageWork(contractId, resource, amount)`，实现 aggregate staged allocation，允许安全复用 terminal 既有同资源库存且不建立平行 board
- [ ] 6.3 为双 carrier 竞争、claim 数量守恒、carrying reset、creep 死亡/过期和合同失效孤儿货物编写失败测试
- [ ] 6.4 新增持久 StageWorkClaim store，并让 carrier assignment/withdraw/transfer 生命周期原子 claim、推进 phase 与释放；通过单一 `executionAuthority` 保证它不与 legacy tick-bound `CarrierAmountSlicePort` 对同一 work 双重计量
- [ ] 6.5 在 CarrierTaskBoard 丢失或 global reset 后从 Memory、creep store 和建筑库存重建工作，验证无重复 claim、过量 staging 或误投 generic energy

## 7. Producer 迁移与单一执行权

- [ ] 7.1 将 Hub import/export/distribution 改为发布 intent，验证 Hub 不可用时非固定 Hub 物流仍能匹配直达路线
- [x] 7.2a 首片只将 typed `synthesisControl` 中启用的 room reaction `synthesis_room` reagent demand 接入 latest-state Shadow：在 legacy `synthesis:<room>:<product>` task 写入前冻结 intent/房间事实，写入后捕获精确 decision/task/delta；不以 reason 前缀判 scope，不改 Hub route compiler、legacy task/authority、synthesis missing/bindings 或 `hub.needsPlan`
- [ ] 7.2b 在 7.2a 的 100-tick Shadow 门槛通过后，再按独立 origin 分片扩展 Shadow：先 `synthesis_distributed_demand` 的 direct/hub-route/resupply，再分别接入 PowerBank boost 和 capacity relief；`synthesis:surplus:*` 与 `auto:synthesis:*` compatibility 在本任务中仍必须显式 `out_of_scope`，任何未纳入分片的 reason 都不得静默遗漏，且本任务不授权 active contract side effect
- [ ] 7.3 保持 console transfer API 不变，在入口创建 operator/manual intent 或 contract，并覆盖取消、查询与固定端点
- [ ] 7.4 为 partially delivered legacy task、重复迁移、`(origin, sourceRoom)` canary、targetRoom-only 拒绝、P0 commitment 去重与持久 rollback request/phase 编写失败测试
- [ ] 7.5 实现 versioned legacy migration：只对同时命中 origin/sourceRoom 的需求原子创建 contract、写入 `migratedContractId/executionAuthority=contract` 并让 legacy executor 跳过
- [ ] 7.6 实现持久 rollback request 状态机和幂等 materializer：按 `requested -> quiescing -> materializing_legacy -> restoring_legacy_authority -> completed` 续跑，只把 active contract 未发送 remainder 还原为 legacy task，释放 lease/claim 且不重放 delivered

## 8. Shadow、观测与资源边界

- [x] 8.1 首先只接 `synthesis_room` latest-state intent，在 legacy 写前冻结输入并捕获实际 decision；用相同 fixture 的 disabled-vs-shadow 规范化差分证明除两个 logistics owner 分支外，legacy task、CarrierTaskBoard、arbiter claim/journal、receiver reservation、terminal/store 与旧 Memory 投影均无新增可观察 mutation，并用 terminal.send/deal mock 证明无 Shadow 新增调用；同时保持 active contract/lease/claim store 为零和 `effectiveAuthority=legacy`，再比较 donor/route、priority、demand coverage、headroom、`predictedStagingEligibility` 和 CPU；distributed/surplus/compatibility 等其余 producer 显式 `out_of_scope`
- [x] 8.2a 通过局部 adapter 扩展 `Memory.runtime.resourceControl.logistics` 的 Shadow 投影，输出 mode/schema、in-scope/out-of-scope、intent freshness/revision、legacy 配对率、各 comparator 维度 match/difference reason、predicted staging、candidate/index/CPU/Memory，以及 `effectiveAuthority`、active contract/lease/claim store 和可观察 actor/claim/journal/invariant 状态；禁止把声明常量或净状态伪装为跨模块瞬时 attempt 计数，也禁止伪造 contract/lease/claim 已恢复
- [ ] 8.2b 扩展执行态投影，输出 contract/lease/claim 状态耗时、blocker、commitment、吞吐、成本、公平性、rollback phase 与执行态 invariant violations；若要声明瞬时 authority/side-effect attempt 计数，必须在 market arbiter、CarrierTaskBoard、receiver reservation、authority/contract/lease/claim writer 与 direct send/deal gateway 增加 mutator-boundary instrumentation
- [x] 8.3a 更新 `scripts/monitor-service.mjs` 与 fixtures/tests，展示 Shadow scope、配对/差异、predicted staging、`effectiveAuthority=legacy`、active store 零值、无 Logistics Shadow actor/claim/journal 和可观察 invariant violation、CPU/Memory 门槛，并兼容缺少 logistics 字段的 legacy/P0 快照；不得把这些字段表述为未布设探针的瞬时 attempt 证明
- [ ] 8.3b 扩展 monitor 执行态 fixtures/tests，展示长期 blocker、lease/claim/rollback 恢复和 stage/send 吞吐，且不把空执行态伪造为已经 live 验收
- [ ] 8.4a 为 Shadow 单轮索引复用、candidate evaluation 上限、continuation、distance/cost factor 缓存、有界 comparator reason/history 与序列化字节计数增加测试钩子；固定 8 rooms/16 intents+observations/8 resources-per-room fixture 的 compact-v1 raw 必须为 5,043 bytes、完整 emitted 16 且 dropped/truncated 为零，并覆盖 arity/index/enum/cursor/canonical 负例、合法 expanded-v1 原子迁移和超 16 KiB 不 attach
- [ ] 8.4b 为执行态 contract/lease/claim 索引、per-source continuation 和 terminal-state history ring buffer 增加测试钩子
- [ ] 8.5a 在固定 live-like fixture 上证明 Shadow 房间事实与 matcher 不进行每房全表扫描，包含 Shadow 成本的同口径 ResourceControl phase p95 CPU 不高于 P0 基线的 110%（增幅不超过 10%），且 logistics data+runtime 的 UTF-8 JSON 序列化字节数合计在所有样本中不超过 32 KiB
- [ ] 8.5b 在执行态 live-like fixture 上证明每房 Agent 不扫描全部 intents/contracts，ResourceControl p95 CPU 不高于 P0 基线的 110%（增幅不超过 10%），contract/lease/claim/history 详情保持有界

## 9. 完整验证、灰度与清理

- [ ] 9.1a 运行 intent store、Synthesis 写前冻结/legacy decision 配对、纯 matcher/comparator、ResourceControl/P0 headroom、Hub 不变回归、monitor 兼容、disabled-vs-shadow 非 logistics 状态差分、send/deal mock 无新增调用、`effectiveAuthority=legacy`/active store 零值/无 Logistics Shadow actor-claim-journal，以及 CPU/Memory 门槛聚焦测试并修复回归；本项不以硬编码零值声称排除了未 instrument 的瞬时 attempt
- [ ] 9.1b 运行 contract、lease、Agent、carrier、Hub/distributed Synthesis/PowerBank、console、market proposal、rollback 和执行态 monitor 聚焦测试并修复回归
- [ ] 9.2 运行执行态 global reset 矩阵：lease grant 后、carrier carrying、staging 完成、send OK 后、partial contract 和 rollback 每个持久 phase 均无丢单/重复发送/双预留/重放 delivered
- [x] 9.3 运行 `npx tsc --noEmit`、`npm run test` 和 `npm run build`，复查主循环顺序、库存保护、market 定价、console API 和冻结 Memory 根声明指纹未发生非预期变化
- [ ] 9.4 在 1.1a、`production-logistics-liveness` deploy/live gate，以及 8.1 的 disabled-vs-shadow 可观察状态差分与 send/deal mock 无新增调用完成后，允许部署零 authority 的 `synthesis_room`-only Shadow，不以 `terminal-headroom-recovery` 6.4 尚未关闭阻止纯只读比较；剔除至少 10 warmup tick 后收集至少 100 个连续 measured tick，确认 in-scope legacy 全部配对或有机器 reason、out-of-scope 不静默遗漏、donor/route/priority/coverage/headroom/predicted-staging 差异可解释，且持续为 `effectiveAuthority=legacy`、active contract/lease/claim store 为零、无 Logistics Shadow actor/claim/journal 记录和可观察 invariant violation；包含 Shadow 成本的 ResourceControl phase post p95 CPU 必须 `<= pre * 1.10`，每 tick logistics data+runtime UTF-8 JSON 字节数必须 `<= 32768`。该 live gate 只证明可观察结果，不得被表述为已经排除未 instrument、发生后又回滚/释放/失败的瞬时 attempt
- [ ] 9.5 只有在 1.1b/`terminal-headroom-recovery` 6.4 完成后，才可按 ordinary→capacity/synthesis/boost→survival/console/market 顺序以 `(origin, sourceRoom)` 双重 allowlist canary authority；每阶段验证单一 executionAuthority、lease 安全、receiver 恢复、条件式公平和持久 rollback request/phase 可恢复，targetRoom-only 不得开启
- [ ] 9.6 全量启用后保留 legacy read/rollback adapter 一个观察窗口；确认无 legacy authority、rollback phase 为 completed 且无未处理 request 后，删除 reason-string executor、direct energy send 和 legacy 房间+资源 staging adapter
- [ ] 9.7 记录最终 live 指标：contract 状态耗时、oldest blocker、lease 使用/过期、claim/orphan、每 source wait、交易能耗、ResourceControl CPU、logistics Memory 字节、rollback phase 和容量越界次数
