import { runSynthesisControl } from "@/runtime/synthesisControl";
import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
} from "@/runtime/carrierTaskBoard";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
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

describe("synthesisControl state machine – happy-path lifecycle", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("progresses idle → loading → synthesizing → idle across ticks", () => {
    setConfig({ sampleInterval: 100 });

    const { room, labs, storageMap } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });
    Game.rooms["W1N1"] = room;

    Game.time = 10;
    runSynthesisControl();

    const runtime = Memory.runtime!.synthesisControl!;
    expect(runtime.rooms["W1N1"].stage).toBe("loading");
    expect(runtime.rooms["W1N1"].activeProduct).toBe(RESOURCE_HYDROXIDE);

    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[1].mineralType = RESOURCE_HYDROGEN;
    labs[1]._resourceMap[RESOURCE_HYDROGEN] = 500;

    Game.time = 20;
    runSynthesisControl();

    expect(runtime.rooms["W1N1"].stage).toBe("synthesizing");
    expect(labs[2].runReaction).toHaveBeenCalledWith(labs[0], labs[1]);

    storageMap[RESOURCE_HYDROXIDE] = 5000;

    Game.time = 30;
    runSynthesisControl();

    expect(runtime.rooms["W1N1"].stage).toBe("idle");
    const carrierTasks = getCarrierTasksByRoom("W1N1");
    expect(Object.keys(carrierTasks).length).toBe(0);
  });

  it("calls runReaction on each product lab with correct reagent lab arguments", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[1].mineralType = RESOURCE_HYDROGEN;
    labs[1]._resourceMap[RESOURCE_HYDROGEN] = 500;
    labs[2].mineralType = undefined;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(labs[2].runReaction).toHaveBeenCalledTimes(1);
    expect(labs[2].runReaction).toHaveBeenCalledWith(labs[0], labs[1]);

    const runtime = Memory.runtime!.synthesisControl!;
    expect(runtime.successfulRunCount).toBe(1);
    expect(runtime.rooms["W1N1"].successfulRuns).toBe(1);
  });

  it("limits runReaction calls to maxRunsPerTick across multiple product labs", () => {
    setConfig({ sampleInterval: 100, maxRunsPerTick: 2 });
    setRoomStage("synthesizing");

    const roomObj: Partial<Room> = {
      name: "W1N1",
      controller: { my: true, level: 7 } as StructureController,
    };

    const lab0 = createLab(roomObj as Room, "W1N1-lab-0", RESOURCE_OXYGEN, {
      [RESOURCE_OXYGEN]: 500,
    });
    const lab1 = createLab(roomObj as Room, "W1N1-lab-1", RESOURCE_HYDROGEN, {
      [RESOURCE_HYDROGEN]: 500,
    });
    const lab2 = createLab(roomObj as Room, "W1N1-lab-2");
    const lab3 = createLab(roomObj as Room, "W1N1-lab-3");
    const lab4 = createLab(roomObj as Room, "W1N1-lab-4");
    const allLabs = [lab0, lab1, lab2, lab3, lab4];

    Object.assign(roomObj, {
      storage: {
        id: "W1N1-storage",
        structureType: STRUCTURE_STORAGE,
        store: createStore({ [RESOURCE_ENERGY]: 500000 }),
      } as unknown as StructureStorage,
      terminal: {
        id: "W1N1-terminal",
        structureType: STRUCTURE_TERMINAL,
        cooldown: 0,
        store: createStore({}),
      } as unknown as StructureTerminal,
      find: ((type: FindConstant, opts?: { filter?: (s: Structure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          return opts?.filter
            ? allLabs.filter((s: any) => opts.filter!(s as Structure))
            : allLabs;
        }
        return [];
      }) as Room["find"],
    });

    Game.rooms["W1N1"] = roomObj as Room;
    Game.time = 10;

    runSynthesisControl();

    const totalCalls =
      lab2.runReaction.mock.calls.length +
      lab3.runReaction.mock.calls.length +
      lab4.runReaction.mock.calls.length;
    expect(totalCalls).toBe(2);
    expect(Memory.runtime!.synthesisControl!.successfulRunCount).toBe(2);
  });

  it("transitions to idle when targetAmount is reached during synthesizing", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
    });

    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[1].mineralType = RESOURCE_HYDROGEN;
    labs[1]._resourceMap[RESOURCE_HYDROGEN] = 500;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("idle");
    expect(roomState.activeProduct).toBeUndefined();
  });
});

describe("contamination cleanup", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("contamination triggers unloading and cleanup task", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    const contaminatedLab = createLab(room, "W1N1-lab-contam", "K" as ResourceConstant, {
      K: 200,
    });
    const correctLab = createLab(room, "W1N1-lab-correct", RESOURCE_HYDROGEN, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    const productLab = createLab(room, "W1N1-lab-product");

    const allLabs = [contaminatedLab, correctLab, productLab];
    (room as any).find = ((
      type: FindConstant,
      opts?: { filter?: (structure: Structure) => boolean },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allLabs.filter((s: any) => opts.filter!(s as Structure))
          : allLabs;
      }
      return [];
    }) as Room["find"];

    const labById: Record<string, any> = {
      [contaminatedLab.id]: contaminatedLab,
      [correctLab.id]: correctLab,
      [productLab.id]: productLab,
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("unloading");

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const taskIds = Object.keys(carrierTasks);
    expect(taskIds.length).toBeGreaterThanOrEqual(1);

    const cleanupTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_cleanup",
    );
    expect(cleanupTask).toBeDefined();
    expect(cleanupTask!.steps.length).toBeGreaterThanOrEqual(1);
    expect(cleanupTask!.steps.some((s) => s.resource === "K")).toBe(true);
    expect(cleanupTask!.steps.some((s) => s.fromId === "W1N1-lab-contam")).toBe(true);
  });

  it("cleanup task has correct from/to/resource/amount", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    const contaminatedLab = createLab(room, "W1N1-lab-contam", "K" as ResourceConstant, {
      K: 200,
    });
    const correctLab = createLab(room, "W1N1-lab-correct", RESOURCE_HYDROGEN, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    const productLab = createLab(room, "W1N1-lab-product");

    const allLabs = [contaminatedLab, correctLab, productLab];
    (room as any).find = ((
      type: FindConstant,
      opts?: { filter?: (structure: Structure) => boolean },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allLabs.filter((s: any) => opts.filter!(s as Structure))
          : allLabs;
      }
      return [];
    }) as Room["find"];

    const labById: Record<string, any> = {
      [contaminatedLab.id]: contaminatedLab,
      [correctLab.id]: correctLab,
      [productLab.id]: productLab,
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const cleanupTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_cleanup",
    );
    expect(cleanupTask).toBeDefined();

    const contamStep = cleanupTask!.steps.find((s) => s.resource === "K");
    expect(contamStep).toBeDefined();
    expect(contamStep!.fromKind).toBe("lab");
    expect(contamStep!.fromId).toBe("W1N1-lab-contam");
    expect(contamStep!.toKind === "terminal" || contamStep!.toKind === "storage").toBe(true);
    expect(contamStep!.amount).toBe(200);
  });

  it("full storage + terminal records lastError for hub room", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 500000 },
    });

    const storageStore = room.storage!.store;
    const terminalStore = room.terminal!.store;
    (storageStore as any).getFreeCapacity = () => 0;
    (terminalStore as any).getFreeCapacity = () => 0;

    const contaminatedLab = createLab(room, "W1N1-lab-contam", "K" as ResourceConstant, {
      K: 200,
    });
    const correctLab = createLab(room, "W1N1-lab-correct", RESOURCE_HYDROGEN, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    const productLab = createLab(room, "W1N1-lab-product");

    const allLabs = [contaminatedLab, correctLab, productLab];
    (room as any).find = ((
      type: FindConstant,
      opts?: { filter?: (structure: Structure) => boolean },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allLabs.filter((s: any) => opts.filter!(s as Structure))
          : allLabs;
      }
      return [];
    }) as Room["find"];

    const labById: Record<string, any> = {
      [contaminatedLab.id]: contaminatedLab,
      [correctLab.id]: correctLab,
      [productLab.id]: productLab,
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(Memory.runtime!.hub).toBeDefined();
    expect(Memory.runtime!.hub!.lastError).toBe("lab_cleanup_destination_full");
  });

  it("full storage + terminal does NOT set lastError for non-hub room", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    Memory.cfg!.hub = {
      hubRoomName: "W2N2",
      enabled: true,
      internalOnly: true,
    };

    const { room } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      terminalResources: { [RESOURCE_ENERGY]: 500000 },
    });

    const storageStore = room.storage!.store;
    const terminalStore = room.terminal!.store;
    (storageStore as any).getFreeCapacity = () => 0;
    (terminalStore as any).getFreeCapacity = () => 0;

    const contaminatedLab = createLab(room, "W1N1-lab-contam", "K" as ResourceConstant, {
      K: 200,
    });
    const correctLab = createLab(room, "W1N1-lab-correct", RESOURCE_HYDROGEN, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    const productLab = createLab(room, "W1N1-lab-product");

    const allLabs = [contaminatedLab, correctLab, productLab];
    (room as any).find = ((
      type: FindConstant,
      opts?: { filter?: (structure: Structure) => boolean },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allLabs.filter((s: any) => opts.filter!(s as Structure))
          : allLabs;
      }
      return [];
    }) as Room["find"];

    const labById: Record<string, any> = {
      [contaminatedLab.id]: contaminatedLab,
      [correctLab.id]: correctLab,
      [productLab.id]: productLab,
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(Memory.runtime!.hub?.lastError).not.toBe("lab_cleanup_destination_full");
  });
});

describe("hub completion signal", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("sets needsPlan=true when hub room completes reaction target", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
    });

    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[1].mineralType = RESOURCE_HYDROGEN;
    labs[1]._resourceMap[RESOURCE_HYDROGEN] = 500;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("idle");
    expect(Memory.runtime!.hub).toBeDefined();
    expect(Memory.runtime!.hub!.needsPlan).toBe(true);
  });

  it("initializes Memory.runtime.hub when it does not exist", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
    });

    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[1].mineralType = RESOURCE_HYDROGEN;
    labs[1]._resourceMap[RESOURCE_HYDROGEN] = 500;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(Memory.runtime!.hub).toBeDefined();
    expect(Memory.runtime!.hub!.needsPlan).toBe(true);
    expect(Memory.runtime!.hub!.updatedAt).toBe(10);
  });

  it("does NOT set needsPlan for non-hub room", () => {
    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    Memory.cfg!.hub = {
      hubRoomName: "W2N2",
      enabled: true,
      internalOnly: true,
    };

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 5000,
      },
    });

    labs[0].mineralType = RESOURCE_OXYGEN;
    labs[0]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[1].mineralType = RESOURCE_HYDROGEN;
    labs[1]._resourceMap[RESOURCE_HYDROGEN] = 500;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("idle");
    expect(Memory.runtime!.hub?.needsPlan).toBeFalsy();
  });
});
