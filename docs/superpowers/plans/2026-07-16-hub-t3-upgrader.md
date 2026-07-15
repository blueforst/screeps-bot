# Hub T3 Upgrader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 RCL7 Hub 自动维持一只 15 WORK 的 XGH2O 强化专用 upgrader，并在 RCL8 后自动停产和释放 boost 资源。

**Architecture:** 新增独立的 `hubUpgradeControl` 维护固定配置和共享 boost 任务；新增 `hubUpgrader` 角色只从控制器附近 link/container 取能并升级控制器。复用现有 `powerBankBoost` lab 准备设施和 spawn planner，不进入普通 worker 任务池。

**Tech Stack:** TypeScript、Screeps API、Jest、现有 runtime service / carrier task / boost 基础设施、Rollup。

## Global Constraints

- Hub 来源只能是 `Memory.cfg.hub.hubRoomName`。
- 仅在己方 RCL7 房间维持恰好 1 只；RCL8、失去房间或 Hub 停用时停止补产。
- 固定身体必须是 `15 WORK + 5 CARRY + 10 MOVE`，单只 2250 energy。
- 单只 boost 需求为 450 XGH2O；使用一个 boost task 和一个 lab。
- Spawn 实际优先级必须保持：母房 carrier > 战争 creep > Hub T3 upgrader > 非关键普通生产；等待战争 creep 时 Hub upgrader 不得抢 energy。
- 不修改普通 worker 数量和任务池逻辑。
- 所有生产代码必须先有能够正确失败的测试。

---

### Task 1: 注册专用角色、固定身体与 WORK boost 支持

**Files:**
- Modify: `src/types/system.ts`
- Modify: `src/config/spawnProfiles.ts`
- Modify: `src/roles/index.ts`
- Modify: `src/roles/combatBoosts.ts`
- Test: `src/roles/combatBoosts.test.ts`

**Interfaces:**
- Produces: `RoleName` 新成员 `hubUpgrader`。
- Produces: `spawnProfiles.hubUpgrader(room): BodyPartConstant[]`。
- Produces: `prepareCombatBoost` 能识别 `RESOURCE_CATALYZED_GHODIUM_ACID -> WORK`。
- Consumes: 现有 `getAssignedPowerBankBoostLabId` 和 `lab.boostCreep`。

- [ ] **Step 1: 写 WORK boost 的失败测试**

在 `src/roles/combatBoosts.test.ts` 增加测试，构造带一个未强化 WORK 的 creep，调用：

```ts
prepareCombatBoost(
  creep,
  "hubUpgrade:E4N58",
  RESOURCE_CATALYZED_GHODIUM_ACID,
);

expect(lab.boostCreep).toHaveBeenCalledWith(creep);
```

- [ ] **Step 2: 运行测试并确认因 WORK compound 未注册而失败**

Run: `npm test -- --runInBand src/roles/combatBoosts.test.ts`

Expected: FAIL，`lab.boostCreep` 调用次数为 0。

- [ ] **Step 3: 最小实现角色类型、固定身体和 boost 映射**

在 `RoleName` 加入：

```ts
| "hubUpgrader"
```

在 `spawnProfiles` 加入固定生成器：

```ts
const HUB_T3_UPGRADER_BODY: BodyPartConstant[] = [
  ...Array(15).fill(WORK),
  ...Array(5).fill(CARRY),
  ...Array(10).fill(MOVE),
];

hubUpgrader: () => [...HUB_T3_UPGRADER_BODY],
```

在 `BOOSTED_PARTS` 加入：

```ts
[RESOURCE_CATALYZED_GHODIUM_ACID]: WORK,
```

先在 `roleRegistry` 用稍后新增的 `hubUpgraderRole` 注册；如果类型检查要求文件存在，与 Task 2 的首个测试一并创建最小导出，不写角色行为。

- [ ] **Step 4: 运行目标测试和类型检查**

Run:

```bash
npm test -- --runInBand src/roles/combatBoosts.test.ts
npx tsc --noEmit
```

Expected: 目标测试 PASS；类型检查 PASS。

- [ ] **Step 5: 提交基础类型和 boost 支持**

```bash
git add src/types/system.ts src/config/spawnProfiles.ts src/roles/index.ts src/roles/combatBoosts.ts src/roles/combatBoosts.test.ts
git commit -m "feat(hub): register T3 upgrader role"
```

---

### Task 2: 实现 Hub 升级配置和共享 boost 生命周期

**Files:**
- Create: `src/runtime/hubUpgradeControl.ts`
- Create: `src/runtime/hubUpgradeControl.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `HUB_UPGRADER_COUNT = 1`。
- Produces: `HUB_UPGRADER_BODY: readonly BodyPartConstant[]`。
- Produces: `runHubUpgradeControl(): void`。
- Consumes: `prepareBoosts(taskId, roomName, 0, requiredAmounts, { requireLabEnergy: true })`。
- Consumes: `releaseBoostLabs(taskId, roomName)`、`getPowerBankBoostPrep(taskId)`、runtime creep config service 和 tick context。

- [ ] **Step 1: 写 RCL7 配置创建的失败测试**

建立 Hub 房间 mock，令控制器 `my=true, level=7`，调用 `runHubUpgradeControl()` 后断言：

```ts
expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toEqual({
  role: "hubUpgrader",
  args: ["E4N58", "hubUpgrade:E4N58"],
  roomName: "E4N58",
  body: HUB_UPGRADER_BODY,
});
expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:1"]).toBeUndefined();
```

- [ ] **Step 2: 运行测试并确认模块不存在或配置未创建**

Run: `npm test -- --runInBand src/runtime/hubUpgradeControl.test.ts`

Expected: FAIL，原因是 `runHubUpgradeControl` 尚不存在或没有创建唯一配置。

- [ ] **Step 3: 写最小配置协调器使测试通过**

实现常量和固定配置写入：

```ts
export const HUB_UPGRADER_COUNT = 1;
export const HUB_UPGRADER_BODY: BodyPartConstant[] = [
  ...Array(15).fill(WORK),
  ...Array(5).fill(CARRY),
  ...Array(10).fill(MOVE),
];

function getConfigName(roomName: string, index: number): string {
  return `${roomName}:hubUpgrader:${index}`;
}
```

只在已启用、可见、己方 RCL7 Hub 写入一个配置，并退役旧配置对应的存量 creep。

- [ ] **Step 4: 运行目标测试确认 GREEN**

Run: `npm test -- --runInBand src/runtime/hubUpgradeControl.test.ts`

Expected: PASS。

- [ ] **Step 5: 写 cleanup 和 boost 需求的失败测试**

分别覆盖：

```ts
it("removes configs and queued entries at RCL8", ...);
it("requests 450 XGH2O for the missing upgrader", ...);
it("releases the shared boost lab when the upgrader is fully boosted", ...);
it("retires a stale second upgrader", ...);
it("keeps retrying when boost labs are temporarily unavailable", ...);
```

对 `prepareBoosts` mock 的关键断言：

```ts
expect(prepareBoosts).toHaveBeenCalledWith(
  "hubUpgrade:E4N58",
  "E4N58",
  0,
  new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]),
  { requireLabEnergy: true },
);
```

- [ ] **Step 6: 运行测试并确认各行为缺失导致失败**

Run: `npm test -- --runInBand src/runtime/hubUpgradeControl.test.ts`

Expected: FAIL，分别显示残留配置、需求量不正确或未释放 lab。

- [ ] **Step 7: 实现 cleanup、剩余 WORK 统计和共享 boost 协调**

核心计算：

```ts
function countRemainingWorkParts(configName: string): number {
  const creep = getTickContextService().getCreepsByConfigName(configName)[0];
  if (!creep) return 15;
  return creep.body.filter((part) =>
    part.type === WORK &&
    part.hits > 0 &&
    part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID
  ).length;
}
```

总剩余量大于 0 时调用 `prepareBoosts`；等于 0 且共享 prep 存在时调用 `releaseBoostLabs`。Cleanup 必须扫描所有 `role === "hubUpgrader"` 配置，从所有 spawn queue 移除后删除配置，并按配置房间释放遗留共享 boost task。

- [ ] **Step 8: 在主循环中接入控制器**

在 `runHubPlanner` 之后、`runSynthesisControl` 之前调用：

```ts
cpuProfiler.measure("hubUpgradeControl", runHubUpgradeControl);
```

这样 boost pause 在同 tick 的 synthesis 执行前生效。

- [ ] **Step 9: 运行目标测试和主循环测试**

Run:

```bash
npm test -- --runInBand src/runtime/hubUpgradeControl.test.ts src/main.test.ts
npx tsc --noEmit
```

Expected: 全部 PASS。

- [ ] **Step 10: 提交 Hub 协调器**

```bash
git add src/runtime/hubUpgradeControl.ts src/runtime/hubUpgradeControl.test.ts src/main.ts
git commit -m "feat(hub): coordinate T3 upgrader production"
```

---

### Task 3: 实现专用 upgrader 取能和升级行为

**Files:**
- Create: `src/roles/hubUpgrader.ts`
- Create: `src/roles/hubUpgrader.test.ts`
- Modify: `src/roles/index.ts`

**Interfaces:**
- Produces: `hubUpgraderRole(roomName?: string, boostTaskId?: string): RoleLifecycle`。
- Consumes: `prepareCombatBoost(creep, boostTaskId, RESOURCE_CATALYZED_GHODIUM_ACID)`。
- Consumes: `moveToTarget` 和 Screeps `withdraw` / `upgradeController`。

- [ ] **Step 1: 写角色行为失败测试**

覆盖以下独立行为：

```ts
it("waits for XGH2O boost in prepare", ...);
it("withdraws from a controller-adjacent link before a container", ...);
it("falls back to a controller-adjacent container", ...);
it("does not use storage or terminal as an energy source", ...);
it("upgrades only the configured owned RCL7 controller", ...);
it("stops acting after the controller reaches RCL8", ...);
```

关键断言：

```ts
expect(creep.withdraw).toHaveBeenCalledWith(controllerLink, RESOURCE_ENERGY);
expect(creep.upgradeController).toHaveBeenCalledWith(room.controller);
```

- [ ] **Step 2: 运行测试并确认角色模块或行为缺失**

Run: `npm test -- --runInBand src/roles/hubUpgrader.test.ts`

Expected: FAIL。

- [ ] **Step 3: 最小实现角色**

能源候选只允许控制器 3 格内的 link/container，先按结构类型、再按距离排序：

```ts
const sources = room.find(FIND_STRUCTURES, {
  filter: (structure) =>
    (structure.structureType === STRUCTURE_LINK ||
      structure.structureType === STRUCTURE_CONTAINER) &&
    structure.pos.getRangeTo(controller.pos) <= 3 &&
    structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
});
```

`source` 在无能量源时返回 `false` 并移动到控制器附近；`target` 只对配置房间内己方 RCL7 controller 升级，能量为 0 时返回 `true`。

- [ ] **Step 4: 运行角色测试确认 GREEN**

Run: `npm test -- --runInBand src/roles/hubUpgrader.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交角色实现**

```bash
git add src/roles/hubUpgrader.ts src/roles/hubUpgrader.test.ts src/roles/index.ts
git commit -m "feat(hub): add dedicated T3 upgrader behavior"
```

---

### Task 4: 固化 spawn 优先级与战争让能规则

**Files:**
- Modify: `src/runtime/spawnPlanner.ts`
- Modify: `src/runtime/spawnPlanner.test.ts`
- Modify: `src/mount/mountSpawn.test.ts`

**Interfaces:**
- Consumes: `CreepConfig.role === "hubUpgrader"` 和配置名中的 `:war:` 标识。
- Produces: `getSpawnConfigPriority(roomName, configName)`，能区分母房 carrier 与其他 carrier。
- Preserves: 另一 spawn 队首存在可生产战争配置时，非母房 carrier 的当前生产必须让出 room energy。

- [ ] **Step 1: 写队列排序失败测试**

构造同一 spawn queue 中的母房 carrier、战争、Hub upgrader、remote carrier、采矿和普通 worker 配置，调用 `scheduleSpawnTasks()` 后断言：

```ts
expect(spawn.memory.spawnList).toEqual([
  "E4N58:carrier:0",
  "E4N58:war:E5N58:g1:healer:0",
  "E4N58:hubUpgrader:0",
  "E4N58:remoteMine:E4N59:carrier:0",
  "E4N58:miner:source0",
  "E4N58:worker:0",
]);
```

另加入同角色但 `config.roomName !== spawn.room.name` 的 carrier，证明只有母房 carrier 能排在战争单位之前。

- [ ] **Step 2: 运行测试并确认 Hub upgrader 与普通生产未区分而失败**

Run: `npm test -- --runInBand src/runtime/spawnPlanner.test.ts`

Expected: FAIL，现有 role-only 排序会把 remote carrier、采矿或 power-bank 单位排在战争配置之前。

- [ ] **Step 3: 调整角色优先级**

把 role-only 排序改为 config-aware 排序。优先级前缀必须是：

```ts
function getSpawnConfigPriority(roomName: string, configName: string): number {
  const config = getCreepConfigService().get(configName);
  if (config?.role === "carrier" && config.roomName === roomName) return 0;
  if (configName.includes(":war:")) return 1;
  if (config?.role === "hubUpgrader") return 2;
  return 3 + getNonWarRolePriority(config?.role);
}
```

`getNonWarRolePriority` 保留现有非战争单位之间的相对顺序，但不再允许 remote carrier、采矿、power-bank 或其他 melee/healer 越过战争配置。`prioritizeSpawnQueue` 的所有比较都必须传入 `spawn.room.name` 和配置名。跨 spawn 的战争 energy 门控继续确保另一 spawn 也不会在战争配置等待时开产。

- [ ] **Step 4: 增加跨 spawn energy 门控回归测试**

在 `mountSpawn.test.ts` 新增 Hub upgrader 场景：另一 spawn 队首是战争 healer 时，`hubUpgrader` 不调用 `spawnCreep`；战争队列消失后允许调用。

- [ ] **Step 5: 运行两组目标测试**

Run:

```bash
npm test -- --runInBand src/runtime/spawnPlanner.test.ts src/mount/mountSpawn.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交优先级规则**

```bash
git add src/runtime/spawnPlanner.ts src/runtime/spawnPlanner.test.ts src/mount/mountSpawn.test.ts
git commit -m "fix(spawn): place hub upgraders below war"
```

---

### Task 5: 全量验证、部署与在线验收

**Files:**
- Verify: all modified source and test files
- Runtime evidence: shard1 `Memory.runtime.lastDeployTag`、Hub creep configs、spawn queues、boost lab、controller progress

**Interfaces:**
- Consumes: Tasks 1–4 的全部实现。
- Produces: 可回滚的 Git commits 和已验证的 Screeps live deploy。

- [ ] **Step 1: 运行全量验证**

```bash
npm test -- --runInBand
npx tsc --noEmit
npm run build
git diff --check
```

Expected: 所有 Jest suites/tests PASS、TypeScript PASS、Rollup build PASS、diff check 无输出。

- [ ] **Step 2: 检查提交范围和工作树**

```bash
git status --short
git log -6 --oneline
```

Expected: 只有本功能相关提交；无未提交源代码。

- [ ] **Step 3: 部署到 Screeps**

Run: `npm run push`

Expected: `Uploaded 1 module(s) to Screeps branch default.`

- [ ] **Step 4: 验证线上版本和 Hub 配置**

等待约 4 tick 后检查：

```text
Memory.runtime.lastDeployTag 包含最新 commit hash
仅 E4N58:hubUpgrader:0 配置存在
配置 body 为 15 WORK + 5 CARRY + 10 MOVE
战争配置等待时 Hub upgrader 不消耗 spawn energy
共享 boost task 只占用一个 XGH2O lab
```

- [ ] **Step 5: 验证 creep 行为和 RCL 进度**

creep 出生后确认：

```text
15 个 WORK 均带 XGH2O boost
从控制器附近 link/container 取能
控制器进度持续增长，目标约 30 progress/tick
```

若线上出现任何逻辑错误，先写失败回归测试，再在 `main` 修复、重新执行全量验证并部署。
