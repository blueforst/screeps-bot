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

describe("lab_product_unload task generation", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 0;
    Game.rooms = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("generates lab_product_unload when product lab holds completed product and storage+terminal below target", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.priority).toBe(180);
    expect(unloadTask!.steps.length).toBeGreaterThanOrEqual(1);
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(unloadTask!.steps[0].fromId).toBe(labs[2].id);
    expect(unloadTask!.steps[0].fromKind).toBe("lab");
    expect(unloadTask!.steps[0].toKind).toBe("storage");
    expect(unloadTask!.steps[0].toId).toBe((room.storage as StructureStorage).id);
  });

  it("targets terminal when storage is full", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 3000 },
      terminalResources: {},
    });

    const storageStore = (room.storage as StructureStorage).store as any;
    storageStore.getFreeCapacity = () => 0;

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.steps[0].toKind).toBe("terminal");
    expect(unloadTask!.steps[0].toId).toBe((room.terminal as StructureTerminal).id);
  });

  it("sets lastError when both storage and terminal are full", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 3000 },
      terminalResources: { [RESOURCE_ENERGY]: 3000 },
    });

    const storageStore = (room.storage as StructureStorage).store as any;
    storageStore.getFreeCapacity = () => 0;
    const terminalStore = (room.terminal as StructureTerminal).store as any;
    terminalStore.getFreeCapacity = () => 0;

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(Memory.runtime!.hub).toBeDefined();
    expect(Memory.runtime!.hub!.lastError).toBe("lab_product_unload_destination_full");
  });

  it("only generates steps for non-empty labs with correct product", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_HYDROXIDE,
      reagentA: RESOURCE_OXYGEN,
      reagentB: RESOURCE_HYDROGEN,
      targetAmount: 5000,
    });

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
    const lab2 = createLab(roomObj as Room, "W1N1-lab-2", RESOURCE_HYDROXIDE as ResourceConstant, {
      [RESOURCE_HYDROXIDE]: 200,
    });
    const lab3 = createLab(roomObj as Room, "W1N1-lab-3");
    const allLabs = [lab0, lab1, lab2, lab3];

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

    const labById: Record<string, any> = {
      [lab0.id]: lab0,
      [lab1.id]: lab1,
      [lab2.id]: lab2,
      [lab3.id]: lab3,
      "W1N1-storage": (roomObj as any).storage,
      "W1N1-terminal": (roomObj as any).terminal,
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = roomObj as Room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    if (unloadTask) {
      expect(unloadTask.steps.length).toBe(1);
      expect(unloadTask.steps[0].fromId).toBe(lab2.id);
    }
  });

  it("does not generate lab_product_unload when transferable amount meets target", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_HYDROXIDE,
      reagentA: RESOURCE_OXYGEN,
      reagentB: RESOURCE_HYDROGEN,
      targetAmount: 5000,
    });

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
    labs[2].mineralType = RESOURCE_HYDROXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_HYDROXIDE] = 100;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeUndefined();
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

  it("generates product-unload and stage=unloading when product in lab meets target but storage+terminal is empty", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

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
    expect(roomState.lastError).toBeUndefined();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.priority).toBe(180);
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(unloadTask!.steps[0].fromId).toBe(labs[2].id);
    expect(unloadTask!.steps[0].fromKind).toBe("lab");
    expect(unloadTask!.steps[0].toKind).toBe("storage");
  });

  it("does not set needsPlan when already in product-unload unloading stage", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    setRoomStage("unloading", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      targetAmount: 106,
    });

    Memory.runtime!.hub = { needsPlan: false, updatedAt: 5 };

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    expect(Memory.runtime!.hub!.needsPlan).toBe(false);
  });

  it("sets needsPlan on synthesizing-to-unloading transition (completion signal)", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });

    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      internalOnly: true,
    };

    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

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
    expect(Memory.runtime!.hub!.needsPlan).toBe(true);
  });

  it("generates prevProductUnloadTask when autoPlan switches product from UO to OH", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: { [RESOURCE_ENERGY]: 500000 },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(unloadTask!.steps[0].fromId).toBe(labs[2].id);
    expect(unloadTask!.steps[0].fromKind).toBe("lab");

    const cleanupTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_cleanup",
    );
    expect(cleanupTask).toBeDefined();
    expect(cleanupTask!.priority).toBeGreaterThan(unloadTask!.priority);
  });

  it("product-unload has no lastError; contamination has lastError=lab_contaminated_waiting_clear", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

    const labById: Record<string, any> = {
      [labs[0].id]: labs[0],
      [labs[1].id]: labs[1],
      [labs[2].id]: labs[2],
    };
    (Game as any).getObjectById = (id: string) => labById[id] ?? null;

    Game.rooms["W1N1"] = room;
    Game.time = 10;

    runSynthesisControl();

    let roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("unloading");
    expect(roomState.lastError).toBeUndefined();

    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 20;
    Memory.runtime = undefined;

    setConfig({ sampleInterval: 100 });
    setRoomStage("synthesizing");

    const { room: room2 } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    const contaminatedLab = createLab(room2, "W1N1-lab-contam", "K" as ResourceConstant, {
      K: 200,
    });
    const correctLab = createLab(room2, "W1N1-lab-correct", RESOURCE_HYDROGEN, {
      [RESOURCE_HYDROGEN]: 1000,
    });
    const productLab = createLab(room2, "W1N1-lab-product");

    const allLabs = [contaminatedLab, correctLab, productLab];
    (room2 as any).find = ((
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

    const labById2: Record<string, any> = {
      [contaminatedLab.id]: contaminatedLab,
      [correctLab.id]: correctLab,
      [productLab.id]: productLab,
    };
    (Game as any).getObjectById = (id: string) => labById2[id] ?? null;

    Game.rooms["W1N1"] = room2;

    runSynthesisControl();

    roomState = Memory.runtime!.synthesisControl!.rooms["W1N1"];
    expect(roomState.stage).toBe("unloading");
    expect(roomState.lastError).toBe("lab_contaminated_waiting_clear");
  });

  it("stranded recovery: idle with no activeProduct, product lab has UO, targetAmount=106 → generates lab_product_unload", () => {
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
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 0;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 0;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

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
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(roomState.targetAmount).toBe(106);

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(unloadTask!.steps[0].fromId).toBe(labs[2].id);
    expect(unloadTask!.steps[0].fromKind).toBe("lab");
    expect(unloadTask!.steps[0].toKind).toBe("storage");
    expect(unloadTask!.steps[0].amount).toBe(110);
  });

  it("stranded recovery: empty product labs with idle/no-activeProduct → no carrier task, remains idle", () => {
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
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeUndefined();
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
    expect(unloadTask!.steps[0].fromId).toBe(labs[2].id);
    expect(unloadTask!.steps[0].amount).toBe(50);
  });

  it("stranded recovery: normal active-plan path still produces supply/product-unload without invoking stranded recovery", () => {
    setConfig({
      sampleInterval: 100,
      reactions: [
        { product: RESOURCE_UTRIUM_OXIDE as ResourceConstant, targetAmount: 106 },
      ],
    });
    setRoomStage("synthesizing", {
      activeProduct: RESOURCE_UTRIUM_OXIDE,
      reagentA: RESOURCE_UTRIUM,
      reagentB: RESOURCE_OXYGEN,
      targetAmount: 106,
    });

    const { room, labs } = createSynthesisRoom({
      name: "W1N1",
      storageResources: {
        [RESOURCE_ENERGY]: 500000,
        [RESOURCE_UTRIUM]: 2000,
        [RESOURCE_OXYGEN]: 2000,
        [RESOURCE_HYDROXIDE]: 2000,
      },
    });

    labs[0].mineralType = RESOURCE_UTRIUM;
    labs[0]._resourceMap[RESOURCE_UTRIUM] = 500;
    labs[1].mineralType = RESOURCE_OXYGEN;
    labs[1]._resourceMap[RESOURCE_OXYGEN] = 500;
    labs[2].mineralType = RESOURCE_UTRIUM_OXIDE as ResourceConstant;
    labs[2]._resourceMap[RESOURCE_UTRIUM_OXIDE as string] = 110;

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
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(roomState.targetAmount).toBe(106);

    const carrierTasks = getCarrierTasksByRoom("W1N1");
    const unloadTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_product_unload",
    );
    expect(unloadTask).toBeDefined();
    expect(unloadTask!.steps[0].resource).toBe(RESOURCE_UTRIUM_OXIDE as ResourceConstant);

    const supplyTask = Object.values(carrierTasks).find(
      (t) => t.type === "lab_supply",
    );
    expect(supplyTask).toBeUndefined();
  });
});
