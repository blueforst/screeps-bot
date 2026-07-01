/**
 * Integration tests for hub production pipeline wiring.
 *
 * Main loop tick order (src/main.ts lines 57-64):
 *   hubPlanner → synthesisControl → mineralExtraction → resourceControl → memoryCleanup → flagControl
 *
 * These tests verify:
 * 1. hubPlanner writes synthesis config → synthesisControl consumes it and transitions stage
 * 2. statusHub reflects active synthesis state from runtime
 * 3. statusHub reflects cleanup error state from runtime
 */

import { runHubPlanner, getEligibleSynthesisRooms } from "@/runtime/hubPlanner";
import { runSynthesisControl } from "@/runtime/synthesisControl";
import { statusHubRaw, hubProgressRaw } from "@/runtime/consoleCommands";
import { buildHubProgressSnapshot, collectHubProgressSnapshot } from "@/runtime/hubProgress";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import {
  clearCarrierTaskBoardForTest,
} from "@/runtime/carrierTaskBoard";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(map: Record<string, number> = {}, totalCapacity = 3000) {
  const entries: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    entries[k] = v;
  }
  Object.defineProperties(entries, {
    getUsedCapacity: {
      value: (resource?: ResourceConstant): number => {
        if (resource !== undefined) return entries[resource] ?? 0;
        return Object.values(map).reduce((s, v) => s + v, 0);
      },
      enumerable: false,
      configurable: true,
    },
    getFreeCapacity: {
      value: (resource?: ResourceConstant): number => {
        const used =
          resource !== undefined
            ? (entries[resource] ?? 0)
            : Object.values(map).reduce((s, v) => s + v, 0);
        return totalCapacity - used;
      },
      enumerable: false,
      configurable: true,
    },
  });
  return entries as typeof entries & {
    getUsedCapacity: (resource?: ResourceConstant) => number;
    getFreeCapacity: (resource?: ResourceConstant) => number;
  };
}

interface LabHandle {
  id: string;
  room: Room;
  structureType: string;
  pos: { inRangeTo: () => boolean };
  store: ReturnType<typeof createStore>;
  runReaction: jest.Mock;
  cooldown: number;
  mineralType: ResourceConstant | undefined;
  _resourceMap: Record<string, number>;
}

function createLab(
  room: Room,
  id: string,
  mineralType?: ResourceConstant,
  resources?: Partial<Record<ResourceConstant, number>>,
): LabHandle {
  const resourceMap: Record<string, number> = {};
  if (resources) {
    for (const [k, v] of Object.entries(resources)) {
      if (v !== undefined) resourceMap[k] = v;
    }
  }
  const store = createStore(resourceMap);
  return {
    id,
    room,
    structureType: STRUCTURE_LAB,
    pos: { inRangeTo: () => true } as unknown as RoomPosition,
    store,
    runReaction: jest.fn(() => OK),
    cooldown: 0,
    mineralType,
    _resourceMap: resourceMap,
  } as unknown as LabHandle;
}

function createSynthesisRoom(options: {
  name: string;
  storageResources?: Partial<Record<ResourceConstant, number>>;
  terminalResources?: Partial<Record<ResourceConstant, number>>;
  labs?: LabHandle[];
}): { room: Room; labs: LabHandle[]; storageMap: Record<string, number> } {
  const storageMap: Record<string, number> = {};
  const terminalMap: Record<string, number> = {};
  if (options.storageResources) {
    for (const [k, v] of Object.entries(options.storageResources)) {
      if (v !== undefined) storageMap[k] = v;
    }
  }
  if (options.terminalResources) {
    for (const [k, v] of Object.entries(options.terminalResources)) {
      if (v !== undefined) terminalMap[k] = v;
    }
  }

  const storageStore = createStore(storageMap, 1_000_000);
  const terminalStore = createStore(terminalMap, 300_000);

  const room = {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: storageStore,
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: terminalStore,
    } as unknown as StructureTerminal,
  } as Room;

  const labs =
    options.labs ??
    [
      createLab(room, `${options.name}-lab-1`),
      createLab(room, `${options.name}-lab-2`),
      createLab(room, `${options.name}-lab-3`),
    ];

  (room as any).find = ((
    type: FindConstant,
    opts?: { filter?: ((structure: Structure) => boolean) | Record<string, unknown> },
  ) => {
    if (type === FIND_MY_STRUCTURES) {
      if (opts?.filter) {
        if (typeof opts.filter === "function") {
          return labs.filter((s: any) => (opts.filter as Function)(s as Structure));
        }
        const match = opts.filter as Record<string, unknown>;
        return labs.filter((s: any) =>
          Object.entries(match).every(([k, v]) => s[k] === v),
        );
      }
      return labs;
    }
    if (type === FIND_MINERALS) return [];
    return [];
  }) as Room["find"];

  return { room, labs, storageMap };
}

beforeEach(() => {
  resetRuntimeServices();
  clearCarrierTaskBoardForTest();
  Game.time = 0;
  Game.rooms = {};
  (Game as any).getObjectById = (id: string) => null;
  (Game as any).market = {
    calcTransactionCost: () => 0,
  } as any;
  Memory.runtime = undefined;
  Memory.data = undefined;
  Memory.rooms = {};
});

describe("hub production integration – ordered runtime calls", () => {
  it("hubPlanner writes synthesis config and synthesisControl transitions stage", () => {
    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 50000,
        [RESOURCE_LEMERGIUM]: 50000,
        [RESOURCE_KEANIUM]: 50000,
        [RESOURCE_ZYNTHIUM]: 50000,
        [RESOURCE_CATALYST]: 50000,
      },
    });
    Game.rooms["W1N1"] = room;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
      },
    };

    Game.time = 0;

    runHubPlanner();

    const roomSynthesisCfg = Memory.cfg?.synthesisControl?.rooms?.["W1N1"];
    expect(roomSynthesisCfg).toBeDefined();
    expect(roomSynthesisCfg!.enabled).toBe(true);
    expect(roomSynthesisCfg!.reactions).toBeDefined();
    expect(roomSynthesisCfg!.reactions.length).toBeGreaterThanOrEqual(1);
    expect(roomSynthesisCfg!.reactions[0].targetAmount).toBeGreaterThan(0);

    expect(Memory.runtime!.hub!.status).not.toBe("idle");
    expect(Memory.runtime!.hub!.needsPlan).toBe(false);

    Game.time = 1;
    runSynthesisControl();

    const synthesisRoomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(synthesisRoomState).toBeDefined();
    expect(synthesisRoomState!.stage).not.toBe("idle");
    expect(synthesisRoomState!.stage).not.toBe("blocked");
    expect(synthesisRoomState!.activeProduct).toBe(roomSynthesisCfg!.reactions[0].product);
  });

  it("pre-set synthesis config flows through synthesisControl and statusHub", () => {
    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 3000,
        [RESOURCE_OXYGEN]: 3000,
      },
    });
    Game.rooms["W1N1"] = room;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_HYDROXIDE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
      synthesisControl: {
        enabled: true,
        rooms: {
          W1N1: {
            enabled: true,
            batchSize: 500,
            maxRunsPerTick: 6,
            donorRoomNames: [],
            reagentLabIds: [],
            reactions: [
              {
                product: RESOURCE_HYDROXIDE as ResourceConstant,
                targetAmount: 5000,
                batchSize: 500,
                donorRoomNames: [],
              },
            ],
          },
        },
      },
    };
    Memory.runtime = {
      hub: {
        status: "importing",
        updatedAt: 0,
        activeProduct: RESOURCE_HYDROXIDE,
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [RESOURCE_HYDROXIDE],
        needsPlan: false,
      },
    };

    Game.time = 10;

    runSynthesisControl();

    const synthesisRoomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(synthesisRoomState).toBeDefined();
    expect(synthesisRoomState!.stage).not.toBe("idle");
    expect(synthesisRoomState!.stage).not.toBe("blocked");
    expect(synthesisRoomState!.activeProduct).toBe(RESOURCE_HYDROXIDE);

    const hubStatus = statusHubRaw();
    expect(hubStatus).toMatchObject({
      enabled: true,
      hubRoomName: "W1N1",
      status: "active",
      activeProduct: RESOURCE_HYDROXIDE,
    });
  });
});

describe("hub production integration – statusHub reflects active state", () => {
  it("returns active synthesis details from runtime state", () => {
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        internalOnly: true,
      },
    };

    Memory.runtime = {
      synthesisControl: {
        updatedAt: 100,
        generatedTaskCount: 5,
        failedTaskCount: 0,
        successfulRunCount: 3,
        lastActions: [],
        bindings: {},
        rooms: {
          W1N1: {
            stage: "synthesizing",
            activeProduct: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            reagentLabIds: ["lab-1", "lab-2"],
            productLabIds: ["lab-3"],
            successfulRuns: 10,
            pendingTasks: 0,
            lastTransitionAt: 90,
          } as any,
        },
      },
      hub: {
        status: "importing",
        updatedAt: 100,
        activeProduct: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        activeStep: 5,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: false,
      },
    };

    const result = statusHubRaw();

    expect(result).toMatchObject({
      enabled: true,
      hubRoomName: "W1N1",
      status: "active",
      activeProduct: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      activeStage: "synthesizing",
      lastError: null,
      needsPlan: false,
      targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
    });
  });
});

describe("hub production integration – statusHub reflects cleanup error", () => {
  it("returns lastError from hub runtime state", () => {
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        internalOnly: true,
      },
    };

    Memory.runtime = {
      hub: {
        status: "blocked",
        updatedAt: 50,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
        lastError: "lab_cleanup_destination_full",
      },
      synthesisControl: {
        updatedAt: 50,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W1N1: {
            stage: "unloading",
            activeProduct: RESOURCE_HYDROXIDE,
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: 50,
          } as any,
        },
      },
    };

    const result = statusHubRaw();

    expect(result).toMatchObject({
      enabled: true,
      hubRoomName: "W1N1",
      status: "active",
      activeStage: "unloading",
      lastError: "lab_cleanup_destination_full",
      needsPlan: true,
    });
  });
});

describe("hub intermediate production recovery", () => {
  it("partial resources produce intermediate reaction config and synthesisControl is not blocked", () => {
    // Hub room has H+O but no K/Z — targeting XGHO2 which requires deep chains.
    // Progressive planner should find OH (hydroxide) as a feasible intermediate.
    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
      },
    });
    Game.rooms["W1N1"] = room;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
      },
    };

    Game.time = 0;

    // Step 1: runHubPlanner should find feasible intermediates
    runHubPlanner();

    // Hub status should NOT be "blocked" — partial resources allow intermediate production
    expect(Memory.runtime!.hub!.status).not.toBe("blocked");
    expect(Memory.runtime!.hub!.status).toBe("importing");

    // Synthesis config should be written with enabled:true
    const roomSynthesisCfg = Memory.cfg?.synthesisControl?.rooms?.["W1N1"];
    expect(roomSynthesisCfg).toBeDefined();
    expect(roomSynthesisCfg!.enabled).toBe(true);
    expect(roomSynthesisCfg!.reactions).toBeDefined();
    expect(roomSynthesisCfg!.reactions.length).toBeGreaterThanOrEqual(1);

    // First reaction should be a useful intermediate (hydroxide from H+O)
    const firstReaction = roomSynthesisCfg!.reactions[0];
    expect(firstReaction.product).toBe(RESOURCE_HYDROXIDE);
    expect(firstReaction.targetAmount).toBeGreaterThan(0);

    // Step 2: runSynthesisControl should accept the config without blocking
    Game.time = 1;
    runSynthesisControl();

    const synthesisRoomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(synthesisRoomState).toBeDefined();
    expect(synthesisRoomState!.stage).not.toBe("blocked");
    expect(synthesisRoomState!.lastError).not.toBe("room_config_disabled");
    // Should be in acquiring or loading stage (has reagents in storage)
    expect(["acquiring", "loading", "synthesizing"]).toContain(synthesisRoomState!.stage);
    expect(synthesisRoomState!.activeProduct).toBe(RESOURCE_HYDROXIDE);
  });

  it("empty reactions after distributing does not create room_config_disabled", () => {
    // Hub room has all T3 targets already at reserve — planner enters distributing
    // state with empty reactions. synthesisControl should not block.
    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 50000,
        [RESOURCE_OXYGEN]: 50000,
        [RESOURCE_UTRIUM]: 50000,
        [RESOURCE_LEMERGIUM]: 50000,
        [RESOURCE_KEANIUM]: 50000,
        [RESOURCE_ZYNTHIUM]: 50000,
        [RESOURCE_CATALYST]: 50000,
        // All T3 targets already at reserve level
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 50000,
      },
    });
    Game.rooms["W1N1"] = room;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
      },
    };

    Game.time = 0;

    // runHubPlanner: all targets at reserve → distributing, empty reactions
    runHubPlanner();

    expect(Memory.runtime!.hub!.status).toBe("distributing");
    expect(Memory.runtime!.hub!.needsPlan).toBe(false);

    // writeSynthesisConfig does not create a room entry when steps are empty,
    // so seed the room config with enabled:true and empty reactions to simulate
    // the post-distributing state that hubPlanner leaves behind.
    if (!Memory.cfg!.synthesisControl) {
      Memory.cfg!.synthesisControl = { enabled: true };
    }
    Memory.cfg!.synthesisControl.enabled = true;
    if (!Memory.cfg!.synthesisControl.rooms) {
      Memory.cfg!.synthesisControl.rooms = {};
    }
    Memory.cfg!.synthesisControl.rooms["W1N1"] = {
      enabled: true,
      batchSize: 500,
      maxRunsPerTick: 6,
      donorRoomNames: [],
      reagentLabIds: [],
      reactions: [],
    };

    Game.time = 1;
    runSynthesisControl();

    const synthesisRoomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(synthesisRoomState).toBeDefined();
    expect(synthesisRoomState!.stage).not.toBe("blocked");
    expect(synthesisRoomState!.lastError).not.toBe("room_config_disabled");
    expect(["idle", "loading", "acquiring"]).toContain(synthesisRoomState!.stage);
  });
});

describe("synthesis room config – empty reactions vs explicit disabled", () => {
  it("enabled:true with empty reactions does NOT produce room_config_disabled", () => {
    const { room } = createSynthesisRoom({
      name: "W2N2",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
      },
    });
    Game.rooms["W2N2"] = room;

    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        rooms: {
          W2N2: {
            enabled: true,
            batchSize: 500,
            maxRunsPerTick: 6,
            donorRoomNames: [],
            reagentLabIds: [],
            reactions: [],
          },
        },
      },
    };

    Game.time = 10;
    runSynthesisControl();

    const synthesisRoomState = Memory.runtime!.synthesisControl!.rooms["W2N2"];
    expect(synthesisRoomState).toBeDefined();
    expect(synthesisRoomState!.stage).not.toBe("blocked");
    expect(synthesisRoomState!.lastError).not.toBe("room_config_disabled");
  });

  it("explicit enabled:false still produces stage blocked and room_config_disabled", () => {
    const { room } = createSynthesisRoom({
      name: "W3N3",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
      },
    });
    Game.rooms["W3N3"] = room;

    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        rooms: {
          W3N3: {
            enabled: false,
            batchSize: 500,
            maxRunsPerTick: 6,
            donorRoomNames: [],
            reagentLabIds: [],
            reactions: [
              {
                product: RESOURCE_HYDROXIDE as ResourceConstant,
                targetAmount: 5000,
                batchSize: 500,
                donorRoomNames: [],
              },
            ],
          },
        },
      },
    };

    Game.time = 10;
    runSynthesisControl();

    const synthesisRoomState = Memory.runtime!.synthesisControl!.rooms["W3N3"];
    expect(synthesisRoomState).toBeDefined();
    expect(synthesisRoomState!.stage).toBe("blocked");
    expect(synthesisRoomState!.lastError).toBe("room_config_disabled");
  });
});

describe("distributed synthesis integration – full pipeline with 3 rooms", () => {
  it("runHubPlanner writes configs to hub + 2 aux rooms, creates transfer tasks, and progress snapshot lists all rooms", () => {
    // Hub room: W1N1 — has H, O, plus some U/K/Z/L for variety
    const { room: hubRoom } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 20000,
        [RESOURCE_OXYGEN]: 20000,
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_KEANIUM]: 5000,
        [RESOURCE_ZYNTHIUM]: 5000,
        [RESOURCE_LEMERGIUM]: 5000,
        [RESOURCE_CATALYST]: 5000,
      },
    });
    Game.rooms["W1N1"] = hubRoom;

    // Aux room 1: W2N1 — has Z + K (can make ZK)
    const { room: auxRoom1 } = createSynthesisRoom({
      name: "W2N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_ZYNTHIUM]: 30000,
        [RESOURCE_KEANIUM]: 30000,
      },
    });
    Game.rooms["W2N1"] = auxRoom1;

    // Aux room 2: W3N1 — has U + L (can make UL)
    const { room: auxRoom2 } = createSynthesisRoom({
      name: "W3N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_UTRIUM]: 30000,
        [RESOURCE_LEMERGIUM]: 30000,
      },
    });
    Game.rooms["W3N1"] = auxRoom2;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
      },
    };

    Game.time = 0;

    // Step 1: Run planner
    runHubPlanner();

    // Verify: planner discovered 3 eligible rooms
    const eligible = getEligibleSynthesisRooms();
    const eligibleNames = eligible.map(r => r.roomName);
    expect(eligibleNames).toContain("W1N1");
    expect(eligibleNames).toContain("W2N1");
    expect(eligibleNames).toContain("W3N1");

    // Verify: hub status is not blocked — distributed synthesis active
    expect(Memory.runtime!.hub!.status).not.toBe("blocked");
    expect(Memory.runtime!.hub!.status).not.toBe("idle");

    // Verify: distributed synthesis plan stored
    const dist = Memory.runtime!.hub!.distributedSynthesis;
    expect(dist).toBeDefined();
    expect(dist!.dispatchAssignments.length).toBeGreaterThanOrEqual(1);

    // Verify: synthesis configs written to multiple rooms
    const scRooms = Memory.cfg!.synthesisControl!.rooms!;
    const roomNames = Object.keys(scRooms);
    expect(roomNames.length).toBeGreaterThanOrEqual(2);

    // Each assigned room should have enabled:true and a reaction
    for (const assignment of dist!.dispatchAssignments) {
      const roomCfg = scRooms[assignment.roomName];
      expect(roomCfg).toBeDefined();
      expect(roomCfg!.enabled).toBe(true);
      expect(roomCfg!.reactions).toBeDefined();
      expect(roomCfg!.reactions!.length).toBeGreaterThanOrEqual(1);
      expect(roomCfg!.reactions![0].product).toBe(assignment.product);
      expect(roomCfg!.reactions![0].targetAmount).toBeGreaterThan(0);
    }

    // Verify: route decisions may create transfer tasks
    if (dist!.routeDecisions && dist!.routeDecisions.length > 0) {
      const taskStore = ensureResourceTransferTaskStore();
      const pendingTasks = Object.values(taskStore).filter(t => t.status === "pending");
      expect(pendingTasks.length).toBeGreaterThanOrEqual(1);
    }

    // Verify: hub progress snapshot includes all active production rooms
    Game.time = 1;
    const snapshot = collectHubProgressSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.productionRooms.length).toBeGreaterThanOrEqual(1);

    // Check that assigned rooms appear in productionRooms
    const snapshotRoomNames = snapshot.productionRooms.map(r => r.roomName);
    for (const assignment of dist!.dispatchAssignments) {
      expect(snapshotRoomNames).toContain(assignment.roomName);
    }

    // Hub room entry should be marked isHubRoom
    const hubEntry = snapshot.productionRooms.find(r => r.roomName === "W1N1");
    if (hubEntry) {
      expect(hubEntry.isHubRoom).toBe(true);
    }
    // Aux room entries should be marked !isHubRoom
    for (const assignment of dist!.dispatchAssignments) {
      if (!assignment.isHubRoom) {
        const entry = snapshot.productionRooms.find(r => r.roomName === assignment.roomName);
        expect(entry).toBeDefined();
        expect(entry!.isHubRoom).toBe(false);
      }
    }
  });

  it("progress snapshot includes upstream/downstream links between rooms", () => {
    // Set up pre-existing distributed synthesis data to test progress model directly
    const { room: hubRoom } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
      },
    });
    Game.rooms["W1N1"] = hubRoom;

    const { room: auxRoom1 } = createSynthesisRoom({
      name: "W2N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
        [RESOURCE_ZYNTHIUM_KEANITE]: 2000,
      },
    });
    Game.rooms["W2N1"] = auxRoom1;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "importing",
        updatedAt: 0,
        activeProduct: RESOURCE_HYDROXIDE,
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [RESOURCE_HYDROXIDE],
        needsPlan: false,
        distributedSynthesis: {
          dispatchAssignments: [
            { roomName: "W1N1", product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000, isHubRoom: true },
            { roomName: "W2N1", product: RESOURCE_ZYNTHIUM_KEANITE as ResourceConstant, targetAmount: 3000, isHubRoom: false },
          ],
          routeDecisions: [
            { fromRoom: "W1N1", toRoom: "W1N1", resource: RESOURCE_HYDROXIDE as ResourceConstant, amount: 2000, fee: 0 },
            { fromRoom: "W2N1", toRoom: "W1N1", resource: RESOURCE_ZYNTHIUM_KEANITE as ResourceConstant, amount: 1000, fee: 0 },
          ],
          progressEdges: [
            { fromRoom: "W2N1", toRoom: "W1N1", resource: RESOURCE_ZYNTHIUM_KEANITE as ResourceConstant, delivered: 500, total: 1000 },
          ],
        },
      },
      synthesisControl: {
        rooms: {
          W1N1: { stage: "synthesizing", activeProduct: RESOURCE_HYDROXIDE, reagentLabIds: ["l1", "l2"], productLabIds: ["l3"], successfulRuns: 5, pendingTasks: 0, lastTransitionAt: 0 },
          W2N1: { stage: "synthesizing", activeProduct: RESOURCE_ZYNTHIUM_KEANITE, reagentLabIds: ["l1", "l2"], productLabIds: ["l3"], successfulRuns: 3, pendingTasks: 0, lastTransitionAt: 0 },
        },
      } as any,
    };

    const snapshot = collectHubProgressSnapshot();
    expect(snapshot.productionRooms).toHaveLength(2);

    // Hub entry
    const hubEntry = snapshot.productionRooms.find(r => r.roomName === "W1N1")!;
    expect(hubEntry).toBeDefined();
    expect(hubEntry.isHubRoom).toBe(true);
    expect(hubEntry.product).toBe(RESOURCE_HYDROXIDE);
    expect(hubEntry.stage).toBe("synthesizing");
    // W1N1 receives ZK from W2N1 → downstream link
    expect(hubEntry.hubSurplusAmount).toBeGreaterThan(0);

    // Aux entry
    const auxEntry = snapshot.productionRooms.find(r => r.roomName === "W2N1")!;
    expect(auxEntry).toBeDefined();
    expect(auxEntry.isHubRoom).toBe(false);
    expect(auxEntry.product).toBe(RESOURCE_ZYNTHIUM_KEANITE);
    // W2N1 has upstream from progress edge
    expect(auxEntry.upstream.length + auxEntry.downstream.length).toBeGreaterThanOrEqual(1);
  });
});

describe("distributed synthesis integration – statusHub and hubProgressRaw visibility", () => {
  it("hubProgressRaw returns productionRooms with non-hub synthesis rooms after planner run", () => {
    // Hub + 1 aux room, targeting ZK (simple aux-room production)
    const { room: hubRoom } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
      },
    });
    Game.rooms["W1N1"] = hubRoom;

    const { room: auxRoom } = createSynthesisRoom({
      name: "W2N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_ZYNTHIUM]: 10000,
        [RESOURCE_KEANIUM]: 10000,
      },
    });
    Game.rooms["W2N1"] = auxRoom;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_ZYNTHIUM_KEANITE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
      },
    };

    Game.time = 0;
    runHubPlanner();

    // Get progress snapshot via console command
    const snapshot = hubProgressRaw();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.productionRooms.length).toBeGreaterThanOrEqual(1);

    // Non-hub rooms should appear
    const auxEntries = snapshot.productionRooms.filter(r => !r.isHubRoom);
    if (Memory.runtime!.hub!.distributedSynthesis?.dispatchAssignments?.some(a => !a.isHubRoom)) {
      expect(auxEntries.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("statusHubRaw shows active hub state but does not list distributed rooms (current behavior)", () => {
    // Verify current behavior: statusHubRaw shows hub synthesis state but
    // does not include distributed production rooms directly.
    // Users should use hubProgressRaw for distributed room details.
    const { room: hubRoom } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 5000,
        [RESOURCE_OXYGEN]: 5000,
      },
    });
    Game.rooms["W1N1"] = hubRoom;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: [RESOURCE_HYDROXIDE as ResourceConstant],
        internalOnly: true,
      },
      synthesisControl: {
        enabled: true,
        rooms: {
          W1N1: {
            enabled: true,
            batchSize: 500,
            maxRunsPerTick: 6,
            donorRoomNames: [],
            reagentLabIds: [],
            reactions: [
              {
                product: RESOURCE_HYDROXIDE as ResourceConstant,
                targetAmount: 5000,
                batchSize: 500,
                donorRoomNames: [],
              },
            ],
          },
        },
      },
    };
    Memory.runtime = {
      hub: {
        status: "importing",
        updatedAt: 0,
        activeProduct: RESOURCE_HYDROXIDE,
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [RESOURCE_HYDROXIDE],
        needsPlan: false,
      },
      synthesisControl: {
        updatedAt: 10,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W1N1: {
            stage: "synthesizing",
            activeProduct: RESOURCE_HYDROXIDE,
            reagentLabIds: ["l1", "l2"],
            productLabIds: ["l3"],
            successfulRuns: 5,
            pendingTasks: 0,
            lastTransitionAt: 0,
          } as any,
        },
      },
    };

    const result = statusHubRaw();
    // statusHubRaw shows hub-centric status
    expect(result).toMatchObject({
      enabled: true,
      hubRoomName: "W1N1",
      status: "active",
      activeProduct: RESOURCE_HYDROXIDE,
      activeStage: "synthesizing",
    });
    // It does not have a productionRooms field (by design — use hubProgressRaw for that)
    expect((result as any).productionRooms).toBeUndefined();
  });
});

describe("ordered pipeline integration regression – distributedStorage hub fallback", () => {
  it("runHubPlanner writes hub fallback reaction, runSynthesisControl consumes it same tick", () => {
    // Regression: when distributedStorage=true and hub room is NOT in dispatchAssignments,
    // runHubPlanner must still write a hub-room synthesisControl config (the fallback path
    // added in Task 2). runSynthesisControl must then consume that config and enter a
    // non-idle production stage.

    // Hub room: W1N1 — H+O below reservePerRoom (1000) so planHubChains sees them
    // and produces an OH step, but planDistributedSynthesis ledger subtracts the
    // reserve and sees 0 effective minerals for the hub → hub NOT dispatched.
    const { room: hubRoom } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROGEN]: 500,
        [RESOURCE_OXYGEN]: 500,
      },
    });
    Game.rooms["W1N1"] = hubRoom;

    // Aux room: W2N1 — Z+K above reserve so planDistributedSynthesis dispatches
    // ZK here, and wireDistributedSynthesis returns true (aux rooms exist).
    const { room: auxRoom } = createSynthesisRoom({
      name: "W2N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_ZYNTHIUM]: 30000,
        [RESOURCE_KEANIUM]: 30000,
      },
    });
    Game.rooms["W2N1"] = auxRoom;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE as ResourceConstant],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
        distributedStorage: true,
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: true,
      },
    };

    Game.time = 0;

    // ---- Step 1: runHubPlanner() ----
    runHubPlanner();

    // Verify: planner produced a non-idle hub status
    expect(Memory.runtime!.hub!.status).not.toBe("idle");
    expect(Memory.runtime!.hub!.status).not.toBe("blocked");
    expect(Memory.runtime!.hub!.activeProduct).toBeTruthy();
    expect(Memory.runtime!.hub!.needsPlan).toBe(false);

    // Verify: distributed synthesis is active (aux rooms exist)
    const dist = Memory.runtime!.hub!.distributedSynthesis;
    expect(dist).toBeDefined();

    // Verify: hub room has synthesisControl config written (the fallback path)
    const hubRoomCfg = Memory.cfg?.synthesisControl?.rooms?.["W1N1"];
    expect(hubRoomCfg).toBeDefined();
    expect(hubRoomCfg!.enabled).toBe(true);
    expect(hubRoomCfg!.reactions).toBeDefined();
    expect(hubRoomCfg!.reactions!.length).toBeGreaterThanOrEqual(1);

    // The hub room reaction product should match the first chain step
    const hubReaction = hubRoomCfg!.reactions![0];
    expect(hubReaction.targetAmount).toBeGreaterThan(0);
    expect(hubReaction.product).toBeTruthy();

    // Verify: hub is NOT in dispatch assignments (reservePerRoom trick prevents dispatch)
    expect(dist!.dispatchAssignments!.find(a => a.roomName === "W1N1")).toBeUndefined();

    // Hub fallback wrote the reaction matching the active product
    expect(hubReaction.product).toBe(Memory.runtime!.hub!.activeProduct);

    // ---- Step 2: runSynthesisControl() same tick ----
    Game.time = 1;
    runSynthesisControl();

    // Verify: hub room synthesis runtime entered a non-idle production path
    const hubSynthesisState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(hubSynthesisState).toBeDefined();
    expect(hubSynthesisState!.stage).not.toBe("idle");
    expect(hubSynthesisState!.stage).not.toBe("blocked");
    // The stage should be one of: acquiring, loading, or synthesizing
    expect(["acquiring", "loading", "synthesizing"]).toContain(hubSynthesisState!.stage);

    // The active product should match the config that runHubPlanner wrote
    expect(hubSynthesisState!.activeProduct).toBe(hubReaction.product);
  });
});

describe("main.ts tick-order invariant", () => {
  it("hubPlanner runs before synthesisControl and hubProgressAnalytics runs after both", () => {
    // Read main.ts and verify the call order is:
    // hubPlanner → synthesisControl → mineralExtraction → resourceControl → hubProgressAnalytics
    // This is a static analysis test, not a runtime test.
    const fs = require("fs");
    const path = require("path");
    const mainPath = path.join(__dirname, "..", "main.ts");
    const mainSrc = fs.readFileSync(mainPath, "utf-8");

    const hubPlannerIdx = mainSrc.indexOf('measure("hubPlanner"');
    const synthesisControlIdx = mainSrc.indexOf('measure("synthesisControl"');
    const mineralExtractionIdx = mainSrc.indexOf('measure("mineralExtraction"');
    const resourceControlIdx = mainSrc.indexOf('measure("resourceControl"');
    const hubProgressIdx = mainSrc.indexOf('measure("hubProgressAnalytics"');

    expect(hubPlannerIdx).toBeGreaterThan(-1);
    expect(synthesisControlIdx).toBeGreaterThan(-1);
    expect(mineralExtractionIdx).toBeGreaterThan(-1);
    expect(resourceControlIdx).toBeGreaterThan(-1);
    expect(hubProgressIdx).toBeGreaterThan(-1);

    // Verify order: hubPlanner < synthesisControl < mineralExtraction < resourceControl < hubProgressAnalytics
    expect(hubPlannerIdx).toBeLessThan(synthesisControlIdx);
    expect(synthesisControlIdx).toBeLessThan(mineralExtractionIdx);
    expect(mineralExtractionIdx).toBeLessThan(resourceControlIdx);
    expect(resourceControlIdx).toBeLessThan(hubProgressIdx);
  });
});
