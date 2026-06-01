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
} from "@/runtime/factoryControl";

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
