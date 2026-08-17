## ADDED Requirements

### Requirement: 成功的跨房搜索必须产生可复用的当前房间 Segment

系统必须（MUST）在可缓存的 multi-room `PathFinder.search` 成功且返回可验证、有界的当前房间路径段后，把当前房间的连续路径前缀与最多一个相邻房间 transition step 保存到该 creep 的 heap-only movement state；无法验证连续性、边界拓扑或长度上界的 path 不得缓存。后续相同策略请求必须先尝试合法 segment，不得在每个相邻移动 tick 重复完整 multi-room search。

#### Scenario: 稳定跨房移动复用一次搜索

- **WHEN** 同一 creep 在同一房间连续多个 tick 沿相同 target、route、danger set 与 move options 前进，且每步仍与 segment 相邻
- **THEN** 首个 tick 必须执行一次 multi-room search，后续 tick 必须沿 segment 移动且不得再次执行 search

#### Scenario: Search 只缓存当前房间边界

- **WHEN** 成功 search 返回跨越多个房间的完整 path
- **THEN** movement state 必须只保存当前房间连续前缀和首个 transition step，不得把后续房间路径作为当前 segment 继续复用

### Requirement: Segment 身份必须覆盖完整路线策略

系统必须（MUST）使用无歧义身份匹配当前 room、target room、selected next room、fixed/dynamic 模式、有序 route、危险房集合、travel range、plain/swamp cost、maxRooms、ignoreCreeps 与 reusePath。任一具有语义的输入变化都必须（MUST）使旧 segment 失效；危险房集合的重复项或枚举顺序本身不得制造不同身份。

#### Scenario: 路线或搜索选项变化立即重搜

- **WHEN** 已有 segment 后 target、next room、route order、avoid-room set、range、cost、maxRooms、ignoreCreeps 或 reusePath 任一变化
- **THEN** 系统必须拒绝旧 segment 并使用当前输入重新搜索或进入既有 fallback

#### Scenario: 危险房集合使用集合语义

- **WHEN** 两次请求的危险房成员完全相同但顺序或重复项不同
- **THEN** 只要其他策略字段一致，segment identity 必须保持相同

### Requirement: 动态占用、卡住与偏离必须 fail-safe 失效

系统不得（MUST NOT）缓存 `reusePath=0` 或有效 `ignoreCreeps=false` 的 multi-room search。已有 segment 在 idle TTL 或 hard TTL 到期、连续卡住达到既有阈值、当前房间不匹配、实时 next-room 安全门禁失败、当前点无法精确或相邻接入路径时必须（MUST）先失效，再使用原 fresh search/fallback；不得跳过不相邻 step。segment follower 必须以单调 cursor 只在已确认位置之后重接，且缓存长度与 reusePath 输入必须有有限上界。

#### Scenario: Stuck recovery 不复用静态 Segment

- **WHEN** creep 连续卡住达到 dynamic occupancy recovery 阈值
- **THEN** 系统必须丢弃已有 segment，以 `reusePath=0`、`ignoreCreeps=false` 执行 fresh path，并且不得保存该动态结果供后续 tick 复用

#### Scenario: Traffic 偏离超过一格触发重搜

- **WHEN** traffic push 或其他移动使 creep 与 segment 中任何可接续 step 的距离大于 1
- **THEN** follower 必须返回不可用、segment 必须失效，并进入原 multi-room search 或 exit fallback

#### Scenario: TTL 到期触发重搜

- **WHEN** segment 到达或超过 expiresAt
- **THEN** 系统必须拒绝该 segment，过期后不得通过仅延长旧数据 TTL 恢复复用

#### Scenario: 有效命中续租但不越过硬上限

- **WHEN** creep 在长路径上持续得到 `OK`、`ERR_TIRED` 或 `ERR_BUSY` 的可复用缓存 follower 结果
- **THEN** 系统可以延长 idle expiresAt 以覆盖正常行程，但不得越过固定 hardExpiresAt；非有限或超大 reusePath 不得制造无限租期

#### Scenario: Hairpin 与 traffic push 只向前重接

- **WHEN** creep 已确认走到 segment 中段后，被 traffic 推到同时邻近旧 step 与未来 step 的位置
- **THEN** follower 必须从 cursor 之后选择可接续 step，不得回接已经走过的路径

#### Scenario: 下一房实时安全状态变化

- **WHEN** segment 建立后、普通房内 follower 命中前，相邻非目标房变为非 normal 状态或在可见事实中出现敌对控制/战斗存在
- **THEN** 系统必须拒绝旧 segment，并让随后执行的 fresh search 由既有 room callback 重新裁决；缓存不得新增对该 callback 的绕过，但本 change 不改变原先独立存在的 direct-exit/fallback 策略

### Requirement: 房间边界必须重新建立 Segment

系统必须（MUST）在每 tick 保留现有 next-room 与危险房判定。segment 可以在当前出口消费唯一 transition step；creep 进入下一房间后必须（MUST）以新 current room 重新建立 segment，不得继续沿旧房间缓存绕过当前策略。

#### Scenario: 出口 transition 后在新房重搜

- **WHEN** creep 沿 segment 从当前房间出口进入相邻房间
- **THEN** 出口 tick 可以使用缓存 transition intent；进入新房的边界 tile 后可以先执行既有 exit recovery，但旧房 segment 不得再命中，首次离开边界后的 pathing 请求必须重新执行当前策略与 path search

#### Scenario: Transition 同时校验坐标与房间拓扑

- **WHEN** search path 或缓存 follower 提供跨房 step
- **THEN** 两个 step 必须在边界坐标上八方向相邻，且 `describeExits(currentRoom)` 对应出口必须精确指向该 step 的 roomName；合法对角跨边 intent 必须保留

#### Scenario: Live-safety 失效不改写既有 Direct Exit 合同

- **WHEN** creep 已站在当前策略选择的出口，且 segment 因下一房实时状态变化而失效
- **THEN** 该次请求不得计为 segment hit，但必须继续执行本 change 之前已有的 direct-exit intent，不得借缓存优化暗中改变路线政策

#### Scenario: Segment 失败保留既有 fallback

- **WHEN** 缓存 follower 无法解析相邻 step，或 fresh multi-room search 失败/首 step 不是本房严格相邻位置
- **THEN** 系统必须继续尝试既有 closest-exit、single-room `moveToTarget` 或 `ERR_NO_PATH` 路径，不得吞掉 fallback

#### Scenario: 已发出的 Transition Intent 终态错误原样传播

- **WHEN** 缓存已解析合法跨房 transition 并调用 `creep.move`，但 API 返回 `ERR_NO_BODYPART` 等非复用终态错误
- **THEN** 系统必须失效 segment 并原样返回该错误，不得在同 tick 重复发出第二个 direct-exit intent，也不得计为 hit

### Requirement: Segment 必须保持瞬态且自然可清理

segment 必须（MUST）只存在于现有 global creep movement state，不得写入 `Memory`、creep memory 或 Colonization 持久路径。dead-creep cleanup、target room 到达、显式 movement clear 与 global reset 必须（MUST）沿既有生命周期移除或自然丢失该数据。

#### Scenario: Global reset 后安全冷启动

- **WHEN** global reset 清空 heap state，而 creep 与所有持久 Memory 保持不变
- **THEN** 下一次跨房请求必须从当前事实重新 search，不得依赖不存在的 segment 或要求 Memory migration

#### Scenario: 到达目标房释放 TravelState

- **WHEN** creep 的当前房间等于 targetRoom
- **THEN** 系统必须在 travel 调用或周期性 movement cleanup 中删除 travel state，segment 不得因 role 停止调用 travel 而继续占用 heap

### Requirement: Segment 收益与失效必须可观测

movement analytics 必须（MUST）分别累计实际 multi-room searches、成功 segment hits 与已有 segment invalidations；计数必须同时进入 totals 和请求发生房间的 bucket。`OK`、`ERR_TIRED` 或 `ERR_BUSY` 表示 follower 命中缓存并避免本次 search，均可计为 hit；其中 traffic 层在未调用 pusher `creep.move` 时返回的 `ERR_BUSY` 只证明缓存复用/搜索避免，不证明 intent 或物理前进。无法解析可复用 step 或返回其他终态错误不得计为 hit。计数器必须保持有界数值，不得创建逐事件历史；旧 global 快照缺少新增字段时必须归零补形。External telemetry 必须保留 totals，并按 room 最近活动优先、确定性地选择有限数量的 owned/remote buckets，即使 payload 进入 compact 路径也不得丢失该投影。

#### Scenario: 一次搜索后连续命中

- **WHEN** 一个 creep 首次搜索后连续三个 tick 成功沿 segment 移动
- **THEN** analytics 必须记录一次 search 和三次 hit，且不得记录不存在的 invalidation

#### Scenario: 已有 Segment 被拒绝时只记一次失效

- **WHEN** 一个已有 segment 因 key、TTL、stuck、room 或 step 偏离被丢弃
- **THEN** analytics 必须为该次丢弃增加一次 invalidation；没有 segment 的普通 miss 不得计为 invalidation

#### Scenario: Hot-load 旧指标并投影 Remote 房间

- **WHEN** global 中已有缺少三个新字段的旧 movement bucket，且跨房请求发生在非 owned room
- **THEN** telemetry 读取必须安全补零旧字段，并在有界 room 投影中保留该 remote bucket，不得要求 global reset 或 Memory migration
