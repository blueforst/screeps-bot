## 1. 冻结基础矿物与 V3 配置合同

- [x] 1.1 实现精确 `H/O/U/L/K/Z/X` raw allowlist validator；额外资源、重复项和额外 threshold key 整体 fail-closed
- [x] 1.2 签入排除 rolling 两端 partial 的 91-row canonical floor JSON+SHA，验证器重算 accepted/rejected/reference/trusted95/policy；定义七个 immutable policy/bootstrap
- [x] 1.3 定义 bounded `owned-visible-terminal-v1` RoomAdmissionPolicy、`maxRooms=16/maxKnownRoomNames=32/maxLanes=112`、不可回退 room-incarnation high-water/previous-instance chain 和稳定派生 lane ID
- [x] 1.4 扩展类型/normalizer、固定 ring/checkpoint；permit 保留 `min(64,total)` suffix，binding source仅512 receipt+112 active review、hard cap624，实现 pin discharge/超界零写
- [x] 1.5 覆盖白名单、禁止资源、高价禁止订单、bootstrap 缺失/重复/回拨、自动新房准入、同 owner+同 terminal 重占、normal→hub→normal、Memory/checkpoint rollback 和所有上界单测

## 2. V2 兼容迁移、Lifecycle 与 Permit

- [x] 2.1 保留不可变 v2 evaluator/codec；无 discriminator event 仅在 outer v2 或 authenticated seq cutoff 内按原始 v2 bytes 验证，禁止补字段；v3 event 必须显式版本
- [x] 2.2 首个 v3 successor 签入 v2 event cutoff并链接 opaque tip；原子维护 tip/high-water/cutover/ledger/permit-prefix、64-record suffix、binding map 和 totalChainLength
- [x] 2.3 分离动态 `DerivedLaneLifecycle` 与 permit-only `SignedLaneGrant`：自动准入只创建 `shadow+suspended` lifecycle，首个登记 successor 仍 suspended，至少下一 successor 才可 Canary
- [x] 2.4 首个 v3 successor 在同一提交中 suspend legacy X；在中央 append/accept 层强制新增或 fingerprint 变化 grant suspended，拒绝 legacy bridge、旧 policyId 原地扩房、降 floor/reserve 或放宽 scope
- [x] 2.5 实现逐 lane 100-cycle Shadow、qualified、one-shot canary、review_paused、review digest 与 successor continuous
- [x] 2.6 覆盖 codec/cutoff 故障、epoch<64与65/129、suffix predecessor、binding 624/625及 tombstone非法引用、pin释放、retained幂等/pruned重签和 high-water rollback

## 3. 多房间全局最高净价规划

- [x] 3.1 移除全部 `allowedRoomNames[0]` 假设，为每个 resource 构造完整动态 lane universe
- [x] 3.2 每次 full read 每资源只读一次不可变 BUY book并共享；实现 order/transaction-cost memo、全 book distinct orderRoom 128 hard cap、同 ID 去重/冲突、跨资源重复、自有订单排除与二读 fresh-object 门禁
- [x] 3.3 实现 writable lane 全局完整性、suspended Shadow 局部隔离、shared/unknown 全局 fail-closed
- [x] 3.4 对全部安全 tuple 执行 planned/worst-unit floor、terminal energy、名义额、全局单位净价排序与稳定 tie-break
- [x] 3.5 写前双读动态 roster/lane set、非选中 lane、book/order、terminal/protection/energy/quota/permit/arbiter；任一变化零写
- [x] 3.6 实现 raw/eligible/distinct-orderRoom/evaluation/CPU hard budget，测试 `2×16×128=4096` 与 129 目的房；writable 永不轮转或截断，超限整轮零写；仅 suspended Shadow 用 8-lane cursor
- [x] 3.7 覆盖多房同资源、跨资源、高价小单/低价大单、远距高 gross、非选中 lane 变优、动态 roster 变化、56/112 lane 无饥饿轮转、cursor 重映射与预算超限测试

## 4. 生产保护、Hub 与 Terminal Energy

- [x] 4.1 Hub 实际 planning 一开始、任何 early return 前递增 attempt high-water 并使旧 snapshot 不可接受；在局部构造完整 `nextCommittedHubProtectionSnapshot`，所有缺项显式为空并绑定同一 revision，success/blocked/early-return/throw/CPU-cut 均经单出口整包提交 committed 或 invalid empty
- [x] 4.2 让 protection adapter 只使用 fresh committed snapshot 而非 legacy 字段或 `needsPlan`；保留配置漂移、跨 revision、结构异常和未知事实的全局 fail-closed
- [x] 4.3 从同 revision committed allocation residual 计算 Hub 七种基础矿物 surplus 上界；无 residual、distributed→fallback/blocked、residual 缩小均不得复用旧值，白名单外 surplus 不得进入现代市场
- [x] 4.4 允许 protection 完整的 pressure/emergency Direct lane 使用 terminal 实存安全出售，不给容量状态价格、批次或额度加成
- [x] 4.5 发布 current `effectivePostDealEnergyReserve`；把普通 Energy feed 与 readiness 合成单一 desired target，按 stable ID 与 staging/offload/claim 在同一 per-room draft pass 去重仲裁，合并后检查 40k，并每房每 tick只整包 replace 一次；读取 canonical `Memory.data`
- [x] 4.6 覆盖 Hub 同 tick replan request、distributed→fallback/blocked、residual shrink、所有 early return/throw/CPU cut/部分写；覆盖 normal/pressure/emergency、survival、pending send/生产承诺、E6 2,347、existing feed、combined staging、offload conflict、duplicate ID、replacement-loss/调用一次
- [x] 4.7 固定 `marketSalePreflight → pixelGenerator(disabled) → productionMonitor → hubPlanner → hubUpgradeControl → synthesisControl → factoryControl → mineralExtraction → resourceControl → marketSaleAutomation` 完整回归，禁止第二次同 tick Hub planner或重排

## 5. WAL、Quota、观测与旧路径闩

- [x] 5.1 v3 pending/outcome/receipt 各自显式冻结 schema/hash revision；legacy v2 由 authenticated cutoff 分派；pending 冻结历史 permit、incarnation/lane、当时动态 scope、双读和四层 quota
- [x] 5.2 精确按 global=全部、resource=resource、room=sellerRoom、lane=resource+sellerRoom 跨 v2/v3 聚合 cap；保留 account-global 1,000 confirmed cooldown/retry backoff，并连续计入 partial actual 与四层 unmatched reservation
- [x] 5.3 保持单 pending、固定 1,000、单 tick 一次写和 `outcome→receipt/head/checkpoint/lifetime→processed key→delete` 提交顺序
- [x] 5.4 扩展 console/monitor，投影 catalog/admission/current roster/lane lifecycle、permit、quota、Hub marker、energy readiness、CPU blocker 的有界摘要
- [x] 5.5 对 Pixel、legacy ResourceControl/Hub/Factory seller、Maker/hybrid 加代码级永久闩；验证配置误开仍不能消费新 base surplus，且唯一 `Game.market.deal` arbiter 入口不变
- [x] 5.6 覆盖跨版本 pending 后 scope 变化、historical permit/prefix binding 损坏、部分成交/CPU-cut、512 receipt coverage、终态槽预留、ring 满仍收敛 pending、quota 与 bounded Memory

## 6. 验证与独立复审

- [x] 6.1 运行 policy/config/lifecycle/permit/WAL/planner/pricing/protection/resourceControl/monitor 定向 Jest
- [x] 6.2 运行 `npx tsc --noEmit`、`npm run build`、静态市场写门禁与 `openspec validate market-base-resource-all-rooms --strict`
- [x] 6.3 运行完整 Jest，记录套件/测试数、CPU fixture 与冻结 diff
- [x] 6.4 由独立 subagent 分别审查 permit/WAL、价格/多 lane、生产/Hub/Energy，修复全部 P0/P1

## 7. 合并、部署与 Live 分阶段启用

- [x] 7.1 将审查通过的 worktree 分支合并到 main，确认无用户改动被覆盖并运行最终 smoke
- [ ] 7.2 `npm run push` 部署兼容 bundle，核对 deploy tag、Pixel/legacy sellers 关闭、v2 state/ledger/quota 无损与零异常 pending
- [ ] 7.3 验证 Hub committed snapshot 至少跨两个 planInterval，E6 readiness feed 在无更高承诺时达到 26,000 且不侵占生产/terminal headroom
- [ ] 7.4 在 WAL 静止时提出并签收首个 v3 successor：同 tick suspend legacy X，按部署时实际 roster 登记全部 lane 为 shadow+suspended，并核对未来新房只能自动加入 Derived Shadow
- [ ] 7.5 完成 100 个完整 Shadow 周期，优先对当前大额 surplus lane 逐一签发 one-shot canary
- [ ] 7.6 每笔 canary 后独立复核实际净价、生产、terminal、receipt/quota，再签收 successor continuous；任一异常只安全收窄或 Emergency Stop

## 本地验证记录（2026-08-03）

- `npx tsc --noEmit`、`npm run build`、`git diff --check` 与 `npx openspec validate market-base-resource-all-rooms --strict` 均通过。
- 完整 Jest：115 个 suite、3189 个 test 全部通过；定向 512 receipt 满环 fixture 同时断言 cold runtime gate 最多一次 full audit、hot automation 不再重复 full/runtime gate，quota receipt 在已认证 context 内复用，且同一 25 CPU 窗口覆盖 outer preflight 到 claim。
- 性能门禁：cold preflight P95 `<100ms`、ResourceControl+terminal read P95 `<75ms`、hot automation P95 `<20ms`、总 P95 `<150ms`；本轮 full Jest 的 512-ring prepare P95 为 `8.802ms`，三路独立终审中的 cold fixture 连续复跑均通过，诊断探针已删除。
- 静态市场写面检查：`Game.market.deal` 仅存在于 `marketActionArbiter` 的受控执行入口；Pixel、legacy seller 与 Maker/hybrid 均由代码级闩阻断。
- 主分支快进合并后最终 smoke：`main`、upgrader 与基础矿物自动化共 3 个 suite / 70 个 test 通过；512 receipt cold-Memory active outer tick 定向 fixture 通过。
