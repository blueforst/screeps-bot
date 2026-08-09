## 1. 策略与退役实现

- [x] 1.1 将共享 dedicated-upgrader 策略和手动启动入口收窄为仅 RCL8 maintenance，保持 175,000/195,000 滞回不变。
- [x] 1.2 清理 RCL1–7 普通 upgrader 的 task/config/queue/spawning/boost，同时让 live ordinary creep 停工并自然退役。
- [x] 1.3 让 Hub 只生成最小无 boost maintenance 配置，并让 spawn planner 拒绝未认证的普通 upgrader 补产。

## 2. 回归测试

- [x] 2.1 覆盖 RCL1–7 不创建、手动入口拒绝、完整生产链清理和 live ordinary creep 不 suicide。
- [x] 2.2 覆盖自然退役角色不提交 intent、spawn planner 不补产普通 upgrader。
- [x] 2.3 复验 RCL8 175,000/195,000 边界、最小身材、无 boost、停止时即时清理和通用 worker upgrade task 不变。

## 3. 验证

- [x] 3.1 运行 upgrader policy/Hub/role/spawn/worker/bootstrap 定向 Jest。
- [x] 3.2 运行 TypeScript、构建、diff check 与 OpenSpec strict validate。

## 4. 审查修正

- [x] 4.1 使用 task provenance 收紧 maintenance 即时清理身份，并迁移合法的旧版 active maintenance。
- [x] 4.2 修复唯一 spawning maintenance 自我取消，保留真正 live maintenance 对重叠 replacement 的抑制。
- [x] 4.3 覆盖最小 ordinary 自然退役、provenance 迁移、连续 spawning 和健康阈值不重建，并重新运行定向测试、TypeScript 与严格校验。
