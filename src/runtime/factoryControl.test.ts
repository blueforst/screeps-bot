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
import {
  clearMarketActionArbiterForTest,
  getMarketActionJournal,
} from "@/runtime/marketActionArbiter";

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
});

describe("recursive target queue", () => {

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
});

describe("resource floor", () => {

  it("getRoomStock returns zero for absent resource", () => {
    const { room } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    expect(getRoomStock(room, "U" as ResourceConstant)).toBe(0);
  });
});

describe("factory level gate", () => {

  it("getRequiredFactoryLevel returns level from COMMODITIES", () => {
    expect(getRequiredFactoryLevel("battery" as ResourceConstant)).toBe(0);
    expect(getRequiredFactoryLevel("composite" as ResourceConstant)).toBe(1);
    expect(getRequiredFactoryLevel("crystal" as ResourceConstant)).toBe(2);
    expect(getRequiredFactoryLevel("liquid" as ResourceConstant)).toBe(3);
    expect(getRequiredFactoryLevel("circuit" as ResourceConstant)).toBe(4);
    expect(getRequiredFactoryLevel("device" as ResourceConstant)).toBe(5);
  });
});

describe("runFactoryControl planning", () => {

  it("isProducible returns false for base resources", () => {
    expect(isProducible("energy" as ResourceConstant)).toBe(false);
    expect(isProducible("U" as ResourceConstant)).toBe(false);
    expect(isProducible("silicon" as ResourceConstant)).toBe(false);
    expect(isProducible("power" as ResourceConstant)).toBe(false);
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
});

describe("cooldown and capacity", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
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
    clearMarketActionArbiterForTest();
    setupMarketMocks();
    (Game.market as any).credits = 100000;
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
});
