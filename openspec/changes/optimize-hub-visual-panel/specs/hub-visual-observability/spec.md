## ADDED Requirements

### Requirement: Hub 主面板提供异常优先健康摘要
系统 SHALL 在 Hub 房间 RoomVisual 主面板顶部展示 Hub 房间、Hub 状态、合成阶段和可辨识的健康等级。系统 MUST 按错误、无效保护快照、待规划、缺料、blocked transfer 与带任务的 terminal reserve 不足推导有限告警；正常时 MUST 保持紧凑，异常时 MUST 按确定优先级展示有限告警与 overflow。

#### Scenario: Hub 正常运行
- **WHEN** Hub 已启用且没有错误、待规划、缺料、blocked transfer、保护异常或带任务的 terminal reserve 不足
- **THEN** 主面板显示 ok 健康摘要且不增加空告警行

#### Scenario: 多个异常同时存在
- **WHEN** Hub 同时存在错误、缺料和 blocked transfer，且告警数量超过可见上限
- **THEN** 主面板按确定优先级显示最高优先级告警并显示剩余告警数量

### Requirement: 生产进度只使用可靠目标
系统 MUST 仅在活动产品具有大于零的合成绝对目标时绘制百分比进度条，并 MUST 使用 Hub storage、terminal、carrier 与 lab 的该产品总量计算进度。存在活动产品但没有可靠目标时 SHALL 展示产品库存与阶段活动文本，不得使用固定伪目标；没有活动产品时 SHALL 显示 idle。

#### Scenario: 活动产品具有目标
- **WHEN** Hub 正在生产产品且 synthesis runtime 提供大于零的 targetAmount
- **THEN** 面板展示当前总量、目标量和封顶为 100% 的 determinate progress bar

#### Scenario: 活动产品没有目标
- **WHEN** Hub 有活动产品但 synthesis runtime 没有有效 targetAmount
- **THEN** 面板展示 activity 文本且不绘制基于固定 1,000 的进度条

### Requirement: Hub 物流摘要表达真实方向和健康
系统 SHALL 为 Hub pending import、reclaim 与 export task 投影 classification、counterpart room、resource、remaining amount、task age、last-progress age、blocked reason 与 blocked age。import/reclaim MUST 以来源房间作为 counterpart，export MUST 以目的房间作为 counterpart；可见任务 MUST 按 blocked 优先、年龄、数量和稳定字典序确定排序。

#### Scenario: 同时存在入站和出站任务
- **WHEN** Hub 同时存在 satellite 到 Hub 的 reclaim 和 Hub 到 satellite 的 export
- **THEN** 面板分别以入站来源和出站目的房间显示两条不同方向的任务

#### Scenario: 存在阻塞任务
- **WHEN** pending Hub task 带 blockedReason 与 blockedSince
- **THEN** 对应物流行展示可读 blocker 和 blocker age，并优先于未阻塞任务

#### Scenario: 任务超过可见上限
- **WHEN** pending Hub task 数量超过主面板物流行上限
- **THEN** 面板只显示排序最高的有限任务并显示 overflow 数量

### Requirement: T3 储备按化合物表达覆盖事实
系统 SHALL 为每个目标 T3 化合物计算 Hub 当前量、Hub reserve、Hub deficit、Hub surplus 和全部非 Hub 房间的 aggregate deficit。视觉层 MUST 优先展示总缺口最严重的有限化合物；不同化合物的 surplus MUST NOT 抵消另一个化合物的 deficit。现有 `hubSurplus` 与 `totalDeficit` 汇总字段 MUST 保留兼容。

#### Scenario: Hub 总盈余掩盖单项缺口
- **WHEN** 一个 T3 化合物高于 Hub reserve 而另一个低于 Hub reserve
- **THEN** 面板仍明确显示后者的逐项 Hub deficit，不把前者 surplus 视为抵消

#### Scenario: 全部目标储备满足
- **WHEN** 每个目标化合物的 Hub deficit 与 aggregate satellite deficit 均为零
- **THEN** 面板压缩显示全部目标已 stocked 而不列出空缺口行

### Requirement: 主面板和卫星面板保持分层职责
系统 SHALL 在主面板只汇总 active 与 blocked production room 数量，并 SHALL 在每个可见卫星房间只展示该房间选中的产品、阶段、进度、有限上下游和 blocker。主面板 MUST NOT 恢复全量 production room 明细列表。

#### Scenario: 多房间分布式生产
- **WHEN** Hub plan 包含多个活动生产房间且其中一个 blocked
- **THEN** 主面板显示 active/blocked 数量，blocked 卫星房间在自己的面板显示原因

### Requirement: 面板具有可读底板和非颜色语义
Hub 与卫星面板 SHALL 各使用一次覆盖其实际内容高度的半透明底板。健康、方向和 blocker MUST 同时具有文字或符号语义，不得只依赖颜色；section header MAY 按健康等级着色。

#### Scenario: 房间背景建筑密集
- **WHEN** 面板绘制在结构与 terrain 视觉复杂的房间区域
- **THEN** 单层半透明底板覆盖从首个 header 到最后一行的内容范围

### Requirement: Visual model 缓存有界且关键状态立即失效
系统 SHALL 在 module heap 缓存 Hub snapshot 与 visual model，并 MUST 在缓存年龄达到 5 tick 时重新采集。Hub 房间/开关、Hub 状态、待规划、错误、活动产品、合成阶段/产品/目标或 protection revision/validity 变化时 MUST 在下一次 overlay 调用立即失效。RoomVisual MUST 继续每 tick 绘制；缓存不得写入新的持久 Memory schema。

#### Scenario: 连续稳定 tick
- **WHEN** 连续 overlay 调用相隔少于 5 tick且关键 signature 未变化
- **THEN** 系统复用已缓存 snapshot/model但仍执行当前 tick RoomVisual 绘制

#### Scenario: 关键状态变化
- **WHEN** 缓存未满 5 tick但 Hub status 或 protection revision 变化
- **THEN** 下一次 overlay 调用重新采集并构建 visual model

#### Scenario: Analytics 与 overlay 同 tick
- **WHEN** analytics phase 已在当前 tick 采集 Hub snapshot后 overlay phase 运行
- **THEN** overlay 复用该 snapshot/model而不进行第二次完整采集

### Requirement: Visual call 预算使用真实绘制计数
主面板和卫星面板绘制函数 MUST 返回其实际 `Panel.callsUsed`，且总 overlay MUST 在既定 visual call 预算和卫星面板硬上限内。卫星候选 MUST 按 blocker、活动生产和稳定房间名排序后截断；预算判断不得依赖仅由测试 mock 提供的全局调用数组。

#### Scenario: 所有面板低于预算
- **WHEN** 主面板与所有候选卫星面板的预估 calls 不超过总预算和卫星上限
- **THEN** 系统绘制全部候选且返回/累计的 calls 与实际 RoomVisual 调用相符

#### Scenario: 卫星候选超过预算
- **WHEN** 绘制全部卫星面板会超过总预算或硬上限
- **THEN** 系统保留 blocker 和活动生产优先的面板并确定性跳过其余候选

### Requirement: Hub visual 行为具有回归测试与静态验证
系统 MUST 通过单元测试覆盖健康优先级、可靠进度、物流方向与 blocker、逐化合物 T3、底板高度、缓存失效、卫星排序及调用预算，并 MUST 通过 TypeScript 无输出检查和 bundle 构建。

#### Scenario: 本地完成实现
- **WHEN** 变更准备交付
- **THEN** 定向 Jest、全量 Jest、`npx tsc --noEmit` 与 `npm run build` 均成功，且不得将静态结果表述为已验证实际地图渲染
