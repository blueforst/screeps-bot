## ADDED Requirements

### Requirement: Continuous 必须使用 Canonical 多资源执行表
系统 MUST 只从已签收 permit 的 canonical execution table 读取可写 lane。每个 entry MUST 显式冻结 resource、allowed rooms、requireNativeMineral、hard/economic floor、lane reserve、最小订单量/名义额、单笔上限、cooldown、rolling window/cap、safe-opportunity reserve、raw/eligible scan budget、max transaction energy、terminal energy reserve 与 resource fingerprint；entry 和房间列表必须稳定排序。所有 lane 必须为自有、非 Hub、非 capacity emergency 且 terminal 正常。

#### Scenario: 首批执行表
- **WHEN** 首版 policy 被规范化
- **THEN** 表必须精确包含 X/E6N59 reviewed exception、原生 H/E3N59、原生 Z/E7N57 三个 entry，且不得自动加入其他资源或房间

#### Scenario: 首批逐资源阈值
- **WHEN** 系统读取三个 entry
- **THEN** X 必须为 floor 600/600、buffer 100,000、min executable notional 600,000、30k cap 8,000；H 为 428/451、100,000、451,000、8,000；Z 为 43/45、100,000、45,000、5,000；三者的 safe-opportunity reserve/raw scan/eligible scan/max transaction energy/terminal energy reserve 均精确为 1,000/1,000/200/1,000/25,000；notional 一律按固定 1,000 计划量乘 gross price 计算，不得用整张订单量扩大名义额

#### Scenario: 共享上限
- **WHEN** 任一 entry 参与规划
- **THEN** 计划量必须恰为 1,000、cooldown 1,000、terminal energy reserve 恰为 25,000，且全资源 30,000 tick cap 为 12,000

#### Scenario: 未授权商品出现高价
- **WHEN** Energy、Power、ops、Pixel、G/O、U/L/K、化合物、Boost、Factory/Deposit/seasonal 商品出现高价 BUY order
- **THEN** 系统不得生成 tuple、Shadow 资格或市场写

#### Scenario: 原生矿不匹配或房间进入 Emergency
- **WHEN** H/Z lane 的 room mineralType 不再匹配，或任一 lane 成为 Hub、非自有、capacity emergency、terminal 不正常
- **THEN** 该 lane 不得生成 tuple；输入事实不完整时全局零写

#### Scenario: 配置增加资源或房间
- **WHEN** config 增加未在 current permit 中的资源、房间或放宽任一阈值
- **THEN** current permit 不得扩围；配置与 permit 不一致时全局零写，直到 successor permit 完整签收

### Requirement: 每个资源必须独立完成 Lifecycle
每个 entry MUST 独立保存 `shadow/qualified/canary/review_paused/continuous` lifecycle、revision、fingerprint、连续周期和 canary evidence。X MAY 仅通过精确匹配既有 reviewed outcome 进入 continuous；H/Z MUST 各自完成 100 个完整 Shadow 周期、最多一笔 canary 和独立 review 后才能进入 continuous。

#### Scenario: X 复用既有证据
- **WHEN** v1 state 中唯一 confirmed outcome 的 canonical digest 精确匹配 request `direct:72585530:E6N59:X` 与 transaction `6a65f8e1656d080013d32210`
- **THEN** X entry 可以形成 `review_paused` migration evidence；permit 签收前仍零写

#### Scenario: H 或 Z 首次加入
- **WHEN** H/Z 没有本 entry 的 100 个完整 Shadow 周期和 reviewed canary
- **THEN** 它不得继承 X 的资格、floor、quota 或 transaction evidence

#### Scenario: Entry-Local Shadow Fingerprint 变化
- **WHEN** 只有某 entry policy、allowed room、floor、buffer 或本 entry Shadow evidence revision/fingerprint 变化
- **THEN** 只把该 entry 的 consecutive complete cycles 清零并从新 fingerprint 重新累计 100 周期；其他 entry 的历史与 quota 不变

#### Scenario: Shared Fingerprint 变化
- **WHEN** engine assumption、共享 Direct fingerprint、global quota/cooldown 或 canonical hash revision 变化
- **THEN** 所有引用该 shared fingerprint 的 entry 必须清零连续 Shadow；既有 qualified/canary grant 失效，continuous entry 全局零写直到 successor permit 携带重新审查的共享证据，任何 receipt/quota/lifetime 历史不得清除

#### Scenario: Shadow 安全等待
- **WHEN** 保护、历史、能量和完整 BUY book 均可信，但该 entry 没有高于净底价的 BUY tuple
- **THEN** 该周期计为完整 Shadow，并记录 `safe_no_opportunity`；不得降低底价

#### Scenario: Shadow 输入不完整
- **WHEN** entry 的 book、history、permit proposal、ledger coverage 或无法界定作用域的 protection collector 输入不完整
- **THEN** 该 entry 连续计数清零且本 tick 全局零写；若保护事实完整且能精确界定为某 resource 的 donor 候选 lanes，则只阻塞该 resource 的全部候选 lanes，其他 entry 可在自身与全局证据完整时继续

#### Scenario: Canary 确认
- **WHEN** H 或 Z canary 唯一确认一笔正实际量
- **THEN** 只有该 entry 进入 `review_paused`，其 canary grant 自动失效；其他 entry 的历史、permit 和 rolling 用量不得清零

#### Scenario: 新资源完成审查
- **WHEN** operator 提供该 entry canary 的完整 canonical digest 并签收引用当前 permit/ledger head 的 successor permit
- **THEN** successor 可以把该 entry 推进 continuous，同时继承全部旧 receipt 与额度

### Requirement: 市场写必须由不可变 Permit Chain 授权
系统 MUST 只允许 permit 冻结的 `executorShard=shard1` 执行 account market 写，并保存该 shard-scoped append-only permit chain。permit MUST 包含 epoch/permitId、account identity、executorShard、capability/schema、engine/Direct fingerprint、canonical execution table、entry grants、完整 reviewed evidence digest、global limits、previous permit ID、previous permit head、previous ledger head 和 operator authorization fingerprint。state 与 checkpoint MUST 保存 current epoch/ID/head 以及不可回退的 `permitEpochHighWater/permitChainHeadHighWater`；current 必须是最高连续 epoch 的 chain tip。首个 epoch 为 1，successor epoch 必须恰为 high-water+1。permit 必须先落盘自校验，之后才能准备 pending。

#### Scenario: 相同 Permit 重试
- **WHEN** 相同 epoch、canonical content 与 permitId 被重复签收
- **THEN** 系统只验证已存 permit 内容后幂等 no-op，不得因当前 ledger head 已前进而拒绝，也不得生成第二 permit、重置额度或重复授权

#### Scenario: 冲突二次签收
- **WHEN** 同 epoch 出现不同 digest，或相同 evidence 指向不同内容
- **THEN** 系统进入持久 `permit_conflict` blocker，普通配置修改不得解除

#### Scenario: Successor 未引用当前 Head
- **WHEN** successor epoch 不连续，或 previous permit ID/permit head/ledger head 与持久状态不一致
- **THEN** successor 必须被拒绝且 current permit 不得被覆盖

#### Scenario: Successor 与 Pending 交错
- **WHEN** 存在 pending、quarantine、gap 或 unmatched resource/global reservation
- **THEN** 新 successor 不得签收；必须先按旧 permit 将 WAL 与 reservation 收敛到零

#### Scenario: Permit Tip 被回拨或删除
- **WHEN** current pointer 不指向 permitEpochHighWater 的连续 chain tip，或 checkpoint 的 epoch/head high-water 与 state 不一致
- **THEN** 系统进入持久 `permit_conflict`，不得重新启用旧 permit

#### Scenario: Permit 在其他 Shard 复用
- **WHEN** 同一 permitId 被请求在非 executorShard 执行
- **THEN** shard identity 校验必须失败且零 deal

#### Scenario: 配置 Revision 变化
- **WHEN** operator 只改变 config revision、enabled 或 entry stage，而没有合法 successor permit
- **THEN** 系统必须零写，旧额度、lifetime 和 audit history保持不变

#### Scenario: Successor 安全收窄 Grant
- **WHEN** successor 把某 entry 的 new-deal grant 改为 suspended
- **THEN** 系统可以停止该 entry 新 pending，但必须保留并继承其 lifecycle、evidence、receipt、rolling/lifetime 与 high-water；恢复 grant 必须再签收合法 successor，不能产生新额度

#### Scenario: Outcome 审计环裁剪
- **WHEN** reviewed canary 的旧 outcome 已从 50 条 audit ring 裁剪
- **THEN** permit 内保存的完整 evidence digest 仍可验证授权；系统不得依赖已裁剪 outcome 重新构造不同证据

### Requirement: Continuous 必须全局优先最高安全单位净价
系统 MUST 对 current permit 所有可写 `(entry, seller room, BUY order)` 生成 1,000 单位 tuple，并在通过 resource/global quota 与 safe-opportunity reserve admission 的全部安全 tuple 中按动作后单位净价、总净额、gross price 降序及 resource/room/orderId 稳定升序全局排序。库存、容量压力、资源顺序和订单剩余量不得排在价格之前；opportunity reserve 只能决定准入，不能改变已准入 tuple 的价格顺序。

#### Scenario: 高价小单与低价大单
- **WHEN** 两个订单均至少能成交 1,000，较小订单动作后单位净价更高
- **THEN** 系统必须选较高单位净价订单，不得因另一订单剩余量更大而优先

#### Scenario: 同资源不同房间
- **WHEN** 同一 BUY order 可从两个 allowed rooms 成交，近端房间单位净价更高
- **THEN** 系统必须选择近端安全 lane，不能按 sellable 或 capacity pressure 先选房

#### Scenario: 不同资源同时安全
- **WHEN** X/H/Z 同 tick 存在安全 tuple
- **THEN** 系统必须按精确单位净价全局排序，不依赖配置或对象遍历顺序

#### Scenario: 更高 Gross 但更低 Net
- **WHEN** 较高标价 tuple 扣除 transaction energy 后单位净价更低
- **THEN** 系统必须选择实际单位净价更高者

#### Scenario: 任一参与 Book 不完整
- **WHEN** 任一可写 entry/lane 的 BUY book 读取失败、超 raw/eligible 扫描预算或无法证明完整
- **THEN** 本 tick 全局零写，不得只在剩余资源中降级选择

#### Scenario: 写前最佳 Tuple 变化
- **WHEN** 第二次完整重读中任一参与 book、order tuple/remaining、terminal cooldown/stock/energy、protection revision/sellable、credits、transaction energy、单位净价、amount=1 最坏净价、resource/global quota/opportunity reserve、permit/head、pending/arbiter 状态发生变化，或最佳 tuple 与规划 tuple 不完全一致
- **THEN** 本 tick 必须零写；不得临时换单、沿用旧数值或跳过第三次完整重验

#### Scenario: Z 可执行名义额边界
- **WHEN** Z BUY price 为 50 且 remaining amount 为 3,000 或 1,000
- **THEN** 两者的 executable notional 都必须按 `50*1,000=50,000` 计算并通过 45,000 门槛；订单剩余 3,000 不得获得排序加成

#### Scenario: Z 低于可执行名义额
- **WHEN** Z BUY price 为 44.999 且 remaining amount 很大
- **THEN** executable notional 仍低于 45,000，tuple 必须被拒绝；不得用整张大订单名义额绕过门槛

#### Scenario: 最坏部分成交穿底价
- **WHEN** 计划量净价安全但 amount=1 的最坏单位净价低于该 entry 有效 floor
- **THEN** tuple 必须被拒绝

### Requirement: Continuous 必须服从生产保护和统一仲裁
Continuous MUST 复用 current-tick protection、terminal/market arbiter 和唯一 `deal` 包装入口。任何生产保护侵占、可执行生产购买、terminal claim、自有 remaining order、Maker exposure、unresolved Direct pending/quarantine/gap 或 state blocker均阻止新出售。

#### Scenario: 可执行生产购买
- **WHEN** 生产系统找到订单、余额和 cooldown 均有效并在写前重验成功后声明 market intent
- **THEN** Direct 必须在同 tick 让位

#### Scenario: 只有不可执行生产需求
- **WHEN** 生产需求存在但没有可执行订单、余额或 cooldown
- **THEN** 生产侧不得发布空 intent；Direct 仍须独立通过所有出售门禁

#### Scenario: Blocked 生产承诺
- **WHEN** 合成、Factory、Hub、Boost/War 或关键调拨因 capacity/fee/source 暂时 blocked 但承诺未取消/过期
- **THEN** 承诺继续计入保护，相关库存不得出售

#### Scenario: 全局单 Pending
- **WHEN** 任意资源或房间已有 prepared/submitted/reconcile-gap pending
- **THEN** 所有其他资源/房间不得准备第二 pending

#### Scenario: 唯一写入口
- **WHEN** 静态扫描 bundle 与 source
- **THEN** 真实 `Game.market.deal` 仍只能由统一 market action arbiter 调用

### Requirement: Resource 与 Global Quota 必须同时持久执行
rolling 窗口 MUST 精确定义为 `[tick-29,999,tick]`。每条 confirmed receipt MUST 同时计入对应 resource bucket 与 account-global bucket；X reviewed canary 若仍在窗口也必须双计。准备新 pending 前，confirmed actual 加 unmatched planned reservation 再加 1,000 MUST 同时不超过 resource 与 global cap。每个 canary/continuous 且 current full read 存在 pre-global-quota safe tuple 的资源 MUST 保留尚未满足的 1,000 rolling opportunity reserve；候选只能在为其他安全资源保留该额度后仍不超过 global cap 时准入。

#### Scenario: Resource 额度不足
- **WHEN** 某 entry 的 30k remaining 小于 1,000
- **THEN** 该 entry 等待，不得主动缩量

#### Scenario: Global 额度不足
- **WHEN** 全资源 30k remaining 小于 1,000
- **THEN** 所有 entry 必须零写

#### Scenario: X/H/Z 长期同时安全
- **WHEN** X、H、Z 在多个 30k 滑动窗口内持续存在安全 tuple，且单位净价始终 X 高于 H 高于 Z
- **THEN** X/H 可先按价格使用未保留额度，但 admission 必须给当前尚未满足的 Z 保留至少 1,000；Z 不得因绝对单价较低而永久为零

#### Scenario: 低价资源当前没有安全机会
- **WHEN** Z 没有通过 floor/energy/protection/order 门禁的 pre-global-quota safe tuple
- **THEN** Z 本 tick 不占 opportunity reserve，X/H 可以使用相应 global headroom；Z 后续出现安全机会时必须从之后释放的 global slot 开始获得保留

#### Scenario: Opportunity Reserve 不得重排订单
- **WHEN** 某资源通过 quota admission 且其两个 BUY order 都安全
- **THEN** 两单仍必须按动作后单位净价选择；订单剩余量、库存和等待时间不得借 reserve 插队

#### Scenario: 跨房切换
- **WHEN** 同资源在 successor permit 中换 allowed room
- **THEN** 该资源历史用量不得清零，且 room 变化必须先经新证据和 permit

#### Scenario: Pending 跨 Global Reset
- **WHEN** 1,000 计划量已持久化但 pending 尚未终态
- **THEN** 它同时占用 resource/global reservation，并因全局单 pending 阻止新写

#### Scenario: 实际部分成交
- **WHEN** 提交 1,000 但唯一 transaction 确认小于 1,000 的正实际量
- **THEN** actualAmount 原位替换同 request 的两个 planned reservation，不双计；resource/global 1,000 tick confirmed cooldown 均生效

#### Scenario: Failed 或 Not Filled
- **WHEN** attempt 严格终态为 failed/not_filled
- **THEN** 只有终态 receipt 完整提交后才能释放两个 reservation，并设置全局 `retryNotBefore=attemptAt+100`

### Requirement: WAL 必须冻结多资源策略并使用固定提交顺序
每个 pending MUST 在 `deal` 前冻结 attemptSeq、executionPolicy、permit/epoch、entry/resource fingerprint、seller room/resource、order tuple、planned amount/energy/net、resource/global quota snapshot 以及既有物理与 transaction-window 证据。旧 v1 pending MUST 永远按 legacy X canary 对账。sequence MUST 无空洞：无 pending 时 `next=finalized+1` 且 latest finalized receipt 必须已有匹配 processed key；未写 receipt 的 active pending 必须为 `pending.seq=finalized+1,next=pending.seq+1`；receipt 已写待删 pending 的唯一合法前缀为 `pending.seq=finalized,next=finalized+1` 且 outcome/receipt/hash 精确匹配。

#### Scenario: 配置在 Pending 后变化
- **WHEN** pending 持久化后 config、permit proposal 或 entry stage 变化
- **THEN** preflight 必须按 pending 冻结策略继续对账，不得重新解释、删除 exposure 或重置额度

#### Scenario: Confirmed 提交前缀
- **WHEN** transaction 被唯一确认
- **THEN** 系统必须依次持久化 audit outcome、finalized receipt/head/checkpoint、processed evidence key，最后删除 pending

#### Scenario: Outcome 后 CPU 中断
- **WHEN** outcome 已写但 receipt 尚未写即发生中断
- **THEN** 下一 tick preflight 必须从 outcome 和 pending 唯一幂等补齐 receipt，完成前全局零写

#### Scenario: Receipt 后 CPU 中断
- **WHEN** receipt/head 已写但 processed key 或 pending delete 尚未完成
- **THEN** preflight 必须验证相同 seq/hash 后补齐剩余前缀，不得重复计数或成交

#### Scenario: Receipt 存在但 Outcome 缺失
- **WHEN** receipt 无法与 bounded outcome、pending 或 checkpoint 的合法中断前缀唯一对应
- **THEN** 系统进入持久 safety blocker，不得猜测修复

#### Scenario: 旧 Pending 重放
- **WHEN** transaction/evidence key 已从 bounded 环裁剪但 attemptSeq 不高于 finalized high-water
- **THEN** 旧 pending 不得重新执行或重复计数

#### Scenario: Pending 被单独删除
- **WHEN** state 出现 next/high-water 空洞且没有对应 active pending 或合法 finalized receipt 前缀
- **THEN** 系统必须设置持久 sequence blocker，不得分配或执行新的 attemptSeq

### Requirement: Receipt Chain 必须证明窗口 Coverage
系统 MUST 为所有终态 attempt 保存单调 sequence 与 `prevHash/eventHash/headHash`，并保存 coverageStartTick、prune checkpoint、finalized high-water、global/per-resource lifetime count/amount。所有 receipt MUST 有 `resolvedAt/retentionTick`；confirmed 还必须有 transactionTime/actualAmount 且 retentionTick=transactionTime，failed/not_filled 不得伪造 transactionTime且 retentionTick=首次 resolvedAt。rolling amount/cooldown 只读取 confirmed transactionTime/actualAmount；至少 512 条 receipt ring 的裁剪统一读取 retentionTick，且只有 retentionTick 严格小于 `tick-29,999` 并已被 checkpoint 连续吸收 seq/hash/lifetime 后才可裁剪。

#### Scenario: 窗口左边界
- **WHEN** transactionTime 等于 `tick-29,999`
- **THEN** receipt 仍在窗口并计入额度

#### Scenario: 严格移出窗口
- **WHEN** 任一 receipt 的 retentionTick 小于 `tick-29,999`
- **THEN** receipt 只有在 checkpoint 连续吸收后才可从 ring 裁剪；confirmed quota 是否移出窗口仍只由 transactionTime 决定

#### Scenario: Failed Receipt 长期裁剪
- **WHEN** failed/not_filled 没有 transactionTime 且其首次 resolvedAt 已小于 `tick-29,999`
- **THEN** retentionTick 必须等于该首次 resolvedAt，并允许在连续 checkpoint 吸收后裁剪，不得制造伪交易时间

#### Scenario: 第 51/65/201 笔
- **WHEN** audit outcome 或 receipt ring 发生多次有界裁剪
- **THEN** lifetime、rolling、high-water 和 hash head 必须保持准确，不得退回保留数组长度

#### Scenario: 断链或分叉
- **WHEN** seq 缺口、prevHash 不匹配、同 seq 不同 eventHash、时间逆序或 coverageStart 不足
- **THEN** 系统必须全局零写并持久化不可由普通配置清除的 blocker

#### Scenario: 重复读取同一 Outcome
- **WHEN** 多 tick 反复观察相同 evidence key
- **THEN** receipt、rolling、lifetime 和 cooldown 只能推进一次

#### Scenario: Outcome 已合法裁剪
- **WHEN** bounded audit outcome 已自然裁剪，但 receipt chain、processed key 或连续 prune checkpoint 能唯一证明该 finalized attempt
- **THEN** outcome 缺失是合法终态，不得误判为损坏或重复成交

### Requirement: 状态缺失和旧 Bundle 回滚必须 Fail-Closed
新 bundle MUST 永久退役 legacy X canary 写路径。v2 state、permit 或 ledger 缺失时不得创建 fresh canary。唯一自动迁移只允许来自 `669bce3` 的精确安全 v1 state；旧 bundle 读取 v2 后再升级必须被识别为 rollback evidence loss。

#### Scenario: 合法首次迁移
- **WHEN** v1 state 为 schema1、唯一 reviewed X confirmed outcome、count1、pause=true 且零 pending/quarantine/gap
- **THEN** 系统只生成 `readyForPermit` 与 X evidence digest，并按 golden fixture 构造唯一 v2 genesis：receipt sentinel、legacy X `attemptSeq=1/permitEpoch=0` confirmed receipt、processed key `6a65f8e1656d080013d32210:6a65e025656d080013ccad03`、确定性 event/head hash、`finalized=1/next=2`、global/X lifetime count1 amount1,000、零值 prune checkpoint 与覆盖当前 30k 窗口的 migration attestation；保持零写

#### Scenario: 首张 Permit 引用 Genesis
- **WHEN** operator 签收 epoch 1
- **THEN** previous permit ID 必须为空、previous permit head 必须为固定 permit genesis sentinel，previous ledger head 必须精确等于迁移后的 X seed ledger head

#### Scenario: Direct State 被删除
- **WHEN** config 仍请求 Direct/Continuous 但 v2 state、permit 或 ledger 缺失
- **THEN** 系统设置 `direct_state_missing`，不得重新跑一笔免费 canary

#### Scenario: 回滚到 669bce3 再升级
- **WHEN** 受控回滚保留 v2 state，新 schema 被旧 normalizer 标记 unsupported 或未知字段被丢弃
- **THEN** 新 bundle 必须设置 `rollback_evidence_lost` 并要求审计恢复，不得再次执行 v1 bootstrap

#### Scenario: 旧 Bundle 回滚前状态不可证明
- **WHEN** 无法证明 v2 schema/permit/ledger 将在运行 `669bce3` 期间保留
- **THEN** 回滚门槛不成立，不得声称旧 bundle 能防止 fresh state；必须继续使用新 bundle 的 fail-closed recovery

#### Scenario: 完整 Memory 被清除
- **WHEN** 所有市场持久证据缺失
- **THEN** 系统只能保持零写；重新启用需要外部权威证据和显式恢复流程

### Requirement: Continuous 必须提供有界观测和安全停止
runtime/monitor MUST 展示 permit epoch/id/head、每 entry stage/fingerprint/lane/floor、Shadow count、最佳 tuple、resource/global used/reserved/remaining、逐资源 opportunity reserve 的 safe/required/unmet/admission 状态、coverage start、attempt high-water、next eligible/retry tick、pending/gap 与 blocker。部署本身 MUST 零写；Emergency Stop MUST 禁止新 pending 但继续 preflight 对账。

#### Scenario: 新 Bundle 未签收 Permit
- **WHEN** v2 已部署并完成安全 migration，但 operator 尚未签收 proposed permit
- **THEN** runtime 展示 proposal/evidence digest，市场写保持零

#### Scenario: Z 低于底价
- **WHEN** Z 当前最高动作后净价低于 43/45
- **THEN** runtime 展示 `below_floor`，不得强卖或把容量压力作为降价理由

#### Scenario: Emergency Stop 有 Pending
- **WHEN** stop 时任一资源 pending 尚未终态
- **THEN** 系统保留 WAL、两个 quota reservation 与 exposure，直到唯一确认、严格未成交或审计 resolution

#### Scenario: 安全回滚门槛
- **WHEN** Direct pending/exposure/sync gap、Maker exposure、staging 和 reservation 全部为零，且 operator 已验证回滚期间 v2 state/unsupported marker 不会被删除或重建
- **THEN** operator 可以执行受控回滚；旧 bundle 仅在该持久证据保留的合同内因新 schema fail-closed
