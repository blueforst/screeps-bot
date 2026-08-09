## Why

当前 PowerBank 可行性模型与实际单攻击手编队、RCL8 强化配置和旅行时间单位不一致，可能接受无法按时击破的目标；同时 Boost、续命、替补、攻击和回收阶段缺少统一截止时间与进度约束，会出现停滞、重复申请资源或把零收益任务记为成功。现有测试虽然通过，但关键生命周期分支缺少合同覆盖，因此需要先恢复正确性，再考虑 CPU 微优化。

## What Changes

- 由实际 creep body、强化需求、计划编队数量和 Spawn 并行度派生 DPS、HPS、生产时间及完整任务时间线。
- 评估所有可用来源房间，以真实强化需求、Lab/库存/在途供给、Spawn ETA、路线风险及接收容量选择可执行候选。
- 为 PowerBank 任务增加绝对衰减截止时间、阶段进入时间、最近进展、阻塞原因和有限重试语义。
- 将主战与替补建模为带 generation 的双人组；只有攻击手和治疗手均属于当前代、完成强化、相邻且具备有效部件时才允许攻击。
- 使 Boost 准备成为可回滚事务，纳入 Lab 能量，处理 `boostCreep`/`renewCreep` 返回码，并隔离主力与替补的 Lab 生命周期。
- 让 creep config、Spawn 队列、搬运工和清理操作以 task ID 与 generation 唯一归属，避免并发 Bank 互相覆盖。
- 记录掉落观测、拾取、交付和损失，区分成功、部分回收、过期与被争夺，不再把零收益空场无条件记为完成。
- 让战斗组和 Hauler 共享任务路线及危险房快照，并增加状态、截止余量、资源阻塞和回收结果的只读观测。
- 补充可行性、Boost 事务、完整状态机、替补换代、编队就绪和真实回收闭环回归测试。

## Capabilities

### New Capabilities

- `power-bank-squad-lifecycle`: 规定 PowerBank 目标准入、双人组生命周期、强化事务、截止时间、替补换代、运输回收及观测合同。

### Modified Capabilities

无。本变更不修改现有资源转运合同；PowerBank 跨房资源 intent/lease 的迁移继续由 `decentralized-logistics-contracts` 承接。

## Impact

- 主要影响 `src/runtime/powerBankViability.ts`、`powerBankHarvest.ts`、`powerBankBoost.ts`、PowerBank 角色、Spawn 规划、Memory 类型与相关测试。
- 任务 Memory 会新增时间线、双人组代际、阻塞与回收统计字段；旧任务需要兼容性初始化或安全终止。
- 不新增全局写接口，不改变主循环阶段顺序，不另建跨房物流账本。
