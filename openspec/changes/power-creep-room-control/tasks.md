## 1. Power Creep 基础控制

- [x] 1.1 扩展 PowerCreepMemory、任务和房间能力类型
- [x] 1.2 实现通用房间归属引导和按技能动态发现能力
- [x] 1.3 实现 PC 孵化、房间启用、续命及持久化优先级队列执行器

## 2. 技能与 OPS 调度

- [x] 2.1 实现 GENERATE_OPS 冷却入队和 OPS 高低水位卸载
- [x] 2.2 实现最高普通优先级 OPERATE_STORAGE 调度
- [x] 2.3 实现两个 Source 的 REGEN_SOURCE 成功后交替调度
- [x] 2.4 实现按 Extension 能量缺口调度 OPERATE_EXTENSION
- [x] 2.5 实现 OPERATE_STORAGE 冷却重叠窗口、范围 3 预定位和缺 OPS 时的队列门控
- [x] 2.6 将 Power Creep 同房移动接入通用寻路、占位识别和范围锚点推让
- [x] 2.7 按 REGEN_SOURCE 等级扩展 link miner 体型，并实现先补后退的安全换代
- [x] 2.8 让 REGEN_SOURCE 在 cooldown 归零时立即入队，保留等待中的任务并提前移动到下一 Source

## 3. Carrier 与 Power Spawn 联动

- [x] 3.1 按动态能力调整 Spawn、Extension 和 Power Spawn 的 carrier 目标
- [x] 3.2 扩展 carrier 任务板并发布 Power Spawn 的 Power/Energy 批量补给任务
- [x] 3.3 实现 Power Spawn 资源充足时自动 processPower
- [x] 3.4 将 Power Spawn 补给插入正确的 carrier 优先级位置

## 4. 集成与验证

- [x] 4.1 将 PC 和 Power Spawn 控制阶段接入主循环及 CPU 统计
- [x] 4.2 添加 PC 队列、动态供能策略和 Power Spawn 补给/加工单元测试
- [x] 4.3 完成 OpenSpec 严格校验、TypeScript 检查和构建；相关 100 个测试通过，全量 3351/3352，唯一既有耗时断言隔离复测通过
- [x] 4.4 部署 `2026.8.9-2` 到 shard1；验证 PC 孵化/启用/技能轮换、carrier 双资源任务和 Power Spawn 连续加工
- [x] 4.5 添加 Storage 持续维护回归测试，部署 `2026.8.9-3` 并核对真实维护队列、OPS 解锁和范围 3 预定位
- [x] 4.6 添加 PC 双向交通推让回归测试，部署 `2026.8.9-4`；tick 72868039-72868040 实测 E4N58 与 remoteMiningCarrier 交换位置完成让路
- [x] 4.7 添加 REGEN_SOURCE miner 体型、能力隔离、常规换代和单入口矿点交接回归测试；全量 3372 个测试通过，实况边界修正后相关 131 个测试、TypeScript、构建及 OpenSpec 严格校验通过
- [x] 4.8 部署 `2026.8.9-6`；tick 72868740 验证 E4N58 两个 miner 均完成 `12 WORK + 6 CARRY + 5 MOVE` 换代，单入口矿点正常交接且 Spawn 无重复队列
- [x] 4.9 添加 REGEN_SOURCE 旧 effect 等待、预定位与到期首 tick 施法回归测试；全量 122 suites / 508 tests、TypeScript、构建、diff 检查及两个 OpenSpec 严格校验通过
- [ ] 4.10 提交并部署到 shard1，验证 cooldown 归零后任务已提前入队且 PC 向下一 Source 预定位
