# Hub T3 Upgrader 设计

## 目标

在 Hub 房间尚未达到 RCL8 时，自动维持 2 只使用 `XGH2O` 强化的专用 upgrader。规模按用户给定的资源模型确定：Hub 掌控 4 个普通能量矿，理论总产出约为 `4 × 10 = 40 energy/tick`；扣除约 `10 energy/tick` 的采矿、运输和周期性孵化损耗后，可持续升级预算约为 `30 energy/tick`，因此维持 2 只各含 15 个 `WORK` 的 upgrader。

## 范围与边界

- 只作用于 `Memory.cfg.hub.hubRoomName` 指定的 Hub 房间。
- 仅在房间归属己方且控制器为 RCL7 时启用。
- 固定维持 2 只，不引入滚动产能统计或复杂反馈控制。
- 控制器达到 RCL8 后立即删除生产配置、清理队列并释放 boost lab；已有 creep 不再补产。
- Hub T3 upgrader 的生产优先级低于母房 carrier 和战争 creep，不改变现有战争优先级约束。
- 不改变普通 worker 的数量策略和任务池。

## Creep 规格

新增专用角色 `hubUpgrader`，配置名为：

- `<hubRoom>:hubUpgrader:0`
- `<hubRoom>:hubUpgrader:1`

固定身体为：

```text
15 WORK + 5 CARRY + 10 MOVE
```

单只造价 2250 energy，消耗 450 `XGH2O` 完成 15 个 `WORK` 部件强化。满负载时单只消耗 15 energy/tick，并产生约 30 controller progress/tick；两只合计消耗 30 energy/tick、产生约 60 progress/tick。

`MOVE` 数量按铺路环境设计，足以承载 20 个非 MOVE 部件；`CARRY` 提供 250 energy 缓冲，主要从控制器附近的 link 或 container 取能。

## 控制器与生产流程

新增独立的 Hub 升级控制器，每 tick 执行以下状态协调：

1. 读取 Hub 配置并验证房间归属和 RCL。
2. RCL7 时创建或维护两个 `hubUpgrader` 配置。
3. 根据两只 creep 尚未强化的 `WORK` 数量计算剩余 `XGH2O` 需求。
4. 复用现有 boost 准备设施，为一个共享任务预留单个 lab，并准备所需矿物和 lab energy。
5. boost 就绪后允许两只 creep 依次进入同一个 lab 完成强化。
6. 两只当前 creep 均完成强化后释放 lab，恢复 Hub 合成；出现替补需求时重新申请。
7. RCL8、失去房间或 Hub 配置停用时删除配置和排队项，并释放 boost 资源。

共享 boost 任务避免同时长期占用两个 lab，也避免为已经完成强化的存活 creep 重复准备矿物。

## 角色行为

`hubUpgrader` 不进入普通 worker 任务池，只执行控制器升级：

- `prepare`：在共享 boost lab 完成 `XGH2O` 强化；未完成前不得离开准备区。
- `source`：优先从控制器附近的 link 取能，其次使用控制器附近的 container；均不可用时等待，不跨房取能。
- `target`：在控制器升级范围内持续调用 `upgradeController`；能量耗尽后返回取能阶段。
- 控制器不再属于己方或已经 RCL8 时停止升级行为，等待控制器清理配置，不执行其他 worker 工作。

## Spawn 优先级

现有生产排序和 spawn 执行门控共同保证：

1. 母房 carrier
2. 战争 creep
3. Hub T3 upgrader
4. 其他普通生产

当 Hub 自身成为战争母房时，等待中的战争配置会阻止 `hubUpgrader` 消耗 spawn energy；战争配置开产后，Hub upgrader 才可继续补产。

## 异常处理

- `XGH2O` 不足：保留配置但不让未强化 creep 开始升级，由现有跨房资源任务补料。
- lab 不足或被战争占用：等待并定期重试，不把任务永久标记为失败。
- 控制器 link 暂时断粮：creep 原地等待，不从 terminal/storage 进行长距离低效搬运。
- creep 死亡：仅为缺失配置补产，并按剩余未强化 `WORK` 数重新准备 boost。
- RCL8 或房间丢失：清理配置、spawn 队列和 boost lab 占用，避免残留状态。

## 测试策略

按测试驱动方式覆盖：

- RCL7 Hub 恰好创建两个固定身体配置。
- 非 Hub、非己方房间和 RCL8 不创建配置。
- RCL8 会删除配置、清理 spawn 队列并释放 boost 任务。
- boost 需求按未强化的 `WORK` 数计算，两个新 creep 共需 900 `XGH2O`。
- 两只完成强化后释放共享 lab；替补出现时只准备缺失部分。
- `hubUpgrader` 优先从控制器 link/container 取能并只升级本房控制器。
- spawn 排序中 Hub upgrader 低于战争 creep、高于普通生产，且现有母房 carrier 最高优先级保持不变。
- 全量 Jest、TypeScript 类型检查和 Rollup 构建通过后才允许部署。
