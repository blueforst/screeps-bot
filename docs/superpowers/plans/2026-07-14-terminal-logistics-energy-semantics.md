# Terminal Logistics Energy Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `energyFloor` drive worker reserve hysteresis while terminal logistics uses real fee affordability, `energyTarget`, and `energyExportStart` without treating terminal reserve energy as untouchable.

**Architecture:** Extract one pure room-energy-policy resolver so worker reserve and resource control normalize the same values. Keep the existing task lifecycle and carrier staging, but split planning eligibility from execution affordability: non-energy tasks are planned from resource/capacity safety and executed against actual terminal energy, while energy exports additionally require the storage export threshold and preserve total room energy through `energyTarget`.

**Tech Stack:** TypeScript 5.9, Screeps API, Jest 29 with ts-jest, Rollup.

## Global Constraints

- Worker reserve enters when storage energy is strictly below `energyFloor` and clears when storage energy is at least `energyTarget`.
- Terminal energy is excluded from worker reserve decisions.
- `energyTarget` is normalized to at least `energyFloor`; `energyExportStart` is normalized to at least the normalized `energyTarget`.
- `terminalEnergyReserve` remains a terminal refill/offload target, not a cross-room send floor.
- Non-energy task planning must not depend on current fee energy; execution may spend any actual terminal energy that pays the exact fee.
- Energy export requires `storageEnergy >= energyExportStart` and may not reduce total room energy below `energyTarget` after commitments and transaction fee.
- Receiver capacity buffers, same-tick reservations, mineral floors, T3 reserve, production commitments, task TTL, and blocker lifecycle remain enforced.
- The legacy `survival` status and market/factory policies remain compatible; market eligibility and factory configuration are outside this change.
- Do not reorder `src/main.ts`, change creep role state machines, or deploy to Screeps as part of this plan.

## File Map

- Create `src/runtime/roomEnergyPolicy.ts`: pure normalization and defaults for the four room energy-policy values.
- Create `src/runtime/roomEnergyPolicy.test.ts`: focused normalization regression coverage.
- Modify `src/runtime/resourceControl.ts`: consume the shared policy and correct energy/non-energy planning and execution semantics.
- Modify `src/runtime/resourceControl.test.ts`: black-box resource-control regressions for task creation, exact fees, energy donor/receiver rules, and same-tick ledgers.
- Modify `src/runtime/autoReserveFlag.ts`: replace hard-coded reserve thresholds with the shared room policy.
- Modify `src/runtime/autoReserveFlag.test.ts`: configured threshold, boundary, hysteresis, and storage-only tests.
- Modify `package.json`: advance the release tag to `2026.7.14-1` after all behavior is green.

---

### Task 1: Extract the shared room energy policy

**Files:**
- Create: `src/runtime/roomEnergyPolicy.ts`
- Create: `src/runtime/roomEnergyPolicy.test.ts`
- Modify: `src/runtime/resourceControl.ts:21-24,60-68,191-215,273-315`

**Interfaces:**
- Consumes: `normalizeNumber(value, fallback, min, max)` from `src/runtime/configNormalize.ts`.
- Produces: `RoomEnergyPolicy` and `resolveRoomEnergyPolicy(value: unknown): RoomEnergyPolicy` for resource control and automatic reserve flags.

- [ ] **Step 1: Write the failing policy-normalization tests**

Create `src/runtime/roomEnergyPolicy.test.ts`:

```ts
import { resolveRoomEnergyPolicy } from "@/runtime/roomEnergyPolicy";

describe("resolveRoomEnergyPolicy", () => {
  it("returns the existing resource-control defaults when config is absent", () => {
    expect(resolveRoomEnergyPolicy(undefined)).toEqual({
      energyFloor: 120_000,
      energyTarget: 200_000,
      energyExportStart: 250_000,
      terminalEnergyReserve: 20_000,
    });
  });

  it("normalizes room overrides into floor target export order", () => {
    expect(
      resolveRoomEnergyPolicy({
        energyFloor: 210_000,
        energyTarget: 190_000,
        energyExportStart: 195_000,
        terminalEnergyReserve: 12_345,
      }),
    ).toEqual({
      energyFloor: 210_000,
      energyTarget: 210_000,
      energyExportStart: 210_000,
      terminalEnergyReserve: 12_345,
    });
  });

  it("clamps invalid values with the existing resource-control bounds", () => {
    expect(
      resolveRoomEnergyPolicy({
        energyFloor: -1,
        energyTarget: Number.POSITIVE_INFINITY,
        energyExportStart: 4_000_000,
        terminalEnergyReserve: 400_000,
      }),
    ).toEqual({
      energyFloor: 0,
      energyTarget: 200_000,
      energyExportStart: 3_000_000,
      terminalEnergyReserve: 300_000,
    });
  });
});
```

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```bash
npm test -- --runInBand src/runtime/roomEnergyPolicy.test.ts
```

Expected: FAIL because `@/runtime/roomEnergyPolicy` does not exist.

- [ ] **Step 3: Implement the pure resolver and route resource control through it**

Create `src/runtime/roomEnergyPolicy.ts`:

```ts
import { normalizeNumber } from "@/runtime/configNormalize";

export interface RoomEnergyPolicy {
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
}

const DEFAULT_ROOM_ENERGY_POLICY: RoomEnergyPolicy = {
  energyFloor: 120_000,
  energyTarget: 200_000,
  energyExportStart: 250_000,
  terminalEnergyReserve: 20_000,
};

export function resolveRoomEnergyPolicy(value: unknown): RoomEnergyPolicy {
  const raw = value && typeof value === "object"
    ? (value as Partial<RoomEnergyPolicy>)
    : {};
  const energyFloor = normalizeNumber(
    raw.energyFloor,
    DEFAULT_ROOM_ENERGY_POLICY.energyFloor,
    0,
    3_000_000,
  );
  const energyTarget = Math.max(
    energyFloor,
    normalizeNumber(
      raw.energyTarget,
      DEFAULT_ROOM_ENERGY_POLICY.energyTarget,
      0,
      3_000_000,
    ),
  );
  const energyExportStart = Math.max(
    energyTarget,
    normalizeNumber(
      raw.energyExportStart,
      DEFAULT_ROOM_ENERGY_POLICY.energyExportStart,
      0,
      3_000_000,
    ),
  );

  return {
    energyFloor,
    energyTarget,
    energyExportStart,
    terminalEnergyReserve: normalizeNumber(
      raw.terminalEnergyReserve,
      DEFAULT_ROOM_ENERGY_POLICY.terminalEnergyReserve,
      0,
      300_000,
    ),
  };
}
```

In `src/runtime/resourceControl.ts`, add:

```ts
import {
  resolveRoomEnergyPolicy,
  type RoomEnergyPolicy,
} from "@/runtime/roomEnergyPolicy";
```

Replace `ResourceControlRoomConfig` with:

```ts
interface ResourceControlRoomConfig extends RoomEnergyPolicy {
  transferBatchSize: number;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
}
```

Replace `DEFAULT_ROOM_CONFIG` with:

```ts
const DEFAULT_ROOM_CONFIG: Omit<ResourceControlRoomConfig, keyof RoomEnergyPolicy> = {
  transferBatchSize: 10_000,
  mineralFloor: {
    [RESOURCE_HYDROGEN]: 5_000,
    [RESOURCE_OXYGEN]: 5_000,
    [RESOURCE_UTRIUM]: 5_000,
    [RESOURCE_LEMERGIUM]: 5_000,
    [RESOURCE_KEANIUM]: 5_000,
    [RESOURCE_ZYNTHIUM]: 5_000,
    [RESOURCE_CATALYST]: 3_000,
  },
  mineralExportStart: {
    [RESOURCE_HYDROGEN]: 15_000,
    [RESOURCE_OXYGEN]: 15_000,
    [RESOURCE_UTRIUM]: 15_000,
    [RESOURCE_LEMERGIUM]: 15_000,
    [RESOURCE_KEANIUM]: 15_000,
    [RESOURCE_ZYNTHIUM]: 15_000,
    [RESOURCE_CATALYST]: 10_000,
  },
};
```

Replace `normalizeRoomConfig` with:

```ts
function normalizeRoomConfig(value: unknown): ResourceControlRoomConfig {
  const config = value && typeof value === "object"
    ? (value as Partial<ResourceControlRoomConfig>)
    : {};
  const energyPolicy = resolveRoomEnergyPolicy(config);
  const transferBatchSize = normalizeNumber(
    config.transferBatchSize,
    DEFAULT_ROOM_CONFIG.transferBatchSize,
    100,
    50_000,
  );
  const mineralFloor = normalizeResourceThresholdMap(
    config.mineralFloor,
    DEFAULT_ROOM_CONFIG.mineralFloor,
    0,
    500_000,
  );
  const mineralExportStart = normalizeResourceThresholdMap(
    config.mineralExportStart,
    DEFAULT_ROOM_CONFIG.mineralExportStart,
    0,
    1_000_000,
  );

  for (const resource of BASE_MINERALS) {
    const floor = mineralFloor[resource] || 0;
    const exportStart = mineralExportStart[resource] || 0;
    if (exportStart < floor) {
      mineralExportStart[resource] = floor;
    }
  }

  return {
    ...energyPolicy,
    transferBatchSize,
    mineralFloor,
    mineralExportStart,
  };
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
npm test -- --runInBand src/runtime/roomEnergyPolicy.test.ts src/runtime/resourceControl.test.ts
npx tsc --noEmit
```

Expected: both suites PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the shared policy**

```bash
git add src/runtime/roomEnergyPolicy.ts src/runtime/roomEnergyPolicy.test.ts src/runtime/resourceControl.ts
git commit -m "refactor(resource-control): share room energy policy"
```

---

### Task 2: Drive worker reserve hysteresis from room policy

**Files:**
- Modify: `src/runtime/autoReserveFlag.ts:1-46`
- Modify: `src/runtime/autoReserveFlag.test.ts:1-90`

**Interfaces:**
- Consumes: `resolveRoomEnergyPolicy(value: unknown): RoomEnergyPolicy` from Task 1.
- Produces: unchanged `runAutoReserveFlags(): void`; only the automatic `RESERVE_<room>` flag uses configured thresholds.

- [ ] **Step 1: Replace hard-coded-threshold tests with configured policy tests**

Use these helpers and cases in `src/runtime/autoReserveFlag.test.ts`:

```ts
import { runAutoReserveFlags } from "@/runtime/autoReserveFlag";

function createRoom(name: string, storageEnergy: number, level = 4, terminalEnergy = 0): Room {
  const storage = {
    pos: { x: 20, y: 20, roomName: name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? storageEnergy : 0,
    },
  } as unknown as StructureStorage;
  const room = {
    name,
    controller: { my: true, level } as StructureController,
    storage,
    terminal: {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? terminalEnergy : 0,
      },
    } as unknown as StructureTerminal,
    createFlag: jest.fn((_pos: RoomPosition, flagName?: string) => flagName || name),
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

function createAutoFlag(room: Room, x = 20, y = 20): Flag {
  const flag = {
    name: `RESERVE_${room.name}`,
    pos: { x, y, roomName: room.name },
    remove: jest.fn(() => OK),
    setPosition: jest.fn(() => OK),
  } as unknown as Flag;
  Game.flags[flag.name] = flag;
  return flag;
}

function setRoomPolicy(roomName: string, energyFloor: number, energyTarget: number): void {
  Memory.cfg = {
    resourceControl: {
      rooms: {
        [roomName]: { energyFloor, energyTarget },
      },
    },
  };
}

describe("runAutoReserveFlags", () => {
  beforeEach(() => {
    Game.rooms = {};
    Game.flags = {};
    Memory.cfg = {};
  });

  it("creates the auto reserve flag below the room's configured energyFloor", () => {
    const room = createRoom("W1N1", 74_999);
    setRoomPolicy(room.name, 75_000, 110_000);
    runAutoReserveFlags();
    expect(room.createFlag).toHaveBeenCalledWith(room.storage?.pos, "RESERVE_W1N1");
  });

  it("does not create the auto reserve flag at the configured energyFloor", () => {
    const room = createRoom("W1N2", 40_000);
    setRoomPolicy(room.name, 40_000, 60_000);
    runAutoReserveFlags();
    expect(room.createFlag).not.toHaveBeenCalled();
  });

  it("keeps the auto reserve flag below the configured energyTarget", () => {
    const room = createRoom("W1N3", 90_000);
    setRoomPolicy(room.name, 60_000, 100_000);
    const flag = createAutoFlag(room);
    runAutoReserveFlags();
    expect(flag.remove).not.toHaveBeenCalled();
  });

  it("removes the auto reserve flag at the configured energyTarget", () => {
    const room = createRoom("W1N4", 60_000);
    setRoomPolicy(room.name, 40_000, 60_000);
    const flag = createAutoFlag(room);
    runAutoReserveFlags();
    expect(flag.remove).toHaveBeenCalled();
  });

  it("uses storage energy only when entering worker reserve mode", () => {
    const room = createRoom("W1N5", 90_000, 4, 250_000);
    setRoomPolicy(room.name, 100_000, 150_000);
    runAutoReserveFlags();
    expect(room.createFlag).toHaveBeenCalledWith(room.storage?.pos, "RESERVE_W1N5");
  });

  it("does not manage a room before storage is built", () => {
    const room = createRoom("W1N6", 10_000);
    delete (room as Room & { storage?: StructureStorage }).storage;
    runAutoReserveFlags();
    expect(room.createFlag).not.toHaveBeenCalled();
  });

  it("moves an existing auto reserve flag back to storage while below floor", () => {
    const room = createRoom("W1N7", 10_000);
    setRoomPolicy(room.name, 100_000, 150_000);
    const flag = createAutoFlag(room, 10, 10);
    runAutoReserveFlags();
    expect(flag.setPosition).toHaveBeenCalledWith(room.storage?.pos);
    expect(room.createFlag).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the reserve suite and confirm RED**

Run:

```bash
npm test -- --runInBand src/runtime/autoReserveFlag.test.ts
```

Expected: FAIL on configured entry/clear boundaries because production still uses 50,000/80,000.

- [ ] **Step 3: Replace the automatic reserve implementation**

Replace `src/runtime/autoReserveFlag.ts` with:

```ts
import { resolveRoomEnergyPolicy } from "@/runtime/roomEnergyPolicy";

function getAutoReserveFlagName(roomName: string): string {
  return `RESERVE_${roomName}`;
}

function isAtPosition(flag: Flag, pos: RoomPosition): boolean {
  return flag.pos.roomName === pos.roomName && flag.pos.x === pos.x && flag.pos.y === pos.y;
}

function shouldManageRoom(room: Room): room is Room & { storage: StructureStorage } {
  return !!room.controller?.my && room.controller.level >= 4 && !!room.storage;
}

export function runAutoReserveFlags(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!shouldManageRoom(room)) {
      continue;
    }

    const flagName = getAutoReserveFlagName(room.name);
    const flag = Game.flags[flagName];
    const policy = resolveRoomEnergyPolicy(
      Memory.cfg?.resourceControl?.rooms?.[room.name],
    );
    const storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);

    if (storageEnergy < policy.energyFloor) {
      if (flag) {
        if (!isAtPosition(flag, room.storage.pos)) {
          flag.setPosition(room.storage.pos);
        }
        continue;
      }

      const createdFlagName = room.createFlag(room.storage.pos, flagName);
      if (createdFlagName === flagName) {
        console.log(`[reserve] ${room.name} entered reserve mode at ${storageEnergy} energy`);
      }
      continue;
    }

    if (flag && storageEnergy >= policy.energyTarget) {
      flag.remove();
      console.log(`[reserve] ${room.name} cleared reserve mode at ${storageEnergy} energy`);
    }
  }
}
```

- [ ] **Step 4: Run reserve, policy, and type checks**

Run:

```bash
npm test -- --runInBand src/runtime/roomEnergyPolicy.test.ts src/runtime/autoReserveFlag.test.ts
npx tsc --noEmit
```

Expected: both suites PASS and TypeScript exits 0.

- [ ] **Step 5: Commit worker reserve semantics**

```bash
git add src/runtime/autoReserveFlag.ts src/runtime/autoReserveFlag.test.ts
git commit -m "fix(reserve): use configured worker energy thresholds"
```

---

### Task 3: Make non-energy planning independent of fee inventory

**Files:**
- Modify: `src/runtime/resourceControl.ts:692-725,1009-1041`
- Modify: `src/runtime/resourceControl.test.ts:3701-4392,4393-4805`

**Interfaces:**
- Consumes: existing `getTotalMovableResourceAmount`, task blocker API, receiver-capacity ledger, and `Game.market.calcTransactionCost`.
- Produces: `computeLargestAffordableAmount(maximum, canAfford): number`; non-energy execution returns the largest batch whose exact fee fits current terminal energy.

- [ ] **Step 1: Add RED regressions for planning, reserve spending, exact shrinking, and blocking**

Add this case to `capacity-relief planning`:

```ts
it("plans non-energy relief even when fee energy is below floor and reserve", () => {
  const source = createRoom({
    name: "W61N20",
    terminalResources: { [RESOURCE_HYDROGEN]: 260_000 },
    storageFreeCapacity: 500_000,
  });
  source.terminal!.cooldown = 1;
  const receiver = createRoom({
    name: "W61N21",
    storageResources: { [RESOURCE_ENERGY]: 200_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    storageFreeCapacity: 500_000,
  });
  Game.rooms[source.name] = source;
  Game.rooms[receiver.name] = receiver;
  Memory.cfg!.resourceControl!.rooms = {
    [source.name]: {
      energyFloor: 250_000,
      terminalEnergyReserve: 80_000,
    },
  };
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 5_000);

  runResourceControl();

  const task = Object.values(ensureResourceTransferTaskStore()).find(
    (entry) => entry.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
  );
  expect(task).toMatchObject({
    amount: 40_000,
    remainingAmount: 40_000,
    status: "pending",
    blockedReason: "insufficient_terminal_resource_or_fee",
  });
});
```

Replace `protects total donor energy from a non-energy relief fee` with:

```ts
it("allows non-energy relief to spend terminal energy below terminalEnergyReserve", () => {
  const donor = createRoom({
    name: "W68N10E",
    storageResources: { [RESOURCE_ENERGY]: 100_000 },
    terminalResources: {
      [RESOURCE_ENERGY]: 11_000,
      [RESOURCE_KEANIUM]: 10_000,
    },
    storageFreeCapacity: 50_000,
  });
  const receiver = createRoom({
    name: "W68N10F",
    storageResources: { [RESOURCE_ENERGY]: 200_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    storageFreeCapacity: 500_000,
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  Memory.cfg!.resourceControl!.rooms = {
    [donor.name]: { terminalEnergyReserve: 50_000 },
  };
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 11_000);
  const created = createAutomaticResourceTransferTask(
    donor.name,
    receiver.name,
    RESOURCE_KEANIUM,
    1_000,
    `capacity:relief:${RESOURCE_KEANIUM}`,
  );
  if (typeof created === "string") throw new Error(created);

  runResourceControl();

  expect(donor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_KEANIUM,
    1_000,
    receiver.name,
    expect.any(String),
  );
  expect(created.task).toMatchObject({ status: "done", remainingAmount: 0 });
});
```

Add these cases to `capacity-relief execution health and priority`:

```ts
it("shrinks a non-energy send to the largest fee-affordable batch", () => {
  const donor = createRoom({
    name: "W68N20",
    terminalResources: {
      [RESOURCE_ENERGY]: 750,
      [RESOURCE_KEANIUM]: 10_000,
    },
  });
  const receiver = createRoom({ name: "W68N21", storageFreeCapacity: 500_000 });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
    (amount: number) => Math.ceil(amount / 10),
  );
  const created = createResourceTransferTask(
    donor.name,
    receiver.name,
    RESOURCE_KEANIUM,
    10_000,
    "manual:test",
  );
  if (typeof created === "string") throw new Error(created);

  runResourceControl();

  expect(donor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_KEANIUM,
    7_500,
    receiver.name,
    expect.any(String),
  );
  expect(created.task).toMatchObject({
    status: "pending",
    remainingAmount: 2_500,
    lastProgressAt: 10,
  });
});

it("keeps a staged non-energy task pending when no positive batch is fee-affordable", () => {
  const donor = createRoom({
    name: "W68N22",
    terminalResources: { [RESOURCE_KEANIUM]: 1_000 },
  });
  const receiver = createRoom({ name: "W68N23", storageFreeCapacity: 500_000 });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
    (amount: number) => Math.max(1, Math.ceil(amount / 10)),
  );
  const created = createResourceTransferTask(
    donor.name,
    receiver.name,
    RESOURCE_KEANIUM,
    1_000,
    "manual:test",
  );
  if (typeof created === "string") throw new Error(created);

  runResourceControl();

  expect(donor.terminal!.send).not.toHaveBeenCalled();
  expect(created.task).toMatchObject({
    status: "pending",
    remainingAmount: 1_000,
    blockedReason: "insufficient_terminal_resource_or_fee",
    blockedSince: 10,
  });
});
```

- [ ] **Step 2: Run the four cases and confirm RED**

Run:

```bash
npm test -- --runInBand src/runtime/resourceControl.test.ts -t "plans non-energy relief even when fee energy is below floor and reserve|allows non-energy relief to spend terminal energy below terminalEnergyReserve|shrinks a non-energy send to the largest fee-affordable batch|keeps a staged non-energy task pending when no positive batch is fee-affordable"
```

Expected: FAIL because planning returns no task, reserve energy is protected, and the old halving loop cannot return 7,500.

- [ ] **Step 3: Separate non-energy planning from exact execution affordability**

Add this helper immediately before `computeSendAmount`:

```ts
function computeLargestAffordableAmount(
  maximum: number,
  canAfford: (amount: number) => boolean,
): number {
  let low = 1;
  let high = Math.max(0, Math.floor(maximum));
  let result = 0;

  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (canAfford(candidate)) {
      result = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }

  return result;
}
```

Replace `computeSendAmount` with this intermediate implementation; the energy branch intentionally retains its old reserve behavior until Task 4:

```ts
function computeSendAmount(
  donor: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  targetAmount: number,
): number {
  const availableResource = donor.terminal.store.getUsedCapacity(resource);
  const maximum = Math.floor(
    Math.min(targetAmount, donor.transferBatchSize, availableResource),
  );
  const spendableEnergy = resource === RESOURCE_ENERGY
    ? getEnergyAvailableForFees(donor)
    : donor.terminalEnergy;

  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      donor.roomName,
      receiverRoomName,
    );
    const requiredEnergy = resource === RESOURCE_ENERGY ? amount + fee : fee;
    return requiredEnergy <= spendableEnergy;
  });
}
```

Replace `computeSafeCapacityReliefAmount` with:

```ts
function computeSafeCapacityReliefAmount(
  source: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  requestedAmount: number,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  const resourceMovable = getTotalMovableResourceAmount(
    source,
    resource,
    config,
    context,
    excludeTaskId,
  );
  const candidate = Math.floor(Math.min(requestedAmount, resourceMovable));
  if (resource !== RESOURCE_ENERGY) {
    return candidate;
  }

  const energyBudget = getTotalMovableResourceAmount(
    source,
    RESOURCE_ENERGY,
    config,
    context,
    excludeTaskId,
  );
  return computeLargestAffordableAmount(candidate, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    return amount + fee <= energyBudget;
  });
}
```

- [ ] **Step 4: Run RED cases, safety guards, and the complete resource-control suites**

Run:

```bash
npm test -- --runInBand src/runtime/resourceControl.test.ts -t "plans non-energy relief even when fee energy is below floor and reserve|allows non-energy relief to spend terminal energy below terminalEnergyReserve|shrinks a non-energy send to the largest fee-affordable batch|keeps a staged non-energy task pending when no positive batch is fee-affordable"
npm test -- --runInBand src/runtime/resourceControl.test.ts -t "does not overcommit one receiver across newly planned routes|uses configured receiver safety buffers for every queued send|shares receiver safety capacity across multiple sends in one run|reserves terminal energy for pending non-energy transfer fees"
npm test -- --runInBand src/runtime/resourceControl.test.ts src/runtime/resourceControl.capacityRegression.test.ts
```

Expected: all commands PASS; receiver safety, fee staging, and same-tick capacity reservations remain green.

- [ ] **Step 5: Commit non-energy logistics semantics**

```bash
git add src/runtime/resourceControl.ts src/runtime/resourceControl.test.ts
git commit -m "fix(resource-control): spend terminal energy on logistics fees"
```

---

### Task 4: Enforce target/export semantics for energy logistics

**Files:**
- Modify: `src/runtime/resourceControl.ts:550-552,655-668,696-851,862-895,943-1041,1364-1540,1632-1681,1924-1932,2466-2525`
- Modify: `src/runtime/resourceControl.test.ts:1245-1292,3500-3700,3701-4392,4826-4875`

**Interfaces:**
- Consumes: `computeLargestAffordableAmount` from Task 3 and the shared normalized `energyTarget`/`energyExportStart` values from Task 1.
- Produces: `isEnergyExportEligible(snapshot): boolean`; `getEnergyBalancingSurplus(snapshot, context, excludeTaskId?): number`; one shared `remainingEnergyNeedByRoom` ledger used by immediate balance and queued sends.

- [ ] **Step 1: Write energy-policy RED tests and update obsolete expectations**

In `resource-control capacity state`, replace the old terminal-heavy donor test and add the target/terminal/same-tick cases:

```ts
it("requires donor storage to reach energyExportStart even when total energy is high", () => {
  const donor = createRoom({
    name: "W60N5",
    storageResources: { [RESOURCE_ENERGY]: 249_999 },
    terminalResources: { [RESOURCE_ENERGY]: 100_000 },
  });
  const receiver = createRoom({
    name: "W60N6",
    storageResources: { [RESOURCE_ENERGY]: 50_000 },
    terminalResources: {},
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  runResourceControl();
  expect(donor.terminal!.send).not.toHaveBeenCalledWith(
    RESOURCE_ENERGY,
    expect.any(Number),
    receiver.name,
    "resourceControl:auto-balance",
  );
});

it("balances a room below energyTarget even when legacy state is balanced", () => {
  const donor = createRoom({
    name: "W60N5B",
    storageResources: { [RESOURCE_ENERGY]: 250_000 },
    terminalResources: { [RESOURCE_ENERGY]: 30_000 },
  });
  const receiver = createRoom({
    name: "W60N6B",
    storageResources: { [RESOURCE_ENERGY]: 150_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  runResourceControl();
  expect(donor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_ENERGY,
    10_000,
    receiver.name,
    "resourceControl:auto-balance",
  );
});

it("uses actual terminal energy for cargo and fee below terminalEnergyReserve", () => {
  const donor = createRoom({
    name: "W60N5C",
    storageResources: { [RESOURCE_ENERGY]: 250_000 },
    terminalResources: { [RESOURCE_ENERGY]: 12_000 },
  });
  const receiver = createRoom({
    name: "W60N6C",
    storageResources: { [RESOURCE_ENERGY]: 150_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 3_000);
  runResourceControl();
  expect(donor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_ENERGY,
    9_000,
    receiver.name,
    "resourceControl:auto-balance",
  );
});

it("retains energyTarget after production commitment and exact fee", () => {
  const donor = createRoom({
    name: "W60N5D",
    storageResources: { [RESOURCE_ENERGY]: 320_000 },
    terminalResources: { [RESOURCE_ENERGY]: 100_000 },
  });
  const receiver = createRoom({
    name: "W60N6D",
    storageResources: { [RESOURCE_ENERGY]: 150_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  Memory.cfg!.resourceControl!.rooms = {
    [donor.name]: {
      energyTarget: 320_000,
      energyExportStart: 320_000,
      transferBatchSize: 50_000,
    },
  };
  reserveProductionResource(donor.name, RESOURCE_ENERGY, 70_000, "factory:test");
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 10_000);
  runResourceControl();
  expect(donor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_ENERGY,
    20_000,
    receiver.name,
    "resourceControl:auto-balance",
  );
});

it("does not overfill one energy target across same-tick donors", () => {
  const donors = ["W60N7A", "W60N7B"].map((name) => createRoom({
    name,
    storageResources: { [RESOURCE_ENERGY]: 250_000 },
    terminalResources: { [RESOURCE_ENERGY]: 30_000 },
  }));
  const receiver = createRoom({
    name: "W60N7C",
    storageResources: { [RESOURCE_ENERGY]: 195_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
  });
  Memory.cfg!.resourceControl!.rooms = {
    [receiver.name]: { energyFloor: 200_000, energyTarget: 200_000 },
  };
  for (const room of [...donors, receiver]) Game.rooms[room.name] = room;
  runResourceControl();
  const sent = donors.reduce((sum, room) => {
    const call = (room.terminal!.send as jest.Mock).mock.calls.find(
      (entry) => entry[3] === "resourceControl:auto-balance",
    );
    return sum + (call?.[1] || 0);
  }, 0);
  expect(sent).toBe(5_000);
});
```

Update the two existing commitment tests so they exercise the new donor gate and exhaust the real target budget:

```ts
// Healthy pending outgoing task case
storageResources: { [RESOURCE_ENERGY]: 250_000 },
terminalResources: { [RESOURCE_ENERGY]: 30_000 },
createResourceTransferTask(
  donor.name,
  committedReceiver.name,
  RESOURCE_ENERGY,
  80_000,
  "manual:committed",
);

// Production reservation case
storageResources: { [RESOURCE_ENERGY]: 250_000 },
terminalResources: { [RESOURCE_ENERGY]: 30_000 },
reserveProductionResource(donor.name, RESOURCE_ENERGY, 80_000, "factory:test");
```

Replace `prioritizes survival energy transfers over hub exports` with a target-based priority case:

```ts
it("prioritizes energy transfers to rooms below energyTarget without survival state", () => {
  const receiver = createRoom({
    name: "W11N1",
    storageResources: { [RESOURCE_ENERGY]: 150_000 },
    terminalResources: { [RESOURCE_ENERGY]: 5_000 },
  });
  const energyDonor = createRoom({
    name: "W11N2",
    storageResources: { [RESOURCE_ENERGY]: 250_000 },
    terminalResources: { [RESOURCE_ENERGY]: 30_000 },
  });
  const mineralDonor = createRoom({
    name: "W11N3",
    storageResources: { [RESOURCE_ENERGY]: 200_000 },
    terminalResources: {
      [RESOURCE_ENERGY]: 25_000,
      [RESOURCE_KEANIUM]: 5_000,
    },
  });
  const mineralReceiver = createRoom({ name: "W11N4" });
  for (const room of [receiver, energyDonor, mineralDonor, mineralReceiver]) {
    Game.rooms[room.name] = room;
  }
  Memory.cfg!.resourceControl!.taskMaxPerRun = 1;
  createResourceTransferTask(
    mineralDonor.name,
    mineralReceiver.name,
    RESOURCE_KEANIUM,
    3_000,
    "manual:priority",
  );
  createResourceTransferTask(
    energyDonor.name,
    receiver.name,
    RESOURCE_ENERGY,
    5_000,
    "energy-support",
  );
  runResourceControl();
  expect(energyDonor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_ENERGY,
    5_000,
    receiver.name,
    expect.any(String),
  );
  expect(mineralDonor.terminal!.send).not.toHaveBeenCalled();
});

it("keeps a queued energy transfer pending below energyExportStart", () => {
  const donor = createRoom({
    name: "W11N5",
    storageResources: { [RESOURCE_ENERGY]: 249_999 },
    terminalResources: { [RESOURCE_ENERGY]: 30_000 },
  });
  const receiver = createRoom({
    name: "W11N6",
    storageResources: { [RESOURCE_ENERGY]: 50_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  const created = createResourceTransferTask(
    donor.name,
    receiver.name,
    RESOURCE_ENERGY,
    5_000,
    "energy-support",
  );
  if (typeof created === "string") throw new Error(created);
  runResourceControl();
  expect(donor.terminal!.send).not.toHaveBeenCalled();
  expect(created.task).toMatchObject({
    status: "pending",
    remainingAmount: 5_000,
    blockedReason: "insufficient_terminal_resource_or_fee",
  });
});

it("caps a queued energy transfer by target commitments and exact fee", () => {
  const donor = createRoom({
    name: "W11N7",
    storageResources: { [RESOURCE_ENERGY]: 320_000 },
    terminalResources: { [RESOURCE_ENERGY]: 100_000 },
  });
  const receiver = createRoom({
    name: "W11N8",
    storageResources: { [RESOURCE_ENERGY]: 150_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
  });
  Game.rooms[donor.name] = donor;
  Game.rooms[receiver.name] = receiver;
  Memory.cfg!.resourceControl!.rooms = {
    [donor.name]: {
      energyTarget: 320_000,
      energyExportStart: 320_000,
      transferBatchSize: 50_000,
    },
  };
  reserveProductionResource(donor.name, RESOURCE_ENERGY, 70_000, "factory:test");
  (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 10_000);
  const created = createResourceTransferTask(
    donor.name,
    receiver.name,
    RESOURCE_ENERGY,
    50_000,
    "energy-support",
  );
  if (typeof created === "string") throw new Error(created);
  runResourceControl();
  expect(donor.terminal!.send).toHaveBeenCalledWith(
    RESOURCE_ENERGY,
    20_000,
    receiver.name,
    expect.any(String),
  );
  expect(created.task).toMatchObject({
    status: "pending",
    remainingAmount: 30_000,
  });
});
```

Add this case to `capacity-relief planning`:

```ts
it("does not plan energy relief below energyExportStart", () => {
  const source = createRoom({
    name: "W61N22",
    storageResources: { [RESOURCE_ENERGY]: 249_999 },
    terminalResources: { [RESOURCE_ENERGY]: 100_000 },
    storageFreeCapacity: 50_000,
  });
  source.terminal!.cooldown = 1;
  const receiver = createRoom({
    name: "W61N23",
    storageResources: { [RESOURCE_ENERGY]: 200_000 },
    terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    storageFreeCapacity: 500_000,
  });
  Game.rooms[source.name] = source;
  Game.rooms[receiver.name] = receiver;
  runResourceControl();
  expect(
    Object.values(ensureResourceTransferTaskStore()).filter(
      (task) => task.reason === `capacity:relief:${RESOURCE_ENERGY}`,
    ),
  ).toHaveLength(0);
});
```

In `shares the five-send budget between survival support and queued transfers`, change the immediate energy donor to:

```ts
const energyDonor = createRoom({
  name: "W69N0",
  storageResources: { [RESOURCE_ENERGY]: 250_000 },
  terminalResources: { [RESOURCE_ENERGY]: 100_000 },
});
```

In `includes fee budget in export staging for auto-balance receivers`, change the receiver to the target-deficit but non-survival value below; keep the existing expected terminal-feed amount of 30,000:

```ts
const receiver = createRoom({
  name: "W8N4",
  storageResources: { [RESOURCE_ENERGY]: 150_000 },
  terminalResources: {},
});
```

- [ ] **Step 2: Run the energy cases and confirm RED**

Run:

```bash
npm test -- --runInBand src/runtime/resourceControl.test.ts -t "requires donor storage to reach energyExportStart|balances a room below energyTarget|uses actual terminal energy for cargo and fee|retains energyTarget after production commitment|does not overfill one energy target|prioritizes energy transfers to rooms below energyTarget|keeps a queued energy transfer pending|caps a queued energy transfer|does not plan energy relief below energyExportStart|includes fee budget in export staging|shares the five-send budget"
```

Expected: FAIL under the legacy `survival`/`energyFloor + terminalEnergyReserve` logic.

- [ ] **Step 3: Replace energy logistics decisions with target/export helpers**

Replace `getStock` and `getEnergyBalancingSurplus` with:

```ts
function getStock(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
  if (resource === RESOURCE_ENERGY) {
    return snapshot.storageEnergy + snapshot.terminalEnergy;
  }
  return (snapshot.storage?.store.getUsedCapacity(resource) || 0) +
    snapshot.terminal.store.getUsedCapacity(resource);
}

function isEnergyExportEligible(snapshot: ResourceControlSnapshot): boolean {
  return snapshot.storageEnergy >= snapshot.energyExportStart;
}

function getEnergyBalancingSurplus(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (!isEnergyExportEligible(snapshot)) {
    return 0;
  }
  return Math.max(
    0,
    getStock(snapshot, RESOURCE_ENERGY) -
      snapshot.energyTarget -
      getProductionCommitmentAmount(snapshot.roomName, RESOURCE_ENERGY, context) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
        excludeTaskId,
      ) -
      getOutgoingTransactionFeeReserve(snapshot, context, excludeTaskId),
  );
}
```

Replace `computeSendAmount` and `computeTransferAmount` with:

```ts
function computeSendAmount(
  donor: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  targetAmount: number,
): number {
  const availableResource = resource === RESOURCE_ENERGY
    ? donor.terminalEnergy
    : donor.terminal.store.getUsedCapacity(resource);
  const maximum = Math.floor(
    Math.min(targetAmount, donor.transferBatchSize, availableResource),
  );
  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      donor.roomName,
      receiverRoomName,
    );
    const requiredEnergy = resource === RESOURCE_ENERGY ? amount + fee : fee;
    return requiredEnergy <= donor.terminalEnergy;
  });
}

function computeTransferAmount(
  from: ResourceControlSnapshot,
  to: ResourceControlSnapshot,
  receiverNeed: number,
  receiverCapacity: number,
  context: ResourceControlTransferContext,
): number {
  if (receiverNeed <= 0 || receiverCapacity <= 0) {
    return 0;
  }
  const donorBudget = getEnergyBalancingSurplus(from, context);
  const terminalBudget = Math.max(
    0,
    from.terminalEnergy - getOutgoingTransactionFeeReserve(from, context),
  );
  const maximum = Math.floor(
    Math.min(
      from.transferBatchSize,
      receiverNeed,
      receiverCapacity,
      donorBudget,
      from.terminalEnergy,
    ),
  );
  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(amount, from.roomName, to.roomName);
    return amount + fee <= donorBudget && amount + fee <= terminalBudget;
  });
}
```

Replace `applyInternalBalancing` with:

```ts
function applyInternalBalancing(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  sendBudget: InternalSendBudget,
  context: ResourceControlTransferContext,
  receiverCapacityByRoom: Map<string, number>,
  remainingEnergyNeedByRoom: Map<string, number>,
): string[] {
  const actions: string[] = [];
  const donors = snapshots
    .filter(
      (snapshot) =>
        snapshot.terminal.cooldown === 0 &&
        getEnergyBalancingSurplus(snapshot, context) > 0,
    )
    .sort(
      (left, right) =>
        getEnergyBalancingSurplus(right, context) -
        getEnergyBalancingSurplus(left, context),
    );
  const receivers = snapshots
    .filter((snapshot) => (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0)
    .filter((snapshot) => !context.healthyIncomingEnergyRooms.has(snapshot.roomName))
    .sort((left, right) => {
      const needDiff =
        (remainingEnergyNeedByRoom.get(right.roomName) || 0) -
        (remainingEnergyNeedByRoom.get(left.roomName) || 0);
      return needDiff || left.roomName.localeCompare(right.roomName);
    });

  for (const donor of donors) {
    if (sendBudget.remaining <= 0) break;
    if (terminalBusy.has(donor.roomName)) continue;

    for (const receiver of receivers) {
      if (donor.roomName === receiver.roomName) continue;
      const receiverCapacity = receiverCapacityByRoom.get(receiver.roomName) || 0;
      const receiverNeed = remainingEnergyNeedByRoom.get(receiver.roomName) || 0;
      const amount = computeTransferAmount(
        donor,
        receiver,
        receiverNeed,
        receiverCapacity,
        context,
      );
      if (amount <= 0) continue;

      const code = donor.terminal.send(
        RESOURCE_ENERGY,
        amount,
        receiver.roomName,
        "resourceControl:auto-balance",
      );
      if (code !== OK) {
        actions.push(`send-failed:${donor.roomName}->${receiver.roomName}:code=${code}`);
        continue;
      }
      recordFixedCpuAction("resourceControl");
      const transferCost = applyPostSendDelta(
        donor,
        receiver,
        RESOURCE_ENERGY,
        amount,
      );
      receiverCapacityByRoom.set(receiver.roomName, Math.max(0, receiverCapacity - amount));
      remainingEnergyNeedByRoom.set(receiver.roomName, Math.max(0, receiverNeed - amount));
      actions.push(
        `send:${donor.roomName}->${receiver.roomName}:energy=${amount}:cost=${transferCost}`,
      );
      terminalBusy.add(donor.roomName);
      sendBudget.remaining -= 1;
      break;
    }
  }

  return actions;
}
```

Replace `getTransferTaskPriority` with:

```ts
function getTransferTaskPriority(
  task: ResourceTransferTask,
  energyDeficitRooms: Set<string>,
  storageConstrainedRooms: Set<string>,
  capacityStateByRoom: Map<string, ResourceCapacityState>,
): number {
  if (task.resource === RESOURCE_ENERGY && energyDeficitRooms.has(task.toRoomName)) return 0;
  const reason = task.reason;
  if (task.origin === "manual" && (!reason || reason.startsWith("manual:"))) return 1;
  if (!reason) return 3;
  if (reason.startsWith("capacity:relief:")) {
    return capacityStateByRoom.get(task.fromRoomName) === "emergency" ? 1 : 3;
  }
  if (
    reason.startsWith("synthesis:") ||
    reason.startsWith("auto:synthesis:") ||
    reason.startsWith("powerBankBoost")
  ) return 2;
  if (reason.startsWith("hub:export:") && storageConstrainedRooms.has(task.fromRoomName)) return 4;
  if (reason.startsWith("hub:import:")) return 5;
  if (reason.startsWith("hub:reclaim:")) return 6;
  if (reason.startsWith("hub:export:")) return 7;
  return 3;
}
```

Replace `getProtectedResourceAmount` and both movable helpers with:

```ts
function getProtectedResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  let safetyFloor = snapshot.mineralFloor[resource] || 0;
  if (resource === RESOURCE_ENERGY) {
    safetyFloor =
      snapshot.energyTarget +
      getOutgoingTransactionFeeReserve(snapshot, context, excludeTaskId);
  } else if (HUB_TARGET_COMPOUNDS.includes(resource)) {
    safetyFloor = Math.max(safetyFloor, config.t3ReservePerRoom);
  }
  return safetyFloor +
    getProductionCommitmentAmount(snapshot.roomName, resource, context);
}

function getMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  location: "storage" | "terminal",
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY && !isEnergyExportEligible(snapshot)) return 0;
  const totalStock = getStock(snapshot, resource);
  const movableTotal = Math.max(
    0,
    totalStock -
      getProtectedResourceAmount(snapshot, resource, config, context, excludeTaskId) -
      getHealthyOutgoingCommitment(snapshot.roomName, resource, context, excludeTaskId),
  );
  const structureStock = location === "terminal"
    ? snapshot.terminal.store.getUsedCapacity(resource)
    : snapshot.storage?.store.getUsedCapacity(resource) || 0;
  return Math.min(structureStock, movableTotal);
}

function getTotalMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY && !isEnergyExportEligible(snapshot)) return 0;
  return Math.max(
    0,
    getStock(snapshot, resource) -
      getProtectedResourceAmount(snapshot, resource, config, context, excludeTaskId) -
      getHealthyOutgoingCommitment(snapshot.roomName, resource, context, excludeTaskId),
  );
}
```

Change `executeTransferTasks` to accept the shared need ledger:

```ts
function executeTransferTasks(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  capacityConfig: ResourceCapacityConfig,
  sendBudget: InternalSendBudget,
  capacityReliefRoutes: CapacityReliefRoute[],
  receiverCapacityByRoom: Map<string, number>,
  remainingEnergyNeedByRoom: Map<string, number>,
  context: ResourceControlTransferContext,
): string[] {
```

Replace its `survivalRooms` set with:

```ts
const energyDeficitRooms = new Set(
  snapshots
    .filter((snapshot) => (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0)
    .map((snapshot) => snapshot.roomName),
);
```

Pass `energyDeficitRooms` to both `getTransferTaskPriority` calls. Immediately after calculating the base `requestedAmount`, add:

```ts
if (task.resource === RESOURCE_ENERGY) {
  const receiverNeed = remainingEnergyNeedByRoom.get(receiver.roomName) || 0;
  if (receiverNeed <= 0) {
    markResourceTransferTaskBlocked(task, "receiver_capacity");
    continue;
  }
  const exportBudget = getEnergyBalancingSurplus(donor, context, task.id);
  const maximum = Math.min(requestedAmount, receiverNeed, exportBudget);
  requestedAmount = computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      donor.roomName,
      receiver.roomName,
    );
    return amount + fee <= exportBudget;
  });
  if (requestedAmount <= 0) {
    markResourceTransferTaskBlocked(task, "insufficient_terminal_resource_or_fee");
    continue;
  }
}
```

Immediately after a successful send updates `receiverCapacityByRoom`, add:

```ts
if (task.resource === RESOURCE_ENERGY) {
  remainingEnergyNeedByRoom.set(
    receiver.roomName,
    Math.max(
      0,
      (remainingEnergyNeedByRoom.get(receiver.roomName) || 0) - amount,
    ),
  );
}
```

Replace `getPlannedEnergySendBatch`, `getEnergySendFeeBudget`, and `getResourceControlDonorAvailable` with:

```ts
function getPlannedEnergySendBatch(
  room: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
): number {
  if (!isEnergyExportEligible(room)) return 0;
  const outgoingEnergy = context.healthyOutgoingByRoomResource.get(
    roomResourceKey(room.roomName, RESOURCE_ENERGY),
  ) || 0;
  return outgoingEnergy > 0
    ? Math.min(room.transferBatchSize, outgoingEnergy)
    : room.transferBatchSize;
}
```

```ts
function getEnergySendFeeBudget(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  amount: number,
  context: ResourceControlTransferContext,
): number {
  if (amount <= 0) {
    return context.outgoingFeeByRoom.get(room.roomName) || 0;
  }
  const outgoingEnergy = context.healthyOutgoingByRoomResource.get(
    roomResourceKey(room.roomName, RESOURCE_ENERGY),
  ) || 0;
  const pendingFeeBudget = context.outgoingFeeByRoom.get(room.roomName) || 0;
  if (outgoingEnergy > 0 || !isEnergyExportEligible(room)) {
    return pendingFeeBudget;
  }
  const receiver = snapshots
    .filter(
      (snapshot) =>
        snapshot.roomName !== room.roomName &&
        snapshot.storageEnergy < snapshot.energyTarget,
    )
    .sort((left, right) => {
      const leftNeed = left.energyTarget - left.storageEnergy;
      const rightNeed = right.energyTarget - right.storageEnergy;
      return rightNeed - leftNeed || left.roomName.localeCompare(right.roomName);
    })[0];
  return receiver
    ? pendingFeeBudget + Game.market.calcTransactionCost(
        amount,
        room.roomName,
        receiver.roomName,
      )
    : pendingFeeBudget;
}
```

```ts
export function getResourceControlDonorAvailable(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const total = getStock(snapshot, resource);
  if (resource === RESOURCE_ENERGY) {
    return isEnergyExportEligible(snapshot)
      ? Math.max(0, total - snapshot.energyTarget)
      : 0;
  }
  const floor = snapshot.mineralFloor[resource] || 0;
  return Math.max(0, total - floor);
}
```

In `runResourceControl`, create and pass the shared need ledger:

```ts
const remainingEnergyNeedByRoom = new Map(
  snapshots.map((snapshot) => [
    snapshot.roomName,
    Math.max(0, snapshot.energyTarget - snapshot.storageEnergy),
  ]),
);
```

Use these exact calls:

```ts
const actions = applyInternalBalancing(
  snapshots,
  terminalBusy,
  sendBudget,
  planningContext,
  receiverCapacityByRoom,
  remainingEnergyNeedByRoom,
);
```

```ts
const taskActions = executeTransferTasks(
  snapshots,
  terminalBusy,
  capacityConfig,
  sendBudget,
  capacityReliefRoutes,
  receiverCapacityByRoom,
  remainingEnergyNeedByRoom,
  executionContext,
);
```

- [ ] **Step 4: Run focused energy tests, both resource-control suites, and type checking**

Run:

```bash
npm test -- --runInBand src/runtime/resourceControl.test.ts -t "requires donor storage to reach energyExportStart|balances a room below energyTarget|uses actual terminal energy for cargo and fee|retains energyTarget after production commitment|does not overfill one energy target|prioritizes energy transfers to rooms below energyTarget|keeps a queued energy transfer pending|caps a queued energy transfer|does not plan energy relief below energyExportStart|includes fee budget in export staging|shares the five-send budget"
npm test -- --runInBand src/runtime/resourceControl.test.ts src/runtime/resourceControl.capacityRegression.test.ts
npx tsc --noEmit
```

Expected: all tests PASS and TypeScript exits 0. Existing market tests must remain green because `resolveState` and `getEnergyAvailableForFees` are unchanged for market policy.

- [ ] **Step 5: Commit energy logistics semantics**

```bash
git add src/runtime/resourceControl.ts src/runtime/resourceControl.test.ts
git commit -m "fix(resource-control): separate worker and logistics energy policy"
```

---

### Task 5: Version and complete verification

**Files:**
- Modify: `package.json:2`
- Verify: all files changed in Tasks 1-4

**Interfaces:**
- Consumes: all completed task commits.
- Produces: release-ready local branch tagged by package version `2026.7.14-1`; no remote deployment.

- [ ] **Step 1: Advance the date-based version**

Change the package header to:

```json
{
  "name": "screeps",
  "version": "2026.7.14-1",
  "description": "Screeps local development workspace"
}
```

Do not run `npm install`; `package-lock.json` intentionally retains its existing historical version metadata.

- [ ] **Step 2: Run the full verification ladder**

Run:

```bash
npm test -- --runInBand src/runtime/roomEnergyPolicy.test.ts src/runtime/autoReserveFlag.test.ts
npm test -- --runInBand src/runtime/resourceControl.test.ts src/runtime/resourceControl.capacityRegression.test.ts
npx tsc --noEmit
npm run build
npm test -- --runInBand
git diff --check
```

Expected: focused suites PASS, TypeScript exits 0, Rollup builds `dist/main.js`, all Jest suites PASS, and `git diff --check` prints nothing.

- [ ] **Step 3: Review scope and generated-file state**

Run:

```bash
git status --short
git diff --stat fd40c42
git diff fd40c42 -- package.json src/runtime/roomEnergyPolicy.ts src/runtime/autoReserveFlag.ts src/runtime/resourceControl.ts
```

Expected: only the planned source/tests/version files are changed; `dist/`, `.secret.json`, `package-lock.json`, market rules, factory control, main-loop order, and creep roles are absent from the diff.

- [ ] **Step 4: Commit the version bump**

```bash
git add package.json
git commit -m "chore(v2026.07.14-1): prepare terminal logistics fix"
```

- [ ] **Step 5: Re-run post-commit verification evidence**

Run:

```bash
git status --short --branch
git log --oneline --decorate -6
npm test -- --runInBand
```

Expected: clean branch, five implementation commits after `fd40c42`, and the full Jest suite remains green. Stop before `npm run push`; deployment requires separate user authorization and live-shard verification.
