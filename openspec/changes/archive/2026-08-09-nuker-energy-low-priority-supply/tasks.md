## 1. Nuker Energy 规划

- [x] 1.1 将非 Reserve Energy admission 改为 energyFloor 门槛并保留 Terminal reserve、生产预留、outgoing 与其他 Carrier 承诺扣除
- [x] 1.2 将 Energy task priority 降为 0，并把 task steps 与 production reservation 限制为标准 Carrier 1000 容量

## 2. Carrier 最低优先级执行

- [x] 2.1 将通用 board 选择拆为非 Nuker-Energy 正常任务和独立后台 Nuker Energy 阶段
- [x] 2.2 保留 dead-store、replacement retirement 和 accepted pickup snapshot 生命周期，并允许未取货旧 assignment 被正常任务覆盖

## 3. 回归测试

- [x] 3.1 添加 E6N59 精确水位、floor blocker、1000 task/reservation 上限和 Reserve 安全清理测试
- [x] 3.2 添加正常 priority 1 任务优先、旧 assignment 抢占、dead-store 优先、空闲执行和 Energy snapshot 交付测试
- [x] 3.3 添加 Carrier task board 数值降序与同优先级稳定顺序测试

## 4. 校验

- [x] 4.1 运行 NukerControl、Carrier role 和 Carrier task board 相关 Jest
- [x] 4.2 运行 TypeScript 无输出检查和生产构建
- [x] 4.3 运行 git diff check 与 change 严格校验

## 5. 同 tick 原子执行额度

- [x] 5.1 在 Carrier task board 增加 task/step 双重上限的瞬时 claim，覆盖失败、任务清理、Creep 死亡、成功提交和 tick 轮换生命周期
- [x] 5.2 将 Nuker Energy pickup 与普通已携 Energy fallback 接入同一 claim，保留 accepted snapshot 与同 tick refresh 额度
- [x] 5.3 添加多 Carrier 同 tick、额度缩小/拒绝、失败释放、清理/死亡/成功释放、任务 refresh 与 snapshot 回归，并重跑全部校验
