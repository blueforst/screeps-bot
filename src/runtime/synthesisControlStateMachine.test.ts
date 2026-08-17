import { runSynthesisControl } from "@/runtime/synthesisControl";
import {
  clearCarrierTaskBoardForTest,
} from "@/runtime/carrierTaskBoard";

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
  reactions?: Array<{ product: ResourceConstant; targetAmount: number; batchSize?: number }>;
}) {
  Memory.cfg = {
    synthesisControl: {
      enabled: true,
      sampleInterval: overrides?.sampleInterval ?? 10,
      defaultBatchSize: 500,
      rooms: {
        W1N1: {
          enabled: true,
          batchSize: 500,
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

function setupEightProductLabSynthesisRoom(): { room: Room; labs: LabHandle[] } {
  setConfig({
    reactions: [
      { product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000, batchSize: 500 },
    ],
  });
  setRoomStage("synthesizing", {
    activeProduct: RESOURCE_HYDROXIDE,
    reagentA: RESOURCE_OXYGEN,
    reagentB: RESOURCE_HYDROGEN,
    targetAmount: 5000,
    batchSize: 500,
    nextReactionAt: undefined,
  });

  const { room, labs } = createSynthesisRoom({
    name: "W1N1",
    storageResources: {
      [RESOURCE_ENERGY]: 500000,
    },
  });
  const tenLabs = Array.from({ length: 10 }, (_, index) =>
    createLab(room, `W1N1-lab-${index + 1}`),
  );
  labs.splice(0, labs.length, ...tenLabs);

  labs[0].mineralType = RESOURCE_OXYGEN;
  labs[0]._resourceMap[RESOURCE_OXYGEN] = 3000;
  labs[1].mineralType = RESOURCE_HYDROGEN;
  labs[1]._resourceMap[RESOURCE_HYDROGEN] = 3000;

  const labById = Object.fromEntries(labs.map((lab) => [lab.id, lab]));
  (Game as any).getObjectById = (id: string) => labById[id] ?? null;
  Memory.cfg!.synthesisControl!.rooms!.W1N1.reagentLabIds = [labs[0].id, labs[1].id];
  Game.rooms.W1N1 = room;

  return { room, labs };
}

describe("reaction cooldown scheduling", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 100;
    Game.rooms = {};
    Game.creeps = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
  });

  it("runs all eight product labs together and skips lab scans until the product cooldown expires", () => {
    const { room, labs } = setupEightProductLabSynthesisRoom();
    const productLabs = labs.slice(2);
    Memory.cfg!.synthesisControl!.rooms!.W1N1.reactions!.push({
      product: RESOURCE_UTRIUM_OXIDE as ResourceConstant,
      targetAmount: 5000,
    });
    const findSpy = jest.spyOn(room, "find");

    runSynthesisControl();

    for (const lab of productLabs) {
      expect(lab.runReaction).toHaveBeenCalledTimes(1);
    }
    const reactionInterval = REACTION_TIME[RESOURCE_HYDROXIDE];
    expect(Memory.runtime!.synthesisControl!.rooms.W1N1.nextReactionAt).toBe(
      Game.time + reactionInterval,
    );

    findSpy.mockClear();
    Game.time += 1;
    runSynthesisControl();

    expect(findSpy).not.toHaveBeenCalled();
    for (const lab of productLabs) {
      expect(lab.runReaction).toHaveBeenCalledTimes(1);
    }

    Game.time = 100 + reactionInterval;
    runSynthesisControl();

    expect(findSpy).toHaveBeenCalled();
    for (const lab of productLabs) {
      expect(lab.runReaction).toHaveBeenCalledTimes(2);
    }
  });

  it("waits for the slowest legacy cooldown before synchronizing every product lab", () => {
    const { room, labs } = setupEightProductLabSynthesisRoom();
    const productLabs = labs.slice(2);
    for (const lab of productLabs.slice(0, 6)) {
      lab.cooldown = 5;
    }
    for (const lab of productLabs.slice(6)) {
      lab.cooldown = 6;
    }
    const findSpy = jest.spyOn(room, "find");

    runSynthesisControl();

    for (const lab of productLabs) {
      expect(lab.runReaction).not.toHaveBeenCalled();
    }
    expect(Memory.runtime!.synthesisControl!.rooms.W1N1.nextReactionAt).toBe(106);

    findSpy.mockClear();
    Game.time = 101;
    runSynthesisControl();
    expect(findSpy).not.toHaveBeenCalled();

    for (const lab of productLabs) {
      lab.cooldown = 0;
    }
    Game.time = 106;
    runSynthesisControl();

    for (const lab of productLabs) {
      expect(lab.runReaction).toHaveBeenCalledTimes(1);
    }
    expect(Memory.runtime!.synthesisControl!.rooms.W1N1.nextReactionAt).toBe(
      106 + REACTION_TIME[RESOURCE_HYDROXIDE],
    );
  });
});
