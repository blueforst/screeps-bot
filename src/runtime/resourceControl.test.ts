import { clearCarrierTaskBoardForTest, getCarrierTasksByRoom, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import {
  createAutomaticResourceTransferTask,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  markResourceTransferTaskBlocked,
} from "@/runtime/logistics/resourceTransferTasks";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import { reserveProductionResource } from "@/runtime/resourceReservation";
import {
  createResourceControlTransferContext,
  normalizeCapacityConfig,
  runResourceControl,
} from "@/runtime/resourceControl";
import { runMarketSalePreflight } from "@/runtime/marketSaleAutomation";
import {
  clearMarketActionArbiterForTest,
  getMarketActionJournal,
} from "@/runtime/marketActionArbiter";

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
  const room = {
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
  (room.terminal as StructureTerminal).room = room;
  return room;
}

describe("runResourceControl terminal feed tasks", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearMarketActionArbiterForTest();
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

  it("stages storage cargo with a zero fee even when terminal reserve cannot be replenished", () => {
    const donor = createRoom({
      name: "W4N1",
      storageResources: { [RESOURCE_KEANIUM]: 8000 },
      terminalResources: {},
    });
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
    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`
      ],
    ).toBeUndefined();
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
    donor.terminal!.cooldown = 1;
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
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
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

  it("does not auto-balance energy into rooms without terminal and storage receive buffers", () => {
    const donor = createRoom({
      name: "W8N5",
      storageResources: { [RESOURCE_ENERGY]: 300000 },
      terminalResources: { [RESOURCE_ENERGY]: 30000 },
    });
    const receiver = createRoom({
      name: "W8N6",
      storageResources: { [RESOURCE_ENERGY]: 50000 },
      terminalResources: { [RESOURCE_ENERGY]: 260000 },
      storageFreeCapacity: 150000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
  });

  it("caps auto-balance energy by receiver capacity above terminal and storage buffers", () => {
    const donor = createRoom({
      name: "W8N7",
      storageResources: { [RESOURCE_ENERGY]: 300000 },
      terminalResources: { [RESOURCE_ENERGY]: 30000 },
    });
    const receiver = createRoom({
      name: "W8N8",
      storageResources: { [RESOURCE_ENERGY]: 50000 },
      terminalResources: { [RESOURCE_ENERGY]: 259900 },
      storageFreeCapacity: 150000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(RESOURCE_ENERGY, 100, receiver.name, "resourceControl:auto-balance");
  });

  it("auto-balance 在托管 energy 卖单撤销确认前保留 exposure，确认后恢复", () => {
    const donor = createRoom({
      name: "W81N1",
      storageResources: { [RESOURCE_ENERGY]: 300_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
    });
    const receiver = createRoom({
      name: "W81N2",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          managedEnergy: {
            roomName: donor.name,
            resourceType: RESOURCE_ENERGY,
            remainingExposure: 30_000,
          },
        },
        pendingMutations: {
          managedEnergy: {
            kind: "cancel",
            orderId: "managedEnergy",
            requestedAt: Game.time,
          },
        },
      },
    } as unknown as Memory["data"];

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();

    delete Memory.data!.marketSaleAutomation!.managedOrders.managedEnergy;
    delete Memory.data!.marketSaleAutomation!.pendingMutations.managedEnergy;
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      expect.any(Number),
      receiver.name,
      "resourceControl:auto-balance",
    );
  });

  it("transfer task 在托管矿物卖单撤销确认前保留 exposure，确认后恢复", () => {
    const donor = createRoom({
      name: "W82N1",
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 5_000,
      },
    });
    const receiver = createRoom({ name: "W82N2" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      3_000,
      "test:market-exposure",
    );
    Memory.data = {
      ...(Memory.data || {}),
      marketSaleAutomation: {
        managedOrders: {
          managedK: {
            roomName: donor.name,
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 5_000,
          },
        },
        pendingMutations: {
          managedK: {
            kind: "cancel",
            orderId: "managedK",
            requestedAt: Game.time,
          },
        },
      },
    } as unknown as Memory["data"];

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();

    delete Memory.data!.marketSaleAutomation!.managedOrders.managedK;
    delete Memory.data!.marketSaleAutomation!.pendingMutations.managedK;
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_KEANIUM,
      3_000,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
  });

  it("does not execute pending transfer tasks into rooms without receive buffers", () => {
    const donor = createRoom({
      name: "W8N9",
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_ENERGY]: 30000, [RESOURCE_KEANIUM]: 5000 },
    });
    const receiver = createRoom({
      name: "W8N10",
      terminalResources: { [RESOURCE_ENERGY]: 260000 },
      storageFreeCapacity: 150000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 3000, "test");

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
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

  it("keeps the legacy market disabled when no explicit market config exists", () => {
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
      },
    };
    const room = createRoom({
      name: "W9N2D",
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
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      {
        id: "unsafe-default-buy-order",
        type: ORDER_BUY,
        resourceType: RESOURCE_KEANIUM,
        price: 0.001,
        amount: 1500,
        roomName: "W8N8",
      } as Order,
    ]);

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Memory.runtime?.resourceControl?.lastMarketActions).toEqual([]);
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
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-resource-buy-gap",
            status: "reconcile_gap",
            canaryRoomName: room.name,
            resource: RESOURCE_HYDROGEN,
            dealAmount: 5_000,
            transactionEnergy: 24_800,
          },
        },
      },
    } as unknown as Memory["data"];

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
      storageResources: { [RESOURCE_ENERGY]: 201_000, [RESOURCE_KEANIUM]: 10_000 },
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

  it.each([
    ["receiver_capacity", "W15A1", "W15A2"],
    ["source_depleted", "W15A3", "W15A4"],
  ] as const)("clears a stale transfer feed while %s blocks admission", (blockedReason, donorName, receiverName) => {
    const donor = createRoom({
      name: donorName,
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: blockedReason === "source_depleted" ? 0 : 6_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: receiverName,
      storageFreeCapacity: blockedReason === "receiver_capacity" ? 0 : 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      `manual:${blockedReason}`,
    );
    if (typeof created === "string") throw new Error(created);
    markResourceTransferTaskBlocked(created.task, blockedReason);
    replaceCarrierTasksForProducerRoom("resourceControl:preload", donor.name, [
      {
        id: `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`,
        type: "terminal_feed",
        priority: 80,
        steps: [{
          id: `stale:${blockedReason}`,
          resource: RESOURCE_KEANIUM,
          fromKind: "storage",
          toKind: "terminal",
          fromId: donor.storage!.id,
          toId: donor.terminal!.id,
          amount: 1_000,
        }],
      },
    ]);

    runResourceControl();

    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
  });

  it("does not stage a transfer from mineral safety-floor stock", () => {
    const donor = createRoom({
      name: "W15A5",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: 5_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W15A6", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:protected-mineral",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
  });

  it("does not stage a non-energy transfer when only protected energy could pay its fee", () => {
    const donor = createRoom({
      name: "W15A7",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 6_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W15A8", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 1);
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:unsafe-fee",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`],
    ).toBeUndefined();
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]?.steps[0].amount,
    ).toBe(20_000);
  });

  it("admits cargo when the true fee is safe even if terminal reserve cannot be fully replenished", () => {
    const donor = createRoom({
      name: "W15A8E",
      storageResources: {
        [RESOURCE_ENERGY]: 50_001,
        [RESOURCE_KEANIUM]: 6_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W15A8F", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: {
        energyFloor: 50_000,
        energyTarget: 50_000,
        energyExportStart: 60_000,
        terminalEnergyReserve: 100_000,
      },
    };
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 1);
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:truncated-energy-feed",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 1_000 }],
    });
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 50_001 }],
    });
  });

  it("stages a safe storage-only resource and its payable fee after terminal supply blocks execution", () => {
    const donor = createRoom({
      name: "W15A9",
      storageResources: {
        [RESOURCE_ENERGY]: 220_001,
        [RESOURCE_KEANIUM]: 6_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W15B0", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 1);
    const created = createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:safe-storage-staging",
    );
    if (typeof created === "string") throw new Error(created);
    markResourceTransferTaskBlocked(
      created.task,
      "insufficient_terminal_resource_or_fee",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 1_000 }],
    });
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 20_001 }],
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

  it("keeps recovering an exact-250000 pressured terminal toward the 80000-free watermark", () => {
    const roomName = "W25R1";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      terminalResources: { [RESOURCE_HYDROGEN]: 250_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("pressure");
    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
  });

  it("keeps the legacy exact-250000 offload threshold when terminal recovery is disabled", () => {
    const roomName = "W25R2";
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: false,
    };
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      terminalResources: { [RESOURCE_HYDROGEN]: 250_000 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toBeUndefined();
  });

  it("restores legacy multi-resource and energy feeds when terminal recovery is disabled", () => {
    const donor = createRoom({
      name: "W25L1",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 5_000,
        [RESOURCE_OXYGEN]: 7_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const hydrogenReceiver = createRoom({ name: "W25L1H" });
    const oxygenReceiver = createRoom({ name: "W25L1O" });
    const energyReceiver = createRoom({
      name: "W25L1E",
      storageResources: { [RESOURCE_ENERGY]: 100_000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[hydrogenReceiver.name] = hydrogenReceiver;
    Game.rooms[oxygenReceiver.name] = oxygenReceiver;
    Game.rooms[energyReceiver.name] = energyReceiver;
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: false,
    };
    createResourceTransferTask(
      donor.name,
      hydrogenReceiver.name,
      RESOURCE_HYDROGEN,
      5_000,
      "manual:legacy-hydrogen",
    );
    createResourceTransferTask(
      donor.name,
      oxygenReceiver.name,
      RESOURCE_OXYGEN,
      7_000,
      "manual:legacy-oxygen",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 30_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 5_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_OXYGEN}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_OXYGEN, amount: 7_000 }],
    });
  });

  it("restores legacy full pending-backlog protection when terminal recovery is disabled", () => {
    const donor = createRoom({
      name: "W25L2",
      terminalResources: {
        [RESOURCE_HYDROGEN]: 150_000,
        [RESOURCE_OXYGEN]: 100_000,
        [RESOURCE_KEANIUM]: 50_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const hydrogenReceiver = createRoom({ name: "W25L2H" });
    const oxygenReceiver = createRoom({ name: "W25L2O" });
    Game.rooms[donor.name] = donor;
    Game.rooms[hydrogenReceiver.name] = hydrogenReceiver;
    Game.rooms[oxygenReceiver.name] = oxygenReceiver;
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: false,
    };
    createResourceTransferTask(
      donor.name,
      hydrogenReceiver.name,
      RESOURCE_HYDROGEN,
      150_000,
      "manual:legacy-protected-hydrogen",
    );
    createResourceTransferTask(
      donor.name,
      oxygenReceiver.name,
      RESOURCE_OXYGEN,
      100_000,
      "manual:legacy-protected-oxygen",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_HYDROGEN}`]).toBeUndefined();
    expect(tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_OXYGEN}`]).toBeUndefined();
    expect(tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_KEANIUM}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 10_000 }],
    });
  });

  it("restores legacy raw storage-free offload capacity when terminal recovery is disabled", () => {
    const room = createRoom({
      name: "W25L3",
      terminalResources: { [RESOURCE_HYDROGEN]: 260_000 },
      storageFreeCapacity: 10_000,
    });
    Game.rooms[room.name] = room;
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: false,
    };

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
  });

  it("restores legacy planned-offload precredit when terminal recovery is disabled", () => {
    const donor = createRoom({
      name: "W25L4",
      storageResources: {
        [RESOURCE_ENERGY]: 150_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 35_000,
        [RESOURCE_HYDROGEN]: 215_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25L4K" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: false,
    };
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:legacy-offload-precredit",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 10_000 }],
    });
  });

  it("gives the single staging slot to a real unmet energy deficit before manual minerals", () => {
    const donor = createRoom({
      name: "W25E1",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 10_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const energyReceiver = createRoom({
      name: "W25E1E",
      storageResources: { [RESOURCE_ENERGY]: 100_000 },
    });
    const mineralReceiver = createRoom({ name: "W25E1H" });
    Game.rooms[donor.name] = donor;
    Game.rooms[energyReceiver.name] = energyReceiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      donor.name,
      mineralReceiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:mineral-must-wait-for-energy",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_HYDROGEN}`]).toBeUndefined();
  });

  it("does not stage ephemeral energy for a deficit covered by a healthy pending task", () => {
    const taskDonor = createRoom({
      name: "W25E0A",
      storageResources: { [RESOURCE_ENERGY]: 260_000 },
    });
    taskDonor.terminal!.cooldown = 1;
    const fallbackDonor = createRoom({
      name: "W25E0B",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 15_000,
      },
    });
    fallbackDonor.terminal!.cooldown = 1;
    const energyReceiver = createRoom({
      name: "W25E0E",
      storageResources: { [RESOURCE_ENERGY]: 190_000 },
    });
    const mineralReceiver = createRoom({
      name: "W25E0H",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[taskDonor.name] = taskDonor;
    Game.rooms[fallbackDonor.name] = fallbackDonor;
    Game.rooms[energyReceiver.name] = energyReceiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [taskDonor.name]: { terminalEnergyReserve: 0 },
      [fallbackDonor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      taskDonor.name,
      energyReceiver.name,
      RESOURCE_ENERGY,
      10_000,
      "manual:healthy-energy-coverage",
    );
    createResourceTransferTask(
      fallbackDonor.name,
      mineralReceiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:mineral-after-healthy-energy-coverage",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(taskDonor.name)[
        `resourceControl:terminal_feed:${taskDonor.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
    const fallbackTasks = getCarrierTasksByRoom(fallbackDonor.name);
    expect(
      fallbackTasks[
        `resourceControl:terminal_feed:${fallbackDonor.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(
      fallbackTasks[
        `resourceControl:terminal_feed:${fallbackDonor.name}:${RESOURCE_ENERGY}`
      ],
    ).toBeUndefined();
  });

  it("shares receiver energy need and headroom across donor staging decisions", () => {
    const firstDonor = createRoom({
      name: "W25E1A",
      storageResources: { [RESOURCE_ENERGY]: 260_000 },
    });
    firstDonor.terminal!.cooldown = 1;
    const secondDonor = createRoom({
      name: "W25E1B",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 15_000,
      },
    });
    secondDonor.terminal!.cooldown = 1;
    const energyReceiver = createRoom({
      name: "W25E1E",
      storageResources: { [RESOURCE_ENERGY]: 190_000 },
      storageFreeCapacity: 110_000,
    });
    const mineralReceiver = createRoom({
      name: "W25E1H",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[firstDonor.name] = firstDonor;
    Game.rooms[secondDonor.name] = secondDonor;
    Game.rooms[energyReceiver.name] = energyReceiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [firstDonor.name]: { terminalEnergyReserve: 0 },
      [secondDonor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      secondDonor.name,
      mineralReceiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:mineral-after-shared-energy-staging",
    );

    runResourceControl();

    const firstTasks = getCarrierTasksByRoom(firstDonor.name);
    const secondTasks = getCarrierTasksByRoom(secondDonor.name);
    const energyStagingAmount =
      (firstTasks[`resourceControl:terminal_feed:${firstDonor.name}:${RESOURCE_ENERGY}`]
        ?.steps.reduce((sum, step) => sum + step.amount, 0) || 0) +
      (secondTasks[`resourceControl:terminal_feed:${secondDonor.name}:${RESOURCE_ENERGY}`]
        ?.steps.reduce((sum, step) => sum + step.amount, 0) || 0);
    expect(energyStagingAmount).toBe(10_000);
    expect(
      secondTasks[`resourceControl:terminal_feed:${secondDonor.name}:${RESOURCE_HYDROGEN}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
  });

  it("releases receiver staging when the first donor has no safe terminal feed capacity", () => {
    const fullTerminalDonor = createRoom({
      name: "W25E1F",
      storageResources: { [RESOURCE_ENERGY]: 260_000 },
      terminalResources: { [RESOURCE_HYDROGEN]: 250_000 },
    });
    fullTerminalDonor.terminal!.cooldown = 1;
    const openTerminalDonor = createRoom({
      name: "W25E1G",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    openTerminalDonor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25E1J",
      storageResources: { [RESOURCE_ENERGY]: 190_000 },
      storageFreeCapacity: 110_000,
    });
    const mineralReceiver = createRoom({
      name: "W25E1K",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[fullTerminalDonor.name] = fullTerminalDonor;
    Game.rooms[openTerminalDonor.name] = openTerminalDonor;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [fullTerminalDonor.name]: { terminalEnergyReserve: 0 },
      [openTerminalDonor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      openTerminalDonor.name,
      mineralReceiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:mineral-after-zero-feed-capacity",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(fullTerminalDonor.name)[
        `resourceControl:terminal_feed:${fullTerminalDonor.name}:${RESOURCE_ENERGY}`
      ],
    ).toBeUndefined();
    expect(
      getCarrierTasksByRoom(openTerminalDonor.name)[
        `resourceControl:terminal_feed:${openTerminalDonor.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
    expect(
      getCarrierTasksByRoom(openTerminalDonor.name)[
        `resourceControl:terminal_feed:${openTerminalDonor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
  });

  it("shares a receiver deficit using each donor's safe terminal feed capacity", () => {
    const constrainedDonor = createRoom({
      name: "W25E1P",
      storageResources: { [RESOURCE_ENERGY]: 260_000 },
      terminalResources: { [RESOURCE_HYDROGEN]: 248_000 },
    });
    constrainedDonor.terminal!.cooldown = 1;
    const openTerminalDonor = createRoom({
      name: "W25E1Q",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    openTerminalDonor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25E1V",
      storageResources: { [RESOURCE_ENERGY]: 190_000 },
      storageFreeCapacity: 110_000,
    });
    const mineralReceiver = createRoom({
      name: "W25E1W",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[constrainedDonor.name] = constrainedDonor;
    Game.rooms[openTerminalDonor.name] = openTerminalDonor;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [constrainedDonor.name]: { terminalEnergyReserve: 0 },
      [openTerminalDonor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      openTerminalDonor.name,
      mineralReceiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:mineral-after-partial-feed-capacity",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(constrainedDonor.name)[
        `resourceControl:terminal_feed:${constrainedDonor.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 2_000 }],
    });
    expect(
      getCarrierTasksByRoom(openTerminalDonor.name)[
        `resourceControl:terminal_feed:${openTerminalDonor.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 8_000 }],
    });
    expect(
      getCarrierTasksByRoom(openTerminalDonor.name)[
        `resourceControl:terminal_feed:${openTerminalDonor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
  });

  it("releases provisional energy staging when the source needs no energy feed", () => {
    const readyDonor = createRoom({
      name: "W25E1R",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 15_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 10_000 },
    });
    readyDonor.terminal!.cooldown = 1;
    const stagingDonor = createRoom({
      name: "W25E1S",
      storageResources: { [RESOURCE_ENERGY]: 260_000 },
    });
    stagingDonor.terminal!.cooldown = 1;
    const energyReceiver = createRoom({
      name: "W25E1T",
      storageResources: { [RESOURCE_ENERGY]: 190_000 },
      storageFreeCapacity: 110_000,
    });
    const mineralReceiver = createRoom({
      name: "W25E1U",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[readyDonor.name] = readyDonor;
    Game.rooms[stagingDonor.name] = stagingDonor;
    Game.rooms[energyReceiver.name] = energyReceiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [readyDonor.name]: { terminalEnergyReserve: 0 },
      [stagingDonor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      readyDonor.name,
      mineralReceiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:mineral-after-released-energy-staging",
    );

    runResourceControl();

    const readyTasks = getCarrierTasksByRoom(readyDonor.name);
    const stagingTasks = getCarrierTasksByRoom(stagingDonor.name);
    expect(
      readyTasks[`resourceControl:terminal_feed:${readyDonor.name}:${RESOURCE_HYDROGEN}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(
      readyTasks[`resourceControl:terminal_feed:${readyDonor.name}:${RESOURCE_ENERGY}`],
    ).toBeUndefined();
    expect(
      stagingTasks[`resourceControl:terminal_feed:${stagingDonor.name}:${RESOURCE_ENERGY}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("lets manual mineral staging advance when there is no unmet energy deficit", () => {
    const donor = createRoom({
      name: "W25E2",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 15_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25E2H",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:mineral-without-energy-deficit",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("does not reclaim the staging slot after a direct energy send satisfies the deficit", () => {
    const directDonor = createRoom({
      name: "W25E3A",
      storageResources: { [RESOURCE_ENERGY]: 260_000 },
      terminalResources: { [RESOURCE_ENERGY]: 10_000 },
    });
    const stagingDonor = createRoom({
      name: "W25E3B",
      storageResources: {
        [RESOURCE_ENERGY]: 260_000,
        [RESOURCE_HYDROGEN]: 15_000,
      },
    });
    stagingDonor.terminal!.cooldown = 1;
    const energyReceiver = createRoom({
      name: "W25E3E",
      storageResources: { [RESOURCE_ENERGY]: 190_000 },
    });
    const mineralReceiver = createRoom({
      name: "W25E3H",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[directDonor.name] = directDonor;
    Game.rooms[stagingDonor.name] = stagingDonor;
    Game.rooms[energyReceiver.name] = energyReceiver;
    Game.rooms[mineralReceiver.name] = mineralReceiver;
    Memory.cfg!.resourceControl!.rooms = {
      [directDonor.name]: { terminalEnergyReserve: 0 },
      [stagingDonor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      stagingDonor.name,
      mineralReceiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:mineral-after-direct-energy",
    );

    runResourceControl();

    expect(directDonor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      energyReceiver.name,
      "resourceControl:auto-balance",
    );
    const tasks = getCarrierTasksByRoom(stagingDonor.name);
    expect(tasks[`resourceControl:terminal_feed:${stagingDonor.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${stagingDonor.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("does not recover into storage space reserved by the storage relief watermark", () => {
    const roomName = "W25R3";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      terminalResources: { [RESOURCE_HYDROGEN]: 260_000 },
      storageFreeCapacity: 200_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toBeUndefined();
    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("pressure");
  });

  it("does not recover by offloading terminal inventory fully committed to production", () => {
    const roomName = "W25R4";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      terminalResources: { [RESOURCE_HYDROGEN]: 260_000 },
    });
    Game.rooms[room.name] = room;
    reserveProductionResource(
      room.name,
      RESOURCE_HYDROGEN,
      260_000,
      "factory:protected-terminal-recovery",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toBeUndefined();
    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("pressure");
  });

  it("uses one recovery batch and selects non-energy before energy", () => {
    const roomName = "W25R5";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 35_000,
        [RESOURCE_HYDROGEN]: 215_000,
      },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
    expect(
      Object.values(tasks)
        .filter((task) => task.type === "terminal_offload")
        .flatMap((task) => task.steps)
        .reduce((sum, step) => sum + step.amount, 0),
    ).toBe(10_000);
  });

  it("protects at most one safe send batch instead of a complete pending backlog", () => {
    const roomName = "W25R6";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      terminalResources: { [RESOURCE_HYDROGEN]: 250_000 },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R6B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      room.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      250_000,
      "manual:large-backlog",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`]).toBeUndefined();
  });

  it("caps current capacity-relief staging protection to one transfer batch", () => {
    const roomName = "W25R6C";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_HYDROGEN]: 20_000,
        [RESOURCE_KEANIUM]: 230_000,
      },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R6D" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createAutomaticResourceTransferTask(
      room.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      30_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_KEANIUM}`]).toBeUndefined();
  });

  it("does not protect a receiver-capacity-blocked batch from non-energy-first recovery", () => {
    const roomName = "W25R7";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 240_000,
        [RESOURCE_HYDROGEN]: 10_000,
      },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25R7B",
      terminalResources: { [RESOURCE_KEANIUM]: 260_000 },
    });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    const pending = createResourceTransferTask(
      room.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      "manual:blocked-backlog",
    );
    if (typeof pending === "string") throw new Error(pending);

    runResourceControl();

    expect(pending.task.blockedReason).toBe("receiver_capacity");
    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
  });

  it("does not precredit a recovery offload into energy, transfer, or native-mineral feed capacity", () => {
    const roomName = "W25R8";
    (Memory.cfg!.resourceControl as any).market = { enabled: true };
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_HYDROGEN]: 20_000,
        [RESOURCE_OXYGEN]: 10_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 5_000,
        [RESOURCE_KEANIUM]: 245_000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R8B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      room.name,
      receiver.name,
      RESOURCE_OXYGEN,
      10_000,
      "manual:needs-staging",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_KEANIUM}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 10_000 }],
    });
    for (const resource of [RESOURCE_ENERGY, RESOURCE_OXYGEN, RESOURCE_HYDROGEN]) {
      expect(tasks[`resourceControl:terminal_feed:${room.name}:${resource}`]).toBeUndefined();
    }
  });

  it("shares actual terminal feed headroom between non-energy cargo and fee energy", () => {
    const donor = createRoom({
      name: "W25R8C",
      storageResources: {
        [RESOURCE_ENERGY]: 230_000,
        [RESOURCE_KEANIUM]: 15_000,
      },
      terminalResources: { [RESOURCE_HYDROGEN]: 249_500 },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R8D", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: { terminalEnergyReserve: 0 },
    };
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
      (amount: number) => Math.ceil(amount / 10),
    );
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:shared-feed-headroom",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_ENERGY}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_ENERGY, amount: 46 }],
    });
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 454 }],
    });
    expect(
      Object.values(tasks)
        .filter((task) => task.type === "terminal_feed")
        .flatMap((task) => task.steps)
        .reduce((sum, step) => sum + step.amount, 0),
    ).toBe(500);
  });

  it("uses headroom for the missing cargo delta when a batch is partly staged", () => {
    const donor = createRoom({
      name: "W25R8G",
      storageResources: {
        [RESOURCE_ENERGY]: 230_000,
        [RESOURCE_KEANIUM]: 5_500,
      },
      terminalResources: {
        [RESOURCE_HYDROGEN]: 249_000,
        [RESOURCE_KEANIUM]: 500,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R8H", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:partial-staging-headroom",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 500 }],
    });
  });

  it("keeps the admitted K batch out of reverse offload while recovering energy", () => {
    const donor = createRoom({
      name: "W25R8E",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: 5_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 290_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R8F", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:protect-admitted-k",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_KEANIUM}`],
    ).toBeUndefined();
    expect(
      tasks[`resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("uses the existing transfer priority order for the single staging batch", () => {
    const donor = createRoom({
      name: "W25R9",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_HYDROGEN]: 20_000,
        [RESOURCE_OXYGEN]: 20_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 25_000 },
    });
    const oldLowPriorityReceiver = createRoom({ name: "W25R9B" });
    const newManualReceiver = createRoom({ name: "W25R9C" });
    Game.rooms[donor.name] = donor;
    Game.rooms[oldLowPriorityReceiver.name] = oldLowPriorityReceiver;
    Game.rooms[newManualReceiver.name] = newManualReceiver;

    Game.time = 1;
    createAutomaticResourceTransferTask(
      donor.name,
      oldLowPriorityReceiver.name,
      RESOURCE_HYDROGEN,
      20_000,
      `hub:export:${RESOURCE_HYDROGEN}`,
    );
    Game.time = 2;
    createResourceTransferTask(
      donor.name,
      newManualReceiver.name,
      RESOURCE_OXYGEN,
      10_000,
      "manual:priority-staging",
    );
    Game.time = 10;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_OXYGEN}`]).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_OXYGEN, amount: 10_000 }],
    });
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_HYDROGEN}`],
    ).toBeUndefined();
  });

  it("keeps the highest-priority pending task in the next-send window during cooldown", () => {
    const donor = createRoom({
      name: "W25R9D",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_HYDROGEN]: 6_000,
        [RESOURCE_OXYGEN]: 6_000,
      },
    });
    donor.terminal!.cooldown = 5;
    const firstReceiver = createRoom({ name: "W25R9E", storageFreeCapacity: 500_000 });
    const secondReceiver = createRoom({ name: "W25R9F", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[firstReceiver.name] = firstReceiver;
    Game.rooms[secondReceiver.name] = secondReceiver;
    Game.time = 1;
    createResourceTransferTask(
      donor.name,
      firstReceiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      "manual:window-first",
    );
    Game.time = 2;
    createResourceTransferTask(
      donor.name,
      secondReceiver.name,
      RESOURCE_OXYGEN,
      1_000,
      "manual:window-second",
    );
    Game.time = 10;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_HYDROGEN}`],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 1_000 }],
    });
    expect(
      tasks[`resourceControl:terminal_feed:${donor.name}:${RESOURCE_OXYGEN}`],
    ).toBeUndefined();
  });

  it("moves the next pending task into the staging window after the current task sends", () => {
    const donor = createRoom({
      name: "W25R9G",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: 6_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 20_000,
        [RESOURCE_HYDROGEN]: 6_000,
      },
    });
    const firstReceiver = createRoom({ name: "W25R9H", storageFreeCapacity: 500_000 });
    const secondReceiver = createRoom({ name: "W25R9I", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[firstReceiver.name] = firstReceiver;
    Game.rooms[secondReceiver.name] = secondReceiver;
    Game.time = 1;
    const first = createResourceTransferTask(
      donor.name,
      firstReceiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      "manual:current-send",
    );
    Game.time = 2;
    createResourceTransferTask(
      donor.name,
      secondReceiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:next-send",
    );
    Game.time = 10;

    runResourceControl();

    if (typeof first === "string") throw new Error(first);
    expect(first.task).toMatchObject({ status: "done", remainingAmount: 0 });
    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_HYDROGEN,
      1_000,
      firstReceiver.name,
      expect.any(String),
    );
    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 1_000 }],
    });
  });

  it("stages an exact 25-unit transfer tail without rounding to a batch", () => {
    const donor = createRoom({
      name: "W25R9J",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: 5_025,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R9K", storageFreeCapacity: 500_000 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      25,
      "manual:tail-25",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 25 }],
    });
  });

  it("caps persistent staging at a 3000-unit self-excluded receiver allowance", () => {
    const donor = createRoom({
      name: "W25R9L",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: 15_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25R9M",
      storageFreeCapacity: 103_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:receiver-allowance-3000",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 3_000 }],
    });
  });

  it("caps capacity-relief staging protection by the current receiver ledger allowance", () => {
    const sourceRoomName = "W25R10";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [sourceRoomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const source = createRoom({
      name: sourceRoomName,
      terminalResources: {
        [RESOURCE_HYDROGEN]: 15_000,
        [RESOURCE_KEANIUM]: 235_000,
      },
    });
    source.terminal!.cooldown = 1;
    const otherSource = createRoom({
      name: "W25R10B",
      terminalResources: { [RESOURCE_OXYGEN]: 45_000 },
    });
    otherSource.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25R10C",
      terminalResources: { [RESOURCE_UTRIUM]: 207_999 },
    });
    Game.rooms[source.name] = source;
    Game.rooms[otherSource.name] = otherSource;
    Game.rooms[receiver.name] = receiver;
    createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      10_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );
    createResourceTransferTask(
      otherSource.name,
      receiver.name,
      RESOURCE_OXYGEN,
      45_000,
      "manual:receiver-commitment",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(source.name);
    expect(tasks[`resourceControl:terminal_offload:${source.name}:${RESOURCE_HYDROGEN}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 8_000 }],
    });
    expect(tasks[`resourceControl:terminal_offload:${source.name}:${RESOURCE_KEANIUM}`]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 2_000 }],
    });
  });

  it("protects one pending send batch while recovering the remaining staged inventory", () => {
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
    expect(hOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
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
      storageFreeCapacity: 210_000,
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

  it("suppresses energy feed while a pressured terminal is recovering non-energy", () => {
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
    expect(tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`]).toBeUndefined();
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

  it("prioritizes hub exports when hub storage is near full even with matching reclaim pending", () => {
    const hubRoom = createRoom({
      name: "W10N4",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      storageFreeCapacity: 10_000,
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
    });
    const reclaimDonor = createRoom({
      name: "W10N5",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 25000, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
    });
    const exportTarget = createRoom({
      name: "W10N6",
      storageResources: { [RESOURCE_ENERGY]: 200000 },
      terminalResources: { [RESOURCE_ENERGY]: 20000 },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[reclaimDonor.name] = reclaimDonor;
    Game.rooms[exportTarget.name] = exportTarget;

    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;

    createResourceTransferTask(reclaimDonor.name, hubRoom.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000, "hub:reclaim:XGHO2");
    createResourceTransferTask(hubRoom.name, exportTarget.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000, "hub:export:XGHO2");

    runResourceControl();

    expect(hubRoom.terminal.send).toHaveBeenCalledWith(
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      3000,
      exportTarget.name,
      expect.any(String),
    );
    expect(reclaimDonor.terminal.send).not.toHaveBeenCalled();
  });

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
    const mineralReceiver = createRoom({
      name: "W11N4",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
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
    expect(energyDonor.terminal.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      5_000,
      receiver.name,
      expect.any(String),
    );
    expect(mineralDonor.terminal.send).not.toHaveBeenCalled();
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
      storageResources: { [RESOURCE_ENERGY]: 200000 },
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
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "resourceControl:legacy-mineral-buy",
        outcome: "intent",
        roomName: room.name,
      }),
    ]));
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
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "resourceControl:legacy-energy-buy",
        outcome: "intent",
        roomName: room.name,
      }),
    ]));
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("market-buy") && a.includes("energy"))).toBe(true);
  });

  it("没有可执行应急能量买单时不声明市场 intent", () => {
    Memory.cfg!.resourceControl!.market = {
      enabled: false,
      emergencyBuyEnabled: true,
      maxBuyPrice: { [RESOURCE_ENERGY]: 1 },
    };
    const room = createRoom({
      name: "W1N7",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: { [RESOURCE_ENERGY]: 25_000 },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });

  it("应急能量买单的交易能量超过 terminal 余额时不声明 intent", () => {
    Memory.cfg!.resourceControl!.market = {
      enabled: false,
      emergencyBuyEnabled: true,
      maxBuyPrice: { [RESOURCE_ENERGY]: 1 },
    };
    const room = createRoom({
      name: "W1N9",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: { [RESOURCE_ENERGY]: 500 },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
      () => 1_000,
    );
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(
      (filter: OrderFilter) =>
        filter.type === ORDER_SELL &&
        filter.resourceType === RESOURCE_ENERGY
          ? [{
              id: "sell-energy-too-far",
              type: ORDER_SELL,
              resourceType: RESOURCE_ENERGY,
              price: 0.1,
              amount: 5_000,
              roomName: "W2N9",
            } as Order]
          : [],
    );

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });

  it("没有可执行矿物买单时不声明市场 intent", () => {
    setHubSynthesisDemand("W1N8", RESOURCE_HYDROGEN, 5_000);
    const room = createRoom({
      name: "W1N8",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 25_000 },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });

  it("矿物买单的交易能量超过 terminal 余额时不声明 intent", () => {
    setHubSynthesisDemand("W2N1", RESOURCE_HYDROGEN, 5_000);
    const room = createRoom({
      name: "W2N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 500 },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
      () => 1_000,
    );
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(
      (filter: OrderFilter) =>
        filter.type === ORDER_SELL &&
        filter.resourceType === RESOURCE_HYDROGEN
          ? [{
              id: "sell-hydrogen-too-far",
              type: ORDER_SELL,
              resourceType: RESOURCE_HYDROGEN,
              price: 0.5,
              amount: 5_000,
              roomName: "W3N1",
            } as Order]
          : [],
    );

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });

  it("keeps emergency energy buy reachable after the market-sale preflight disables legacy selling", () => {
    Memory.cfg!.resourceControl!.market!.emergencyBuyEnabled = true;
    Memory.cfg!.resourceControl!.market!.maxBuyPrice![RESOURCE_ENERGY] = 1;
    const room = createRoom({
      name: "W1N6",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: { [RESOURCE_ENERGY]: 25_000 },
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(
      (filter: OrderFilter) => {
        if (
          filter.type === ORDER_SELL &&
          filter.resourceType === RESOURCE_ENERGY
        ) {
          return [
            {
              id: "sell-energy-after-latch",
              type: ORDER_SELL,
              resourceType: RESOURCE_ENERGY,
              price: 0.1,
              amount: 10_000,
              roomName: "W0N0",
            } as Order,
          ];
        }
        return [];
      },
    );

    runMarketSalePreflight();
    expect(Memory.cfg?.resourceControl?.market?.enabled).toBe(false);
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    Memory.data!.marketSaleAutomation!.pendingDirectDeals = {
      direct: {
        requestId: "direct-emergency-buy-gap",
        status: "reconcile_gap",
        canaryRoomName: room.name,
        resource: RESOURCE_KEANIUM,
        dealAmount: 1_000,
        transactionEnergy: 24_800,
      },
    };
    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith(
      "sell-energy-after-latch",
      expect.any(Number),
      room.name,
    );
    expect(
      Memory.runtime?.resourceControl?.lastMarketActions.some((action) =>
        action.includes(`market-buy:${room.name}:energy=`),
      ),
    ).toBe(true);
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
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: { [RESOURCE_ENERGY]: 5000 },
    });
    const receiver = createRoom({ name: "W50N4" });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    donor.terminal!.cooldown = 1;
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
    const hKey = `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`;
    const eKey = `resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`;
    expect(tasks[hKey]).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN }],
    });
    expect(tasks[eKey]).toBeUndefined();
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

  it("bounds far-over-cap recovery to one non-energy-first batch", () => {
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
    const hOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`];
    expect(hOffload).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    const eOffload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`];
    expect(eOffload).toBeUndefined();
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

  it("sends transfer task even when remainingAmount is below the former transfer minimum", () => {
    const donor = createRoom({
      name: "WBM1",
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_KEANIUM]: 500 },
    });
    const receiver = createRoom({ name: "WBM2", storageResources: { [RESOURCE_ENERGY]: 200000 } });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 500, "test:below-min");

    runResourceControl();

    const actions = Memory.runtime?.resourceControl?.lastActions || [];
    const sendAction = actions.find((a: string) => a.includes("task-send") && a.includes("K=500"));
    expect(sendAction).toBeDefined();
    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_KEANIUM,
      500,
      receiver.name,
      expect.any(String),
    );

    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store).find(
      (t) => t.fromRoomName === donor.name && t.resource === RESOURCE_KEANIUM,
    );
    expect(task).toBeDefined();
    expect(task!.status).toBe("done");
    expect(task!.lastError).toBeUndefined();
    expect(task!.remainingAmount).toBe(0);
  });

  it("keeps synthesis transfers blocked when receiver storage buffer is low", () => {
    const donor = createRoom({
      name: "WBM7",
      terminalResources: { [RESOURCE_ENERGY]: 25_000, [RESOURCE_LEMERGIUM_ACID]: 500 },
    });
    const receiver = createRoom({
      name: "WBM8",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      storageFreeCapacity: 10_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_LEMERGIUM_ACID, 500, "synthesis:WBM8:XLH2O");

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) => entry.fromRoomName === donor.name && entry.toRoomName === receiver.name,
    );
    expect(task?.status).toBe("pending");
  });

  it("keeps generic mineral transfers blocked when receiver storage buffer is low", () => {
    const donor = createRoom({
      name: "WBM9",
      terminalResources: { [RESOURCE_ENERGY]: 25_000, [RESOURCE_LEMERGIUM_ACID]: 500 },
    });
    const receiver = createRoom({
      name: "WBM10",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      storageFreeCapacity: 10_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_LEMERGIUM_ACID, 500, "test:generic");

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) => entry.fromRoomName === donor.name && entry.toRoomName === receiver.name,
    );
    expect(task?.status).toBe("pending");
  });

  it("does not merge duplicate task into a completed below-min transfer", () => {
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
    expect(task.remainingAmount).toBe(300);
    expect(task.status).toBe("pending");
  });

  it("getIncomingResourceTransferAmount includes healthy below-min pending tasks", () => {
    const donor = createRoom({
      name: "WBM5",
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
      terminalResources: { [RESOURCE_KEANIUM]: 500 },
    });
    const receiver = createRoom({ name: "WBM6", storageResources: { [RESOURCE_ENERGY]: 200000 } });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;

    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 500, "test:incoming");

    expect(getIncomingResourceTransferAmount(receiver.name, RESOURCE_KEANIUM)).toBe(500);
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
      terminalResources: {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_KEANIUM]: 224_500,
      },
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
      terminalResources: {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_KEANIUM]: 225_000,
      },
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
      terminalResources: {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_KEANIUM]: 215_000,
      },
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
      terminalResources: {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_HYDROGEN]: 215_000,
      },
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
      terminalResources: {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_HYDROGEN]: 223_000,
      },
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

const ALL_10_T3: ResourceConstant[] = [
  RESOURCE_CATALYZED_UTRIUM_ACID,       // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,   // XUHO2
  RESOURCE_CATALYZED_KEANIUM_ACID,      // XKH2O
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,  // XKHO2
  RESOURCE_CATALYZED_LEMERGIUM_ACID,    // XLH2O
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,     // XZH2O
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, // XZHO2
  RESOURCE_CATALYZED_GHODIUM_ACID,      // XGH2O
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,  // XGHO2
];

describe("hub market protection for all 10 T3 compounds", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
        },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 200),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  it("hub room does not sell any of the 10 T3 target compounds on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N1",
      targetCompounds: [...ALL_10_T3],
    };
    Memory.cfg!.resourceControl!.market!.sellResources = [...ALL_10_T3];

    const storageResources: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_ENERGY]: 300_000,
    };
    const terminalResources: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_ENERGY]: 25_000,
    };
    for (const t3 of ALL_10_T3) {
      storageResources[t3] = 10_000;
      terminalResources[t3] = 5_000;
    }

    const room = createRoom({
      name: "W40N1",
      storageResources,
      terminalResources,
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && ALL_10_T3.includes(filter.resourceType as ResourceConstant)) {
        return [
          {
            id: `buy-${filter.resourceType}`,
            type: ORDER_BUY,
            resourceType: filter.resourceType,
            price: 5.0,
            amount: 5_000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("market-sell"))).toBe(false);
  });

  it("non-hub room does not sell the 2 selected T3 target compounds", () => {
    const customTargets: ResourceConstant[] = [
      RESOURCE_CATALYZED_KEANIUM_ACID,
      RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
    ];
    Memory.cfg!.hub = {
      hubRoomName: "W40HUB",
      targetCompounds: customTargets,
    };
    Memory.cfg!.resourceControl!.market!.sellResources = [...customTargets];

    const storageResources: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_ENERGY]: 300_000,
    };
    const terminalResources: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_ENERGY]: 25_000,
    };
    for (const t3 of customTargets) {
      storageResources[t3] = 10_000;
      terminalResources[t3] = 5_000;
    }

    const room = createRoom({
      name: "W40N2",
      storageResources,
      terminalResources,
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && customTargets.includes(filter.resourceType as ResourceConstant)) {
        return [
          {
            id: `buy-${filter.resourceType}`,
            type: ORDER_BUY,
            resourceType: filter.resourceType,
            price: 5.0,
            amount: 5_000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("non-hub room CAN sell a T3 that is NOT in targetCompounds", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40HUB",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    // sellResources includes XGHO2 which is NOT in the target list
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_CATALYZED_GHODIUM_ALKALIDE];

    const room = createRoom({
      name: "W40N3",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 10_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25_000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5_000,
      },
      nativeMineralType: RESOURCE_KEANIUM,
    });
    Game.rooms[room.name] = room;

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_CATALYZED_GHODIUM_ALKALIDE) {
        return [
          {
            id: "buy-xgho2-allowed",
            type: ORDER_BUY,
            resourceType: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            price: 5.0,
            amount: 5_000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-xgho2-allowed", 5_000, room.name);
  });

  it("hub room does not sell newly-added intermediates (KH, ZH, KO, ZO, LH) on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N4",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.sellResources = [
      RESOURCE_KEANIUM_HYDRIDE,
      RESOURCE_ZYNTHIUM_HYDRIDE,
      RESOURCE_KEANIUM_OXIDE,
      RESOURCE_ZYNTHIUM_OXIDE,
      RESOURCE_LEMERGIUM_HYDRIDE,
    ];

    const intermediatesToTest: ResourceConstant[] = [
      RESOURCE_KEANIUM_HYDRIDE,
      RESOURCE_ZYNTHIUM_HYDRIDE,
      RESOURCE_KEANIUM_OXIDE,
      RESOURCE_ZYNTHIUM_OXIDE,
      RESOURCE_LEMERGIUM_HYDRIDE,
    ];

    const storageResources: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_ENERGY]: 300_000,
    };
    const terminalResources: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_ENERGY]: 25_000,
    };
    for (const res of intermediatesToTest) {
      storageResources[res] = 15_000;
      terminalResources[res] = 5_000;
    }

    const room = createRoom({
      name: "W40N4",
      storageResources,
      terminalResources,
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && intermediatesToTest.includes(filter.resourceType as ResourceConstant)) {
        return [
          {
            id: `buy-${filter.resourceType}`,
            type: ORDER_BUY,
            resourceType: filter.resourceType,
            price: 1.0,
            amount: 5_000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("hub surplus sell executes market deal when terminal has resource and energy", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N10",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
      marketSellEnabled: true,
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.runtime = {
      hub: {
        ...Memory.runtime?.hub,
        marketSellSurplus: {
          [RESOURCE_HYDROXIDE]: 3000,
        },
      },
    };
    const room = createRoom({
      name: "W40N10",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROXIDE]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROXIDE) {
        return [
          {
            id: "buy-oh-surplus",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROXIDE,
            price: 1.0,
            amount: 3000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-oh-surplus", 3000, room.name);
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("market-sell") && a.includes("OH"))).toBe(true);
  });

  it("hub surplus sell skips when no energy for fees", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N11",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.runtime = {
      hub: {
        ...Memory.runtime?.hub,
        marketSellSurplus: {
          [RESOURCE_HYDROXIDE]: 3000,
        },
      },
    };
    const room = createRoom({
      name: "W40N11",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROXIDE]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 0,
        [RESOURCE_HYDROXIDE]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROXIDE) {
        return [
          {
            id: "buy-oh-no-energy",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROXIDE,
            price: 1.0,
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

  it("hub surplus sell skips when no buy order found", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N12",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.runtime = {
      hub: {
        ...Memory.runtime?.hub,
        marketSellSurplus: {
          [RESOURCE_HYDROXIDE]: 3000,
        },
      },
    };
    const room = createRoom({
      name: "W40N12",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROXIDE]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => []);

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("hub surplus sell works in survival room state", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N13",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
      marketSellEnabled: true,
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.maxDealsPerRun = 5;
    Memory.runtime = {
      hub: {
        ...Memory.runtime?.hub,
        marketSellSurplus: {
          [RESOURCE_HYDROXIDE]: 3000,
        },
      },
    };
    const room = createRoom({
      name: "W40N13",
      storageResources: {
        [RESOURCE_ENERGY]: 50000,
        [RESOURCE_HYDROXIDE]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROXIDE) {
        return [
          {
            id: "buy-oh-survival",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROXIDE,
            price: 1.0,
            amount: 3000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalledWith("buy-oh-survival", 3000, room.name);
    const actions = Memory.runtime?.resourceControl?.lastMarketActions || [];
    expect(actions.some((a: string) => a.includes("hub-surplus-sell"))).toBe(true);
  });

  it("isHubProtectedResource returns false for resource in marketSellSurplus", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N14",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.runtime = {
      hub: {
        ...Memory.runtime?.hub,
        marketSellSurplus: {
          [RESOURCE_HYDROXIDE]: 3000,
        },
      },
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_HYDROXIDE];
    const room = createRoom({
      name: "W40N14",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROXIDE]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROXIDE) {
        return [
          {
            id: "buy-oh-unprotected",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROXIDE,
            price: 1.0,
            amount: 3000,
            roomName: "W9N9",
          } as Order,
        ];
      }
      return [];
    });

    runResourceControl();

    expect(Game.market.deal).toHaveBeenCalled();
  });

  it("isHubProtectedResource returns true for target compound NOT in marketSellSurplus", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N15",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_CATALYZED_UTRIUM_ACID];
    Memory.runtime = {};
    const room = createRoom({
      name: "W40N15",
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
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 200);
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_CATALYZED_UTRIUM_ACID) {
        return [
          {
            id: "buy-xuh2o-protected",
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

  it("satellite room does not sell OH committed to distributed synthesis on the market", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W50N1",
      targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [RESOURCE_HYDROXIDE];
    Memory.runtime = {
      hub: {
        distributedSynthesis: {
          dispatchAssignments: [
            {
              roomName: "W50N2",
              product: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
              targetAmount: 5000,
              isHubRoom: false,
            },
          ],
          routeDecisions: [
            {
              fromRoom: "W50N2",
              toRoom: "W50N3",
              resource: RESOURCE_HYDROXIDE,
              amount: 2000,
              fee: 0,
            },
          ],
        },
      },
    };

    const room = createRoom({
      name: "W50N2",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_HYDROXIDE]: 3000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;

    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn((filter: OrderFilter) => {
      if (filter.type === ORDER_BUY && filter.resourceType === RESOURCE_HYDROXIDE) {
        return [
          {
            id: "buy-oh",
            type: ORDER_BUY,
            resourceType: RESOURCE_HYDROXIDE,
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
});

describe("resource-control capacity state", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
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

  it("normalizes every capacity-balancing boundary deterministically", () => {
    expect(
      normalizeCapacityConfig({
        enabled: "invalid",
        storagePressureFreeCapacity: -1,
        storageReliefTargetFreeCapacity: -1,
        receiverStorageMinFreeCapacity: 2_000_000,
        terminalPressureFreeCapacity: Number.POSITIVE_INFINITY,
        terminalReliefTargetFreeCapacity: 1,
        receiverTerminalMinFreeCapacity: -1,
        maxPlannedAmountPerTask: Number.NaN,
        maxNewTasksPerRun: 99,
        automaticTaskNoProgressTtl: 0,
        sourceDepletedGraceTicks: 0,
        t3ReservePerRoom: -1,
      }),
    ).toEqual({
      enabled: true,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 0,
      storageReliefTargetFreeCapacity: 0,
      receiverStorageMinFreeCapacity: 1_000_000,
      terminalPressureFreeCapacity: 40_000,
      terminalReliefTargetFreeCapacity: 40_000,
      receiverTerminalMinFreeCapacity: 40_000,
      maxPlannedAmountPerTask: 50_000,
      maxNewTasksPerRun: 5,
      automaticTaskNoProgressTtl: 100,
      sourceDepletedGraceTicks: 1,
      t3ReservePerRoom: 0,
    });
  });

  it("keeps the compatibility config export aligned with shared watermark ordering", () => {
    expect(
      normalizeCapacityConfig({
        terminalHeadroomRecoveryEnabled: false,
        storagePressureFreeCapacity: 400_000,
        storageReliefTargetFreeCapacity: 200_000,
        receiverStorageMinFreeCapacity: 100_000,
        terminalPressureFreeCapacity: 60_000,
        receiverTerminalMinFreeCapacity: 90_000,
        terminalReliefTargetFreeCapacity: 70_000,
      }),
    ).toMatchObject({
      terminalHeadroomRecoveryEnabled: false,
      storagePressureFreeCapacity: 400_000,
      storageReliefTargetFreeCapacity: 400_000,
      receiverStorageMinFreeCapacity: 400_000,
      terminalPressureFreeCapacity: 60_000,
      receiverTerminalMinFreeCapacity: 90_000,
      terminalReliefTargetFreeCapacity: 90_000,
    });
  });

  it("persists a full storage as capacity emergency independently of survival energy", () => {
    const room = createRoom({
      name: "W60N1",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 0,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[room.name]).toMatchObject({
      state: "survival",
      capacityState: "emergency",
      storageFreeCapacity: 0,
      terminalFreeCapacity: 280_000,
    });
  });

  it("enters pressure at a configured storage free-capacity threshold", () => {
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      storagePressureFreeCapacity: 150_000,
    };
    const room = createRoom({
      name: "W60N2",
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 150_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect((Memory.runtime?.resourceControl?.rooms[room.name] as any).capacityState).toBe("pressure");
  });

  it("keeps a previously pressured room pressured inside the recovery band", () => {
    const roomName = "W60N3";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 200_000 },
      storageFreeCapacity: 150_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect((Memory.runtime?.resourceControl?.rooms[room.name] as any).capacityState).toBe("pressure");
  });

  it("returns a pressured room to normal only after both recovery watermarks are met", () => {
    const roomName = "W60N4";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 220_000 },
      storageFreeCapacity: 200_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect((Memory.runtime?.resourceControl?.rooms[room.name] as any).capacityState).toBe("normal");
  });

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

  it("charges the current target-support fee against total protected energy", () => {
    const donor = createRoom({
      name: "W60N5A",
      storageResources: { [RESOURCE_ENERGY]: 320_000 },
      terminalResources: { [RESOURCE_ENERGY]: 10_000 },
    });
    const receiver = createRoom({
      name: "W60N6A",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: {},
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: {
        energyTarget: 320_000,
        energyExportStart: 320_000,
      },
    };
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 1_000);

    runResourceControl();

    const supportCall = (donor.terminal!.send as jest.Mock).mock.calls.find(
      (call) => call[3] === "resourceControl:auto-balance",
    );
    expect(supportCall).toBeDefined();
    expect(supportCall[1] + 1_000).toBeLessThanOrEqual(10_000);
  });

  it("does not spend energy committed to a healthy pending outgoing task", () => {
    const donor = createRoom({
      name: "W60N7",
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
    });
    const receiver = createRoom({
      name: "W60N8",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
    });
    const committedReceiver = createRoom({
      name: "W60N9",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[committedReceiver.name] = committedReceiver;
    createResourceTransferTask(
      donor.name,
      committedReceiver.name,
      RESOURCE_ENERGY,
      80_000,
      "manual:committed",
    );

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      expect.any(Number),
      receiver.name,
      "resourceControl:auto-balance",
    );
  });

  it("does not spend energy covered by an active production reservation", () => {
    const donor = createRoom({
      name: "W60N10",
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
    });
    const receiver = createRoom({
      name: "W60N11",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    reserveProductionResource(donor.name, RESOURCE_ENERGY, 80_000, "factory:test");

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      expect.any(Number),
      receiver.name,
      "resourceControl:auto-balance",
    );
  });
});

describe("capacity-relief planning", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
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

  it("falls back to mineral relief when energy receivers are already at target", () => {
    const source = createRoom({
      name: "W61N24",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
        [RESOURCE_KEANIUM]: 40_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N25",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    const tasks = Object.values(ensureResourceTransferTaskStore()).filter(
      (task) => task.reason?.startsWith("capacity:relief:"),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      fromRoomName: source.name,
      toRoomName: receiver.name,
      resource: RESOURCE_KEANIUM,
      amount: 35_000,
      remainingAmount: 35_000,
    });
  });

  it("caps planned energy relief by uncommitted target deficit", () => {
    const source = createRoom({
      name: "W61N26",
      storageResources: { [RESOURCE_ENERGY]: 300_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const committedDonor = createRoom({
      name: "W61N27",
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
    });
    committedDonor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N28",
      storageResources: { [RESOURCE_ENERGY]: 185_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    for (const room of [source, committedDonor, receiver]) {
      Game.rooms[room.name] = room;
    }
    createResourceTransferTask(
      committedDonor.name,
      receiver.name,
      RESOURCE_ENERGY,
      10_000,
      "manual:committed-energy",
    );

    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) => entry.reason === `capacity:relief:${RESOURCE_ENERGY}`,
    );
    expect(task).toMatchObject({
      fromRoomName: source.name,
      toRoomName: receiver.name,
      amount: 5_000,
      remainingAmount: 5_000,
    });
  });

  it("plans terminal-first relief to an eligible receiver", () => {
    const source = createRoom({
      name: "W61N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find((entry) =>
      entry.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
    );
    expect(task).toMatchObject({
      origin: "automatic",
      fromRoomName: source.name,
      toRoomName: receiver.name,
      resource: RESOURCE_HYDROGEN,
      amount: 40_000,
      remainingAmount: 40_000,
      status: "pending",
    });
  });

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

  it("plans the largest movable storage surplus and stages it through the existing carrier task", () => {
    const source = createRoom({
      name: "W61N3",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 100_000,
        [RESOURCE_HYDROGEN]: 50_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N4",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find((entry) =>
      entry.reason === `capacity:relief:${RESOURCE_KEANIUM}`,
    );
    expect(task).toMatchObject({
      fromRoomName: source.name,
      toRoomName: receiver.name,
      amount: 50_000,
      remainingAmount: 50_000,
    });
    expect(getCarrierTasksByRoom(source.name)).toMatchObject({
      [`resourceControl:terminal_feed:${source.name}:${RESOURCE_KEANIUM}`]: {
        type: "terminal_feed",
        steps: [{ resource: RESOURCE_KEANIUM, amount: 10_000 }],
      },
    });
  });

  it("waits for terminal recovery before selecting a storage-only surplus", () => {
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalReliefTargetFreeCapacity: 290_000,
    };
    const source = createRoom({
      name: "W61N4A",
      storageResources: {
        [RESOURCE_ENERGY]: 120_000,
        [RESOURCE_HYDROGEN]: 100_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 0,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N4B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).filter((entry) => entry.reason?.startsWith("capacity:relief:")),
    ).toHaveLength(0);
  });

  it("replaces an existing storage relief route when terminal recovery becomes urgent", () => {
    const source = createRoom({
      name: "W61N4C",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 100_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N4D",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    const staleStorageRoute = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_KEANIUM,
      50_000,
      `capacity:relief:${RESOURCE_KEANIUM}`,
    );
    if (typeof staleStorageRoute === "string") throw new Error(staleStorageRoute);

    runResourceControl();

    expect(staleStorageRoute.task).toMatchObject({
      status: "cancelled",
      lastError: "capacity_terminal_priority_replaced",
    });
    const pending = Object.values(ensureResourceTransferTaskStore()).filter(
      (entry) => entry.status === "pending" && entry.reason?.startsWith("capacity:relief:"),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      fromRoomName: source.name,
      toRoomName: receiver.name,
      resource: RESOURCE_HYDROGEN,
      remainingAmount: 40_000,
    });
    expect(
      getCarrierTasksByRoom(source.name)[
        `resourceControl:terminal_feed:${source.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
  });

  it("keeps other receiver reservations while replacing an oversized storage route", () => {
    const source = createRoom({
      name: "W61N4G",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 100_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const otherDonor = createRoom({
      name: "W61N4H",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_OXYGEN]: 10_000,
      },
      storageFreeCapacity: 250_000,
    });
    otherDonor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N4I",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 220_000 },
      storageFreeCapacity: 300_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[otherDonor.name] = otherDonor;
    Game.rooms[receiver.name] = receiver;
    const oversizedStorageRoute = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_KEANIUM,
      50_000,
      `capacity:relief:${RESOURCE_KEANIUM}`,
    );
    if (typeof oversizedStorageRoute === "string") throw new Error(oversizedStorageRoute);
    createAutomaticResourceTransferTask(
      otherDonor.name,
      receiver.name,
      RESOURCE_OXYGEN,
      10_000,
      "synthesis:receiver-commitment",
    );

    runResourceControl();

    expect(oversizedStorageRoute.task.status).toBe("cancelled");
    const replacement = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) =>
        entry.status === "pending" &&
        entry.fromRoomName === source.name &&
        entry.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
    );
    expect(replacement).toMatchObject({
      toRoomName: receiver.name,
      amount: 29_999,
      remainingAmount: 29_999,
    });
  });

  it("cancels an existing storage relief route when terminal recovery has no safe candidate", () => {
    const source = createRoom({
      name: "W61N4E",
      storageResources: {
        [RESOURCE_ENERGY]: 110_000,
        [RESOURCE_KEANIUM]: 100_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N4F",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    reserveProductionResource(source.name, RESOURCE_HYDROGEN, 225_000, "factory:protected-terminal");
    const staleStorageRoute = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_KEANIUM,
      50_000,
      `capacity:relief:${RESOURCE_KEANIUM}`,
    );
    if (typeof staleStorageRoute === "string") throw new Error(staleStorageRoute);

    runResourceControl();

    expect(staleStorageRoute.task).toMatchObject({
      status: "cancelled",
      lastError: "capacity_terminal_priority_replaced",
    });
    expect(
      Object.values(ensureResourceTransferTaskStore()).filter(
        (entry) => entry.status === "pending" && entry.reason?.startsWith("capacity:relief:"),
      ),
    ).toHaveLength(0);
    expect(
      getCarrierTasksByRoom(source.name)[
        `resourceControl:terminal_feed:${source.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
  });

  it("keeps the configured per-room T3 reserve out of capacity relief", () => {
    const source = createRoom({
      name: "W61N5",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 252_000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 8_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N6",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find((entry) =>
      entry.reason === `capacity:relief:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    expect(task).toMatchObject({
      amount: 3_000,
      remainingAmount: 3_000,
    });
  });

  it("keeps the configured base-mineral floor out of capacity relief", () => {
    const source = createRoom({
      name: "W61N9",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 250_000,
        [RESOURCE_HYDROGEN]: 10_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N10",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).find(
        (entry) => entry.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
      ),
    ).toMatchObject({ amount: 5_000, remainingAmount: 5_000 });
  });

  it("keeps active production reservations out of mineral relief", () => {
    const source = createRoom({
      name: "W61N11",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 210_000,
        [RESOURCE_KEANIUM]: 50_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N12",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    reserveProductionResource(source.name, RESOURCE_KEANIUM, 40_000, "factory:reserved");

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).find(
        (entry) => entry.reason === `capacity:relief:${RESOURCE_KEANIUM}`,
      ),
    ).toMatchObject({ amount: 5_000, remainingAmount: 5_000 });
  });

  it("keeps active synthesis, boost, and factory carrier commitments out of relief", () => {
    const source = createRoom({
      name: "W61N13",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 210_000,
        [RESOURCE_KEANIUM]: 50_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N14",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    replaceCarrierTasksForProducerRoom("synthesisControl", source.name, [
      {
        id: "synthesis:test:K",
        type: "lab_supply",
        priority: 100,
        steps: [
          {
            id: "K:terminal->lab",
            resource: RESOURCE_KEANIUM,
            fromKind: "terminal",
            toKind: "lab",
            fromId: source.terminal!.id,
            toId: "test-lab" as Id<StructureLab>,
            amount: 40_000,
          },
        ],
      },
    ]);

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).find(
        (entry) => entry.reason === `capacity:relief:${RESOURCE_KEANIUM}`,
      ),
    ).toMatchObject({ amount: 5_000, remainingAmount: 5_000 });
  });

  it("does not admit a new receiver below the configured storage watermark", () => {
    const source = createRoom({
      name: "W61N7",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W61N8",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 299_999,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).filter((entry) => entry.reason?.startsWith("capacity:relief:")),
    ).toHaveLength(0);
  });

  it("uses transaction cost as the receiver tie-breaker", () => {
    const source = createRoom({
      name: "W62N0",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const expensiveReceiver = createRoom({
      name: "W62N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    const cheapReceiver = createRoom({
      name: "W62N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[expensiveReceiver.name] = expensiveReceiver;
    Game.rooms[cheapReceiver.name] = cheapReceiver;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
      (_amount: number, _from: string, to: string) => to === cheapReceiver.name ? 100 : 1_000,
    );

    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find((entry) =>
      entry.reason?.startsWith("capacity:relief:"),
    );
    expect(task?.toRoomName).toBe(cheapReceiver.name);
  });

  it("does not overcommit one receiver across newly planned routes", () => {
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      maxPlannedAmountPerTask: 5_000,
    };
    const receiver = createRoom({
      name: "W63N0",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 250_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[receiver.name] = receiver;

    for (const [index, resource] of [RESOURCE_HYDROGEN, RESOURCE_KEANIUM].entries()) {
      const source = createRoom({
        name: `W63N${index + 1}`,
        storageResources: { [RESOURCE_ENERGY]: 200_000 },
        terminalResources: {
          [RESOURCE_ENERGY]: 30_000,
          [resource]: 230_000,
        },
        storageFreeCapacity: 500_000,
      });
      source.terminal!.cooldown = 1;
      Game.rooms[source.name] = source;
    }

    runResourceControl();

    const tasks = Object.values(ensureResourceTransferTaskStore()).filter(
      (entry) => entry.status === "pending" && entry.reason?.startsWith("capacity:relief:"),
    );
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((task) => task.resource))).toEqual(
      new Set([RESOURCE_HYDROGEN, RESOURCE_KEANIUM]),
    );
    expect(tasks.reduce((sum, task) => sum + task.remainingAmount, 0)).toBe(9_999);
    expect(tasks.every((task) => task.toRoomName === receiver.name)).toBe(true);
  });

  it("does not admit against terminal space promised only by an unfinished offload", () => {
    const source = createRoom({
      name: "W63N2A",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W63N2B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 50_000,
      },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    replaceCarrierTasksForProducerRoom("resourceControl:preload", receiver.name, [
      {
        id: `resourceControl:terminal_offload:${receiver.name}:${RESOURCE_KEANIUM}`,
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: `${RESOURCE_KEANIUM}:${receiver.terminal!.id}->${receiver.storage!.id}`,
            resource: RESOURCE_KEANIUM,
            fromKind: "terminal",
            toKind: "storage",
            fromId: receiver.terminal!.id,
            toId: receiver.storage!.id,
            amount: 50_000,
          },
        ],
      },
    ]);

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).find(
        (task) => task.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
      ),
    ).toMatchObject({
      toRoomName: receiver.name,
      remainingAmount: 9_999,
    });
  });

  it("reuses receiver capacity released by a receiver-capacity blocker in the same planning pass", () => {
    const blockedDonor = createRoom({
      name: "W63N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
      storageFreeCapacity: 250_000,
    });
    blockedDonor.terminal!.cooldown = 1;
    const pressureSource = createRoom({
      name: "W63N4",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    pressureSource.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W63N5",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 250_000 },
      storageFreeCapacity: 500_000,
    });
    for (const room of [blockedDonor, pressureSource, receiver]) {
      Game.rooms[room.name] = room;
    }
    const blocked = createAutomaticResourceTransferTask(
      blockedDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      9_999,
      "synthesis:blocked-capacity",
    );
    if (typeof blocked === "string") throw new Error(blocked);
    markResourceTransferTaskBlocked(blocked.task, "receiver_capacity");

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).find(
        (task) =>
          task.fromRoomName === pressureSource.name &&
          task.toRoomName === receiver.name &&
          task.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
      ),
    ).toMatchObject({ remainingAmount: 9_999 });
  });

  it("creates at most five new relief tasks per planning run", () => {
    const receiver = createRoom({
      name: "W64N0",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[receiver.name] = receiver;

    for (let index = 1; index <= 6; index += 1) {
      const source = createRoom({
        name: `W64N${index}`,
        storageResources: { [RESOURCE_ENERGY]: 200_000 },
        terminalResources: {
          [RESOURCE_ENERGY]: 30_000,
          [RESOURCE_HYDROGEN]: 230_000,
        },
        storageFreeCapacity: 500_000,
      });
      source.terminal!.cooldown = 1;
      Game.rooms[source.name] = source;
    }

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).filter(
        (entry) => entry.status === "pending" && entry.reason?.startsWith("capacity:relief:"),
      ),
    ).toHaveLength(5);
  });

  it("keeps at most one healthy pending relief route per source", () => {
    const source = createRoom({
      name: "W65N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W65N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      20_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).filter(
        (entry) =>
          entry.status === "pending" &&
          entry.fromRoomName === source.name &&
          entry.reason?.startsWith("capacity:relief:"),
      ),
    ).toHaveLength(1);
  });

  it("atomically retargets a receiver-capacity-blocked automatic relief route", () => {
    const source = createRoom({
      name: "W66N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 500_000,
    });
    source.terminal!.cooldown = 1;
    const unsafeReceiver = createRoom({
      name: "W66N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 290_000 },
      storageFreeCapacity: 50_000,
    });
    const replacementReceiver = createRoom({
      name: "W66N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[unsafeReceiver.name] = unsafeReceiver;
    Game.rooms[replacementReceiver.name] = replacementReceiver;
    const created = createAutomaticResourceTransferTask(
      source.name,
      unsafeReceiver.name,
      RESOURCE_HYDROGEN,
      40_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );
    if (typeof created === "string") throw new Error(created);
    markResourceTransferTaskBlocked(created.task, "receiver_capacity");

    runResourceControl();

    expect(created.task).toMatchObject({ status: "cancelled" });
    const pending = Object.values(ensureResourceTransferTaskStore()).filter(
      (entry) =>
        entry.status === "pending" &&
        entry.fromRoomName === source.name &&
        entry.reason?.startsWith("capacity:relief:"),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toRoomName: replacementReceiver.name,
      remainingAmount: 40_000,
      origin: "automatic",
    });
  });

  it("replaces stale blocked energy relief with mineral relief when no receiver needs energy", () => {
    const source = createRoom({
      name: "W66N4",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
        [RESOURCE_KEANIUM]: 40_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const satisfiedReceiver = createRoom({
      name: "W66N5",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 300_000,
    });
    Game.rooms[source.name] = source;
    Game.rooms[satisfiedReceiver.name] = satisfiedReceiver;
    const staleEnergyRoute = createAutomaticResourceTransferTask(
      source.name,
      satisfiedReceiver.name,
      RESOURCE_ENERGY,
      200_000,
      `capacity:relief:${RESOURCE_ENERGY}`,
    );
    if (typeof staleEnergyRoute === "string") throw new Error(staleEnergyRoute);
    markResourceTransferTaskBlocked(staleEnergyRoute.task, "receiver_capacity");

    runResourceControl();

    expect(staleEnergyRoute.task.status).toBe("cancelled");
    const pending = Object.values(ensureResourceTransferTaskStore()).filter(
      (entry) =>
        entry.status === "pending" &&
        entry.fromRoomName === source.name &&
        entry.reason?.startsWith("capacity:relief:"),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toRoomName: satisfiedReceiver.name,
      resource: RESOURCE_KEANIUM,
      amount: 35_000,
      remainingAmount: 35_000,
      origin: "automatic",
    });
  });

  it("keeps blocked energy relief as energy when another receiver still needs it", () => {
    const source = createRoom({
      name: "W66N6",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
        [RESOURCE_KEANIUM]: 40_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
      storageFreeCapacity: 50_000,
    });
    source.terminal!.cooldown = 1;
    const satisfiedReceiver = createRoom({
      name: "W66N7",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 300_000,
    });
    const needyReceiver = createRoom({
      name: "W66N8",
      storageResources: { [RESOURCE_ENERGY]: 185_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    for (const room of [source, satisfiedReceiver, needyReceiver]) {
      Game.rooms[room.name] = room;
    }
    const blockedEnergyRoute = createAutomaticResourceTransferTask(
      source.name,
      satisfiedReceiver.name,
      RESOURCE_ENERGY,
      50_000,
      `capacity:relief:${RESOURCE_ENERGY}`,
    );
    if (typeof blockedEnergyRoute === "string") throw new Error(blockedEnergyRoute);
    markResourceTransferTaskBlocked(blockedEnergyRoute.task, "receiver_capacity");

    runResourceControl();

    expect(blockedEnergyRoute.task.status).toBe("cancelled");
    const pending = Object.values(ensureResourceTransferTaskStore()).filter(
      (entry) =>
        entry.status === "pending" &&
        entry.fromRoomName === source.name &&
        entry.reason?.startsWith("capacity:relief:"),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toRoomName: needyReceiver.name,
      resource: RESOURCE_ENERGY,
      amount: 15_000,
      remainingAmount: 15_000,
      origin: "automatic",
    });
  });

  it("waits without a market deal when no safe receiver exists", () => {
    Memory.cfg!.resourceControl!.market = {
      enabled: true,
      emergencyBuyEnabled: false,
      sellResources: [RESOURCE_HYDROGEN],
    };
    const source = createRoom({
      name: "W67N1",
      storageResources: { [RESOURCE_ENERGY]: 50_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_000,
      },
      storageFreeCapacity: 0,
    });
    Game.rooms[source.name] = source;
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(() => [
      {
        id: "would-buy-hydrogen",
        type: ORDER_BUY,
        resourceType: RESOURCE_HYDROGEN,
        amount: 50_000,
        remainingAmount: 50_000,
        price: 1,
        roomName: "W99N99",
      } as Order,
    ]);

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(
      Object.values(ensureResourceTransferTaskStore()).filter((entry) => entry.reason?.startsWith("capacity:relief:")),
    ).toHaveLength(0);
  });
});

describe("capacity-relief execution health and priority", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
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

  it("marks source depletion before receiver capacity", () => {
    const donor = createRoom({
      name: "W68N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    });
    const receiver = createRoom({
      name: "W68N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 300_000 },
      storageFreeCapacity: 0,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();

    expect(created.task).toMatchObject({
      status: "pending",
      blockedReason: "source_depleted",
      blockedSince: 10,
    });
  });

  it("keeps the first blocked tick stable across repeated checks", () => {
    const donor = createRoom({ name: "W68N3" });
    const receiver = createRoom({ name: "W68N4", storageFreeCapacity: 0 });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();
    Game.time = 20;
    runResourceControl();

    expect(created.task).toMatchObject({
      blockedReason: "source_depleted",
      blockedSince: 10,
      updatedAt: 10,
    });
  });

  it("clears a capacity blocker and records progress when the receiver recovers", () => {
    const donor = createRoom({
      name: "W68N5",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
    });
    const blockedReceiver = createRoom({
      name: "W68N6",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 290_000 },
      storageFreeCapacity: 50_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[blockedReceiver.name] = blockedReceiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      blockedReceiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();
    expect(created.task.blockedReason).toBe("receiver_capacity");

    Game.time = 20;
    const recoveredReceiver = createRoom({
      name: blockedReceiver.name,
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[recoveredReceiver.name] = recoveredReceiver;
    resetRuntimeServices();
    runResourceControl();

    expect(created.task).toMatchObject({
      status: "done",
      remainingAmount: 0,
      lastProgressAt: 20,
      updatedAt: 20,
    });
    expect(created.task.blockedReason).toBeUndefined();
    expect(created.task.blockedSince).toBeUndefined();
  });

  it("marks terminal supply or fee shortage as an explicit blocker", () => {
    const donor = createRoom({
      name: "W68N7",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    });
    const receiver = createRoom({
      name: "W68N8",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();

    expect(created.task).toMatchObject({
      status: "pending",
      blockedReason: "insufficient_terminal_resource_or_fee",
      blockedSince: 10,
    });
  });

  it("keeps a persistent terminal-supply blocker age stable", () => {
    const donor = createRoom({
      name: "W68N8A",
      storageResources: {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    });
    const receiver = createRoom({
      name: "W68N8B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();
    Game.time = 20;
    runResourceControl();

    expect(created.task).toMatchObject({
      status: "pending",
      blockedReason: "insufficient_terminal_resource_or_fee",
      blockedSince: 10,
      updatedAt: 10,
    });
  });

  it("retains the prior supply blocker when a viable send attempt fails", () => {
    const donor = createRoom({
      name: "W68N8C",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
    });
    const receiver = createRoom({
      name: "W68N8D",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Game.time = 1;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    if (typeof created === "string") throw new Error(created);
    markResourceTransferTaskBlocked(created.task, "insufficient_terminal_resource_or_fee");
    (donor.terminal!.send as jest.Mock).mockReturnValue(ERR_TIRED);

    Game.time = 10;
    runResourceControl();

    expect(created.task).toMatchObject({
      status: "pending",
      blockedReason: "insufficient_terminal_resource_or_fee",
      blockedSince: 1,
      updatedAt: 10,
      lastError: `send_code_${ERR_TIRED}`,
    });
  });

  it("releases a failed send reservation before a competing task reserves the receiver", () => {
    const failedDonor = createRoom({
      name: "W68N8E",
      storageResources: { [RESOURCE_KEANIUM]: 5_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 20_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
    });
    const competingDonor = createRoom({
      name: "W68N8F",
      storageResources: { [RESOURCE_OXYGEN]: 5_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 20_000,
        [RESOURCE_OXYGEN]: 1_000,
      },
    });
    const receiver = createRoom({
      name: "W68N8G",
      storageFreeCapacity: 102_000,
    });
    Game.rooms[failedDonor.name] = failedDonor;
    Game.rooms[competingDonor.name] = competingDonor;
    Game.rooms[receiver.name] = receiver;
    Game.time = 1;
    const failed = createResourceTransferTask(
      failedDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:failed-reservation",
    );
    Game.time = 2;
    const competing = createResourceTransferTask(
      competingDonor.name,
      receiver.name,
      RESOURCE_OXYGEN,
      1_000,
      "manual:competing-reservation",
    );
    if (typeof failed === "string") throw new Error(failed);
    if (typeof competing === "string") throw new Error(competing);
    (failedDonor.terminal!.send as jest.Mock).mockReturnValue(ERR_TIRED);
    const reserveSpy = jest.spyOn(ReceiverCapacityLedger.prototype, "reserve");

    Game.time = 10;
    runResourceControl();

    const reserveCalls = [...reserveSpy.mock.calls];
    reserveSpy.mockRestore();
    const failedGrantIndex = reserveCalls.findIndex(
      ([reservationId, , , amount]) => reservationId === failed.task.id && amount > 0,
    );
    const failedReleaseIndex = reserveCalls.findIndex(
      ([reservationId, , , amount], index) =>
        index > failedGrantIndex && reservationId === failed.task.id && amount === 0,
    );
    const competingGrantIndex = reserveCalls.findIndex(
      ([reservationId, , , amount]) => reservationId === competing.task.id && amount > 0,
    );
    expect(failedGrantIndex).toBeGreaterThanOrEqual(0);
    expect(failedReleaseIndex).toBeGreaterThan(failedGrantIndex);
    expect(competingGrantIndex).toBeGreaterThan(failedReleaseIndex);
    expect(failed.task).toMatchObject({
      status: "pending",
      lastError: `send_code_${ERR_TIRED}`,
    });
    expect(competing.task).toMatchObject({ status: "done", remainingAmount: 0 });
  });

  it("uses configured receiver safety buffers for every queued send", () => {
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      storagePressureFreeCapacity: 150_000,
      terminalPressureFreeCapacity: 60_000,
    };
    const donor = createRoom({
      name: "W68N9",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    const receiver = createRoom({
      name: "W68N10",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 235_000 },
      storageFreeCapacity: 155_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(donor.name, receiver.name, RESOURCE_KEANIUM, 10_000, "manual:test");

    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_KEANIUM,
      5_000,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
  });

  it("admits a war boost shipment into physical terminal headroom below the normal safety buffer", () => {
    const donor = createRoom({
      name: "W68N9B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 40_000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 1_200,
      },
    });
    const receiver = createRoom({
      name: "W68N10B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 296_000 },
      storageFreeCapacity: 20_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_CATALYZED_UTRIUM_ACID,
      1_200,
      "powerBankBoost:war:E1N57:E2N54:g1",
    );

    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_CATALYZED_UTRIUM_ACID,
      1_200,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
  });

  it("does not execute capacity relief into a hysteresis-pressure receiver", () => {
    const donor = createRoom({
      name: "W68N10A",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
      storageFreeCapacity: 50_000,
    });
    const receiver = createRoom({
      name: "W68N10B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 150_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [receiver.name]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      10_000,
      `capacity:relief:${RESOURCE_KEANIUM}`,
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
    expect(created.task).toMatchObject({
      status: "pending",
      blockedReason: "receiver_capacity",
      blockedSince: 10,
    });
  });

  it("rechecks protected stock before executing an already queued capacity task", () => {
    const donor = createRoom({
      name: "W68N10C",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5_000,
      },
      storageFreeCapacity: 50_000,
    });
    const receiver = createRoom({
      name: "W68N10D",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      1_000,
      `capacity:relief:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
    expect(created.task).toMatchObject({
      status: "pending",
      blockedReason: "insufficient_terminal_resource_or_fee",
    });
  });

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

  it("cancels remaining relief after the source has already recovered", () => {
    const donor = createRoom({
      name: "W68N10G",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 1_000,
      },
      storageFreeCapacity: 500_000,
    });
    const receiver = createRoom({
      name: "W68N10H",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );
    if (typeof created === "string") throw new Error(created);

    runResourceControl();

    expect(donor.terminal!.send).not.toHaveBeenCalled();
    expect(created.task).toMatchObject({
      status: "cancelled",
      lastError: "capacity_source_recovered",
    });
  });

  it("shares the five-send budget between survival support and queued transfers", () => {
    const energyDonor = createRoom({
      name: "W69N0",
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: { [RESOURCE_ENERGY]: 100_000 },
    });
    const taskReceiver = createRoom({
      name: "W69N9",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[energyDonor.name] = energyDonor;
    Game.rooms[taskReceiver.name] = taskReceiver;

    const taskDonors: Room[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const donor = createRoom({
        name: `W69N${index}`,
        storageResources: { [RESOURCE_ENERGY]: 50_000 },
        terminalResources: {
          [RESOURCE_ENERGY]: 21_000,
          [RESOURCE_KEANIUM]: 1_000,
        },
      });
      taskDonors.push(donor);
      Game.rooms[donor.name] = donor;
      createResourceTransferTask(donor.name, taskReceiver.name, RESOURCE_KEANIUM, 1_000, `manual:${index}`);
    }

    runResourceControl();

    const sendCalls = [energyDonor, ...taskDonors].reduce(
      (sum, room) => sum + ((room.terminal!.send as jest.Mock).mock.calls.length || 0),
      0,
    );
    expect(energyDonor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      expect.any(Number),
      expect.any(String),
      "resourceControl:auto-balance",
    );
    expect(sendCalls).toBe(5);
  });

  it("refreshes source-depleted health after the send budget is exhausted", () => {
    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;
    const activeDonor = createRoom({
      name: "W69N9A",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 1_000,
      },
    });
    const depletedDonor = createRoom({
      name: "W69N9B",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
    });
    const receiver = createRoom({
      name: "W69N9C",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[activeDonor.name] = activeDonor;
    Game.rooms[depletedDonor.name] = depletedDonor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(activeDonor.name, receiver.name, RESOURCE_HYDROGEN, 1_000, "manual:first");
    const depleted = createAutomaticResourceTransferTask(
      depletedDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:depleted",
    );
    if (typeof depleted === "string") throw new Error(depleted);

    runResourceControl();

    expect(activeDonor.terminal!.send).toHaveBeenCalledTimes(1);
    expect(depleted.task).toMatchObject({
      status: "pending",
      blockedReason: "source_depleted",
      blockedSince: 10,
    });
  });

  it("clears a recovered terminal-supply blocker after the send budget is exhausted", () => {
    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(() => 100);
    const firstDonor = createRoom({
      name: "W69N9D",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 1_000,
      },
    });
    const recoveredDonor = createRoom({
      name: "W69N9E",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
    });
    const receiver = createRoom({
      name: "W69N9F",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[firstDonor.name] = firstDonor;
    Game.rooms[recoveredDonor.name] = recoveredDonor;
    Game.rooms[receiver.name] = receiver;

    Game.time = 1;
    const first = createResourceTransferTask(
      firstDonor.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      "manual:first",
    );
    if (typeof first === "string") throw new Error(first);
    Game.time = 2;
    const recovered = createResourceTransferTask(
      recoveredDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:later",
    );
    if (typeof recovered === "string") throw new Error(recovered);
    markResourceTransferTaskBlocked(recovered.task, "insufficient_terminal_resource_or_fee");

    Game.time = 10;
    runResourceControl();

    expect(firstDonor.terminal!.send).toHaveBeenCalledTimes(1);
    expect(recoveredDonor.terminal!.send).not.toHaveBeenCalled();
    expect(recovered.task).toMatchObject({
      status: "pending",
      remainingAmount: 1_000,
    });
    expect(recovered.task.blockedReason).toBeUndefined();
    expect(recovered.task.blockedSince).toBeUndefined();
  });

  it("shares receiver safety capacity across multiple sends in one run", () => {
    const firstDonor = createRoom({
      name: "W69N10",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    const secondDonor = createRoom({
      name: "W69N11",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 10_000,
      },
    });
    const receiver = createRoom({
      name: "W69N12",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 245_000 },
      storageFreeCapacity: 115_000,
    });
    Game.rooms[firstDonor.name] = firstDonor;
    Game.rooms[secondDonor.name] = secondDonor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(firstDonor.name, receiver.name, RESOURCE_KEANIUM, 10_000, "manual:first");
    createResourceTransferTask(secondDonor.name, receiver.name, RESOURCE_HYDROGEN, 10_000, "manual:second");

    runResourceControl();

    expect(firstDonor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_KEANIUM,
      5_000,
      receiver.name,
      expect.any(String),
    );
    expect(secondDonor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_HYDROGEN,
      5_000,
      receiver.name,
      expect.any(String),
    );
  });

  it("shares one receiver energy need across queued donors in one run", () => {
    const donors = ["W69N13", "W69N14"].map((name) => createRoom({
      name,
      storageResources: { [RESOURCE_ENERGY]: 250_000 },
      terminalResources: { [RESOURCE_ENERGY]: 30_000 },
    }));
    const receiver = createRoom({
      name: "W69N15",
      storageResources: { [RESOURCE_ENERGY]: 195_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    for (const room of [...donors, receiver]) {
      Game.rooms[room.name] = room;
    }
    for (const donor of donors) {
      createResourceTransferTask(
        donor.name,
        receiver.name,
        RESOURCE_ENERGY,
        10_000,
        "energy-support",
      );
    }

    runResourceControl();

    const sent = donors.reduce((sum, donor) => {
      const call = (donor.terminal!.send as jest.Mock).mock.calls.find(
        (entry) => entry[2] === receiver.name,
      );
      return sum + (call?.[1] || 0);
    }, 0);
    expect(sent).toBe(5_000);
  });

  it("runs emergency capacity relief before synthesis tasks", () => {
    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;
    const synthesisDonor = createRoom({
      name: "W70N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    const capacityDonor = createRoom({
      name: "W70N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 10_000,
      },
      storageFreeCapacity: 0,
    });
    const receiver = createRoom({
      name: "W70N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[synthesisDonor.name] = synthesisDonor;
    Game.rooms[capacityDonor.name] = capacityDonor;
    Game.rooms[receiver.name] = receiver;
    createAutomaticResourceTransferTask(
      synthesisDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );
    createAutomaticResourceTransferTask(
      capacityDonor.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );

    runResourceControl();

    expect(capacityDonor.terminal!.send).toHaveBeenCalledTimes(1);
    expect(synthesisDonor.terminal!.send).not.toHaveBeenCalled();
  });

  it("runs synthesis tasks before non-emergency capacity relief", () => {
    Memory.cfg!.resourceControl!.taskMaxPerRun = 1;
    const capacityDonor = createRoom({
      name: "W71N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 10_000,
      },
      storageFreeCapacity: 50_000,
    });
    const synthesisDonor = createRoom({
      name: "W71N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    const receiver = createRoom({
      name: "W71N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[capacityDonor.name] = capacityDonor;
    Game.rooms[synthesisDonor.name] = synthesisDonor;
    Game.rooms[receiver.name] = receiver;
    createAutomaticResourceTransferTask(
      capacityDonor.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      1_000,
      `capacity:relief:${RESOURCE_HYDROGEN}`,
    );
    createAutomaticResourceTransferTask(
      synthesisDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );

    runResourceControl();

    expect(synthesisDonor.terminal!.send).toHaveBeenCalledTimes(1);
    expect(capacityDonor.terminal!.send).not.toHaveBeenCalled();
  });
});

describe("resource-control logistics observability", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: { enabled: false },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 123),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("counts real transfer-context builds instead of reporting a constant", () => {
    const buildCounter = { count: 0 };
    const capacityConfig = normalizeCapacityConfig({});

    createResourceControlTransferContext([], capacityConfig, buildCounter);
    createResourceControlTransferContext([], capacityConfig, buildCounter);

    expect(buildCounter.count).toBe(2);
  });

  it("persists actual terminal reserve and one-pass task blocker aggregates", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    Memory.cfg!.resourceControl!.rooms = {
      W72N1: { terminalEnergyReserve: 30_000 },
    };
    const donor = createRoom({
      name: "W72N1",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 40_000,
        [RESOURCE_KEANIUM]: 6_000,
      },
    });
    const receiver = createRoom({
      name: "W72N2",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 290_000 },
      storageFreeCapacity: 50_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "synthesis:test",
    );

    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[donor.name]).toMatchObject({
      terminalEnergyReserve: 30_000,
      taskHealth: {
        pendingIncoming: 0,
        pendingOutgoing: 1,
        blockedIncoming: {},
        blockedOutgoing: { receiver_capacity: 1 },
      },
    });
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]).toMatchObject({
      taskHealth: {
        pendingIncoming: 1,
        pendingOutgoing: 0,
        blockedIncoming: { receiver_capacity: 1 },
        blockedOutgoing: {},
      },
    });
  });

  it("persists bounded structured history for successful capacity relief sends", () => {
    const donor = createRoom({
      name: "W72N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 40_000,
        [RESOURCE_KEANIUM]: 6_000,
      },
      storageFreeCapacity: 50_000,
    });
    const receiver = createRoom({
      name: "W72N4",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    const created = createAutomaticResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      `capacity:relief:${RESOURCE_KEANIUM}`,
    );
    if (typeof created === "string") throw new Error(created);
    const reserveSpy = jest.spyOn(ReceiverCapacityLedger.prototype, "reserve");

    runResourceControl();

    expect(reserveSpy).toHaveBeenCalledWith(
      created.task.id,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      { ownerTaskId: created.task.id },
    );

    expect((Memory.runtime?.resourceControl as any)?.recentCapacityReliefRoutes).toEqual([
      {
        tick: 10,
        taskId: created.task.id,
        fromRoomName: donor.name,
        toRoomName: receiver.name,
        resource: RESOURCE_KEANIUM,
        amount: 1_000,
        transferCost: 123,
      },
    ]);
    expect(Memory.runtime?.resourceControl?.rooms[donor.name]).toMatchObject({
      terminalUsedCapacity: 44_877,
      terminalFreeCapacity: 255_123,
      terminalEnergy: 39_877,
      minerals: { [RESOURCE_KEANIUM]: 5_000 },
    });
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]).toMatchObject({
      terminalUsedCapacity: 21_000,
      terminalFreeCapacity: 279_000,
      minerals: { [RESOURCE_KEANIUM]: 1_000 },
    });
    expect(Memory.runtime?.resourceControl?.capacityIndexBuildCount).toBe(1);
  });

  it("keeps transfer-task store scans bounded independently of room count", () => {
    (Memory.cfg!.resourceControl as any).capacityBalancing = { enabled: false };
    const rooms = Array.from({ length: 4 }, (_, index) => createRoom({
      name: `W72N${index + 5}`,
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    }));
    for (const room of rooms) Game.rooms[room.name] = room;
    createResourceTransferTask(rooms[0].name, rooms[1].name, RESOURCE_KEANIUM, 1_000, "manual:scan-bound");

    let scans = 0;
    const rawStore = Memory.data!.resourceControl!.tasks!;
    Memory.data!.resourceControl!.tasks = new Proxy(rawStore, {
      ownKeys(target) {
        scans += 1;
        return Reflect.ownKeys(target);
      },
    });

    runResourceControl();

    expect(Memory.runtime?.resourceControl?.capacityIndexBuildCount).toBe(1);
    expect(scans).toBeLessThanOrEqual(5);
  });

  it("updates only the synced task contribution while sharing one run context", () => {
    Memory.cfg!.resourceControl!.capacityBalancing = { enabled: false };
    const rooms = Array.from({ length: 4 }, (_, index) => createRoom({
      name: `W73N${index + 1}`,
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
      storageFreeCapacity: 500_000,
    }));
    for (const room of rooms) Game.rooms[room.name] = room;
    createResourceTransferTask(rooms[0].name, rooms[1].name, RESOURCE_KEANIUM, 1_000, "manual:index-k");
    createResourceTransferTask(rooms[1].name, rooms[2].name, RESOURCE_HYDROGEN, 1_000, "manual:index-h");
    createResourceTransferTask(rooms[2].name, rooms[3].name, RESOURCE_OXYGEN, 1_000, "manual:index-o");

    runResourceControl();

    const probe = Memory.runtime?.resourceControl?.taskContributionIndex;
    expect(Memory.runtime?.resourceControl?.capacityIndexBuildCount).toBe(1);
    expect(probe).toMatchObject({ initialTaskCount: 3 });
    if (!probe) throw new Error("missing task contribution index probe");
    expect(probe.syncCount).toBeGreaterThanOrEqual(3);
    expect(probe.contributionEvaluationCount).toBe(
      probe.initialTaskCount + probe.syncCount,
    );
  });
});
