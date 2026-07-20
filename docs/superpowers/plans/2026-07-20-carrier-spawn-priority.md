# Carrier 生产优先级与紧急机制解耦实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让紧急 carrier 只负责房间 carrier 归零时的救场，并保证生产顺序严格为“紧急 carrier > 标准 carrier > 所有其他 creep”，同时不再让紧急 carrier 覆盖标准 carrier。

**Architecture:** 保留 `spawnPlanner` 现有紧急生成和队列去重入口，删除紧急 carrier 对标准配置槽位的覆盖层。队列排序通过两个显式优先级区分紧急与标准 carrier，其他角色的相对顺序整体后移但保持不变。

**Tech Stack:** TypeScript 5.9、Screeps Runtime API、Jest 29、ts-jest、Rollup

## Global Constraints

- 紧急 carrier 仅在房间内没有存活 carrier、也没有正在生产的 carrier 时生成。
- 紧急 carrier 与标准 carrier 的配置、补充和生命周期互不覆盖。
- 紧急 carrier 的生产优先级高于标准 carrier。
- 标准 carrier 的生产优先级高于所有非 carrier creep。
- 标准 carrier 出生后，已有紧急 carrier 继续工作到自然死亡。
- 不改变 carrier 的搬运目标选择、任务优先级或 body 生成策略。
- 不改变非 carrier creep 之间现有的相对生产顺序。
- 不新增 creep role，不对紧急 carrier 执行 `suicide`。

---

## 文件结构

- `src/runtime/spawnPlanner.ts`：移除紧急 carrier 对标准 carrier 的覆盖逻辑，并定义严格的生产优先级。
- `src/runtime/spawnPlanner.test.ts`：以行为测试固定两套 carrier 的独立补充、自然共存和严格队列顺序。
- `docs/superpowers/specs/2026-07-20-carrier-spawn-priority-design.md`：已确认的需求与验收标准，只读参考，不在实施中修改。

### Task 1: 解除紧急 carrier 对标准 carrier 的覆盖

**Files:**
- Modify: `src/runtime/spawnPlanner.test.ts:255-340`
- Modify: `src/runtime/spawnPlanner.ts:645-717`
- Modify: `src/runtime/spawnPlanner.ts:791-808`

**Interfaces:**
- Consumes: `ensureEmergencyCarrier(spawn: StructureSpawn): void` 继续负责归零救场；`queueMissingConfig(...)` 继续负责标准配置的补充。
- Produces: `scheduleSpawnTasks(): void` 不再建立或查询 `emergencyCoveredCarrierConfigs`，每个标准 carrier 配置均独立进入常规补充判断。

- [ ] **Step 1: 把旧覆盖测试改成独立补充的失败测试**

在 `src/runtime/spawnPlanner.test.ts` 中，将 `uses a healthy emergency carrier to cover one queued managed carrier` 替换为：

```ts
it("queues a missing managed carrier while a healthy emergency carrier keeps working", () => {
  const room = createRoom("W1N7");
  const spawn = createSpawn(room);
  const managed = `${room.name}:carrier:0`;
  const suicide = jest.fn();
  Game.rooms[room.name] = room;
  Game.spawns[spawn.name] = spawn;
  Game.creeps.emergencyCarrier = {
    name: "emergencyCarrier",
    room,
    ticksToLive: 1400,
    suicide,
    memory: {
      role: "carrier",
      configName: `${room.name}:manual:maxcarrier:${Game.time - 100}`,
    },
  } as unknown as Creep;
  Memory.data = {
    creepConfigs: {
      [managed]: { role: "carrier", args: [], roomName: room.name },
    },
  } as Memory["data"];

  scheduleSpawnTasks();

  expect(spawn.memory.spawnList).toContain(managed);
  expect(suicide).not.toHaveBeenCalled();
});
```

将 `covers only one managed carrier slot with one emergency carrier` 改名为 `does not let one emergency carrier cover any managed carrier slots`，保留现有场景，并把结尾断言改为：

```ts
const managedQueue = spawn.memory.spawnList!.filter((name) => name.startsWith(`${room.name}:carrier:`));
expect(managedQueue).toEqual([first, second]);
```

- [ ] **Step 2: 运行定向测试并确认按预期失败**

Run:

```bash
npm test -- src/runtime/spawnPlanner.test.ts -t "queues a missing managed carrier|does not let one emergency carrier cover" --runInBand
```

Expected: FAIL。第一个测试中 `spawn.memory.spawnList` 不包含 `W1N7:carrier:0`；第二个测试只保留一个标准 carrier，证明失败来自现有覆盖逻辑。

- [ ] **Step 3: 删除覆盖标准 carrier 的生产逻辑**

从 `src/runtime/spawnPlanner.ts` 删除以下两个只为覆盖机制服务的函数：

```ts
function getEmergencyCarrierConfigName(roomName: string, creepName: string): string | undefined {
  // 删除整个函数。
}

function suppressManagedCarriersCoveredByEmergency(
  roomName: string,
  spawns: StructureSpawn[],
  configs: Record<string, CreepConfig>,
  context: SpawnPlanningContext,
): Set<string> {
  // 删除整个函数。
}
```

在 `scheduleSpawnTasks()` 中删除覆盖集合的构造与跳过分支，使配置遍历直接从 `const configs` 进入房间名判断：

```ts
const configs = getCreepConfigService().list();

for (const [configName, config] of Object.entries(configs)) {
  if (!config.roomName) {
    continue;
  }

  if (initialHarvesterRooms.has(config.roomName)) {
    continue;
  }

  if (config.role === "powerBankHauler") {
    queuePowerBankHaulerConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
    continue;
  }

  queueMissingConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
}
```

不要删除 `CARRIER_PRESPAWN_BUFFER_TICKS`；标准 carrier 的正常预生产仍由 `shouldPreSpawnCarrier()` 使用该常量。

- [ ] **Step 4: 运行紧急 carrier 测试并确认通过**

Run:

```bash
npm test -- src/runtime/spawnPlanner.test.ts -t "spawnPlanner emergency carrier flow" --runInBand
```

Expected: PASS。紧急 carrier 的归零生成、去重、失效队列清理和 inactive Spawn 迁移测试仍通过，两个新独立性测试也通过。

- [ ] **Step 5: 提交独立性修复**

```bash
git add src/runtime/spawnPlanner.ts src/runtime/spawnPlanner.test.ts
git commit -m "fix(spawn): decouple emergency and managed carriers"
```

### Task 2: 固定紧急 carrier 与标准 carrier 的严格生产顺序

**Files:**
- Modify: `src/runtime/spawnPlanner.test.ts:355-405`
- Modify: `src/runtime/spawnPlanner.ts:51-63`

**Interfaces:**
- Consumes: `isEmergencyCarrierConfigName(roomName: string, configName: string): boolean` 判断当前队列项是否为本房间紧急 carrier。
- Produces: `getSpawnConfigPriority(roomName: string, configName: string): number` 返回 `0` 表示紧急 carrier、`1` 表示标准 carrier，其他角色从 `2` 开始并保持既有相对顺序。

- [ ] **Step 1: 扩展战略优先级测试并确认当前实现无法保证顺序**

将 `orders only the source-room carrier ahead of war, then the hub upgrader` 测试改名为 `orders emergency carrier before managed carrier and both before every other creep`。删除该测试中的 `Game.creeps.homeCarrier`，新增紧急配置，并故意把标准 carrier 放在紧急 carrier 前面：

```ts
const emergencyCarrier = `E4N58:manual:maxcarrier:${Game.time}`;
spawn.memory.spawnList = [
  worker,
  miner,
  remoteCarrier,
  hubUpgrader,
  warHealer,
  homeCarrier,
  emergencyCarrier,
];

Memory.data = {
  creepConfigs: {
    [emergencyCarrier]: {
      role: "carrier",
      args: [],
      roomName: room.name,
      body: [CARRY, MOVE],
    },
    [homeCarrier]: { role: "carrier", args: [], roomName: room.name },
    [warHealer]: { role: "healer", args: [], roomName: room.name },
    [hubUpgrader]: { role: "hubUpgrader", args: [], roomName: room.name },
    [remoteCarrier]: { role: "remoteCarrier", args: [], roomName: "E4N59" },
    [miner]: { role: "miner", args: ["source0"], roomName: room.name },
    [worker]: { role: "worker", args: [], roomName: room.name },
  },
} as Memory["data"];

scheduleSpawnTasks();

expect(spawn.memory.spawnList).toEqual([
  emergencyCarrier,
  homeCarrier,
  warHealer,
  hubUpgrader,
  remoteCarrier,
  miner,
  worker,
]);
```

- [ ] **Step 2: 运行优先级测试并确认按预期失败**

Run:

```bash
npm test -- src/runtime/spawnPlanner.test.ts -t "orders emergency carrier before managed carrier" --runInBand
```

Expected: FAIL。当前 `getSpawnConfigPriority()` 给两种本房间 carrier 相同的优先级 `0`，稳定排序会保留 `homeCarrier` 在 `emergencyCarrier` 前面。

- [ ] **Step 3: 实现严格且稳定的优先级**

把 `getSpawnConfigPriority()` 修改为：

```ts
function getSpawnConfigPriority(roomName: string, configName: string): number {
  const config = getCreepConfigService().get(configName);
  if (isEmergencyCarrierConfigName(roomName, configName)) {
    return 0;
  }
  if (config?.role === "carrier" && config.roomName === roomName) {
    return 1;
  }
  if (configName.includes(":war:")) {
    return 2;
  }
  if (config?.role === "hubUpgrader") {
    return 3;
  }
  return 4 + getSpawnRolePriority(config?.role);
}
```

函数声明会被提升，因此可以继续复用文件后部的 `isEmergencyCarrierConfigName()`，无需移动函数或新增导出。`prioritizeSpawnQueue()` 现有的稳定排序不变。

- [ ] **Step 4: 运行定向测试、全量测试、类型检查和构建**

Run:

```bash
npm test -- src/runtime/spawnPlanner.test.ts --runInBand
npm test -- --runInBand
npx tsc --noEmit
npm run build
```

Expected: 四条命令全部以退出码 `0` 完成；Jest 无失败用例，TypeScript 无诊断，Rollup 成功生成 `dist/main.js`。

- [ ] **Step 5: 检查最终差异只包含计划范围**

Run:

```bash
git diff --check
git status --short
git diff -- src/runtime/spawnPlanner.ts src/runtime/spawnPlanner.test.ts
```

Expected: `git diff --check` 无输出；状态只包含计划文档和两个实现文件；代码差异不涉及 carrier 搬运任务、body、其他角色或主循环阶段。

- [ ] **Step 6: 提交优先级修复**

```bash
git add src/runtime/spawnPlanner.ts src/runtime/spawnPlanner.test.ts docs/superpowers/plans/2026-07-20-carrier-spawn-priority.md
git commit -m "fix(spawn): prioritize emergency carriers"
```
