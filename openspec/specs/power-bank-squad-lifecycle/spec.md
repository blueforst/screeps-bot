# PowerBank 小队生命周期规范

## Purpose

定义 PowerBank 任务从可行性评估、双人组生产与换代、Boost、旅行、攻击到 Power 回收的安全生命周期，保证任务有界推进、资产按 owner 隔离，并提供足够的运行时可观测性。

## Requirements

### Requirement: 实际编队驱动的可行性计划
系统 MUST 从实际 creep body、强化要求、显式攻击手数量和可用 Spawn 数量派生 PowerBank DPS、HPS、生产时间、旅行时间、击破时间与回收时间线；空闲攻击格数量不得隐式增加未计划的攻击手。

#### Scenario: 单攻击手不会按空位倍增 DPS
- **WHEN** 任务计划一名攻击手且 Bank 周围存在多个可用格
- **THEN** 击破时间必须只使用一名攻击手的实际 Boost 后 DPS

#### Scenario: RCL8 治疗按实际未强化配置计算
- **WHEN** 来源房选择 RCL8 PowerBank healer profile
- **THEN** 计划不得要求 XLHO2，并必须按未强化 HEAL 部件计算 HPS

#### Scenario: 双人组生产计入完整时间线
- **WHEN** 攻击手和治疗手需要由同一个或多个 Spawn 生产
- **THEN** 计划必须按实际 body 长度、Spawn 并行度和已有队列计算二者均 ready 的时间

### Requirement: 全候选来源评估
系统 MUST 无副作用地评估全部可用来源房间，并仅在选择可执行候选后提交 Spawn、Lab 或跨房资源准备。

#### Scenario: 最近来源不可执行时选择次优来源
- **WHEN** 最近来源缺少真实所需资源或无法在截止前完成，而更远来源可执行
- **THEN** 系统必须选择具备最大正截止余量的可执行来源，而不是立即使任务失败

#### Scenario: 资源检查使用真实数量和可信供给
- **WHEN** 本地 storage、terminal、已分配 Lab 与可信 incoming 的合计可覆盖实际 Boost 需求
- **THEN** 候选不得仅因 storage 或 terminal 中某种化合物为零而被拒绝

#### Scenario: 不可用路径不会成为候选
- **WHEN** 来源房到目标房没有可用安全路线
- **THEN** 该来源必须以明确原因被排除且不得以无限距离参与排序

### Requirement: 有界任务生命周期
每个活动 PowerBank 任务 MUST 保存绝对衰减时间、阶段进入时间、最近进展时间和当前阻塞原因；任何阶段都必须在成功推进或有界失败中结束。

#### Scenario: 阶段等待不能越过 Bank 截止时间
- **WHEN** 当前时间线已经无法在 Bank 衰减前完成击破
- **THEN** 系统必须停止新的资源投入并以明确截止原因终止任务

#### Scenario: 攻击无进展触发 watchdog
- **WHEN** Bank hits 在配置的攻击窗口内没有下降
- **THEN** 系统必须检查成员有效部件与编队状态，并在无法恢复时终止或换代

#### Scenario: 主力进展不掩盖 travelling 替补停滞
- **WHEN** Bank hits 持续下降，但 travelling 替补双员均无 fatigue，且连续 15 tick 静止或只在最近位置间循环、未进入新位置
- **THEN** 系统必须记录替补独立 blocker，并以有冷却的方式清除该替补旧移动状态触发重新寻路

#### Scenario: 失去视野和成员不会永久卡住
- **WHEN** 目标房失去视野且当前双人组已死亡或超过视野宽限期
- **THEN** 任务必须恢复视野、重建可行编队或在 deadline 前有界终止

### Requirement: 代际化双人组与战斗就绪门槛
主力和替补双人组 MUST 由 task ID、generation、成员 ID 和 readiness 唯一标识；成员改变后必须重新完成续命与强化。

#### Scenario: 治疗者缺失时攻击手停攻
- **WHEN** healer 不存在、无有效 HEAL、不同房或与 attacker 不相邻
- **THEN** attacker 不得攻击 PowerBank，并必须等待恢复、替补或终止决策

#### Scenario: 新生替补不得绕过准备阶段
- **WHEN** travelling 或 attacking 阶段的替补成员死亡并由同配置重生
- **THEN** 新成员必须绑定新 ID、清除 readiness，并重新经过 renewing 和 boosting

#### Scenario: 替补晋升后可创建下一代替补
- **WHEN** 当前替补晋升为主力且后续再次需要替换
- **THEN** 系统必须使用新的 generation 和配置，不得复用活动主力的 index 或 Boost owner

#### Scenario: 就绪替补进入 TTL 交接窗口
- **WHEN** 替补已在目标房完成 attacking readiness、双员相邻且主力最小 TTL 等于剩余击破 tick 加 75
- **THEN** manager 必须在同 tick 原子晋升替补、切换 active generation/index/成员 ID/Boost owner，并只退役旧代资产

#### Scenario: 交接窗口之外不提前换代
- **WHEN** 主力最小 TTL 比剩余击破 tick 加 75 高一 tick，或替补尚未进入 attacking readiness、不同房、不相邻或缺少有效部件
- **THEN** manager 不得退役主力或切换 active owner

### Requirement: 可回滚的 Boost 与续命操作
PowerBank Boost 准备 MUST 同时满足 mineral 与 Lab energy，并对 Lab、synthesis pause、carrier draft 和跨房供给执行 owner 级提交或回滚；运行期必须处理 Screeps API 返回码。

#### Scenario: 零可用 Lab 不遗留 synthesis pause
- **WHEN** Boost 准备在暂停 synthesis 后发现没有可用 Lab
- **THEN** 系统必须在同 tick 回滚本 owner 的 pause 与预留，并保留原 synthesis 计划

#### Scenario: Lab 能量不足不会进入可强化状态
- **WHEN** Lab mineral 已满足但 energy 不足
- **THEN** 系统必须保持 preparing 状态并创建或刷新明确的 Lab energy 供给需求

#### Scenario: Boost API 可恢复错误被记录并重试
- **WHEN** `boostCreep` 返回可恢复错误
- **THEN** 系统必须写入 blocker 和下次尝试时间，且不得错误标记该成员为 ready

#### Scenario: 替补 Boost 不被主力攻击状态释放
- **WHEN** 主任务处于 attacking 且替补仍在 renewing 或 boosting
- **THEN** 通用主力清理不得释放替补 Boost owner 的 Lab 或 pause

### Requirement: 任务唯一的配置和清理归属
PowerBank creep config、Spawn 请求、Boost owner 与 Hauler MUST 包含 task ID；战斗成员还必须包含 generation。终止一个任务不得修改其他任务的资产。

#### Scenario: 同源同目标并发 Bank 不碰撞
- **WHEN** 两个 Bank 任务具有相同 source room 与 target room
- **THEN** 二者必须拥有不同配置名、Spawn 请求、成员绑定和清理范围

#### Scenario: 旧终态清理不删除新任务配置
- **WHEN** 旧任务仍在终态清理窗口且同房新任务已创建
- **THEN** 旧任务只能删除带自身 owner 的配置和队列项

### Requirement: 结果驱动的 Power 回收
任务 MUST 记录观察到、拾取、交付和损失的 Power；成功结果必须基于实际交付，Bank 消失或空场不得单独代表成功。

#### Scenario: 零收益不能记为成功
- **WHEN** Bank 消失后从未观察到 Power 且没有任何 Power 被交付
- **THEN** 任务必须分类为过期、被争夺或零收益失败，而不是成功完成

#### Scenario: 部分交付被明确记录
- **WHEN** 已交付 Power 少于观察到或预期数量且回收窗口结束
- **THEN** 任务必须保存部分回收结果与损失数量

#### Scenario: 原来源满载时选择安全备用交付房
- **WHEN** 原来源 terminal 与 storage 无接收容量而存在 TTL 内可达的安全己方房间
- **THEN** Hauler 必须改投备用房并继续累计同一任务的交付量

### Requirement: 编队共享路线与危险信息
选定来源后，任务 MUST 保存攻击手、治疗手和 Hauler 共用的路线与危险房快照；战斗双人组必须在跨房边界保持可治疗距离。

#### Scenario: Scout 危险房约束所有角色
- **WHEN** Scout 标记的危险房仍在有效期内
- **THEN** combat 与 Hauler 路线不得仅因当前无视野而穿越该房间

#### Scenario: 治疗者掉队时 leader 等待
- **WHEN** attacker 即将推进或跨越房间边界而 healer 不相邻
- **THEN** attacker 必须等待 healer 完成编队交接

#### Scenario: 同房会合绕过已占用的直达步
- **WHEN** healer 与 leader 同房但不相邻，且最短直达步被己方 creep 占用而存在其他可走路径
- **THEN** healer 必须基于当前 creep 占用重新寻路，不得持续复用忽略 creep 的旧路径

#### Scenario: 单格通道交给 traffic 协调
- **WHEN** PowerBank 同房占用感知路径因唯一通道被己方 creep 占用而返回无路
- **THEN** 角色必须回退到无缓存的 traffic 路径，使静止 blocker 可被既有 push 协议协调，而不得永久重复同一个无路结果

#### Scenario: 有意停留不保留活动移动状态
- **WHEN** leader 在普通格等待 healer、attacker 已贴近 Bank，或 healer 已贴近其 attacker
- **THEN** 对应角色必须清除旧的同房移动状态，使交通层不得把该角色继续视为正在沿旧路径移动

#### Scenario: 战术直移保留当 tick 移动事实
- **WHEN** PowerBank 角色清除旧路径后直接执行出口离开或侧移
- **THEN** 角色必须重新标记本 tick 的主动移动，使后序 traffic 不得把该 move intent 当作静止 blocker 覆盖

### Requirement: PowerBank 状态可观测
系统 MUST 提供只读状态投影，包含任务阶段、阶段年龄、截止余量、计划与实际战斗能力、成员代际/readiness、Boost/Spawn blocker、Hauler 进度和最终回收结果。

#### Scenario: 卡住任务具有明确阻塞原因
- **WHEN** 任务因资源、Spawn、续命、Boost、路线、编队或容量无法推进
- **THEN** 状态投影必须返回稳定的 blocker 与最近进展 tick

#### Scenario: 替补状态独立可见
- **WHEN** 主力仍在攻击而替补处于 spawning、renewing、boosting、travelling 或 attacking
- **THEN** 状态投影必须独立返回替补 stage、成员 ID、combat readiness、阶段年龄、进展年龄和 blocker

#### Scenario: 终态保留有界历史
- **WHEN** 任务完成一次幂等清理
- **THEN** 系统必须把结果写入有界历史并移除活动任务，且不得连续重复清理相同资产
