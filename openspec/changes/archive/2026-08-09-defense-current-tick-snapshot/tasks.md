## 1. 特征测试

- [x] 1.1 覆盖显式 updater 之前读取、global reset 后首次读取，以及 hostile 跨 tick 出现和消失
- [x] 1.2 覆盖稳定 revision 时同一 epoch 只构建一次、规划 revision 变化时固定 updater 重建、相同 tick 替换 Game 对象，以及多房间状态隔离
- [x] 1.3 锁定 Source Keeper、Invader、危险 body part、无安全区和未知房间的现有判定
- [x] 1.4 覆盖初次与规划 revision 重建中途失败时不发布半份 snapshot、旧代失效，并在下一次普通读取完整重试

## 2. Current-tick snapshot 实现

- [x] 2.1 在 `defenseMode.ts` 中实现以 Game identity、`Game.time` 与安全区规划 revision 为边界的原子 snapshot 构建，并在失败时失效旧代
- [x] 2.2 让 `isDefenseMode()` 与 `runDefenseMode()` 共用同一 ensure 入口，并同步更新测试清理入口

## 3. 本地验证与独立复核

- [x] 3.1 运行 Defense Mode 与全部既有消费者的聚焦测试
- [x] 3.2 运行 TypeScript、全量 Jest、Rollup build 和 OpenSpec strict validation
- [x] 3.3 复核 diff，完成独立实现审查与消费者回归审查

## 4. 部署与线上观测

- [x] 4.1 提交运行时代码，以父 commit `9592a3d` 和线上 `e647683` 记录回滚边界
- [x] 4.2 部署同一已验证 commit，并确认 shard1 deploy tag 已更新
- [x] 4.3 跨多个采样 tick 观察完整 phase、总 CPU、bucket、Spawn/Creep 执行和错误输出
