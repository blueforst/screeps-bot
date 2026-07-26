## 0. 前置能力收敛

- [x] 0.1 将已部署 `market-sale-automation` 的 6.8/6.9 明确记录为“Maker live canary 未执行、由 `market-direct-canary` 取代”，同步并归档前置 change；不得伪造 Maker 成交验收。
- [x] 0.2 验证本 change 的 `market-sale-automation` MODIFIED delta 能在 canonical spec 上 strict apply，保留 Maker 行为与 hybrid fail-closed。

## 1. 配置、类型与持久状态

- [x] 1.1 扩展配置归一化，加入 `direct`、`shadowStrategy`、Direct 数量/名义金额/raw/eligible扫描/能量/action/canary/snapshot 上限；首发硬拒绝非 `[X]`、expansion、floor/buffer/terminal reserve 下调、数量/次数/扫描/能量越界及 `maxDirectDealAmount < max(minDealAmount,minDirectOrderAmount)`，旧 Shadow 缺省仍为 Maker。
- [x] 1.2 实现不含生命周期 `mode` 的 `directSafetyFingerprint`；只允许同 revision、同 fingerprint、同 canary 的 `shadow(strategy=direct) -> direct` 激活边保留资格，其他模式边或安全参数变化均清空资格。
- [x] 1.3 扩展 Memory：active `pendingDirectDeals` 仅含 prepared/submitted/reconcile_gap，保存 attempt/baseline/首个物理观测/两个成功缺失 tick、资源与能量 exposure；无法校验的原始 pending/容器进入持久 quarantine；resolved 进入最多 50 条 outcome 审计，并加入 confirmed count、paused 和有界规划快照。
- [x] 1.4 实现旧 runtime/data、canonical/alias 与 statement-boundary CPU cut 的兼容迁移；只恢复明确半状态，present-but-malformed 顶层/Direct/legacy alias 以及 Maker managed/pending-mutation/pending-create 原始证据全部进入持久 quarantine；以单次 canonical container assignment 原子提交 blocker/quarantine 与 typed 清理，任意 CPU cut 至少保留一份证据，并在 Maker reconcile/retry/drain/planning 前锁死全部 market-sale 写入和 Terminal 消费；只有 canonical 与 alias 均安全缺失/为空时才初始化空状态，且 qualification-only blocker 不得掩盖结构损坏或阻塞完整 Direct WAL 的自动/operator 收敛。

## 2. Direct 定价与机会选择

- [x] 2.1 将结构候选和即时 BUY 机会拆分，允许 `safe_no_opportunity` 作为完整 Direct Shadow 结果。
- [x] 2.2 Direct 绕过 Maker 100-tick 缓存读取 current-tick 完整 BUY book；最多便宜过滤 1,000 raw 单、定价 200 eligible 单，尘埃及 gross milli 低于有效净底价的订单不占 eligible 预算，任一超限/失败整周期拒绝，并计算安全部分量。
- [x] 2.3 用计划量和 `calcTransactionCost(1)` 常数次证明全部并发正部分量；复用 milli-credit 保守取整，以整数商/余数精确排序单位净价，再按总净额/gross milli/orderId，所有 safe-integer 越界 fail-closed。
- [x] 2.4 实现 `effectiveEnergyShadowPrice=max(hard floor, explicit, trusted fresh history, ratchet)`，冻结 components/observedAt；explicit 只能抬高，缺可信历史时拒绝。
- [x] 2.5 取消 SELL 深度和 `directDiscountRatio` 对 Direct 的门禁；保留 hard/economic/history/ratchet floor，并拒绝任何 `remainingAmount>0` 的自有 BUY/SELL（无论 active）及 Maker pending/managed/exposure，分别投影 manual buy/sell 原因而不自动取消；仅 remaining=0 不阻断。
- [x] 2.6 写前重读并重排 current-tick 完整 BUY book，必须证明所选仍为最高安全净价；变化时本 tick no-op，下一完整周期才允许重新选择。

## 3. Direct Shadow、Canary 与观测

- [x] 3.1 实现独立 Direct Shadow 连续计数，要求冻结 revision、`directSafetyFingerprint`、canary 和完整安全决策，但不要求高价订单持续存在。
- [x] 3.2 按 pressure→sellable↓→terminalStock↓→room/resource↑ 确定性锁定唯一非 Hub、非 emergency 结构 canary；BUY 机会不参与 lock，输入重排结果不变。
- [x] 3.3 实现 Direct active 的资格门禁：100 个 Direct Shadow 周期、显式 `mode=direct`、相同 revision/fingerprint/canary、合法的 Shadow→Direct 激活边且 confirmed count 未达上限。
- [x] 3.4 第一笔确认后进入本 change 内不可由配置解除的 `paused_for_review`；Direct Shadow 不再累计且 activationAuthorized 恒 false，只改 revision、重跑 Shadow 或打开 expansion 仍零 deal，未来扩围必须新 capability delta。
- [x] 3.5 分离生命周期与最后规划快照；非规划 tick 保留证据，`maxAge=ResourceControl interval(当前10)`、age==limit fresh、limit+1 stale。
- [x] 3.6 扩展 monitor，展示 Maker SELL、Direct current BUY/扫描上限、最高价、planned/worst milli net、effective energy shadow 组成、pending/exposure、manual orders 和安全等待原因。

## 4. Direct 写入、仲裁与对账

- [x] 4.1 实现 exact config/fingerprint/canary/protection/current book/self orders/terminal/effective energy shadow/arbiter 的同 tick写前重验；生产 emergency buy 或其他 market intent 优先，但 intent 仅在选出 current-tick 可执行订单并通过本地写前检查后、调用紧前声明，空需求不得形成 Shadow 活锁。
- [x] 4.2 `deal` 前写 active pending，保存 exact attemptAt、outgoing key/window baseline、terminal/credits 前态、冻结定价与资源/transaction-energy exposure；OK 按 resultCode→submittedAt→status commit marker 顺序写，跨 tick prepared 视为不确定已提交且绝不重提。
- [x] 4.3 仅由 arbiter 执行 Direct；prepared 后 claim terminal/account，OK/异常保守到 attemptAt+1 最早 preflight，非 OK 写 failed outcome；preflight 后生产购买可用 reservation 外余额并写 action journal。
- [x] 4.4 只接受基线后新增、`time===attemptAt`、ORDER_BUY、from/to/order/resource/price/amount 唯一匹配的 transaction；按 actualAmount 与冻结 effective energy shadow 重算 milli net，先写 outcome 再释放整笔 exposure/增加一次 confirmed。
- [x] 4.5 持久化 attemptAt+1 首个物理观测与两个不同成功缺失 tick；恢复 observation 后 CPU cut 的原首 tick，缺 tick/窗口/前态或多条匹配进入 gap。实现默认拒绝的 `resolveDirectPending`；operator-confirmed 复用原子 finalize、count 只增一次并立即 paused，operator no-fill 用完整窗口+物理指纹做 exact 幂等，内容冲突即暂停。
- [x] 4.6 将 pending Direct/exposure 纳入 emergency stop、drain、零确认和旧 bundle 回滚门槛。
- [x] 4.7 更新 generic Carrier terminal-energy、remoteCarrier 任意资源、task-bound Carrier/Synthesis/terminal 路径，全部尊重 Direct claim 及资源/能量 reservation；gap 不得永久阻塞 reservation 外生产。

## 5. 测试与静态门禁

- [x] 5.1 新增定价/CPU测试：高价小单优先、远近净价、单张 BUY、amount=1 最坏取整、599.999/600/低1 milli、非整除、单位净价差1 milli、输入重排、1000/1001 raw 与200/201 eligible边界、尘埃不占 eligible 预算，以及201张gross<floor加1张665.8仍选安全单且无 O(order×amount) 放大。
- [x] 5.2 新增 X 回归测试：`665.8 × 1,000`、底价 600、SELL 侧仅两个有效房间时仍形成 Direct 机会。
- [x] 5.3 新增 Shadow/配置测试：safe_no_opportunity、SELL 深度不清零、100周期、合法激活边、经其他mode清零，以及首发 allowlist/floor/buffer/terminal reserve/数量/次数/raw与eligible扫描/能量/expansion 每个越界均零 deal；第一笔后只改 revision 也不能解锁。
- [x] 5.4 新增执行/对账测试：旧同tuple不确认、同tick多匹配gap、提交1000实际1释放999且只计1次、两成功tick+四项不变才not_filled、任一前态/窗口/首tick缺失即gap、deal后抛错/CPU statement-boundary recovery/prepared不重提、canonical/alias CPU cut、qualification-only损坏不阻塞自动/operator收敛、operator证据拒绝/确认、no-fill完整证据指纹冲突、confirmed后换 revision 重跑100 Shadow仍零资格/零deal，重复resolution不重复计数。
- [x] 5.5 新增生产兼容测试：保护上升、terminal energy、ResourceControl claim、三类 Carrier 抢占、完全预留的高优先级 task 不得连续饿死 reservation 外生产 task、任意remaining>0自有BUY/SELL阻断、inactive低价SELL补货重启active仍阻断、仅remaining=0不阻断、attempt/preflight global claim、gap+emergency buy 使用 reservation 外余额、quarantine/migration blocker全局保护和 emergency stop；clean Direct 单独注入 malformed managed container/entry、pending mutation、pending create，并保留一个 live 合法 managed sibling，验证 preflight/automation 两个入口的完整 schema/生成态交叉不变量隔离、单次 canonical commit、JSON-roundtrip 后 deal/create/extend/reprice/cancel 持续零写；另用 `totalAmount=1000, exposure=0`、低报 create fee 的近似合法 pending create 和带 live order 的 orphan pending mutation 证明不能欠保护，orphan 隔离后生产 Terminal send 必须 fail-closed。
- [x] 5.6 新增观测测试：非规划 tick 不清空，age==10 fresh/11 stale，`manual_sell_order_present` / `manual_buy_order_present`、order scan budget、energy components 与 pending/outcome 有界。
- [x] 5.7 更新静态市场写门禁，继续保证只有 arbiter 包含真实 `Game.market.deal` 调用。
- [x] 5.8 固定 engine commit `8097782...` 的费用/underfill/transaction tuple/time/cooldown/_skip/inactive订单按实时条件重激活 fixture，漂移时 Direct fail-closed。
- [x] 5.9 运行聚焦 Jest、完整 `npm test`、`npx tsc --noEmit`、`npm run build`、`git diff --check` 和 `openspec validate --strict`。

## 6. 独立审查与 Live Canary

- [x] 6.1 由独立 subagent 审查方案与实现，关闭所有 P0/P1/P2 后才允许合并。
- [x] 6.2 合并 main 并部署新 bundle，保持旧 ResourceControl/Factory 出售、Pixel、Maker/其他出售写关闭；Factory/Boost/emergency buy 继续经 arbiter。写入固定 `[X]`/1000量/600000名义额/1deal/1confirm/1000raw/200eligible/1000交易能量/25000 terminal reserve/energyHardFloor20/floor600/buffer100000 的新 revision Direct Shadow。
- [x] 6.3 实时验证唯一动态 canary、生产可售量、BUY 净价、持续诊断投影以及市场写/claim/pending/exposure 全为零。
- [x] 6.4 在冻结配置下累计 100 个完整 Direct Shadow 周期；任一安全违规、配置变化或输入缺失必须清零重跑。
- [x] 6.5 再次独立审查 live Shadow 证据，通过后显式切换 `mode=direct`，首次最多提交 1,000 X。
- [x] 6.6 唯一确认第一笔 outgoing transaction，用 actualAmount、transaction price、实际取整 energy 与 pending 冻结的 effective energy shadow 重算保守 milli `actualNet>=effectiveNetFloor`，同时核对 worst-case、保护量、terminal 和自动 `paused_for_review`。
