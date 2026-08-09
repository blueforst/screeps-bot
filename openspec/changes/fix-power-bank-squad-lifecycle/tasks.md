## 1. 可行性与统一计划

- [x] 1.1 从实际 body 与 Boost requirements 派生 tier profile，修正单攻击手 DPS 和 RCL8 未强化 healer HPS/资源需求
- [x] 1.2 建立统一时间线计划器，计入双人组生产并行度、Spawn 队列、续命、Boost、旅行、击破和 Hauler 到达
- [x] 1.3 改为评估全部来源候选，排除无路径并使用真实资源数量、Lab/incoming、路线和接收容量选择最大正余量来源
- [x] 1.4 增加表驱动计划测试，覆盖多空位、RCL8 无 XLHO2、单/多 Spawn、长路线 TTL 和次优来源

## 2. 任务时间线与状态存活性

- [x] 2.1 扩展 PowerBank Memory，加入绝对截止、阶段时间、最近进展、blocker、重试和兼容初始化
- [x] 2.2 统一状态转换入口，在每阶段副作用前执行 deadline 与阶段 timeout 检查
- [x] 2.3 增加 Bank hits、成员存活和视野 watchdog，保证 attacking 等阶段有界推进或终止
- [x] 2.4 增加 deadline、无视野、无进展和不可恢复 API 错误的状态机测试

## 3. 配置归属与双人组代际

- [x] 3.1 让战斗与 Hauler config、Spawn 请求和清理逻辑包含 task owner；战斗配置额外包含 generation
- [x] 3.2 为主力和替补实现独立 generation、成员 ID、readiness 及安全晋升，成员变化时重走 renewing/boosting
- [x] 3.3 增加 `pairReadyForCombat`，要求有效 ATTACK/HEAL/TOUGH、同房相邻；角色不再自行写任务状态
- [x] 3.4 让攻击手与治疗手使用共享路线并在跨房边界锁步，所有 PowerBank 角色消费有效危险房快照
- [x] 3.5 增加同源同目标并发任务、替补多代、成员重生、healer 缺失和边界掉队测试

## 4. Boost 与续命事务

- [x] 4.1 PowerBank Boost 始终要求 Lab energy，并显式处理 `boostCreep` 与 `renewCreep` 返回码和重试 blocker
- [x] 4.2 使 Boost prepare 的 pause、Lab reservation、carrier draft 和供给任务在任意早退时按 owner 回滚
- [x] 4.3 为主力和每代替补使用独立 Boost owner，避免 attacking 清理释放正在准备的替补资源
- [x] 4.4 增加零 Lab 回滚、Lab energy、返回码、并发 owner 和替补 Boost 生命周期测试

## 5. 回收结果与容量

- [x] 5.1 累计 observed、picked up、delivered 与 lost Power，并区分成功、部分回收、过期、被争夺和零收益
- [x] 5.2 Hauler 使用 Power 专用容量，原来源满载时选择 TTL 内可达的安全备用交付房，并为容量阻塞设置 blocker
- [x] 5.3 使 Hauler 领取、停产与终态清理按 task owner 工作，避免并发任务互相影响
- [x] 5.4 增加真实 pickup、部分装载、多车竞争、满仓 fallback、携货终止与零收益测试

## 6. 观测、迁移与验证

- [x] 6.1 提供 `powerBankStatusRaw()` 和有界终态 history，输出阶段年龄、截止余量、成员/Boost/Spawn/Hauler blocker 与回收结果
- [x] 6.2 为旧活动任务和 legacy 配置实现受 owner 保护的兼容初始化/清理，不宽泛删除其他任务资产
- [x] 6.3 运行 PowerBank 定向测试、`npx tsc --noEmit`、全量 Jest 与 `npm run build`
- [x] 6.4 运行只读 live monitor，确认无孤儿 synthesis pause、配置碰撞或新增 CPU 异常，并复核工作树差异
