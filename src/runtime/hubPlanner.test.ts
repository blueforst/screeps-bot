import {
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
} from "@/runtime/logistics/resourceTransferTasks";
import { runHubByFlag } from "@/runtime/hubFlag";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  clearHubSynthesisReactions,
  getDefaultHubConfig,
  getDefaultHubRuntime,
  planHubChains,
  planHubDistribution,
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

  it("clears hub room reactions when blocked by missing terminal", () => {
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [HUB_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-a", "lab-b"],
          donorRoomNames: [],
          reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, donorRoomNames: [] }],
        },
        [OTHER_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-c"],
          donorRoomNames: [],
          reactions: [{ product: RESOURCE_ZYNTHIUM_KEANITE, targetAmount: 2000, donorRoomNames: [] }],
        },
      },
    };

    const room = createHubRoom({ hasStorage: true, hasTerminal: false, labCount: 3 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("blocked");
    const hubCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(hubCfg.reactions).toEqual([]);
    expect(hubCfg.reagentLabIds).toEqual(["lab-a", "lab-b"]);
    const otherCfg = Memory.cfg.synthesisControl!.rooms![OTHER_ROOM];
    expect(otherCfg.reactions).toHaveLength(1);
    expect(otherCfg.reactions![0].product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
  });

  it("clears hub room reactions when blocked by missing labs", () => {
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [HUB_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-a", "lab-b"],
          donorRoomNames: [],
          reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, donorRoomNames: [] }],
        },
      },
    };

    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 2 });
    Game.rooms[HUB_ROOM] = room;
    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("blocked");
    const hubCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(hubCfg.reactions).toEqual([]);
    expect(hubCfg.reagentLabIds).toEqual(["lab-a", "lab-b"]);
  });

  it("clears hub room reactions when hub is disabled", () => {
    Memory.cfg!.hub!.enabled = false;
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [HUB_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-a", "lab-b"],
          donorRoomNames: [],
          reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, donorRoomNames: [] }],
        },
      },
    };

    runHubPlanner();

    const hubCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(hubCfg.reactions).toEqual([]);
    expect(hubCfg.reagentLabIds).toEqual(["lab-a", "lab-b"]);
  });

  it("preserves lab IDs and other room config after clearing reactions", () => {
    Memory.cfg!.synthesisControl = {
      enabled: true,
      sampleInterval: 5,
      rooms: {
        [HUB_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-x", "lab-y"],
          donorRoomNames: ["W3N1"],
          reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 1000, donorRoomNames: [] }],
        },
      },
    };

    clearHubSynthesisReactions(HUB_ROOM);

    const hubCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(hubCfg.reactions).toEqual([]);
    expect(hubCfg.reagentLabIds).toEqual(["lab-x", "lab-y"]);
    expect(hubCfg.donorRoomNames).toEqual(["W3N1"]);
    expect(hubCfg.enabled).toBe(true);
    expect(Memory.cfg.synthesisControl!.sampleInterval).toBe(5);
  });

  it("does not affect non-hub rooms' synthesis config", () => {
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [HUB_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-a"],
          donorRoomNames: [],
          reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, donorRoomNames: [] }],
        },
        [OTHER_ROOM]: {
          enabled: true,
          reagentLabIds: ["lab-c"],
          donorRoomNames: [],
          reactions: [{ product: RESOURCE_ZYNTHIUM_KEANITE, targetAmount: 2000, donorRoomNames: [] }],
        },
      },
    };

    clearHubSynthesisReactions(HUB_ROOM);

    const hubCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(hubCfg.reactions).toEqual([]);
    const otherCfg = Memory.cfg.synthesisControl!.rooms![OTHER_ROOM];
    expect(otherCfg.reactions).toHaveLength(1);
    expect(otherCfg.reactions![0].product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
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

  it("skips base mineral import when send amount is below minimum threshold", () => {
    // 50 H above safety floor: 550 total - 500 floor = 50, which is < 100 minimum
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROGEN]: 550 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).not.toContainEqual(expect.stringContaining(`import:${SAT_ROOM}:${RESOURCE_HYDROGEN}`));
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeUndefined();
  });

  it("skips intermediate import when amount is below minimum threshold", () => {
    // 80 OH is below MIN_HUB_IMPORT_AMOUNT (100)
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROXIDE]: 80 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).not.toContainEqual(expect.stringContaining(`import:${SAT_ROOM}:${RESOURCE_HYDROXIDE}`));
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROXIDE && t.reason === `hub:import:${RESOURCE_HYDROXIDE}`,
    );
    expect(ohTask).toBeUndefined();
  });

  it("creates intermediate import task when amount meets minimum threshold", () => {
    // 150 OH is above MIN_HUB_IMPORT_AMOUNT (100)
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROXIDE]: 150 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContainEqual(`import:${SAT_ROOM}:${RESOURCE_HYDROXIDE}=150`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROXIDE && t.reason === `hub:import:${RESOURCE_HYDROXIDE}`,
    );
    expect(ohTask).toBeDefined();
    expect(ohTask!.amount).toBe(150);
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

  it("satellite with 250 XGHO2 receives task for 750 from hub", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=750`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason === `hub:export:${XGHO2}`);
    expect(task).toBeDefined();
    expect(task!.fromRoomName).toBe(HUB_ROOM);
    expect(task!.toRoomName).toBe(SAT_ROOM);
    expect(task!.amount).toBe(750);
  });

  it("satellite with 1000 XGHO2 receives no task", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 1000 });

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason?.startsWith("hub:export:"));
    expect(task).toBeUndefined();
  });

  it("hub room is excluded from distribution even if below reserve", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    // No satellite rooms exist — hub is the only owned room

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toHaveLength(0);
  });

  it("destination terminal capacity caps transfer amount", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    (satRoom.terminal!.store as any).getFreeCapacity = () => 100;

    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    // Shortage is 750, hub has 5000, but terminal free capacity is 100
    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=100`);
  });

  it("no export task when hub has 0 of the T3 compound", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({}); // No T3 in hub
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toHaveLength(0);
  });

  it("pending incoming amounts are counted (don't over-send)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });

    // Existing pending export: hub → satellite, 500 XGHO2
    createResourceTransferTask(HUB_ROOM, SAT_ROOM, XGHO2, 500, `hub:export:${XGHO2}`);

    const actions = planHubDistribution(Memory.cfg!.hub!);

    // Satellite has 250, pending 500 incoming → effective 750. Need 250 more.
    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=250`);

    // Verify the task was merged (total 500 + 250 = 750)
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason === `hub:export:${XGHO2}`);
    expect(task).toBeDefined();
    expect(task!.amount).toBe(750);
  });

  it("creates export task when satellite storage is full but terminal has free capacity", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    // Storage full, terminal has 15000 free (passes combined gate of 10000)
    (satRoom.storage!.store as any).getFreeCapacity = () => 0;
    (satRoom.terminal!.store as any).getFreeCapacity = () => 15000;

    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    // Shortage is 750, hub has 5000, terminal free is 15000 → capped by shortage (750)
    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=750`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason === `hub:export:${XGHO2}`);
    expect(task).toBeDefined();
    expect(task!.amount).toBe(750);
  });

  it("creates no export task when both satellite storage and terminal are full", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    // Both full
    (satRoom.storage!.store as any).getFreeCapacity = () => 0;
    (satRoom.terminal!.store as any).getFreeCapacity = () => 0;

    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason?.startsWith("hub:export:"));
    expect(task).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: full HUB lifecycle crossing hubFlag → hubPlanner → resourceTransferTasks
// ---------------------------------------------------------------------------

const ALL_BASE_MINERALS: Record<string, number> = {
  [RESOURCE_HYDROGEN]: 10000,
  [RESOURCE_OXYGEN]: 10000,
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

  // 1. Full lifecycle: flag → config → needsPlan → planner writes OH reaction
  it("flag placement → config written → planner writes first OH reaction", () => {
    const hubRoom = createIntegrationHubRoom(INTEGRATION_HUB, ALL_BASE_MINERALS);
    Game.rooms[INTEGRATION_HUB] = hubRoom;
    const flag = createTestFlag(INTEGRATION_HUB);
    Game.flags["HUB"] = flag;

    // Tick A: flag processing
    runHubByFlag();

    expect(flag.remove).toHaveBeenCalledTimes(1);
    expect(Memory.cfg.hub).toBeDefined();
    expect(Memory.cfg.hub!.enabled).toBe(true);
    expect(Memory.cfg.hub!.hubRoomName).toBe(INTEGRATION_HUB);
    expect(Memory.runtime.hub).toBeDefined();
    expect(Memory.runtime.hub!.needsPlan).toBe(true);

    // Tick B: planner picks up needsPlan
    runHubPlanner();

    expect(Memory.runtime.hub!.needsPlan).toBe(false);
    expect(Memory.runtime.hub!.updatedAt).toBe(Game.time);
    expect(Memory.runtime.hub!.status).toBe("importing");
    expect(Memory.runtime.hub!.activeProduct).toBe(RESOURCE_HYDROXIDE);

    // synthesisControl written
    expect(Memory.cfg.synthesisControl).toBeDefined();
    expect(Memory.cfg.synthesisControl!.enabled).toBe(true);
    const roomCfg = Memory.cfg.synthesisControl!.rooms![INTEGRATION_HUB];
    expect(roomCfg).toBeDefined();
    expect(roomCfg.enabled).toBe(true);
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_HYDROXIDE);
    expect(roomCfg.reactions![0].targetAmount).toBe(5000);
  });

  // 2. Full lifecycle: OH → ZK stage advancement when OH complete
  it("advances from OH to ZK when OH target is met", () => {
    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, {
      ...ALL_BASE_MINERALS,
      [RESOURCE_HYDROXIDE]: 5000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    runHubPlanner();

    expect(Memory.runtime.hub!.status).toBe("importing");
    expect(Memory.runtime.hub!.activeProduct).toBe(RESOURCE_ZYNTHIUM_KEANITE);

    const roomCfg = Memory.cfg.synthesisControl!.rooms![INTEGRATION_HUB];
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
    expect(roomCfg.reactions![0].targetAmount).toBe(2000);
  });

  // 3. Full lifecycle: T3 production complete → hub:export task created
  it("creates hub:export task when T3 stock exists and satellite needs compound", () => {
    const ALL_COMPLETE: Record<string, number> = {
      ...ALL_BASE_MINERALS,
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
    };

    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(
      INTEGRATION_HUB,
      ALL_COMPLETE,
    );
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {});

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    runHubPlanner();

    // All chains met → distributing
    expect(Memory.runtime.hub!.status).toBe("distributing");
    expect(Memory.runtime.hub!.activeProduct).toBe("");

    // Export task created for satellite
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const exportTask = tasks.find((t) => t.reason?.startsWith("hub:export:"));
    expect(exportTask).toBeDefined();
    expect(exportTask!.fromRoomName).toBe(INTEGRATION_HUB);
    expect(exportTask!.toRoomName).toBe(INTEGRATION_SAT);
    expect(exportTask!.resource).toBe(RESOURCE_CATALYZED_UTRIUM_ACID);
    expect(exportTask!.amount).toBe(1000);
  });

  // 4. No terminal → blocked safely (flag → planner integration)
  it("blocks when hub room has no terminal", () => {
    const hubRoom = createIntegrationHubRoom(INTEGRATION_HUB, ALL_BASE_MINERALS, {
      hasTerminal: false,
    });
    Game.rooms[INTEGRATION_HUB] = hubRoom;
    const flag = createTestFlag(INTEGRATION_HUB);
    Game.flags["HUB"] = flag;

    runHubByFlag();
    expect(Memory.cfg.hub!.enabled).toBe(true);

    runHubPlanner();
    expect(Memory.runtime.hub!.status).toBe("blocked");
    expect(Memory.runtime.hub!.needsPlan).toBe(true);
    expect(Memory.cfg.synthesisControl?.rooms?.[INTEGRATION_HUB]?.reactions).toBeFalsy();
  });

  // 5. <3 labs → blocked safely (flag → planner integration)
  it("blocks when hub room has fewer than 3 labs", () => {
    const hubRoom = createIntegrationHubRoom(INTEGRATION_HUB, ALL_BASE_MINERALS, {
      labCount: 2,
    });
    Game.rooms[INTEGRATION_HUB] = hubRoom;
    const flag = createTestFlag(INTEGRATION_HUB);
    Game.flags["HUB"] = flag;

    runHubByFlag();
    expect(Memory.cfg.hub!.enabled).toBe(true);

    runHubPlanner();
    expect(Memory.runtime.hub!.status).toBe("blocked");
    expect(Memory.runtime.hub!.needsPlan).toBe(true);
    expect(Memory.cfg.synthesisControl?.rooms?.[INTEGRATION_HUB]?.reactions).toBeFalsy();
  });

  // 6. Missing base minerals → blocked with exact missing list
  it("blocks with exact missing minerals list when base minerals absent", () => {
    const partialMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    const hubRoom = createIntegrationHubRoom(INTEGRATION_HUB, partialMinerals);
    Game.rooms[INTEGRATION_HUB] = hubRoom;
    const flag = createTestFlag(INTEGRATION_HUB);
    Game.flags["HUB"] = flag;

    runHubByFlag();
    expect(Memory.cfg.hub!.enabled).toBe(true);

    runHubPlanner();
    expect(Memory.runtime.hub!.status).toBe("blocked");
    expect(Memory.runtime.hub!.missingResources).toEqual(
      expect.arrayContaining([RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM]),
    );
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_HYDROGEN);
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_OXYGEN);
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_UTRIUM);
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_LEMERGIUM);
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_CATALYST);
    // No synthesis config written when blocked
    expect(
      Memory.cfg.synthesisControl?.rooms?.[INTEGRATION_HUB]?.reactions,
    ).toBeFalsy();
  });

  // 7. Near-full storage prevents import tasks from satellite
  it("does not create import tasks when hub storage is near full", () => {
    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(
      INTEGRATION_HUB,
      ALL_BASE_MINERALS,
      { storageFreeCapacity: 50000 },
    );
    // Satellite with surplus hydrogen
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_HYDROGEN]: 2000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    runHubPlanner();

    // Planner should run (not blocked by minerals)
    expect(Memory.runtime.hub!.status).not.toBe("blocked");
    // But no import tasks because hub storage free capacity < threshold
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const importTask = tasks.find((t) => t.reason?.startsWith("hub:import:"));
    expect(importTask).toBeUndefined();
  });

  it("pending hub:import:Z reduces chain demand for zynthium", () => {
    const partialMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, partialMinerals);
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_ZYNTHIUM]: 5000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    // Create pending import of Z from satellite to hub
    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_ZYNTHIUM,
      3000,
      `hub:import:${RESOURCE_ZYNTHIUM}`,
    );

    // Also import K to unblock chains
    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_KEANIUM,
      3000,
      `hub:import:${RESOURCE_KEANIUM}`,
    );

    // Verify incoming amounts are tracked
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_ZYNTHIUM)).toBe(3000);
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_KEANIUM)).toBe(3000);

    runHubPlanner();

    // With pending Z and K imports, chains should be unblocked
    expect(Memory.runtime.hub!.status).not.toBe("blocked");
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_ZYNTHIUM);
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_KEANIUM);
  });

  it("creates hub:export:XGHO2 when chains blocked but hub has T3 stock", () => {
    const partialMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 10000,
      [RESOURCE_OXYGEN]: 10000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    const XGHO2 = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;

    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, {
      ...partialMinerals,
      [XGHO2]: 5000,
    });
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {});

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [XGHO2],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    runHubPlanner();

    // Chains are blocked by missing K and Z
    expect(Memory.runtime.hub!.status).toBe("blocked");
    expect(Memory.runtime.hub!.missingResources).toEqual(
      expect.arrayContaining([RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM]),
    );

    // But distribution still runs — hub has 5000 XGHO2, satellite has 0
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const exportTask = tasks.find(
      (t) => t.resource === XGHO2 && t.reason === `hub:export:${XGHO2}`,
    );
    expect(exportTask).toBeDefined();
    expect(exportTask!.fromRoomName).toBe(INTEGRATION_HUB);
    expect(exportTask!.toRoomName).toBe(INTEGRATION_SAT);
    expect(exportTask!.amount).toBe(1000);
  });
});
