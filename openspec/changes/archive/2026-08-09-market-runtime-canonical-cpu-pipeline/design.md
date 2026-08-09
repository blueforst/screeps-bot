## Context

当前 V3 market-base 调用链在同一个 25 CPU outer window 内依次执行 cold preflight、runtime capability/session 建立、planning scope 双读、Shadow planner、canonical root CAS 与最终提交门禁。线上 `87e28e4` 的 13 个不重复 trace 中，8 个在 `scope_core_read1` 截止；最新 120 样本中 `marketSalePreflight + marketSaleAutomation` 平均约 43.7 CPU。

本地 100µs profile 显示 `liveScopeForRead` 的约 89% 时间位于 canonical hashing：raw config validation、operator authorization、current ratchet validation 与 next ratchet rebuild。另一个独立热点是 runtime status 为三个 Continuous entry 分别调用 `computeContinuousQuota`，而每次调用都会完整验证同一 ledger。现有 opaque runtime capability、frozen exact source 与 final CAS 已提供安全复用的 provenance，但这些成本尚未在架构上按“静态认证 / 动态事实”分层。

约束：

- 25 CPU ceiling 不可提高；CPU 回拨或无效读数继续永久闭锁当前 outer window。
- protection、trusted floors、room observations、orders、terminal、quota、arbiter 与 outgoing window 仍须按原合同 fresh read；不能缓存完整 planning/protection snapshot。
- canonical malformed input 仍须在 commit 前可见并 fail closed。
- 所有 lane/grant 继续保持 `shadow+suspended`；本变更不签发 Canary/Continuous，也不执行真实 deal。
- 不调整 `main.ts` phase 顺序，不触碰 donor-contract 或当前 dirty upgrader/hub/colonizer 文件。

## Goals / Non-Goals

**Goals:**

- 把 invocation 内不会变化且已由 exact runtime session 绑定的配置、permit 与 current ratchet 认证提升到一次性静态认证层。
- 为同 tick 已认证 frozen scope 提供稳定 room observation 快路；只有 live room basis 精确一致时复用 scope，任何变化回到完整 reconcile/fail-closed 路径。
- 对 bounded quota 请求一次验证 Continuous ledger、一次聚合 retained receipts，再批量生成逐资源 snapshot。
- 以确定性调用次数、负向安全测试、本地 profile 和 shard1 Shadow 多 tick 数据证明收益。

**Non-Goals:**

- 不解决 mixed writable + Shadow 的 4,096 transaction-energy P1。
- 不改变 floor、production protection、quota 数值、候选排序、WAL 或写授权。
- 不实现通用跨模块 TickContext、Synthesis 索引或 RoomLogisticsAgent。
- 不以首个部署 tick 作为长期性能结论。

## Decisions

### 1. 建立 invocation-local 静态认证上下文

`runMarketBaseResourceAutomation` 在 runtime session 建立并通过 exact snapshot mismatch 门禁后，创建私有 `StaticReadAttestation`。它只保存：

- 已验证配置的结果与 operator authorization fingerprint；
- exact current V3 permit；
- 已验证、由 session safety context 冻结的 current pricing ratchet；
- 逐资源 current/signed ratchet 只读索引；
- planning 需要的配置标量快照。

`liveScopeForRead` 的每一读先重新执行 `marketBaseResourceRuntimeSnapshotMismatch`，确保 state/permit/ratchet 仍是该 attestation 绑定的 exact frozen source；之后复用静态结果，不再重复 canonical config/operator/current-ratchet 工作。trusted floors 与 next ratchet 仍每读独立构造并进入两读 evidence。

选择 invocation-local snapshot isolation，而不是跨 tick WeakMap：跨 tick Memory 会产生新对象且可能合法更新，跨 tick缓存既难命中又扩大错误复用面。静态上下文不进入 Memory、permit、WAL 或任何 canonical hash。

### 2. 增加 authenticated stable-scope 快路

每次 planning read 仍独立调用 `collectLiveMarketBaseRoomObservations`。当且仅当：

- session 的 exact scope 已冻结且 `updatedAt === current tick`；
- 全部 observation 形状与 roomName 唯一性有效；
- admitted observation 与 frozen `sellerRooms` 在 roomName、owner、terminal、roomClass、admission revision 和 status 上逐项一致；

才直接复用 `session.scopeContext.snapshot`。否则调用现有 `reconcileLiveMarketBaseResourceScopeCore`，由原 checkpoint/tombstone/lane 合同决定 blocker。该快路不复用第一读 observation，也不复用 candidates、protection、book 或 terminal。

选择 exact room-basis 比较，而不是只比较 roster fingerprint：fingerprint 是持久证据的一部分，但单独信任自报 digest 会扩大 rollback/碰撞风险；opaque session + frozen exact source + live field comparison 才构成快路授权。

### 3. 引入 bounded batch quota reader

在 `marketDirectContinuousLedger` 增加批量 quota helper：

1. 验证 tick、global limit、bounded 且 resource 唯一的 requests；
2. 对 ledger 完整验证一次；
3. 对 rolling-window confirmed receipts 单次遍历，形成 global 与 per-resource amount/last-confirmed 聚合；
4. 为每个 request 生成与原 `computeContinuousQuota` 字段逐项一致的 snapshot。

单资源 API 委托给 batch helper，保持兼容；`projectContinuousDirectRuntimeStatus` 与 `computeOpportunityAdmissions` 使用 batch helper，避免同一只读 ledger 重复 full audit。helper 只返回数据，不铸造写 capability，也不替代 prepare/commit 前的 authoritative validation。

### 4. 分层验证而不是放宽 wall-clock 门槛

- 复杂度层：断言一次 outer invocation 只建立一次静态认证；两次动态 read 仍发生；quota batch 输出与逐项 oracle 一致。
- 安全层：owner/terminal/hub/room 变化、第二读 protection/order 变化、malformed canonical input、CPU cut 均保持零 pending/commit/claim/deal。
- 本地层：复跑 cold 512-receipt benchmark 和定向 profile，记录 hot automation median/p95 与主要 canonical caller。
- 线上层：部署后先核对 deployTag 与零市场写；随后至少观察多个 full Shadow tick，并在 1200 tick 后比较完整 120 样本窗口。100 个完整 Shadow 周期仍是 Canary 前置条件，不由本变更自动完成。

## Risks / Trade-offs

- [静态上下文遗漏可变字段] → 上下文只含 config/permit/current ratchet，并在每读先做 exact session mismatch；所有 Game/Memory 市场事实继续 fresh read。
- [快路把 room 变化误判为稳定] → 对全部 observation 做形状、唯一性、准入和 exact basis 比较；不匹配即回完整 reconcile，绝不按旧 scope 继续写。
- [batch quota 与单资源语义漂移] → 单资源 API 反向委托 batch helper，并用 confirmed/pending/cooldown/retry 边界矩阵逐字段比较旧 oracle。
- [Node profile 与 Screeps CPU 比例不同] → 本地 profile 只用于归因；最终收益以 shard1 多 tick Shadow trace 与完整滚动窗口为准。
- [现有工作区包含用户改动] → 只修改市场文件与本 change 工件；部署从基于 HEAD 的干净临时 worktree 生成 bundle，避免夹带 dirty upgrader/hub/colonizer 改动。

## Migration Plan

1. 在主工作区完成最小实现、定向测试、全量测试、TypeScript、build 与 strict OpenSpec validation。
2. 从 `87e28e4` 建立干净临时 worktree，只复制本 change 的已验证 diff并执行 `npm run push`；保留当前 bundle 作为回滚点。
3. 单次 monitor 确认 shard1 deployTag、全部 lane/grant 仍为 `shadow+suspended`、managed/pending/claim/deal 为零。
4. 若出现 canonical blocker、scope mismatch、CPU 恶化或市场写面变化，立即重新部署 `87e28e4` bundle。
5. 等待至少 1200 tick 后读取一次完整滚动窗口，记录前后 CPU；Canary 仍保持关闭。

## Open Questions

- 本轮不把 mixed writable + Shadow 纳入验收；其独立 P1 需要后续 change 和专门的交易能耗预算设计。
