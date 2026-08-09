## 1. Maintenance 策略与运行时

- [x] 1.1 新增共享的 175,000/195,000 tick 滞回策略、运行门禁与 RCL8 最小身材常量。
- [x] 1.2 让 Hub 控制在健康 RCL8 清理专职任务，在风险窗口创建并维持无 boost maintenance 任务。
- [x] 1.3 让 upgrader 角色仅在任务、配置、所有权与恢复计时均有效时执行 source、prepare 和 upgrade intent。
- [x] 1.4 让 RCL8 永久省略通用 worker upgrade task，并让 RCL7→RCL8 stale target 立即 fail closed；build/repair/dismantle 与 workforce 保持不变。
- [x] 1.5 禁止 RCL8 maintenance 的重叠预出生，保持 RCL1–7 upgrader 预出生行为。
- [x] 1.6 让自动与手动入口共享 fresh-task 启动阈值，并清理 live maintenance 的 queued/spawning 重叠替补。

## 2. 回归测试

- [x] 2.1 覆盖健康 RCL8、启动边界、滞回区间、停止边界、RESERVE 独立启动和无 boost 最小身材。
- [x] 2.2 覆盖 stale 角色拒绝、恢复角色运行，以及 RCL8/失去所有权的任务、队列、spawn、creep、boost 全链清理。
- [x] 2.3 覆盖 RCL1–7 upgrade task 保留、健康/恢复期 RCL8 均无通用 upgrade task、其他 worker task 不变、stale 分配立即释放和 maintenance 单实例。
- [x] 2.4 用独立 literal 锁定 175,000/195,000 边界，并覆盖 175,001 手动拒绝、175,000 手动允许和旧 spawning 替补取消。

## 3. 验证

- [x] 3.1 运行 upgrader、Hub、worker/spawn/main 定向测试、TypeScript、构建、diff check 与 OpenSpec strict 校验。
- [x] 3.2 运行完整 Jest，区分确定性失败与既有 wall-clock 抖动，不放宽 CPU 门禁。
- [x] 3.3 重新运行 worker/upgrader/spawn/main 定向测试、TypeScript、构建、完整 Jest、diff check 与 OpenSpec strict 校验。

## 4. 部署与观察

- [x] 4.1 更新版本并从干净 worktree 部署包含市场 CPU、colonizer 与 RCL8 maintenance 的完整 bundle（`2026.8.8-2+d7a96c9`）。
- [x] 4.2 只读确认 shard1 部署标签、健康 RCL8 清理/计时安全、市场 Shadow 与零写入状态（tick 72856700/72856701：三个 RCL8 控制器剩余 199,999 tick，56/56 lane 为 Shadow/suspended，市场写入与风险状态全零）。
- [x] 4.3 用户在旧部署达到完整窗口前收紧 RCL8 worker task 合同；`d7a96c9` 观察于 18/120 样本终止，不作为稳态收益结论。
- [x] 4.4 从 commit `47cc10a` 的干净 detached worktree 部署新的 RCL8 worker task 合同；上传 1 个模块至 Screeps `default` branch，实际标签为 `2026.8.8-3+47cc10a@2026-08-08T08:06:32.418Z`。
- [x] 4.5 只读确认 shard1 新部署：tick 72857404 的 E4N58/E6N59/W1N57 worker task board 均已刷新且通用 upgrade task 为 0，同时仍存在 build/repair task；tick 72857319 三个 RCL8 均剩余 199,380 tick，健康态无 manual task、专用 config、creep、queue 或 spawning。当前未自然进入 175,000 tick 启动窗口，最小 `[WORK,CARRY,MOVE]`、175,000/195,000 滞回与单实例合同仅由测试覆盖、未宣称本轮实机触发。部署后市场仍为 56/56 Shadow/suspended，managed order、pending mutation、terminal claim、staging、reservation、exposure、fee 与 safety violation 均为 0。
- [x] 4.6 `2026.8.8-3+47cc10a@2026-08-08T08:06:32.418Z` 的纯新 120 样本窗口覆盖 tick 72857450–72858640（interval 10、history 120）：总 CPU 均值 97.4166→98.2284（+0.83%）、EMA 97.8689→92.9536（-5.02%）、max 142.4000→166.7643（+17.11%），bucket avg/min 均维持 10,000；同期 market automation 35.9009→37.3936（+4.16%）、preflight 7.8334→7.5479（-3.64%）、creepWork 27.3979→30.1432（+10.02%）、其子项 pathing 13.5003→16.4221（+21.64%）。当前为 8 房、2 worker、9 carrier，世界负载与路径开销漂移，故只记录“总均值近似持平、无可归因的线上整体 CPU 降幅”，不把聚合变化归因于本轮代码。tick 72858667/72858669 再次只读确认三个 RCL8 均剩余 198,032 tick，健康态无 maintenance task/config/creep/queue/spawning/boost，实时 task board 的通用 upgrade task 为 0 且 build/repair 仍存在；低阈值分支未实机触发、未主动制造条件。各轮 monitor 采样均保持 56/56 Shadow/suspended 与全部写面/风险计数为 0。
