# 战争双人组有限回身反击实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让战争攻击者对 2 格内危险敌人尝试一次贴身，同时保证敌人拉开后立即恢复原 breach，不形成持续追击。

**Architecture:** 在 `CreepMemory` 中保存短寿命反击状态和本次近距离接触的抑制目标数组。没有固定 healer 时攻击者直接提交一步移动；存在 healer 时先布置状态、再由 healer 确认，第三 tick 双方执行保持或换位。healer 在创建 tick 先执行时会独立预检并保持位置，从第一 tick 起消除角色执行顺序差异。反击状态只消费一次接近机会，既有相邻攻击逻辑负责后续命中。

**Tech Stack:** TypeScript、Screeps API、Jest。

## Global Constraints

- 生产逻辑不得包含房间名、固定坐标、敌方 creep 名称或特定战线配置。
- 只对具有 `ATTACK`、`RANGED_ATTACK` 或 `HEAL` 有效部件的敌方 creep 触发。
- 目标必须在 2 格内且未受敌方 rampart 保护。
- 同一目标持续停在 2 格内时只允许一次接近；离开后重新靠近才可再次尝试。
- 反击不得清除仍存活的 `_warBreachTargetId`。
- 不改变非战争近战角色、Power Bank 角色和远程防御逻辑。

---

### Task 1: 攻击者一次接近状态

**Files:**
- Modify: `src/global.d.ts:1231`
- Modify: `src/roles/meleeAttacker.ts:240-560`
- Test: `src/roles/meleeAttacker.test.ts`

**Interfaces:**
- Consumes: 现有 `findPairedWarHealer`、`isDangerousHostile`、`isWalkableStructure` 和 `_warBreachTargetId`。
- Produces: `CreepMemory._warCounterstrike`、`CreepMemory._warCounterstrikeSuppressedTargetIds`；healer 在 Task 2 读取前者。

- [ ] **Step 1: 写失败测试**

在 `src/roles/meleeAttacker.test.ts` 增加以下用例；共享的 `setupCounterstrikeRoom` 帮助函数负责创建 tracked wall、攻击者、配对 healer、敌人和准确的 Chebyshev `getRangeTo`：

```ts
it("takes one step toward an exposed dangerous hostile at range two", () => {
  meleeAttackerRole(TARGET_ROOM).target(attacker);
  expect(attacker.move).toHaveBeenCalledWith(RIGHT);
  expect(attacker.memory._warCounterstrike?.targetId).toBe(hostile.id);
  expect(attacker.memory._warBreachTargetId).toBe(wall.id);
});

it("does not repeat the approach while the same hostile remains at range two", () => {
  attacker.memory._warCounterstrikeSuppressedTargetIds = [hostile.id];
  meleeAttackerRole(TARGET_ROOM).target(attacker);
  expect(attacker.move).not.toHaveBeenCalled();
  expect(attacker.attack).toHaveBeenCalledWith(wall);
});

it("allows a new approach after the suppressed hostile leaves range two", () => {
  attacker.memory._warCounterstrikeSuppressedTargetIds = [hostile.id];
  hostile.pos = position(30, 25);
  meleeAttackerRole(TARGET_ROOM).target(attacker);
  expect(attacker.memory._warCounterstrikeSuppressedTargetIds).toBeUndefined();
});

it("preserves the tracked breach after attacking an adjacent hostile", () => {
  meleeAttackerRole(TARGET_ROOM).target(attacker);
  expect(attacker.attack).toHaveBeenCalledWith(hostile);
  expect(attacker.memory._warBreachTargetId).toBe(wall.id);
});

it.each([
  ["range three", 28, 25, false],
  ["protected by a hostile rampart", 27, 25, true],
])("does not counterstrike a hostile that is %s", (_label, x, y, protectedByRampart) => {
  const { attacker, hostile, wall } = setupCounterstrikeRoom({ hostileX: x, hostileY: y, protectedByRampart });
  meleeAttackerRole(TARGET_ROOM).target(attacker);
  expect(attacker.move).not.toHaveBeenCalled();
  expect(attacker.attack).toHaveBeenCalledWith(wall);
  expect(attacker.attack).not.toHaveBeenCalledWith(hostile);
});

it("does not displace an unrelated friendly creep from the only approach tile", () => {
  const { attacker, wall } = setupCounterstrikeRoom({ approachOccupantRole: "worker" });
  meleeAttackerRole(TARGET_ROOM).target(attacker);
  expect(attacker.move).not.toHaveBeenCalled();
  expect(attacker.attack).toHaveBeenCalledWith(wall);
});
```

- [ ] **Step 2: 运行测试确认 RED**

```bash
npm test -- --runInBand src/roles/meleeAttacker.test.ts
```

Expected: FAIL，`_warCounterstrike` 未定义且 range-2 场景没有 `move(RIGHT)`。

- [ ] **Step 3: 增加 memory 类型和最小攻击者实现**

在 `src/global.d.ts` 增加：

```ts
_warCounterstrike?: {
  targetId: Id<Creep>;
  targetX: number;
  targetY: number;
  createdAt: number;
  originX: number;
  originY: number;
  approachX: number;
  approachY: number;
  healerCoordinated?: boolean;
  healerReadyAt?: number;
  healerSwap?: boolean;
};
_warCounterstrikeSuppressedTargetIds?: Id<Creep>[];
```

在 `src/roles/meleeAttacker.ts` 增加：

```ts
function clearExpiredCounterstrikeSuppression(creep: Creep): void;
function isHostileProtectedByRampart(creep: Creep, hostile: Creep): boolean;
function findCounterstrikeApproach(creep: Creep): {
  target: Creep;
  x: number;
  y: number;
  healerCoordinated: boolean;
  healerSwap: boolean;
} | null;
function runCounterstrikeApproach(creep: Creep): boolean;
```

`findCounterstrikeApproach` 先按距离、当前生命值、战斗威胁排序候选敌人，再枚举目标周围八格。只接受同时与攻击者相邻、地形可走、没有不可走结构的位置。其他 creep 占位时拒绝；只有配对 healer 占位时返回 `healerSwap: true`。敌人位置存在敌方 rampart、距离大于 2 或 ID 仍处于抑制状态时直接排除。

`runCounterstrikeApproach` 的核心状态转换以当前实现为准：固定 healer 存在时创建 tick 和确认 tick 均保持位置，只有 `healerReadyAt === createdAt + 1` 且当前 tick 为 `createdAt + 2` 时执行移动；无固定 healer 时创建 tick 立即执行。目标抑制使用 ID 数组，逐个在目标离开 2 格后释放。

空闲 approach 必须保持 healer 相邻；swap approach 只允许固定、未 detached、同房且相邻的 healer。创建 tick 若 healer 先执行，它必须通过同一候选规则预检并保持位置。握手期间重新检查目标原坐标和 approach 的地形、不可走结构、自然障碍、Creep 与 PowerCreep 占位。所有直接邻格移动前调用 `clearMovementState`，同时清除运行时路径与 Memory 路径缓存。

在战争目标房 `target` 流程中，将其放在相邻敌人检查之后、建筑目标选择之前。相邻攻击时保留 `_warBreachTargetId`。

- [ ] **Step 4: 运行测试确认 GREEN**

```bash
npm test -- --runInBand src/roles/meleeAttacker.test.ts
npx tsc --noEmit
```

Expected: meleeAttacker 测试全部 PASS，TypeScript 无错误。

### Task 2: healer 协同让位与完整验证

**Files:**
- Modify: `src/roles/healer.ts:90-175`
- Test: `src/roles/healer.test.ts`

**Interfaces:**
- Consumes: Task 1 产生的 `CreepMemory._warCounterstrike` 和现有固定配对攻击者。
- Produces: healer 在占据 `approachX/approachY` 时向攻击者原位置移动的单 tick 交换意图。

- [ ] **Step 1: 写失败测试**

在 `src/roles/healer.test.ts` 增加：

```ts
it("yields its tile when the paired attacker starts a counterstrike swap", () => {
  attacker.memory._warCounterstrike = {
    targetId: "enemy" as Id<Creep>,
    targetX: hostile.pos.x,
    targetY: hostile.pos.y,
    createdAt: Game.time,
    originX: attacker.pos.x,
    originY: attacker.pos.y,
    approachX: healer.pos.x,
    approachY: healer.pos.y,
    healerCoordinated: true,
    healerSwap: true,
  };
  healerRole(TARGET_ROOM).target(healer);
  expect(healer.move).toHaveBeenCalledWith(healer.pos.getDirectionTo(attacker.pos));
});
```

- [ ] **Step 2: 运行测试确认 RED**

```bash
npm test -- --runInBand src/roles/healer.test.ts
```

Expected: FAIL，healer 没有提交交换移动。

- [ ] **Step 3: 实现 healer 让位**

```ts
function coordinateCounterstrike(creep: Creep, attacker: Creep): boolean;
```

在 `healAttacker` 之后、普通编队移动之前调用。若返回 true，本 tick 不再提交其他移动意图，但仍保留治疗意图。

- [ ] **Step 4: 运行定向和全量验证**

```bash
npm test -- --runInBand src/roles/meleeAttacker.test.ts src/roles/healer.test.ts
npx tsc --noEmit
npm test -- --runInBand
npm run build
git diff --check
```

Expected: 所有测试 PASS、TypeScript 与 Rollup 构建成功、diff check 无输出。

- [ ] **Step 5: 提交、部署和实时验收**

```bash
git add src/global.d.ts src/roles/meleeAttacker.ts src/roles/meleeAttacker.test.ts src/roles/healer.ts src/roles/healer.test.ts docs/superpowers/plans/2026-07-16-war-opportunistic-counterstrike.md
git commit -m "fix(war): allow bounded counterstrikes"
npm run push
```

部署后运行 `npm run monitor:once`，确认 shard1 `lastDeployTag` 包含新提交。通过临时只读快照确认攻击者最多接近一次；若敌人保持相邻则攻击，若敌人拉开则原 tracked rampart hits 继续下降。
