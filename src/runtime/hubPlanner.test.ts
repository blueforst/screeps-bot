import {
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  getDefaultHubConfig,
  getDefaultHubRuntime,
  planHubChains,
  planHubImports,
  runHubPlanner,
} from "@/runtime/hubPlanner";

describe("hubPlanner defaults", () => {
  describe("getDefaultHubConfig", () => {
    it("resolves five war-core T3 target compounds", () => {
      const config = getDefaultHubConfig();
      expect(config.targetCompounds).toEqual([
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ]);
    });

    it("sets reservePerRoom to 1000", () => {
      const config = getDefaultHubConfig();
      expect(config.reservePerRoom).toBe(1000);
    });

    it("is disabled by default", () => {
      const config = getDefaultHubConfig();
      expect(config.enabled).toBe(false);
    });

    it("has empty hubRoomName by default", () => {
      const config = getDefaultHubConfig();
      expect(config.hubRoomName).toBe("");
    });

    it("sets internalOnly to true", () => {
      const config = getDefaultHubConfig();
      expect(config.internalOnly).toBe(true);
    });
  });

  describe("getDefaultHubRuntime", () => {
    it("starts in idle status", () => {
      const runtime = getDefaultHubRuntime();
      expect(runtime.status).toBe("idle");
    });

    it("has empty lastPlanActions", () => {
      const runtime = getDefaultHubRuntime();
      expect(runtime.lastPlanActions).toEqual([]);
    });

    it("does not need a plan initially", () => {
      const runtime = getDefaultHubRuntime();
      expect(runtime.needsPlan).toBe(false);
    });
  });
});

describe("planHubChains", () => {
  it("returns 19 steps in correct order for empty hub inventory", () => {
    const result = planHubChains({}, {}, 1000);
    expect(result.steps).toHaveLength(19);

    const products = result.steps.map((s) => s.product);
    expect(products).toEqual([
      RESOURCE_HYDROXIDE,
      RESOURCE_ZYNTHIUM_KEANITE,
      RESOURCE_UTRIUM_LEMERGITE,
      RESOURCE_GHODIUM,
      RESOURCE_UTRIUM_HYDRIDE,
      RESOURCE_UTRIUM_OXIDE,
      RESOURCE_LEMERGIUM_OXIDE,
      RESOURCE_GHODIUM_HYDRIDE,
      RESOURCE_GHODIUM_OXIDE,
      RESOURCE_UTRIUM_ACID,
      RESOURCE_UTRIUM_ALKALIDE,
      RESOURCE_LEMERGIUM_ALKALIDE,
      RESOURCE_GHODIUM_ALKALIDE,
      RESOURCE_GHODIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
      RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      RESOURCE_CATALYZED_GHODIUM_ACID,
    ]);

    const amounts = result.steps.map((s) => s.targetAmount);
    expect(amounts).toEqual([
      5000, 2000, 2000, 2000,
      1000, 1000, 1000, 1000, 1000,
      1000, 1000, 1000, 1000, 1000,
      1000, 1000, 1000, 1000, 1000,
    ]);
  });

  it("accounts for shared intermediates without duplication", () => {
    const result = planHubChains({}, {}, 1000);
    const byProduct = new Map(result.steps.map((s) => [s.product, s]));

    expect(byProduct.get(RESOURCE_HYDROXIDE)!.targetAmount).toBe(5000);
    expect(byProduct.get(RESOURCE_GHODIUM)!.targetAmount).toBe(2000);
    expect(byProduct.get(RESOURCE_ZYNTHIUM_KEANITE)!.targetAmount).toBe(2000);
    expect(byProduct.get(RESOURCE_UTRIUM_LEMERGITE)!.targetAmount).toBe(2000);
  });

  it("reduces production by reclaimed surplus from inventory and incoming", () => {
    const hubInventory: Record<string, number> = {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 600,
    };
    const incomingResources: Record<string, number> = {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 500,
    };

    const result = planHubChains(hubInventory, incomingResources, 1000);

    const byProduct = new Map(result.steps.map((s) => [s.product, s]));
    expect(byProduct.has(RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
    expect(byProduct.has(RESOURCE_UTRIUM_ACID)).toBe(false);
    expect(byProduct.has(RESOURCE_UTRIUM_HYDRIDE)).toBe(false);

    expect(byProduct.get(RESOURCE_HYDROXIDE)!.targetAmount).toBe(4000);
  });

  it("reports blocked with missing base minerals when insufficient", () => {
    const partialInventory: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };

    const result = planHubChains(partialInventory, {}, 1000);
    expect(result.blocked).toBe(true);
    expect(result.missingResources).toContain(RESOURCE_KEANIUM);
    expect(result.missingResources).toContain(RESOURCE_ZYNTHIUM);
    expect(result.missingResources).not.toContain(RESOURCE_HYDROGEN);
    expect(result.missingResources).not.toContain(RESOURCE_OXYGEN);
    expect(result.missingResources).not.toContain(RESOURCE_UTRIUM);
    expect(result.missingResources).not.toContain(RESOURCE_LEMERGIUM);
    expect(result.missingResources).not.toContain(RESOURCE_CATALYST);
  });
});

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

describe("runHubPlanner", () => {
  const PLAN_INTERVAL = 50;

  beforeEach(() => {
    Game.time = 1;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: PLAN_INTERVAL,
        reservePerRoom: 1000,
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

  it("no-ops when hub disabled", () => {
    Memory.cfg!.hub!.enabled = false;
    const beforeStatus = Memory.runtime.hub.status;
    runHubPlanner();
    expect(Memory.runtime.hub.status).toBe(beforeStatus);
    expect(Memory.runtime.hub.updatedAt).toBe(0);
  });

  it("no-ops when off cadence and needsPlan=false", () => {
    Game.time = 7;
    Memory.runtime.hub.needsPlan = false;
    const beforeUpdatedAt = Memory.runtime.hub.updatedAt;
    runHubPlanner();
    expect(Memory.runtime.hub.updatedAt).toBe(beforeUpdatedAt);
  });

  it("runs on cadence (Game.time % planInterval === 0)", () => {
    Game.time = PLAN_INTERVAL;
    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 3 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();
    expect(Memory.runtime.hub.updatedAt).toBe(Game.time);
    expect(Memory.runtime.hub.needsPlan).toBe(false);
  });

  it("runs when needsPlan=true regardless of cadence", () => {
    Game.time = 7;
    Memory.runtime.hub.needsPlan = true;
    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 3 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();
    expect(Memory.runtime.hub.updatedAt).toBe(Game.time);
    expect(Memory.runtime.hub.needsPlan).toBe(false);
  });

  it("is blocked when hub room has no terminal", () => {
    Game.time = PLAN_INTERVAL;
    const room = createHubRoom({ hasStorage: true, hasTerminal: false, labCount: 3 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();
    expect(Memory.runtime.hub.status).toBe("blocked");
  });

  it("is blocked when hub room has no storage", () => {
    Game.time = PLAN_INTERVAL;
    const room = createHubRoom({ hasStorage: false, hasTerminal: true, labCount: 3 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();
    expect(Memory.runtime.hub.status).toBe("blocked");
  });

  it("is blocked when hub room has fewer than 3 labs", () => {
    Game.time = PLAN_INTERVAL;
    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 2 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();
    expect(Memory.runtime.hub.status).toBe("blocked");
  });

  it("successful plan clears needsPlan and sets updatedAt", () => {
    Game.time = PLAN_INTERVAL;
    Memory.runtime.hub.needsPlan = true;
    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 3 });
    const mineralStore = (room.storage!.store as unknown as Record<string, number>);
    mineralStore[RESOURCE_HYDROGEN] = 10000;
    mineralStore[RESOURCE_OXYGEN] = 10000;
    mineralStore[RESOURCE_UTRIUM] = 10000;
    mineralStore[RESOURCE_LEMERGIUM] = 10000;
    mineralStore[RESOURCE_KEANIUM] = 10000;
    mineralStore[RESOURCE_ZYNTHIUM] = 10000;
    mineralStore[RESOURCE_CATALYST] = 10000;
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();
    expect(Memory.runtime.hub.needsPlan).toBe(false);
    expect(Memory.runtime.hub.updatedAt).toBe(PLAN_INTERVAL);
    expect(Memory.runtime.hub.status).not.toBe("blocked");
    expect(Memory.runtime.hub.status).not.toBe("idle");
    if (Memory.runtime.hub.activeProduct) {
      expect(typeof Memory.runtime.hub.activeProduct).toBe("string");
      expect(Memory.runtime.hub.activeProduct.length).toBeGreaterThan(0);
    }
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

  it("creates base mineral import from satellite with surplus H above safety floor", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROGEN]: 1000 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContainEqual(`import:${SAT_ROOM}:${RESOURCE_HYDROGEN}=500`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeDefined();
    expect(hTask!.fromRoomName).toBe(SAT_ROOM);
    expect(hTask!.toRoomName).toBe(HUB_ROOM);
    expect(hTask!.amount).toBe(500);
  });

  it("does not create base mineral import when satellite has only 500 H (at safety floor)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROGEN]: 500 });
    planHubImports(Memory.cfg!.hub!);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeUndefined();
  });

  it("creates intermediate import task for satellite with surplus OH", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROXIDE]: 100 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContainEqual(`import:${SAT_ROOM}:${RESOURCE_HYDROXIDE}=100`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROXIDE && t.reason === `hub:import:${RESOURCE_HYDROXIDE}`,
    );
    expect(ohTask).toBeDefined();
    expect(ohTask!.amount).toBe(100);
  });

  it("creates surplus T3 reclaim task when satellite has 1501 XGHO2", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1501,
    });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContainEqual(
      `reclaim:${SAT_ROOM}:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}=501`,
    );
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(
      (t) =>
        t.resource === RESOURCE_CATALYZED_GHODIUM_ALKALIDE &&
        t.reason === `hub:reclaim:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    expect(t3Task).toBeDefined();
    expect(t3Task!.amount).toBe(501);
  });

  it("does not create reclaim task when satellite has exactly 1000 XGHO2 (at reserve)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
    });
    planHubImports(Memory.cfg!.hub!);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(
      (t) =>
        t.resource === RESOURCE_CATALYZED_GHODIUM_ALKALIDE &&
        t.reason === `hub:reclaim:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    expect(t3Task).toBeUndefined();
  });

  it("does not create tasks when hub storage free capacity is below threshold", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports(50000);
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 1000,
      [RESOURCE_HYDROXIDE]: 100,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 2000,
    });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    expect(Object.keys(tasks)).toHaveLength(0);
  });

  it("does not create tasks from survival-economy rooms", () => {
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
    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    expect(Object.keys(tasks)).toHaveLength(0);
  });

  it("does not create duplicate tasks when existing hub:import task already exists", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    createResourceTransferTask(
      SAT_ROOM,
      HUB_ROOM,
      RESOURCE_HYDROGEN,
      200,
      `hub:import:${RESOURCE_HYDROGEN}`,
    );
    const tasksBefore = Object.values(ensureResourceTransferTaskStore());
    const hTaskBefore = tasksBefore.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTaskBefore).toBeDefined();
    expect(hTaskBefore!.amount).toBe(200);
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toHaveLength(0);
    const tasksAfter = Object.values(ensureResourceTransferTaskStore());
    const hTaskAfter = tasksAfter.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTaskAfter!.amount).toBe(200);
  });
});

describe("writeSynthesisConfig", () => {
  const PLAN_INTERVAL = 50;

  function setupHubRoomForSynthesis(
    storageResources: Record<string, number>,
    terminalResources: Record<string, number> = {},
  ): void {
    const storageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      ...storageResources,
    };
    const terminalEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 20000,
      ...terminalResources,
    };

    const storage = {
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
    };

    const terminal = {
      id: "hub-terminal",
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

    const labCount = 3;
    const labs: Structure[] = [];
    for (let i = 0; i < labCount; i++) {
      labs.push({
        id: `hub-lab-${i}`,
        structureType: STRUCTURE_LAB,
      } as Structure);
    }

    const room = {
      name: HUB_ROOM,
      controller: { my: true, level: 8 },
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

    Game.rooms[HUB_ROOM] = room;
  }

  beforeEach(() => {
    Game.time = PLAN_INTERVAL;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: PLAN_INTERVAL,
        reservePerRoom: 1000,
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

  it("writes first reaction (OH) when hub inventory is empty", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    });

    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("importing");
    expect(Memory.runtime.hub.activeProduct).toBe(RESOURCE_HYDROXIDE);
    expect(Memory.runtime.hub.activeStep).toBe(0);

    expect(Memory.cfg.synthesisControl).toBeDefined();
    expect(Memory.cfg.synthesisControl!.enabled).toBe(true);
    const roomCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(roomCfg).toBeDefined();
    expect(roomCfg.enabled).toBe(true);
    expect(roomCfg.reactions).toBeDefined();
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_HYDROXIDE);
    expect(roomCfg.reactions![0].targetAmount).toBe(5000);
  });

  it("advances to next step (ZK) when hub has 5000 OH", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
      [RESOURCE_HYDROXIDE]: 5000,
    });

    runHubPlanner();

    expect(Memory.runtime.hub.activeProduct).toBe(RESOURCE_ZYNTHIUM_KEANITE);
    expect(Memory.runtime.hub.activeStep).toBe(0);

    const roomCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
    expect(roomCfg.reactions![0].targetAmount).toBe(2000);
  });

  it("preserves existing reagentLabIds in synthesisControl config", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    });

    Memory.cfg.synthesisControl = {
      enabled: true,
      sampleInterval: 5,
      defaultBatchSize: 100,
      defaultMaxRunsPerTick: 3,
      rooms: {
        [HUB_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-a", "lab-b"],
          donorRoomNames: [],
          reactions: [],
        },
      },
    };

    runHubPlanner();

    const roomCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(roomCfg.reagentLabIds).toEqual(["lab-a", "lab-b"]);
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_HYDROXIDE);
    expect(Memory.cfg.synthesisControl!.sampleInterval).toBe(5);
    expect(Memory.cfg.synthesisControl!.defaultBatchSize).toBe(100);
    expect(Memory.cfg.synthesisControl!.defaultMaxRunsPerTick).toBe(3);
  });

  it("sets status to 'acquiring' when imports are pending but reagents not yet available", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    });

    createResourceTransferTask("W2N1", HUB_ROOM, RESOURCE_HYDROGEN, 500, "hub:import:H");

    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("importing");
    expect(Memory.cfg.synthesisControl!.rooms![HUB_ROOM].reactions).toHaveLength(1);
  });

  it("sets status to 'blocked' when no internal source can satisfy reagents", () => {
    setupHubRoomForSynthesis({});

    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("blocked");
    expect(Memory.runtime.hub.missingResources!.length).toBeGreaterThan(0);
    const roomCfg = Memory.cfg.synthesisControl?.rooms?.[HUB_ROOM];
    expect(roomCfg?.reactions).toBeFalsy();
  });

  it("sets status to 'distributing' when all chain steps are complete", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
      [RESOURCE_HYDROXIDE]: 5000,
      [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
      [RESOURCE_UTRIUM_LEMERGITE]: 2000,
      [RESOURCE_GHODIUM]: 2000,
      [RESOURCE_UTRIUM_HYDRIDE]: 1000,
      [RESOURCE_UTRIUM_OXIDE]: 1000,
      [RESOURCE_LEMERGIUM_OXIDE]: 1000,
      [RESOURCE_GHODIUM_HYDRIDE]: 1000,
      [RESOURCE_GHODIUM_OXIDE]: 1000,
      [RESOURCE_UTRIUM_ACID]: 1000,
      [RESOURCE_UTRIUM_ALKALIDE]: 1000,
      [RESOURCE_LEMERGIUM_ALKALIDE]: 1000,
      [RESOURCE_GHODIUM_ALKALIDE]: 1000,
      [RESOURCE_GHODIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_GHODIUM_ACID]: 1000,
    });

    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("distributing");
    expect(Memory.runtime.hub.activeProduct).toBe("");
    expect(Memory.runtime.hub.activeStep).toBe(0);

    const roomCfg = Memory.cfg.synthesisControl?.rooms?.[HUB_ROOM];
    expect(roomCfg?.reactions).toBeFalsy();
  });
});
