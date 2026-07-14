## 1. 前置基线与版本化数据模型

- [ ] 1.1 确认 `terminal-headroom-recovery` 已实现并通过其共享水位、capacity index、staging/offload 回归测试，记录 P0 CPU 与 runtime 基线
- [ ] 1.2 为 logistics contract 的 disabled/shadow/canary/enabled 配置、schemaVersion、按 origin/room executionAuthority 和回滚开关编写失败测试
- [ ] 1.3 在 `src/global.d.ts` 定义 latest intent、TransferContract、CapacityLease、StageWorkClaim、market proposal 与 runtime 投影类型
- [ ] 1.4 新增 versioned Memory store 初始化/清理模块，验证旧 Memory、缺字段和 global reset 下可幂等恢复

## 2. Intent 与显式优先级

- [ ] 2.1 为 `(producer,demandKey)` 单 active revision、相同 revision 重放、绝对需求增减、TTL 和已交付量保留编写失败测试
- [ ] 2.2 实现 latest-state intent store、dirty/TTL 索引和 demand revision reconciliation，不保存追加式 intent 日志
- [ ] 2.3 建立现有 reason/origin 到 `deadline/capacity_emergency/survival_energy/operator/production/capacity_pressure/balance/market` 的显式映射及 golden tests
- [ ] 2.4 实现房间 offer/headroom 发布，复用 P0 oracle 并扣除保护库存、active source commitments、fee budget 与未完成 offload

## 3. TransferContract 与 Matcher

- [ ] 3.1 为合同身份/不可变路线、`committed=delivered+remaining`、staged 上限、终态不可复活和只有 send OK 推进数量编写失败测试
- [ ] 3.2 实现 TransferContract store、幂等创建、状态转换、source commitment 聚合和有界终态审计
- [ ] 3.3 为安全候选过滤、Hub 缺失直达、交易成本、stable-key 决胜、deadline 与 priority 排序编写失败测试
- [ ] 3.4 实现按 resource 索引的确定性贪心 matcher、direct route 选择、candidate budget 与 continuation cursor
- [ ] 3.5 为 aging、per-source 条件式公平、cooldown ready tick、机器可读 blocker 和有界退避编写失败测试并实现调度 helper
- [ ] 3.6 实现 automatic successor/retarget，验证先获新 lease、再原子 supersede 旧合同且不会产生双 receiver commitment
- [ ] 3.7 保留 manual 合同的固定端点、无 automatic TTL/retarget 语义，同时验证其物理库存、容量和 fee 约束

## 4. Receiver CapacityLease

- [ ] 4.1 为 receiver-only grant、owner/epoch、共享总容量池、resource-specific 容量、legacy commitment 与同 tick 多申请编写失败测试
- [ ] 4.2 实现 CapacityLease store 和 receiver Agent grant/renew/release，复用 P0 capacity index 且 renew 时排除自身旧 lease
- [ ] 4.3 将 lease 限制为当前/下一 source send window 的一个批次，实现 TTL/终态/retarget 释放与 manual 重新申请
- [ ] 4.4 为 send 前物理重验、过期 epoch、send OK 后 same-tick consumed debit 和 post-send delta 不双扣编写失败测试并实现 projection 更新
- [ ] 4.5 增加 global reset lease 恢复、稳定申请排序和 overlease invariant 检查

## 5. RoomLogisticsAgent 与 terminal 单一所有权

- [ ] 5.1 为每房单一 terminal owner、每窗口一个动作、cooldown、跨 source 并行和预算轮换编写失败测试
- [ ] 5.2 实现 `RoomLogisticsAgent`，在现有 ResourceControl 阶段内统一选择合同 send 与 market proposal，不改变主循环阶段顺序
- [ ] 5.3 把 market buy/sell 执行改为 Agent proposal，保持现有定价、资源白名单、deal 上限和保护规则
- [ ] 5.4 把 survival energy direct send 改为 `survival_energy` intent/contract，并验证不再绕过 Agent 或重复消耗全局预算
- [ ] 5.5 实现 send 前 contract/lease/headroom/source/staged/fee/cooldown 最终重验和 OK/失败的原子进度、blocker、projection 更新

## 6. Contract-aware Staging 与 Carrier Claim

- [ ] 6.1 为有 lease 才 staging、当前/下一窗口、批次上限、aggregate terminal allocation 和 P0 feed/offload 冲突编写失败测试
- [ ] 6.2 实现 `StageWork(contractId, resource, amount)` 与 aggregate staged allocation，允许安全复用 terminal 既有同资源库存
- [ ] 6.3 为双 carrier 竞争、claim 数量守恒、carrying reset、creep 死亡/过期和合同失效孤儿货物编写失败测试
- [ ] 6.4 新增持久 StageWorkClaim store，并让 carrier assignment/withdraw/transfer 生命周期原子 claim、推进 phase 与释放
- [ ] 6.5 在 CarrierTaskBoard 丢失或 global reset 后从 Memory、creep store 和建筑库存重建工作，验证无重复 claim、过量 staging 或误投 generic energy

## 7. Producer 迁移与单一执行权

- [ ] 7.1 将 Hub import/export/distribution 改为发布 intent，验证 Hub 不可用时非固定 Hub 物流仍能匹配直达路线
- [ ] 7.2 将 distributed synthesis、room synthesis、PowerBank boost 和 capacity relief producer 改为发布显式 priority intent
- [ ] 7.3 保持 console transfer API 不变，在入口创建 operator/manual intent 或 contract，并覆盖取消、查询与固定端点
- [ ] 7.4 为 partially delivered legacy task、重复迁移、origin/room canary、P0 commitment 去重和 rollback 编写失败测试
- [ ] 7.5 实现 versioned legacy migration：原子创建 contract、写入 `migratedContractId/executionAuthority=contract` 并让 legacy executor 跳过
- [ ] 7.6 实现回滚 materializer，仅把 active contract 未发送 remainder 还原为 legacy task，释放 lease/claim 且不重放 delivered

## 8. Shadow、观测与资源边界

- [ ] 8.1 实现 shadow comparator，在无 active lease/send side effect 下比较 legacy 与 contract 的 route、priority、容量、staging 和 CPU 决策
- [ ] 8.2 扩展 `Memory.runtime.logistics`，输出 intent/contract/lease/claim、状态耗时、blocker、commitment、吞吐、成本、公平性和 invariant violations
- [ ] 8.3 更新 `scripts/monitor-service.mjs` 与 fixtures/tests，展示长期阻塞、lease/claim 恢复和 CPU 指标，并兼容 legacy/P0 快照
- [ ] 8.4 为单轮索引复用、candidate evaluation 上限、continuation、distance/cost factor 缓存和 terminal-state history ring buffer 增加测试钩子
- [ ] 8.5 在固定 live-like fixture 上证明每房 Agent 不进行全表扫描，ResourceControl p95 CPU 不超过 P0 基线 10%，Memory 详情保持有界

## 9. 完整验证、灰度与清理

- [ ] 9.1 运行 contract、lease、Agent、carrier、ResourceControl、Hub/Synthesis/PowerBank、console 和 monitor 聚焦测试并修复回归
- [ ] 9.2 运行 global reset 矩阵：lease grant 后、carrier carrying、staging 完成、send OK 后和 partial contract 五个切点均无丢单/重复发送/双预留
- [ ] 9.3 运行 `npx tsc --noEmit`、`npm run test` 和 `npm run build`，复查主循环顺序、库存保护、market 定价与 console API 未发生非预期变化
- [ ] 9.4 部署 shadow 模式并观察至少两个业务周期，确认 route/priority 差异可解释、invariant violation 为零且 CPU/Memory 通过 gate
- [ ] 9.5 按 ordinary→capacity/synthesis/boost→survival/console/market 顺序 canary origins/rooms，每阶段验证单一 executionAuthority、lease 安全、receiver 恢复与条件式公平
- [ ] 9.6 全量启用后保留 legacy read/rollback adapter 一个观察窗口；确认无 legacy authority 后删除 reason-string executor、direct energy send 和 legacy 房间+资源 staging adapter
- [ ] 9.7 记录最终 live 指标：contract 状态耗时、oldest blocker、lease 使用/过期、claim/orphan、每 source wait、交易能耗、ResourceControl CPU 和容量越界次数
