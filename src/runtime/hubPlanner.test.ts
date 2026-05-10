import {
  getDefaultHubConfig,
  getDefaultHubRuntime,
  planHubChains,
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

describe("runHubPlanner", () => {
  const HUB_ROOM = "W1N1";
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
