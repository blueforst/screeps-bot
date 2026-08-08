## 1. Maintenance 策略与运行时

- [x] 1.1 新增共享的 175,000/195,000 tick 滞回策略、运行门禁与 RCL8 最小身材常量。
- [x] 1.2 让 Hub 控制在健康 RCL8 清理专职任务，在风险窗口创建并维持无 boost maintenance 任务。
- [x] 1.3 让 upgrader 角色仅在任务、配置、所有权与恢复计时均有效时执行 source、prepare 和 upgrade intent。

## 2. 回归测试

- [x] 2.1 覆盖健康 RCL8、启动边界、滞回区间、停止边界、RESERVE 独立启动和无 boost 最小身材。
- [x] 2.2 覆盖 stale 角色拒绝、恢复角色运行，以及 RCL8/失去所有权的任务、队列、spawn、creep、boost 全链清理。

## 3. 验证

- [x] 3.1 运行 upgrader、Hub、worker/spawn/main 定向测试、TypeScript、构建、diff check 与 OpenSpec strict 校验。
- [x] 3.2 运行完整 Jest，区分确定性失败与既有 wall-clock 抖动，不放宽 CPU 门禁。

## 4. 部署与观察

- [ ] 4.1 更新版本并从干净 worktree 部署包含市场 CPU、colonizer 与 RCL8 maintenance 的完整 bundle。
- [ ] 4.2 只读确认 shard1 部署标签、健康 RCL8 清理/计时安全、市场 Shadow 与零写入状态。
- [ ] 4.3 等待并对比部署后的完整 120 样本 CPU 窗口；未达到窗口前不得宣称线上稳态收益。
