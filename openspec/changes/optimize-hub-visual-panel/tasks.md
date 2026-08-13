## 1. P0 事实投影与健康模型

- [x] 1.1 扩展 Hub pending task 快照，保留 classification、任务年龄、last-progress age、blocked reason 与 blocked age，同时保持旧字段兼容
- [x] 1.2 扩展 T3 reserve 快照为逐化合物 Hub 库存、底线、盈亏和全网缺口，同时保留旧汇总字段
- [x] 1.3 重构 `HubVisualModel`，生成健康等级、有限告警、可靠三态进度、方向化物流、生产房间摘要和缺口优先 reserve 行
- [x] 1.4 为健康优先级、无目标 activity 进度、入出站 counterpart、blocker 排序和逐化合物 T3 增加模型测试

## 2. P1 自适应面板与底板

- [x] 2.1 扩展共享 palette 与 `Panel`，支持单层半透明动态高度底板、可着色 header 和真实 calls 计数
- [x] 2.2 将 Hub 主面板切换为健康摘要、可靠生产、方向化物流和逐化合物 T3 的正常/异常自适应布局
- [x] 2.3 保持卫星面板本地职责，并在主面板增加 active/blocked production room 有界汇总
- [x] 2.4 增加主面板、卫星面板、底板高度、非颜色语义和绘制调用数测试

## 3. P2 缓存、预算与清理

- [x] 3.1 实现 5 tick module heap visual cache、关键 signature 失效，并让 analytics 同 tick 填充 overlay 缓存
- [x] 3.2 使用 `Panel.callsUsed` 实施总 visual call 预算、卫星硬上限及 blocker/活动优先的确定性截断
- [x] 3.3 删除废弃的分布式主面板绘制函数、固定 1,000 进度和失效的 mock 全局预算计数路径
- [x] 3.4 增加缓存复用/失效、analytics-overlay 去重、卫星优先级和调用预算测试

## 4. 验证与交付门禁

- [x] 4.1 运行 hub progress、panel 与 palette 定向 Jest 测试
- [x] 4.2 运行全量 `npm run test`
- [x] 4.3 运行 `npx tsc --noEmit`
- [x] 4.4 运行 `npm run build`
- [x] 4.5 审计 tick phase 顺序、持久 store/owner、控制台旧字段和业务执行副作用未改变，analytics 新字段保持加法兼容且无需迁移
