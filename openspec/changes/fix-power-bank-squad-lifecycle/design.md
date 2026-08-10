## Context

PowerBank 逻辑目前由发现、可行性评估、Boost 准备、Spawn 配置、角色状态机和搬运回收多个模块共同推进。任务以 Bank ID 持久化，但战斗配置仅按来源房、目标房、角色和固定 index 命名；可行性模块又独立手写 body 数值和时间公式，导致计划与执行漂移。跨房化合物供给已有 legacy transfer 与正在建设的物流合同，本变更必须复用这些边界，而不能创建第二套转运账本。

## Goals / Non-Goals

**Goals:**

- 让同一份实际 body/Boost profile 同时驱动可行性判断、生产配置、续命、替补和运行期观测。
- 让每个任务、战斗代际、Boost 会话和搬运配置具有唯一归属，并能在成员替换后安全重走准备阶段。
- 用绝对衰减时间、统一 ETA 和进度 watchdog 保证所有非终态最终前进或终止。
- 让成功语义由实际 Power 回收结果决定，并保留可诊断的终态摘要。
- 以回归测试保护数学、事务清理、状态转换、编队就绪和搬运闭环。

**Non-Goals:**

- 不改变主循环阶段顺序，不重写通用 Spawn planner、移动系统或 Lab 合成系统。
- 不实现 `decentralized-logistics-contracts` 中尚未完成的统一合同执行器。
- 不在本变更中增加自动部署或 live 写操作。

## Decisions

### 1. 使用纯计划器作为唯一数值来源

新增纯函数计划器，从 `POWER_BANK_*_BODIES` 与 `POWER_BANK_BOOST_REQUIREMENTS` 派生部件数、Boost 后 DPS/HPS、成本、单/多 Spawn 生产 ETA、旅行 ETA、击破 ETA 和 Hauler 最晚开工时间。`freeTiles` 只限制显式 `attackerCount`，当前计划人数固定为 1。

选择纯计划器而非继续修补分散公式，是为了让表驱动测试直接验证同一份输入输出；未来若启用多攻击手，只需改变显式计划人数。

### 2. 先评估全部候选，再提交资源准备

来源选择分成无副作用的候选评估和有副作用的准备提交。评估检查路径、实际所需矿物、已分配 Lab、可信 incoming、Spawn 可用时间、接收 headroom 与危险路线；按截止余量、可执行性和距离排序。跨房供给仍调用现有 PowerBank Boost/资源转运接口，未来由统一合同替换。

### 3. 任务保存绝对时间与进展事实

新任务保存 `bankExpiresAt`、`stageEnteredAt`、`lastProgressAt`、`lastBankHits`、`blocker` 和 `nextAttemptAt`。统一 transition helper 更新阶段时间；每个阶段在执行副作用前检查绝对截止时间，并按阶段 timeout 或 hits 无进展 watchdog 失败。旧任务缺字段时根据最近观测补齐，无法安全推导时中止而不是继续无限等待。

### 4. 战斗组使用 generation 和 readiness gate

主力与替补分别保存 generation、配置名、成员 ID 与 `combatReady`。任一实际成员 ID 变化都会清除 readiness 并重走续命/Boost；角色只有在 ID、generation、taskId 匹配且 manager 写入 readiness 后才能行军或攻击。攻击还要求 healer 存活、有有效 HEAL、同房且相邻，以及 attacker 有有效 ATTACK 和可用 TOUGH 层。

替补晋升时递增下一代 generation，不复用当前活动配置。Boost owner 使用 `taskId:primary:gN` 或 `taskId:reinforcement:gN`，从而避免攻击阶段的通用清理释放尚在准备的替补 Lab。

### 5. Boost 准备是可回滚事务

PowerBank 始终要求 Lab mineral 与 energy 都 ready。暂停 synthesis、预留 Lab、创建 carrier/transfer 草稿中的任何一步失败时，必须释放本次 owner 的全部预留并恢复暂停前计划。运行期显式处理 `renewCreep` 与 `boostCreep` 返回码：可重试错误写 blocker/nextAttemptAt，不可恢复错误终止当前代或任务。

### 6. 配置和清理按 task/generation 唯一归属

PowerBank config 名加入稳定的 task token 与 generation。配置枚举、Spawn 队列清理、Hauler 停产判定及 orphan 识别均以精确 owner 元数据为准，不再只按 source/target 前缀匹配。兼容旧配置时只清理能证明属于当前 task 的条目。

### 7. 回收采用结果账本

任务累计 `observedPower`、`pickedUpPower`、`deliveredPower` 和 `lostPower`。Bank 消失不自动代表成功：结合已观测掉落、衰减时间、敌对争夺和最终交付量设置 outcome。Hauler 投递优先原来源房，但在接收容量不足时允许选择安全且有 headroom 的己方房间；无法交付时写 blocker，而不是永久空转。

### 8. 路线作为任务级快照共享

候选选定后保存 route rooms 与危险房快照，攻击手、治疗手和 Hauler 共用。双人组跨房时以攻击手为 leader，只有 healer 邻接才推进，过出口后等待边界交接。路线失效时有限次数重算，超过截止余量则失败。

### 9. 保留有界诊断而非无限终态任务

提供只读 `powerBankStatusRaw()`，输出阶段年龄、截止余量、计划/实际 DPS、成员 readiness、Boost blocker、Spawn/Hauler 状态和回收结果。终态完成一次幂等清理后写入有界 history，再删除活动任务，避免连续 100 tick 重复清理。

### 10. 就绪替补按剩余击破时间主动交接

替补到达目标房、双员相邻且仍具备有效战斗部件后，不再等待主力死亡或 Bank hits watchdog 触发。Manager 比较主力双员最小 TTL 与 `remainingAttackTicks + 75`；进入该闭区间时复用既有 generation 晋升入口，一次性切换 active generation/index/成员 ID/Boost owner，随后只退役旧代配置、队列和 creep。

交接不计入仍在生产或旅行中的替补，也不在阈值之外提前换代。晋升入口在任何清理前重新核对 task ID、generation、角色、目标房、相邻关系和有效 ATTACK/TOUGH/HEAL，避免损坏的 readiness 状态先杀死健康主力。

### 11. PowerBank 同房会合使用占用感知的短路径

攻击手继续作为跨房 leader：普通格上 healer 掉队时不反向追逐，避免双方相互追赶和路线振荡；但 leader 有意等待、贴 Bank 攻击或 healer 贴身治疗时必须清除旧移动状态，使交通层能把它识别为静止单位。Healer 在同房追赶 leader、以及 attacker 接近 Bank 时使用 `ignoreCreeps=false`、`reusePath=0` 的单房路径，每 tick基于当前占用重新选择可走格；若单格通道因此返回 `ERR_NO_PATH`，同 tick 改用 `ignoreCreeps=true` 的 fresh path 交给 traffic push 协议。直接出口/侧移在清状态后重新标记本 tick 的主动移动，防止后序 creep 覆盖其 move intent。

该策略只用于 PowerBank 战斗组的短距离编队恢复。通用 `moveToTarget` 的默认缓存、跨房共享路线和其他角色的交通策略保持不变；独立的全局 stuck-repath 策略另立变更。

### 12. 替补进展与主任务进展分栏

替补保存自身的 stage/成员签名、当前位置签名、当前窗口中最近首次到达的最多 32 个不同双员位置签名、阶段进入 tick、最近进展 tick、blocker 和最近软重寻路 tick。Manager 每 tick 在角色执行前观察上一 tick 的位置：stage 或成员变化会重置进展窗口；只有到达窗口内未见过的新位置才刷新替补进展。A↔B 等短周期振荡因重复命中历史位置，不再伪装成进展。travelling 双员均存在、无 fatigue 且连续 15 tick 没有新位置时，记录 `reinforcement_travel_no_progress` 并清除双方旧移动状态，10 tick 冷却内不重复执行。

该 watchdog 不更新任务级 `lastProgressAt/blocker`，也不自杀、删配置或自动重建 generation。主力 Bank hits 仍只代表主任务战斗进展；替补停滞通过状态投影独立呈现。更激进的自动回收需要单独证明活 creep 与 generation 的安全清理边界。

## Risks / Trade-offs

- [更严格的准入会暂时减少出征数量] → 输出明确 reject reasons 与 slack，先保证不会消耗资源执行必败任务。
- [旧任务字段不完整] → 使用兼容初始化；发现配置归属或时间线不明确时安全中止并清理。
- [配置名变化可能留下旧配置] → 增加一次受前缀和 owner 双重保护的迁移清理，不做宽泛删除。
- [战斗锁步可能增加旅行时间] → 计划器把锁步旅行预算计入 ETA，并允许缓存共享路线降低 CPU。
- [占用感知同房路径会增加局部寻路 CPU] → 仅在双员不相邻或 attacker 未贴 Bank 时启用，并限制 `maxRooms=1`；相邻/攻击/治疗等待路径主动清理状态。
- [位置历史会把短距离回撤视为停滞] → 仅在连续 15 tick 都未进入新位置时执行无破坏性的软重寻路，历史固定为 32 项且不删除 creep/config。
- [过早换代会浪费健康主力寿命] → 只在替补已完整到位且主力最小 TTL 进入 `remainingAttackTicks + 75` 闭区间时交接，阈值高一 tick 明确保持原代。
- [跨房供给仍受 legacy transfer 健康语义限制] → 本变更只消费可信 incoming；统一 lease/claim 由既有物流变更继续完成。

## Migration Plan

1. 先引入纯计划器、Memory 可选字段和兼容读取，不改变活动任务行为。
2. 切换新发现任务到 task/generation 配置与绝对时间线；旧活动任务在当前阶段完成或安全中止。
3. 启用 Boost 事务、readiness gate 和回收账本。
4. 运行定向与全量测试、类型检查及构建；部署前通过只读 monitor 检查无孤儿 pause/config。
5. 回滚时恢复旧代码即可；新 Memory 字段均为附加字段，旧版本会忽略。

## Open Questions

- 自动选择备用交付房间是否需要设置最大线性距离；本变更默认只选择已有安全路线且能在 creep TTL 内到达的己方房间。
- 未来多攻击手模式应作为独立策略变更，当前显式锁定 `attackerCount=1`。
