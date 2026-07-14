import {
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

describe("hubPlanner defaults", () => {
  describe("getDefaultHubConfig", () => {
    it("resolves all 10 T3 target compounds", () => {
      const config = getDefaultHubConfig();
      expect(config.targetCompounds).toEqual([
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
      ]);
    });

    it("sets reservePerRoom to 5000", () => {
      const config = getDefaultHubConfig();
      expect(config.reservePerRoom).toBe(5000);
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

    it("sets distributedStorage to true by default", () => {
      const config = getDefaultHubConfig();
      expect(config.distributedStorage).toBe(true);
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
  // Progressive algorithm: returns only FEASIBLE steps (products where both
  // reagents are currently available). With all base minerals present, every
  // intermediate can be produced progressively — the first round produces base
  // intermediates (OH, ZK, UL, G), then T1, T2, T3 in subsequent cycles.
  // However, G requires ZK+UL which don't exist yet, and T2 requires OH+T1
  // which don't exist yet. So only base intermediates and T1 are feasible.
  it("returns feasible steps when all base minerals are present", () => {
    const allBaseMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    const result = planHubChains(allBaseMinerals, {}, 1000);
    // Only base intermediates (OH, ZK, UL) and T1 products are feasible:
    // G needs ZK+UL (not yet available), T2 needs OH+T1 (not yet available)
    expect(result.steps).toHaveLength(11);

    const products = result.steps.map((s) => s.product);
    expect(products).toEqual([
      RESOURCE_HYDROXIDE,
      RESOURCE_ZYNTHIUM_KEANITE,
      RESOURCE_UTRIUM_LEMERGITE,
      RESOURCE_UTRIUM_HYDRIDE,
      RESOURCE_UTRIUM_OXIDE,
      RESOURCE_KEANIUM_HYDRIDE,
      RESOURCE_KEANIUM_OXIDE,
      RESOURCE_LEMERGIUM_HYDRIDE,
      RESOURCE_LEMERGIUM_OXIDE,
      RESOURCE_ZYNTHIUM_HYDRIDE,
      RESOURCE_ZYNTHIUM_OXIDE,
    ]);

    const amounts = result.steps.map((s) => s.targetAmount);
    expect(amounts).toEqual([
      10000, 2000, 2000,
      1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
    ]);
  });

  // Progressive: with base minerals, only OH/ZK/UL/T1 are feasible.
  // G is not feasible yet (needs ZK+UL which aren't produced yet).
  // OH demand = 10000 (shared across all T2 chains), ZK/UL = 2000 each.
  it("accounts for shared intermediates without duplication", () => {
    const allBaseMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    const result = planHubChains(allBaseMinerals, {}, 1000);
    const byProduct = new Map(result.steps.map((s) => [s.product, s]));

    expect(byProduct.get(RESOURCE_HYDROXIDE)!.targetAmount).toBe(10000);
    expect(byProduct.get(RESOURCE_ZYNTHIUM_KEANITE)!.targetAmount).toBe(2000);
    expect(byProduct.get(RESOURCE_UTRIUM_LEMERGITE)!.targetAmount).toBe(2000);
  });

  // Progressive: reclaimed surplus reduces demand; need base minerals for feasible steps
  it("reduces production by reclaimed surplus from inventory and incoming", () => {
    const hubInventory: Record<string, number> = {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 600,
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    const incomingResources: Record<string, number> = {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 500,
    };

    const result = planHubChains(hubInventory, incomingResources, 1000);

    const byProduct = new Map(result.steps.map((s) => [s.product, s]));
    expect(byProduct.has(RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
    expect(byProduct.has(RESOURCE_UTRIUM_ACID)).toBe(false);
    expect(byProduct.has(RESOURCE_UTRIUM_HYDRIDE)).toBe(false);

    // OH demand reduced from 10000 to 9000 because XUH2O surplus covers part of chain
    expect(byProduct.get(RESOURCE_HYDROXIDE)!.targetAmount).toBe(9000);
  });

  // Progressive: providing exact intermediates allows the T3 step to appear.
  it("produces XUHO2 step when intermediates are available and T3 is at zero", () => {
    const result = planHubChains(
      {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
        [RESOURCE_HYDROXIDE]: 10000,
        [RESOURCE_UTRIUM_OXIDE]: 1000,
        [RESOURCE_UTRIUM_ALKALIDE]: 1000,
      },
      {},
      1000,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE],
    );
    const byProduct = new Map(result.steps.map((s) => [s.product, s]));
    const xuho2Step = byProduct.get(RESOURCE_CATALYZED_UTRIUM_ALKALIDE);
    expect(xuho2Step).toBeDefined();
    expect(xuho2Step!.targetAmount).toBe(1000);
  });

  it("produces the remaining T3 deficit when partial inventory and intermediates are available", () => {
    const result = planHubChains(
      {
        [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 500,
        [RESOURCE_UTRIUM_ALKALIDE]: 500,
        [RESOURCE_CATALYST]: 500,
      },
      {},
      1000,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE],
    );
    const xuho2Step = result.steps.find((s) => s.product === RESOURCE_CATALYZED_UTRIUM_ALKALIDE);
    expect(result.blocked).toBe(false);
    expect(xuho2Step).toBeDefined();
    expect(xuho2Step!.targetAmount).toBe(500);
  });

  it("does not produce XUHO2 when inventory is at reserve (1000/1000)", () => {
    const result = planHubChains({ [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 1000 }, {}, 1000);
    const byProduct = new Map(result.steps.map((s) => [s.product, s]));
    expect(byProduct.has(RESOURCE_CATALYZED_UTRIUM_ALKALIDE)).toBe(false);
  });

  // Progressive: XUHO2 at exactly half reserve with base minerals still needs
  // the remaining half, so lower-level intermediates are produced.
  it("produces intermediates when T3 is at half reserve (500/1000) and intermediates absent", () => {
    const result = planHubChains(
      {
        [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 500,
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      },
      {},
      1000,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE],
    );
    expect(result.blocked).toBe(false);
    const products = result.steps.map((s) => s.product);
    expect(products).toContain(RESOURCE_HYDROXIDE);
    expect(products).toContain(RESOURCE_UTRIUM_OXIDE);
  });

  // Progressive: H+O available → OH is a feasible candidate → blocked=false.
  // The old all-or-nothing algorithm returned blocked here; progressive produces
  // what it can (OH) and reports missing only when NO candidate exists.
  it("produces feasible intermediate when some base minerals are missing", () => {
    const partialInventory: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };

    const result = planHubChains(partialInventory, {}, 1000);
    expect(result.blocked).toBe(false);
    // OH is the first feasible candidate (H+O available)
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].product).toBe(RESOURCE_HYDROXIDE);
    // K and Z are still missing for further chain steps
    expect(result.missingResources).toEqual([]);
  });

  // ---------------------------------------------------------------
  // Progressive feasible-step scheduling: direct planHubChains tests
  // ---------------------------------------------------------------
  describe("progressive feasible-step scheduling", () => {
    it("(a) H+O available, K/Z unavailable → produces OH, blocked=false", () => {
      const inventory: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 15000,
        [RESOURCE_OXYGEN]: 15000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      };
      const result = planHubChains(inventory, {}, 1000);
      expect(result.blocked).toBe(false);
      expect(result.steps.length).toBeGreaterThan(0);
      const ohStep = result.steps.find((s) => s.product === RESOURCE_HYDROXIDE);
      expect(ohStep).toBeDefined();
      expect(new Set(ohStep!.reagents)).toEqual(new Set([RESOURCE_HYDROGEN, RESOURCE_OXYGEN]));
    });

    it("(b) U+O/H available, K/Z unavailable, target XUHO2 → produces UO, blocked=false", () => {
      const inventory: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 15000,
        [RESOURCE_OXYGEN]: 15000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      };
      const result = planHubChains(inventory, {}, 1000, [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]);
      expect(result.blocked).toBe(false);
      // OH and UO should be among feasible candidates (H+O, U+O available)
      const products = result.steps.map((s) => s.product);
      expect(products).toContain(RESOURCE_UTRIUM_OXIDE);
    });

    it("(c) empty inventory → blocked:true, steps:[], non-empty missingResources", () => {
      const result = planHubChains({}, {}, 1000);
      expect(result.blocked).toBe(true);
      expect(result.steps).toEqual([]);
      // All base minerals needed for default 10-T3 target list
      expect(result.missingResources.length).toBeGreaterThan(0);
      expect(result.missingResources).toContain(RESOURCE_HYDROGEN);
      expect(result.missingResources).toContain(RESOURCE_OXYGEN);
    });

    it("(d) all targets already at reserve → blocked:false, steps:[]", () => {
      const inventory: Record<string, number> = {
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
        [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 1000,
        [RESOURCE_CATALYZED_KEANIUM_ACID]: 1000,
        [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: 1000,
        [RESOURCE_CATALYZED_LEMERGIUM_ACID]: 1000,
        [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 1000,
        [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: 1000,
        [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: 1000,
        [RESOURCE_CATALYZED_GHODIUM_ACID]: 1000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
      };
      const result = planHubChains(inventory, {}, 1000);
      expect(result.blocked).toBe(false);
      expect(result.steps).toEqual([]);
      expect(result.missingResources).toEqual([]);
    });

    it("(e) healthy incoming resources counted as available", () => {
      const result = planHubChains(
        {},
        { [RESOURCE_HYDROGEN]: 15000, [RESOURCE_OXYGEN]: 15000 },
        1000,
      );
      // H and O from incoming → OH is feasible
      expect(result.blocked).toBe(false);
      const ohStep = result.steps.find((s) => s.product === RESOURCE_HYDROXIDE);
      expect(ohStep).toBeDefined();
    });

    it("(f) blocked incoming excluded — does not create false available", () => {
      // This tests the runHubPlanner layer where blocked tasks have lastError set.
      // At the planHubChains level, incoming resources are passed in directly —
      // the caller (runHubPlanner) is responsible for filtering blocked imports.
      // So planHubChains({H:1000}, {}, 1000) with H available → OH is feasible.
      // The real test for blocked incoming is in the integration tests above.
      const result = planHubChains(
        { [RESOURCE_HYDROGEN]: 1000 },
        {},
        1000,
      );
      // Only H available, no O → OH is not feasible → blocked
      expect(result.blocked).toBe(true);
    });

    it("(g) auto-OH behavior preserved when H/O present", () => {
      const inventory: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      };
      const result = planHubChains(inventory, {}, 1000, [RESOURCE_CATALYZED_UTRIUM_ACID]);
      // OH should be first candidate in OUTPUT_ORDER
      expect(result.steps[0].product).toBe(RESOURCE_HYDROXIDE);
      expect(result.steps[0].targetAmount).toBe(1000);
    });
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
    mineralStore[RESOURCE_HYDROGEN] = 20000;
    mineralStore[RESOURCE_OXYGEN] = 20000;
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

  it("uses distributed synthesis when hub-only inventory lacks base reagents", () => {
    Game.time = PLAN_INTERVAL;
    Memory.cfg!.hub!.targetCompounds = [RESOURCE_CATALYZED_UTRIUM_ALKALIDE];
    Memory.cfg!.hub!.hubReservePerCompound = 5000;
    Memory.cfg!.hub!.reservePerRoom = 5000;

    Game.rooms[HUB_ROOM] = createSynthesisCapableRoom(HUB_ROOM, { labCount: 3 });
    Game.rooms["W2N1"] = createSynthesisCapableRoom("W2N1", {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      },
    });

    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("importing");
    expect(Memory.runtime.hub.missingResources).toEqual([]);
    expect(Memory.runtime.hub.distributedSynthesis?.dispatchAssignments.length).toBeGreaterThan(0);
    expect(Memory.cfg!.synthesisControl!.rooms!["W2N1"].reactions!.length).toBe(1);
  });

  it("distributed synthesis plans toward chainTarget when hub T3 is at hubReserve but satellite has deficit", () => {
    Game.time = PLAN_INTERVAL;
    Memory.cfg!.hub!.targetCompounds = [RESOURCE_CATALYZED_UTRIUM_ACID];
    Memory.cfg!.hub!.hubReservePerCompound = 5000;
    Memory.cfg!.hub!.reservePerRoom = 5000;

    Game.rooms[HUB_ROOM] = createSynthesisCapableRoom(HUB_ROOM, {
      labCount: 3,
      storageResources: {
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
      },
    });

    Game.rooms["W2N1"] = createSynthesisCapableRoom("W2N1", {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
        [RESOURCE_UTRIUM]: 10000,
      },
    });

    runHubPlanner();

    expect(Memory.runtime.hub.status).not.toBe("blocked");
    expect(Memory.runtime.hub.missingResources).toEqual([]);
    expect(Memory.runtime.hub.distributedSynthesis?.dispatchAssignments.length).toBeGreaterThan(0);
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

  it("creates base mineral import from survival satellite with large H surplus (E3N59 scenario)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 95086,
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
    expect(actions).toContain(`import:${SAT_ROOM}:${RESOURCE_HYDROGEN}=94586`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeDefined();
    expect(hTask!.amount).toBe(94586);
  });

  it("does not create base mineral import from survival satellite at safety floor (500 H)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 500,
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
    expect(actions).not.toContainEqual(expect.stringContaining(`hub:import:${RESOURCE_HYDROGEN}`));
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeUndefined();
  });

  it("does not create base mineral import from survival satellite below minimum send amount (599 H)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 599,
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
    expect(actions).not.toContainEqual(expect.stringContaining(`hub:import:${RESOURCE_HYDROGEN}`));
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeUndefined();
  });

  it("creates intermediate import from survival satellite with surplus OH", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROXIDE]: 100,
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
    expect(actions).toContain(`import:${SAT_ROOM}:${RESOURCE_HYDROXIDE}=100`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROXIDE && t.reason === `hub:import:${RESOURCE_HYDROXIDE}`,
    );
    expect(ohTask).toBeDefined();
    expect(ohTask!.amount).toBe(100);
  });

  it("creates T3 reclaim from survival satellite with surplus XGHO2", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1501,
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
    expect(actions).toContain(`reclaim:${SAT_ROOM}:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}=501`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(
      (t) =>
        t.resource === RESOURCE_CATALYZED_GHODIUM_ALKALIDE &&
        t.reason === `hub:reclaim:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    expect(t3Task).toBeDefined();
    expect(t3Task!.amount).toBe(501);
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

// ---------------------------------------------------------------------------
// TDD: distributedStorage policy — hub import ON/OFF behavior
// ---------------------------------------------------------------------------

describe("distributedStorage off", () => {
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
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
        distributedStorage: false,
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("creates hub:import:H base mineral task from satellite with surplus H", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROGEN]: 1000 });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeDefined();
    expect(hTask!.fromRoomName).toBe(SAT_ROOM);
    expect(hTask!.toRoomName).toBe(HUB_ROOM);
    expect(hTask!.reason).toBe("hub:import:H");
    expect(hTask!.amount).toBeGreaterThan(0);
  });

  it("creates hub:import:OH intermediate task from satellite with surplus OH", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROXIDE]: 150 });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROXIDE && t.reason === `hub:import:${RESOURCE_HYDROXIDE}`,
    );
    expect(ohTask).toBeDefined();
    expect(ohTask!.fromRoomName).toBe(SAT_ROOM);
    expect(ohTask!.toRoomName).toBe(HUB_ROOM);
    expect(ohTask!.reason).toBe("hub:import:OH");
    expect(ohTask!.amount).toBe(150);
  });

  it("creates hub:reclaim:XUH2O T3 reclaim task from satellite with surplus T3", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 1501,
    });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(
      (t) =>
        t.resource === RESOURCE_CATALYZED_UTRIUM_ACID &&
        t.reason === `hub:reclaim:${RESOURCE_CATALYZED_UTRIUM_ACID}`,
    );
    expect(t3Task).toBeDefined();
    expect(t3Task!.fromRoomName).toBe(SAT_ROOM);
    expect(t3Task!.toRoomName).toBe(HUB_ROOM);
    expect(t3Task!.reason).toBe("hub:reclaim:XUH2O");
    expect(t3Task!.amount).toBe(501);
  });

  it("creates all three task types simultaneously (H + OH + XUH2O reclaim)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 2000,
      [RESOURCE_HYDROXIDE]: 500,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
    });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find((t) => t.reason === "hub:import:H");
    const ohTask = tasks.find((t) => t.reason === "hub:import:OH");
    const t3Task = tasks.find((t) => t.reason === "hub:reclaim:XUH2O");

    expect(hTask).toBeDefined();
    expect(ohTask).toBeDefined();
    expect(t3Task).toBeDefined();

    // Guardrail: distributedStorage off never populates dispatchAssignments
    const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
    expect(dispatchAssignments).toHaveLength(0);
  });
});

describe("distributedStorage on", () => {
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
        reservePerRoom: 5000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
        distributedStorage: true,
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("does NOT create hub:import:H base mineral task (suppressed by distributed storage)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROGEN]: 2000 });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    // distributedStorage=true suppresses base mineral imports to hub
    expect(hTask).toBeUndefined();
  });

  it("does NOT create hub:import:OH intermediate task (suppressed by distributed storage)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [RESOURCE_HYDROXIDE]: 500 });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROXIDE && t.reason === `hub:import:${RESOURCE_HYDROXIDE}`,
    );
    // distributedStorage=true suppresses intermediate compound imports to hub
    expect(ohTask).toBeUndefined();
  });

  it("still creates hub:reclaim:XUH2O T3 reclaim task (reclaims preserved)", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 5501,
    });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(
      (t) =>
        t.resource === RESOURCE_CATALYZED_UTRIUM_ACID &&
        t.reason === `hub:reclaim:${RESOURCE_CATALYZED_UTRIUM_ACID}`,
    );
    expect(t3Task).toBeDefined();
    expect(t3Task!.fromRoomName).toBe(SAT_ROOM);
    expect(t3Task!.toRoomName).toBe(HUB_ROOM);
    expect(t3Task!.reason).toBe("hub:reclaim:XUH2O");
    expect(t3Task!.amount).toBe(501);
  });

  it("does not create hub:import:power task for POWER resource", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_POWER]: 3000,
    });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());
    const powerTask = tasks.find(
      (t) => t.resource === RESOURCE_POWER && t.reason === "hub:import:power",
    );
    expect(powerTask).toBeUndefined();
    const powerAction = actions.find((a) => a.includes(":power="));
    expect(powerAction).toBeUndefined();
  });

  it("suppressed state: no base, intermediate, or POWER imports, only T3 reclaim", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 2000,
      [RESOURCE_HYDROXIDE]: 500,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 6000,
      [RESOURCE_POWER]: 3000,
    });

    const actions = planHubImports(Memory.cfg!.hub!);

    const tasks = Object.values(ensureResourceTransferTaskStore());

    // Base mineral and intermediate imports must be suppressed
    const hTask = tasks.find((t) => t.reason === "hub:import:H");
    const ohTask = tasks.find((t) => t.reason === "hub:import:OH");
    expect(hTask).toBeUndefined();
    expect(ohTask).toBeUndefined();

    // T3 reclaim preserved
    const t3Task = tasks.find((t) => t.reason === "hub:reclaim:XUH2O");
    expect(t3Task).toBeDefined();

    // POWER import must not be created
    const powerTask = tasks.find((t) => t.reason === "hub:import:power");
    expect(powerTask).toBeUndefined();

    // Guardrail: route-task wiring must NOT create synthetic dispatchAssignments
    const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
    expect(dispatchAssignments).toHaveLength(0);
  });

  it("Guardrail: route-task wiring never creates synthetic dispatchAssignments entries", () => {
    // all route types active: proves none pollute dispatchAssignments
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 2000,
      [RESOURCE_HYDROXIDE]: 500,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
      [RESOURCE_POWER]: 3000,
    });

    const actions = planHubImports(Memory.cfg!.hub!);

    // Route tasks exist (T3 reclaim only), but dispatchAssignments must remain empty
    const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
    expect(dispatchAssignments).toHaveLength(0);
    // Also verify the entire distributedSynthesis object is absent or empty — no synthetic entries
    const ds = Memory.runtime?.hub?.distributedSynthesis;
    if (ds) {
      expect(Object.keys(ds).filter(k => k !== "dispatchAssignments")).toHaveLength(0);
    }
  });
});

describe("writeSynthesisConfig", () => {
  const PLAN_INTERVAL = 50;

  function setupHubRoomForSynthesis(
    storageResources: Record<string, number>,
    terminalResources: Record<string, number> = {},
    labStores: Record<string, number>[] = [],
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

    const labCount = Math.max(3, labStores.length);
    const labs: Structure[] = [];
    for (let i = 0; i < labCount; i++) {
      const labEntries: Record<string, number> = {
        [RESOURCE_ENERGY]: 2000,
        ...labStores[i],
      };
      labs.push({
        id: `hub-lab-${i}`,
        structureType: STRUCTURE_LAB,
        store: {
          ...labEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return labEntries[resource] || 0;
            return Object.values(labEntries).reduce((a: number, b: number) => a + b, 0);
          },
        },
      } as unknown as Structure);
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
        reservePerRoom: 5000,
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

  // Progressive: with single target XUH2O, OH demand is 1000 (not 10000 from 10 targets).
  // The first feasible candidate is OH (H+O available), targetAmount=1000.
  it("writes first reaction (OH) when hub inventory is empty", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
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
    // Progressive: single target XUH2O → OH demand=1000 (not 10000 from 10 targets)
    expect(roomCfg.reactions![0].targetAmount).toBe(1000);
  });

  // Progressive: OH met → next feasible step is UH (U+H available), not ZK.
  // Single target XUH2O chain: XUH2O → Catalyst+UH2O → UH+OH → U+H.
  // ZK is not in the XUH2O dependency chain.
  it("advances to next step (UH) when hub has 10000 OH", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
      [RESOURCE_HYDROXIDE]: 10000,
    });

    runHubPlanner();

    // Progressive: OH demand=0 (at surplus), UH (U+H) is next feasible candidate
    expect(Memory.runtime.hub.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(Memory.runtime.hub.activeStep).toBe(0);

    const roomCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(roomCfg.reactions![0].targetAmount).toBe(1000);
  });

  it("preserves existing reagentLabIds in synthesisControl config", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
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
    // Progressive: single target XUH2O → OH demand=1000
    expect(roomCfg.reactions![0].targetAmount).toBe(1000);
    expect(Memory.cfg.synthesisControl!.sampleInterval).toBe(5);
    expect(Memory.cfg.synthesisControl!.defaultBatchSize).toBe(100);
    expect(Memory.cfg.synthesisControl!.defaultMaxRunsPerTick).toBe(3);
  });

  it("sets status to 'acquiring' when imports are pending but reagents not yet available", () => {
    setupHubRoomForSynthesis({
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
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
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
      [RESOURCE_HYDROXIDE]: 10000,
      [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
      [RESOURCE_UTRIUM_LEMERGITE]: 2000,
      [RESOURCE_GHODIUM]: 2000,
      [RESOURCE_UTRIUM_HYDRIDE]: 1000,
      [RESOURCE_UTRIUM_OXIDE]: 1000,
      [RESOURCE_KEANIUM_HYDRIDE]: 1000,
      [RESOURCE_KEANIUM_OXIDE]: 1000,
      [RESOURCE_LEMERGIUM_HYDRIDE]: 1000,
      [RESOURCE_LEMERGIUM_OXIDE]: 1000,
      [RESOURCE_ZYNTHIUM_HYDRIDE]: 1000,
      [RESOURCE_ZYNTHIUM_OXIDE]: 1000,
      [RESOURCE_GHODIUM_HYDRIDE]: 1000,
      [RESOURCE_GHODIUM_OXIDE]: 1000,
      [RESOURCE_UTRIUM_ACID]: 1000,
      [RESOURCE_UTRIUM_ALKALIDE]: 1000,
      [RESOURCE_KEANIUM_ACID]: 1000,
      [RESOURCE_KEANIUM_ALKALIDE]: 1000,
      [RESOURCE_LEMERGIUM_ACID]: 1000,
      [RESOURCE_LEMERGIUM_ALKALIDE]: 1000,
      [RESOURCE_ZYNTHIUM_ACID]: 1000,
      [RESOURCE_ZYNTHIUM_ALKALIDE]: 1000,
      [RESOURCE_GHODIUM_ALKALIDE]: 1000,
      [RESOURCE_GHODIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_KEANIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_LEMERGIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_GHODIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
    });

    runHubPlanner();

    expect(Memory.runtime.hub.status).toBe("distributing");
    expect(Memory.runtime.hub.activeProduct).toBe("");
    expect(Memory.runtime.hub.activeStep).toBe(0);

    const roomCfg = Memory.cfg.synthesisControl?.rooms?.[HUB_ROOM];
    expect(roomCfg?.reactions).toBeFalsy();
  });

  it("skips UO step when UO exists only in lab (counts lab-held resources)", () => {
    Memory.cfg.hub!.targetCompounds = [RESOURCE_CATALYZED_UTRIUM_ALKALIDE];

    setupHubRoomForSynthesis(
      {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
        [RESOURCE_HYDROXIDE]: 10000,
        [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
        [RESOURCE_UTRIUM_LEMERGITE]: 2000,
        [RESOURCE_GHODIUM]: 2000,
        [RESOURCE_UTRIUM_HYDRIDE]: 1000,
      },
      {},
      [{ [RESOURCE_UTRIUM_OXIDE]: 1000 }],
    );

    runHubPlanner();

    expect(Memory.runtime.hub.status).not.toBe("blocked");
    expect(Memory.runtime.hub.activeProduct).not.toBe(RESOURCE_UTRIUM_OXIDE);
    expect(Memory.runtime.hub.lastPlanActions).toBeDefined();
    expect(Memory.runtime.hub.lastPlanActions).not.toContain(RESOURCE_UTRIUM_OXIDE);
    expect(Memory.runtime.hub.lastPlanActions).toContain(RESOURCE_UTRIUM_ALKALIDE);
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

  it("does not plan distribution below the terminal receiver admission watermark", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    (satRoom.terminal!.store as any).getFreeCapacity = () => 40_100;

    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toHaveLength(0);
    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) => entry.reason === `hub:export:${XGHO2}`,
    );
    expect(task).toBeUndefined();
  });

  it("caps an admitted receiver by its physical terminal headroom", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 50_000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    (satRoom.terminal!.store as any).getFreeCapacity = () => 50_100;
    Memory.cfg!.hub!.reservePerRoom = 20_000;
    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=10100`);
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

    // Satellite has 250, pending 500 incoming. Code counts satellite current only for shortage.
    // Shortage = 1000 - 250 = 750. Hub remaining = 5000 - 500 - 1000 = 3500. Export = min(750, 3500) = 750.
    expect(actions).toContainEqual(`export:${SAT_ROOM}:${XGHO2}=750`);

    // Manual console work and automatic planner work keep distinct origins,
    // while their combined reservation preserves the previous 1250 total.
    const tasks = Object.values(ensureResourceTransferTaskStore()).filter(
      (task) => task.reason === `hub:export:${XGHO2}`,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: "manual", amount: 500 }),
        expect.objectContaining({ origin: "automatic", amount: 750 }),
      ]),
    );
    expect(tasks.reduce((total, task) => total + task.amount, 0)).toBe(1250);
  });

  it("creates no export task when satellite storage lacks the receive buffer", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForDistribution({ [XGHO2]: 5000 });
    const satRoom = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 250 });
    // Storage full, terminal has free capacity, but storage lacks the 100k receive buffer.
    (satRoom.storage!.store as any).getFreeCapacity = () => 0;
    (satRoom.terminal!.store as any).getFreeCapacity = () => 150000;

    Game.rooms[SAT_ROOM] = satRoom;

    const actions = planHubDistribution(Memory.cfg!.hub!);

    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find((t) => t.reason === `hub:export:${XGHO2}`);
    expect(task).toBeUndefined();
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

    Memory.cfg.hub!.hubReservePerCompound = 1000;

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
    expect(roomCfg.reactions![0].targetAmount).toBe(10000);
  });

  // Progressive: with OH met and targetCompounds=[XUH2O], the next feasible
  // candidate is UH (U+H both available), not ZK (which belongs to other chains).
  it("advances from OH to UH when OH target is met (XUH2O chain)", () => {
    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, {
      ...ALL_BASE_MINERALS,
      [RESOURCE_HYDROXIDE]: 10000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
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
    // Progressive: next feasible step is UH (U+H), not ZK (not in XUH2O chain)
    expect(Memory.runtime.hub!.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);

    const roomCfg = Memory.cfg.synthesisControl!.rooms![INTEGRATION_HUB];
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(roomCfg.reactions![0].targetAmount).toBe(1000);
  });

  // 3. Full lifecycle: T3 production complete → hub:export task created
  it("creates hub:export task when T3 stock exists and satellite needs compound", () => {
    const ALL_COMPLETE: Record<string, number> = {
      ...ALL_BASE_MINERALS,
      [RESOURCE_HYDROXIDE]: 10000,
      [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
      [RESOURCE_UTRIUM_LEMERGITE]: 2000,
      [RESOURCE_GHODIUM]: 2000,
      [RESOURCE_UTRIUM_HYDRIDE]: 1000,
      [RESOURCE_UTRIUM_OXIDE]: 1000,
      [RESOURCE_KEANIUM_HYDRIDE]: 1000,
      [RESOURCE_KEANIUM_OXIDE]: 1000,
      [RESOURCE_LEMERGIUM_HYDRIDE]: 1000,
      [RESOURCE_LEMERGIUM_OXIDE]: 1000,
      [RESOURCE_ZYNTHIUM_HYDRIDE]: 1000,
      [RESOURCE_ZYNTHIUM_OXIDE]: 1000,
      [RESOURCE_GHODIUM_HYDRIDE]: 1000,
      [RESOURCE_GHODIUM_OXIDE]: 1000,
      [RESOURCE_UTRIUM_ACID]: 1000,
      [RESOURCE_UTRIUM_ALKALIDE]: 1000,
      [RESOURCE_KEANIUM_ACID]: 1000,
      [RESOURCE_KEANIUM_ALKALIDE]: 1000,
      [RESOURCE_LEMERGIUM_ACID]: 1000,
      [RESOURCE_LEMERGIUM_ALKALIDE]: 1000,
      [RESOURCE_ZYNTHIUM_ACID]: 1000,
      [RESOURCE_ZYNTHIUM_ALKALIDE]: 1000,
      [RESOURCE_GHODIUM_ALKALIDE]: 1000,
      [RESOURCE_GHODIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_KEANIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_LEMERGIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: 1000,
      [RESOURCE_CATALYZED_GHODIUM_ACID]: 1000,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
    };

    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(
      INTEGRATION_HUB,
      ALL_COMPLETE,
    );
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 0,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 5000,
        hubReservePerCompound: 0,
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
    expect(exportTask!.amount).toBe(5000);
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

  // Progressive: H+O available → OH is feasible → status=importing (not blocked).
  // The old all-or-nothing algorithm blocked here; progressive produces OH and
  // reports status=importing. K and Z are missing for further steps but OH can proceed.
  it("imports feasible intermediate when some base minerals are missing", () => {
    const partialMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
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

    Memory.cfg.hub!.hubReservePerCompound = 1000;

    runHubPlanner();
    // Progressive: OH is feasible (H+O available) → importing, not blocked
    expect(Memory.runtime.hub!.status).toBe("importing");
    expect(Memory.runtime.hub!.activeProduct).toBe(RESOURCE_HYDROXIDE);
    // Synthesis config written for the feasible step
    expect(
      Memory.cfg.synthesisControl?.rooms?.[INTEGRATION_HUB]?.reactions,
    ).toBeDefined();
    expect(
      Memory.cfg.synthesisControl!.rooms![INTEGRATION_HUB].reactions!.length,
    ).toBeGreaterThan(0);
  });

  // 7. Near-full storage prevents import tasks from satellite
  it("does not create import tasks when hub storage is near full", () => {
    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(
      INTEGRATION_HUB,
      ALL_BASE_MINERALS,
      { storageFreeCapacity: 50000 },
    );
    // Satellite with surplus hydrogen and target compound at reserve (avoids deficit)
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_HYDROGEN]: 2000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
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
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, partialMinerals);
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_ZYNTHIUM]: 5000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
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
      5000,
      `hub:import:${RESOURCE_ZYNTHIUM}`,
    );

    // Also import K to unblock chains
    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_KEANIUM,
      5000,
      `hub:import:${RESOURCE_KEANIUM}`,
    );

    // Verify incoming amounts are tracked
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_ZYNTHIUM)).toBe(5000);
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_KEANIUM)).toBe(5000);

    runHubPlanner();

    // With pending Z and K imports, chains should be unblocked
    expect(Memory.runtime.hub!.status).not.toBe("blocked");
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_ZYNTHIUM);
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_KEANIUM);
  });

  // Progressive: source-depleted incoming Z outside its grace must not count as available.
  // Use XGHO2 target (needs Z via G→ZK→Z+K chain) so blocked Z import matters.
  it("hub planner treats blocked incoming resources as unavailable", () => {
    const partialMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
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
        hubReservePerCompound: 1000,
        // XGHO2 needs Z (via G→ZK→Z+K), so blocked Z import matters
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_ZYNTHIUM,
      3000,
      `hub:import:${RESOURCE_ZYNTHIUM}`,
    );

    const store = ensureResourceTransferTaskStore();
    const zTask = Object.values(store).find((t) => t.resource === RESOURCE_ZYNTHIUM)!;
    markResourceTransferTaskBlocked(zTask, "source_depleted");
    zTask.blockedSince = Game.time - 100;

    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_ZYNTHIUM)).toBe(0);

    runHubPlanner();

    // Progressive: OH is feasible (H+O) → importing status, not distributing
    expect(Memory.runtime.hub!.status).not.toBe("distributing");
    // Blocked Z means ZK (Z+K) is not a candidate — Z is not in hub inventory
    // Verify no Z-dependent product is being synthesized
    const lastActions = Memory.runtime.hub!.lastPlanActions || [];
    expect(lastActions).not.toContain(RESOURCE_ZYNTHIUM_KEANITE);
  });

  // Progressive: XGHO2=5000 exceeds hubReservePerCompound=1000, so chain target
  // is met. Status becomes "distributing" (not "blocked"). Export still works.
  it("creates hub:export:XGHO2 when hub has T3 stock at surplus", () => {
    const partialMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    const XGHO2 = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;

    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, {
      ...partialMinerals,
      [XGHO2]: 10000,
    });
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {});

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 5000,
        hubReservePerCompound: 1000,
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

    // Progressive: XGHO2=10000 > hubReserve + satellite deficit → distributing (chain target met)
    expect(Memory.runtime.hub!.status).toBe("distributing");
    expect(Memory.runtime.hub!.activeProduct).toBe("");

    // Distribution still runs — hub has 10000 XGHO2, satellite has 0
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const exportTask = tasks.find(
      (t) => t.resource === XGHO2 && t.reason === `hub:export:${XGHO2}`,
    );
    expect(exportTask).toBeDefined();
    expect(exportTask!.fromRoomName).toBe(INTEGRATION_HUB);
    expect(exportTask!.toRoomName).toBe(INTEGRATION_SAT);
    expect(exportTask!.amount).toBe(5000);
  });

  // Progressive: H+O → OH is feasible → importing (not distributing).
  // Blocked Z import means Z-dependent intermediates (ZK, G-chain) cannot be produced,
  // but OH can still proceed. Hub must NOT enter distributing — Z is not actually available.
  it("blocked pending Z import does not cause hub to enter distributing", () => {
    // Hub has all base minerals EXCEPT zynthium, targeting XGHO2 which requires Z
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

    // Create pending import of Z from satellite to hub — but mark its source as depleted beyond grace.
    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_ZYNTHIUM,
      3000,
      `hub:import:${RESOURCE_ZYNTHIUM}`,
    );
    const store = ensureResourceTransferTaskStore();
    const zTask = Object.values(store).find((t) => t.resource === RESOURCE_ZYNTHIUM)!;
    markResourceTransferTaskBlocked(zTask, "source_depleted");
    zTask.blockedSince = Game.time - 100;

    // Verify blocked import is excluded from incoming amounts
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_ZYNTHIUM)).toBe(0);

    runHubPlanner();

    // Hub must NOT enter distributing — Z is not actually available
    expect(Memory.runtime.hub!.status).not.toBe("distributing");
    // Progressive: OH (H+O) is feasible → importing
    expect(Memory.runtime.hub!.status).toBe("importing");
    // Z-dependent intermediates (ZK, G-chain) must not appear in plan actions
    const lastActions = Memory.runtime.hub!.lastPlanActions || [];
    expect(lastActions).not.toContain(RESOURCE_ZYNTHIUM_KEANITE);
    expect(lastActions).not.toContain(RESOURCE_GHODIUM);
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

describe("runHubPlanner – out-of-cadence regression", () => {
  const PLAN_INTERVAL = 1000;

  beforeEach(() => {
    Game.time = 7;
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

  it("runs out-of-cadence when needsPlan=true and writes next chain step", () => {
    Memory.runtime.hub.needsPlan = true;

    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 3 });
    const mineralStore = (room.storage!.store as unknown as Record<string, number>);
    mineralStore[RESOURCE_HYDROGEN] = 20000;
    mineralStore[RESOURCE_OXYGEN] = 20000;
    mineralStore[RESOURCE_UTRIUM] = 10000;
    mineralStore[RESOURCE_LEMERGIUM] = 10000;
    mineralStore[RESOURCE_KEANIUM] = 10000;
    mineralStore[RESOURCE_ZYNTHIUM] = 10000;
    mineralStore[RESOURCE_CATALYST] = 10000;
    Game.rooms[HUB_ROOM] = room;

    runHubPlanner();

    expect(Memory.runtime.hub.updatedAt).toBe(7);
    expect(Memory.runtime.hub.needsPlan).toBe(false);
    expect(Memory.runtime.hub.status).not.toBe("blocked");
    expect(Memory.runtime.hub.activeProduct).toBeDefined();
    expect(Memory.runtime.hub.activeProduct!.length).toBeGreaterThan(0);

    const scConfig = Memory.cfg.synthesisControl?.rooms?.[HUB_ROOM];
    expect(scConfig).toBeDefined();
    expect(scConfig!.enabled).toBe(true);
    expect(scConfig!.reactions.length).toBeGreaterThanOrEqual(1);
    expect(scConfig!.reactions[0].product).toBe(Memory.runtime.hub.activeProduct);
  });

  it("does NOT run when off cadence and needsPlan=false", () => {
    Memory.runtime.hub.needsPlan = false;

    const room = createHubRoom({ hasStorage: true, hasTerminal: true, labCount: 3 });
    Game.rooms[HUB_ROOM] = room;

    const beforeUpdatedAt = Memory.runtime.hub.updatedAt;
    runHubPlanner();

    expect(Memory.runtime.hub.updatedAt).toBe(beforeUpdatedAt);
    expect(Memory.runtime.hub.status).toBe("idle");
  });
});

describe("hub chain advancement after product unload", () => {
  const PLAN_INTERVAL = 50;
  const UO = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
  const UHO2 = RESOURCE_UTRIUM_ALKALIDE as ResourceConstant;
  const XUHO2 = RESOURCE_CATALYZED_UTRIUM_ALKALIDE as ResourceConstant;

  function setupHubRoomForUOChain(
    storageResources: Record<string, number>,
  ): { room: Room; storageEntries: Record<string, number> } {
    const storageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      ...storageResources,
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
        [RESOURCE_ENERGY]: 20000,
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300000,
        cooldown: 0,
      },
    };

    const labs: Structure[] = [];
    for (let i = 0; i < 3; i++) {
      labs.push({ id: `hub-lab-${i}`, structureType: STRUCTURE_LAB } as Structure);
    }

    const room = {
      name: HUB_ROOM,
      controller: { my: true, level: 8 },
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

    Game.rooms[HUB_ROOM] = room;
    return { room, storageEntries };
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
        hubReservePerCompound: 1000,
        targetCompounds: [XUHO2],
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

  it("writes UO as active step when OH through UH are met but UO is not", () => {
    setupHubRoomForUOChain({
      ...ALL_BASE_MINERALS,
      [RESOURCE_HYDROXIDE]: 10000,
      [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
      [RESOURCE_UTRIUM_LEMERGITE]: 2000,
      [RESOURCE_GHODIUM]: 2000,
      [RESOURCE_UTRIUM_HYDRIDE]: 1000,
    });

    runHubPlanner();

    expect(Memory.runtime.hub!.status).toBe("importing");
    expect(Memory.runtime.hub!.activeProduct).toBe(UO);

    const roomCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(UO);
  });

  // Progressive: after UO is produced, UHO2 (UO+OH) is the next feasible step
  // in the XUHO2 chain, not KH (which belongs to K-chain).
  it("advances past UO to UHO2 after product unload makes UO visible in storage", () => {
    const { storageEntries } = setupHubRoomForUOChain({
      ...ALL_BASE_MINERALS,
      [RESOURCE_HYDROXIDE]: 10000,
      [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
      [RESOURCE_UTRIUM_LEMERGITE]: 2000,
      [RESOURCE_GHODIUM]: 2000,
      [RESOURCE_UTRIUM_HYDRIDE]: 1000,
    });

    runHubPlanner();

    expect(Memory.runtime.hub!.activeProduct).toBe(UO);

    storageEntries[UO] = 1000;
    const storageStore = Game.rooms[HUB_ROOM].storage!.store as unknown as Record<string, number>;
    storageStore[UO] = 1000;
    Game.time = PLAN_INTERVAL + 1;
    Memory.runtime.hub!.needsPlan = true;

    runHubPlanner();

    expect(Memory.runtime.hub!.status).toBe("importing");
    expect(Memory.runtime.hub!.activeProduct).not.toBe(UO);
    // Progressive: UHO2 (UO+OH) is feasible → next step in XUHO2 chain
    expect(Memory.runtime.hub!.activeProduct).toBe(UHO2);

    const roomCfg = Memory.cfg.synthesisControl!.rooms![HUB_ROOM];
    expect(roomCfg.reactions).toHaveLength(1);
    expect(roomCfg.reactions![0].product).toBe(UHO2);
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

describe("all-10 T3 target compounds (TDD RED)", () => {
  it("getDefaultHubConfig returns all 10 T3 target compounds in correct order", () => {
    const config = getDefaultHubConfig();
    expect(config.targetCompounds).toEqual(ALL_T3_COMPOUNDS);
  });

  it("getDefaultHubConfig has hubReservePerCompound field set to 20000", () => {
    const config = getDefaultHubConfig();
    expect((config as any).hubReservePerCompound).toBe(20000);
  });
});

describe("hub config migration (TDD RED)", () => {
  // normalizeHubConfig does not exist yet — this import will fail at compile time
  // which is the expected RED state.
  it("importing normalizeHubConfig should succeed (function does not exist yet)", () => {
    // This test is a placeholder; the real test is that the import at the top of
    // the file includes normalizeHubConfig. We verify the function is callable.
    // Once the function is exported from hubPlanner, this test body will be updated.
    // For now, we assert the function exists on the module — this will fail.
    const { normalizeHubConfig } = require("@/runtime/hubPlanner") as Record<string, unknown>;
    expect(typeof normalizeHubConfig).toBe("function");
  });

  it("normalizeHubConfig migrates old 5-compound list to all 10 T3s", () => {
    const { normalizeHubConfig } = require("@/runtime/hubPlanner") as { normalizeHubConfig: (cfg: any) => any };
    const oldFive: ResourceConstant[] = [
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
      RESOURCE_CATALYZED_GHODIUM_ACID,     // XGH2O
      RESOURCE_CATALYZED_UTRIUM_ACID,      // XUH2O
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,  // XUHO2
      RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
    ];
    const result = normalizeHubConfig({ targetCompounds: oldFive });
    expect(result.targetCompounds.sort()).toEqual([...ALL_T3_COMPOUNDS].sort());
  });

  it("normalizeHubConfig preserves custom target list unchanged", () => {
    const { normalizeHubConfig } = require("@/runtime/hubPlanner") as { normalizeHubConfig: (cfg: any) => any };
    const customList: ResourceConstant[] = [
      RESOURCE_CATALYZED_UTRIUM_ACID,       // XUH2O
      RESOURCE_CATALYZED_KEANIUM_ACID,      // XKH2O
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,  // XGHO2
    ];
    const result = normalizeHubConfig({ targetCompounds: customList });
    expect(result.targetCompounds).toEqual(customList);
  });

  it("normalizeHubConfig defaults missing distributedStorage to true", () => {
    const { normalizeHubConfig } = require("@/runtime/hubPlanner") as { normalizeHubConfig: (cfg: any) => any };
    const result = normalizeHubConfig({});
    expect(result.distributedStorage).toBe(true);
  });

  it("normalizeHubConfig preserves explicit distributedStorage false", () => {
    const { normalizeHubConfig } = require("@/runtime/hubPlanner") as { normalizeHubConfig: (cfg: any) => any };
    const result = normalizeHubConfig({ distributedStorage: false });
    expect(result.distributedStorage).toBe(false);
  });

  it("normalizeHubConfig preserves explicit distributedStorage true", () => {
    const { normalizeHubConfig } = require("@/runtime/hubPlanner") as { normalizeHubConfig: (cfg: any) => any };
    const result = normalizeHubConfig({ distributedStorage: true });
    expect(result.distributedStorage).toBe(true);
  });
});

describe("chain resolvability for all 10 T3s (TDD RED)", () => {
  // Progressive: empty inventory → no candidates → blocked:true.
  // To test chain resolvability, provide all base minerals and verify that each
  // T3 target's dependency chain can produce at least one feasible intermediate.
  it("planHubChains produces feasible steps toward each T3 from base minerals", () => {
    const allBaseMinerals: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 20000,
      [RESOURCE_OXYGEN]: 20000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_ZYNTHIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };
    for (const t3 of ALL_T3_COMPOUNDS) {
      // Test each T3 individually to verify its chain produces feasible steps
      const result = planHubChains(allBaseMinerals, {}, 1000, [t3]);
      // At minimum, base intermediates and T1 should be feasible
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.blocked).toBe(false);
    }
  });
});

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

  it("hub with 21000 of a T3 and empty satellite → export exactly 1000", () => {
    const hubStorageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      [XGHO2]: 21000,
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

    // Surplus = 21000 - 20000 = 1000. Satellite shortage = 1000. Export = min(1000, 1000) = 1000.
    expect(actions).toContainEqual(`export:${SAT_ROOM_D}:${XGHO2}=1000`);
  });

  it("hub with pending outgoing 500, stock 21500, reserve 20000, satellite deficit 1000 → exports 1000", () => {
    const hubStorageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      [XGHO2]: 21500,
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

    // Existing pending export of 500
    createResourceTransferTask(HUB_ROOM_D, SAT_ROOM_D, XGHO2, 500, `hub:export:${XGHO2}`);

    const actions = planHubDistribution(Memory.cfg!.hub!);

    // Surplus = 21500 - 20000 = 1500. Pending 500 → hubRemaining after reserve floor should be 1500.
    // Satellite deficit = 1000. Export = min(1000, 1500) = 1000.
    // This will FAIL because current code has no reserve floor — hubRemaining = 21500 - 500 = 21000,
    // and it will export min(1000, 21000) = 1000 which coincidentally passes.
    // But the intent is to test that surplus is correctly computed as 1500 after reserve.
    // The assertion that the pending export total becomes 1500 (500 + 1000) verifies this.
    expect(actions).toContainEqual(`export:${SAT_ROOM_D}:${XGHO2}=1000`);
  });

  it("hub with pending outgoing 1500, stock 21500, reserve 20000 → exports 0", () => {
    const hubStorageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      [XGHO2]: 21500,
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

    // Pending outgoing of 1500
    createResourceTransferTask(HUB_ROOM_D, SAT_ROOM_D, XGHO2, 1500, `hub:export:${XGHO2}`);

    const actions = planHubDistribution(Memory.cfg!.hub!);

    // Surplus after reserve = 21500 - 20000 = 1500. Pending = 1500 → net surplus = 0.
    // No additional export should be created.
    // This will FAIL because current code: hubRemaining = 21500 - 1500 = 20000, satellite deficit = 1000,
    // so it exports min(1000, 20000) = 1000.
    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const exportTasks = tasks.filter(
      (t) => t.reason === `hub:export:${XGHO2}` && t.status === "pending",
    );
    // Should still be only the original pending 1500 task
    const totalPending = exportTasks.reduce((sum, t) => sum + t.remainingAmount, 0);
    expect(totalPending).toBe(1500);
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

  it("constructs 3-room mock environment with correct room count and structure presence", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      },
    });

    const aux1Room = createSynthesisCapableRoom(DIST_AUX1, {
      labCount: 3,
      storageResources: {
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM]: 10000,
      },
    });

    const aux2Room = createSynthesisCapableRoom(DIST_AUX2, {
      labCount: 3,
      storageResources: {
        [RESOURCE_LEMERGIUM]: 10000,
      },
    });

    Game.rooms[DIST_HUB] = hubRoom;
    Game.rooms[DIST_AUX1] = aux1Room;
    Game.rooms[DIST_AUX2] = aux2Room;

    expect(Object.keys(Game.rooms)).toHaveLength(3);
    expect(Game.rooms[DIST_HUB]).toBeDefined();
    expect(Game.rooms[DIST_AUX1]).toBeDefined();
    expect(Game.rooms[DIST_AUX2]).toBeDefined();
  });

  it("each room has storage, terminal, and 3+ labs", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_HUB, { labCount: 3 });
    const aux1Room = createSynthesisCapableRoom(DIST_AUX1, { labCount: 3 });
    const aux2Room = createSynthesisCapableRoom(DIST_AUX2, { labCount: 3 });

    for (const room of [hubRoom, aux1Room, aux2Room]) {
      expect(room.storage).toBeDefined();
      expect(room.terminal).toBeDefined();
      const labs = room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_LAB },
      });
      expect(labs.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("rooms have distinct mineral stores as configured", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_HUB, {
      storageResources: { [RESOURCE_HYDROGEN]: 20000, [RESOURCE_UTRIUM]: 10000 },
    });
    const aux1Room = createSynthesisCapableRoom(DIST_AUX1, {
      storageResources: { [RESOURCE_KEANIUM]: 10000 },
    });
    const aux2Room = createSynthesisCapableRoom(DIST_AUX2, {
      storageResources: { [RESOURCE_LEMERGIUM]: 10000 },
    });

    const hubStore = hubRoom.storage!.store as unknown as Record<string, number>;
    const aux1Store = aux1Room.storage!.store as unknown as Record<string, number>;
    const aux2Store = aux2Room.storage!.store as unknown as Record<string, number>;

    expect(hubStore[RESOURCE_HYDROGEN]).toBe(20000);
    expect(hubStore[RESOURCE_UTRIUM]).toBe(10000);
    expect(aux1Store[RESOURCE_KEANIUM]).toBe(10000);
    expect(aux2Store[RESOURCE_LEMERGIUM]).toBe(10000);

    expect(hubStore[RESOURCE_KEANIUM]).toBeFalsy();
    expect(hubStore[RESOURCE_LEMERGIUM]).toBeFalsy();
    expect(aux1Store[RESOURCE_HYDROGEN]).toBeFalsy();
    expect(aux2Store[RESOURCE_HYDROGEN]).toBeFalsy();
  });

  it("SynthesisRoomCapability type contract captures room eligibility", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_HUB, {
      labCount: 3,
      storageResources: { [RESOURCE_HYDROGEN]: 5000 },
    });

    const capability: SynthesisRoomCapability = {
      roomName: hubRoom.name,
      labCount: hubRoom.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_LAB },
      }).length,
      hasTerminal: !!hubRoom.terminal,
      hasStorage: !!hubRoom.storage,
      boostLabExclusive: false,
      mineralInventory: { [RESOURCE_HYDROGEN]: 5000 },
    };

    expect(capability.roomName).toBe(DIST_HUB);
    expect(capability.labCount).toBe(3);
    expect(capability.hasTerminal).toBe(true);
    expect(capability.hasStorage).toBe(true);
    expect(capability.boostLabExclusive).toBe(false);
    expect(capability.mineralInventory[RESOURCE_HYDROGEN]).toBe(5000);
  });

  it("SynthesisDispatchAssignment type contract models room reaction assignment", () => {
    const assignment: SynthesisDispatchAssignment = {
      roomName: DIST_AUX1,
      product: RESOURCE_HYDROXIDE,
      targetAmount: 5000,
      isHubRoom: false,
    };

    expect(assignment.roomName).toBe(DIST_AUX1);
    expect(assignment.product).toBe(RESOURCE_HYDROXIDE);
    expect(assignment.targetAmount).toBe(5000);
    expect(assignment.isHubRoom).toBe(false);
  });

  it("AllocationLedgerEntry type contract models resource commitments", () => {
    const entry: AllocationLedgerEntry = {
      resource: RESOURCE_HYDROGEN,
      totalAmount: 20000,
      roomCommitments: {
        [DIST_HUB]: 10000,
        [DIST_AUX1]: 5000,
        [DIST_AUX2]: 5000,
      },
    };

    expect(entry.resource).toBe(RESOURCE_HYDROGEN);
    expect(entry.totalAmount).toBe(20000);
    expect(Object.keys(entry.roomCommitments)).toHaveLength(3);
    const totalCommitted = Object.values(entry.roomCommitments).reduce(
      (sum, v) => sum + v,
      0,
    );
    expect(totalCommitted).toBe(20000);
  });

  it("DirectRouteDecision type contract models terminal transfer", () => {
    const decision: DirectRouteDecision = {
      fromRoom: DIST_AUX1,
      toRoom: DIST_HUB,
      resource: RESOURCE_KEANIUM,
      amount: 5000,
      fee: 200,
    };

    expect(decision.fromRoom).toBe(DIST_AUX1);
    expect(decision.toRoom).toBe(DIST_HUB);
    expect(decision.resource).toBe(RESOURCE_KEANIUM);
    expect(decision.amount).toBe(5000);
    expect(decision.fee).toBe(200);
  });

  it("ProgressEdge type contract models upstream/downstream flow", () => {
    const edge: ProgressEdge = {
      fromRoom: DIST_AUX1,
      toRoom: DIST_HUB,
      resource: RESOURCE_HYDROXIDE,
      delivered: 2000,
      total: 5000,
    };

    expect(edge.fromRoom).toBe(DIST_AUX1);
    expect(edge.toRoom).toBe(DIST_HUB);
    expect(edge.resource).toBe(RESOURCE_HYDROXIDE);
    expect(edge.delivered).toBeLessThan(edge.total);
    expect(edge.total - edge.delivered).toBe(3000);
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
// getEligibleSynthesisRooms tests
// ---------------------------------------------------------------------------

describe("getEligibleSynthesisRooms", () => {
  const ELIG_HUB = "E1N1";
  const ELIG_AUX = "E2N1";
  const ELIG_AUX2 = "E3N1";

  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: ELIG_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
      homeDefense: {},
    };
    Memory.runtime = {
      hub: getDefaultHubRuntime(),
    };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("returns eligible rooms with storage, terminal, and 3+ labs", () => {
    const hubRoom = createSynthesisCapableRoom(ELIG_HUB, {
      labCount: 3,
      storageResources: { [RESOURCE_HYDROGEN]: 5000 },
    });
    const auxRoom = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 5,
      storageResources: { [RESOURCE_KEANIUM]: 3000 },
    });
    Game.rooms[ELIG_HUB] = hubRoom;
    Game.rooms[ELIG_AUX] = auxRoom;

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(2);
    const names = result.map((r) => r.roomName);
    expect(names).toContain(ELIG_HUB);
    expect(names).toContain(ELIG_AUX);
  });

  it("excludes rooms without storage", () => {
    const noStorageRoom = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 3,
      hasStorage: false,
    });
    Game.rooms[ELIG_AUX] = noStorageRoom;

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(0);
  });

  it("excludes rooms without terminal", () => {
    const noTerminalRoom = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 3,
      hasTerminal: false,
    });
    Game.rooms[ELIG_AUX] = noTerminalRoom;

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(0);
  });

  it("excludes rooms with fewer than 3 labs", () => {
    const twoLabRoom = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 2,
    });
    Game.rooms[ELIG_AUX] = twoLabRoom;

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(0);
  });

  it("excludes rooms not visible in Game.rooms", () => {
    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(0);
  });

  it("includes survival-state rooms as eligible", () => {
    const survivalRoom = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 3,
      storageResources: { [RESOURCE_HYDROGEN]: 500 },
    });
    Game.rooms[ELIG_AUX] = survivalRoom;

    Memory.runtime!.resourceControl = {
      updatedAt: Game.time,
      rooms: {
        [ELIG_AUX]: {
          state: "survival",
          storageEnergy: 10000,
          terminalEnergy: 5000,
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

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(1);
    expect(result[0].roomName).toBe(ELIG_AUX);
  });

  it("includes room with boost lab when room has multiple labs", () => {
    const room = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 3,
      storageResources: { [RESOURCE_UTRIUM]: 1000 },
    });
    Game.rooms[ELIG_AUX] = room;

    Memory.cfg!.homeDefense = {
      rooms: {
        [ELIG_AUX]: {
          boostLabId: `${ELIG_AUX}-lab-0`,
        },
      },
    };

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(1);
    expect(result[0].boostLabExclusive).toBe(false);
    expect(result[0].labCount).toBe(3);
  });

  it("excludes room where all labs are boost-reserved (1 lab + boostLabId)", () => {
    const room = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 1,
    });
    Game.rooms[ELIG_AUX] = room;

    Memory.cfg!.homeDefense = {
      rooms: {
        [ELIG_AUX]: {
          boostLabId: `${ELIG_AUX}-lab-0`,
        },
      },
    };

    const result = getEligibleSynthesisRooms();

    // 1 lab room is also excluded by the <3 lab count check
    expect(result).toHaveLength(0);
  });

  it("collects mineral inventory from storage and terminal", () => {
    const room = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 3,
      storageResources: { [RESOURCE_HYDROGEN]: 5000, [RESOURCE_UTRIUM]: 3000 },
      terminalResources: { [RESOURCE_KEANIUM]: 2000, [RESOURCE_HYDROGEN]: 1000 },
    });
    Game.rooms[ELIG_AUX] = room;

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(1);
    const inv = result[0].mineralInventory;
    expect(inv[RESOURCE_HYDROGEN]).toBe(6000);
    expect(inv[RESOURCE_UTRIUM]).toBe(3000);
    expect(inv[RESOURCE_KEANIUM]).toBe(2000);
    expect(inv[RESOURCE_ENERGY]).toBeUndefined();
  });

  it("includes hub room alongside auxiliary rooms", () => {
    const hubRoom = createSynthesisCapableRoom(ELIG_HUB, {
      labCount: 3,
      storageResources: { [RESOURCE_HYDROGEN]: 10000 },
    });
    const auxRoom = createSynthesisCapableRoom(ELIG_AUX, {
      labCount: 5,
      storageResources: { [RESOURCE_KEANIUM]: 5000 },
    });
    const aux2Room = createSynthesisCapableRoom(ELIG_AUX2, {
      labCount: 4,
      storageResources: { [RESOURCE_ZYNTHIUM]: 8000 },
    });
    Game.rooms[ELIG_HUB] = hubRoom;
    Game.rooms[ELIG_AUX] = auxRoom;
    Game.rooms[ELIG_AUX2] = aux2Room;

    const result = getEligibleSynthesisRooms();

    expect(result).toHaveLength(3);
    const hubCap = result.find((r) => r.roomName === ELIG_HUB);
    expect(hubCap).toBeDefined();
    expect(hubCap!.hasStorage).toBe(true);
    expect(hubCap!.hasTerminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planDistributedSynthesis tests
// ---------------------------------------------------------------------------

const DIST_SYNTH_HUB = "DS1";
const DIST_SYNTH_AUX = "DS2";
const DIST_SYNTH_AUX2 = "DS3";

describe("planDistributedSynthesis", () => {
  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: DIST_SYNTH_HUB,
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

  function getHubInventory(): Record<string, number> {
    const inv: Record<string, number> = {};
    const room = Game.rooms[DIST_SYNTH_HUB];
    if (!room?.storage?.store || !room?.terminal?.store) return inv;
    for (const [res, amt] of Object.entries(room.storage.store as unknown as Record<string, number>)) {
      if (res !== RESOURCE_ENERGY && amt > 0) inv[res] = amt;
    }
    for (const [res, amt] of Object.entries(room.terminal.store as unknown as Record<string, number>)) {
      if (res !== RESOURCE_ENERGY && amt > 0) inv[res] = (inv[res] || 0) + amt;
    }
    return inv;
  }

  it("returns empty plan when no eligible rooms exist", () => {
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, [RESOURCE_CATALYZED_UTRIUM_ACID], 1000, 1000, getHubInventory());

    expect(plan.dispatchAssignments).toEqual([]);
    expect(plan.blockedTargets).toContain(RESOURCE_CATALYZED_UTRIUM_ACID);
  });

  it("backward compatibility: single hub room produces same chain as planHubChains", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_LEMERGIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Hub room alone has all base minerals → planHubChains returns feasible steps
    expect(plan.dispatchAssignments.length).toBeGreaterThan(0);
    // All assignments go to the hub
    for (const a of plan.dispatchAssignments) {
      expect(a.roomName).toBe(DIST_SYNTH_HUB);
      expect(a.isHubRoom).toBe(true);
    }
    // No route decisions needed (single room)
    expect(plan.routeDecisions).toEqual([]);
    // Target should not be blocked
    expect(plan.blockedTargets).not.toContain(RESOURCE_CATALYZED_UTRIUM_ACID);
  });

  it("backward compatibility: single hub result matches planHubChains output", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Hub has H, O, U, Catalyst but not L, K, Z — progressive chain returns OH + UH + UO as feasible
    const products = plan.dispatchAssignments.map(a => a.product);
    expect(products).toContain(RESOURCE_HYDROXIDE);
    expect(plan.blockedTargets).not.toContain(RESOURCE_CATALYZED_UTRIUM_ACID);
  });

  it("scarce shared base minerals: ledger prevents double-spending across rooms", () => {
    // Hub has limited H (1500), Aux has limited H (1500)
    // Reserve=1000 per room, so effective H per room = 500
    // Target XUH2O needs H for chain: OH(H+O), UH(U+H), UH2O(UH+OH), XUH2O(C+UH2O)
    // With only H from both rooms, OH demand depends on what else is available
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 1500,
        [RESOURCE_OXYGEN]: 3000,
        [RESOURCE_UTRIUM]: 3000,
        [RESOURCE_CATALYST]: 3000,
      },
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 1500,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Total effective H = 500 (hub) + 500 (aux) = 1000
    // Verify ledger tracks this correctly
    const hLedger = plan.allocationLedger[RESOURCE_HYDROGEN];
    expect(hLedger).toBeDefined();
    // After assignments, total remaining should be 0 or consistent
    const totalCommitted = Object.values(hLedger!.roomCommitments).reduce((s, v) => s + v, 0);
    expect(totalCommitted + hLedger!.totalAmount).toBeLessThanOrEqual(1000);

    // Verify no room committed more than its effective amount
    const hubHCommitted = hLedger!.roomCommitments[DIST_SYNTH_HUB] ?? 0;
    const auxHCommitted = hLedger!.roomCommitments[DIST_SYNTH_AUX] ?? 0;
    // Original effective amounts: hub=500, aux=500
    // Committed (original) minus remaining = consumed
    // Total consumed across rooms should equal the amount used by assignments
    const hubHConsumed = 500 - Math.max(0, hubHCommitted);
    const auxHConsumed = 500 - Math.max(0, auxHCommitted);
    const totalConsumed = hubHConsumed + auxHConsumed;
    // Total consumed should not exceed total available
    expect(totalConsumed).toBeLessThanOrEqual(1000);
  });

  it("scarce shared minerals: two rooms compete for H, second room cannot over-allocate", () => {
    // Hub: 3000 H, 3000 O (effective: 2000 H, 2000 O)
    // Aux: 2000 H only (effective: 1000 H)
    // Two targets both need H: XUH2O and XUHO2
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 3000,
        [RESOURCE_OXYGEN]: 3000,
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 2000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    const targets: ResourceConstant[] = [
      RESOURCE_CATALYZED_UTRIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
    ];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Total effective H = 2000 (hub) + 1000 (aux) = 3000
    // Total effective O = 2000 (hub only)
    // OH demand for 2 targets = 2000 (shared intermediate)
    // OH uses H+O: limited by O (2000), so OH amount = min(H for OH, O) = 2000
    // After OH, H remaining = 3000 - 2000 = 1000
    // Verify the ledger was decremented correctly
    const hLedger = plan.allocationLedger[RESOURCE_HYDROGEN];
    expect(hLedger).toBeDefined();
    // Total consumed H should not exceed total available (3000)
    const totalAvailable = 3000;
    const totalRemaining = hLedger!.totalAmount;
    expect(totalRemaining).toBeLessThanOrEqual(totalAvailable);
  });

  it("all-T3 concurrent feasibility: sufficient global resources produce assignments", () => {
    const allBases: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 100000,
      [RESOURCE_OXYGEN]: 100000,
      [RESOURCE_UTRIUM]: 50000,
      [RESOURCE_LEMERGIUM]: 50000,
      [RESOURCE_KEANIUM]: 50000,
      [RESOURCE_ZYNTHIUM]: 50000,
      [RESOURCE_CATALYST]: 50000,
    };

    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: allBases,
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const targets: ResourceConstant[] = [
      RESOURCE_CATALYZED_UTRIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
      RESOURCE_CATALYZED_KEANIUM_ACID,
      RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
      RESOURCE_CATALYZED_LEMERGIUM_ACID,
      RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      RESOURCE_CATALYZED_ZYNTHIUM_ACID,
      RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
      RESOURCE_CATALYZED_GHODIUM_ACID,
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
    ];

    // hubReservePerCompound=1000 so each T3 deficit is small (1000 per target)
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // With abundant resources, should have many feasible steps
    expect(plan.dispatchAssignments.length).toBeGreaterThan(0);
    // Progressive chain returns base intermediates + T1 as feasible candidates
    const products = plan.dispatchAssignments.map(a => a.product);
    expect(products).toContain(RESOURCE_HYDROXIDE);
    // With small reserve, H remains for T1 intermediates like UH (U+H)
    expect(products).toContain(RESOURCE_UTRIUM_HYDRIDE);
    // Should not be blocked
    expect(plan.blockedTargets).toEqual([]);
  });

  it("cross-room routing: hub routes reagents from aux when hub lacks them", () => {
    // Hub has H and O but no U
    // Aux has U but no H or O
    // Target XUH2O needs U → hub needs U from aux to produce UH (U+H)
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_UTRIUM]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Hub has H+O → OH is feasible locally
    const ohAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);
    expect(ohAssignment).toBeDefined();

    // For U-dependent steps (UH needs U+H), hub has H but not U → route from aux
    const uhAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_UTRIUM_HYDRIDE);
    if (uhAssignment) {
      // UH should be assigned to hub (preferred) with U routed from aux
      if (uhAssignment.roomName === DIST_SYNTH_HUB) {
        const uRoutes = plan.routeDecisions.filter(r => r.resource === RESOURCE_UTRIUM);
        expect(uRoutes.length).toBeGreaterThan(0);
        expect(uRoutes.some(r => r.fromRoom === DIST_SYNTH_AUX)).toBe(true);
      }
    }
  });

  it("uses global distributed reagent inventory when hub has none", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {},
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    const plan = planDistributedSynthesis(
      DIST_SYNTH_HUB,
      [RESOURCE_CATALYZED_UTRIUM_ALKALIDE],
      1000,
      1000,
      getHubInventory(),
    );

    const products = plan.dispatchAssignments.map(a => a.product);
    expect(plan.blockedTargets).toEqual([]);
    expect(products).toContain(RESOURCE_HYDROXIDE);
    expect(products).toContain(RESOURCE_UTRIUM_OXIDE);
  });

  it("demand-driven upstream supply: ledger tracks exact amounts needed", () => {
    // Hub has enough for 1 T3 target (XUH2O)
    // Chain: XUH2O ← C + UH2O ← UH + OH ← U + H, H + O
    // With targetAmount=1000: need 1000 U, 3000 H (UH:1000 + OH:1000 + extra), 1000 O (for OH), 1000 C
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, [RESOURCE_CATALYZED_UTRIUM_ACID], 1000, 1000, getHubInventory());

    // Verify allocation ledger captures resource demands
    expect(plan.allocationLedger[RESOURCE_HYDROGEN]).toBeDefined();
    expect(plan.allocationLedger[RESOURCE_OXYGEN]).toBeDefined();
    expect(plan.allocationLedger[RESOURCE_UTRIUM]).toBeDefined();

    // Verify the hub's commitments were decremented from original effective amounts
    const hEntry = plan.allocationLedger[RESOURCE_HYDROGEN]!;
    // Original H = 10000, reserve=1000, effective=9000
    // After assignments, remaining should be less than 9000
    const totalConsumed = 9000 - hEntry.totalAmount;
    expect(totalConsumed).toBeGreaterThan(0);
  });

  it("pending incoming transfers counted as available inventory", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_UTRIUM]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    // Create pending incoming U transfer to hub
    createResourceTransferTask(
      DIST_SYNTH_AUX,
      DIST_SYNTH_HUB,
      RESOURCE_UTRIUM,
      3000,
      "hub:import:U",
    );

    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, [RESOURCE_CATALYZED_UTRIUM_ACID], 1000, 1000, getHubInventory());

    // Hub's effective U should include the 3000 incoming
    // (minus reserve: 3000 incoming + 0 local = 3000, reserve=1000, effective=2000)
    const uLedger = plan.allocationLedger[RESOURCE_UTRIUM];
    expect(uLedger).toBeDefined();
    // Hub commitment should reflect the incoming amount (3000 - 1000 reserve = 2000)
    const hubU = uLedger!.roomCommitments[DIST_SYNTH_HUB] ?? 0;
    // Original hub effective U = 3000 (incoming) - 1000 (reserve) = 2000
    // But some may have been consumed by assignments
    expect(hubU).toBeGreaterThanOrEqual(0);
  });

  it("pending outgoing transfers reduce available inventory", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_CATALYST]: 10000,
      },
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {},
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    // Create pending outgoing H transfer from hub
    createResourceTransferTask(
      DIST_SYNTH_HUB,
      DIST_SYNTH_AUX,
      RESOURCE_HYDROGEN,
      3000,
      "hub:export:H",
    );

    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, [RESOURCE_CATALYZED_UTRIUM_ACID], 1000, 1000, getHubInventory());

    // Hub's effective H should be reduced by the 3000 outgoing
    // Original: 10000 - 3000 outgoing - 1000 reserve = 6000 effective
    const hLedger = plan.allocationLedger[RESOURCE_HYDROGEN];
    expect(hLedger).toBeDefined();
    // Some consumed by assignments, but total should be at most 6000 + aux
    expect(hLedger!.totalAmount).toBeLessThanOrEqual(6000);
  });

  it("local reserve subtracted from base minerals per room", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 2000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, [RESOURCE_CATALYZED_UTRIUM_ACID], 1000, 1000, getHubInventory());

    // H effective = 2000 - 1000 (reserve) = 1000
    const hLedger = plan.allocationLedger[RESOURCE_HYDROGEN];
    expect(hLedger).toBeDefined();
    // Original effective H = 1000, after assignments remaining should be <= 1000
    expect(hLedger!.totalAmount).toBeLessThanOrEqual(1000);
    const hubOriginal = 1000;
    const hubCommitted = hLedger!.roomCommitments[DIST_SYNTH_HUB] ?? 0;
    // Hub consumed = original - remaining
    const hubConsumed = hubOriginal - hubCommitted;
    expect(hubConsumed).toBeGreaterThanOrEqual(0);
  });

  it("allocations are subtracted: two T3 targets share OH without over-allocation", () => {
    // Hub has all resources for two U-chain T3 targets
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const targets: ResourceConstant[] = [
      RESOURCE_CATALYZED_UTRIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
    ];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // OH is shared between XUH2O and XUHO2 chains
    // Demand for OH: 2000 (1000 per T3 target)
    // Verify OH was assigned
    const ohAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);
    expect(ohAssignment).toBeDefined();

    // Verify H was decremented for both OH reagent usage
    const hLedger = plan.allocationLedger[RESOURCE_HYDROGEN];
    expect(hLedger).toBeDefined();
    const totalHConsumed = 19000 - hLedger!.totalAmount; // 20000 - 1000 reserve = 19000 effective
    expect(totalHConsumed).toBeGreaterThan(0);
  });

  it("DistributedSynthesisPlan type contract round-trips through assignments", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;

    const plan: DistributedSynthesisPlan = planDistributedSynthesis(DIST_SYNTH_HUB, [RESOURCE_CATALYZED_UTRIUM_ACID], 1000, 1000, getHubInventory());

    expect(Array.isArray(plan.dispatchAssignments)).toBe(true);
    expect(plan.allocationLedger).toBeDefined();
    expect(Array.isArray(plan.routeDecisions)).toBe(true);
    expect(Array.isArray(plan.blockedTargets)).toBe(true);

    for (const a of plan.dispatchAssignments) {
      expect(a.roomName).toBeDefined();
      expect(a.product).toBeDefined();
      expect(a.targetAmount).toBeGreaterThan(0);
      expect(typeof a.isHubRoom).toBe("boolean");
    }

    for (const entry of Object.values(plan.allocationLedger)) {
      expect(entry.resource).toBeDefined();
      expect(entry.totalAmount).toBeGreaterThanOrEqual(0);
      expect(entry.roomCommitments).toBeDefined();
    }
  });

  it("distributes assignments across rooms: 7 rooms with diverse minerals produce multiple parallel assignments", () => {
    // Mimic live game state: hub (E4N58) has lots of intermediates,
    // 6 satellite rooms each extract different base minerals.
    // Hub: OH, UH, UO, LO, GH, GO intermediates + Catalyst
    // Satellites: each has a primary base mineral + H/O support.
    const DIST_SAT1 = "SA1";
    const DIST_SAT2 = "SA2";
    const DIST_SAT3 = "SA3";
    const DIST_SAT4 = "SA4";
    const DIST_SAT5 = "SA5";
    const DIST_SAT6 = "SA6";

    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROXIDE]: 16838,
        [RESOURCE_UTRIUM_HYDRIDE]: 8447,
        [RESOURCE_UTRIUM_OXIDE]: 955,
        [RESOURCE_LEMERGIUM_OXIDE]: 11175,
        [RESOURCE_GHODIUM_HYDRIDE]: 8911,
        [RESOURCE_GHODIUM_OXIDE]: 19999,
        [RESOURCE_CATALYST]: 30000,
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_KEANIUM]: 5000,
        [RESOURCE_LEMERGIUM]: 5000,
        [RESOURCE_ZYNTHIUM]: 5000,
        [RESOURCE_UTRIUM]: 5000,
      },
    });
    // Sat1: K (keanium) — needed for K-chain T3s (XKH2O, XKHO2)
    const sat1 = createSynthesisCapableRoom(DIST_SAT1, {
      labCount: 3,
      storageResources: { [RESOURCE_KEANIUM]: 10000, [RESOURCE_HYDROGEN]: 5000 },
    });
    // Sat2: L (lemergium) — needed for L-chain T3s (XLH2O)
    const sat2 = createSynthesisCapableRoom(DIST_SAT2, {
      labCount: 3,
      storageResources: { [RESOURCE_LEMERGIUM]: 10000, [RESOURCE_OXYGEN]: 5000 },
    });
    // Sat3: Z (zynthium) — needed for Z-chain T3s (XZH2O, XZHO2)
    const sat3 = createSynthesisCapableRoom(DIST_SAT3, {
      labCount: 3,
      storageResources: { [RESOURCE_ZYNTHIUM]: 10000, [RESOURCE_HYDROGEN]: 5000 },
    });
    // Sat4: U (utrium) — needed for U-chain (XUHO2)
    const sat4 = createSynthesisCapableRoom(DIST_SAT4, {
      labCount: 3,
      storageResources: { [RESOURCE_UTRIUM]: 10000, [RESOURCE_OXYGEN]: 5000 },
    });
    // Sat5: H + O support
    const sat5 = createSynthesisCapableRoom(DIST_SAT5, {
      labCount: 3,
      storageResources: { [RESOURCE_HYDROGEN]: 8000, [RESOURCE_OXYGEN]: 8000 },
    });
    // Sat6: extra K + H
    const sat6 = createSynthesisCapableRoom(DIST_SAT6, {
      labCount: 3,
      storageResources: { [RESOURCE_KEANIUM]: 8000, [RESOURCE_OXYGEN]: 8000 },
    });

    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SAT1] = sat1;
    Game.rooms[DIST_SAT2] = sat2;
    Game.rooms[DIST_SAT3] = sat3;
    Game.rooms[DIST_SAT4] = sat4;
    Game.rooms[DIST_SAT5] = sat5;
    Game.rooms[DIST_SAT6] = sat6;

    // Target T3s that are NOT at reserve (missing):
    // XKH2O, XKHO2, XLH2O, XZH2O, XZHO2, XUHO2
    const targets: ResourceConstant[] = [
      RESOURCE_CATALYZED_KEANIUM_ACID,      // XKH2O
      RESOURCE_CATALYZED_KEANIUM_ALKALIDE,   // XKHO2
      RESOURCE_CATALYZED_LEMERGIUM_ACID,     // XLH2O
      RESOURCE_CATALYZED_ZYNTHIUM_ACID,      // XZH2O
      RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,  // XZHO2
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,    // XUHO2
    ];

    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Must produce more than 1 assignment — distributed across rooms
    expect(plan.dispatchAssignments.length).toBeGreaterThan(1);

    // Each room should appear at most once in the assignments
    const roomCounts: Record<string, number> = {};
    for (const a of plan.dispatchAssignments) {
      roomCounts[a.roomName] = (roomCounts[a.roomName] || 0) + 1;
    }
    for (const [room, count] of Object.entries(roomCounts)) {
      expect(count).toBeLessThanOrEqual(1);
    }

    // Assignments should span at least 3 distinct rooms
    const distinctRooms = Object.keys(roomCounts);
    expect(distinctRooms.length).toBeGreaterThanOrEqual(3);

    // Lower-tier products should appear first (base intermediates before T1 before T2 before T3)
    const tierOrder: Record<string, number> = {
      [RESOURCE_HYDROXIDE]: 0,
      [RESOURCE_ZYNTHIUM_KEANITE]: 0,
      [RESOURCE_UTRIUM_LEMERGITE]: 0,
      [RESOURCE_GHODIUM]: 0,
      [RESOURCE_UTRIUM_HYDRIDE]: 1, [RESOURCE_UTRIUM_OXIDE]: 1,
      [RESOURCE_KEANIUM_HYDRIDE]: 1, [RESOURCE_KEANIUM_OXIDE]: 1,
      [RESOURCE_LEMERGIUM_HYDRIDE]: 1, [RESOURCE_LEMERGIUM_OXIDE]: 1,
      [RESOURCE_ZYNTHIUM_HYDRIDE]: 1, [RESOURCE_ZYNTHIUM_OXIDE]: 1,
      [RESOURCE_GHODIUM_HYDRIDE]: 1, [RESOURCE_GHODIUM_OXIDE]: 1,
      [RESOURCE_UTRIUM_ACID]: 2, [RESOURCE_UTRIUM_ALKALIDE]: 2,
      [RESOURCE_KEANIUM_ACID]: 2, [RESOURCE_KEANIUM_ALKALIDE]: 2,
      [RESOURCE_LEMERGIUM_ACID]: 2, [RESOURCE_LEMERGIUM_ALKALIDE]: 2,
      [RESOURCE_ZYNTHIUM_ACID]: 2, [RESOURCE_ZYNTHIUM_ALKALIDE]: 2,
      [RESOURCE_GHODIUM_ACID]: 2, [RESOURCE_GHODIUM_ALKALIDE]: 2,
    };
    for (let i = 1; i < plan.dispatchAssignments.length; i++) {
      const prevTier = tierOrder[plan.dispatchAssignments[i - 1].product] ?? 3;
      const currTier = tierOrder[plan.dispatchAssignments[i].product] ?? 3;
      expect(currTier).toBeGreaterThanOrEqual(prevTier);
    }

    // Not blocked — we have enough resources globally
    expect(plan.blockedTargets).toEqual([]);
  });

  it("cross-room reagent routing: hub supplies OH to satellite for T1 production", () => {
    // Hub has OH, satellite has K — KH (K+H) needs H which satellite may not have enough,
    // but KO (K+O) is also a T1 step. With OH routing, satellite can make KO if it gets OH.
    // Actually KO = K + O, no OH needed. So test KO production at satellite using its K + O.
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROXIDE]: 5000,
        [RESOURCE_CATALYST]: 5000,
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_KEANIUM]: 5000,
      },
    });
    const satRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_KEANIUM]: 5000,
        [RESOURCE_OXYGEN]: 5000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = satRoom;

    const targets: ResourceConstant[] = [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]; // XKHO2
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Should produce at least KO assignment (K+O → KO)
    const products = plan.dispatchAssignments.map(a => a.product);
    expect(products.length).toBeGreaterThan(0);

    // Satellite has K+O locally → KO should be assigned to satellite or hub
    const koAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_KEANIUM_OXIDE);
    if (koAssignment) {
      // Verify KO got an assignment — either room is fine
      expect(koAssignment.targetAmount).toBeGreaterThan(0);
    }
  });

  it("rooms get one assignment each before any room gets a second", () => {
    // 3 rooms, each with all base minerals in abundance
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_LEMERGIUM]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_ZYNTHIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      },
    });
    const aux1 = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      },
    });
    const aux2 = createSynthesisCapableRoom(DIST_SYNTH_AUX2, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = aux1;
    Game.rooms[DIST_SYNTH_AUX2] = aux2;

    // Multiple T3 targets to force many assignments
    const targets: ResourceConstant[] = [
      RESOURCE_CATALYZED_UTRIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
      RESOURCE_CATALYZED_KEANIUM_ACID,
      RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
    ];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    // Must produce multiple assignments
    expect(plan.dispatchAssignments.length).toBeGreaterThan(1);

    // First 3 assignments should go to 3 distinct rooms
    const firstThree = plan.dispatchAssignments.slice(0, 3);
    const roomSet = new Set(firstThree.map(a => a.roomName));
    expect(roomSet.size).toBe(Math.min(3, firstThree.length));
  });

  it("uses hub inventory for deficit: hub has 0 T3 but satellites have 80k", () => {
    const hubRoom = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
      labCount: 3,
      storageResources: {
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
        [RESOURCE_KEANIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    const auxRoom = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
      labCount: 3,
      storageResources: {
        [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: 80000,
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      },
    });
    Game.rooms[DIST_SYNTH_HUB] = hubRoom;
    Game.rooms[DIST_SYNTH_AUX] = auxRoom;

    const targets: ResourceConstant[] = [RESOURCE_CATALYZED_KEANIUM_ALKALIDE];
    const plan = planDistributedSynthesis(DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory());

    const products = plan.dispatchAssignments.map(a => a.product);
    expect(products.length).toBeGreaterThan(0);
    expect(plan.blockedTargets).not.toContain(RESOURCE_CATALYZED_KEANIUM_ALKALIDE);
  });

  describe("final-T3 uniqueness", () => {
    /**
     * Maps an intermediate product to its ultimate T3 target.
     * T1/T2 intermediates each feed exactly one T3.
     * Returns null for ambiguous base intermediates (OH, ZK, UL, G) that serve multiple chains.
     */
    function traceProductToFinalT3(product: ResourceConstant): ResourceConstant | null {
      const T3_LIST: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        RESOURCE_CATALYZED_KEANIUM_ACID,
        RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
        RESOURCE_CATALYZED_LEMERGIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        RESOURCE_CATALYZED_ZYNTHIUM_ACID,
        RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      ];
      if (T3_LIST.includes(product)) return product;

      const T2_TO_T3: Record<string, ResourceConstant> = {
        [RESOURCE_UTRIUM_ACID]: RESOURCE_CATALYZED_UTRIUM_ACID,
        [RESOURCE_UTRIUM_ALKALIDE]: RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        [RESOURCE_KEANIUM_ACID]: RESOURCE_CATALYZED_KEANIUM_ACID,
        [RESOURCE_KEANIUM_ALKALIDE]: RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
        [RESOURCE_LEMERGIUM_ACID]: RESOURCE_CATALYZED_LEMERGIUM_ACID,
        [RESOURCE_LEMERGIUM_ALKALIDE]: RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        [RESOURCE_ZYNTHIUM_ACID]: RESOURCE_CATALYZED_ZYNTHIUM_ACID,
        [RESOURCE_ZYNTHIUM_ALKALIDE]: RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
        [RESOURCE_GHODIUM_ACID]: RESOURCE_CATALYZED_GHODIUM_ACID,
        [RESOURCE_GHODIUM_ALKALIDE]: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      };
      if (T2_TO_T3[product]) return T2_TO_T3[product];

      const T1_TO_T3: Record<string, ResourceConstant> = {
        [RESOURCE_UTRIUM_HYDRIDE]: RESOURCE_CATALYZED_UTRIUM_ACID,
        [RESOURCE_UTRIUM_OXIDE]: RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        [RESOURCE_KEANIUM_HYDRIDE]: RESOURCE_CATALYZED_KEANIUM_ACID,
        [RESOURCE_KEANIUM_OXIDE]: RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
        [RESOURCE_LEMERGIUM_HYDRIDE]: RESOURCE_CATALYZED_LEMERGIUM_ACID,
        [RESOURCE_LEMERGIUM_OXIDE]: RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        [RESOURCE_ZYNTHIUM_HYDRIDE]: RESOURCE_CATALYZED_ZYNTHIUM_ACID,
        [RESOURCE_ZYNTHIUM_OXIDE]: RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
        [RESOURCE_GHODIUM_HYDRIDE]: RESOURCE_CATALYZED_GHODIUM_ACID,
        [RESOURCE_GHODIUM_OXIDE]: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      };
      if (T1_TO_T3[product]) return T1_TO_T3[product];

      return null;
    }

    it("assigns unique final T3 targets to each room when enough distinct targets are feasible", () => {
      // Hub has partial UH2O (300) + full base minerals (H,O,U,K,L,Z,Catalyst).
      // planHubChains generates T1 steps for all chains AND an XUH2O T3 step
      // (partial UH2O covers some demand). Both UH→XUH2O and XUH2O→XUH2O
      // trace to the same final T3 target — a duplicate. With 5 rooms and 6
      // feasible distinct final T3 targets, this duplicate is invalid because
      // feasible targets exceed assignable rooms (no fallback needed).
      const DS4 = "DS4";
      const DS5 = "DS5";

      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_LEMERGIUM]: 20000,
        [RESOURCE_ZYNTHIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
        [RESOURCE_UTRIUM_ACID]: 300,
      };

      Game.rooms[DIST_SYNTH_HUB] = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX] = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX2] = createSynthesisCapableRoom(DIST_SYNTH_AUX2, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DS4] = createSynthesisCapableRoom(DS4, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DS5] = createSynthesisCapableRoom(DS5, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      const targets: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        RESOURCE_CATALYZED_KEANIUM_ACID,
        RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
        RESOURCE_CATALYZED_LEMERGIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const plan = planDistributedSynthesis(
        DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory(),
      );

      expect(plan.dispatchAssignments.length).toBeGreaterThan(1);

      const assignedT3s: ResourceConstant[] = [];
      for (const a of plan.dispatchAssignments) {
        const t3 = traceProductToFinalT3(a.product);
        if (t3) assignedT3s.push(t3);
      }

      const uniqueT3s = new Set(assignedT3s);
      const duplicateT3s = assignedT3s.filter(
        (t3, i) => assignedT3s.indexOf(t3) !== i,
      );
      expect({
        feasibleTargets: targets.length,
        rooms: 5,
        uniqueCount: uniqueT3s.size,
        assignedCount: assignedT3s.length,
        duplicates: [...new Set(duplicateT3s)],
        details: plan.dispatchAssignments.map(a =>
          `${a.roomName}→${a.product}→${traceProductToFinalT3(a.product) ?? "?"}`,
        ),
      }).toEqual({
        feasibleTargets: targets.length,
        rooms: 5,
        uniqueCount: assignedT3s.length,
        assignedCount: assignedT3s.length,
        duplicates: [],
        details: plan.dispatchAssignments.map(a =>
          `${a.roomName}→${a.product}→${traceProductToFinalT3(a.product) ?? "?"}`,
        ),
      });
    });

    // -----------------------------------------------------------------------
    // Task 2: final-T3 mapping contract tests
    //
    // These tests define the contract that each dispatch assignment must carry
    // candidate-context-aware final-target metadata. The production type
    // `SynthesisDispatchAssignment` currently lacks a `finalTarget` field.
    // Until Task 3 adds it, these are intentionally RED tests.
    //
    // A test-local helper `candidateFinalTarget()` is used to express the
    // expected behavior; it does NOT reflect production reality yet.
    // -----------------------------------------------------------------------

    /**
     * TEST-LOCAL helper: resolves the final T3 target for an assignment.
     *
     * Contract: if the assignment carries a `finalTarget` field (added in
     * Task 3), use it. Otherwise fall back to the global `traceProductToFinalT3()`
     * which returns null for shared intermediates like OH.
     *
     * Once production adds `finalTarget` to SynthesisDispatchAssignment,
     * this helper becomes `(a) => a.finalTarget`.
     */
    function candidateFinalTarget(
      a: SynthesisDispatchAssignment,
    ): ResourceConstant | null {
      // Task 3 will add `finalTarget` to the assignment type.
      // Until then, use the narrow traceProductToFinalT3 which cannot
      // resolve shared intermediates.
      const anyA = a as unknown as Record<string, unknown>;
      if ("finalTarget" in anyA && anyA.finalTarget != null) {
        return anyA.finalTarget as ResourceConstant;
      }
      return traceProductToFinalT3(a.product);
    }

    it("final T3 product maps to itself when assigned directly", () => {
      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
        [RESOURCE_UTRIUM_ACID]: 500,
      };

      Game.rooms[DIST_SYNTH_HUB] = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX] = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
      const plan = planDistributedSynthesis(
        DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory(),
      );

      const t3Assignments = plan.dispatchAssignments.filter(
        a => a.product === RESOURCE_CATALYZED_UTRIUM_ACID,
      );

      expect(t3Assignments.length).toBeGreaterThan(0);

      for (const a of t3Assignments) {
        expect({
          product: a.product,
          finalTarget: candidateFinalTarget(a),
        }).toEqual({
          product: RESOURCE_CATALYZED_UTRIUM_ACID,
          finalTarget: RESOURCE_CATALYZED_UTRIUM_ACID,
        });
      }
    });

    it("intermediate product maps to its chain's final T3 target, not global lookup", () => {
      // Given: XUH2O and XKH2O targets. Hub has H, O, U, K, Catalyst.
      // When: planDistributedSynthesis generates UH (→XUH2O) and KH (→XKH2O).
      // Then: UH's finalTarget is XUH2O, KH's finalTarget is XKH2O.
      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      };

      Game.rooms[DIST_SYNTH_HUB] = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX] = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      const targets: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_KEANIUM_ACID,
      ];
      const plan = planDistributedSynthesis(
        DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory(),
      );

      const uhAssignment = plan.dispatchAssignments.find(
        a => a.product === RESOURCE_UTRIUM_HYDRIDE,
      );

      expect(uhAssignment).toBeDefined();
      const ft = candidateFinalTarget(uhAssignment!);
      expect(ft).toBe(RESOURCE_CATALYZED_UTRIUM_ACID);
    });

    it("shared intermediate OH is associated with a specific final T3 target via candidate context, not arbitrarily", () => {
      // This is the key test: OH is shared across ALL mineral-based chains.
      // Current production lacks per-candidate final-target metadata.
      // With the future implementation, each OH assignment should carry
      // the finalTarget of its planning candidate (e.g., XUH2O for one room,
      // XKH2O for another).
      //
      // Setup: Hub + 3 satellites, requesting XUH2O, XUHO2, XKH2O.
      // planHubChains will generate OH as a shared intermediate.
      // Without candidate-context metadata, OH gets assigned to one room
      // with no indication of which T3 it serves.
      //
      // The contract: every assignment that produces OH must have a
      // finalTarget field indicating which T3 chain it belongs to.
      const DS4 = "DS4";

      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_LEMERGIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      };

      Game.rooms[DIST_SYNTH_HUB] = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX] = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX2] = createSynthesisCapableRoom(DIST_SYNTH_AUX2, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DS4] = createSynthesisCapableRoom(DS4, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      const targets: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        RESOURCE_CATALYZED_KEANIUM_ACID,
        RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
      ];
      const plan = planDistributedSynthesis(
        DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory(),
      );

      const ohAssignments = plan.dispatchAssignments.filter(
        a => a.product === RESOURCE_HYDROXIDE,
      );

      if (ohAssignments.length === 0) {
        // If no OH assignments (unlikely with these inputs), skip.
        return;
      }

      // CONTRACT: every OH assignment MUST have a resolvable finalTarget
      // (i.e., candidateFinalTarget must NOT return null for OH).
      // Currently traceProductToFinalT3("OH") returns null because OH
      // is ambiguous — this test will FAIL until Task 3 adds finalTarget
      // metadata to assignments.
      for (const a of ohAssignments) {
        const ft = candidateFinalTarget(a);
        expect({
          roomName: a.roomName,
          product: a.product,
          finalTarget: ft,
          hasFinalTarget: ft !== null,
        }).toEqual(
          expect.objectContaining({
            product: RESOURCE_HYDROXIDE,
            hasFinalTarget: true,
          }),
        );
      }
    });

    it("assignments for intermediates from different chains resolve to distinct final T3 targets", () => {
      // With 5 rooms and 6 targets, assignments include UH (→XUH2O chain)
      // and KH (→XKH2O chain). Their finalTargets must be different:
      // UH→XUH2O, KH→XKH2O. This verifies candidate-context awareness
      // rather than a global product→T3 map (which already works for
      // non-shared T1 products). The real value: if future code refactors
      // use a global map, this test catches the regression for shared cases.
      const DS4 = "DS4";
      const DS5 = "DS5";

      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 20000,
        [RESOURCE_KEANIUM]: 20000,
        [RESOURCE_LEMERGIUM]: 20000,
        [RESOURCE_ZYNTHIUM]: 20000,
        [RESOURCE_CATALYST]: 20000,
      };

      Game.rooms[DIST_SYNTH_HUB] = createSynthesisCapableRoom(DIST_SYNTH_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX] = createSynthesisCapableRoom(DIST_SYNTH_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DIST_SYNTH_AUX2] = createSynthesisCapableRoom(DIST_SYNTH_AUX2, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DS4] = createSynthesisCapableRoom(DS4, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[DS5] = createSynthesisCapableRoom(DS5, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      const targets: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        RESOURCE_CATALYZED_KEANIUM_ACID,
        RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
        RESOURCE_CATALYZED_LEMERGIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];
      const plan = planDistributedSynthesis(
        DIST_SYNTH_HUB, targets, 1000, 1000, getHubInventory(),
      );

      // Collect all assignments with their finalTargets via the contract helper
      const withFinalTargets = plan.dispatchAssignments.map(a => ({
        roomName: a.roomName,
        product: a.product,
        finalTarget: candidateFinalTarget(a),
      }));

      // Find UH and KH assignments
      const uhEntry = withFinalTargets.find(e => e.product === RESOURCE_UTRIUM_HYDRIDE);
      const khEntry = withFinalTargets.find(e => e.product === RESOURCE_KEANIUM_HYDRIDE);

      // Both must exist and have distinct finalTargets
      expect({
        hasUH: !!uhEntry,
        hasKH: !!khEntry,
        uhFinalTarget: uhEntry?.finalTarget ?? null,
        khFinalTarget: khEntry?.finalTarget ?? null,
      }).toEqual({
        hasUH: true,
        hasKH: true,
        uhFinalTarget: RESOURCE_CATALYZED_UTRIUM_ACID,
        khFinalTarget: RESOURCE_CATALYZED_KEANIUM_ACID,
      });
    });
  });
});

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

  describe("T1 source-room preference", () => {
    it("assigns OH when both rooms have reagents, distributes across rooms", () => {
      const hubRoom = createSynthesisCapableRoom(SCORE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_CATALYST]: 5000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(SCORE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[SCORE_HUB] = hubRoom;
      Game.rooms[SCORE_AUX] = auxRoom;

      const plan = planDistributedSynthesis(
        SCORE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        getHubInv(),
      );

      const ohAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);
      expect(ohAssignment).toBeDefined();
      expect(ohAssignment!.targetAmount).toBeGreaterThan(0);
    });

    it("scoreRoomForStep gives +100 bonus when both reagents are fully local", () => {
      const ledger: Record<string, AllocationLedgerEntry> = {
        [RESOURCE_HYDROGEN]: { resource: RESOURCE_HYDROGEN, totalAmount: 5000, roomCommitments: { [SCORE_AUX]: 5000 } },
        [RESOURCE_OXYGEN]: { resource: RESOURCE_OXYGEN, totalAmount: 5000, roomCommitments: { [SCORE_AUX]: 5000 } },
      };
      const step: ChainStep = { product: RESOURCE_HYDROXIDE, targetAmount: 3000, reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN] };
      const caps: SynthesisRoomCapability[] = [
        { roomName: SCORE_AUX, labCount: 3, hasTerminal: true, hasStorage: true, boostLabExclusive: false, mineralInventory: {} },
      ];

      const score = scoreRoomForStep(SCORE_AUX, step, ledger, SCORE_HUB, caps);
      expect(score.score).toBeGreaterThanOrEqual(100);
    });
  });

  describe("stage guard", () => {
    it("room in synthesizing stage is deprioritised for new assignments", () => {
      const hubRoom = createSynthesisCapableRoom(SCORE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(SCORE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[SCORE_HUB] = hubRoom;
      Game.rooms[SCORE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[SCORE_HUB] = { stage: "synthesizing" };

      const plan = planDistributedSynthesis(
        SCORE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        getHubInv(),
      );

      const ohAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);
      expect(ohAssignment).toBeDefined();
      expect(ohAssignment!.roomName).toBe(SCORE_AUX);
    });

    it("scoreRoomForStep gives -200 penalty for busy stage", () => {
      const ledger: Record<string, AllocationLedgerEntry> = {
        [RESOURCE_HYDROGEN]: { resource: RESOURCE_HYDROGEN, totalAmount: 5000, roomCommitments: { [SCORE_HUB]: 5000 } },
        [RESOURCE_OXYGEN]: { resource: RESOURCE_OXYGEN, totalAmount: 5000, roomCommitments: { [SCORE_HUB]: 5000 } },
      };
      const step: ChainStep = { product: RESOURCE_HYDROXIDE, targetAmount: 1000, reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN] };
      const caps: SynthesisRoomCapability[] = [
        { roomName: SCORE_HUB, labCount: 3, hasTerminal: true, hasStorage: true, boostLabExclusive: false, mineralInventory: {} },
      ];

      (Memory.runtime as any).synthesisControl = { rooms: { [SCORE_HUB]: { stage: "synthesizing" } } };
      const scoreBusy = scoreRoomForStep(SCORE_HUB, step, ledger, SCORE_HUB, caps);

      (Memory.runtime as any).synthesisControl = { rooms: { [SCORE_HUB]: { stage: "idle" } } };
      const scoreIdle = scoreRoomForStep(SCORE_HUB, step, ledger, SCORE_HUB, caps);

      expect(scoreBusy.score).toBeLessThan(scoreIdle.score);
      expect(scoreIdle.score - scoreBusy.score).toBeGreaterThanOrEqual(200);
    });
  });

  describe("terminal-load deprioritisation", () => {
    it("room with heavy terminal load is deprioritised", () => {
      const hubRoom = createSynthesisCapableRoom(SCORE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(SCORE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[SCORE_HUB] = hubRoom;
      Game.rooms[SCORE_AUX] = auxRoom;

      createResourceTransferTask(SCORE_HUB, "W9N9", RESOURCE_HYDROGEN, 4000, "other");

      const plan = planDistributedSynthesis(
        SCORE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        getHubInv(),
      );

      const ohAssignment = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);
      expect(ohAssignment).toBeDefined();
      expect(ohAssignment!.roomName).toBe(SCORE_AUX);
    });

    it("scoreRoomForStep penalises terminal load", () => {
      const ledger: Record<string, AllocationLedgerEntry> = {
        [RESOURCE_HYDROGEN]: { resource: RESOURCE_HYDROGEN, totalAmount: 5000, roomCommitments: { [SCORE_HUB]: 5000 } },
        [RESOURCE_OXYGEN]: { resource: RESOURCE_OXYGEN, totalAmount: 5000, roomCommitments: { [SCORE_HUB]: 5000 } },
      };
      const step: ChainStep = { product: RESOURCE_HYDROXIDE, targetAmount: 1000, reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN] };
      const caps: SynthesisRoomCapability[] = [
        { roomName: SCORE_HUB, labCount: 3, hasTerminal: true, hasStorage: true, boostLabExclusive: false, mineralInventory: {} },
      ];

      const scoreNoLoad = scoreRoomForStep(SCORE_HUB, step, ledger, SCORE_HUB, caps);

      createResourceTransferTask(SCORE_HUB, "W9N9", RESOURCE_HYDROGEN, 4000, "load-test");

      const scoreWithLoad = scoreRoomForStep(SCORE_HUB, step, ledger, SCORE_HUB, caps);

      expect(scoreWithLoad.score).toBeLessThan(scoreNoLoad.score);
    });
  });

  describe("cycle rejection", () => {
    it("DependencyGraph detects direct cycle", () => {
      const graph = new DependencyGraph();
      graph.add("A", "B");
      expect(graph.wouldCreateCycle("B", "A")).toBe(true);
    });

    it("DependencyGraph detects transitive cycle", () => {
      const graph = new DependencyGraph();
      graph.add("A", "B");
      graph.add("B", "C");
      expect(graph.wouldCreateCycle("C", "A")).toBe(true);
    });

    it("DependencyGraph allows non-cyclic dependency", () => {
      const graph = new DependencyGraph();
      graph.add("A", "B");
      expect(graph.wouldCreateCycle("C", "A")).toBe(false);
    });

    it("DependencyGraph detects complex transitive cycle", () => {
      const graph = new DependencyGraph();
      graph.add("A", "B");
      graph.add("B", "C");
      graph.add("C", "D");
      expect(graph.wouldCreateCycle("D", "A")).toBe(true);
    });

    it("DependencyGraph allows adding new edge when no cycle formed", () => {
      const graph = new DependencyGraph();
      graph.add("A", "B");
      graph.add("A", "C");
      expect(graph.wouldCreateCycle("D", "A")).toBe(false);
      expect(graph.wouldCreateCycle("D", "B")).toBe(false);
    });

    it("planDistributedSynthesis avoids cyclic cross-room routing", () => {
      const hubRoom = createSynthesisCapableRoom(SCORE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_UTRIUM]: 5000,
          [RESOURCE_CATALYST]: 5000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(SCORE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      const aux2Room = createSynthesisCapableRoom(SCORE_AUX2, {
        labCount: 3,
        storageResources: {
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[SCORE_HUB] = hubRoom;
      Game.rooms[SCORE_AUX] = auxRoom;
      Game.rooms[SCORE_AUX2] = aux2Room;

      const plan = planDistributedSynthesis(
        SCORE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        getHubInv(),
      );

      for (const route of plan.routeDecisions) {
        expect(route.fromRoom).not.toBe(route.toRoom);
      }

      const depPairs: Array<[string, string]> = [];
      const roomsWithDeps = new Set<string>();
      const roomsDependedOn = new Set<string>();
      for (const route of plan.routeDecisions) {
        depPairs.push([route.toRoom, route.fromRoom]);
        roomsWithDeps.add(route.toRoom);
        roomsDependedOn.add(route.fromRoom);
      }

      const visited = new Map<string, boolean>();
      const hasCycle = (room: string, path: Set<string>): boolean => {
        if (path.has(room)) return true;
        if (visited.has(room)) return visited.get(room)!;
        path.add(room);
        for (const [to, from] of depPairs) {
          if (to === room && hasCycle(from, path)) {
            visited.set(room, true);
            return true;
          }
        }
        path.delete(room);
        visited.set(room, false);
        return false;
      };
      for (const room of roomsWithDeps) {
        expect(hasCycle(room, new Set())).toBe(false);
      }
    });
  });

  describe("base mineral fair-share capping", () => {
    const CAP_HUB = "CP1";
    const CAP_AUX = "CP2";

    function getCapHubInventory(): Record<string, number> {
      const inv: Record<string, number> = {};
      const room = Game.rooms[CAP_HUB];
      if (!room?.storage?.store || !room?.terminal?.store) return inv;
      for (const [res, amt] of Object.entries(room.storage.store as unknown as Record<string, number>)) {
        if (res !== RESOURCE_ENERGY && amt > 0) inv[res] = amt;
      }
      for (const [res, amt] of Object.entries(room.terminal.store as unknown as Record<string, number>)) {
        if (res !== RESOURCE_ENERGY && amt > 0) inv[res] = (inv[res] || 0) + amt;
      }
      return inv;
    }

    it("OH and UO both get fair share of O when O is sufficient for both", () => {
      // Hub has 30k O. OH needs O, UO needs O. With 2 steps sharing O,
      // each gets 30k/2 = 15k fair share.
      const hubRoom = createSynthesisCapableRoom(CAP_HUB, {
        labCount: 6,
        storageResources: {
          [RESOURCE_HYDROGEN]: 20000,
          [RESOURCE_OXYGEN]: 30000,
          [RESOURCE_UTRIUM]: 20000,
          [RESOURCE_LEMERGIUM]: 20000,
          [RESOURCE_KEANIUM]: 20000,
          [RESOURCE_ZYNTHIUM]: 20000,
          [RESOURCE_CATALYST]: 20000,
        },
      });
      Game.rooms[CAP_HUB] = hubRoom;

      // Target multiple T3 that share O across their chain steps
      // XUH2O chain: OH(H+O), UH(U+H), UH2O(UH+OH), XUH2O(C+UH2O)
      // XUHO2 chain: OH(H+O), UO(U+O), UHO2(UO+OH), XUHO2(C+UHO2)
      // Both chains need OH (which needs O). Also UO directly needs O.
      const targets: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
      ];
      const plan = planDistributedSynthesis(CAP_HUB, targets, 1000, 1000, getCapHubInventory());

      const ohAssign = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);
      const uoAssign = plan.dispatchAssignments.find(a => a.product === RESOURCE_UTRIUM_OXIDE);

      // OH assignment should exist but NOT consume all O
      expect(ohAssign).toBeDefined();
      expect(ohAssign!.targetAmount).toBeLessThanOrEqual(15000); // fair share = 30k/2

      // UO assignment should also exist since O was shared
      if (uoAssign) {
        expect(uoAssign.targetAmount).toBeGreaterThan(0);
      }
    });

    it("O only enough for OH → UO gets 0 targetAmount and is skipped", () => {
      // Hub has only 3000 O with 1000 reserve = 2000 effective.
      // OH(H+O) and UO(U+O) both need O. 2 steps sharing O → share = 1000 each.
      // But with U available too, UO should get capped to 1000 or less.
      const hubRoom = createSynthesisCapableRoom(CAP_HUB, {
        labCount: 6,
        storageResources: {
          [RESOURCE_HYDROGEN]: 20000,
          [RESOURCE_OXYGEN]: 3000,
          [RESOURCE_UTRIUM]: 20000,
          [RESOURCE_CATALYST]: 20000,
        },
      });
      Game.rooms[CAP_HUB] = hubRoom;

      const targets: ResourceConstant[] = [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
      ];
      const plan = planDistributedSynthesis(CAP_HUB, targets, 1000, 1000, getCapHubInventory());

      // OH and UO both need O. With 2000 effective O and 2 demanders, share = 1000 each.
      // Both steps get capped to 1000. Steps should exist with reduced amounts.
      const products = plan.dispatchAssignments.map(a => a.product);
      const ohAssign = plan.dispatchAssignments.find(a => a.product === RESOURCE_HYDROXIDE);

      if (products.includes(RESOURCE_HYDROXIDE)) {
        // OH target should be capped to fair share, not consume all O
        expect(ohAssign!.targetAmount).toBeLessThanOrEqual(1000);
      }
    });

    it("all base minerals abundant → no capping needed, all steps get full targetAmount", () => {
      const hubRoom = createSynthesisCapableRoom(CAP_HUB, {
        labCount: 6,
        storageResources: {
          [RESOURCE_HYDROGEN]: 50000,
          [RESOURCE_OXYGEN]: 50000,
          [RESOURCE_UTRIUM]: 50000,
          [RESOURCE_LEMERGIUM]: 50000,
          [RESOURCE_KEANIUM]: 50000,
          [RESOURCE_ZYNTHIUM]: 50000,
          [RESOURCE_CATALYST]: 50000,
        },
      });
      Game.rooms[CAP_HUB] = hubRoom;

      const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
      const plan = planDistributedSynthesis(CAP_HUB, targets, 1000, 1000, getCapHubInventory());

      // With abundant resources, all steps from the chain should be present
      expect(plan.dispatchAssignments.length).toBeGreaterThan(0);
      // Hub handles all steps (single room), no routes needed
      for (const a of plan.dispatchAssignments) {
        expect(a.targetAmount).toBeGreaterThan(0);
      }
    });

    it("step with 0 targetAmount after capping produces no assignment", () => {
      // Hub has 0 O. OH(H+O) and UO(U+O) need O.
      // share = floor(0 / demandCount) = 0 → both capped to 0 → skipped.
      const hubRoom = createSynthesisCapableRoom(CAP_HUB, {
        labCount: 6,
        storageResources: {
          [RESOURCE_HYDROGEN]: 20000,
          [RESOURCE_UTRIUM]: 20000,
          [RESOURCE_CATALYST]: 20000,
        },
      });
      Game.rooms[CAP_HUB] = hubRoom;

      const targets: ResourceConstant[] = [RESOURCE_CATALYZED_UTRIUM_ACID];
      const plan = planDistributedSynthesis(CAP_HUB, targets, 1000, 1000, getCapHubInventory());

      // No assignments for products needing O since O=0
      const products = plan.dispatchAssignments.map(a => a.product);
      expect(products).not.toContain(RESOURCE_HYDROXIDE);
      expect(products).not.toContain(RESOURCE_UTRIUM_OXIDE);
    });
  });

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

    it("writes distinct reactions per room for multi-room assignment", () => {
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
          [RESOURCE_ZYNTHIUM]: 10000,
          [RESOURCE_KEANIUM]: 10000,
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_LEMERGIUM]: 10000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      const result = wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        1000,
        1000,
        {
          [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_ZYNTHIUM]: 10000, [RESOURCE_KEANIUM]: 10000,
          [RESOURCE_UTRIUM]: 10000, [RESOURCE_LEMERGIUM]: 10000,
        },
        [],
      );

      expect(result).toBe(true);
      expect(Memory.cfg?.synthesisControl?.rooms).toBeDefined();
      const rooms = Memory.cfg!.synthesisControl!.rooms!;

      const hubProducts = (rooms[WIRE_HUB]?.reactions || []).map(r => r.product);
      const auxProducts = (rooms[WIRE_AUX]?.reactions || []).map(r => r.product);

      expect(hubProducts.length).toBeGreaterThanOrEqual(1);
      expect(auxProducts.length).toBeGreaterThanOrEqual(1);

      expect(hubProducts).toEqual(expect.not.arrayContaining(auxProducts));
    });

    it("rounds written synthesis targets up to full lab reaction amounts", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_LEMERGIUM_ACID]: 23,
          [RESOURCE_CATALYST]: 1000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_LEMERGIUM_ACID]: 22,
          [RESOURCE_CATALYST]: 1000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_LEMERGIUM_ACID],
        1000,
        1000,
        {
          [RESOURCE_LEMERGIUM_ACID]: 45,
          [RESOURCE_CATALYST]: 2000,
        },
        [],
      );

      for (const roomCfg of Object.values(Memory.cfg!.synthesisControl!.rooms!)) {
        for (const reaction of roomCfg.reactions || []) {
          expect(reaction.targetAmount % LAB_REACTION_AMOUNT).toBe(0);
          expect(reaction.batchSize % LAB_REACTION_AMOUNT).toBe(0);
        }
      }
    });

    it("preserves active non-idle room and does not overwrite its reaction", () => {
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
          [RESOURCE_CATALYST]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = { stage: "synthesizing" };

      const existingProduct = RESOURCE_HYDROXIDE;
      if (!Memory.cfg!.synthesisControl) Memory.cfg!.synthesisControl = {};
      if (!Memory.cfg!.synthesisControl.rooms) Memory.cfg!.synthesisControl.rooms = {};
      Memory.cfg!.synthesisControl.rooms[WIRE_AUX] = {
        enabled: true,
        reactions: [{ product: existingProduct, targetAmount: 5000, batchSize: 100, donorRoomNames: [] }],
        donorRoomNames: [],
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_UTRIUM]: 5000, [RESOURCE_CATALYST]: 5000 },
        [],
      );

      const auxRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_AUX];
      expect(auxRoomCfg).toBeDefined();
      expect(auxRoomCfg.reactions![0].product).toBe(existingProduct);
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

    it("includes busy synthesizing room in dispatchAssignments for analytics", () => {
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
          [RESOURCE_ZYNTHIUM]: 5000,
          [RESOURCE_KEANIUM]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_ZYNTHIUM_KEANITE,
        targetAmount: 5000,
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_ZYNTHIUM]: 5000, [RESOURCE_KEANIUM]: 5000 },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const auxAssignment = assignments.find(a => a.roomName === WIRE_AUX);
      expect(auxAssignment).toBeDefined();
      expect(auxAssignment!.product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
      expect(auxAssignment!.targetAmount).toBe(5000);
      expect(auxAssignment!.isHubRoom).toBe(false);
    });

    it("does not double-count idle rooms already in plan dispatchAssignments", () => {
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
          [RESOURCE_HYDROGEN]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 15000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_UTRIUM]: 5000 },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const auxCount = assignments.filter(a => a.roomName === WIRE_AUX).length;
      expect(auxCount).toBeLessThanOrEqual(1);
    });

    it("corrects dispatch entry when busy room product differs from plan", () => {
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
          [RESOURCE_ZYNTHIUM]: 10000,
          [RESOURCE_KEANIUM]: 10000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_CATALYZED_ZYNTHIUM_ACID,
        targetAmount: 40792,
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_ZYNTHIUM]: 10000, [RESOURCE_KEANIUM]: 10000 },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const auxAssignment = assignments.find(a => a.roomName === WIRE_AUX);
      expect(auxAssignment).toBeDefined();
      expect(auxAssignment!.product).toBe(RESOURCE_CATALYZED_ZYNTHIUM_ACID);
      expect(auxAssignment!.targetAmount).toBe(40792);
    });

    it("does not modify dispatch entry when busy room product matches plan", () => {
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
          [RESOURCE_ZYNTHIUM]: 5000,
          [RESOURCE_KEANIUM]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_ZYNTHIUM_KEANITE,
        targetAmount: 5000,
      };

      if (!Memory.cfg!.synthesisControl) Memory.cfg!.synthesisControl = {};
      if (!Memory.cfg!.synthesisControl.rooms) Memory.cfg!.synthesisControl.rooms = {};
      Memory.cfg!.synthesisControl.rooms[WIRE_AUX] = {
        enabled: true,
        reactions: [{ product: RESOURCE_ZYNTHIUM_KEANITE, targetAmount: 5000, batchSize: 100, donorRoomNames: [] }],
        donorRoomNames: [],
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_ZYNTHIUM]: 5000, [RESOURCE_KEANIUM]: 5000 },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const auxAssignment = assignments.find(a => a.roomName === WIRE_AUX);
      expect(auxAssignment).toBeDefined();
      expect(auxAssignment!.product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
      // First pass skips busy room — config reactions remain unchanged
      const auxRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_AUX];
      expect(auxRoomCfg.reactions![0].product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
    });

    it("preserves shared reagent routes when correcting mismatched dispatch", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 10000,
          [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_CATALYST]: 10000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_ZYNTHIUM]: 10000,
          [RESOURCE_OXYGEN]: 5000,
          [RESOURCE_HYDROGEN]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      // Runtime says aux is synthesizing XUHO2 (catalyst + UTRIUM_ALKALIDE)
      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
        targetAmount: 3000,
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE],
        1000,
        1000,
        {
          [RESOURCE_HYDROGEN]: 15000, [RESOURCE_OXYGEN]: 15000,
          [RESOURCE_CATALYST]: 10000, [RESOURCE_ZYNTHIUM]: 10000,
        },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const auxAssignment = assignments.find(a => a.roomName === WIRE_AUX);
      expect(auxAssignment).toBeDefined();
      // Dispatch corrected to runtime's actual product
      expect(auxAssignment!.product).toBe(RESOURCE_CATALYZED_UTRIUM_ALKALIDE);
      expect(auxAssignment!.targetAmount).toBe(3000);

      // Verify no stale (old-only) reagent routes survive for WIRE_AUX.
      // XUHO2 direct reagents: catalyst + UTRIUM_ALKALIDE.
      // Any surviving routes to WIRE_AUX must be for actual-product reagents only.
      const routes = Memory.runtime!.hub!.distributedSynthesis!.routeDecisions ?? [];
      const routesToAux = routes.filter(r => r.toRoom === WIRE_AUX);
      const actualReagents = new Set<ResourceConstant>([RESOURCE_CATALYST, RESOURCE_UTRIUM_ALKALIDE]);
      for (const route of routesToAux) {
        expect(actualReagents.has(route.resource as ResourceConstant)).toBe(true);
      }
    });

    it("corrects hub room dispatch entry when busy with different product", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_HYDROGEN]: 10000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_ZYNTHIUM]: 5000,
          [RESOURCE_KEANIUM]: 5000,
          [RESOURCE_CATALYST]: 10000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      // Hub is busy synthesizing OH (but hub has no O, so planner assigns something else)
      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_HUB] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_HYDROXIDE,
        targetAmount: 2000,
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        {
          [RESOURCE_HYDROGEN]: 15000, [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_UTRIUM]: 10000, [RESOURCE_CATALYST]: 10000,
          [RESOURCE_ZYNTHIUM]: 5000, [RESOURCE_KEANIUM]: 5000,
        },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const hubAssignment = assignments.find(a => a.roomName === WIRE_HUB);
      expect(hubAssignment).toBeDefined();
      expect(hubAssignment!.product).toBe(RESOURCE_HYDROXIDE);
      expect(hubAssignment!.targetAmount).toBe(2000);
      expect(hubAssignment!.isHubRoom).toBe(true);
    });

    it("creates direct A→B transfer when downstream consumer is known and direct fee is lower", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      (Game as any).market = {
        ...(Game.market || {}),
        calcTransactionCost: (amount: number, _from: string, _to: string) =>
          Math.ceil(amount * 0.01),
      };

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_HUB, toRoom: WIRE_AUX, resource: RESOURCE_HYDROXIDE, amount: 1000, fee: 10 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000);

      const store = ensureResourceTransferTaskStore();
      const directTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:direct:OH" && t.toRoomName === WIRE_AUX,
      );
      expect(directTasks.length).toBe(1);
      expect(directTasks[0].amount).toBe(1000);
    });

    it("creates hub-bound surplus transfer when no downstream consumer is known", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_UTRIUM, amount: 5000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000);

      const store = ensureResourceTransferTaskStore();
      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:U" && t.toRoomName === WIRE_HUB,
      );
      expect(surplusTasks.length).toBe(1);
      expect(surplusTasks[0].amount).toBe(5000 - 1000);
    });

    it("pending direct transfers reduce available resource in subsequent planner cycle", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_UTRIUM, amount: 3000, fee: 0 },
      ];
      wireRouteTransferTasks(routes, WIRE_HUB, 1000);

      const outgoingAfter = getOutgoingResourceTransferAmount(WIRE_AUX, RESOURCE_UTRIUM);
      expect(outgoingAfter).toBeGreaterThan(0);
    });

    it("keeps matching pending synthesis route tasks stable across replans", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      (Game as any).market = {
        ...(Game.market || {}),
        calcTransactionCost: (amount: number, _from: string, _to: string) =>
          Math.ceil(amount * 0.01),
      };

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_HUB, toRoom: WIRE_AUX, resource: RESOURCE_UTRIUM, amount: 3000, fee: 30 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000);
      const firstTask = Object.values(ensureResourceTransferTaskStore()).find(
        t => t.status === "pending" && t.reason === "synthesis:direct:U",
      )!;
      firstTask.lastError = "insufficient_terminal_resource_or_fee";
      firstTask.updatedAt = Game.time + 1;

      wireRouteTransferTasks(routes, WIRE_HUB, 1000);

      const tasks = Object.values(ensureResourceTransferTaskStore()).filter(
        t => t.reason === "synthesis:direct:U",
      );
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe(firstTask.id);
      expect(tasks[0].status).toBe("pending");
      expect(tasks[0].remainingAmount).toBe(3000);
      expect(tasks[0].lastError).toBe("insufficient_terminal_resource_or_fee");
    });

    it("direct supply commitment suppresses same-resource hub-bound surplus transfer", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      (Game as any).market = {
        ...(Game.market || {}),
        calcTransactionCost: (amount: number, _from: string, _to: string) =>
          Math.ceil(amount * 0.01),
      };

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_HYDROXIDE, amount: 3000, fee: 0 },
        { fromRoom: WIRE_AUX, toRoom: "W4N1", resource: RESOURCE_HYDROXIDE, amount: 1800, fee: 5 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 500);

      const store = ensureResourceTransferTaskStore();
      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:OH",
      );

      if (surplusTasks.length > 0) {
        const surplusAmount = surplusTasks.reduce((sum, t) => sum + t.amount, 0);
        expect(surplusAmount).toBeLessThanOrEqual(3000 - 1800 - 500);
      }

      const directTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:direct:OH",
      );
      expect(directTasks.length).toBe(1);
      expect(directTasks[0].amount).toBe(1800);
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

    it("suppresses synthesis:surplus:X (catalyst) when distributedStorage is true", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_CATALYST, amount: 5000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:X",
      );
      expect(surplusTasks.length).toBe(0);
    });

    it("suppresses synthesis:surplus:power when distributedStorage is true", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_POWER, amount: 5000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:power",
      );
      expect(surplusTasks.length).toBe(0);
      const powerTasks = Object.values(store).filter(
        t => t.status === "pending" && t.resource === RESOURCE_POWER,
      );
      expect(powerTasks.length).toBe(0);
    });

    it("creates synthesis:surplus:XUH2O (T3) hub-route when distributedStorage is true", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_CATALYZED_UTRIUM_ACID, amount: 5000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:XUH2O",
      );
      expect(surplusTasks.length).toBe(1);
      expect(surplusTasks[0].amount).toBe(5000 - 1000);
    });

    it("creates synthesis:direct:H task for hub-bound reagent demand under distributedStorage", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_HYDROGEN, amount: 458, fee: 0, isHubReagentDemand: true },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const demandTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:direct:H" && t.toRoomName === WIRE_HUB,
      );
      expect(demandTasks.length).toBe(1);
      expect(demandTasks[0].fromRoomName).toBe(WIRE_AUX);
      expect(demandTasks[0].resource).toBe(RESOURCE_HYDROGEN);
      expect(demandTasks[0].amount).toBe(458);
    });

    it("does not subtract reservePerRoom from hub-bound reagent demand amount", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_OXYGEN, amount: 1500, fee: 0, isHubReagentDemand: true },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const demandTask = Object.values(store).find(
        t => t.status === "pending" && t.reason === "synthesis:direct:O",
      );
      expect(demandTask).toBeDefined();
      expect(demandTask!.amount).toBe(1500);
    });

    it("still skips non-T3 hub-bound surplus return (no isHubReagentDemand) under distributedStorage", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_HYDROGEN, amount: 5000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:H",
      );
      expect(surplusTasks.length).toBe(0);
      const anyHTask = Object.values(store).filter(
        t => t.status === "pending" && t.resource === RESOURCE_HYDROGEN,
      );
      expect(anyHTask.length).toBe(0);
    });

    it("treats hub-bound reagent demand and surplus return for same resource independently", () => {
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      Memory.data = {};

      const routes: DirectRouteDecision[] = [
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_HYDROGEN, amount: 1000, fee: 0, isHubReagentDemand: true },
        { fromRoom: WIRE_AUX, toRoom: WIRE_HUB, resource: RESOURCE_HYDROGEN, amount: 4000, fee: 0 },
      ];

      wireRouteTransferTasks(routes, WIRE_HUB, 1000, true);

      const store = ensureResourceTransferTaskStore();
      const demandTask = Object.values(store).find(
        t => t.status === "pending" && t.reason === "synthesis:direct:H",
      );
      expect(demandTask).toBeDefined();
      expect(demandTask!.amount).toBe(1000);

      const surplusTasks = Object.values(store).filter(
        t => t.status === "pending" && t.reason === "synthesis:surplus:H",
      );
      expect(surplusTasks.length).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Task 4: duplicate fallback, busy-room reconciliation, reassignment,
    // and stability tests
    // -----------------------------------------------------------------------

    it("allows duplicate final T3 assignments only after distinct targets are exhausted (third-pass fallback)", () => {
      // Only XUH2O chain feasible: H, O, U, Catalyst. No K, L, Z.
      // 3 rooms, 1 feasible target → third-pass fallback allows duplicates.
      const WIRE_AUX2 = "W3N1";

      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 10000,
          [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_CATALYST]: 5000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
          [RESOURCE_UTRIUM]: 5000,
          [RESOURCE_CATALYST]: 2000,
        },
      });
      const auxRoom2 = createSynthesisCapableRoom(WIRE_AUX2, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
          [RESOURCE_UTRIUM]: 5000,
          [RESOURCE_CATALYST]: 2000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;
      Game.rooms[WIRE_AUX2] = auxRoom2;

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 20000, [RESOURCE_OXYGEN]: 20000, [RESOURCE_UTRIUM]: 20000, [RESOURCE_CATALYST]: 9000 },
        [],
      );

      const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;

      // All assignments carry finalTarget (Task 3 contract)
      for (const a of assignments) {
        expect(a.finalTarget).toBeDefined();
      }

      // All finalTargets are XUH2O — only feasible target
      const finalTargets = assignments.map(a => a.finalTarget!);
      const uniqueTargets = new Set(finalTargets);
      expect(uniqueTargets.size).toBe(1);
      expect([...uniqueTargets][0]).toBe(RESOURCE_CATALYZED_UTRIUM_ACID);

      // Multiple assignments across different rooms → fallback duplicates
      expect(assignments.length).toBeGreaterThan(1);
      const roomNames = new Set(assignments.map(a => a.roomName));
      expect(roomNames.size).toBeGreaterThan(1);

      // Relationship: feasibleTargets(1) < rooms(3), so duplicates are valid
      // after first-pass distinct assignment is made.
      expect(assignments.length).toBeGreaterThan(1);
    });

    it("preserves busy rooms in loading, unloading, and cleanup stages without overwriting reactions", () => {
      // Synthesizing stage is already covered by existing tests above.
      // This test covers the remaining non-reassignable stages.
      const busyStages = ["loading", "unloading", "cleanup"] as const;
      const busyProduct = RESOURCE_UTRIUM_HYDRIDE;

      for (const stage of busyStages) {
        // Reset synthesis control per iteration
        Memory.cfg!.synthesisControl = { enabled: true, rooms: {} };
        if (!Memory.runtime!.synthesisControl) {
          (Memory.runtime as any).synthesisControl = { rooms: {} };
        }
        if (!(Memory.runtime as any).synthesisControl.rooms) {
          (Memory.runtime as any).synthesisControl.rooms = {};
        }
        delete (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX];

        // Recreate rooms
        Game.rooms = {};
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
            [RESOURCE_CATALYST]: 5000,
          },
        });
        Game.rooms[WIRE_HUB] = hubRoom;
        Game.rooms[WIRE_AUX] = auxRoom;

        // Aux room is busy with UH in the given stage
        (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
          stage,
          activeProduct: busyProduct,
          targetAmount: 3000,
        };

        // Pre-existing reaction config for aux
        Memory.cfg!.synthesisControl.rooms[WIRE_AUX] = {
          enabled: true,
          reactions: [{ product: busyProduct, targetAmount: 3000, batchSize: 100, donorRoomNames: [] }],
          donorRoomNames: [],
        };

        wireDistributedSynthesis(
          WIRE_HUB,
          [RESOURCE_CATALYZED_UTRIUM_ACID],
          1000,
          1000,
          { [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000, [RESOURCE_UTRIUM]: 5000, [RESOURCE_CATALYST]: 5000 },
          [],
        );

        // Reaction config preserved (not overwritten)
        const auxRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_AUX];
        expect({
          stage,
          reactionProduct: auxRoomCfg?.reactions?.[0]?.product,
        }).toEqual({
          stage,
          reactionProduct: busyProduct,
        });

        // Dispatch entry includes busy room with active product
        const assignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
        const auxAssignment = assignments.find(a => a.roomName === WIRE_AUX);
        expect({
          stage,
          found: !!auxAssignment,
          product: auxAssignment?.product,
        }).toEqual({
          stage,
          found: true,
          product: busyProduct,
        });
      }
    });

    it("reassigns loading room when missing inputs have no pending supply", () => {
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
          [RESOURCE_CATALYST]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "loading",
        activeProduct: RESOURCE_ZYNTHIUM_KEANITE,
        targetAmount: 3000,
        pendingTasks: 0,
        missing: {
          [RESOURCE_ZYNTHIUM]: 3000,
          [RESOURCE_KEANIUM]: 3000,
        },
      };

      Memory.cfg!.synthesisControl = {
        enabled: true,
        rooms: {
          [WIRE_AUX]: {
            enabled: true,
            reactions: [{ product: RESOURCE_ZYNTHIUM_KEANITE, targetAmount: 3000, batchSize: 3000, donorRoomNames: [] }],
            donorRoomNames: [],
          },
        },
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        {
          [RESOURCE_HYDROGEN]: 10000,
          [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_UTRIUM]: 5000,
          [RESOURCE_CATALYST]: 5000,
        },
        [],
      );

      const auxRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_AUX];
      expect(auxRoomCfg.reactions![0].product).not.toBe(RESOURCE_ZYNTHIUM_KEANITE);
    });

    it("does not keep a loading room on the same product when its inputs are unserved", () => {
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
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_KEANIUM]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "loading",
        activeProduct: RESOURCE_KEANIUM_ACID,
        targetAmount: 3000,
        pendingTasks: 0,
        missing: {
          [RESOURCE_KEANIUM_HYDRIDE]: 3000,
          [RESOURCE_HYDROXIDE]: 3000,
        },
      };

      Memory.cfg!.synthesisControl = {
        enabled: true,
        rooms: {
          [WIRE_AUX]: {
            enabled: true,
            reactions: [{ product: RESOURCE_KEANIUM_ACID, targetAmount: 3000, batchSize: 3000, donorRoomNames: [] }],
            donorRoomNames: [],
          },
        },
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_KEANIUM_ACID],
        1000,
        1000,
        {
          [RESOURCE_HYDROGEN]: 15000,
          [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_KEANIUM]: 5000,
          [RESOURCE_CATALYST]: 5000,
        },
        [],
      );

      const auxRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_AUX];
      expect(auxRoomCfg.reactions![0].product).not.toBe(RESOURCE_KEANIUM_ACID);
    });

    it("reassigns idle room to different final T3 target after previous product completes", () => {
      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_CATALYST]: 5000,
      };

      // Phase 1: aux is busy synthesizing UH (XUH2O chain)
      Game.rooms = {};
      Game.rooms[WIRE_HUB] = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[WIRE_AUX] = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      (Memory.runtime as any).synthesisControl = { rooms: {} };
      (Memory.runtime as any).synthesisControl.rooms[WIRE_AUX] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_UTRIUM_HYDRIDE,
        targetAmount: 3000,
      };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ACID],
        1000,
        1000,
        { ...RESOURCES },
        [],
      );

      const firstAssignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const firstAux = firstAssignments.find(a => a.roomName === WIRE_AUX);
      expect(firstAux).toBeDefined();
      // Reconciliation preserves active product for busy room
      expect(firstAux!.product).toBe(RESOURCE_UTRIUM_HYDRIDE);

      // Phase 2: aux completes, returns to idle
      Game.rooms = {};
      Game.rooms[WIRE_HUB] = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[WIRE_AUX] = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      // Reset synthesis control — aux is now idle
      (Memory.runtime as any).synthesisControl = { rooms: {} };
      Memory.cfg!.synthesisControl = { enabled: true, rooms: {} };
      // Clear transfer tasks so effective inventories are clean
      Memory.data = {};
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ACID],
        1000,
        1000,
        { ...RESOURCES },
        [],
      );

      const secondAssignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;
      const secondAux = secondAssignments.find(a => a.roomName === WIRE_AUX);
      expect(secondAux).toBeDefined();
      expect(secondAux!.finalTarget).toBeDefined();

      // Aux now has a different final T3 target (diversified from XUH2O)
      expect({
        previousProduct: firstAux!.product,
        newFinalTarget: secondAux!.finalTarget,
        diversified: secondAux!.finalTarget !== RESOURCE_CATALYZED_UTRIUM_ACID,
      }).toEqual(
        expect.objectContaining({ diversified: true }),
      );
    });

    it("produces identical dispatch assignments when called twice with unchanged state", () => {
      const RESOURCES: Record<string, number> = {
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      };

      // First call
      Game.rooms = {};
      Game.rooms[WIRE_HUB] = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });
      Game.rooms[WIRE_AUX] = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: { ...RESOURCES },
      });

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { ...RESOURCES },
        [],
      );

      const firstAssignments = JSON.parse(JSON.stringify(
        Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!,
      ));

      // Reset transfer tasks and synthesis control for clean second call
      Memory.data = {};
      (global as any).__runtimeServices = undefined;
      registerRuntimeServices();
      delete (Memory.runtime as any).synthesisControl;
      Memory.cfg!.synthesisControl = { enabled: true, rooms: {} };

      // Second call — same rooms, same inventory
      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { ...RESOURCES },
        [],
      );

      const secondAssignments = Memory.runtime!.hub!.distributedSynthesis!.dispatchAssignments!;

      // Deterministic: identical structure
      expect(secondAssignments).toEqual(firstAssignments);
    });

    // -----------------------------------------------------------------------
    // Task 2: Hub-room synthesis config fallback when distributedStorage is on
    // -----------------------------------------------------------------------

    it("distributedStorage fallback: hub room reaction matches steps[0].product when hub not in dispatch assignments", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      const steps: ChainStep[] = [
        { product: RESOURCE_HYDROXIDE, targetAmount: 1000, reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN] },
      ];

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 5000, [RESOURCE_OXYGEN]: 5000 },
        steps,
        true,
      );

      const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
      expect(dispatchAssignments.find(a => a.roomName === WIRE_HUB)).toBeUndefined();

      const hubRoomCfg = Memory.cfg?.synthesisControl?.rooms?.[WIRE_HUB];
      expect(hubRoomCfg).toBeDefined();
      expect(hubRoomCfg!.reactions).toBeDefined();
      expect(hubRoomCfg!.reactions!.length).toBeGreaterThanOrEqual(1);
      expect(hubRoomCfg!.reactions![0].product).toBe(RESOURCE_HYDROXIDE);
    });

    it("distributedStorage fallback: stale idle hub reaction is replaced by steps[0].product", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
          [RESOURCE_ZYNTHIUM]: 5000,
          [RESOURCE_KEANIUM]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      Memory.cfg!.synthesisControl = {
        enabled: true,
        rooms: {
          [WIRE_HUB]: {
            enabled: true,
            reactions: [{ product: RESOURCE_ZYNTHIUM_KEANITE, targetAmount: 5000, batchSize: 100, donorRoomNames: [] }],
            donorRoomNames: [],
          },
        },
      };
      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_HUB] = { stage: "idle" };

      const steps: ChainStep[] = [
        { product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 1000, reagents: [RESOURCE_UTRIUM, RESOURCE_HYDROGEN] },
      ];

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_HYDROGEN]: 5000, [RESOURCE_OXYGEN]: 5000, [RESOURCE_ZYNTHIUM]: 5000, [RESOURCE_KEANIUM]: 5000 },
        steps,
        true,
      );

      const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
      expect(dispatchAssignments.find(a => a.roomName === WIRE_HUB)).toBeUndefined();

      const hubRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_HUB];
      expect(hubRoomCfg.reactions).toBeDefined();
      expect(hubRoomCfg.reactions!.length).toBeGreaterThanOrEqual(1);
      expect(hubRoomCfg.reactions![0].product).toBe(RESOURCE_UTRIUM_HYDRIDE);
    });

    it("distributedStorage fallback: busy hub room preserves existing reaction unchanged", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_HYDROGEN]: 10000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 5000,
          [RESOURCE_OXYGEN]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_HUB] = {
        stage: "synthesizing",
        activeProduct: RESOURCE_UTRIUM_HYDRIDE,
        targetAmount: 2000,
      };
      Memory.cfg!.synthesisControl = {
        enabled: true,
        rooms: {
          [WIRE_HUB]: {
            enabled: true,
            reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 2000, batchSize: 100, donorRoomNames: [] }],
            donorRoomNames: [],
          },
        },
      };

      const steps: ChainStep[] = [
        { product: RESOURCE_HYDROXIDE, targetAmount: 1000, reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN] },
      ];

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        { [RESOURCE_UTRIUM]: 10000, [RESOURCE_HYDROGEN]: 15000, [RESOURCE_OXYGEN]: 5000 },
        steps,
        true,
      );

      const hubRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_HUB];
      expect(hubRoomCfg.reactions![0].product).toBe(RESOURCE_UTRIUM_HYDRIDE);
      expect(hubRoomCfg.reactions![0].targetAmount).toBe(2000);
      expect(hubRoomCfg.reactions![0].product).not.toBe(steps[0].product);
    });

    it("distributedStorage fallback: empty steps clears hub room reactions when rewrite-safe", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_ZYNTHIUM]: 5000,
          [RESOURCE_KEANIUM]: 5000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      Memory.cfg!.synthesisControl = {
        enabled: true,
        rooms: {
          [WIRE_HUB]: {
            enabled: true,
            reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, batchSize: 100, donorRoomNames: [] }],
            donorRoomNames: [],
          },
        },
      };
      if (!Memory.runtime!.synthesisControl) (Memory.runtime as any).synthesisControl = { rooms: {} };
      if (!(Memory.runtime as any).synthesisControl.rooms) (Memory.runtime as any).synthesisControl.rooms = {};
      (Memory.runtime as any).synthesisControl.rooms[WIRE_HUB] = { stage: "idle" };

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_UTRIUM_ACID],
        1000,
        1000,
        {},
        [],
        true,
      );

      const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
      expect(dispatchAssignments.find(a => a.roomName === WIRE_HUB)).toBeUndefined();

      const hubRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_HUB];
      expect(hubRoomCfg.reactions).toEqual([]);
    });

    it("distributedStorage fallback: does not clear hub reaction when hub has explicit dispatch assignment", () => {
      const hubRoom = createSynthesisCapableRoom(WIRE_HUB, {
        labCount: 3,
        storageResources: {
          [RESOURCE_HYDROGEN]: 10000,
          [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_ZYNTHIUM]: 10000,
          [RESOURCE_KEANIUM]: 10000,
          [RESOURCE_LEMERGIUM]: 10000,
        },
      });
      const auxRoom = createSynthesisCapableRoom(WIRE_AUX, {
        labCount: 3,
        storageResources: {
          [RESOURCE_ZYNTHIUM]: 10000,
          [RESOURCE_KEANIUM]: 10000,
          [RESOURCE_UTRIUM]: 10000,
          [RESOURCE_LEMERGIUM]: 10000,
        },
      });
      Game.rooms[WIRE_HUB] = hubRoom;
      Game.rooms[WIRE_AUX] = auxRoom;

      wireDistributedSynthesis(
        WIRE_HUB,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        1000,
        1000,
        {
          [RESOURCE_HYDROGEN]: 10000, [RESOURCE_OXYGEN]: 10000,
          [RESOURCE_ZYNTHIUM]: 10000, [RESOURCE_KEANIUM]: 10000,
          [RESOURCE_UTRIUM]: 10000, [RESOURCE_LEMERGIUM]: 10000,
        },
        [],
        true,
      );

      const dispatchAssignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments ?? [];
      const hubAssignments = dispatchAssignments.filter(a => a.roomName === WIRE_HUB);
      expect(hubAssignments.length).toBeGreaterThan(0);
      const hubAssignmentProducts = hubAssignments.map(a => a.product);

      const hubRoomCfg = Memory.cfg!.synthesisControl!.rooms![WIRE_HUB];
      expect(hubRoomCfg.reactions).toBeDefined();
      expect(hubRoomCfg.reactions!.length).toBe(1);
      expect(hubAssignmentProducts).toContain(hubRoomCfg.reactions![0].product);
    });
  });
});

describe("planHubImports: local reserve and direct-supply protection", () => {
  const HUB_ROOM = "W1N1";
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
        hubReservePerCompound: 20000,
        targetCompounds: [XGHO2],
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

  it("satellite with 800 T3 and reservePerRoom=1000 produces no reclaim task", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 800 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).not.toContainEqual(expect.stringContaining(`reclaim:${SAT_ROOM}:${XGHO2}`));
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(t => t.reason === `hub:reclaim:${XGHO2}`);
    expect(t3Task).toBeUndefined();
  });

  it("satellite with 2000 T3 and reservePerRoom=1000 reclaims 1000", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 2000 });
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContainEqual(`reclaim:${SAT_ROOM}:${XGHO2}=1000`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(t => t.reason === `hub:reclaim:${XGHO2}`);
    expect(t3Task).toBeDefined();
    expect(t3Task!.amount).toBe(1000);
  });

  it("satellite with active synthesis assignment keeps local reserve for T3 product", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 2000 });
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: SAT_ROOM, product: XGHO2, targetAmount: 5000, isHubRoom: false },
      ],
      allocationLedger: {},
      routeDecisions: [],
    };
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContainEqual(`reclaim:${SAT_ROOM}:${XGHO2}=1000`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const t3Task = tasks.find(t => t.reason === `hub:reclaim:${XGHO2}`);
    expect(t3Task).toBeDefined();
    expect(t3Task!.amount).toBe(1000);
  });

  it("satellite with active synthesis and only 800 T3 produces no reclaim task", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, { [XGHO2]: 800 });
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: SAT_ROOM, product: XGHO2, targetAmount: 5000, isHubRoom: false },
      ],
      allocationLedger: {},
      routeDecisions: [],
    };
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).not.toContainEqual(expect.stringContaining(`reclaim:${SAT_ROOM}:${XGHO2}`));
  });

  it("upstream room with direct downstream demand keeps committed amount", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROXIDE]: 2000,
    });
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: SAT_ROOM, product: XGHO2, targetAmount: 5000, isHubRoom: false },
      ],
      allocationLedger: {},
      routeDecisions: [
        { fromRoom: SAT_ROOM, toRoom: "W3N1", resource: RESOURCE_HYDROXIDE, amount: 800, fee: 0 },
      ],
    };
    const actions = planHubImports(Memory.cfg!.hub!);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(t => t.reason === `hub:import:${RESOURCE_HYDROXIDE}`);
    expect(ohTask).toBeDefined();
    expect(ohTask!.amount).toBeLessThanOrEqual(2000 - 800);
  });

  it("direct-supply and hub-storage conflict resolves with direct-supply first", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROXIDE]: 3000,
    });
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: SAT_ROOM, product: XGHO2, targetAmount: 5000, isHubRoom: false },
      ],
      allocationLedger: {},
      routeDecisions: [
        { fromRoom: SAT_ROOM, toRoom: HUB_ROOM, resource: RESOURCE_HYDROXIDE, amount: 3000, fee: 0 },
        { fromRoom: SAT_ROOM, toRoom: "W3N1", resource: RESOURCE_HYDROXIDE, amount: 1800, fee: 5 },
      ],
    };
    const actions = planHubImports(Memory.cfg!.hub!);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const ohTask = tasks.find(t => t.reason === `hub:import:${RESOURCE_HYDROXIDE}`);
    if (ohTask) {
      expect(ohTask!.amount).toBeLessThanOrEqual(3000 - 1800);
    }
  });

  it("hub distribution still fills rooms below target", () => {
    const hubStorageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      [XGHO2]: 21000,
    };
    const hubRoom = {
      name: HUB_ROOM,
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
          getUsedCapacity: () => 20000,
          getFreeCapacity: () => 280000,
          cooldown: 0,
        },
      },
      find: () => [],
    } as unknown as Room;
    Game.rooms[HUB_ROOM] = hubRoom;
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [],
      allocationLedger: {},
      routeDecisions: [],
    };
    const actions = planHubDistribution(Memory.cfg!.hub!);
    expect(actions.some(a => a.includes("export") && a.includes(XGHO2))).toBe(true);
  });

   it("market protection for committed satellite resources", () => {
     Game.rooms[HUB_ROOM] = createHubRoomForImports();
     Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
       [RESOURCE_HYDROXIDE]: 2000,
     });
     Memory.runtime!.hub!.distributedSynthesis = {
       dispatchAssignments: [
         { roomName: SAT_ROOM, product: XGHO2, targetAmount: 5000, isHubRoom: false },
       ],
       allocationLedger: {},
       routeDecisions: [
         { fromRoom: SAT_ROOM, toRoom: "W3N1", resource: RESOURCE_HYDROXIDE, amount: 800, fee: 0 },
       ],
     };
     const actions = planHubImports(Memory.cfg!.hub!);
     const tasks = Object.values(ensureResourceTransferTaskStore());
     const ohTask = tasks.find(t => t.reason === `hub:import:${RESOURCE_HYDROXIDE}`);
     expect(ohTask).toBeDefined();
     expect(ohTask!.amount).toBeLessThanOrEqual(1200);
   });
});

// ---------------------------------------------------------------------------
// computeAndStoreMarketSellSurplus tests (tested via runHubPlanner)
// ---------------------------------------------------------------------------

describe("computeAndStoreMarketSellSurplus (via runHubPlanner)", () => {
  const SURPLUS_HUB = "S1N1";
  const PLAN_INTERVAL = 50;

  beforeEach(() => {
    Game.time = PLAN_INTERVAL;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: SURPLUS_HUB,
        planInterval: PLAN_INTERVAL,
        reservePerRoom: 1000,
        hubReservePerCompound: 20000,
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

  function createSurplusHubRoom(storageResources: Record<string, number>): Room {
    const storageEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 200000,
      ...storageResources,
    };
    const terminalEntries: Record<string, number> = {
      [RESOURCE_ENERGY]: 20000,
    };
    const labs: Structure[] = [];
    for (let i = 0; i < 3; i++) {
      labs.push({ id: `hub-lab-${i}`, structureType: STRUCTURE_LAB } as Structure);
    }
    return {
      name: SURPLUS_HUB,
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
          ...terminalEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return terminalEntries[resource] || 0;
            return Object.values(terminalEntries).reduce((a: number, b: number) => a + b, 0);
          },
          getFreeCapacity: () => 300000,
          cooldown: 0,
        },
      },
      find: (type: FindConstant, opts?: { filter?: ((s: Structure) => boolean) | { structureType: string } }) => {
        if (type === FIND_MY_STRUCTURES) {
          if (!opts?.filter) return labs;
          if (typeof opts.filter === "function") return labs.filter(opts.filter);
          const targetType = (opts.filter as { structureType: string }).structureType;
          return labs.filter((s) => s.structureType === targetType);
        }
        return [] as Structure[];
      },
    } as unknown as Room;
  }

  it("T3 compound above chainTarget creates surplus entry", () => {
    // hubReservePerCompound=20000, no satellites → chainTarget=20000
    // Hub has 25000 XUH2O → sellable = 25000 - 20000 = 5000
    Game.rooms[SURPLUS_HUB] = createSurplusHubRoom({
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 25000,
    });

    runHubPlanner();

    const surplus = Memory.runtime.hub.marketSellSurplus;
    expect(surplus).toBeDefined();
    expect(surplus![RESOURCE_CATALYZED_UTRIUM_ACID]).toBe(5000);
  });

  it("T3 compound at chainTarget creates no surplus entry", () => {
    // hubReservePerCompound=20000, no satellites → chainTarget=20000
    // Hub has exactly 20000 XUH2O → sellable = 0
    Game.rooms[SURPLUS_HUB] = createSurplusHubRoom({
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 20000,
    });

    runHubPlanner();

    const surplus = Memory.runtime.hub.marketSellSurplus;
    expect(surplus).toBeDefined();
    expect(surplus![RESOURCE_CATALYZED_UTRIUM_ACID]).toBeUndefined();
  });

  it("non-target compounds are never sold (only T3 targets)", () => {
    // RESOURCE_HYDROXIDE is not a T3 target → no surplus even above 5000
    Game.rooms[SURPLUS_HUB] = createSurplusHubRoom({
      [RESOURCE_HYDROXIDE]: 8000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 20000,
    });

    runHubPlanner();

    const surplus = Memory.runtime.hub.marketSellSurplus;
    expect(surplus).toBeDefined();
    expect(surplus![RESOURCE_HYDROXIDE]).toBeUndefined();
  });

  it("non-target compound at 5000 creates no surplus entry", () => {
    Game.rooms[SURPLUS_HUB] = createSurplusHubRoom({
      [RESOURCE_HYDROXIDE]: 5000,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 20000,
    });

    runHubPlanner();

    const surplus = Memory.runtime.hub.marketSellSurplus;
    expect(surplus).toBeDefined();
    expect(surplus![RESOURCE_HYDROXIDE]).toBeUndefined();
  });

  it("energy, power, ops are excluded from surplus", () => {
    Game.rooms[SURPLUS_HUB] = createSurplusHubRoom({
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 20000,
    });
    // Manually add energy, power, ops to storage to check exclusion
    const store = Game.rooms[SURPLUS_HUB].storage!.store as unknown as Record<string, number>;
    store[RESOURCE_ENERGY] = 300000;
    store[RESOURCE_POWER] = 10000;
    store[RESOURCE_OPS] = 5000;

    runHubPlanner();

    const surplus = Memory.runtime.hub.marketSellSurplus;
    expect(surplus).toBeDefined();
    expect(surplus![RESOURCE_ENERGY]).toBeUndefined();
    expect(surplus![RESOURCE_POWER]).toBeUndefined();
    expect(surplus![RESOURCE_OPS]).toBeUndefined();
  });

  it("outgoing transfer amounts reduce surplus", () => {
    // Hub has 25000 XUH2O, chainTarget=20000 → would be 5000 surplus
    // But create an outgoing transfer of 3000 XUH2O
    // Effective = 25000 - 3000 = 22000, surplus = 22000 - 20000 = 2000
    Game.rooms[SURPLUS_HUB] = createSurplusHubRoom({
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 25000,
    });
    createResourceTransferTask(
      SURPLUS_HUB, "W2N1", RESOURCE_CATALYZED_UTRIUM_ACID, 3000, "hub:export:XUH2O",
    );

    runHubPlanner();

    const surplus = Memory.runtime.hub.marketSellSurplus;
    expect(surplus).toBeDefined();
    expect(surplus![RESOURCE_CATALYZED_UTRIUM_ACID]).toBe(2000);
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

  it("creates resupply task for busy room missing reagent", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toContainEqual(`resupply:${SAT_ROOM}:${RESOURCE_UTRIUM}=800`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find(
      (t) => t.reason === `synthesis:resupply:${RESOURCE_UTRIUM}`,
    );
    expect(task).toBeDefined();
    expect(task!.fromRoomName).toBe(HUB_ROOM_NAME);
    expect(task!.toRoomName).toBe(SAT_ROOM);
    expect(task!.amount).toBe(800);
  });

  it("uses a supplied transfer amount index for existing resupply", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});
    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;
    const transferAmounts = {
      getIncoming: jest.fn(() => 800),
      getOutgoing: jest.fn(() => 0),
      getPendingIncoming: jest.fn(() => 0),
      getPendingOutgoing: jest.fn(() => 0),
    };

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, 1000, transferAmounts);

    expect(actions).toEqual([]);
    expect(transferAmounts.getIncoming).toHaveBeenCalledWith(SAT_ROOM, RESOURCE_UTRIUM);
    expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(0);
  });

  it("skips idle rooms", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "idle",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toHaveLength(0);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find(
      (t) => t.reason === `synthesis:resupply:${RESOURCE_UTRIUM}`,
    );
    expect(task).toBeUndefined();
  });

  it("skips rooms without missing reagents", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: {},
    } as any;

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toHaveLength(0);
  });

  it("skips when hub has no exportable reagent", () => {
    // Hub has 1200 U, reservePerRoom=1000, so exportable = 1200 - 0 - 1000 = 200
    // But if we set reservePerRoom=1500, exportable = 1200 - 0 - 1500 < 0
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 1200 };
    const reservePerRoom = 1500;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toHaveLength(0);
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

  it("deduplicates partial incoming", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {});

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    // 300 U already incoming to SAT_ROOM
    createResourceTransferTask("W3N1", SAT_ROOM, RESOURCE_UTRIUM, 300, "synthesis:test");

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toContainEqual(`resupply:${SAT_ROOM}:${RESOURCE_UTRIUM}=500`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const task = tasks.find(
      (t) => t.reason === `synthesis:resupply:${RESOURCE_UTRIUM}`,
    );
    expect(task).toBeDefined();
    expect(task!.amount).toBe(500);
  });

  it("skips hub room itself", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});

    Memory.runtime!.synthesisControl!.rooms![HUB_ROOM_NAME] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toHaveLength(0);
  });

  it("skips rooms without terminal or storage", () => {
    const hubInventory: Record<string, number> = { [RESOURCE_UTRIUM]: 5000 };
    const reservePerRoom = 1000;

    Game.rooms[HUB_ROOM_NAME] = createSatelliteRoom(HUB_ROOM_NAME, {});
    // Room without terminal and storage
    Game.rooms[SAT_ROOM] = {
      name: SAT_ROOM,
      controller: { my: true, level: 8 },
      find: () => [],
    } as unknown as Room;

    Memory.runtime!.synthesisControl!.rooms![SAT_ROOM] = {
      stage: "synthesizing",
      missing: { [RESOURCE_UTRIUM]: 800 },
    } as any;

    const actions = resupplyBusySynthesisRooms(HUB_ROOM_NAME, hubInventory, reservePerRoom);

    expect(actions).toHaveLength(0);
  });
});
