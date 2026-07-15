import { clearCarrierTaskBoardForTest, getCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";
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
});
