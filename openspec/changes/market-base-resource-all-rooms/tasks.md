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
- [x] 3.8（历史实现，已由 3.10 取代）在纯 suspended Shadow、全资源 `eligible=0` 且无 writable lane 时只对 exact ready 子集合并一次多资源 planner 调用，并保留局部 incomplete reset；严格验证 capability/artifact/覆盖/零候选/零回调，失败用新 capability 回退，CPU cut 不推进，并省略无写消费者的 full-read evidence 深哈希
- [x] 3.9（历史实现，已由 3.10 取代）在纯 suspended Shadow `eligible>0` 时只批处理 exact ready 子集；保留局部 incomplete reset，禁止 normalization capability 和 selected/admitted 外泄，验证冻结 book/order/binding/预算/callback，原生能耗 miss 前后 CPU 截断，并投影 planner mode/invocation/实际 evaluation 标量
- [x] 3.10 将 suspended Shadow 统一改为冻结 catalog resource-major cohort：按全部 active lane 固定最多 8 条单资源分块、版本化 `(resource,laneId)` anchor/legacy remap；恢复 eligible=0 validation-only 专支并投影资源数/候选身份检查标量。该项仅批准全 Shadow 部署，mixed CPU 仍为 Canary 前硬门
- [x] 3.11 将 25 CPU 同一窗口扩展到批/逐 lane planner 前后，候选身份扫描每 32 条复核；CPU cut 前未实际执行 fallback 时保持真实 mode，并明确双读资源宽度取最大值、身份检查量累加的遥测语义
- [x] 3.12 将 25 CPU 窗口继续覆盖 outer session、scope core、market facts、Shadow batch、inner apply、完整候选 root 私有注册与最终 precommit；最终 fresh CPU read 后重做 exact root/context CAS，超限丢弃全部正向进度，只允许最多 8 条已采样 suspended Shadow/qualified lane 的必要 incomplete reset-only root

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
- [x] 5.7 增加 runtime-only bounded CPU trace；固定五个累计分段、首个 cut phase 与 market-facts disposition，canonical 正常提交时可镜像 snapshot，但任何字段均不得参与 permit、价格、保护、quota 或授权；未提交 canonical root 时 monitor 仍优先展示更新的 runtime trace

## 6. 验证与独立复审

- [x] 6.1 运行 policy/config/lifecycle/permit/WAL/planner/pricing/protection/resourceControl/monitor 定向 Jest
- [x] 6.2 运行 `npx tsc --noEmit`、`npm run build`、静态市场写门禁与 `openspec validate market-base-resource-all-rooms --strict`
- [x] 6.3 运行完整 Jest，记录套件/测试数、CPU fixture 与冻结 diff
- [x] 6.4 由独立 subagent 分别审查 permit/WAL、价格/多 lane、生产/Hub/Energy，修复全部 P0/P1
- [x] 6.5 对 post-apply/precommit CPU gate 运行 0/1/8 reset、clone/replay、root setter/CAS、same-tick reentry、prepared WAL 优先级、monitor 兼容与完整 Jest；再由三路独立 subagent 终审并修复全部 P0/P1

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

## Shadow 批规划优化验证记录（2026-08-07）

- `npx tsc --noEmit`、`npm run build`、`git diff --check` 与 `openspec validate market-base-resource-all-rooms --strict` 均通过。
- 完整拆分 Jest：排除 wall-clock Ledger benchmark 的 114 个 suite / 3,210 个 test 全部通过；`marketBaseResourceLedger.test.ts` 独立 1 个 suite / 21 个 test 全部通过，合计覆盖 115 个 suite / 3,231 个 test。
- Ledger 独立基准：cold runtime gate median/p95 为 `5.929/6.116ms`，prepare median/p95 为 `8.784/10.902ms`；未修改其阈值。
- 实时盘口形状 fixture（5 resource、8 Shadow lane、112 raw、collector `eligible=0`）只执行一次多资源 normalization artifact、零 transaction-energy callback、八条 observation 完整；批失败、CPU cut、输入乱序、pending/arbiter、terminal/protection incomplete 和 fresh capability 回退均有确定性测试。
- 三路独立终审分别复核 lifecycle/权限、订单簿/CPU、生产/OpenSpec/测试；修复混合 writable scope 丢失较早 lane-local reset 的 P2 后，最终 P0–P3 均为零并批准仅以 Shadow 部署。真实交易授权未改变。

## 候选订单 Shadow 批规划优化验证记录（2026-08-07）

- 最终 `npx tsc --noEmit`、`npm run build`、`git diff --check` 与 `npx openspec validate market-base-resource-all-rooms --strict` 均通过。
- 最终拆分 Jest：排除 wall-clock Ledger benchmark 的 114 个 suite / 3,216 个 test 全部通过；`marketBaseResourceLedger.test.ts` 独立 1 个 suite / 21 个 test 全部通过，合计 115 个 suite / 3,237 个 test。
- Ledger 独立基准保持门禁内：cold runtime gate median/p95 为 `5.737/5.912ms`，prepare median/p95 为 `8.640/9.078ms`；未修改阈值。
- 线上同形状 fixture 固定 6 resource、8 sampled lane、6 unique seller room、94 raw、8 eligible、8 distinct order room 与 collector budget 96；4 条 production protection incomplete lane 保留局部 reset，其余 4 条 exact ready lane 只执行一次 candidate batch，normalization observer 为 `false`、原生 transaction-energy evaluation 为 12，fresh-capability fallback oracle 的逐 lane 结果完全一致。
- CPU fixture 在第 5 次原生 transaction-energy 计算后越过 25 ceiling，随后零原生调用、零回退、零 cursor、零 formal selected；全 Shadow runtime fixture 同时断言零 WAL commit、零 claim、零 deal。另覆盖同一 seller room 的 L/U 均 ready 但机会结果不同，以及 ready Hub candidate，锁定 `resource+room+laneId` 精确投影。
- 三路终审发现并修复：旧/上一 tick planning snapshot 遥测继承、第二读失败漏计实际调用、late writable early-return 漏计 Shadow 调用，以及 eligible=0 exact-ready-subset 的 OpenSpec 漂移；所有修复均有确定性回归。
- 部署前 live 基线 tick `72833950` 仍为 `1e4416a`：planning complete、CPU `23.440539199997147`、raw 116、eligible 8、distinct order room 8、budget 80；全部 grant 仍为 Shadow+suspended，formal selected/WAL/claim/deal 为空。真实交易授权与生产保护均未放宽。

## Resource-major Shadow Cohort 修复验证记录（2026-08-07）

- 最终 `npx tsc --noEmit`、`npm run build`、`git diff --check` 与 `npx openspec validate market-base-resource-all-rooms --strict` 均通过。
- 最终拆分 Jest：排除 wall-clock Ledger benchmark 的 114 个 suite / 3,223 个 test 全部通过；`marketBaseResourceLedger.test.ts` 独立 1 个 suite / 21 个 test 全部通过，合计 115 个 suite / 3,244 个 test。Ledger cold runtime gate median/p95 为 `5.774/5.897ms`，prepare median/p95 为 `8.604/9.202ms`，未修改门禁阈值。
- suspended Shadow 现按冻结 catalog 的单资源 cohort 轮转：8/16 房分别在 7/14 周期覆盖 56/112 lane，9 房严格按每资源 `8+1` 在 14 周期覆盖 63 lane；legacy、删除、损坏 cursor、writable anchor 过滤、Hub/ready subset 与局部 production incomplete 均有确定性回归。纯 Shadow 每个 full read 只读取一个资源 book；`eligible=0` 的 candidate identity/transaction-energy 均为零。
- 同一 25 CPU 窗口现覆盖 batch/per-lane planner 与外部 artifact 前后，候选身份扫描每 32 条检查一次；CPU cut 不再进入尚未发生的 fallback、不推进 cursor、不形成完整 observation，mode 保持实际路径。`evaluatedShadowResourceCount` 明确为单次 full-read cohort 的资源宽度，双读取最大值；身份检查量按两读累加。旧 planning snapshot 缺新增字段时 monitor 安全投影 `null`。
- 部署前 live 旧版本 `32991bd` 在 tick `72834960` 仍复现跨资源批次 CPU `27.593771399988327`、`market_base_cpu_ceiling_exceeded`；56/56 grant 均为 `shadow+suspended`，managed/pending mutation/pending create/terminal claim 均为零，证明当前故障与本修复目标一致且未发生新市场写入。
- 三路独立终审中，文档/兼容测试与细粒度 CPU/遥测 P2/P3 均已修复并复核关闭；唯一保留问题是 same-resource mixed `1 writable + 7 Shadow + 128 order-room` 双读可达 4,096 次原生 transaction-energy 的交易活性 P1。该 P1 不阻断全 `suspended_shadow` 部署观察，但继续硬性阻断任何 Canary/Continuous/writable permit 与真实成交。

## Shadow CPU Trace 与最终提交门禁验证记录（2026-08-07）

- 最终 `npx tsc --noEmit`、`npm run build`、`git diff --check` 与 `npx openspec validate market-base-resource-all-rooms --strict` 均通过；静态写面仍只有 `marketActionArbiter` 持有受控市场写入口。
- 受影响面定向回归为 3 个 suite / 185 个 test 全部通过。完整拆分 Jest：排除 wall-clock Ledger benchmark 的 114 个 suite / 3,256 个 test 全部通过；`marketBaseResourceLedger.test.ts` 独立 1 个 suite / 21 个 test 全部通过，合计 115 个 suite / 3,277 个 test。
- Ledger 独立基准保持门禁内：cold runtime gate median/p95 为 `5.735/5.838ms`，prepare median/p95 为 `8.623/8.973ms`；未修改任何阈值。
- 同一 25 CPU 窗口现覆盖 inner 入口首次读数、outer session、scope/facts/Shadow planner、inner apply 与最终 precommit。入口读数直接初始化不可回拨 raw high-water；回拨、无效、超过 25 或已有 first-cut 均永久闭锁。第二读 partial failure 只更新 raw high-water，里程碑必须保持 prefix-complete/trailing-null，monitor 对非单调、null-hole、额外字段和越界值整条 fail closed。
- inner 通过不持久化的 `cpuRawHighWater` 把 partial trace 未能表示的 raw 峰值交给 outer；outer 在任何 root 注册或 fresh CPU callback 前逐字段冻结精确 trace 并复制 primitive high-water。覆盖 `24→22` 回拨、高水位缺失、fresh callback 篡改返回对象、0/1/8 reset-only、clone/replay、setter throw/throw-after-write/swallow/substitute、exact CAS、same-tick reentry、full-root 注册失败与 prepared WAL 优先级。
- 三路独立终审最终均未发现本次范围的 P0/P1/P2，并批准只保持全部 lane/grant 为 `shadow+suspended` 的 Shadow-only 合并部署。same-resource mixed writable+Shadow 的 25 CPU 活性仍是独立 P1，继续硬性阻断 Canary、Continuous、writable grant 与真实成交。
