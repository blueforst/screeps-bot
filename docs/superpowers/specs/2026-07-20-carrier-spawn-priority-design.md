# Carrier 生产优先级与紧急机制解耦设计

## 背景

当前生产规划会把存活的紧急 carrier 视为标准 carrier 配置的临时替代品，并从生产队列中移除被其“覆盖”的标准 carrier。这个行为把两套本应独立的机制耦合在一起：紧急 carrier 负责房间 carrier 归零时的即时救场，标准 carrier 则负责长期、稳定的常规运力。

## 目标

- 紧急 carrier 仅在房间内没有存活 carrier、也没有正在生产的 carrier 时生成。
- 紧急 carrier 与标准 carrier 的配置、补充和生命周期互不覆盖。
- 紧急 carrier 的生产优先级高于标准 carrier。
- 标准 carrier 的生产优先级高于所有非 carrier creep。
- 标准 carrier 出生后，已有紧急 carrier 继续工作到自然死亡。

## 非目标

- 不改变 carrier 的搬运目标选择或任务优先级。
- 不改变其他 creep 之间的现有生产优先级关系。
- 不新增 creep role，也不修改 carrier body 生成策略。
- 不对已存活的紧急 carrier 执行 `suicide` 或其他提前退场操作。

## 生产规则

### 紧急 carrier 的登场条件

每个有可用 Spawn 的受管房间在生产规划阶段检查：

1. 房间内不存在任何存活的 `role="carrier"` creep；
2. 房间内不存在任何正在生产的 `role="carrier"` creep；
3. 房间的 Spawn 队列中不存在紧急 carrier 配置。

三个条件同时满足时，创建一个 `room:manual:maxcarrier:<tick>` 配置并加入队列。同一房间最多保留一个待生产的紧急 carrier。

标准 carrier 是否缺失、是否已排队，不参与紧急 carrier 的登场判断。原因是标准 carrier 尚未出生时，房间仍然处于实际无 carrier 状态，需要紧急 carrier 先行救场。

### 标准 carrier 的补充规则

标准配置（例如 `E4N58:carrier:0`）只根据自身对应 creep 的存活、生产和预生产条件决定是否入队。紧急 carrier 的存活、生产或排队状态不得：

- 覆盖标准 carrier 配置槽位；
- 阻止标准 carrier 入队；
- 从任何 Spawn 队列中删除标准 carrier；
- 延迟标准 carrier 的预生产时间。

因此在 carrier 归零后的恢复阶段，队列可以同时包含一个紧急 carrier 和一个或多个缺失的标准 carrier。

## 优先级

生产队列采用以下严格顺序：

1. 本房间紧急 carrier；
2. 本房间标准 carrier；
3. 其余 creep，保持当前已有的战争单位、hubUpgrader 和普通角色顺序。

同一优先级内继续保持原始队列顺序，避免无关任务抖动。紧急 carrier 即使晚于标准 carrier 被发现或加入，也必须稳定排到标准 carrier 前面。

## 生命周期

紧急 carrier 成功出生后，其临时配置仍按现有机制删除，但 creep 继续凭自身 Memory 正常执行 carrier 角色。

当标准 carrier 随后出生时：

- 不删除紧急 carrier；
- 不修改紧急 carrier 的任务；
- 不触发 `suicide`；
- 紧急 carrier 继续工作到自然死亡。

紧急 carrier 死亡后，只要房间仍有标准 carrier 存活或正在生产，就不会再次触发紧急生成。

## 实现范围

主要修改 `src/runtime/spawnPlanner.ts`：

- 删除紧急 carrier 对标准 carrier 的覆盖计算和队列过滤；
- 保留现有紧急 carrier 生成与队列去重逻辑；
- 为紧急 carrier 和标准 carrier 提供不同的显式生产优先级。

更新 `src/runtime/spawnPlanner.test.ts`：

- 将“紧急 carrier 覆盖标准 carrier”的旧断言改为二者独立入队；
- 验证紧急 carrier 始终排在标准 carrier 前面；
- 验证标准 carrier 高于战争单位、hubUpgrader 和其他 creep；
- 验证已有紧急 carrier 时仍会补充标准 carrier；
- 保留并验证紧急 carrier 的生成条件和队列去重行为；
- 验证标准 carrier 出生后不会产生额外紧急 carrier。

## 验收标准

- 房间无 carrier 时，生产队列头部为紧急 carrier，其后为缺失的标准 carrier。
- 房间已有紧急 carrier但缺少标准 carrier 时，标准 carrier 正常入队。
- 房间已有任意存活或正在生产的 carrier 时，不新增紧急 carrier。
- 紧急 carrier 不再导致任何标准 carrier 队列项被删除。
- 队列顺序稳定满足：紧急 carrier > 标准 carrier > 所有其他 creep。
- 相关 Jest 测试、TypeScript 类型检查和项目构建全部通过。
