# 外矿 Worker 道路施工 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让活跃外矿的 remoteWorker 建造其 `roadPlan` 内的道路施工位点，同时保持 container 施工和紧急维修优先。

**Architecture:** `remoteWorker` 从 `Memory.data.remoteMining[targetRoom].roadPlan.positions` 建立允许的位置集合，只选择该集合内的己方道路施工位点。`remoteMining` 生命周期将计划内道路施工位点纳入 worker 的生成条件；角色端按 container 施工、紧急 container 维修、道路施工、普通 container 维修的顺序执行。

**Tech Stack:** TypeScript、Jest、Screeps API mock、Rollup。

## Global Constraints

- 只处理当前外矿任务 `roadPlan.positions` 内、目标房间的己方 `STRUCTURE_ROAD` 施工位点。
- 不新增道路维修行为，也不接管无关或手动道路施工位点。
- 沿用远程 worker 从源点附近 container/掉落能量补能的机制。
- 所有生产逻辑变更必须先有失败的 Jest 回归测试。
- 部署后以 shard1 的部署标签和 E8N58 实时任务/施工位点验证结果为准。

---

### Task 1: 让 remoteWorker 识别并施工计划内道路

**Files:**
- Modify: `src/roles/remoteWorker.ts:54-69, 102-167`
- Modify: `src/roles/remoteWorker.test.ts:390-472, 476-569, 618-648`

**Interfaces:**
- Consumes: `Memory.data.remoteMining[targetRoom].roadPlan.positions`（`{ x, y, roomName }[]`）。
- Produces: `findPlannedRoadSitesInRoom(room, targetRoom): ConstructionSite[]`，只返回己方、计划内的道路位点。

- [ ] **Step 1: 写道路施工的失败角色测试**

在 `src/roles/remoteWorker.test.ts` 中，将测试任务的 `roadPlan` 设置为包含 `(24, 25, TARGET_ROOM)`；创建一个该位置的道路位点和一个不在计划内的道路位点。满能 worker 执行 `target` 后，断言只对计划内道路位点调用 `build`：

```ts
expect(creep.build).toHaveBeenCalledWith(plannedRoadSite);
expect(creep.build).not.toHaveBeenCalledWith(unplannedRoadSite);
```

- [ ] **Step 2: 运行测试，确认其因未支持道路而失败**

Run: `npm run test -- src/roles/remoteWorker.test.ts --runInBand`

Expected: FAIL，`creep.build` 没有接收到计划内道路位点。

- [ ] **Step 3: 写优先级的失败角色测试**

添加两个独立测试：

```ts
expect(creep.build).toHaveBeenCalledWith(containerSite);
expect(creep.build).not.toHaveBeenCalledWith(plannedRoadSite);
```

以及：

```ts
expect(creep.repair).toHaveBeenCalledWith(criticalContainer);
expect(creep.build).not.toHaveBeenCalledWith(plannedRoadSite);
```

其中 `criticalContainer.hits / criticalContainer.hitsMax < 0.30`；另保留现有普通 container 损伤场景，并令其断言计划内道路优先。

- [ ] **Step 4: 运行测试，确认优先级测试失败**

Run: `npm run test -- src/roles/remoteWorker.test.ts --runInBand`

Expected: FAIL，道路尚未进入目标选择或优先级与预期不一致。

- [ ] **Step 5: 实现最小角色逻辑**

在 `src/roles/remoteWorker.ts` 新增计划位置键和筛选函数：

```ts
function findPlannedRoadSitesInRoom(room: Room, targetRoom: string): ConstructionSite[] {
  const planned = Memory.data?.remoteMining?.[targetRoom]?.roadPlan?.positions ?? [];
  const keys = new Set(planned.map(p => `${p.roomName}:${p.x}:${p.y}`));
  return room.find(FIND_CONSTRUCTION_SITES, {
    filter: (site): site is ConstructionSite =>
      site.my &&
      site.structureType === STRUCTURE_ROAD &&
      keys.has(`${site.pos.roomName}:${site.pos.x}:${site.pos.y}`),
  });
}
```

在 `target` 中应用以下顺序：container 位点、低于 30% 的 source container、距离最近的计划道路位点、其余受损 source container、回母房。道路和 container 均沿用距离 3 的 build/repair 与 `moveToTarget` 模式。

- [ ] **Step 6: 运行角色测试，确认通过**

Run: `npm run test -- src/roles/remoteWorker.test.ts --runInBand`

Expected: PASS，包含计划内道路、排除计划外道路和三层优先级断言。

- [ ] **Step 7: 提交角色改动**

```bash
git add src/roles/remoteWorker.ts src/roles/remoteWorker.test.ts
git commit -m "feat(remote-worker): build planned remote roads"
```

### Task 2: 道路施工位点驱动 worker 生命周期

**Files:**
- Modify: `src/runtime/remoteMining.ts:1135-1163, 1479-1483`
- Modify: `src/runtime/remoteMining.test.ts`（`remote worker lifecycle` 测试组）

**Interfaces:**
- Consumes: 活跃 `RemoteMiningTask.roadPlan.positions` 和目标房间的 `FIND_CONSTRUCTION_SITES`。
- Produces: `remoteNeedsInfrastructureWorker(task): boolean`，在 container 工作或计划内道路施工位点存在时返回 `true`。

- [ ] **Step 1: 写生命周期失败测试**

在 `remote worker lifecycle` 组中创建活跃外矿任务，其 containers 健康且无 container 位点，但任务 `roadPlan.positions` 含 `(20, 20, "W1N0")`，目标房间存在同位置的己方道路位点。执行 `processRemoteConfigLifecycle` 后断言：

```ts
expect(Memory.data!.creepConfigs![getRemoteWorkerConfigName("W1N1", "W1N0")]).toBeDefined();
```

再添加计划位置不匹配的道路位点与“道路位点消失”场景，断言不创建或移除 worker 配置。

- [ ] **Step 2: 运行生命周期测试，确认失败**

Run: `npm run test -- src/runtime/remoteMining.test.ts --runInBand`

Expected: FAIL，健康 container 且没有 container 位点时当前实现移除了 worker 配置。

- [ ] **Step 3: 实现最小生命周期逻辑**

把 `remoteNeedsContainerWorker` 重命名为 `remoteNeedsInfrastructureWorker`，保留已有 container 判定，并在返回 `false` 前检查：

```ts
const plannedRoadKeys = new Set((task.roadPlan?.positions ?? [])
  .filter(pos => pos.roomName === task.targetRoom)
  .map(pos => `${pos.x}:${pos.y}`));
return targetRoom.find(FIND_CONSTRUCTION_SITES).some(site =>
  site.my &&
  site.structureType === STRUCTURE_ROAD &&
  plannedRoadKeys.has(`${site.pos.x}:${site.pos.y}`),
);
```

将生命周期调用替换为新函数；不改变每个外矿最多一个 worker 的配置模型。

- [ ] **Step 4: 运行生命周期测试，确认通过**

Run: `npm run test -- src/runtime/remoteMining.test.ts --runInBand`

Expected: PASS，计划内道路会生成 worker，计划外/消失道路不会维持 worker。

- [ ] **Step 5: 提交生命周期改动**

```bash
git add src/runtime/remoteMining.ts src/runtime/remoteMining.test.ts
git commit -m "feat(remote-mining): staff planned road construction"
```

### Task 3: 全量验证与游戏部署

**Files:**
- No source changes expected.

**Interfaces:**
- Verifies: branch `codex/e8n58-remote-path-budget` 的已提交代码与 shard1 运行状态。

- [ ] **Step 1: 执行静态检查、构建与完整测试**

```bash
npx tsc --noEmit
npm run build
npm run test -- --runInBand
git diff --check
```

Expected: 四项命令均成功；Jest 完整套件无失败。

- [ ] **Step 2: 部署到游戏**

```bash
npm run push
npm run monitor:once
```

Expected: 上传到 Screeps `default` 分支；monitor 选中 shard1，且 `runtime.lastDeployTag` 包含最新提交短 SHA。

- [ ] **Step 3: 读取 E8N58 的实时结果**

通过项目现有只读 Memory/room-objects API 查询 `data.remoteMining.E8N58`、对应 remoteWorker 配置和 E8N58 道路施工位点。确认任务保持 active、计划内道路位点存在、worker 配置已创建或已有对应 creep，且道路施工进度开始变化。

- [ ] **Step 4: 记录最终提交与部署证据**

```bash
git status --short
git log --oneline -5
```

Expected: 只保留实施前已存在的未跟踪文件；本次代码与测试均已提交，最终回复报告实际 deploy tag 和 E8N58 道路施工状态。
