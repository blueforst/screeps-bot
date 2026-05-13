import { clearCarrierTaskBoardForTest, getCarrierTasksByRoom, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { createResourceTransferTask, ensureResourceTransferTaskStore, getIncomingResourceTransferAmount } from "@/runtime/logistics/resourceTransferTasks";
import { runResourceControl } from "@/runtime/resourceControl";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type GameWithPartialMarket = Omit<Game, "market"> & {
  market: Partial<Market>;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(options: {
  name: string;
  storageResources?: Partial<Record<ResourceConstant, number>>;
  terminalResources?: Partial<Record<ResourceConstant, number>>;
  nativeMineralType?: MineralConstant;
  hasExtractor?: boolean;
  storageFreeCapacity?: number;
}): Room {
  const storageResources = options.storageResources ?? {};
  const terminalResources = options.terminalResources ?? {};
  const storageFreeCapacity = options.storageFreeCapacity ?? 1_000_000;
  const nativeMineral = options.nativeMineralType
    ? ({
        id: `${options.name}-mineral`,
        mineralType: options.nativeMineralType,
      } as Mineral)
    : null;
  const extractor = nativeMineral && options.hasExtractor !== false
    ? ({
        id: `${options.name}-extractor`,
        structureType: STRUCTURE_EXTRACTOR,
      } as StructureExtractor)
    : null;
  return {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        ...storageResources,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(storageResources).reduce((sum, value) => sum + (value || 0), 0);
          }
          return storageResources[resource] || 0;
        },
        getFreeCapacity: () => storageFreeCapacity,
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      send: jest.fn(() => OK),
      store: {
        ...terminalResources,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(terminalResources).reduce((sum, value) => sum + (value || 0), 0);
          }
          return terminalResources[resource] || 0;
        },
        getFreeCapacity: (resource?: ResourceConstant) => {
          const used = resource
            ? terminalResources[resource] || 0
            : Object.values(terminalResources).reduce((sum, value) => sum + (value || 0), 0);
          return 300000 - used;
        },
      },
    } as unknown as StructureTerminal,
    find(type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) {
      if (type === FIND_MINERALS) {
        return nativeMineral ? [nativeMineral] : [];
      }
      if (type === FIND_STRUCTURES) {
        const structures: Structure[] = extractor ? [extractor] : [];
        return opts?.filter ? structures.filter((structure) => opts.filter?.(structure)) : structures;
      }
      return [];
    },
  } as Room;
}

describe("runResourceControl terminal feed tasks", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("creates a storage-to-terminal carrier task for pending non-energy transfers", () => {
    const donor = createRoom({ name: "W4N1", storageResources: { [RESOURCE_KEANIUM]: 5000 }, terminalResources: {} });
    const receiver = createRoom({ name: "W4N2" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 3000, "test");

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)).toMatchObject({
      [`resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`]: {
        type: "terminal_feed",
        steps: [
          {
            resource: RESOURCE_KEANIUM,
            fromKind: "storage",
            toKind: "terminal",
            amount: 3000,
          },
        ],
      },
    });
  });

  it("does not create a terminal feed task when terminal stock already covers the next send", () => {
    const donor = createRoom({ name: "W5N1", storageResources: { [RESOURCE_KEANIUM]: 5000 }, terminalResources: { [RESOURCE_KEANIUM]: 3500 } });
    const receiver = createRoom({ name: "W5N2" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 3000, "test");

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)).toEqual({});
  });

  it("clears stale terminal feed tasks when no pending transfer remains", () => {
    const donor = createRoom({ name: "W6N1", storageResources: { [RESOURCE_KEANIUM]: 5000 }, terminalResources: {} });
    const receiver = createRoom({ name: "W6N2" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    replaceCarrierTasksForProducerRoom("resourceControl:preload", donor.name, [
      {
        id: `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`,
        type: "terminal_feed",
        priority: 80,
        steps: [
          {
            id: "step-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "storage",
            toKind: "terminal",
            fromId: donor.storage!.id,
            toId: donor.terminal!.id,
            amount: 3000,
          },
        ],
      },
    ]);

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)).toEqual({});
  });

  it("creates a storage-to-terminal energy task to maintain terminal reserve from storage", () => {
    const room = createRoom({
      name: "W7N1",
      storageResources: { [RESOURCE_ENERGY]: 240000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [
          {
            resource: RESOURCE_ENERGY,
            fromKind: "storage",
            toKind: "terminal",
            amount: 15000,
          },
        ],
      },
    });
  });

  it("creates a terminal-to-storage energy offload task when storage is below target", () => {
    const room = createRoom({
      name: "W7N2",
      storageResources: { [RESOURCE_ENERGY]: 150000 },
      terminalResources: { [RESOURCE_ENERGY]: 35000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_offload",
        steps: [
          {
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            amount: 10000,
          },
        ],
      },
    });
    expect(getCarrierTasksByRoom(room.name)[`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("does not keep a terminal offload task after a full emergency energy send drains the terminal snapshot", () => {
    const donor = createRoom({
      name: "W7N2A",
      storageResources: { [RESOURCE_ENERGY]: 150000 },
      terminalResources: { [RESOURCE_ENERGY]: 10000 },
    });
    const receiver = createRoom({ name: "W7N2B" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
        rooms: {
          [donor.name]: {
            terminalEnergyReserve: 0,
          },
        },
      },
    };
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 10000, "test");

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("does not offload terminal energy reserved for a pending send while the terminal is on cooldown", () => {
    const donor = createRoom({
      name: "W7N2C",
      storageResources: { [RESOURCE_ENERGY]: 150000 },
      terminalResources: { [RESOURCE_ENERGY]: 10000 },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W7N2D" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
        rooms: {
          [donor.name]: {
            terminalEnergyReserve: 0,
          },
        },
      },
    };
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 10000, "test");

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("stages terminal energy for pending energy sends only after storage is healthy", () => {
    const donor = createRoom({
      name: "W7N3",
      storageResources: { [RESOURCE_ENERGY]: 260000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    const receiver = createRoom({ name: "W7N4" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 3000, "test");

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)).toMatchObject({
      [`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [
          {
            resource: RESOURCE_ENERGY,
            amount: 18000,
          },
        ],
      },
    });
  });

  it("includes transfer fee budget when staging terminal energy for pending sends", () => {
     const donor = createRoom({
       name: "W8N1",
       storageResources: { [RESOURCE_ENERGY]: 260000 },
       terminalResources: { [RESOURCE_ENERGY]: 5000 },
     });
     const receiver = createRoom({ name: "W8N2" });
     Game.rooms[donor.name] = donor;
     Game.rooms[receiver.name] = receiver;
     (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 5000);
     createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 10000, "test");
 
     runResourceControl();
 
     expect(getCarrierTasksByRoom(donor.name)).toMatchObject({
       [`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]: {
         type: "terminal_feed",
         steps: [
           {
             resource: RESOURCE_ENERGY,
            amount: 30000,
           },
         ],
       },
     });
   });

  it("includes fee budget in export staging for auto-balance receivers", () => {
    const donor = createRoom({
      name: "W8N3",
      storageResources: { [RESOURCE_ENERGY]: 300000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    const receiver = createRoom({
      name: "W8N4",
      storageResources: { [RESOURCE_ENERGY]: 100000 },
      terminalResources: {},
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 5000);

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)).toMatchObject({
      [`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [
          {
            resource: RESOURCE_ENERGY,
            amount: 30000,
          },
        ],
      },
    });
  });

  it("stages native minerals above the 10000 threshold into the terminal before selling", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
        },
      },
    };
    const room = createRoom({
      name: "W9N1",
      storageResources: {
        [RESOURCE_ENERGY]: 200000,
        [RESOURCE_KEANIUM]: 11500,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 20000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_feed:${room.name}:${RESOURCE_KEANIUM}`]: {
        type: "terminal_feed",
        steps: [
          {
            resource: RESOURCE_KEANIUM,
            fromKind: "storage",
            toKind: "terminal",
            amount: 1500,
          },
        ],
      },
    });
  });

  it("sells native minerals above the 10000 threshold even before the room reaches export state", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
        },
      },
    };
    const room = createRoom({
      name: "W9N2",
      storageResources: {
        [RESOURCE_ENERGY]: 200000,
        [RESOURCE_KEANIUM]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_KEANIUM]: 1500,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_KEANIUM) {
        return [
          {
            id: "buy-order-1",
            type: ORDER_BUY,
            resourceType: RESOURCE_KEANIUM,
            price: 0.8,
            amount: 1500,
            roomName: "W8N8",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-order-1", 1500, room.name);
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toContain(
      `market-sell:${room.name}:${RESOURCE_KEANIUM}=1500:price=0.800:cost=200`,
    );
  });

  it("does not auto-sell energy even if sellResources includes energy", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
          sellResources: [RESOURCE_ENERGY, RESOURCE_KEANIUM],
        },
        rooms: {
          W9N2E: {
            energyExportStart: 250000,
          },
        },
      },
    };
    const room = createRoom({
      name: "W9N2E",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 30000,
      },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_ENERGY) {
        return [
          {
            id: "buy-order-energy-1",
            type: ORDER_BUY,
            resourceType: RESOURCE_ENERGY,
            price: 0.2,
            amount: 10000,
            roomName: "W8N8",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toEqual([]);
  });

  it("does not buy base minerals just to refill mineralFloor when no synthesis demand exists", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
          maxBuyPrice: {
            [RESOURCE_HYDROGEN]: 1,
          },
        },
        rooms: {
          W9N3: {
            mineralFloor: {
              [RESOURCE_HYDROGEN]: 5000,
            },
          },
        },
      },
    };
    const room = createRoom({
      name: "W9N3",
      storageResources: {
        [RESOURCE_ENERGY]: 200000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
      },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_SELL && filter.resourceType === RESOURCE_HYDROGEN) {
        return [
          {
            id: "sell-order-h-1",
            type: ORDER_SELL,
            resourceType: RESOURCE_HYDROGEN,
            price: 0.5,
            amount: 5000,
            roomName: "W8N8",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toEqual([]);
  });

  it("buys base minerals when synthesis demand is below target", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
          maxBuyPrice: {
            [RESOURCE_HYDROGEN]: 1,
          },
        },
        synthesis: {
          enabled: true,
          rooms: {
            W9N4: {
              demands: {
                [RESOURCE_HYDROGEN]: 5000,
              },
            },
          },
        },
      },
    };
    const room = createRoom({
      name: "W9N4",
      storageResources: {
        [RESOURCE_ENERGY]: 200000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
      },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_SELL && filter.resourceType === RESOURCE_HYDROGEN) {
        return [
          {
            id: "sell-order-h-2",
            type: ORDER_SELL,
            resourceType: RESOURCE_HYDROGEN,
            price: 0.5,
            amount: 5000,
            roomName: "W8N8",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("sell-order-h-2", 5000, room.name);
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toContain(
      `market-buy:${room.name}:${RESOURCE_HYDROGEN}=5000:price=0.500:cost=200`,
    );
  });

  it("buys base minerals when active synthesis runtime state reports missing reagents", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
          maxBuyPrice: {
            [RESOURCE_HYDROGEN]: 1,
          },
        },
      },
    };
    Memory.runtime = {
      synthesisControl: {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W9N5: {
            stage: "acquiring",
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 0,
            missing: {
              [RESOURCE_HYDROGEN]: 3000,
            },
            lastTransitionAt: Game.time,
          },
        },
      },
    };
    const room = createRoom({
      name: "W9N5",
      storageResources: {
        [RESOURCE_ENERGY]: 200000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
      },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 150);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_SELL && filter.resourceType === RESOURCE_HYDROGEN) {
        return [
          {
            id: "sell-order-h-3",
            type: ORDER_SELL,
            resourceType: RESOURCE_HYDROGEN,
            price: 0.45,
            amount: 3000,
            roomName: "W8N8",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("sell-order-h-3", 3000, room.name);
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toContain(
      `market-buy:${room.name}:${RESOURCE_HYDROGEN}=3000:price=0.450:cost=150`,
    );
  });

  it("feeds terminal energy even when storage is below energyTarget", () => {
    const room = createRoom({
      name: "W15N1",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: { [RESOURCE_ENERGY]: 0 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    // energyTarget defaults to 200000, storage has 50000 — should still feed terminal
    expect(getCarrierTasksByRoom(room.name)[`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_feed",
      steps: [
        {
          resource: RESOURCE_ENERGY,
          fromKind: "storage",
          toKind: "terminal",
        },
      ],
    });
  });

  it("reserves terminal energy for pending non-energy transfer fees", () => {
    const donor = createRoom({
      name: "W15N2",
      storageResources: { [RESOURCE_ENERGY]: 50_000, [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_KEANIUM]: 0 },
    });
    const receiver = createRoom({ name: "W15N3" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn((amount: number, _from: string, _to: string) => {
      if (amount > 5000) return 5000;
      return 1000;
    });
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 5000, "hub:import:K");

    runResourceControl();

    const feedTask = getCarrierTasksByRoom(donor.name)[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`];
    expect(feedTask).toMatchObject({
      type: "terminal_feed",
      steps: [
        {
          resource: RESOURCE_ENERGY,
          amount: 21000,
        },
      ],
    });
  });

  it("does not feed terminal energy when storage is empty", () => {
    const room = createRoom({
      name: "W15N4",
      storageResources: { [RESOURCE_ENERGY]: 0 },
      terminalResources: { [RESOURCE_ENERGY]: 0 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    // createTerminalFeedTask caps by storageAmount which is 0
    expect(getCarrierTasksByRoom(room.name)[`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("offloads terminal energy to storage when storage is below target and terminal has surplus", () => {
    const room = createRoom({
      name: "W15N5",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 35_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    // storageEnergy(150000) < energyTarget(200000), terminal has 35000, protected = max(25000, 20000) = 25000
    // offloadable = 10000, should offload min(batchSize=10000, target-storage=50000, offloadable=10000) = 10000
    expect(getCarrierTasksByRoom(room.name)[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_offload",
      steps: [
        {
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "storage",
          amount: 10000,
        },
      ],
    });
  });

});

describe("terminal overflow offload above 250k", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("offloads non-energy terminal overflow above 250000 to storage", () => {
    const room = createRoom({
      name: "W25N1",
      terminalResources: { [RESOURCE_HYDROGEN]: 200_000, [RESOURCE_KEANIUM]: 100_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offloadKeys = Object.keys(tasks).filter(k => k.includes("terminal_offload") && !k.includes(RESOURCE_ENERGY));
    expect(offloadKeys.length).toBeGreaterThanOrEqual(1);
    const totalOffloaded = offloadKeys.reduce((sum, key) => {
      const steps = tasks[key].steps;
      return sum + steps.reduce((s, step) => s + step.amount, 0);
    }, 0);
    expect(totalOffloaded).toBeGreaterThan(0);
  });

  it("does not offload pending outbound send staging even when terminal exceeds 250000", () => {
    const donor = createRoom({
      name: "W25N2",
      terminalResources: { [RESOURCE_HYDROGEN]: 200_000, [RESOURCE_KEANIUM]: 100_000 },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25N2B" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_HYDROGEN, 200_000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    const hOffload = tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_HYDROGEN}`];
    expect(hOffload).toBeUndefined();
  });

  it("offloads only amount above pending send protection", () => {
    const room = createRoom({
      name: "W25N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_UTRIUM]: 100_000 },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25N3B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(room.name, receiver.name, RESOURCE_UTRIUM, 80_000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_UTRIUM}`];
    expect(offload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_UTRIUM, amount: 10_000 }],
    });
  });

  it("caps overflow offload by storage free capacity and transferBatchSize", () => {
    const room = createRoom({
      name: "W25N4",
      terminalResources: { [RESOURCE_HYDROGEN]: 300_000 },
      storageFreeCapacity: 10_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`];
    expect(offload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
  });

  it("pending hub:export XGHO2 is protected from terminal overflow offload", () => {
    const XGHO2 = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
    const room = createRoom({
      name: "W25N7",
      terminalResources: {
        [RESOURCE_ENERGY]: 100_000,
        [XGHO2]: 200_000,
      },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25N7B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    // Terminal total 300k > 250k cap, but 150k XGHO2 is staged for hub export
    createResourceTransferTask(room.name, receiver.name, XGHO2, 150_000, `hub:export:${XGHO2}`);

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offload = tasks[`resourceControl:terminal_offload:${room.name}:${XGHO2}`];
    // 200k XGHO2 in terminal, 150k protected by pending export → at most 50k offloadable
    // Capped by transferBatchSize (10k), so actual offload is 10k
    expect(offload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: XGHO2, amount: 10_000 }],
    });
  });

  it("no offload when terminal total is exactly 250000 or lower", () => {
    const room = createRoom({
      name: "W25N5",
      terminalResources: { [RESOURCE_HYDROGEN]: 100_000, [RESOURCE_KEANIUM]: 150_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offloadKeys = Object.keys(tasks).filter(k => k.includes("terminal_offload") && !k.includes(RESOURCE_ENERGY));
    expect(offloadKeys).toEqual([]);
  });

  it("offloads energy alongside minerals when terminal exceeds 250k", () => {
    const room = createRoom({
      name: "W25N6",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 100_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    // Both energy (above 20k reserve) and H are candidates for overflow offload
    const offloadKeys = Object.keys(tasks).filter(k => k.includes("terminal_offload"));
    expect(offloadKeys.length).toBeGreaterThanOrEqual(1);
    // H should definitely be offloaded (no pending protection)
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN }],
    });
  });

  it("energy counts toward terminal 250000 cap and can be offloaded", () => {
    const room = createRoom({
      name: "W25N8",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 100_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offloadKeys = Object.keys(tasks).filter(k => k.includes("terminal_offload"));
    expect(offloadKeys.length).toBeGreaterThanOrEqual(1);
    const totalOffloaded = offloadKeys.reduce((sum, key) => {
      const steps = tasks[key].steps;
      return sum + steps.reduce((s, step) => s + step.amount, 0);
    }, 0);
    expect(totalOffloaded).toBeGreaterThan(0);
  });

  it("energy-only terminal overflow offloads only above protected energy", () => {
    const room = createRoom({
      name: "W25N9",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 260_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    // Protected = 20k reserve + 0 pending = 20k. Offloadable = 240k. Cap overflow = 10k.
    // amount = min(240000, 10000, 10000 transferBatchSize, storageFree) = 10000
    expect(offload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("energy offload protects terminalEnergyReserve and pending send fee reserve", () => {
    const room = createRoom({
      name: "W25N10",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 260_000 },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25N10B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    // Pending mineral send: fee reserve = calcTransactionCost(10000, ...) which we mock to 5000
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 5000);
    createResourceTransferTask(room.name, receiver.name, RESOURCE_HYDROGEN, 50_000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const energyOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    // Protected = 20k reserve + 5k mineral fee = 25k
    // Offloadable = 260k - 25k = 235k. Cap overflow = 10k.
    // amount = min(235000, 10000, 10000, storageFree) = 10000
    expect(energyOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("does not offload energy below reserve even when terminal is above 250k", () => {
    const room = createRoom({
      name: "W25N11",
      storageResources: { [RESOURCE_ENERGY]: 0 },
      terminalResources: { [RESOURCE_ENERGY]: 260_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const energyOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    // Protected = 20k. Offloadable = 240k. Cap overflow = 10k.
    // But storageFree for storage with 0 energy: storageFree = 1000000 - 0 = 1000000
    // amount = min(240000, 10000, 10000, 1000000) = 10000
    // The offload should respect the reserve — only offloads above 20k
    expect(energyOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("overflow offload suppresses terminal feed for the same mineral", () => {
    const room = createRoom({
      name: "W25O1",
      storageResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 10_000 },
      terminalResources: { [RESOURCE_HYDROGEN]: 200_000, [RESOURCE_KEANIUM]: 100_000 },
    });
    const receiver = createRoom({ name: "W25O1B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(room.name, receiver.name, RESOURCE_HYDROGEN, 5000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toBeDefined();
    expect(tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`]).toBeUndefined();
  });

  it("below-cap terminal still creates mineral feed for pending exports", () => {
    const room = createRoom({
      name: "W25O2",
      storageResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 10_000 },
      terminalResources: { [RESOURCE_HYDROGEN]: 2_000 },
    });
    const receiver = createRoom({ name: "W25O2B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(room.name, receiver.name, RESOURCE_HYDROGEN, 5000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, fromKind: "storage", toKind: "terminal" }],
    });
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toBeUndefined();
  });

  it("energy terminal task is unaffected by mineral offload feed suppression", () => {
    const room = createRoom({
      name: "W25O3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 5_000, [RESOURCE_HYDROGEN]: 200_000, [RESOURCE_KEANIUM]: 100_000 },
    });
    const receiver = createRoom({ name: "W25O3B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, fromKind: "storage", toKind: "terminal" }],
    });
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toBeDefined();
  });
});

describe("executeTransferTasks hub-aware priority ordering", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("executes hub import before hub export with limited taskMaxPerRun", () => {
    const hubRoom = createRoom({
      name: "W10N1",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
    });
    const importDonor = createRoom({
      name: "W10N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_OXYGEN]: 5000 },
    });
    const exportTarget = createRoom({
      name: "W10N3",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 20000 },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[importDonor.name] = importDonor;
    Game.rooms[exportTarget.name] = exportTarget;

    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;

    createResourceTransferTask(hubRoom.name, exportTarget.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000, "hub:export:XGHO2");
    createResourceTransferTask(importDonor.name, hubRoom.name, RESOURCE_OXYGEN, 3000, "hub:import:O");

    runResourceControl();

    expect(importDonor.terminal.send).toHaveBeenCalledWith(
      RESOURCE_OXYGEN, 3000, hubRoom.name, expect.any(String),
    );
    expect(hubRoom.terminal.send).not.toHaveBeenCalled();
  });

  it("prioritizes survival energy transfers over hub exports", () => {
    const survivalRoom = createRoom({
      name: "W11N1",
      storageResources: { [RESOURCE_ENERGY]: 50000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    const energyDonor = createRoom({
      name: "W11N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    const hubExportRoom = createRoom({
      name: "W11N3",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
    });
    const exportTarget = createRoom({
      name: "W11N4",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 20000 },
    });
    Game.rooms[survivalRoom.name] = survivalRoom;
    Game.rooms[energyDonor.name] = energyDonor;
    Game.rooms[hubExportRoom.name] = hubExportRoom;
    Game.rooms[exportTarget.name] = exportTarget;

    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;

    createResourceTransferTask(hubExportRoom.name, exportTarget.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000, "hub:export:XGHO2");
    createResourceTransferTask(energyDonor.name, survivalRoom.name, RESOURCE_ENERGY, 5000, "energy-support");

    runResourceControl();

    expect(energyDonor.terminal.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY, 5000, survivalRoom.name, expect.any(String),
    );
    expect(hubExportRoom.terminal.send).not.toHaveBeenCalled();
  });

  it("respects taskMaxPerRun limit with hub-aware ordering", () => {
    const room1 = createRoom({
      name: "W13N1",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_KEANIUM]: 10000 },
    });
    const room2 = createRoom({
      name: "W13N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_KEANIUM]: 10000 },
    });
    const room3 = createRoom({
      name: "W13N3",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_KEANIUM]: 10000 },
    });
    const target = createRoom({
      name: "W13N4",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 20000 },
    });
    Game.rooms[room1.name] = room1;
    Game.rooms[room2.name] = room2;
    Game.rooms[room3.name] = room3;
    Game.rooms[target.name] = target;

    Memory.cfg!.resourceControl!.taskMaxPerRun = 2;

    createResourceTransferTask(room1.name, target.name, RESOURCE_KEANIUM, 3000, "test:a");
    createResourceTransferTask(room2.name, target.name, RESOURCE_KEANIUM, 3000, "test:b");
    createResourceTransferTask(room3.name, target.name, RESOURCE_KEANIUM, 3000, "test:c");

    runResourceControl();

    let sendCount = 0;
    sendCount += (room1.terminal.send as jest.Mock).mock.calls.length;
    sendCount += (room2.terminal.send as jest.Mock).mock.calls.length;
    sendCount += (room3.terminal.send as jest.Mock).mock.calls.length;
    expect(sendCount).toBe(2);
  });

  it("hub room does not sell hub intermediates (OH, G) on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14N1",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N1",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROXIDE]: 20000,
        [RESOURCE_GHODIUM]: 15000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROXIDE]: 5000,
        [RESOURCE_GHODIUM]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && (filter.resourceType === RESOURCE_HYDROXIDE || filter.resourceType === RESOURCE_GHODIUM)) {
        return [
          {
            id: `buy-${filter.resourceType}`,
            type: ORDER_BUY,
            resourceType: filter.resourceType,
            price: 1.0,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("market-sell") && a.includes("OH"))).toBe(false);
    expect(actions.some((a: string) => a.includes("market-sell") && a.includes("G"))).toBe(false);
  });

  it("hub room does not sell selected T3 compounds on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14N2",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N2",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_CATALYZED_UTRIUM_ACID];
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_CATALYZED_UTRIUM_ACID) {
        return [
          {
            id: "buy-xutrium",
            type: ORDER_BUY,
            resourceType: RESOURCE_CATALYZED_UTRIUM_ACID,
            price: 5.0,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("hub room does not sell base minerals on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14N3",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N3",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROGEN]: 20000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROGEN]: 10000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROGEN) {
        return [
          {
            id: "buy-h",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROGEN,
            price: 0.5,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("hub room does not sell T2 intermediates (UH2O) on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14N4",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N4",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_UTRIUM_ACID]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_UTRIUM_ACID]: 5000,
      },
      nativeMineralType: RESOURCE_UTRIUM,
    });
    Game.rooms[room.name] = room;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_UTRIUM_ACID];
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_UTRIUM_ACID) {
        return [
          {
            id: "buy-uh2o",
            type: ORDER_BUY,
            resourceType: RESOURCE_UTRIUM_ACID,
            price: 1.0,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("hub room energy balancing still works when hub config is present", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14N5",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    const donor = createRoom({
      name: "W14N5",
      storageResources: { [RESOURCE_ENERGY]: 300000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    const receiver = createRoom({
      name: "W14N6",
      storageResources: { [RESOURCE_ENERGY]: 50000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    expect(donor.terminal.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY, expect.any(Number), receiver.name, "resourceControl:auto-balance",
    );
  });

  it("non-hub room does not sell selected T3 at reserve level", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14HUB",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N7",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_CATALYZED_UTRIUM_ACID];
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_CATALYZED_UTRIUM_ACID) {
        return [
          {
            id: "buy-xutrium",
            type: ORDER_BUY,
            resourceType: RESOURCE_CATALYZED_UTRIUM_ACID,
            price: 5.0,
            amount: 1000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("non-hub room does not sell surplus selected T3 (left for hubPlanner reclaim)", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14HUB",
      targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N8",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 8000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 3000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_CATALYZED_GHODIUM_ALKALIDE];
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_CATALYZED_GHODIUM_ALKALIDE) {
        return [
          {
            id: "buy-xgho2",
            type: ORDER_BUY,
            resourceType: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            price: 5.0,
            amount: 3000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("non-hub room can still sell non-hub-managed minerals normally", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W14HUB",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W14N9",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_KEANIUM]: 20000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_KEANIUM]: 5000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_KEANIUM) {
        return [
          {
            id: "buy-k",
            type: ORDER_BUY,
            resourceType: RESOURCE_KEANIUM,
            price: 0.8,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-k", 5000, room.name);
  });

  it("does not skip hub export when hub import task exists for a different resource", () => {
    const hubRoom = createRoom({
      name: "W12N1",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
    });
    const importDonor = createRoom({
      name: "W12N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_OXYGEN]: 30000 },
    });
    const exportTarget = createRoom({
      name: "W12N3",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 20000 },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[importDonor.name] = importDonor;
    Game.rooms[exportTarget.name] = exportTarget;

    Memory.cfg!.resourceControl!.taskMaxPerRun = 10;

    createResourceTransferTask(importDonor.name, hubRoom.name, RESOURCE_OXYGEN, 30000, "hub:import:O");
    createResourceTransferTask(hubRoom.name, exportTarget.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000, "hub:export:XGHO2");

    runResourceControl();

    expect(importDonor.terminal.send).toHaveBeenCalledWith(
      RESOURCE_OXYGEN, expect.any(Number), hubRoom.name, expect.any(String),
    );
    expect(hubRoom.terminal.send).toHaveBeenCalledWith(
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE, expect.any(Number), exportTarget.name, expect.any(String),
    );
  });

  it("skips hub export when hub import task exists for same resource", () => {
    const hubRoom = createRoom({
      name: "W12N1",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 8000 },
    });
    const importDonor = createRoom({
      name: "W12N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 30000 },
    });
    const exportTarget = createRoom({
      name: "W12N3",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 20000 },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[importDonor.name] = importDonor;
    Game.rooms[exportTarget.name] = exportTarget;

    Memory.cfg!.resourceControl!.taskMaxPerRun = 10;

    createResourceTransferTask(importDonor.name, hubRoom.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 30000, "hub:import:XGHO2");
    createResourceTransferTask(hubRoom.name, exportTarget.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000, "hub:export:XGHO2");

    runResourceControl();

    expect(importDonor.terminal.send).toHaveBeenCalledWith(
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE, expect.any(Number), hubRoom.name, expect.any(String),
    );
    expect(hubRoom.terminal.send).not.toHaveBeenCalled();
  });

  it("pending outgoing transfer prevents market sale of same resource", () => {
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_HYDROGEN];
    const room = createRoom({
      name: "W20N1",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROGEN]: 11000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROGEN]: 5000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    const destRoom = createRoom({
      name: "W20N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[room.name] = room;
    Game.rooms[destRoom.name] = destRoom;
    createResourceTransferTask(room.name, destRoom.name, RESOURCE_HYDROGEN, 5500, "hub:import:H");
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROGEN) {
        return [
          {
            id: "buy-h",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROGEN,
            price: 1.0,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("pending outgoing transfer does not block market sale of unrelated resource", () => {
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W20N3",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_KEANIUM]: 15000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_KEANIUM]: 5000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;
    createResourceTransferTask(room.name, "W20N4", RESOURCE_HYDROGEN, 5000, "hub:import:H");
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_KEANIUM) {
        return [
          {
            id: "buy-k2",
            type: ORDER_BUY,
            resourceType: RESOURCE_KEANIUM,
            price: 0.8,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-k2", 5000, room.name);
  });

  it("no pending transfers — normal market sell behavior unchanged", () => {
    Memory.cfg!.resourceControl!.market!.enabled = true;
    const room = createRoom({
      name: "W20N5",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROGEN]: 20000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROGEN]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROGEN) {
        return [
          {
            id: "buy-h2",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROGEN,
            price: 1.0,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-h2", 5000, room.name);
  });

  it("transfer task terminal send suppresses same-tick market deal for that room", () => {
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_KEANIUM];
    const donor = createRoom({
      name: "W30N1",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_KEANIUM]: 20000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_KEANIUM]: 5000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    const receiver = createRoom({
      name: "W30N2",
      storageResources: { [RESOURCE_ENERGY]: 50000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 3000, "test:terminal-busy");
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_KEANIUM) {
        return [
          {
            id: "buy-k-busy",
            type: ORDER_BUY,
            resourceType: RESOURCE_KEANIUM,
            price: 0.8,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    // Transfer task should have used the terminal
    expect(donor.terminal.send).toHaveBeenCalled();
    // Market deal should be skipped because terminal is now busy
    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("idle room without terminal activity still executes market deals", () => {
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_KEANIUM];
    const donor = createRoom({
      name: "W30N3",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_KEANIUM]: 5000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_KEANIUM]: 5000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    const idleRoom = createRoom({
      name: "W30N4",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_KEANIUM]: 20000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_KEANIUM]: 5000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    const receiver = createRoom({
      name: "W30N5",
      storageResources: { [RESOURCE_ENERGY]: 150000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[idleRoom.name] = idleRoom;
    // Transfer task only involves donor → receiver, idleRoom is free
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 3000, "test:idle-check");
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_KEANIUM) {
        return [
          {
            id: "buy-k-idle",
            type: ORDER_BUY,
            resourceType: RESOURCE_KEANIUM,
            price: 0.8,
            amount: 5000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    // Donor's terminal was used by transfer task
    expect(donor.terminal.send).toHaveBeenCalled();
    // Idle room's market deal should still go through
    expect(Game.market.deal).toHaveBeenCalledWith("buy-k-idle", 5000, idleRoom.name);
  });

});

describe("hub internalOnly market buy", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
          maxBuyPrice: {
            [RESOURCE_HYDROGEN]: 1,
          },
        },
        synthesis: {
          enabled: true,
          rooms: {},
        },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 200),
      getAllOrders: jest.fn((filter: OrderFilter) => {
        if (filter.type === ORDER_SELL && filter.resourceType === RESOURCE_HYDROGEN) {
          return [
            {
              id: "sell-h-internal",
              type: ORDER_SELL,
              resourceType: RESOURCE_HYDROGEN,
              price: 0.5,
              amount: 5000,
              roomName: "W0N0",
            } as Order,
          ];
        }
        return [];
      }),
      deal: jest.fn(() => OK),
    };
  });

  function setHubSynthesisDemand(roomName: string, resource: ResourceConstant, amount: number): void {
    Memory.cfg!.resourceControl!.synthesis!.rooms![roomName] = { demands: { [resource]: amount } };
  }

  it("hub room with internalOnly (default) does not buy minerals from market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    setHubSynthesisDemand("W1N1", RESOURCE_HYDROGEN, 5000);
    const room = createRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("market-buy") && a.includes("H"))).toBe(false);
  });

  it("hub room with internalOnly: false allows mineral market buy", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W1N2",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
      internalOnly: false,
    };
    setHubSynthesisDemand("W1N2", RESOURCE_HYDROGEN, 5000);
    const room = createRoom({
      name: "W1N2",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("sell-h-internal", 5000, room.name);
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toContain(
      `market-buy:${room.name}:${RESOURCE_HYDROGEN}=5000:price=0.500:cost=200`,
    );
  });

  it("non-hub room still buys minerals regardless of hub internalOnly", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W1N1_HUB",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    setHubSynthesisDemand("W1N3", RESOURCE_HYDROGEN, 5000);
    const room = createRoom({
      name: "W1N3",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("sell-h-internal", 5000, room.name);
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toContain(
      `market-buy:${room.name}:${RESOURCE_HYDROGEN}=5000:price=0.500:cost=200`,
    );
  });

  it("hub room internalOnly does not affect emergency energy buy", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W1N4",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.emergencyBuyEnabled = true;
    Memory.cfg!.resourceControl!.market!.maxBuyPrice![RESOURCE_ENERGY] = 1;
    const room = createRoom({
      name: "W1N4",
      storageResources: { [RESOURCE_ENERGY]: 50000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_SELL && filter.resourceType === RESOURCE_ENERGY) {
        return [
          {
            id: "sell-energy-hub",
            type: ORDER_SELL,
            resourceType: RESOURCE_ENERGY,
            price: 0.1,
            amount: 10000,
            roomName: "W0N0",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("sell-energy-hub", expect.any(Number), room.name);
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("market-buy") && a.includes("energy"))).toBe(true);
  });

  it("hub room with explicit internalOnly: true does not buy minerals", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W1N5",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
      internalOnly: true,
    };
    setHubSynthesisDemand("W1N5", RESOURCE_HYDROGEN, 5000);
    const room = createRoom({
      name: "W1N5",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

});

describe("terminal energy jitter", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("boundary no-op: storage slightly below target + terminal slightly above reserve produces no task", () => {
    const room = createRoom({
      name: "WJ1",
      storageResources: { [RESOURCE_ENERGY]: 195000 },
      terminalResources: { [RESOURCE_ENERGY]: 22000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
    expect(tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("true surplus offload: storage well below target + terminal well above reserve produces offload", () => {
    const room = createRoom({
      name: "WJ2",
      storageResources: { [RESOURCE_ENERGY]: 180000 },
      terminalResources: { [RESOURCE_ENERGY]: 35000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_offload",
        steps: [
          {
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            amount: 10000,
          },
        ],
      },
    });
  });

  it("consecutive stability: offload then equilibrium produces no energy task", () => {
    const room = createRoom({
      name: "WJ3",
      storageResources: { [RESOURCE_ENERGY]: 180000 },
      terminalResources: { [RESOURCE_ENERGY]: 35000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_offload",
    });

    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 20;
    Memory.cfg!.resourceControl!.sampleInterval = 10;

    const roomAfter = createRoom({
      name: "WJ3",
      storageResources: { [RESOURCE_ENERGY]: 190000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    Game.rooms[roomAfter.name] = roomAfter;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(roomAfter.name);
    expect(tasks[`resourceControl:terminal_offload:${roomAfter.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
    expect(tasks[`resourceControl:terminal_feed:${roomAfter.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("feed still works: terminal below reserve creates feed task", () => {
    const room = createRoom({
      name: "WJ4",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [
          {
            resource: RESOURCE_ENERGY,
            fromKind: "storage",
            toKind: "terminal",
          },
        ],
      },
    });
  });

  it("pending/reserved energy protection: terminal energy above zero but below reserve+pending+batch produces no offload", () => {
    const donor = createRoom({
      name: "WJ5",
      storageResources: { [RESOURCE_ENERGY]: 150000 },
      terminalResources: { [RESOURCE_ENERGY]: 28000 },
    });
    const receiver = createRoom({ name: "WJ5R" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    // calcTransactionCost returns 3000 per batch, so pending energy send reserves:
    // stagedEnergy=10000 + feeBudget=3000 = 13000 reserved
    // protectedTerminalEnergy = 20000 (reserve) + 13000 (reserved) = 33000
    // terminal has 28000, which is below 33000 → no offload
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 3000);
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 10000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

});

describe("terminalEnergyReserve default 20000", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("uses 20000 terminalEnergyReserve by default for send and receive buffer", () => {
    const room = createRoom({
      name: "W50N1",
      storageResources: { [RESOURCE_ENERGY]: 100_000 },
      terminalResources: { [RESOURCE_ENERGY]: 0 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [{ resource: RESOURCE_ENERGY, amount: 20000 }],
      },
    });
  });

  it("keeps per-room terminalEnergyReserve override behavior", () => {
    Memory.cfg!.resourceControl!.rooms = {
      W50N2: { terminalEnergyReserve: 10_000 },
    };
    const room = createRoom({
      name: "W50N2",
      storageResources: { [RESOURCE_ENERGY]: 100_000 },
      terminalResources: { [RESOURCE_ENERGY]: 0 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(getCarrierTasksByRoom(room.name)).toMatchObject({
      [`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [{ resource: RESOURCE_ENERGY, amount: 10000 }],
      },
    });
  });

  it("feeds terminal to 20000 reserve plus pending send fee budget", () => {
    const donor = createRoom({
      name: "W50N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    const receiver = createRoom({ name: "W50N4" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 2000);
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 3000, "test");

    runResourceControl();

    expect(getCarrierTasksByRoom(donor.name)).toMatchObject({
      [`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]: {
        type: "terminal_feed",
        steps: [{ resource: RESOURCE_ENERGY, amount: 20000 }],
      },
    });
  });

  it("does not offload terminal energy protected by 20000 reserve and pending sends", () => {
    const donor = createRoom({
      name: "W50N5",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000 },
    });
    const receiver = createRoom({ name: "W50N6" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 2000);
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_ENERGY, 3000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

});

describe("terminal energy 25k floor protection", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("terminal energy exactly 25000 creates no energy offload task", () => {
    const room = createRoom({
      name: "W25KF1",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 25_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("terminal energy above 25000 is eligible only for surplus above the protection line", () => {
    const room = createRoom({
      name: "W25KF2",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 35_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    expect(offload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("config override terminalEnergyReserve 30000 protects 30k not 25k", () => {
    Memory.cfg!.resourceControl!.rooms = {
      W25KF3: { terminalEnergyReserve: 30_000 },
    };
    const room = createRoom({
      name: "W25KF3",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 35_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("pending send fee reserve greater than 25k raises the protection line", () => {
    const donor = createRoom({
      name: "W25KF4",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 40_000 },
    });
    const receiver = createRoom({ name: "W25KF4R" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 10_000);
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_HYDROGEN, 50_000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    const offload = tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`];
    expect(offload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("overflow offload processes non-energy before energy", () => {
    const room = createRoom({
      name: "W25KF5",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_HYDROGEN]: 100_000,
      },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offloadKeys = Object.keys(tasks).filter(k => k.includes("terminal_offload"));
    const hKey = `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`;
    const eKey = `resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`;
    expect(tasks[hKey]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN }],
    });
    expect(tasks[eKey]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY }],
    });
  });

  it("mixed overflow offloads non-energy before energy and energy never drops below protected line", () => {
    const room = createRoom({
      name: "W25KF6",
      storageResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 0 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const hOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`];
    expect(hOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    const eOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    expect(eOffload).toBeUndefined();
  });

  it("overflow offload continues evaluating energy after non-energy brings total to exactly cap", () => {
    // 150k H + 110k energy = 260k → offload 10k H → 250k → energy surplus 0 → no energy offload
    const room = createRoom({
      name: "W25KF7",
      storageResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 0 },
      terminalResources: {
        [RESOURCE_ENERGY]: 110_000,
        [RESOURCE_HYDROGEN]: 150_000,
      },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const hOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`];
    expect(hOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    const eOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    expect(eOffload).toBeUndefined();
  });

  it("overflow offload processes both minerals and energy when total far exceeds cap", () => {
    // Terminal: 200k H + 100k energy = 300k total, overflow = 50k
    // H offloaded 10k → total 290k, surplus 40k
    // Energy: offloadable = 100k - 25k = 75k, amount = min(75k, 40k, 10k) = 10k
    const room = createRoom({
      name: "W25KF8",
      storageResources: { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 0 },
      terminalResources: {
        [RESOURCE_ENERGY]: 100_000,
        [RESOURCE_HYDROGEN]: 200_000,
      },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    // Both H and energy should get offloaded (batch size each)
    const hOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`];
    expect(hOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    const eOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    expect(eOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

});

describe("executeTransferTasks below-min blocked tasks", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
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

  it("keeps task pending with blocking error when remainingAmount < transferMinAmount", () => {
    const donor = createRoom({
      name: "WBM1",
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_KEANIUM]: 500 },
    });
    const receiver = createRoom({ name: "WBM2" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 500, "test:below-min");

    runResourceControl();

    const actions = Memory.runtime?.resourceControl?.lastActions || [];
    const blockedAction = actions.find((a: string) => a.includes("task-blocked") && a.includes("remaining_below_transfer_min"));
    expect(blockedAction).toBeDefined();

    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store).find(
      (t) => t.fromRoomName === donor.name && t.resource === RESOURCE_KEANIUM,
    );
    expect(task).toBeDefined();
    expect(task!.status).toBe("pending");
    expect(task!.lastError).toBe("remaining_below_transfer_min");
    expect(task!.remainingAmount).toBe(500);
  });

  it("merges duplicate task into existing blocked pending task instead of creating new", () => {
    const donor = createRoom({
      name: "WBM3",
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_KEANIUM]: 500 },
    });
    const receiver = createRoom({ name: "WBM4" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 500, "test:merge");
    runResourceControl();

    const result2 = createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 300, "test:merge") as any;

    expect(result2.ok).toBe(true);
    const task = result2.task;
    expect(task.remainingAmount).toBe(800);
    expect(task.status).toBe("pending");
  });

  it("getIncomingResourceTransferAmount returns 0 for below-min blocked pending tasks", () => {
    const donor = createRoom({
      name: "WBM5",
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_KEANIUM]: 500 },
    });
    const receiver = createRoom({ name: "WBM6" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 500, "test:incoming");
    runResourceControl();

    expect(getIncomingResourceTransferAmount(receiver.name, RESOURCE_KEANIUM)).toBe(0);
  });
});

describe("terminal feed respects TERMINAL_TOTAL_STORAGE_CAP", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
          nativeMineralAutoSellThreshold: 10_000,
          minDealAmount: 1_000,
          maxDealAmount: 10_000,
        },
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

  it("caps native mineral feed when terminal total is near 250k", () => {
    // Native X room, storage has 223k X, terminal has 249,500 total (of other minerals, 0 X)
    // Auto-sell target = min(223k surplus, 10k maxDeal) = 10k
    // But feedCapacity = 250,000 - 249,500 = 500
    // Feed should be capped to 500 X, no offload
    const room = createRoom({
      name: "WFC1",
      nativeMineralType: RESOURCE_HYDROGEN,
      hasExtractor: true,
      storageResources: { [RESOURCE_HYDROGEN]: 223_000, [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_KEANIUM]: 249_500 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const feedKey = `resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`;
    const offloadKey = `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`;
    // Feed exists but is capped to at most 500
    expect(tasks[feedKey]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 500 }],
    });
    // No offload of H (terminal total 249,500 < 250,000)
    expect(tasks[offloadKey]).toBeUndefined();
  });

  it("produces no native mineral feed when terminal total is exactly 250k", () => {
    // Terminal total exactly 250,000: feedCapacity = 0, no native X feed, no X offload
    const room = createRoom({
      name: "WFC2",
      nativeMineralType: RESOURCE_HYDROGEN,
      hasExtractor: true,
      storageResources: { [RESOURCE_HYDROGEN]: 223_000, [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_KEANIUM]: 250_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const feedKey = `resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`;
    const offloadKey = `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`;
    expect(tasks[feedKey]).toBeUndefined();
    expect(tasks[offloadKey]).toBeUndefined();
  });

  it("native mineral feed works when terminal total well under 250k", () => {
    // Terminal total 240,000: feedCapacity = 10,000
    // Auto-sell target = 10k, which fits within feedCapacity
    const room = createRoom({
      name: "WFC3",
      nativeMineralType: RESOURCE_HYDROGEN,
      hasExtractor: true,
      storageResources: { [RESOURCE_HYDROGEN]: 223_000, [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_KEANIUM]: 240_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const feedKey = `resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`;
    expect(tasks[feedKey]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN }],
    });
    // Amount should be full 10k since feedCapacity = 10k
    expect(tasks[feedKey].steps[0].amount).toBe(10_000);
  });

  it("pending transfer feed still works when feedCapacity is available", () => {
    // Terminal total 240,000: feedCapacity = 10,000
    // Pending transfer for K needs 5k feed — should work
    const room = createRoom({
      name: "WFC4",
      storageResources: { [RESOURCE_KEANIUM]: 20_000, [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_HYDROGEN]: 240_000 },
    });
    const receiver = createRoom({ name: "WFC4B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(room.name, receiver.name, RESOURCE_KEANIUM, 5_000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const feedKey = `resourceControl:terminal_feed:${room.name}:${RESOURCE_KEANIUM}`;
    expect(tasks[feedKey]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 5_000 }],
    });
  });

  it("pending transfer feed is capped when feedCapacity is limited", () => {
    // Terminal total 248,000: feedCapacity = 2,000
    // Pending transfer for K needs 5k feed, but only 2k capacity available
    const room = createRoom({
      name: "WFC5",
      storageResources: { [RESOURCE_KEANIUM]: 20_000, [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_HYDROGEN]: 248_000 },
    });
    const receiver = createRoom({ name: "WFC5B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(room.name, receiver.name, RESOURCE_KEANIUM, 5_000, "test");

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const feedKey = `resourceControl:terminal_feed:${room.name}:${RESOURCE_KEANIUM}`;
    expect(tasks[feedKey]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 2_000 }],
    });
  });
});
