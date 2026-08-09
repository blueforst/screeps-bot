## 1. 规划与数据合同

- [x] 1.1 扩展 Carrier 任务、Memory runtime 和 Nuker 运行态类型
- [x] 1.2 扩展 Hub/Distributed Synthesis 链规划，使其接收附加 Ghodium 消耗需求

## 2. Nuker 补给控制

- [x] 2.1 实现己方 Nuker 发现、容量缺口、在途 Carrier 和运行态汇总
- [x] 2.2 实现本房 Ghodium Carrier 草案、资源预留与失效清理
- [x] 2.3 实现扣除保护和 pending 任务的跨房 Ghodium donor 选择与 automatic transfer
- [x] 2.4 实现非 RESERVE 房间受 Energy target、Terminal reserve 和既有承诺保护的 Energy 草案

## 3. Carrier 与主循环集成

- [x] 3.1 实现 Nuker 结构任务执行和 Ghodium 专用优先级，保留既有 pickup 快照交付
- [x] 3.2 将 NukerControl 接入 Hub Planner 之前的主循环和 CPU phase

## 4. 测试与校验

- [x] 4.1 添加 Hub 附加 Ghodium 需求及库存抵扣回归测试
- [x] 4.2 添加 Nuker 本地补给、跨房去重、donor 保护、RESERVE 和 Energy 安全余量测试
- [x] 4.3 添加 Carrier 优先级、任务刷新交付和主循环顺序测试
- [x] 4.4 完成目标测试、全量测试、TypeScript、构建、diff 检查和 OpenSpec 严格校验

## 5. 提交、部署与实况验证

- [ ] 5.1 更新版本并提交代码，部署到 shard1
- [ ] 5.2 验证真实 Nuker runtime、Ghodium 转运/合成需求、Carrier 草案及 Energy 安全门控
