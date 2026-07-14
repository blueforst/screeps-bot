## 1. 共享容量策略

- [x] 1.1 为默认水位、terminal/storage 单调规范化、建筑容量上限和 feature flag 编写失败测试
- [x] 1.2 新增共享 `CapacityHeadroomPolicy` 纯函数模块，并在 `src/global.d.ts` 中补充 `terminalHeadroomRecoveryEnabled` 及 runtime 可选类型
- [x] 1.3 将 ResourceControl 的容量状态判断和 Hub distribution 的 receiver buffer 切换到共享策略，删除 Hub 重复常量并通过一致性测试

## 2. Receiver 容量投影与预留

- [x] 2.1 为多 producer 同 tick 竞争、任务自身承诺排除、失效承诺释放和未完成 offload 不提前增容编写失败测试
- [x] 2.2 实现单轮复用的 room capacity/commitment index，按 terminal 总空闲、资源空闲、storage 空闲和健康承诺计算安全可接收量
- [x] 2.3 为 admission 增加同 tick reservation 账本，并让 Hub planner、capacity planner 与 transfer executor 共用该账本
- [x] 2.4 在 `terminal.send` 前重验 receiver 物理容量，并验证所有 producer 的累计承诺不超过安全 headroom

## 3. Terminal 恢复闭环

- [ ] 3.1 为 full→50k 粘滞区、双水位恢复、正常区间滞回、storage 无空间和 protected-only terminal 编写失败测试
- [ ] 3.2 将 pressure/emergency 房间的 terminal offload 目标改为 `terminalReliefTargetFreeCapacity`，保留 normal 房间现有日常 overflow 行为
- [ ] 3.3 实现非 energy 优先、energy 最后且保护 admitted staging、energy reserve、交易费预算和生产库存的 offload 选择
- [ ] 3.4 验证 carrier 尚未完成 offload 时容量状态和 receiver admission 不会提前恢复，并覆盖多周期无 feed/offload 振荡

## 4. Staging admission

- [ ] 4.1 为 `receiver_capacity`、`source_depleted`、真实 fee 不足、terminal cooldown、25 单位尾数和 receiver reservation 上限编写失败测试
- [ ] 4.2 按现有优先级为每个 source room 构建当前/下一发送机会的有界 staging window，并细分资源缺料与 fee/保护库存不足
- [ ] 4.3 让 terminal feed 仅装载已获 admission 的安全批次，在 blocker 变化时移除或恢复旧 feed
- [ ] 4.4 保证同房同资源同轮不会同时生成冲突 feed/offload，且被抑制 staging 不再保护 terminal 库存
- [ ] 4.5 增加覆盖 carrier draft 替换、任务恢复且无需重建持久 transfer task 的集成测试

## 5. 观测与兼容

- [ ] 5.1 扩展 `Memory.runtime.resourceControl`，输出规范化水位、eligible receiver 数、每房恢复 gap/可排空量、粘滞原因、reservation 与 admitted/suppressed staging 摘要
- [ ] 5.2 更新 `scripts/monitor-service.mjs` 及其 fixture/test，展示新增字段并兼容缺少字段的旧 runtime 快照
- [x] 5.3 增加索引构建次数或等价测试钩子，证明 planner、executor 与 feed sync 在单轮内复用同一 capacity/commitment index

## 6. 验证与上线准备

- [ ] 6.1 运行聚焦的 ResourceControl、Hub、carrier task 和 monitor 测试并修复回归
- [ ] 6.2 运行 `npx tsc --noEmit`、`npm run test` 和 `npm run build`，记录通过结果及 ResourceControl 基准 CPU 对比
- [ ] 6.3 复查变更未修改主循环阶段顺序、energy export、矿物/T3/生产保护、market 与手工 transfer 语义
- [ ] 6.4 部署前记录 receiver/blocker/CPU 基线；部署后观察至少两个恢复周期，确认 receiver 数回升、50k 粘滞消失、安全容量越界为零且 CPU 无显著回退
- [ ] 6.5 验证关闭 `terminalHeadroomRecoveryEnabled` 可回滚新 offload/staging 行为，且无需清理现有 transfer tasks
