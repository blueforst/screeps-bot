import { runSynthesisControl } from "@/runtime/synthesisControl";
import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
} from "@/runtime/carrierTaskBoard";
import { ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  __creepAssignmentState?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(map: Record<string, number> = {}) {
  return {
    getUsedCapacity: (resource?: ResourceConstant): number => {
      if (resource !== undefined) return map[resource] ?? 0;
      return Object.values(map).reduce((s, v) => s + v, 0);
    },
    getFreeCapacity: (resource?: ResourceConstant): number => {
      const used =
        resource !== undefined
          ? (map[resource] ?? 0)
          : Object.values(map).reduce((s, v) => s + v, 0);
      return 3000 - used;
    },
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

  const storageStore = createStore(storageMap);
  const terminalStore = createStore(terminalMap);

  const room = {
    name: options.name,
    controller: { my: true, level: 7 } as StructureController,
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
    opts?: { filter?: (structure: Structure) => boolean },
  ) => {
    if (type === FIND_MY_STRUCTURES) {
      return opts?.filter
        ? labs.filter((s: any) => opts.filter!(s as Structure))
        : labs;
    }
    if (type === FIND_MINERALS) return [];
    return [];
  }) as Room["find"];

  return { room, labs, storageMap };
}

function setConfig(overrides?: {
  sampleInterval?: number;
  maxRunsPerTick?: number;
  reactions?: Array<{ product: ResourceConstant; targetAmount: number; batchSize?: number }>;
}) {
  Memory.cfg = {
    synthesisControl: {
      enabled: true,
      sampleInterval: overrides?.sampleInterval ?? 10,
      defaultBatchSize: 500,
      defaultMaxRunsPerTick: 6,
      rooms: {
        W1N1: {
          enabled: true,
          batchSize: 500,
          maxRunsPerTick: overrides?.maxRunsPerTick ?? 6,
          reactions: overrides?.reactions ?? [
            { product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000 },
          ],
        },
      },
    },
  };
}

function setRoomStage(
  stage: "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked",
  extra?: Record<string, unknown>,
): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.synthesisControl) {
    Memory.runtime.synthesisControl = {
      updatedAt: Game.time,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: {},
    };
  }
  const existing: any = Memory.runtime.synthesisControl.rooms["W1N1"] || {};
  Memory.runtime.synthesisControl.rooms["W1N1"] = {
    ...existing,
    stage,
    reagentLabIds: (existing as any).reagentLabIds || [],
    productLabIds: (existing as any).productLabIds || [],
    successfulRuns: 0,
    pendingTasks: 0,
    lastTransitionAt: Game.time,
    activeProduct: RESOURCE_HYDROXIDE,
    reagentA: RESOURCE_OXYGEN,
    reagentB: RESOURCE_HYDROGEN,
    targetAmount: 5000,
    batchSize: 500,
    ...extra,
  } as any;
}

describe("stale hub lastError cleanup", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("clears stale Memory.runtime.hub.lastError when storage/terminal capacity has recovered", () => {
    setConfig({ sampleInterval: 100 });

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    // Simulate a stale error left over from a previous tick where destination was full.
    Memory.runtime = {
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
    Memory.runtime.hub = { lastError: "lab_product_unload_destination_full" };

    // Room has free storage/terminal capacity and target already met, so no
    // destination-full condition is re-triggered this tick.
    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
    });

    labs[0].mineralType = undefined;
    labs[0]._resourceMap = {};
    labs[1].mineralType = undefined;
    labs[1]._resourceMap = {};
    labs[2].mineralType = undefined;
    labs[2]._resourceMap = {};

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(Memory.runtime.hub).toBeDefined();
    expect(Memory.runtime.hub!.lastError).toBeUndefined();
  });
});

describe("E4N58 stall regression", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("stranded recovery: storage already has UO above target AND product lab has UO → stranded unload still generates", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("idle", {
      activeProduct: undefined,
      reagentA: undefined,
      reagentB: undefined,
      targetAmount: undefined,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_UTRIUM_OXIDE as string]: 200,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 0;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 0;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 1000;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("unloading");

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(unloadTask!.steps[0].fromId).toBe(labs[2].id);
    expect(unloadTask!.steps[0].amount).toBe(1000);
  });
});

describe("batch-complete unload gate (Bug A regression)", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("generates lab_product_unload for small residue when target is met but lab has leftover product", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 5000 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 5000,
      batchSize: 500,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_UTRIUM_OXIDE as string]: 4950,
      },
    });

    // Product lab has 50 residue; storage has 4950, total = 5000 ≥ target 5000
    // chooseActivePlan returns null (total met)
    // transferableCurrent = 4950 < 5000 → primary unload doesn't early-return
    // minLabAmount=1 → lab 50 ≥ 1 → unload step generated
    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 0;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 0;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 50;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("unloading");

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(unloadTask!.steps[0].amount).toBe(50);
  });
});

describe("reagent lab cleanup when idle (Bug B regression)", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("returns to idle after reagent cleanup completes (labs empty)", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 61 },
      ],
    });
    setRoomStage("idle", {
      activeProduct: undefined,
      reagentA: undefined,
      reagentB: undefined,
      targetAmount: undefined,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_UTRIUM_OXIDE as string]: 65,
        [RESOURCE_HYDROXIDE]: 2500,
      },
    });

    // All labs empty — nothing to clean up
    labs[0].mineralType = undefined;
    labs[0]._resourceMap = {};
    labs[1].mineralType = undefined;
    labs[1]._resourceMap = {};
    labs[2].mineralType = undefined;
    labs[2]._resourceMap = {};

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("idle");
    expect(roomState.activeProduct).toBeUndefined();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    expect(Object.keys(carrierTasks).length).toBe(0);
  });

  it("product unload takes priority over reagent cleanup", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 100 },
      ],
    });
    setRoomStage("idle", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      targetAmount: 100,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 2500,
      },
    });

    // Product lab has product AND reagent labs have residue
    // UO total = 1000 (lab) >= targetAmount 100 → chooseActivePlan returns null
    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 45;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 735;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 1000;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("unloading");

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    // Should have product unload task
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    // Reagent cleanup should NOT be generated when product unload exists
    const cleanupTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_cleanup" && t.id.includes("reagent-residue"),
    );
    expect(cleanupTask).toBeUndefined();
  });
});

describe("in-flight synthesis cargo suppresses duplicate supply demand", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Game.creeps = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
    delete (global as RuntimeGlobal).__creepAssignmentState;
  });

  it("partial top-up with in-flight cargo: deficit < LAB_REACTION_AMOUNT still generates step when effectiveCurrentAmount > 0", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000 },
      ],
    });
    // Override batchSize to MAX_BATCH_SIZE (3000) so desiredLabAmount = 3000
    (Memory.cfg!.synthesisControl!.rooms!["W1N1"] as any).batchSize = 3000;
    setRoomStage("loading", {
      activeProduct: RESOURCE_HYDROXIDE,
      reagentA: RESOURCE_OXYGEN,
      reagentB: RESOURCE_HYDROGEN,
      targetAmount: 5000,
      batchSize: 3000,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_OXYGEN]: 200,
        [RESOURCE_HYDROGEN]: 1000,
      },
    });

    // Oxygen lab has 2946 — almost full; mutate _resourceMap in-place (store shares the same map)
    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 2946;
    labs[1].mineralType = RESOURCE_HYDROGEN;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    // Carrier has 50 oxygen in-flight toward the oxygen lab
    const carrierStore = createStore({ [RESOURCE_OXYGEN]: 50 });
    (Game as any).creeps = {
      "carrier-W1N1-1": {
        name: "carrier-W1N1-1",
        store: carrierStore,
        room,
      } as unknown as Creep,
    };

    const carrierState = ensureCreepAssignmentState("carrier-W1N1-1");
    carrierState.synthesisCarrierPendingToId = labs[0].id;
    carrierState.synthesisCarrierPendingResource = RESOURCE_OXYGEN;

    // effectiveCurrentAmount = 2946 (lab) + 50 (in-flight) = 2996
    // With early skip at > 2200, oxygen lab is skipped entirely — already has enough reagent.

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const supplyTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_supply",
    );

    const oxygenStep = supplyTask?.steps?.find(
      (s: any) => s.resource === RESOURCE_OXYGEN && s.toId === labs[0].id,
    );
    // Oxygen lab has effectiveCurrentAmount=2996 > 2200, so no supply step is generated
    expect(oxygenStep).toBeUndefined();
  });
});
