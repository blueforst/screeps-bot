# 外矿 Worker 道路施工设计

## 目标

让每个活跃外矿的 `remoteWorker` 在已有的源点 container 工作之外，能够建造该外矿道路规划生成的道路施工位点。

E8N58 是首个目标：实时状态中已有 `roadPlan` 和道路施工位点，但 worker 的生成条件与执行逻辑只识别 source container，因此不会生成 worker 来施工道路。

## 范围

- 仅建造当前外矿任务 `roadPlan.positions` 内、位于目标房间且属于我的 `STRUCTURE_ROAD` 施工位点。
- 不把外矿 worker 扩展为道路维修者。
- 不处理目标房间中不属于该任务道路规划的手动或无关道路施工位点。
- 保留现有的能量来源：源点附近的 container 和掉落能量。

## 设计

### Worker 生成与回收

将 `remoteNeedsContainerWorker` 改为涵盖外矿基础设施工作：

1. 保留现有条件：源点附近 container 耐久低于 30%，或存在我的 container 施工位点。
2. 新增条件：任务 `roadPlan.positions` 对应的我的道路施工位点仍存在。
3. 上述条件都不存在时，移除 worker 配置及其排队条目；已存活 worker 沿用现有 orphan/退休流程。

### Worker 目标优先级

worker 满能且位于目标外矿时，按以下顺序工作：

1. 源点附近的 container 施工位点。
2. 耐久低于 30% 的源点 container，防止采集基础设施失效。
3. 任务道路计划中的道路施工位点，按与 worker 的距离从近到远施工。
4. 其他受损的源点 container。
5. 无工作时返回母房。

施工/维修仍在距离 3 内执行，否则使用现有跨房移动逻辑靠近目标。

### 数据边界

道路位点筛选从 `Memory.data.remoteMining[targetRoom].roadPlan.positions` 建立位置集合，再同当前房间的己方道路施工位点取交集。这保证 worker 不会接管同房间无关道路。

## 测试与验证

- 角色测试：道路施工位点命中计划时，worker 调用 `build`；不在计划中的道路位点被忽略。
- 优先级测试：container 施工和低耐久 container 维修优先于道路；道路优先于普通 container 维修。
- 生命周期测试：存在计划内道路施工位点时创建 worker 配置；全部完成时移除配置。
- 运行 `npx tsc --noEmit`、相关 Jest 测试、完整 Jest 测试、构建。
- 部署后读取 shard1 的部署标签、E8N58 worker 配置/creep 与道路施工位点，确认 worker 被创建且道路位点进度开始增长。
