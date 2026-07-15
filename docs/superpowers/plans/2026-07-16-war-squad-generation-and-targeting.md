# 战争双人小队代次与目标优先级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用显式代次和单向强化闸门可靠生产连续 T3 双人小队，并让攻击者按战术价值清理目标而不是追逐无害 creep 或绕行拆残余墙。

**Architecture:** `warControl.ts` 继续负责战争任务编排，但为每个 T3 任务持久化一个活动代次，使用代次专属配置名和强化任务 ID。共享强化准备增加战争专用的实验室能量检查选项；角色层只增加 detached 编队语义和目标优先级，不改变普通近战、Power Bank 或防御流程。

**Tech Stack:** TypeScript、Screeps MMO API、Jest、Rollup、项目现有 Memory/runtime service 与 carrier task board。

## Global Constraints

- 所有新增文档和测试说明使用中文。
- 不改变 T3 攻击者、治疗者身体与强化配方。
- `oneShot: true` 保持每个槽位只排队一次，不创建下一代。
- 只有战争调用开启实验室完整能量检查，Power Bank 现有状态转换保持不变。
- 已排队、生产中或存活的已放行代次不得因库存波动被删除。
- 出发后破组创建完整下一代，旧代幸存者继续行动但不与新代固定配对。
- wall/rampart 只在阻挡更高优先目标或只剩残余 rampart 时成为主动目标。
- 部署目标为 Screeps `default` 分支；本地 Git 工作在 `main`。
- 实时验收覆盖 E3N57、E2N54、E3N53 与 W2N58。

---

### Task 1: 战争强化实验室能量门槛

**Files:**
- Modify: `src/runtime/powerBankBoost.ts`
- Modify: `src/runtime/powerBankBoost.test.ts`
- Modify: `src/roles/combatBoosts.ts`
- Create: `src/roles/combatBoosts.test.ts`

**Interfaces:**
- Consumes: 现有 `prepareBoosts(taskId, sourceRoomName, tier, requiredAmountsOverride)`、`checkBoostReadiness(taskId, requiredCompounds, requiredAmounts)` 与 carrier task board。
- Produces: `BoostPrepOptions { requireLabEnergy?: boolean }`；两个共享函数新增末尾 `options?: BoostPrepOptions` 参数，默认不检查整批实验室能量。

- [ ] **Step 1: 写实验室能量 readiness 失败测试**

先把测试 helper 扩展为可设置 lab energy：

```ts
function createLabWithCompound(
  id: string,
  roomName: string,
  compound: ResourceConstant | null,
  amount: number,
  energy = 0,
): StructureLab {
  const storeResources: Record<string, number> = { [RESOURCE_ENERGY]: energy };
  if (compound && amount > 0) storeResources[compound] = amount;
  return {
    id: id as Id<StructureLab>,
    pos: new MockPos(20, 20, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_LAB as StructureConstant,
    mineralType: compound as MineralConstant | null,
    mineralAmount: amount,
    cooldown: 0,
    store: createMockStore(storeResources),
    boostCreep: jest.fn(() => OK),
    runReaction: jest.fn(() => OK),
  } as unknown as StructureLab;
}
```

然后在 `src/runtime/powerBankBoost.test.ts` 的 `checkBoostReadiness` 分组加入：

```ts
it("requires the full lab energy budget only when requested by war prep", () => {
  const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
  const required = new Map<ResourceConstant, number>([[compound, 60]]);
  const lab = createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, compound, 60, 0);
  Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab] });
  ensurePowerBankBoostPrepStore()[TASK_ID] = {
    taskId: TASK_ID,
    sourceRoomName: SOURCE_ROOM,
    labs: { [lab.id]: { labId: lab.id, compound } },
  };
  Game.getObjectById = jest.fn(() => lab) as typeof Game.getObjectById;

  expect(checkBoostReadiness(TASK_ID, [compound], required)).toBe(true);
  expect(checkBoostReadiness(TASK_ID, [compound], required, { requireLabEnergy: true })).toBe(false);
});
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run: `npm test -- --runInBand src/runtime/powerBankBoost.test.ts`

Expected: TypeScript/Jest 因 `checkBoostReadiness` 尚不接受第四个 options 参数而失败，或能量断言得到 true。

- [ ] **Step 3: 实现可选能量检查和能量搬运草案**

在 `src/runtime/powerBankBoost.ts` 增加并贯穿调用：

```ts
export interface BoostPrepOptions {
  requireLabEnergy?: boolean;
}

function getRequiredLabEnergy(mineralAmount: number): number {
  return Math.ceil(mineralAmount / LAB_BOOST_MINERAL) * LAB_BOOST_ENERGY;
}
```

将函数签名改为：

```ts
export function prepareBoosts(
  taskId: string,
  sourceRoomName: string,
  tier: number,
  requiredAmountsOverride?: ReadonlyMap<ResourceConstant, number>,
  options: BoostPrepOptions = {},
): BoostPrepResult;

export function checkBoostReadiness(
  taskId: string,
  requiredCompounds: ResourceConstant[],
  requiredAmounts?: ReadonlyMap<ResourceConstant, number>,
  options: BoostPrepOptions = {},
): boolean;
```

每个 compound/lab 的矿物搬运草案生成后，在 `options.requireLabEnergy` 为 true 时计算 `requiredEnergy`，从来源房 storage/terminal 创建独立的 `lab_supply` 草案：

```ts
const requiredEnergy = getRequiredLabEnergy(needed);
const energyDeficit = Math.max(0, requiredEnergy - lab.store.getUsedCapacity(RESOURCE_ENERGY));
if (energyDeficit > 0) {
  const energySource = resolveBoostSupplySource(room, RESOURCE_ENERGY);
  const transferAmount = Math.min(
    energyDeficit,
    energySource?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0,
    lab.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0,
  );
  if (!energySource || transferAmount < energyDeficit) {
    return { status: "failed", reason: "insufficient_lab_energy", labs: labs.map((item) => item.id) };
  }
  drafts.push({
    id: `powerBankBoost:lab_energy:${taskId}:${lab.id}`,
    type: "lab_supply",
    priority: BOOST_LAB_SUPPLY_PRIORITY,
    steps: [{
      id: `${RESOURCE_ENERGY}:${energySource.id}->${lab.id}`,
      resource: RESOURCE_ENERGY,
      fromKind: energySource.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
      toKind: "lab",
      fromId: energySource.id,
      toId: lab.id,
      amount: transferAmount,
    }],
  });
}
```

`checkBoostReadiness` 在选项开启时加入：

```ts
if (options.requireLabEnergy) {
  const requiredEnergy = getRequiredLabEnergy(requiredAmount);
  if (lab.store.getUsedCapacity(RESOURCE_ENERGY) < requiredEnergy) return false;
}
```

- [ ] **Step 4: 补充能量搬运 GREEN 测试**

在 `prepareBoosts` 本地库存分组加入 storage 有矿物和 energy、lab 无 energy 的测试，断言 carrier task 同时包含 compound 和 `RESOURCE_ENERGY`；把 lab energy 补足后再次调用并断言 ready。运行：

Run: `npm test -- --runInBand src/runtime/powerBankBoost.test.ts`

Expected: PASS，既有未传 options 的 Power Bank 测试保持原行为。

- [ ] **Step 5: 写角色单次强化缺能量失败测试并确认 RED**

创建 `src/roles/combatBoosts.test.ts`，mock `getAssignedPowerBankBoostLabId`，构造矿物 30、energy 0 的 lab，调用：

```ts
const ready = prepareCombatBoost(
  creep,
  "war:E1N57:E2N54:g1",
  RESOURCE_CATALYZED_UTRIUM_ACID,
);
expect(ready).toBe(false);
expect(lab.boostCreep).not.toHaveBeenCalled();
```

Run: `npm test -- --runInBand src/roles/combatBoosts.test.ts`

Expected: FAIL，因为当前代码只检查矿物并调用 `boostCreep`。

- [ ] **Step 6: 在发出强化意图前检查单次能量并确认 GREEN**

在 `prepareCombatBoost` 的矿物检查后加入：

```ts
if (lab.store.getUsedCapacity(RESOURCE_ENERGY) < LAB_BOOST_ENERGY) return false;
```

再增加 energy 20 时调用 `boostCreep` 的测试。

Run: `npm test -- --runInBand src/roles/combatBoosts.test.ts src/runtime/powerBankBoost.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交实验室能量门槛**

```bash
git add src/runtime/powerBankBoost.ts src/runtime/powerBankBoost.test.ts src/roles/combatBoosts.ts src/roles/combatBoosts.test.ts
git commit -m "fix(war): require boost lab energy before squad release"
```

### Task 2: 活动代次、旧任务迁移与初始强化闸门

**Files:**
- Modify: `src/runtime/warControl.ts`
- Modify: `src/runtime/warControl.test.ts`
- Modify: `src/global.d.ts`

**Interfaces:**
- Consumes: Task 1 的 `BoostPrepOptions` 与现有战争配置/队列工具。
- Produces: `WarGenerationState`、代次专属 config/boost ID、惰性旧状态迁移、`preparing -> assembling` 单向闸门。

- [ ] **Step 1: 写空旧任务迁移和初始门槛测试**

先把 `src/runtime/warControl.test.ts` 的 lab helper 改为接受 energy，并增加一个完整的来源房 helper：

```ts
function createBoostLab(
  id: string,
  compound: ResourceConstant,
  amount: number,
  energy = 2_000,
): StructureLab {
  return {
    id: id as Id<StructureLab>,
    pos: new MockPos(20, 20, "E1N57") as unknown as RoomPosition,
    room: { name: "E1N57" } as Room,
    structureType: STRUCTURE_LAB,
    mineralType: compound as MineralConstant,
    mineralAmount: amount,
    store: createMockStore({ [compound]: amount, [RESOURCE_ENERGY]: energy }),
    boostCreep: jest.fn(() => OK),
  } as unknown as StructureLab;
}

function setupWarBoostRoom(attackAmount = 900): { spawn: StructureSpawn; labs: StructureLab[] } {
  const labs = [
    createBoostLab("lab-tough", RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 600),
    createBoostLab("lab-attack", RESOURCE_CATALYZED_UTRIUM_ACID, attackAmount),
    createBoostLab("lab-heal", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 600),
    createBoostLab("lab-move", RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, 540),
  ];
  const sourceRoom = createSourceRoom(labs);
  const spawn = createSpawn(sourceRoom);
  Game.rooms.E1N57 = sourceRoom;
  Game.spawns.Spawn1 = spawn;
  Game.getObjectById = jest.fn((id: string) => labs.find((lab) => lab.id === id) ?? null) as typeof Game.getObjectById;
  return { spawn, labs };
}
```

替换旧的“资源准备时删除 replacement 配置”断言，新增两个测试：

```ts
it("migrates an empty legacy T3 task into generation one without queuing before boosts are ready", () => {
  setupWarBoostRoom(0);
  runWarControl();
  const task = Memory.data!.war!.E3N57;
  expect(task.activeGeneration).toMatchObject({ id: 1, phase: "preparing" });
  expect(task.activeGeneration?.boostGateOpenedAt).toBeUndefined();
  expect(Game.spawns.Spawn1.memory.spawnList).toEqual([]);
});

it("opens generation one once and queues generation-scoped configs", () => {
  const { spawn } = setupWarBoostRoom();
  runWarControl();
  const task = Memory.data!.war!.E3N57;
  expect(task.activeGeneration).toMatchObject({ id: 1, phase: "assembling" });
  expect(task.activeGeneration?.boostGateOpenedAt).toBe(Game.time);
  expect(spawn.memory.spawnList).toEqual(expect.arrayContaining([
    "E1N57:war:E3N57:g1:meleeAttacker:0",
    "E1N57:war:E3N57:g1:healer:0",
  ]));
});
```

- [ ] **Step 2: 运行 warControl 测试并确认 RED**

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: FAIL，Memory 中没有 `activeGeneration`，配置名仍为旧格式。

- [ ] **Step 3: 增加 Memory 类型和代次命名函数**

在 `src/runtime/warControl.ts` 与 `src/global.d.ts` 对应 Memory 结构中加入：

```ts
type WarGenerationPhase = "preparing" | "assembling" | "deployed";
interface WarGenerationState {
  id: number;
  phase: WarGenerationPhase;
  createdAt: number;
  boostTaskId: string;
  boostGateOpenedAt?: number;
  deployedAt?: number;
  configNames: { meleeAttacker: string; healer: string };
}
```

`WarTask` 增加：

```ts
generationCounter?: number;
activeGeneration?: WarGenerationState;
```

新增精确命名函数：

```ts
function getGenerationConfigName(task: WarTask, generationId: number, role: WarRole): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:g${generationId}:${role}:0`;
}
function getGenerationBoostTaskId(task: WarTask, generationId: number): string {
  return `war:${task.sourceRoom}:${task.targetRoom}:g${generationId}`;
}
```

- [ ] **Step 4: 实现惰性迁移与第 1 代创建**

增加：

```ts
function createGeneration(task: WarTask, id: number): WarGenerationState {
  return {
    id,
    phase: "preparing",
    createdAt: Game.time,
    boostTaskId: getGenerationBoostTaskId(task, id),
    configNames: {
      meleeAttacker: getGenerationConfigName(task, id, "meleeAttacker"),
      healer: getGenerationConfigName(task, id, "healer"),
    },
  };
}
```

`ensureActiveGeneration` 先检测旧格式两个配置在 live/queued/spawning 中是否存在。有则创建 id 0 并沿用旧配置名/旧 boost ID；无则删除空闲旧配置、设置 counter 0、创建 id 1。

- [ ] **Step 5: 让准备与配置创建使用活动代次**

将 T3 路径改为：

```ts
const generation = ensureActiveGeneration(task);
const result = prepareBoosts(
  generation.boostTaskId,
  task.sourceRoom,
  0,
  T3_DUO_BOOST_AMOUNTS,
  { requireLabEnergy: true },
);
if (!generation.boostGateOpenedAt) {
  if (result.status !== "ready") return false;
  generation.boostGateOpenedAt = Game.time;
  generation.phase = "assembling";
}
ensureGenerationCombatConfigs(task, generation);
```

角色 args 使用 `generation.boostTaskId`，配置名使用 `generation.configNames`。standard squad 保持旧命名路径。

- [ ] **Step 6: 增加有旧成员的第 0 代迁移测试并确认 GREEN**

构造旧格式 attacker 存活、healer 排队，运行后断言：

```ts
expect(task.activeGeneration).toMatchObject({
  id: 0,
  phase: "assembling",
  boostGateOpenedAt: Game.time,
  configNames: {
    meleeAttacker: "E1N57:war:E3N57:meleeAttacker:0",
    healer: "E1N57:war:E3N57:healer:0",
  },
});
expect(spawn.memory.spawnList).toContain("E1N57:war:E3N57:healer:0");
```

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交活动代次和迁移**

```bash
git add src/runtime/warControl.ts src/runtime/warControl.test.ts src/global.d.ts
git commit -m "feat(war): add persistent squad generations"
```

### Task 3: 单向闸门、出发前补位与出发后破组

**Files:**
- Modify: `src/runtime/warControl.ts`
- Modify: `src/runtime/warControl.test.ts`
- Modify: `src/roles/meleeAttacker.ts`
- Modify: `src/roles/meleeAttacker.test.ts`
- Modify: `src/roles/healer.ts`
- Modify: `src/roles/healer.test.ts`
- Modify: `src/global.d.ts`

**Interfaces:**
- Consumes: Task 2 的 `activeGeneration` 和代次配置名。
- Produces: 动态当前代强化需求、deployed 检测、破组换代、`CreepMemory._warDetached`。

- [ ] **Step 1: 写闸门打开后库存下降仍保留队列的 RED 测试**

把现有临时补丁测试改为代次断言：首 tick 完整库存打开 g1 闸门；第二 tick 攻击者已完整强化、实验室只剩治疗者需求且完整双人库存不够。断言：

```ts
expect(task.activeGeneration?.boostGateOpenedAt).toBe(1000);
expect(task.activeGeneration?.phase).toBe("assembling");
expect(spawn.memory.spawnList).toContain("E1N57:war:E3N57:g1:healer:0");
expect(Memory.data!.creepConfigs!["E1N57:war:E3N57:g1:healer:0"]).toBeDefined();
```

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: FAIL，当前代码仍依赖临时 fallback 或代次动态需求尚未实现。

- [ ] **Step 2: 实现活动代次剩余强化需求**

把 `getCurrentT3DuoBoostAmounts` 改为接收 `generation`，只读取该代配置。对 one-shot 已消费且不再 live/queued/spawning 的槽位返回零；其余缺失槽位按完整 body 计数。闸门打开后调用：

```ts
const remainingAmounts = getGenerationRemainingBoostAmounts(task, generation);
const result = prepareBoosts(
  generation.boostTaskId,
  task.sourceRoom,
  0,
  remainingAmounts,
  { requireLabEnergy: true },
);
task.boostStatus = result.status;
task.failReason = result.reason;
ensureGenerationCombatConfigs(task, generation);
```

删除 `currentT3DuoCanFinishBoosting` 及“完整准备失败后再 fallback”的临时路径。闸门开启后的 failed/preparing 只写遥测，不调用 `clearTaskConfigs`。

- [ ] **Step 3: 写出发前单槽补位 RED 测试**

构造 g1 assembling：治疗者存活、攻击者既不 live 也不 queued/spawning。运行后断言只重新排入 g1 attacker，治疗者配置和名字不变。

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: FAIL，尚未区分槽位补充与整代重建。

- [ ] **Step 4: 实现 assembling 单槽补位并确认 GREEN**

让 `ensureGenerationCombatConfigs` 分角色检查 live/queued/spawning；连续任务只把缺失槽位排到最空闲 spawn，one-shot 继续尊重 `spawnOnce.queuedAt`。

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: PASS。

- [ ] **Step 5: 写 deployed 破组换代 RED 测试**

先让 g1 两名成员存在，其中攻击者已在目标房，运行后断言 phase 变 deployed 且释放 g1 boost prep。下一 tick 删除治疗者，断言：

```ts
expect(attacker.memory._warDetached).toBe(true);
expect(task.activeGeneration).toMatchObject({ id: 2, phase: "preparing" });
expect(task.activeGeneration?.configNames.meleeAttacker).toContain(":g2:");
expect(task.activeGeneration?.configNames.healer).toContain(":g2:");
```

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: FAIL，没有 deployed/破组转换。

- [ ] **Step 6: 实现 deployed 检测、破组和旧代清理**

规则代码保持单向：

```ts
if (generation.phase === "assembling" && generationCreeps.some((creep) => creep.room.name !== task.sourceRoom)) {
  generation.phase = "deployed";
  generation.deployedAt = Game.time;
  releaseBoostLabs(generation.boostTaskId, task.sourceRoom);
}

if (generation.phase === "deployed" && generationCreeps.length < 2 && !task.oneShot) {
  for (const survivor of generationCreeps) survivor.memory._warDetached = true;
  cleanupInactiveGenerationConfigs(task, generation);
  task.generationCounter = Math.max(task.generationCounter ?? generation.id, generation.id) + 1;
  task.activeGeneration = createGeneration(task, task.generationCounter);
}
```

清理函数删除缺失旧槽配置和队列，但保留 live/spawning 幸存者配置；每 tick 扫描战争前缀，成员消失后删除 detached 旧配置，防止 spawn planner 重新生产旧代。

- [ ] **Step 7: 让 detached 角色停止固定等待并写角色 RED/GREEN 测试**

在 `src/global.d.ts` 增加 `_warDetached?: boolean`。分别为攻击者和治疗者写测试：配置名仍是旧代但无搭档、memory detached 时，攻击者不在 formation wait 返回，治疗者不等待固定攻击者并继续自疗/向目标房移动。

实现：

```ts
function expectsWarHealer(creep: Creep): boolean {
  const configName = creep.memory.configName;
  return creep.memory._warDetached !== true && configName?.includes(":war:") === true && configName.includes(":meleeAttacker:");
}
function expectsWarAttacker(creep: Creep): boolean {
  const configName = creep.memory.configName;
  return creep.memory._warDetached !== true && configName?.includes(":war:") === true && configName.includes(":healer:");
}
```

Run: `npm test -- --runInBand src/runtime/warControl.test.ts src/roles/meleeAttacker.test.ts src/roles/healer.test.ts`

Expected: PASS。

- [ ] **Step 8: 增加 one-shot 破组不换代测试**

构造 deployed one-shot g1 丢失治疗者，断言 survivor detached、`generationCounter` 不增加、无 g2 配置或队列。

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交单向闸门和破组生命周期**

```bash
git add src/runtime/warControl.ts src/runtime/warControl.test.ts src/roles/meleeAttacker.ts src/roles/meleeAttacker.test.ts src/roles/healer.ts src/roles/healer.test.ts src/global.d.ts
git commit -m "fix(war): make squad generation gates monotonic"
```

### Task 4: 战争目标价值排序与无害 creep 忽略

**Files:**
- Modify: `src/roles/meleeAttacker.ts`
- Modify: `src/roles/meleeAttacker.test.ts`
- Modify: `src/roles/healer.test.ts`

**Interfaces:**
- Consumes: 现有 `findWarObjectiveTarget`、`findFirstBreachOnCombatPath`、tracked breach 和 healer shared target。
- Produces: 战略设施、战斗 creep、裸露功能建筑、受保护功能建筑、残余 rampart 的确定性顺序。

- [ ] **Step 1: 写无害 creep/残余 rampart 不覆盖裸露建筑的 RED 测试**

构造远处无害 carry creep、100 万 rampart、裸露 extension 和 lab，断言：

```ts
expect(findWarObjectiveTarget(attacker)).toBe(lab);
```

另写只剩远处无害 creep 时返回 null 的测试。

Run: `npm test -- --runInBand src/roles/meleeAttacker.test.ts`

Expected: FAIL，当前 `findTarget` 会返回 creep 或 rampart。

- [ ] **Step 2: 写战斗 creep 与 rampart 保护 RED 测试**

构造一个裸露 ATTACK creep、一个站在 hostile rampart 上的 RANGED_ATTACK creep 和一个裸露 lab。断言裸露战斗 creep 优先；移除裸露战斗 creep 后断言 lab 优先于 rampart 内 ranged creep。

Run: `npm test -- --runInBand src/roles/meleeAttacker.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现分层目标选择**

在 `findWarObjectiveTarget` 内一次读取 hostile creeps/structures，建立 hostile rampart 位置集合，并使用：

```ts
const coreOrder: StructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_TERMINAL,
  STRUCTURE_INVADER_CORE,
];
const utilityOrder: StructureConstant[] = [
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_NUKER,
  STRUCTURE_LAB,
  STRUCTURE_OBSERVER,
  STRUCTURE_LINK,
  STRUCTURE_EXTENSION,
  STRUCTURE_EXTRACTOR,
];
```

选择顺序为 core、未被 rampart 保护的 dangerous creep、裸露 non-barrier utility、受保护 non-barrier utility、残余 rampart。dangerous 判定继续使用 HEAL/ATTACK/RANGED_ATTACK 有效部件。无结构且只有非 dangerous creep 时返回 null。

- [ ] **Step 4: 保持必要 breach 与锁定行为**

复用已有 complete-path 与 tracked-breach 测试，并增加“裸露 lab 的路径首格为 wall 时锁定该 wall”的测试。不要修改 `getCombatBreachCost`：rampart 和 ranged 覆盖 wall 继续使用 `0xfe`。

Run: `npm test -- --runInBand src/roles/meleeAttacker.test.ts src/roles/healer.test.ts`

Expected: PASS；既有 spawn/tower/storage 顺序测试也通过。

- [ ] **Step 5: 提交目标优先级修复**

```bash
git add src/roles/meleeAttacker.ts src/roles/meleeAttacker.test.ts src/roles/healer.test.ts
git commit -m "fix(war): prioritize infrastructure over harmless creeps"
```

### Task 5: 代次遥测、停止清理和完整回归

**Files:**
- Modify: `src/runtime/warControl.ts`
- Modify: `src/runtime/warControl.test.ts`
- Modify: `src/global.d.ts`

**Interfaces:**
- Consumes: Tasks 2–4 的活动代次和 detached 状态。
- Produces: 可从 `analytics.war` 证明代次状态的字段，覆盖所有代配置的 stop/done 清理。

- [ ] **Step 1: 写遥测 RED 测试**

在 war telemetry 测试中断言：

```ts
expect(Memory.analytics?.war?.tasks.E3N57).toEqual(expect.objectContaining({
  generationId: 1,
  generationPhase: "assembling",
  boostGateOpen: true,
  generationAge: 0,
  deployedAge: 0,
}));
```

并让 creep snapshot 暴露 `detached: true`。

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: FAIL，snapshot 尚无字段。

- [ ] **Step 2: 扩展 WarStatus 类型和 snapshot**

`WarStatusTaskSnapshot` / `src/global.d.ts` 增加：

```ts
generationId?: number;
generationPhase?: WarGenerationPhase;
boostGateOpen: boolean;
generationAge: number;
deployedAge: number;
```

`WarStatusCreepSnapshot` 增加 `detached: boolean`。`buildTaskStatusSnapshot` 从活动代次计算年龄；无代次时返回 false/0。

- [ ] **Step 3: 写 stop/done 多代配置清理测试**

构造 active g2、live detached g1 和 idle g0 配置。`stopWarRoom` 后断言所有代配置和队列删除、活动代 boost prep 释放；未传 `suicide` 时 live g1 creep 保持存活并依靠已复制到 CreepMemory 的 role/roleArgs 继续执行。另构造仍保留 done 任务的 live detached g1：完成 tick 保留其配置，删除 live creep 后再次运行控制器，断言旧配置消失。

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: FAIL，旧实现只理解固定预期配置。

- [ ] **Step 4: 实现前缀级安全清理并确认 GREEN**

让 `getTaskConfigNames` 保留战争前缀扫描；停止、完成、失败分别释放 `activeGeneration.boostTaskId` 或迁移前旧 boost ID。stop 沿用现有语义立即删除所有配置；done/failed 的后台清理在 live/spawning 期间保留配置，成员消失后删除。所有路径显式删除队列项，保证 detached 幸存者不会被重生。

Run: `npm test -- --runInBand src/runtime/warControl.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行定向回归和类型检查**

Run: `npm test -- --runInBand src/runtime/warControl.test.ts src/runtime/powerBankBoost.test.ts src/roles/combatBoosts.test.ts src/roles/meleeAttacker.test.ts src/roles/healer.test.ts`

Expected: 所有定向 suite PASS。

Run: `npx tsc --noEmit`

Expected: exit 0。

- [ ] **Step 6: 提交遥测与清理**

```bash
git add src/runtime/warControl.ts src/runtime/warControl.test.ts src/global.d.ts
git commit -m "feat(war): expose squad generation telemetry"
```

### Task 6: 全量验证、部署与四目标实时验收

**Files:**
- Verify only: repository-wide source/tests
- Runtime mutation: Screeps `default` branch and approved war task Memory through existing console commands

**Interfaces:**
- Consumes: 全部实现提交与 `screeps-game-data` 监控/API 路径。
- Produces: 新 deploy tag、四目标任务状态、新代生产/强化/出发和目标选择的实时证据。

- [ ] **Step 1: 运行完整静态和测试验证**

```bash
npx tsc --noEmit
npm test -- --runInBand
npm run build
git diff --check
git status --short
```

Expected: TypeScript/build/test exit 0；worktree clean；完整 Jest suite 无失败。

- [ ] **Step 2: 部署当前 main**

Run: `npm run push`

Expected: Rollup 构建成功并上传 Screeps `default` 分支。

- [ ] **Step 3: 验证 deploy tag**

Run: `npm run monitor:once`

Expected: `memory.selectedShard` 为 `shard1`，`memory.shardCandidates` 中 shard1 的 `lastDeployTag` 包含最新 Git short SHA。

- [ ] **Step 4: 核对并补齐四个战争任务**

通过 `warStatusRaw()` / `analytics.war` 核对 E3N57、E2N54、E3N53、W2N58。只对不存在或 failed 的目标调用现有 `startWarRoom(target, source, { oneShot: false, routeRooms })`；其中 `routeRooms` 是从当前任务 Memory 沿用的字符串数组，不存在时先用 `Game.map.findRoute(source, target).map((step) => step.room)` 读取。保留已完成/仍有效任务，不重复创建。

- [ ] **Step 5: 验证新代恢复生产**

每约 15 tick（45 秒）读取 `analytics.war`，确认：

```text
generationId >= 1
generationPhase: preparing -> assembling -> deployed
boostGateOpen: false -> true（不回退）
配置名包含 :g<id>:
攻击者 50 个强化部件，治疗者 38 个强化部件
两名成员自行离开来源房并保持相邻
```

- [ ] **Step 6: 验证战斗目标选择**

在目标房可见时采集攻击者 `_warBreachTargetId`、目标类型、位置和房间结构计数。确认：

- 存在裸露功能建筑时不锁定残余 wall/rampart。
- 不追逐无 ATTACK/RANGED_ATTACK/HEAL 的远处 creep。
- 必须破墙时锁定路径第一面安全 wall，拆除期间不回走。
- 治疗者在分散塔火下自疗，并继续与本代攻击者相邻。

- [ ] **Step 7: 完成防御聚类只读审查记录**

复核 `src/runtime/defenseFronts.ts` 的桥接 hostile 多簇合并问题，只报告当前静态结论和测试缺口；除非用户另行批准防御行为变更，本轮不混入战争部署提交。

- [ ] **Step 8: 最终工作树和运行态审计**

Run: `git status --short --branch`

Expected: `## main` 且无未提交文件。最终汇报每个提交、全量测试数量、deploy tag、四目标任务状态以及仍需等待的外部战斗进度。
