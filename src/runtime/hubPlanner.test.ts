import {
  createAutomaticResourceTransferTask,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  getOutgoingResourceTransferAmount,
  markResourceTransferTaskBlocked,
} from "@/runtime/logistics/resourceTransferTasks";
import { runHubByFlag } from "@/runtime/hubFlag";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  clearHubSynthesisReactions,
  getDefaultHubConfig,
  getDefaultHubRuntime,
  getEligibleSynthesisRooms,
  planDistributedSynthesis,
  planHubChains,
  planHubDistribution,
  planHubImports,
  resupplyBusySynthesisRooms,
  runHubPlanner,
  scoreRoomForStep,
  wireDistributedSynthesis,
  wireRouteTransferTasks,
  DependencyGraph,
} from "@/runtime/hubPlanner";
import type {
  DistributedSynthesisPlan,
  ChainStep,
} from "@/runtime/hubPlanner";
import type {
  SynthesisRoomCapability,
  SynthesisDispatchAssignment,
  AllocationLedgerEntry,
  DirectRouteDecision,
  ProgressEdge,
} from "@/runtime/hubPlanner";
import type { HubRuntimeProtectionExtension } from "@/runtime/hubProtectionSnapshot";

function createHubRoom(options: {
  hasStorage?: boolean;
  hasTerminal?: boolean;
  labCount?: number;
  controllerMine?: boolean;
}): Room {
  const storage = options.hasStorage
    ? {
        id: "hub-storage",
        structureType: STRUCTURE_STORAGE,
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 500000,
          [RESOURCE_ENERGY]: 0,
        },
      }
    : undefined;

  const terminal = options.hasTerminal
    ? {
        id: "hub-terminal",
        structureType: STRUCTURE_TERMINAL,
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 10000,
        },
        cooldown: 0,
      }
    : undefined;

  const labCount = options.labCount ?? 3;
  const labs: Structure[] = [];
  for (let i = 0; i < labCount; i++) {
    labs.push({
      id: `hub-lab-${i}`,
      structureType: STRUCTURE_LAB,
    } as Structure);
  }

  const room = {
    name: "W1N1",
    controller: { my: options.controllerMine ?? true, level: 8 },
    storage,
    terminal,
    find: (type: FindConstant, opts?: { filter?: ((s: Structure) => boolean) | { structureType: string } }) => {
      if (type === FIND_MY_STRUCTURES) {
        if (!opts?.filter) return labs;
        if (typeof opts.filter === "function") return labs.filter(opts.filter);
        const targetType = (opts.filter as { structureType: string }).structureType;
        return labs.filter((s) => s.structureType === targetType);
      }
      return [];
    },
  } as unknown as Room;

  return room;
}

const HUB_ROOM = "W1N1";

describe("clearHubSynthesisReactions", () => {
  const OTHER_ROOM = "W2N1";
  const PLAN_INTERVAL = 50;

  beforeEach(() => {
    Game.time = PLAN_INTERVAL;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: PLAN_INTERVAL,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: getDefaultHubRuntime(),
    };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("returns safely when no synthesis config exists", () => {
    expect(() => clearHubSynthesisReactions(HUB_ROOM)).not.toThrow();
  });
});

function createSatelliteRoom(
  roomName: string,
  storageResources: Record<string, number>,
  terminalResources: Record<string, number> = {},
): Room {
  const storageEntries: Record<string, number> = { [RESOURCE_ENERGY]: 50000, ...storageResources };
  const terminalEntries: Record<string, number> = { [RESOURCE_ENERGY]: 20000, ...terminalResources };

  const storage = {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    store: {
      ...storageEntries,
      getUsedCapacity: (resource?: string) => {
        if (resource) return storageEntries[resource] || 0;
        return Object.values(storageEntries).reduce((a: number, b: number) => a + b, 0);
      },
      getFreeCapacity: () => 500000,
    },
  };

  const terminal = {
    id: `${roomName}-terminal`,
    structureType: STRUCTURE_TERMINAL,
    store: {
      ...terminalEntries,
      getUsedCapacity: (resource?: string) => {
        if (resource) return terminalEntries[resource] || 0;
        return Object.values(terminalEntries).reduce((a: number, b: number) => a + b, 0);
      },
      getFreeCapacity: () => 300000,
      cooldown: 0,
    },
  };

  return {
    name: roomName,
    controller: { my: true, level: 8 },
    storage,
    terminal,
    find: () => [],
  } as unknown as Room;
}

function createHubRoomForImports(freeCapacity: number = 500000): Room {
  const storageEntries: Record<string, number> = { [RESOURCE_ENERGY]: 200000 };
  return {
    name: HUB_ROOM,
    controller: { my: true, level: 8 },
    storage: {
      id: "hub-storage",
      structureType: STRUCTURE_STORAGE,
      store: {
        ...storageEntries,
        getUsedCapacity: (resource?: string) => {
          if (resource) return storageEntries[resource] || 0;
          return Object.values(storageEntries).reduce((a: number, b: number) => a + b, 0);
        },
        getFreeCapacity: () => freeCapacity,
      },
    },
    terminal: {
      id: "hub-terminal",
      structureType: STRUCTURE_TERMINAL,
      store: {
        [RESOURCE_ENERGY]: 20000,
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300000,
        cooldown: 0,
      },
    },
    find: () => [],
  } as unknown as Room;
}

describe("planHubImports", () => {
  const HUB_ROOM = "W1N1";
  const SAT_ROOM = "W2N1";

  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE], // XGHO2
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("creates base mineral import from survival satellite with surplus H above safety floor", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    Memory.runtime!.resourceControl = {
      updatedAt: Game.time,
      rooms: {
        [SAT_ROOM]: {
          state: "survival",
          storageEnergy: 50000,
          terminalEnergy: 20000,
          energyFloor: 120000,
          energyTarget: 200000,
          energyExportStart: 250000,
          canMineNative: false,
          minerals: {},
        },
      },
      lastActions: [],
      lastMarketActions: [],
    };
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContain(`import:${SAT_ROOM}:${RESOURCE_HYDROGEN}=500`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeDefined();
    expect(hTask!.amount).toBe(500);
  });
});

function createHubRoomForDistribution(t3Resources: Record<string, number>): Room {
  const storageEntries: Record<string, number> = { [RESOURCE_ENERGY]: 200000, ...t3Resources };
  return {
    name: HUB_ROOM,
    controller: { my: true, level: 8 },
    storage: {
      id: "hub-storage",
      structureType: STRUCTURE_STORAGE,
      store: {
        ...storageEntries,
        getUsedCapacity: (resource?: string) => {
          if (resource) return storageEntries[resource] || 0;
          return Object.values(storageEntries).reduce((a: number, b: number) => a + b, 0);
        },
        getFreeCapacity: () => 500000,
      },
    },
    terminal: {
      id: "hub-terminal",
      structureType: STRUCTURE_TERMINAL,
      store: {
        [RESOURCE_ENERGY]: 20000,
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300000,
        cooldown: 0,
      },
    },
    find: () => [],
  } as unknown as Room;
}

describe("planHubDistribution", () => {
  const SAT_ROOM = "W2N1";
  const XGHO2 = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;

  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("uses the shared configured receiver headroom watermarks", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    (satRoom.storage!.store as any).getFreeCapacity = () => 450_500;
    (satRoom.terminal!.store as any).getFreeCapacity = () => 60_500;
    Memory.cfg!.resourceControl = {
      capacityBalancing: {
        storagePressureFreeCapacity: 450_000,
        terminalPressureFreeCapacity: 60_000,
      },
    };
    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=500`);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: full HUB lifecycle crossing hubFlag → hubPlanner → resourceTransferTasks
// ---------------------------------------------------------------------------

const ALL_BASE_MINERALS: Record<string, number> = {
  [RESOURCE_HYDROGEN]: 20000,
  [RESOURCE_OXYGEN]: 20000,
  [RESOURCE_UTRIUM]: 10000,
  [RESOURCE_LEMERGIUM]: 10000,
  [RESOURCE_KEANIUM]: 10000,
  [RESOURCE_ZYNTHIUM]: 10000,
  [RESOURCE_CATALYST]: 10000,
};

function createIntegrationHubRoom(
  roomName: string,
  storageResources: Record<string, number>,
  options: {
    hasTerminal?: boolean;
    hasStorage?: boolean;
    labCount?: number;
    storageFreeCapacity?: number;
  } = {},
): Room {
  const {
    hasTerminal = true,
    hasStorage = true,
    labCount = 3,
    storageFreeCapacity = 500000,
  } = options;

  const storageEntries: Record<string, number> = {
    [RESOURCE_ENERGY]: 200000,
    ...storageResources,
  };

  const storage = hasStorage
    ? {
        id: `${roomName}-storage`,
        structureType: STRUCTURE_STORAGE,
        store: {
          ...storageEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return storageEntries[resource] || 0;
            return Object.values(storageEntries).reduce(
              (a: number, b: number) => a + b,
              0,
            );
          },
          getFreeCapacity: () => storageFreeCapacity,
        },
      }
    : undefined;

  const terminal = hasTerminal
    ? {
        id: `${roomName}-terminal`,
        structureType: STRUCTURE_TERMINAL,
        store: {
          [RESOURCE_ENERGY]: 20000,
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 300000,
          cooldown: 0,
        },
      }
    : undefined;

  const labs: Structure[] = [];
  for (let i = 0; i < labCount; i++) {
    labs.push({
      id: `${roomName}-lab-${i}`,
      structureType: STRUCTURE_LAB,
    } as Structure);
  }

  return {
    name: roomName,
    controller: { my: true, level: 8 },
    storage,
    terminal,
    find: (
      type: FindConstant,
      opts?: {
        filter?: ((s: Structure) => boolean) | { structureType: string };
      },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        if (!opts?.filter) return labs;
        if (typeof opts.filter === "function") return labs.filter(opts.filter);
        const targetType = (opts.filter as { structureType: string })
          .structureType;
        return labs.filter((s) => s.structureType === targetType);
      }
      return [];
    },
  } as unknown as Room;
}

function createTestFlag(roomName: string): Flag {
  return {
    name: "HUB",
    pos: { x: 25, y: 25, roomName } as RoomPosition,
    remove: jest.fn(() => OK),
  } as unknown as Flag;
}

const INTEGRATION_HUB = "W1N1";
const INTEGRATION_SAT = "W2N1";

describe("HUB lifecycle integration", () => {
  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Game.flags = {};
    Memory.cfg = {};
    Memory.runtime = {};
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  // Regression: healthy pending incoming prevents duplicate demand
  it("healthy pending Z import is counted and does not create duplicate demand", () => {
    const mineralsWithoutZ: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };

    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, mineralsWithoutZ);
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_ZYNTHIUM]: 5000,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    // Create healthy pending import of Z (no lastError)
    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_ZYNTHIUM,
      5000,
      `hub:import:${RESOURCE_ZYNTHIUM}`,
    );

    // Verify healthy import IS counted as incoming
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_ZYNTHIUM)).toBe(5000);

    runHubPlanner();

    // Hub should NOT be blocked — healthy Z import covers the deficit
    expect(Memory.runtime.hub!.status).not.toBe("blocked");
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_ZYNTHIUM);

    // Verify no duplicate Z import task was created
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const zImportTasks = tasks.filter(
      (t) => t.resource === RESOURCE_ZYNTHIUM && t.reason === `hub:import:${RESOURCE_ZYNTHIUM}`,
    );
    expect(zImportTasks).toHaveLength(1);
    expect(zImportTasks[0].amount).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// TDD: All-10 T3 reserve policy (RED phase — these tests must FAIL until implemented)
// ---------------------------------------------------------------------------

const ALL_T3_COMPOUNDS: ResourceConstant[] = [
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

describe("hub reserve floor (TDD RED)", () => {
  const HUB_ROOM_D = "WDR1";
  const SAT_ROOM_D = "WDR2";
  const XGHO2 = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;

  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM_D,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [XGHO2],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
        // hubReservePerCompound does not exist yet — this is the TDD RED state
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("hub with exactly 20000 of a T3 and empty satellite → zero export tasks", () => {
    // Hub has exactly 20000 XGHO2 — at the reserve floor, no surplus to export
    const hubStorageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      [XGHO2]: 20000,
    };
    Game.rooms[HUB_ROOM_D] = {
      name: HUB_ROOM_D,
      controller: { my: true, level: 8 },
      storage: {
        id: "hub-storage",
        structureType: STRUCTURE_STORAGE,
        store: {
          ...hubStorageEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return hubStorageEntries[resource] || 0;
            return Object.values(hubStorageEntries).reduce((a: number, b: number) => a + b, 0);
          },
          getFreeCapacity: () => 500000,
        },
      },
      terminal: {
        id: "hub-terminal",
        structureType: STRUCTURE_TERMINAL,
        store: {
          [RESOURCE_ENERGY]: 20000,
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 300000,
          cooldown: 0,
        },
      },
      find: () => [],
    } as unknown as Room;
    Game.rooms[SAT_ROOM_D] = createSatelliteRoom(SAT_ROOM_D, {});

    const actions = planHubDistribution(Memory.cfg!.hub!);

    // With 20k reserve floor, hub has 0 surplus → no export
    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason?.startsWith("hub:export:"));
    expect(task).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Distributed synthesis: multi-room fixture contract tests
// ---------------------------------------------------------------------------

function createSynthesisCapableRoom(
  roomName: string,
  options: {
    labCount?: number;
    storageResources?: Record<string, number>;
    terminalResources?: Record<string, number>;
    hasStorage?: boolean;
    hasTerminal?: boolean;
    controllerLevel?: number;
  } = {},
): Room {
  const {
    labCount = 3,
    hasStorage = true,
    hasTerminal = true,
    controllerLevel = 8,
  } = options;

  const storageEntries: Record<string, number> = {
    [RESOURCE_ENERGY]: 200000,
    ...(options.storageResources ?? {}),
  };

  const terminalEntries: Record<string, number> = {
    [RESOURCE_ENERGY]: 20000,
    ...(options.terminalResources ?? {}),
  };

  const storage = hasStorage
    ? {
        id: `${roomName}-storage`,
        structureType: STRUCTURE_STORAGE,
        store: {
          ...storageEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return storageEntries[resource] || 0;
            return Object.values(storageEntries).reduce((a: number, b: number) => a + b, 0);
          },
          getFreeCapacity: () => 500000,
        },
      }
    : undefined;

  const terminal = hasTerminal
    ? {
        id: `${roomName}-terminal`,
        structureType: STRUCTURE_TERMINAL,
        store: {
          ...terminalEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return terminalEntries[resource] || 0;
            return Object.values(terminalEntries).reduce((a: number, b: number) => a + b, 0);
          },
          getFreeCapacity: () => 300000,
          cooldown: 0,
        },
      }
    : undefined;

  const labs: Structure[] = [];
  for (let i = 0; i < labCount; i++) {
    labs.push({
      id: `${roomName}-lab-${i}`,
      structureType: STRUCTURE_LAB,
    } as Structure);
  }

  return {
    name: roomName,
    controller: { my: true, level: controllerLevel },
    storage,
    terminal,
    find: (
      type: FindConstant,
      opts?: { filter?: ((s: Structure) => boolean) | { structureType: string } },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        if (!opts?.filter) return labs;
        if (typeof opts.filter === "function") return labs.filter(opts.filter);
        const targetType = (opts.filter as { structureType: string }).structureType;
        return labs.filter((s) => s.structureType === targetType);
      }
      return [];
    },
  } as unknown as Room;
}

const DIST_HUB = "W1N1";
const DIST_AUX1 = "W2N1";
const DIST_AUX2 = "W3N1";
const DIST_PLAN_INTERVAL = 50;

describe("distributed synthesis planning", () => {
  beforeEach(() => {
    Game.time = DIST_PLAN_INTERVAL;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: DIST_HUB,
        planInterval: DIST_PLAN_INTERVAL,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        ],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        ...getDefaultHubRuntime(),
        distributedSynthesis: {
          roomCapabilities: {},
          dispatchAssignments: [],
          allocationLedger: {},
          routeDecisions: [],
          progressEdges: [],
        },
      },
    };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("distributedSynthesis runtime state initializes and round-trips through Memory", () => {
    const capabilities: Record<string, SynthesisRoomCapability> = {
      [DIST_HUB]: {
        roomName: DIST_HUB,
        labCount: 3,
        hasTerminal: true,
        hasStorage: true,
        boostLabExclusive: false,
        mineralInventory: { [RESOURCE_HYDROGEN]: 20000 },
      },
      [DIST_AUX1]: {
        roomName: DIST_AUX1,
        labCount: 3,
        hasTerminal: true,
        hasStorage: true,
        boostLabExclusive: false,
        mineralInventory: { [RESOURCE_KEANIUM]: 10000 },
      },
    };

    Memory.runtime!.hub!.distributedSynthesis = {
      roomCapabilities: capabilities,
      dispatchAssignments: [
        { roomName: DIST_HUB, product: RESOURCE_HYDROXIDE, targetAmount: 5000, isHubRoom: true },
      ],
      allocationLedger: {
        [RESOURCE_HYDROGEN]: {
          resource: RESOURCE_HYDROGEN,
          totalAmount: 20000,
          roomCommitments: { [DIST_HUB]: 20000 },
        },
      },
      routeDecisions: [],
      progressEdges: [
        {
          fromRoom: DIST_AUX1,
          toRoom: DIST_HUB,
          resource: RESOURCE_KEANIUM,
          delivered: 0,
          total: 5000,
        },
      ],
    };

    const ds = Memory.runtime!.hub!.distributedSynthesis;
    expect(Object.keys(ds!.roomCapabilities!)).toHaveLength(2);
    expect(ds!.dispatchAssignments).toHaveLength(1);
    expect(ds!.dispatchAssignments![0].isHubRoom).toBe(true);
    expect(ds!.allocationLedger![RESOURCE_HYDROGEN].totalAmount).toBe(20000);
    expect(ds!.progressEdges).toHaveLength(1);
    expect(ds!.progressEdges![0].delivered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// planDistributedSynthesis tests
// ---------------------------------------------------------------------------

const DIST_SYNTH_HUB = "DS1";
const DIST_SYNTH_AUX = "DS2";
const DIST_SYNTH_AUX2 = "DS3";

// ---------------------------------------------------------------------------
// Logistics-cost-aware dispatch scoring tests
// ---------------------------------------------------------------------------

const SCORE_HUB = "SH1";
const SCORE_AUX = "SH2";
const SCORE_AUX2 = "SH3";

describe("logistics-cost-aware dispatch scoring", () => {
  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: SCORE_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  function getHubInv(): Record<string, number> {
    const inv: Record<string, number> = {};
    const room = Game.rooms[SCORE_HUB];
    if (!room?.storage?.store || !room?.terminal?.store) return inv;
    for (const [res, amt] of Object.entries(room.storage.store as unknown as Record<string, number>)) {
      if (res !== RESOURCE_ENERGY && amt > 0) inv[res] = amt;
    }
    for (const [res, amt] of Object.entries(room.terminal.store as unknown as Record<string, number>)) {
      if (res !== RESOURCE_ENERGY && amt > 0) inv[res] = (inv[res] || 0) + amt;
    }
    return inv;
  }

  describe("wireDistributedSynthesis", () => {
    const WIRE_HUB = "W1N1";
    const WIRE_AUX = "W2N1";

    beforeEach(() => {
      Game.time = DIST_PLAN_INTERVAL;
      Game.rooms = {};
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: WIRE_HUB,
          planInterval: DIST_PLAN_INTERVAL,
          reservePerRoom: 1000,
          hubReservePerCompound: 1000,
          targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: getDefaultHubRuntime(),
      };
      Memory.data = {};
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
    });

    it("returns false (hub-only fallback) when no auxiliary rooms are eligible", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;

      const result = wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 5000, [RESOURCE_OXYGEN]: 5000 },
        [{ product: RESOURCE_HYDROXIDE, targetAmount: 1000, reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN] }],
      );

      expect(result).toBe(false);
    });

    it("stores distributed plan in runtime memory", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 10000,
          [RESOURCE_OXYGEN]: 10000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_UTRIUM]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_UTRIUM]: 5000 },
        [],
      );

      expect(Memory.runtime?.hub?.distributedSynthesis).toBeDefined();
      expect(Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments).toBeDefined();
      expect(Memory.runtime!.hub!.distributedSynthesis!.roomCapabilities).toBeDefined();
    });

    it("creates direct task when fromRoom is hub room (avoids ERR_SAME_ROOM in hub-route fallback)", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      (Game as any).market = {
        ...(Game.market || {}),
        calcTransactionCost: (amount: number, _from: string, _to: string) =>
          Math.ceil(amount * 0.01),
      };

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_HUB, toRoom: WIRE_AUX, resource: RESOURCE_KEANIUM, amount: 20000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000);

      const store = ensureResourceTransferTaskStore();
      const allTasks = Object.values(store).filter(t => t.status === "pending");
      const kTasks = allTasks.filter(t => t.resource === RESOURCE_KEANIUM);

      expect(kTasks.length).toBe(1);
      expect(kTasks[0].fromRoomName).toBe(WIRE_HUB);
      expect(kTasks[0].toRoomName).toBe(WIRE_AUX);
      expect(kTasks[0].amount).toBe(20000);
      expect(kTasks[0].reason).toBe("synthesis:direct:K");
    });
  });
});

describe("resupplyBusySynthesisRooms", () => {
  const SAT_ROOM = "W2N1";
  const HUB_ROOM_NAME = "W1N1";

  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM_NAME,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: getDefaultHubRuntime(),
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {},
      },
    } as any;
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("deduplicates with incoming transfers", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    // Already 800 U incoming to SAT_ROOM
    createResourceTransferTask("W3N1", SAT_ROOM, RESOURCE_UTRIUM, 800, "synthesis:test");

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toHaveLength(0);
  });
});
