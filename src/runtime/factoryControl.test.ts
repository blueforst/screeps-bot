import { createMockFactory, createMockStore, MockFactoryConfig } from "@mock/powerBank";
import {
  runFactoryControl,
  isEligibleRoom,
  getRoomStock,
  computeSurplus,
  decomposeTarget,
  resolveTargetQueue,
  getRequiredFactoryLevel,
  isProducible,
  parseConfig,
  findSafeSellOrder,
  attemptRegionalRawPurchase,
  addFactoryTask,
  cancelFactoryTask,
  listFactoryTasks,
  type MarketConfig,
  type FactoryControlRuntime,
} from "@/runtime/factoryControl";

type GameWithPartialMarket = Omit<Game, "market"> & {
  market: Partial<Market> & {
    calcTransactionCost?: (amount: number, fromRoom: string, toRoom: string) => number;
    getAllOrders?: (filter: OrderFilter) => Order[];
    deal?: (orderId: string, amount: number, roomName: string) => number;
    getOrderById?: (id: string) => Order | null;
  };
};

interface FactoryRoomOptions {
  name?: string;
  rcl?: number;
  storageResources?: Record<string, number>;
  terminalResources?: Record<string, number>;
  factoryOverrides?: Partial<MockFactoryConfig>;
  hasController?: boolean;
  hasTerminal?: boolean;
}

interface FactoryRoomHandle {
  room: Room;
  factory: StructureFactory;
  storage: StructureStorage;
  terminal: StructureTerminal;
}

function createFactoryRoom(options: FactoryRoomOptions = {}): FactoryRoomHandle {
  const roomName = options.name ?? "W1N1";
  const rcl = options.rcl ?? 7;

  const storage: StructureStorage = {
    id: `${roomName}-storage` as Id<StructureStorage>,
    structureType: STRUCTURE_STORAGE,
    store: createMockStore(options.storageResources ?? { [RESOURCE_ENERGY]: 300000 }),
  } as unknown as StructureStorage;

  const terminal: StructureTerminal = {
    id: `${roomName}-terminal` as Id<StructureTerminal>,
    structureType: STRUCTURE_TERMINAL,
    cooldown: 0,
    store: createMockStore(options.terminalResources ?? { [RESOURCE_ENERGY]: 25000 }),
  } as unknown as StructureTerminal;

  const factory = createMockFactory({
    id: `${roomName}-factory`,
    roomName,
    level: rcl >= 7 ? 1 : 0,
    store: createMockStore({}),
    ...options.factoryOverrides,
  });

  const allStructures: any[] = [factory, storage, terminal];

  const roomObj: Partial<Room> = {
    name: roomName,
    controller: options.hasController !== false
      ? ({ my: true, level: rcl } as StructureController)
      : undefined,
    storage,
    terminal: options.hasTerminal !== false ? terminal : undefined,
  };
  Object.assign(roomObj, {
    factory,
    find: ((type: FindConstant, opts?: { filter?: (s: Structure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allStructures.filter((s: any) => opts.filter!(s as Structure))
          : allStructures;
      }
      return [];
    }) as Room["find"],
  });

  return {
    room: roomObj as Room,
    factory,
    storage,
    terminal,
  };
}

function setConfig(cfg: Record<string, unknown>): void {
  if (!Memory.cfg) Memory.cfg = {};
  Memory.cfg.factoryControl = cfg as any;
}

function setupGameRooms(rooms: Record<string, Room>): void {
  (Game as any).rooms = rooms;
  Game.time = 1000;
}

describe("factory mock", () => {
  it("calls produce on a mocked factory and returns OK", () => {
    const { room, factory } = createFactoryRoom({
      factoryOverrides: {
        store: createMockStore({ [RESOURCE_ENERGY]: 50000, [RESOURCE_BATTERY]: 5000 }),
        level: 1,
      },
    });

    expect((room as any).factory).toBeDefined();
    expect((room as any).factory.structureType).toBe(STRUCTURE_FACTORY);
    expect((room as any).factory.level).toBe(1);

    const result = factory.produce(RESOURCE_BATTERY);
    expect(result).toBe(OK);
    expect(factory.produce).toHaveBeenCalledWith(RESOURCE_BATTERY);
    expect(factory.produce).toHaveBeenCalledTimes(1);
  });

  it("discovers factory via room.find(FIND_MY_STRUCTURES)", () => {
    const { room } = createFactoryRoom();

    const factories = room.find(FIND_MY_STRUCTURES, {
      filter: (s: Structure) => s.structureType === STRUCTURE_FACTORY,
    });

    expect(factories.length).toBe(1);
    expect(factories[0].structureType).toBe(STRUCTURE_FACTORY);
  });

  it("returns custom error code from overridden produce", () => {
    const factory = createMockFactory({
      id: "W1N1-factory-2",
      roomName: "W1N1",
      produce: jest.fn(() => ERR_NOT_ENOUGH_RESOURCES),
    });

    const result = factory.produce(RESOURCE_BATTERY);
    expect(result).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(factory.produce).toHaveBeenCalledTimes(1);
  });

  it("exposes cooldown and store helpers on the factory mock", () => {
    const factory = createMockFactory({
      id: "W1N1-factory-3",
      roomName: "W1N1",
      cooldown: 5,
      store: createMockStore({ [RESOURCE_ENERGY]: 10000 }),
    });

    expect(factory.cooldown).toBe(5);
    expect(factory.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(10000);
    expect(factory.store.getUsedCapacity()).toBe(10000);
  });
});

describe("factory room eligibility", () => {
  it("accepts owned room with factory and terminal", () => {
    const { room } = createFactoryRoom({ rcl: 7 });
    expect(isEligibleRoom(room)).toBe(true);
  });

  it("rejects room without controller", () => {
    const { room } = createFactoryRoom({ hasController: false });
    expect(isEligibleRoom(room)).toBe(false);
  });

  it("rejects room without terminal", () => {
    const { room } = createFactoryRoom({ hasTerminal: false });
    expect(isEligibleRoom(room)).toBe(false);
  });

  it("rejects room without factory in structures", () => {
    const roomObj: Partial<Room> = {
      name: "W1N1",
      controller: { my: true, level: 7 } as StructureController,
      storage: { store: createMockStore({ energy: 100 }) } as any,
      terminal: { store: createMockStore({ energy: 100 }) } as any,
      find: ((_type: FindConstant) => []) as Room["find"],
    };
    expect(isEligibleRoom(roomObj as Room)).toBe(false);
  });
});

describe("recursive target queue", () => {
  it("selects target directly when all components available", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 2000 },
      factoryOverrides: { level: 0 },
    });

    const result = decomposeTarget(
      "utrium_bar" as ResourceConstant,
      100,
      room,
      {},
      "test-holder",
    );

    expect(result.productionTarget).toBe("utrium_bar");
    expect(result.missing).toEqual({});
    expect(result.requiredLevel).toBe(0);
  });

  it("recursively decomposes to missing producible component", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: { level: 1 },
    });

    const result = decomposeTarget(
      "composite" as ResourceConstant,
      20,
      room,
      {},
      "test-holder",
    );

    // composite needs utrium_bar + zynthium_bar + energy
    // Neither utrium_bar nor zynthium_bar in stock
    // First missing producible = utrium_bar (iteration order)
    // utrium_bar needs U (base) + energy -> U missing
    expect(result.productionTarget).toBe("utrium_bar" as ResourceConstant);
    expect(result.requiredLevel).toBe(0);
    expect(result.missing).toBeDefined();
    expect((result.missing as any).U).toBeGreaterThan(0);
  });

  it("reports base deposit resources as missing", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: { level: 0 },
    });

    const result = decomposeTarget(
      "wire" as ResourceConstant,
      20,
      room,
      {},
      "test-holder",
    );

    // wire needs utrium_bar (producible) + silicon (base deposit) + energy
    // Decomposes to utrium_bar first, which needs U (base)
    // silicon is also missing as a base resource
    expect((result.missing as any).silicon).toBeGreaterThan(0);
  });

  it("stops decomposition at energy as base resource", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 0 },
      terminalResources: { [RESOURCE_ENERGY]: 0 },
      factoryOverrides: { level: 0 },
    });

    const result = decomposeTarget(
      "battery" as ResourceConstant,
      50,
      room,
      {},
      "test-holder",
    );

    expect(result.productionTarget).toBe("battery" as ResourceConstant);
    expect((result.missing as any).energy).toBeGreaterThan(0);
  });

  it("respects resource floors during surplus calculation", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 1000 },
      factoryOverrides: { level: 0 },
    });

    // utrium_bar needs 500 U per batch
    // With floor of 900 for U, surplus is only 100
    const result = decomposeTarget(
      "utrium_bar" as ResourceConstant,
      100,
      room,
      { U: 900 },
      "test-holder",
    );

    expect((result.missing as any).U).toBeGreaterThan(0);
  });

  it("per-room target queue overrides global queue", () => {
    setConfig({
      enabled: true,
      targetQueue: [
        { resource: "battery", targetAmount: 1000 },
      ],
      rooms: {
        W1N1: {
          enabled: true,
          targetQueue: [
            { resource: "utrium_bar", targetAmount: 200 },
          ],
        },
      },
    });

    const config = parseConfig();
    const queue = resolveTargetQueue(config, "W1N1");

    expect(queue.length).toBe(1);
    expect(queue[0].resource).toBe("utrium_bar");
  });

  it("falls back to global target queue when room has none", () => {
    setConfig({
      enabled: true,
      targetQueue: [
        { resource: "battery", targetAmount: 1000 },
      ],
      rooms: {
        W1N1: { enabled: true },
      },
    });

    const config = parseConfig();
    const queue = resolveTargetQueue(config, "W1N1");

    expect(queue.length).toBe(1);
    expect(queue[0].resource).toBe("battery");
  });

  it("preserves evaluation order of target queue", () => {
    setConfig({
      enabled: true,
      targets: [
        { resource: "battery", targetAmount: 100 },
        { resource: "utrium_bar", targetAmount: 200 },
        { resource: "composite", targetAmount: 50 },
      ],
    });

    const config = parseConfig();
    expect(config.targetQueue[0].resource).toBe("battery");
    expect(config.targetQueue[1].resource).toBe("utrium_bar");
    expect(config.targetQueue[2].resource).toBe("composite");
  });

  it("normalizes string-array targetQueue into default entries", () => {
    setConfig({
      enabled: true,
      targetQueue: ["battery", "utrium_bar", "composite"] as unknown as ResourceConstant[],
    });

    const config = parseConfig();
    expect(config.targetQueue.length).toBe(3);
    expect(config.targetQueue[0]).toEqual({ resource: "battery", targetAmount: 0, cap: 0 });
    expect(config.targetQueue[1]).toEqual({ resource: "utrium_bar", targetAmount: 0, cap: 0 });
    expect(config.targetQueue[2]).toEqual({ resource: "composite", targetAmount: 0, cap: 0 });
  });

  it("plans production from string-array targetQueue", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targetQueue: ["battery"] as unknown as ResourceConstant[],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.activeTarget).toBe("battery");
  });
});

describe("resource floor", () => {
  it("computeSurplus subtracts floor from stock", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 1000 },
    });

    const surplus = computeSurplus(room, "U" as ResourceConstant, 400, "holder");
    expect(surplus).toBe(600);
  });

  it("computeSurplus never goes below zero", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 100 },
    });

    const surplus = computeSurplus(room, "U" as ResourceConstant, 500, "holder");
    expect(surplus).toBe(0);
  });

  it("computeSurplus sums storage + terminal + factory stock", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 400 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, U: 300 },
      factoryOverrides: {
        store: createMockStore({ U: 200 }),
      },
    });

    const surplus = computeSurplus(room, "U" as ResourceConstant, 0, "holder");
    expect(surplus).toBe(900);
  });

  it("getRoomStock returns zero for absent resource", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    expect(getRoomStock(room, "U" as ResourceConstant)).toBe(0);
  });

  it("planner skips product at or above production cap", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, battery: 500 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 1000 }],
      productionCaps: { battery: 500 },
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("sleeping");
    expect(state!.sleepReason).toBe("all_targets_skipped");
  });

  it("planner skips product at or above target amount", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, battery: 1000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 1000 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state!.stage).toBe("sleeping");
  });

  it("planner respects per-room resource floors", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 600 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "utrium_bar", targetAmount: 100 }],
      rooms: {
        W1N1: {
          enabled: true,
          resourceFloors: { U: 500 },
        },
      },
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    // With only 600 U and floor of 500, surplus is 100 < 500 needed per batch
    // So U is missing, and since U is a base resource, we're blocked
    expect(state!.activeTarget).toBe("utrium_bar" as ResourceConstant);
  });
});

describe("factory level gate", () => {
  it("skips high-level target and plans lower-level later target", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 2000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [
        { resource: "composite", targetAmount: 20 },
        { resource: "utrium_bar", targetAmount: 100 },
      ],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    // composite requires level 1, skipped; utrium_bar at level 0 is planned
    expect(state!.activeTarget).toBe("utrium_bar");
    expect(state!.stage).toBe("loading");
  });

  it("sleeps when only target requires higher factory level", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 2000, Z: 2000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "composite", targetAmount: 20 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state!.stage).toBe("sleeping");
    expect(state!.sleepReason).toContain("factory_level");
    expect(state!.activeTarget).toBeUndefined();
  });

  it("getRequiredFactoryLevel returns level from COMMODITIES", () => {
    expect(getRequiredFactoryLevel("battery" as ResourceConstant)).toBe(0);
    expect(getRequiredFactoryLevel("composite" as ResourceConstant)).toBe(1);
    expect(getRequiredFactoryLevel("crystal" as ResourceConstant)).toBe(2);
    expect(getRequiredFactoryLevel("liquid" as ResourceConstant)).toBe(3);
    expect(getRequiredFactoryLevel("circuit" as ResourceConstant)).toBe(4);
    expect(getRequiredFactoryLevel("device" as ResourceConstant)).toBe(5);
  });

  it("sleeps with factory_level reason when all targets require higher level", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [
        { resource: "composite", targetAmount: 20 },
        { resource: "crystal", targetAmount: 10 },
      ],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state!.stage).toBe("sleeping");
    // crystal (level 2) is the highest level-gated target
    expect(state!.sleepReason).toBe("factory_level_2_required");
    expect(state!.activeTarget).toBeUndefined();
  });
});

describe("runFactoryControl planning", () => {
  it("does nothing when disabled", () => {
    const { room } = createFactoryRoom();
    setupGameRooms({ W1N1: room });

    setConfig({ enabled: false });
    runFactoryControl();

    expect(Memory.runtime?.factoryControl).toBeUndefined();
  });

  it("writes runtime state for eligible room", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const runtime = Memory.runtime?.factoryControl;
    expect(runtime).toBeDefined();
    expect(runtime!.updatedAt).toBe(1000);
    expect(runtime!.rooms.W1N1).toBeDefined();
    expect(runtime!.rooms.W1N1.activeTarget).toBe("battery");
    expect(runtime!.rooms.W1N1.lastTransitionAt).toBe(1000);
  });

  it("sleeps when target queue is empty", () => {
    const { room } = createFactoryRoom();
    setupGameRooms({ W1N1: room });

    setConfig({ enabled: true });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state!.stage).toBe("sleeping");
    expect(state!.sleepReason).toBe("empty_target_queue");
  });

  it("skips room when room-level config is disabled", () => {
    const { room } = createFactoryRoom();
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
      rooms: {
        W1N1: { enabled: false },
      },
    });

    runFactoryControl();

    expect(Memory.runtime?.factoryControl?.rooms?.W1N1).toBeUndefined();
  });

  it("respects sleep until tick", () => {
    const { room } = createFactoryRoom();
    setupGameRooms({ W1N1: room });
    Game.time = 100;

    setConfig({ enabled: true });

    runFactoryControl();

    expect(Memory.runtime!.factoryControl!.rooms!.W1N1!.lastTransitionAt).toBe(100);

    const state = Memory.runtime!.factoryControl!.rooms!.W1N1!;
    state.sleepUntilTick = 200;

    Game.time = 150;
    runFactoryControl();

    // Sleep is still active at tick 150 (expires at 200), so no re-evaluation
    // but lastTransitionAt was already updated at tick 100
    expect(Memory.runtime!.factoryControl!.rooms!.W1N1!.sleepReason).toBe("empty_target_queue");
  });

  it("isProducible identifies commodity resources", () => {
    expect(isProducible("battery" as ResourceConstant)).toBe(true);
    expect(isProducible("utrium_bar" as ResourceConstant)).toBe(true);
    expect(isProducible("composite" as ResourceConstant)).toBe(true);
  });

  it("isProducible returns false for base resources", () => {
    expect(isProducible("energy" as ResourceConstant)).toBe(false);
    expect(isProducible("U" as ResourceConstant)).toBe(false);
    expect(isProducible("silicon" as ResourceConstant)).toBe(false);
    expect(isProducible("power" as ResourceConstant)).toBe(false);
  });
});

describe("produce and unload", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
  });

  it("publishes factory_supply tasks when recipe inputs missing from factory", () => {
    const { room, terminal } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({}, 50000),
      },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 50000, battery: 0 }, 300000);
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.activeTarget).toBe("battery");
    expect(state!.stage).toBe("loading");

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    const tasks = listCarrierTasksByRoom("W1N1");
    const supplyTasks = tasks.filter((t: any) => t.type === "factory_supply");
    expect(supplyTasks.length).toBeGreaterThanOrEqual(1);

    const energyTask = supplyTasks.find((t: any) => t.steps.some((s: any) => s.resource === "energy"));
    expect(energyTask).toBeDefined();
    const step = energyTask.steps.find((s: any) => s.resource === "energy");
    expect(step.fromKind).toBe("storage");
    expect(step.toKind).toBe("factory");
    expect(step.amount).toBeGreaterThan(0);
  });

  it("calls produce when inputs present and publishes unload after product appears", () => {
    const { room, factory, terminal } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ [RESOURCE_ENERGY]: 600 }, 50000),
        cooldown: 0,
      },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, battery: 0 }, 300000);
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("producing");
    expect(factory.produce).toHaveBeenCalledTimes(1);
    expect(factory.produce).toHaveBeenCalledWith("battery");

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    let tasks = listCarrierTasksByRoom("W1N1");
    let supplyTasks = tasks.filter((t: any) => t.type === "factory_supply");
    let unloadTasks = tasks.filter((t: any) => t.type === "factory_unload");
    expect(supplyTasks.length).toBe(0);
    expect(unloadTasks.length).toBe(0);

    (factory as any).store = createMockStore({ battery: 50, energy: 0 }, 50000);
    (factory.produce as jest.Mock).mockClear();

    Game.time = 1001;
    runFactoryControl();

    const state2 = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state2!.stage).toBe("unloading");

    tasks = listCarrierTasksByRoom("W1N1");
    unloadTasks = tasks.filter((t: any) => t.type === "factory_unload");
    expect(unloadTasks.length).toBe(1);

    const unloadStep = unloadTasks[0].steps[0];
    expect(unloadStep.resource).toBe("battery");
    expect(unloadStep.fromKind).toBe("factory");
    expect(unloadStep.toKind).toBe("terminal");
    expect(unloadStep.amount).toBe(50);
  });
});

describe("explicit factory tasks", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
  });

  it("creates a battery decompression task and supplies battery to the factory", () => {
    const { room, factory, storage } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, [RESOURCE_BATTERY]: 1000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({}, 50000),
      },
    });
    setupGameRooms({ W1N1: room });
    setConfig({ enabled: true });

    const created = addFactoryTask("W1N1", "decompress_battery", { amount: 1000 });
    expect(created).toEqual(expect.objectContaining({ ok: true, taskId: "factoryTask:W1N1:decompress_battery:1000" }));

    runFactoryControl();

    const tasks = listFactoryTasks("W1N1");
    expect(tasks).toEqual([
      expect.objectContaining({
        id: "factoryTask:W1N1:decompress_battery:1000",
        roomName: "W1N1",
        type: "decompress_battery",
        status: "loading",
        requestedBatteryAmount: 1000,
        remainingBatteryAmount: 1000,
      }),
    ]);

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    const carrierTasks = listCarrierTasksByRoom("W1N1");
    expect(carrierTasks).toHaveLength(1);
    expect(carrierTasks[0]).toEqual(expect.objectContaining({
      id: "factoryControl:factory_task:factoryTask:W1N1:decompress_battery:1000:supply",
      producer: "factoryControl",
      type: "factory_supply",
    }));
    expect(carrierTasks[0].steps[0]).toEqual(expect.objectContaining({
      resource: RESOURCE_BATTERY,
      fromKind: "storage",
      toKind: "factory",
      fromId: storage.id,
      toId: factory.id,
      amount: 1000,
    }));
    expect(factory.produce).not.toHaveBeenCalled();
  });

  it("produces energy from loaded battery and unloads output before completing", () => {
    const { room, factory, terminal } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, [RESOURCE_BATTERY]: 1000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ [RESOURCE_BATTERY]: 50 }, 50000),
        cooldown: 0,
      },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000 }, 300000);
    setupGameRooms({ W1N1: room });
    setConfig({ enabled: true });
    addFactoryTask("W1N1", "decompress_battery", { amount: 50 });

    runFactoryControl();

    expect(factory.produce).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(listFactoryTasks("W1N1")[0]).toEqual(expect.objectContaining({
      status: "producing",
      producedEnergyAmount: 0,
    }));

    (factory as any).store = createMockStore({ [RESOURCE_ENERGY]: 500 }, 50000);
    Game.time = 1001;
    runFactoryControl();

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    const unloadTasks = listCarrierTasksByRoom("W1N1").filter((task: any) => task.type === "factory_unload");
    expect(unloadTasks).toHaveLength(1);
    expect(unloadTasks[0]).toEqual(expect.objectContaining({
      id: "factoryControl:factory_task:factoryTask:W1N1:decompress_battery:50:unload",
      producer: "factoryControl",
    }));
    expect(unloadTasks[0].steps[0]).toEqual(expect.objectContaining({
      resource: RESOURCE_ENERGY,
      fromKind: "factory",
      amount: 500,
    }));
    expect(listFactoryTasks("W1N1")[0]).toEqual(expect.objectContaining({
      status: "unloading",
      producedEnergyAmount: 500,
    }));

    (factory as any).store = createMockStore({}, 50000);
    Game.time = 1002;
    runFactoryControl();

    expect(listFactoryTasks("W1N1")[0]).toEqual(expect.objectContaining({
      status: "done",
      completedAt: 1002,
      producedEnergyAmount: 500,
    }));
    expect(listCarrierTasksByRoom("W1N1").filter((task: any) => task.producer === "factoryControl")).toHaveLength(0);
  });

  it("cancels a factory task and clears its carrier tasks", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, [RESOURCE_BATTERY]: 500 },
      factoryOverrides: { store: createMockStore({}, 50000) },
    });
    setupGameRooms({ W1N1: room });
    setConfig({ enabled: true });
    const created = addFactoryTask("W1N1", "decompress_battery", { amount: 500 });
    if (typeof created === "string") throw new Error(created);
    runFactoryControl();

    const result = cancelFactoryTask(created.taskId);

    expect(result).toEqual(expect.objectContaining({ ok: true, taskId: created.taskId, previousStatus: "loading" }));
    expect(listFactoryTasks("W1N1")[0]).toEqual(expect.objectContaining({
      id: created.taskId,
      status: "cancelled",
      completedAt: 1000,
    }));
    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    expect(listCarrierTasksByRoom("W1N1").filter((task: any) => task.producer === "factoryControl")).toHaveLength(0);
  });
});

describe("cooldown and capacity", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
  });

  it("skips produce during cooldown but stays in producing stage", () => {
    const { room, factory } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ [RESOURCE_ENERGY]: 600 }, 50000),
        cooldown: 5,
      },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("producing");
    expect(factory.produce).not.toHaveBeenCalled();
  });

  it("blocks when factory has no free capacity for output", () => {
    const { room, factory } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ [RESOURCE_ENERGY]: 2999 }, 3000),
        cooldown: 0,
      },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("blocked");
    expect(state!.sleepReason).toBe("factory_output_full");
    expect(state!.lastError).toBe("factory_full");
    expect(factory.produce).not.toHaveBeenCalled();
  });

  it("blocks when terminal has no capacity for output (backpressure)", () => {
    const { room, factory, storage } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ [RESOURCE_ENERGY]: 600 }, 50000),
        cooldown: 0,
      },
    });
    (storage as any).store = createMockStore({ [RESOURCE_ENERGY]: 1000000 }, 1000000);
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("blocked");
    expect(state!.sleepReason).toBe("terminal_backpressure");
    expect(factory.produce).not.toHaveBeenCalled();
  });

  it("blocks unloading when terminal and storage have no capacity for product", () => {
    const { room, storage } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ battery: 50 }, 50000),
        cooldown: 0,
      },
    });
    (storage as any).store = createMockStore({ [RESOURCE_ENERGY]: 1000000 }, 1000000);
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("blocked");
    expect(state!.sleepReason).toBe("unload_target_full");

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    const tasks = listCarrierTasksByRoom("W1N1");
    expect(tasks.length).toBe(0);
  });

  it("replaces supply tasks when active target changes", () => {
    const { room, terminal } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000, U: 2000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({}, 50000),
      },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, battery: 0 }, 300000);
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    let tasks = listCarrierTasksByRoom("W1N1");
    let supplyTasks = tasks.filter((t: any) => t.type === "factory_supply");
    expect(supplyTasks.length).toBeGreaterThanOrEqual(1);
    const hasEnergyStep = supplyTasks.some((t: any) =>
      t.steps.some((s: any) => s.resource === "energy"),
    );
    expect(hasEnergyStep).toBe(true);

    setConfig({
      enabled: true,
      targets: [{ resource: "utrium_bar", targetAmount: 100 }],
    });

    Game.time = 1001;
    runFactoryControl();

    tasks = listCarrierTasksByRoom("W1N1");
    supplyTasks = tasks.filter((t: any) => t.type === "factory_supply");
    const hasUStep = supplyTasks.some((t: any) =>
      t.steps.some((s: any) => s.resource === "U"),
    );
    expect(hasUStep).toBe(true);
  });

  it("clears carrier tasks when room sleeps", () => {
    const { room, terminal } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({}, 50000),
      },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, battery: 0 }, 300000);
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 100 }],
    });

    runFactoryControl();

    const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
    let tasks = listCarrierTasksByRoom("W1N1");
    expect(tasks.length).toBeGreaterThan(0);

    setConfig({
      enabled: true,
      targets: [],
    });

    Game.time = 1001;
    runFactoryControl();

    tasks = listCarrierTasksByRoom("W1N1");
    expect(tasks.length).toBe(0);

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state!.stage).toBe("sleeping");
    expect(state!.sleepReason).toBe("empty_target_queue");
  });
});

function setupMarketMocks(overrides: Partial<GameWithPartialMarket["market"]> = {}): void {
  (Game as GameWithPartialMarket).market = {
    calcTransactionCost: jest.fn(() => 0),
    getAllOrders: jest.fn(() => []),
    deal: jest.fn(() => OK),
    getOrderById: jest.fn(() => null),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> & { id: string; price: number; amount: number; roomName: string }): Order {
  return {
    type: ORDER_BUY,
    resourceType: "battery" as ResourceConstant,
    created: 0,
    remainingAmount: overrides.amount,
    ...overrides,
  };
}

function makeMarketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return {
    enabled: true,
    sellResources: [],
    minSellPrice: {},
    minNetCredits: 0,
    minOrderAmount: 100,
    minPriceRatio: 0,
    maxEnergyCostRatio: 1,
    orderBlacklist: new Set(),
    orderAllowlist: new Set(),
    roomAllowlist: new Set(),
    maxBatch: 5000,
    purchaseEnabled: false,
    maxBuyPrice: {},
    buyMaxBatch: 5000,
    dailyBudget: 0,
    creditReserve: 10000,
    buyResources: [],
    ...overrides,
  };
}

function makeRuntime(claimedOrders?: FactoryControlRuntime["claimedOrders"]): FactoryControlRuntime {
  return {
    updatedAt: 1000,
    rooms: {},
    claimedOrders: claimedOrders ?? [],
  };
}

const PURCHASE_PRICE_CAP: Partial<Record<ResourceConstant, number>> = {
  silicon: 1.0,
  mist: 1.0,
  biomass: 1.0,
  metal: 1.0,
};

function makePurchaseMarketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return makeMarketConfig({
    purchaseEnabled: true,
    maxBuyPrice: { ...PURCHASE_PRICE_CAP },
    dailyBudget: 100000,
    ...overrides,
  });
}

type TestSaleState = {
  stage: "idle" | "acquiring" | "loading" | "producing" | "unloading" | "blocked" | "sleeping";
  activeTarget?: ResourceConstant;
  missing?: Partial<Record<ResourceConstant, number>>;
  lastTransitionAt: number;
  sleepReason?: string;
  lastError?: string;
};

describe("factory product sale retirement", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
    setupMarketMocks();
  });

  it("does not sell factory products even when the legacy market flag is enabled", () => {
    const { room, terminal } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ battery: 50, energy: 0 }, 50000),
        cooldown: 0,
      },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, battery: 2000 }, 300000);
    setupGameRooms({ W1N1: room });
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeOrder({ id: "legacy-buy", price: 0.8, amount: 5000, roomName: "W2N2" }),
    ]);

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 5000 }],
      market: { enabled: true },
    });

    runFactoryControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("retains the configured terminal energy reserve for purchases", () => {
    setConfig({ enabled: true, terminalEnergyReserve: 5000 });
    expect(parseConfig().terminalEnergyReserve).toBe(5000);
  });

  it("defaults the terminal energy reserve used by purchases to 10000", () => {
    setConfig({ enabled: true });
    expect(parseConfig().terminalEnergyReserve).toBe(10000);
  });
});

function makeSellOrder(
  overrides: Partial<Order> & { id: string; price: number; amount: number; roomName: string },
): Order {
  return {
    type: ORDER_SELL,
    resourceType: "silicon" as ResourceConstant,
    created: 0,
    remainingAmount: overrides.amount,
    ...overrides,
  };
}

describe("regional raw purchase", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
    setupMarketMocks();
    (Game.market as any).credits = 100000;
  });

  it("keeps regional raw purchases reachable while the legacy sale latch is disabled", () => {
    const { room, terminal } = createFactoryRoom({
      terminalResources: { [RESOURCE_ENERGY]: 25000, silicon: 0 },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, silicon: 0 }, 300000);
    setupGameRooms({ W1N1: room });
    setupMarketMocks();
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_SELL) {
        return [
          makeSellOrder({ id: "sell-1", price: 0.1, amount: 5000, roomName: "W2N2", resourceType: "silicon" }),
          makeSellOrder({ id: "sell-2", price: 0.2, amount: 5000, roomName: "W3N3", resourceType: "silicon" }),
        ];
      }
      return [];
    });
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getOrderById = jest.fn((id: string) => {
      if (id === "sell-1") return makeSellOrder({ id: "sell-1", price: 0.1, amount: 5000, roomName: "W2N2", resourceType: "silicon" });
      return null;
    });
    (Game.market as any).credits = 100000;

    setConfig({
      enabled: true,
      targets: [{ resource: "wire", targetAmount: 100 }],
      market: { enabled: false, purchaseEnabled: true, maxBuyPrice: { silicon: 1.0 }, dailyBudget: 100000 },
    });

    runFactoryControl();

    expect(Game.market.deal).toHaveBeenCalledWith("sell-1", expect.any(Number), "W1N1");
    const dealCall = (Game.market.deal as jest.Mock).mock.calls[0];
    expect(dealCall[1]).toBeGreaterThan(0);

    const runtime = Memory.runtime?.factoryControl as FactoryControlRuntime | undefined;
    expect(runtime?.claimedOrders).toBeDefined();
    const buyClaim = runtime!.claimedOrders!.find(c => c.purpose === "buy");
    expect(buyClaim).toBeDefined();
    expect((buyClaim as any).credits).toBeGreaterThan(0);
  });

  it("findSafeSellOrder selects cheapest valid sell order", () => {
    const marketCfg = makePurchaseMarketConfig();
    const runtime = makeRuntime();

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-expensive", price: 0.5, amount: 5000, roomName: "W2N2" }),
      makeSellOrder({ id: "sell-cheap", price: 0.1, amount: 5000, roomName: "W3N3" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).not.toBeNull();
    expect(result!.order.id).toBe("sell-cheap");
    expect(result!.dealAmount).toBe(1000);
  });

  it("does not purchase when terminal energy is below reserve + cost", () => {
    const marketCfg = makePurchaseMarketConfig();
    const runtime = makeRuntime();

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-energy", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 20000);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 12000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).toBeNull();
  });

  it("does not purchase when credits below creditReserve", () => {
    const marketCfg = makePurchaseMarketConfig({ creditReserve: 50000 });
    const runtime = makeRuntime();

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-credits", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 40000,
    );

    expect(result).toBeNull();
  });

  it("does not purchase when dailyBudget exhausted", () => {
    const marketCfg = makePurchaseMarketConfig({ dailyBudget: 50 });
    const runtime = makeRuntime([{
      orderId: "prev-purchase", roomName: "W1N1", tick: 1000, purpose: "buy" as const, credits: 50,
    }]);

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-budget", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).toBeNull();
  });

  it("skips blacklisted sell order", () => {
    const marketCfg = makePurchaseMarketConfig({ orderBlacklist: new Set(["sell-bad"]) });
    const runtime = makeRuntime();

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-bad", price: 0.05, amount: 5000, roomName: "W2N2" }),
      makeSellOrder({ id: "sell-ok", price: 0.1, amount: 5000, roomName: "W3N3" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).not.toBeNull();
    expect(result!.order.id).toBe("sell-ok");
  });

  it("skips same-tick claimed sell order", () => {
    const marketCfg = makePurchaseMarketConfig();
    const runtime = makeRuntime([{
      orderId: "sell-claimed", roomName: "W1N1", tick: 1000, purpose: "buy" as const,
    }]);

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-claimed", price: 0.1, amount: 5000, roomName: "W2N2" }),
      makeSellOrder({ id: "sell-other", price: 0.2, amount: 5000, roomName: "W3N3" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).not.toBeNull();
    expect(result!.order.id).toBe("sell-other");
  });

  it("returns null when maxBuyPrice not configured for resource", () => {
    const marketCfg = makePurchaseMarketConfig({ maxBuyPrice: {} });
    const runtime = makeRuntime();

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-no-cap", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).toBeNull();
  });

  it("returns null when dailyBudget is zero", () => {
    const marketCfg = makePurchaseMarketConfig({ dailyBudget: 0 });
    const runtime = makeRuntime();

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-no-budget", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);

    const result = findSafeSellOrder(
      "silicon" as ResourceConstant, 1000, 25000, 10000, 200000,
      "W1N1", marketCfg, runtime, 1000, 100000,
    );

    expect(result).toBeNull();
  });

  it("rejects sell order via revalidation when order gone", () => {
    const { room, terminal } = createFactoryRoom({
      terminalResources: { [RESOURCE_ENERGY]: 25000, silicon: 0 },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, silicon: 0 }, 300000);
    setupMarketMocks();
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-gone", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getOrderById = jest.fn(() => null);
    (Game.market as any).credits = 100000;

    const config = parseConfig();
    config.market = makePurchaseMarketConfig();
    const runtime = makeRuntime();
    const state: TestSaleState = {
      stage: "blocked",
      activeTarget: "wire" as ResourceConstant,
      missing: { silicon: 500 },
      lastTransitionAt: 1000,
    };

    attemptRegionalRawPurchase(room, state, config, runtime, "W1N1");

    expect(state.lastError).toBe("purchase_order_gone");
    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("rejects sell order via revalidation when price changed", () => {
    const { room, terminal } = createFactoryRoom({
      terminalResources: { [RESOURCE_ENERGY]: 25000, silicon: 0 },
    });
    (terminal as any).store = createMockStore({ [RESOURCE_ENERGY]: 25000, silicon: 0 }, 300000);
    setupMarketMocks();
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      makeSellOrder({ id: "sell-changed", price: 0.1, amount: 5000, roomName: "W2N2" }),
    ]);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getOrderById = jest.fn(() =>
      makeSellOrder({ id: "sell-changed", price: 5.0, amount: 5000, roomName: "W2N2" }),
    );
    (Game.market as any).credits = 100000;

    const config = parseConfig();
    config.market = makePurchaseMarketConfig();
    const runtime = makeRuntime();
    const state: TestSaleState = {
      stage: "blocked",
      activeTarget: "wire" as ResourceConstant,
      missing: { silicon: 500 },
      lastTransitionAt: 1000,
    };

    attemptRegionalRawPurchase(room, state, config, runtime, "W1N1");

    expect(state.lastError).toBe("purchase_order_changed");
    expect(Game.market.deal).not.toHaveBeenCalled();
  });
});

describe("does not buy intermediates", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
    setupMarketMocks();
    (Game.market as any).credits = 100000;
  });

  it("does not purchase missing utrium_bar (intermediate)", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
      factoryOverrides: { level: 1 },
    });
    setupGameRooms({ W1N1: room });
    setupMarketMocks();
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);
    (Game.market as any).credits = 100000;

    setConfig({
      enabled: true,
      targets: [{ resource: "composite", targetAmount: 20 }],
      market: { enabled: true, purchaseEnabled: true, maxBuyPrice: { silicon: 1.0 }, dailyBudget: 100000 },
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.missing).toBeDefined();

    const dealCalls = (Game.market.deal as jest.Mock).mock.calls;
    expect(dealCalls.length).toBe(0);
  });

  it("does not purchase when active target dependency tree does not require the raw material", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
      factoryOverrides: { level: 0, store: createMockStore({ [RESOURCE_ENERGY]: 600 }, 50000) },
    });
    setupGameRooms({ W1N1: room });
    setupMarketMocks();
    (Game.market as any).credits = 100000;

    setConfig({
      enabled: true,
      targets: [{ resource: "battery", targetAmount: 1000 }],
      market: { enabled: true, purchaseEnabled: true, maxBuyPrice: { silicon: 1.0 }, dailyBudget: 100000 },
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("does not purchase when purchaseEnabled is false", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, silicon: 0 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });
    setupMarketMocks();
    (Game.market as any).credits = 100000;

    setConfig({
      enabled: true,
      targets: [{ resource: "wire", targetAmount: 100 }],
      market: { enabled: true, purchaseEnabled: false },
    });

    runFactoryControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("does not purchase non-regional raw base resources (minerals)", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
      factoryOverrides: { level: 0 },
    });
    setupGameRooms({ W1N1: room });
    setupMarketMocks();
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);
    (Game.market as any).credits = 100000;

    setConfig({
      enabled: true,
      targets: [{ resource: "utrium_bar", targetAmount: 100 }],
      market: { enabled: true, purchaseEnabled: true, maxBuyPrice: { silicon: 1.0 }, dailyBudget: 100000 },
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.missing).toBeDefined();
    if (state!.missing) {
      expect(state!.missing.U).toBeGreaterThan(0);
    }

    expect(Game.market.deal).not.toHaveBeenCalled();
  });
});

describe("recursive intermediate purchase guard", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
    setupMarketMocks();
    (Game.market as any).credits = 100000;
  });

  it("does not purchase missing bars needed for composite", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
      factoryOverrides: { level: 1 },
    });
    setupGameRooms({ W1N1: room });
    setupMarketMocks();
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);
    (Game.market as any).credits = 100000;

    setConfig({
      enabled: true,
      targets: [{ resource: "composite", targetAmount: 20 }],
      market: { enabled: true, purchaseEnabled: true, maxBuyPrice: { silicon: 1.0 }, dailyBudget: 100000 },
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.missing).toBeDefined();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });
});
