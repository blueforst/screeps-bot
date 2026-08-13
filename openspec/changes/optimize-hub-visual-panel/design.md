## Context

Hub 进度链当前由 `runHubProgressAnalytics` 与 `renderHubProgressOverlays` 分别调用 `collectHubProgressSnapshot`。快照已经包含 Hub 状态、合成阶段、缺料、错误、转运任务、卫星生产、T3 储备与保护 revision，但 `HubVisualModel` 只投影进度、按 `from` 聚合的任务数和汇总储备。结果是正常态简洁，但 export 目的地、任务阻塞、无目标进度和单个 T3 缺口均不可见。

RoomVisual 必须每 tick 重绘才能保持显示，但快照采集无需每 tick 扫描所有房间、lab、carrier 和 transfer task。现有 `MAX_HUB_VISUAL_CALLS` 通过 Jest mock 的 `global.__roomVisualCalls` 计算，真实 Screeps 运行时没有该计数源；通用 `Panel` 已自行记录 calls，却没有作为预算依据。线上只读采样中，`hubProgressAnalytics` 与 `hubProgressOverlay` 在同一 tick 分别约使用 0.70 与 0.67 CPU，说明避免重复采集有实际收益。

## Goals / Non-Goals

**Goals:**

- 让主面板在一眼范围内表达 Hub 健康、当前生产、物流方向与最严重 T3 缺口。
- 正常态保持紧凑，异常态仅展开有限且确定排序的诊断行。
- 保持主面板与卫星本地面板的职责分离，不恢复主面板的全量生产房间列表。
- 将昂贵快照采集限制为最多每 5 tick 一次，并在关键状态或 plan revision 变化时立即刷新。
- 以实际 `Panel.callsUsed` 实施总调用预算和卫星数量上限。
- 保持所有业务投影只读、无新持久 store 或 schema 迁移、无 tick phase 顺序变化；允许现有 analytics Hub 快照增加兼容观测字段。

**Non-Goals:**

- 不修改 Hub 规划、分布式分配、合成状态机、资源转运执行、市场保护或 reserve 策略。
- 不增加 RoomVisual 点击交互，也不把完整 `hubProgressRaw()` 诊断数据复制到地图面板。
- 不在本变更中部署到 Screeps 或以静态测试替代实际渲染验收。

## Decisions

### 1. 使用异常优先的专用 Visual Model

`HubProgressSnapshot` 继续作为控制台与 analytics 的事实快照；`buildHubVisualModel` 负责生成受限的视图模型：健康等级、有界 alerts、可靠进度模式、方向化物流行、生产房间摘要和逐化合物储备行。渲染层不得重新解释原始 Memory。

健康等级按确定优先级计算：Hub/生产错误或无效保护快照为 error；待规划、缺料、blocked transfer 或 terminal 低于 reserve 且仍有任务为 warn；其余为 ok。T3 战略缺口在独立区块展示，不单独把运行健康升级为 error。

替代方案是直接把 snapshot 字段逐行渲染；该方案会重新制造信息拥挤，也难以测试异常优先级，因此不采用。

### 2. 物流按任务方向投影，而不是统一按来源聚合

每个 Hub pending task 保留 classification、created/last-progress tick、blocked reason/since。import 与 reclaim 的 counterpart 是来源房间并使用入站箭头；export 的 counterpart 是目的房间并使用出站箭头。行按 blocked 优先、年龄降序、剩余量降序和稳定字典序排序，最多显示三条并给出 overflow。

不修改 canonical transfer task，也不创建第二执行源；这里只增加只读字段投影。

### 3. T3 同时保留兼容汇总和新增逐化合物事实

`t3ReserveStatus` 保留现有 `hubSurplus` 与 `totalDeficit`，避免控制台/monitor 消费方破坏；新增 `compounds`，每项包含 Hub 当前量、Hub reserve、Hub deficit/surplus 与全网 satellite deficit。视觉层按总缺口严重度排序，仅展示前三项；全部满足时展示 `N/N stocked`。

不再把不同化合物的正盈余当作可以互相抵消的健康信号。

### 4. 进度使用 determinate/activity/idle 三态

只有 `synthesisTargetAmount > 0` 时使用 determinate bar，并用 Hub storage、terminal、carrier 与 lab 的产品总量计算绝对目标进度。存在产品但无可靠目标时使用 activity 文本行，展示产品库存与阶段；无产品时显示 idle。删除固定 1,000 fallback。

### 5. 主面板摘要、卫星面板本地化

主面板只显示 active/blocked production room 数量，不逐房展开。卫星面板继续只显示本房产品、阶段、上下游和 blocker。卫星候选按 blocker、活动阶段、房间名排序，在数量上限和剩余 call budget 内绘制。

### 6. Panel 显式绘制预估高度的单层背景

为 `Panel` 增加 `background(height)` 和可着色 section header。Hub 与卫星渲染在首个内容调用前，根据同一组有界行数计算高度并绘制一次 `VIS_PANEL_FILL` 底板。所有绘制方法继续累计 `callsUsed`，绘制函数返回该值。

采用显式高度而不是延迟 command buffer，避免改写全部 Panel 调用模型和增加每 tick 临时对象数量。

### 7. module heap 缓存事实快照与 visual model

模块级缓存保存 snapshot、model、采集 tick 与轻量 signature。signature 包含 Hub 配置房间/开关、Hub status/needsPlan/error/active product、合成 stage/product/target，以及 protection attempt/committed revision 与有效性。

`runHubProgressAnalytics` 每次采集后同时更新缓存；overlay 在缓存年龄小于 5 tick 且 signature 未变化时复用，否则采集并更新。任务量、库存和普通 blocker 最多延迟 4 tick，关键状态/revision 立即刷新。RoomVisual 仍每 tick绘制，global reset 后缓存可从当前状态安全重建。缓存本身不进入 Memory；analytics 仍沿用既有 `Memory.analytics.hub` 字段，只接收向后兼容的快照扩展。

替代方案是把缓存写入 `Memory.analytics` 并只读取它；这会扩大持久数据的语义并在 analytics 关闭或延迟时产生耦合，因此使用 module heap。

### 8. 真实调用预算与可验证截断

主、卫星绘制函数返回 `Panel.callsUsed`。overlay 先绘制主面板，再按候选顺序判断卫星的精确预估 calls 是否能放入总预算；同时设置卫星面板硬上限。截断日志最多每 100 tick 输出一次，避免控制台刷屏。

## Risks / Trade-offs

- [普通库存或任务变化最多延迟 4 tick] → 关键状态/revision 改变立即失效；5 tick 对只读操作面板足够新鲜，并在面板中不宣称逐 tick 精确。
- [显式高度计算与渲染条件漂移] → 将可见行选择先归一化为 model 字段，测试背景高度覆盖最后一行且 call 计数精确。
- [Unicode 箭头或警告符号显示差异] → 沿用项目已使用的箭头与警告字符，并保留文字 action/blocker 作为非颜色语义。
- [卫星面板被预算截断] → blocker 与活动生产优先，稳定排序；主面板显示 active/blocked 汇总，不因截断掩盖总体异常。
- [新增快照字段增加 analytics 大小] → 只为已有 Hub pending task 增加少量标量字段，数组仍受现有任务域约束；不复制完整任务对象。
- [健康规则产生长期 warn] → T3 缺口独立展示；只有执行错误、缺料、待规划和真实 blocked task 影响健康等级。

## Migration Plan

1. 先扩展 snapshot/model 与单元测试，保持旧汇总字段兼容。
2. 切换主/卫星渲染并启用背景与真实 call 计数。
3. 接入 module heap 缓存，验证同 tick analytics/overlay 只采集一次以及五 tick 失效行为。
4. 运行定向 Jest、全量测试、`npx tsc --noEmit` 和 `npm run build`。
5. 如后续获得部署授权，先记录当前版本并 `npm run push`，再用 `npm run monitor:once` 验证 deploy tag、CPU phase 和 Hub 状态；实际地图可读性仍需人工/截图验收。

回滚时只需回退视觉与快照投影改动；缓存不持久化，global reset 后不会留下迁移状态。

## Open Questions

- 首次实际渲染后，13.5 room unit 宽度下 blocker 文本是否需要更激进缩写，需由截图验证决定。
- 若未来希望在主面板显示详细 production graph，应另建能力，不扩大本变更的紧凑摘要职责。
