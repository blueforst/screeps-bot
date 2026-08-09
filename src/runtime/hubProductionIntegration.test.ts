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
