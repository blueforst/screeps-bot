import {
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
} from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  getDefaultHubRuntime,
  planHubImports,
  runHubPlanner,
} from "@/runtime/hubPlanner";


const HUB_ROOM = "W1N1";

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


// ---------------------------------------------------------------------------
// Integration tests: full HUB lifecycle crossing hubFlag → hubPlanner → resourceTransferTasks
// ---------------------------------------------------------------------------


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
