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
      const transactionCost = Game.market.calcTransactionCost(
        amount,
        name,
        toRoomName,
      );
      const requiredEnergy =
        transactionCost + (resource === RESOURCE_ENERGY ? amount : 0);
      if (terminalStore.getUsedCapacity(resource) < amount) {
        return ERR_NOT_ENOUGH_RESOURCES;
      }
      if (terminalStore.getUsedCapacity(RESOURCE_ENERGY) < requiredEnergy) {
        return ERR_NOT_ENOUGH_RESOURCES;
      }
      if (receiver.store.getFreeCapacity() < amount) return ERR_FULL;

      if (resource === RESOURCE_ENERGY) {
        terminalStore.set(
          RESOURCE_ENERGY,
          terminalStore.getUsedCapacity(RESOURCE_ENERGY) - requiredEnergy,
        );
      } else {
        terminalStore.set(resource, terminalStore.getUsedCapacity(resource) - amount);
        terminalStore.set(
          RESOURCE_ENERGY,
          terminalStore.getUsedCapacity(RESOURCE_ENERGY) - transactionCost,
        );
      }
      const receiverStore = receiver.store as unknown as MutableStore;
      receiverStore.set(resource, receiverStore.getUsedCapacity(resource) + amount);
      return OK;
    }),
  } as unknown as StructureTerminal;

  const room = {
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
  (terminal as StructureTerminal & { room: Room }).room = room;
  return room;
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

function executeTerminalFeedTasks(room: Room): number {
  const terminalStore = room.terminal!.store as unknown as MutableStore;
  const storageStore = room.storage!.store as unknown as MutableStore;
  let moved = 0;
  for (const task of Object.values(getCarrierTasksByRoom(room.name))) {
    if (task.type !== "terminal_feed") continue;
    for (const step of task.steps) {
      if (step.fromKind !== "storage" || step.toKind !== "terminal") continue;
      const amount = Math.min(
        step.amount,
        storageStore.getUsedCapacity(step.resource),
        terminalStore.getFreeCapacity(),
      );
      storageStore.set(
        step.resource,
        storageStore.getUsedCapacity(step.resource) - amount,
      );
      terminalStore.set(
        step.resource,
        terminalStore.getUsedCapacity(step.resource) + amount,
      );
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

  it("keeps an exact-admission receiver normal instead of ping-ponging next cycle", () => {
    const source = createMutableRoom(
      "W81N1",
      { [RESOURCE_ENERGY]: 200_000 },
      {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_001,
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

    expect(receiver.terminal!.store.getFreeCapacity()).toBe(40_000);
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
      { [RESOURCE_ENERGY]: 901_000 },
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

  it("bootstraps only the full fee when capacity-relief cargo is already in a pressured terminal", () => {
    const source = createMutableRoom(
      "E3N59",
      {
        [RESOURCE_ENERGY]: 146_000,
        [RESOURCE_HYDROGEN]: 840_000,
      },
      {
        [RESOURCE_ZYNTHIUM]: 295_000,
      },
    );
    const receiver = createMutableRoom(
      "E4N58",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.capacityBalancing = {
      terminalHeadroomRecoveryEnabled: true,
    };
    (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(2_000);

    Game.time = 1;
    const created = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_ZYNTHIUM,
      2_500,
      `capacity:relief:${RESOURCE_ZYNTHIUM}`,
    );
    if (typeof created === "string") throw new Error(created);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    const sourceRuntime = Memory.runtime?.resourceControl?.rooms[source.name];
    expect(sourceRuntime?.staging).toMatchObject({
      admittedAmount: 2_500,
      admittedTaskCount: 1,
      admittedByResource: { [RESOURCE_ZYNTHIUM]: 2_500 },
    });
    const feedTasks = Object.values(getCarrierTasksByRoom(source.name)).filter(
      (task) => task.type === "terminal_feed",
    );
    expect(feedTasks).toEqual([
      expect.objectContaining({
        id: `resourceControl:terminal_feed:${source.name}:${RESOURCE_ENERGY}`,
        steps: [expect.objectContaining({ resource: RESOURCE_ENERGY, amount: 2_000 })],
      }),
    ]);
    expect(
      feedTasks.some((task) =>
        task.steps.some((step) => step.resource === RESOURCE_ZYNTHIUM),
      ),
    ).toBe(false);

    expect(executeTerminalFeedTasks(source)).toBe(2_000);
    expect(source.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(2_000);

    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(source.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ZYNTHIUM,
      2_500,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
    expect(created.task.status).toBe("done");
    expect(source.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(0);
    expect(source.terminal!.store.getUsedCapacity(RESOURCE_ZYNTHIUM)).toBe(292_500);
    expect(receiver.terminal!.store.getUsedCapacity(RESOURCE_ZYNTHIUM)).toBe(2_500);
  });

  it("rejects the whole fee bootstrap batch when only a smaller batch would fit", () => {
    const source = createMutableRoom(
      "E3N58",
      {
        [RESOURCE_ENERGY]: 146_000,
        [RESOURCE_HYDROGEN]: 840_000,
      },
      {
        [RESOURCE_ZYNTHIUM]: 299_000,
      },
    );
    const receiver = createMutableRoom(
      "E4N57",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    (Game.market.calcTransactionCost as jest.Mock).mockImplementation(
      (amount: number) => Math.ceil(amount / 2),
    );

    Game.time = 1;
    const created = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_ZYNTHIUM,
      2_500,
      `capacity:relief:${RESOURCE_ZYNTHIUM}`,
    );
    if (typeof created === "string") throw new Error(created);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({
      admittedAmount: 0,
      admittedTaskCount: 0,
      suppressedByReason: { terminal_headroom: 1 },
    });
    expect(
      Object.values(getCarrierTasksByRoom(source.name)).filter(
        (task) => task.type === "terminal_feed",
      ),
    ).toEqual([]);
    expect(source.terminal!.send).not.toHaveBeenCalled();
    expect(created.task.remainingAmount).toBe(2_500);
  });

  it("does not use the fee bootstrap exception to stage cargo still in Storage", () => {
    const source = createMutableRoom(
      "E3N57",
      {
        [RESOURCE_ENERGY]: 146_000,
        [RESOURCE_ZYNTHIUM]: 10_000,
        [RESOURCE_HYDROGEN]: 840_000,
      },
      {
        [RESOURCE_KEANIUM]: 299_000,
      },
    );
    const receiver = createMutableRoom(
      "E4N56",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(500);

    Game.time = 1;
    const created = createResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_ZYNTHIUM,
      2_500,
      "manual:cargo-still-in-storage",
    );
    if (typeof created === "string") throw new Error(created);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({
      admittedAmount: 0,
      suppressedByReason: { terminal_headroom: 1 },
    });
    expect(
      Object.values(getCarrierTasksByRoom(source.name)).filter(
        (task) => task.type === "terminal_feed",
      ),
    ).toEqual([]);
    expect(created.task.remainingAmount).toBe(2_500);
  });

  it("stages non-energy cargo when room-total action energy is safe below the room target", () => {
    const source = createMutableRoom(
      "E7N58",
      {
        [RESOURCE_ENERGY]: 1_692,
        [RESOURCE_LEMERGIUM]: 998_308,
      },
      { [RESOURCE_ENERGY]: 52_312 },
    );
    const receiver = createMutableRoom(
      "E4N58",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.capacityBalancing = {
      terminalHeadroomRecoveryEnabled: true,
    };
    (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(2_000);

    Game.time = 1;
    const created = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_LEMERGIUM,
      3_463,
      `capacity:relief:${RESOURCE_LEMERGIUM}`,
    );
    if (typeof created === "string") throw new Error(created);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({
      admittedAmount: 3_463,
      admittedTaskCount: 1,
      admittedByResource: { [RESOURCE_LEMERGIUM]: 3_463 },
      suppressedCount: 0,
    });
    expect(getCarrierTasksByRoom(source.name)).toMatchObject({
      [`resourceControl:terminal_feed:${source.name}:${RESOURCE_LEMERGIUM}`]: {
        type: "terminal_feed",
        steps: [expect.objectContaining({ resource: RESOURCE_LEMERGIUM, amount: 3_463 })],
      },
    });
    expect(created.task.blockedReason).toBe("insufficient_terminal_resource_or_fee");
  });

  it("executes an explicit Energy task below donor watermarks even when the receiver reached target", () => {
    const source = createMutableRoom(
      "W86N1",
      { [RESOURCE_ENERGY]: 10_000 },
      { [RESOURCE_ENERGY]: 31_000 },
    );
    const receiver = createMutableRoom(
      "W86N2",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(1_000);

    Game.time = 1;
    const created = createResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_ENERGY,
      10_000,
      "manual:energy-watermark-independence",
    );
    if (typeof created === "string") throw new Error(created);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(source.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
    expect(created.task.status).toBe("done");
    expect(source.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(20_000);
    expect(receiver.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(30_000);
  });

  it("keeps donor exportStart as the gate for creating no-task automatic Energy recovery", () => {
    const donor = createMutableRoom(
      "W86N3",
      { [RESOURCE_ENERGY]: 249_999 },
      { [RESOURCE_ENERGY]: 50_000 },
    );
    const receiver = createMutableRoom(
      "W86N4",
      { [RESOURCE_ENERGY]: 100_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();

    (donor.storage!.store as unknown as MutableStore).set(
      RESOURCE_ENERGY,
      250_000,
    );
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      receiver.name,
      expect.stringContaining("resourceControl:auto-balance"),
    );
  });

  it("keeps receiver target as the demand gate for no-task automatic Energy recovery", () => {
    const donor = createMutableRoom(
      "W86N5",
      { [RESOURCE_ENERGY]: 300_000 },
      { [RESOURCE_ENERGY]: 50_000 },
    );
    const receiver = createMutableRoom(
      "W86N6",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
  });

  it("plans Energy capacity relief without requiring receiver Energy demand", () => {
    const source = createMutableRoom(
      "W87N1",
      { [RESOURCE_ENERGY]: 980_000 },
      {},
    );
    const receiver = createMutableRoom(
      "W87N2",
      { [RESOURCE_ENERGY]: 300_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) =>
        entry.fromRoomName === source.name &&
        entry.toRoomName === receiver.name &&
        entry.resource === RESOURCE_ENERGY &&
        entry.reason === `capacity:relief:${RESOURCE_ENERGY}`,
    );
    expect(task).toMatchObject({
      status: "pending",
      remainingAmount: 50_000,
    });
    expect(getCarrierTasksByRoom(source.name)).toMatchObject({
      [`resourceControl:terminal_feed:${source.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [expect.objectContaining({ resource: RESOURCE_ENERGY, amount: 30_000 })],
      },
    });
  });

  it("admits exactly 50000 into a normal 150000-free Storage and none at 100000", () => {
    Memory.cfg!.resourceControl!.rooms = {
      W88N1: { transferBatchSize: 50_000 },
    };
    const source = createMutableRoom(
      "W88N1",
      {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_HYDROGEN]: 790_001,
      },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const receiver = createMutableRoom(
      "W88N2",
      { [RESOURCE_ENERGY]: 850_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const saturated = createMutableRoom(
      "W88N3",
      { [RESOURCE_ENERGY]: 900_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[saturated.name] = saturated;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) => entry.fromRoomName === source.name,
    );
    expect(task).toMatchObject({
      toRoomName: receiver.name,
      resource: RESOURCE_HYDROGEN,
      remainingAmount: 50_000,
    });
    expect(
      Object.values(ensureResourceTransferTaskStore()).some(
        (entry) => entry.toRoomName === saturated.name,
      ),
    ).toBe(false);
    expect(
      Memory.runtime?.resourceControl?.rooms[receiver.name]?.capacityReservation,
    ).toEqual({ committed: 50_000, remaining: 0 });
    expect(
      Memory.runtime?.resourceControl?.rooms[saturated.name]?.capacityReservation,
    ).toEqual({ committed: 0, remaining: 0 });

    expect(executeTerminalFeedTasks(source)).toBe(50_000);
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(source.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_HYDROGEN,
      50_000,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
    expect(task?.status).toBe("done");
  });

  it("does not create a zero-capacity task when the only receiver is exactly at 100000", () => {
    const source = createMutableRoom(
      "W89N1",
      {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_HYDROGEN]: 790_001,
      },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const saturated = createMutableRoom(
      "W89N2",
      { [RESOURCE_ENERGY]: 900_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[saturated.name] = saturated;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(Object.values(ensureResourceTransferTaskStore())).toEqual([]);
    expect(
      Memory.runtime?.resourceControl?.rooms[saturated.name]?.capacityReservation,
    ).toEqual({ committed: 0, remaining: 0 });
  });
});
