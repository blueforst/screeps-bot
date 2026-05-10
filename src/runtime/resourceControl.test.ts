import { clearCarrierTaskBoardForTest, getCarrierTasksByRoom, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { createResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
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
}): Room {
  const storageResources = options.storageResources ?? {};
  const terminalResources = options.terminalResources ?? {};
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
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(storageResources).reduce((sum, value) => sum + (value || 0), 0);
          }
          return storageResources[resource] || 0;
        },
        getFreeCapacity: () => 1_000_000,
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      send: jest.fn(() => OK),
      store: {
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
      terminalResources: { [RESOURCE_ENERGY]: 12000 },
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

  it("skips hub export when hub import task exists for same hub room", () => {
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
    expect(hubRoom.terminal.send).not.toHaveBeenCalled();
  });

});
