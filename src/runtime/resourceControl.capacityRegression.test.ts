import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";
import {
  createAutomaticResourceTransferTask,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";
import { runResourceControl } from "@/runtime/resourceControl";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
type MutableStore = StoreDefinition & { set(resource: ResourceConstant, amount: number): void };
type GameWithPartialMarket = Omit<Game, "market"> & { market: Partial<Market> };

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createMutableStore(
  capacity: number,
  initial: Partial<Record<ResourceConstant, number>>,
): MutableStore {
  const amounts: Partial<Record<ResourceConstant, number>> = { ...initial };
  const store = {
    ...initial,
    getUsedCapacity(resource?: ResourceConstant): number {
      if (resource) return amounts[resource] || 0;
      return Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
    },
    getFreeCapacity(): number {
      return Math.max(0, capacity - this.getUsedCapacity());
    },
    getCapacity(): number {
      return capacity;
    },
    set(resource: ResourceConstant, amount: number): void {
      const normalized = Math.max(0, Math.floor(amount));
      amounts[resource] = normalized;
      (store as unknown as Record<string, unknown>)[resource] = normalized;
    },
  } as unknown as MutableStore;
  return store;
}

function createMutableRoom(
  name: string,
  storageInitial: Partial<Record<ResourceConstant, number>>,
  terminalInitial: Partial<Record<ResourceConstant, number>>,
): Room {
  const storageStore = createMutableStore(1_000_000, storageInitial);
  const terminalStore = createMutableStore(300_000, terminalInitial);
  const terminal = {
    id: `${name}-terminal`,
    structureType: STRUCTURE_TERMINAL,
    cooldown: 0,
    store: terminalStore,
    send: jest.fn((resource: ResourceConstant, amount: number, toRoomName: string) => {
      const receiver = Game.rooms[toRoomName]?.terminal;
      if (!receiver) return ERR_INVALID_TARGET;
      if (terminalStore.getUsedCapacity(resource) < amount) return ERR_NOT_ENOUGH_RESOURCES;
      if (receiver.store.getFreeCapacity() < amount) return ERR_FULL;

      terminalStore.set(resource, terminalStore.getUsedCapacity(resource) - amount);
      const receiverStore = receiver.store as unknown as MutableStore;
      receiverStore.set(resource, receiverStore.getUsedCapacity(resource) + amount);
      return OK;
    }),
  } as unknown as StructureTerminal;

  return {
    name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: storageStore,
    } as unknown as StructureStorage,
    terminal,
    find(type: FindConstant) {
      if (type === FIND_MINERALS || type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) return [];
      return [];
    },
  } as unknown as Room;
}

function executeTerminalOffloadTasks(room: Room): number {
  const terminalStore = room.terminal!.store as unknown as MutableStore;
  const storageStore = room.storage!.store as unknown as MutableStore;
  let moved = 0;
  for (const task of Object.values(getCarrierTasksByRoom(room.name))) {
    if (task.type !== "terminal_offload") continue;
    for (const step of task.steps) {
      if (step.fromKind !== "terminal" || step.toKind !== "storage") continue;
      const amount = Math.min(step.amount, terminalStore.getUsedCapacity(step.resource));
      terminalStore.set(step.resource, terminalStore.getUsedCapacity(step.resource) - amount);
      storageStore.set(step.resource, storageStore.getUsedCapacity(step.resource) + amount);
      moved += amount;
    }
  }
  return moved;
}

describe("resource control live-like capacity recovery", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        taskMaxPerRun: 5,
        market: { enabled: false },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  it("recovers multiple full terminals without stale-task leaks, reserve loss, or ping-pong", () => {
    const sourceA = createMutableRoom(
      "W80N1",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 265_000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5_000,
      },
    );
    const sourceB = createMutableRoom(
      "W80N2",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 270_000,
      },
    );
    const receiver = createMutableRoom(
      "W80N3",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const staleTaskSource = createMutableRoom(
      "W80N4",
      { [RESOURCE_ENERGY]: 750_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[sourceA.name] = sourceA;
    Game.rooms[sourceB.name] = sourceB;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[staleTaskSource.name] = staleTaskSource;

    Game.time = 0;
    const staleAutomatic = createAutomaticResourceTransferTask(
      staleTaskSource.name,
      receiver.name,
      RESOURCE_OXYGEN,
      1_000,
      "synthesis:stale",
    );
    const staleManual = createResourceTransferTask(
      staleTaskSource.name,
      receiver.name,
      RESOURCE_LEMERGIUM,
      1_000,
      "manual:keep",
    );
    if (typeof staleAutomatic === "string") throw new Error(staleAutomatic);
    if (typeof staleManual === "string") throw new Error(staleManual);

    for (let tick = 6_000; tick <= 6_090; tick += 10) {
      Game.time = tick;
      runResourceControl();
    }

    expect(staleAutomatic.task).toMatchObject({
      status: "cancelled",
      lastError: "automatic_no_progress_timeout",
    });
    expect(staleManual.task).toMatchObject({
      status: "pending",
      blockedReason: "source_depleted",
      blockedSince: 6_000,
    });

    expect(sourceA.terminal!.store.getFreeCapacity()).toBeGreaterThanOrEqual(80_000);
    expect(sourceB.terminal!.store.getFreeCapacity()).toBeGreaterThanOrEqual(80_000);
    expect(sourceA.terminal!.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ALKALIDE)).toBe(5_000);
    expect(sourceA.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBeGreaterThanOrEqual(20_000);
    expect(sourceB.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBeGreaterThanOrEqual(20_000);
    expect(receiver.terminal!.store.getFreeCapacity()).toBeGreaterThanOrEqual(40_000);
    expect(receiver.storage!.store.getFreeCapacity()).toBeGreaterThanOrEqual(100_000);

    expect(Memory.runtime?.resourceControl?.rooms[sourceA.name]?.capacityState).toBe("normal");
    expect(Memory.runtime?.resourceControl?.rooms[sourceB.name]?.capacityState).toBe("normal");
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]?.capacityState).toBe("normal");

    const capacityTasks = Object.values(ensureResourceTransferTaskStore()).filter((task) =>
      task.reason?.startsWith("capacity:relief:"),
    );
    expect(capacityTasks.length).toBeGreaterThanOrEqual(4);
    expect(capacityTasks.every((task) => task.fromRoomName !== receiver.name)).toBe(true);
    expect(capacityTasks.filter((task) => task.status === "pending")).toHaveLength(0);
    expect(Memory.runtime?.resourceControl?.recentCapacityReliefRoutes?.length).toBe(16);
  });

  it("keeps an exact-admission receiver normal instead of ping-ponging next cycle", () => {
    const source = createMutableRoom(
      "W81N1",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
    );
    const receiver = createMutableRoom(
      "W81N2",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 250_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    Game.time = 10;
    runResourceControl();
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]).toMatchObject({
      terminalUsedCapacity: receiver.terminal!.store.getUsedCapacity(),
      terminalFreeCapacity: receiver.terminal!.store.getFreeCapacity(),
    });
    expect(Memory.runtime?.resourceControl?.capacityIndexBuildCount).toBe(1);
    Game.time = 20;
    runResourceControl();

    expect(receiver.terminal!.store.getFreeCapacity()).toBe(40_001);
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]?.capacityState).toBe("normal");
    expect(
      Object.values(ensureResourceTransferTaskStore()).filter(
        (task) => task.reason?.startsWith("capacity:relief:") && task.fromRoomName === receiver.name,
      ),
    ).toHaveLength(0);
  });

  it("recovers a sticky 50000-free terminal through real carrier moves without next-cycle jitter", () => {
    const room = createMutableRoom(
      "W82N1",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_HYDROGEN]: 225_000,
      },
    );
    Game.rooms[room.name] = room;
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: true,
    };
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [room.name]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;

    let originalCreatedAt: number | undefined;
    for (const [index, expectedFreeCapacity] of [60_000, 70_000, 80_000].entries()) {
      Game.time = 10 + index * 10;
      resetRuntimeServices();
      runResourceControl();

      expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("pressure");
      const tasks = getCarrierTasksByRoom(room.name);
      const offload = tasks[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ];
      expect(offload).toMatchObject({
        id: `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`,
        type: "terminal_offload",
        steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
      });
      expect(Object.values(tasks).filter((task) => task.type === "terminal_feed")).toHaveLength(0);
      originalCreatedAt = originalCreatedAt ?? offload.createdAt;
      expect(offload.createdAt).toBe(originalCreatedAt);

      expect(executeTerminalOffloadTasks(room)).toBe(10_000);
      expect(room.terminal!.store.getFreeCapacity()).toBe(expectedFreeCapacity);
    }

    Game.time = 40;
    resetRuntimeServices();
    runResourceControl();

    expect(room.terminal!.store.getFreeCapacity()).toBe(80_000);
    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("normal");
    expect(getCarrierTasksByRoom(room.name)).toEqual({});

    Game.time = 50;
    resetRuntimeServices();
    runResourceControl();

    expect(room.terminal!.store.getFreeCapacity()).toBe(80_000);
    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("normal");
    expect(getCarrierTasksByRoom(room.name)).toEqual({});
  });

  it("restores staging for the same persistent task after receiver capacity recovers", () => {
    const source = createMutableRoom(
      "W83N1",
      {
        [RESOURCE_ENERGY]: 220_001,
        [RESOURCE_KEANIUM]: 6_000,
      },
      {},
    );
    source.terminal!.cooldown = 1;
    const receiver = createMutableRoom(
      "W83N2",
      { [RESOURCE_ENERGY]: 950_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 1);

    Game.time = 1;
    const created = createResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:receiver-recovery",
    );
    if (typeof created === "string") throw new Error(created);
    const originalTaskId = created.task.id;
    const originalTaskCreatedAt = created.task.createdAt;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(created.task).toMatchObject({
      id: originalTaskId,
      createdAt: originalTaskCreatedAt,
      status: "pending",
      blockedReason: "receiver_capacity",
    });
    expect(
      getCarrierTasksByRoom(source.name)[
        `resourceControl:terminal_feed:${source.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();

    (receiver.storage!.store as unknown as MutableStore).set(
      RESOURCE_ENERGY,
      200_000,
    );
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    const recoveredFeed = getCarrierTasksByRoom(source.name)[
      `resourceControl:terminal_feed:${source.name}:${RESOURCE_KEANIUM}`
    ];
    expect(ensureResourceTransferTaskStore()[originalTaskId]).toMatchObject({
      id: originalTaskId,
      createdAt: originalTaskCreatedAt,
      status: "pending",
    });
    expect(recoveredFeed).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 1_000 }],
    });

    Game.time = 30;
    resetRuntimeServices();
    runResourceControl();

    expect(
      getCarrierTasksByRoom(source.name)[
        `resourceControl:terminal_feed:${source.name}:${RESOURCE_KEANIUM}`
      ],
    ).toMatchObject({
      createdAt: recoveredFeed.createdAt,
      steps: [{ resource: RESOURCE_KEANIUM, amount: 1_000 }],
    });
    expect(ensureResourceTransferTaskStore()[originalTaskId].createdAt).toBe(
      originalTaskCreatedAt,
    );
  });

  it("persists normalized capacity policy and terminal headroom telemetry", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = {
      enabled: false,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 120_000,
      storageReliefTargetFreeCapacity: 110_000,
      receiverStorageMinFreeCapacity: 100_000,
      terminalPressureFreeCapacity: 45_000,
      receiverTerminalMinFreeCapacity: 55_000,
      terminalReliefTargetFreeCapacity: 50_000,
    };
    const room = createMutableRoom(
      "W84N1",
      { [RESOURCE_ENERGY]: 750_000 },
      {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 260_000,
      },
    );
    Game.rooms[room.name] = room;

    Game.time = 10;
    runResourceControl();

    const runtime = Memory.runtime?.resourceControl as any;
    expect(runtime.capacityPolicy).toEqual({
      enabled: false,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 120_000,
      storageReliefTargetFreeCapacity: 120_000,
      receiverStorageMinFreeCapacity: 120_000,
      terminalPressureFreeCapacity: 45_000,
      receiverTerminalMinFreeCapacity: 55_000,
      terminalReliefTargetFreeCapacity: 55_000,
    });
    expect(runtime.capacityIndexBuildCount).toBe(1);
    expect(runtime.eligibleReceiverCount).toBe(0);
    expect(runtime.receiverExcludedByReason).toEqual({ terminal_headroom: 1 });
    expect(runtime.rooms[room.name]).toMatchObject({
      desiredTerminalFreeCapacity: 55_000,
      terminalRecoveryGap: 45_000,
      recoverableOffloadAmount: 10_000,
      stickyHeadroom: false,
      capacityReservation: { committed: 0, remaining: 0 },
      staging: {
        admittedAmount: 0,
        admittedTaskCount: 0,
        admittedByResource: {},
        suppressedCount: 0,
        suppressedByReason: {},
      },
    });
  });

  it("reports receiver admission, shared commitments, owned staging, and window suppression", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    Memory.cfg!.resourceControl!.rooms = {
      W85N6: { transferBatchSize: 10_000 },
    };
    const eligible = createMutableRoom(
      "W85N1",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const lowStorage = createMutableRoom(
      "W85N2",
      { [RESOURCE_ENERGY]: 701_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const lowTerminal = createMutableRoom(
      "W85N3",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 251_000 },
    );
    const hysteresis = createMutableRoom(
      "W85N4",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 240_000 },
    );
    const exhausted = createMutableRoom(
      "W85N5",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 250_000 },
    );
    const source = createMutableRoom(
      "W85N6",
      {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 700_000,
        [RESOURCE_HYDROGEN]: 20_000,
      },
      {},
    );
    source.terminal!.cooldown = 1;
    for (const room of [eligible, lowStorage, lowTerminal, hysteresis, exhausted, source]) {
      Game.rooms[room.name] = room;
    }
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: { [hysteresis.name]: { capacityState: "pressure" } },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;

    Game.time = 1;
    const exactCommitment = createResourceTransferTask(
      source.name,
      exhausted.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:exact-capacity",
    );
    if (typeof exactCommitment === "string") throw new Error(exactCommitment);
    Game.time = 2;
    const waiting = createResourceTransferTask(
      source.name,
      eligible.name,
      RESOURCE_HYDROGEN,
      5_000,
      "manual:window-wait",
    );
    if (typeof waiting === "string") throw new Error(waiting);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    const runtime = Memory.runtime?.resourceControl as any;
    expect(runtime.eligibleReceiverCount).toBe(1);
    expect(runtime.receiverExcludedByReason).toEqual({
      storage_headroom: 2,
      terminal_headroom: 1,
      capacity_state: 1,
      commitment_exhausted: 1,
    });
    expect(runtime.rooms[exhausted.name].capacityReservation).toEqual({
      committed: 10_000,
      remaining: 0,
    });
    expect(runtime.rooms[eligible.name].capacityReservation).toEqual({
      committed: 5_000,
      remaining: 235_000,
    });
    expect(runtime.rooms[source.name].staging).toEqual({
      admittedAmount: 10_000,
      admittedTaskCount: 1,
      admittedByResource: { [RESOURCE_KEANIUM]: 10_000 },
      suppressedCount: 1,
      suppressedByReason: { window_limit: 1 },
    });
    expect(runtime.suppressedStagingCount).toEqual({ window_limit: 1 });
    expect(runtime.capacityIndexBuildCount).toBe(1);
  });

  it("diagnoses receiver and fee suppression behind an occupied source window", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    const source = createMutableRoom(
      "W85N7",
      {
        [RESOURCE_ENERGY]: 201_000,
        [RESOURCE_KEANIUM]: 20_000,
        [RESOURCE_HYDROGEN]: 20_000,
        [RESOURCE_OXYGEN]: 20_000,
      },
      {},
    );
    source.terminal!.cooldown = 1;
    const admittedReceiver = createMutableRoom(
      "W85N8",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const constrainedReceiver = createMutableRoom(
      "W85N9",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 280_000 },
    );
    const expensiveReceiver = createMutableRoom(
      "W85N10",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    for (const room of [source, admittedReceiver, constrainedReceiver, expensiveReceiver]) {
      Game.rooms[room.name] = room;
    }
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
      (_amount: number, _from: string, to: string) =>
        to === expensiveReceiver.name ? 2_000 : 0,
    );
    Game.time = 1;
    createResourceTransferTask(
      source.name,
      admittedReceiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:admit",
    );
    Game.time = 2;
    createResourceTransferTask(
      source.name,
      constrainedReceiver.name,
      RESOURCE_OXYGEN,
      1_000,
      "manual:receiver-blocked",
    );
    Game.time = 3;
    createResourceTransferTask(
      source.name,
      expensiveReceiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      "manual:fee-blocked",
    );

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    const staging = (Memory.runtime?.resourceControl as any).rooms[source.name].staging;
    expect(staging).toMatchObject({
      admittedAmount: 1_000,
      admittedTaskCount: 1,
      admittedByResource: { [RESOURCE_KEANIUM]: 1_000 },
      suppressedCount: 2,
      suppressedByReason: {
        receiver_capacity: 1,
        fee_budget: 1,
      },
    });
    expect((Memory.runtime?.resourceControl as any).suppressedStagingCount).toEqual({
      receiver_capacity: 1,
      fee_budget: 1,
    });
  });

  it("counts ephemeral energy-deficit staging without inventing a persistent task", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    const donor = createMutableRoom(
      "W85N11",
      { [RESOURCE_ENERGY]: 260_000 },
      {},
    );
    donor.terminal!.cooldown = 1;
    const receiver = createMutableRoom(
      "W85N12",
      { [RESOURCE_ENERGY]: 100_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    Game.time = 10;
    runResourceControl();

    expect((Memory.runtime?.resourceControl as any).rooms[donor.name].staging).toMatchObject({
      admittedAmount: 10_000,
      admittedTaskCount: 0,
      admittedByResource: { [RESOURCE_ENERGY]: 10_000 },
    });
  });

  it("classifies sticky terminal headroom without crediting planned carrier moves", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    const storageFull = createMutableRoom(
      "W86N1",
      {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 800_000,
      },
      {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_HYDROGEN]: 265_000,
      },
    );
    const protectedInventory = createMutableRoom(
      "W86N2",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_KEANIUM]: 265_000,
      },
    );
    const noOffloadable = createMutableRoom(
      "W86N3",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 290_000 },
    );
    const backlog = createMutableRoom(
      "W86N4",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_HYDROGEN]: 265_000,
      },
    );
    const inconsistentTerminalStore = noOffloadable.terminal!.store;
    inconsistentTerminalStore.getUsedCapacity = ((resource?: ResourceConstant) =>
      resource ? 0 : 290_000) as typeof inconsistentTerminalStore.getUsedCapacity;
    replaceCarrierTasksForProducerRoom("test:lab", protectedInventory.name, [
      {
        id: "test:protected-k",
        type: "lab_supply",
        priority: 100,
        steps: [{
          id: "protected-k",
          resource: RESOURCE_KEANIUM,
          fromKind: "terminal",
          toKind: "lab",
          fromId: protectedInventory.terminal!.id,
          toId: "test-lab" as Id<StructureLab>,
          amount: 265_000,
        }],
      },
    ]);
    for (const room of [storageFull, protectedInventory, noOffloadable, backlog]) {
      Game.rooms[room.name] = room;
    }

    Game.time = 10;
    runResourceControl();
    let runtime = Memory.runtime?.resourceControl as any;
    expect(runtime.rooms[storageFull.name]).toMatchObject({
      terminalRecoveryGap: 70_000,
      recoverableOffloadAmount: 0,
      stickyHeadroom: true,
      stickyHeadroomReason: "storage_full",
    });
    expect(runtime.rooms[protectedInventory.name]).toMatchObject({
      recoverableOffloadAmount: 0,
      stickyHeadroom: true,
      stickyHeadroomReason: "protected_inventory",
    });
    expect(runtime.rooms[noOffloadable.name]).toMatchObject({
      recoverableOffloadAmount: 0,
      stickyHeadroom: true,
      stickyHeadroomReason: "no_offloadable_resource",
    });
    expect(runtime.rooms[backlog.name]).toMatchObject({
      terminalFreeCapacity: 10_000,
      recoverableOffloadAmount: 10_000,
      stickyHeadroom: false,
    });

    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();
    runtime = Memory.runtime?.resourceControl as any;
    expect(runtime.rooms[backlog.name]).toMatchObject({
      terminalFreeCapacity: 10_000,
      terminalRecoveryGap: 70_000,
      recoverableOffloadAmount: 10_000,
      stickyHeadroom: true,
      stickyHeadroomReason: "carrier_backlog",
    });
  });

  it("does not attribute backlog from an old offload resource to a different current draft", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    const room = createMutableRoom(
      "W87N1",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_KEANIUM]: 265_000,
      },
    );
    Game.rooms[room.name] = room;
    Game.time = 1;
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [
      {
        id: `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`,
        type: "terminal_offload",
        priority: 90,
        steps: [{
          id: "old-h-offload",
          resource: RESOURCE_HYDROGEN,
          fromKind: "terminal",
          toKind: "storage",
          fromId: room.terminal!.id,
          toId: room.storage!.id,
          amount: 10_000,
        }],
      },
    ]);
    Memory.runtime = {
      resourceControl: {
        updatedAt: 1,
        rooms: {
          [room.name]: {
            capacityState: "pressure",
            terminalFreeCapacity: 10_000,
          },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect((Memory.runtime?.resourceControl as any).rooms[room.name]).toMatchObject({
      recoverableOffloadAmount: 10_000,
      stickyHeadroom: false,
    });
    expect(
      (Memory.runtime?.resourceControl as any).rooms[room.name]
        .stickyHeadroomReason,
    ).toBeUndefined();
    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeDefined();
  });
});
