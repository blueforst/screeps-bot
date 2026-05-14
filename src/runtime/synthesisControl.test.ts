import { runSynthesisControl } from "@/runtime/synthesisControl";
import {
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type GameWithPartialMarket = Omit<Game, "market"> & {
  market: {
    calcTransactionCost: (amount: number, fromRoom: string, toRoom: string) => number;
  };
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createLab(room: Room, id: string): StructureLab {
  return {
    id,
    room,
    structureType: STRUCTURE_LAB,
    pos: {
      inRangeTo: () => true,
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: () => 0,
    },
    runReaction: jest.fn(() => OK),
    cooldown: 0,
  } as unknown as StructureLab;
}

function createRoomWithResources(options: {
  name: string;
  mineralType: MineralConstant;
  storageEnergy?: number;
  terminalResources?: Partial<Record<ResourceConstant, number>>;
}): Room {
  const terminalResources = options.terminalResources || {};
  const room = {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === RESOURCE_ENERGY) {
            return options.storageEnergy ?? 0;
          }
          return 0;
        },
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource && resource in terminalResources) {
            return terminalResources[resource]!;
          }
          return 0;
        },
        getFreeCapacity: () => 100000,
      },
    } as unknown as StructureTerminal,
  } as Room;

  const labs = [
    createLab(room, `${options.name}-lab-1`),
    createLab(room, `${options.name}-lab-2`),
    createLab(room, `${options.name}-lab-3`),
  ];
  room.find = ((type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) => {
    if (type === FIND_MINERALS) {
      return [{ id: `${options.name}-mineral`, mineralType: options.mineralType, room } as Mineral];
    }
    if (type === FIND_MY_STRUCTURES) {
      return opts?.filter ? labs.filter((structure) => opts.filter?.(structure)) : labs;
    }
    return [];
  }) as Room["find"];
  return room;
}

describe("runSynthesisControl hub import guard", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          W1N1: {
            reactions: [
              {
                product: RESOURCE_UTRIUM_HYDRIDE,
                targetAmount: 5000,
              },
            ],
          },
        },
      },
    };
    Memory.runtime = undefined;
    Memory.rooms = {};
    Memory.data = undefined;
    Game.rooms = {};
    Game.spawns = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: () => 0,
    };
  });

  it("skips synthesis transfer for reagent fully covered by hub:import task", () => {
    const hubRoom = createRoomWithResources({
      name: "W1N1",
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    const donorRoom = createRoomWithResources({
      name: "W2N1",
      mineralType: RESOURCE_HYDROGEN,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_HYDROGEN]: 5000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    const hubImportResult = createResourceTransferTask(
      donorRoom.name,
      hubRoom.name,
      RESOURCE_UTRIUM,
      500,
      `hub:import:${RESOURCE_UTRIUM}`,
    );
    expect(hubImportResult).not.toBe("string" as never);
    expect(typeof hubImportResult).toBe("object");

    runSynthesisControl();

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const hubImportTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason === `hub:import:${RESOURCE_UTRIUM}`,
    );
    expect(hubImportTasks.length).toBe(1);

    const synthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:"),
    );
    const utriumSynthesisTasks = synthesisTasks.filter((t) => t.resource === RESOURCE_UTRIUM);
    expect(utriumSynthesisTasks.length).toBe(0);

    const hydrogenSynthesisTasks = synthesisTasks.filter((t) => t.resource === RESOURCE_HYDROGEN);
    expect(hydrogenSynthesisTasks.length).toBe(1);
  });

  it("creates normal synthesis transfer when no hub import covers the deficit", () => {
    const hubRoom = createRoomWithResources({
      name: "W1N1",
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    const donorRoom = createRoomWithResources({
      name: "W2N1",
      mineralType: RESOURCE_HYDROGEN,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_HYDROGEN]: 5000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    runSynthesisControl();

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const synthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:"),
    );
    expect(synthesisTasks.length).toBeGreaterThanOrEqual(1);

    const utriumSynthesisTasks = synthesisTasks.filter((t) => t.resource === RESOURCE_UTRIUM);
    expect(utriumSynthesisTasks.length).toBe(1);
  });

  it("skips synthesis transfer for reagent fully covered by hub:reclaim task", () => {
    const hubRoom = createRoomWithResources({
      name: "W1N1",
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    const donorRoom = createRoomWithResources({
      name: "W2N1",
      mineralType: RESOURCE_HYDROGEN,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_HYDROGEN]: 5000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    const reclaimResult = createResourceTransferTask(
      donorRoom.name,
      hubRoom.name,
      RESOURCE_UTRIUM,
      500,
      `hub:reclaim:${RESOURCE_UTRIUM}`,
    );
    expect(reclaimResult).not.toBe("string" as never);

    runSynthesisControl();

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const synthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:"),
    );
    const utriumSynthesisTasks = synthesisTasks.filter((t) => t.resource === RESOURCE_UTRIUM);
    expect(utriumSynthesisTasks.length).toBe(0);
  });

  it("creates synthesis transfer for remaining deficit when hub import partially covers", () => {
    const hubRoom = createRoomWithResources({
      name: "W1N1",
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    const donorRoom = createRoomWithResources({
      name: "W2N1",
      mineralType: RESOURCE_HYDROGEN,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM]: 5000,
        [RESOURCE_HYDROGEN]: 5000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    const hubImportResult = createResourceTransferTask(
      donorRoom.name,
      hubRoom.name,
      RESOURCE_UTRIUM,
      200,
      `hub:import:${RESOURCE_UTRIUM}`,
    );
    expect(hubImportResult).not.toBe("string" as never);

    runSynthesisControl();

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const synthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:"),
    );
    const utriumSynthesisTasks = synthesisTasks.filter((t) => t.resource === RESOURCE_UTRIUM);
    expect(utriumSynthesisTasks.length).toBe(1);
    expect(utriumSynthesisTasks[0].amount).toBe(300);
  });
});

describe("non-hub synthesis completion signals hub needsPlan with debounce", () => {
  const HUB_ROOM = "W1N1";
  const AUX_ROOM = "W2N1";
  const PLAN_INTERVAL = 50;

  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 100;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          [HUB_ROOM]: {
            reactions: [],
          },
          [AUX_ROOM]: {
            enabled: true,
            reactions: [
              { product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 100, batchSize: 100, donorRoomNames: [] },
            ],
          },
        },
      },
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: PLAN_INTERVAL,
      },
    };
    Memory.runtime = undefined;
    Memory.rooms = {};
    Memory.data = undefined;
    Game.rooms = {};
    Game.spawns = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: () => 0,
    };
  });

  it("sets needsPlan for non-hub room when product reaches target", () => {
    const auxRoom = createRoomWithResources({
      name: AUX_ROOM,
      mineralType: RESOURCE_KEANIUM,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM_HYDRIDE]: 200,
      },
    });
    const hubRoom = createRoomWithResources({
      name: HUB_ROOM,
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    Game.rooms[AUX_ROOM] = auxRoom;
    Game.rooms[HUB_ROOM] = hubRoom;

    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        needsPlan: false,
        lastPlanTick: 10,
      },
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [AUX_ROOM]: {
            stage: "synthesizing" as const,
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [`${AUX_ROOM}-lab-1`, `${AUX_ROOM}-lab-2`],
            productLabIds: [`${AUX_ROOM}-lab-3`],
            successfulRuns: 5,
            pendingTasks: 0,
            lastTransitionAt: 90,
          },
        },
      },
    };

    runSynthesisControl();

    expect(Memory.runtime?.hub?.needsPlan).toBe(true);
  });

  it("does NOT set needsPlan for non-hub room within debounce window", () => {
    Game.time = 55;
    const auxRoom = createRoomWithResources({
      name: AUX_ROOM,
      mineralType: RESOURCE_KEANIUM,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM_HYDRIDE]: 200,
      },
    });
    const hubRoom = createRoomWithResources({
      name: HUB_ROOM,
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    Game.rooms[AUX_ROOM] = auxRoom;
    Game.rooms[HUB_ROOM] = hubRoom;

    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        needsPlan: false,
        lastPlanTick: 50,
      },
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [AUX_ROOM]: {
            stage: "synthesizing" as const,
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [`${AUX_ROOM}-lab-1`, `${AUX_ROOM}-lab-2`],
            productLabIds: [`${AUX_ROOM}-lab-3`],
            successfulRuns: 5,
            pendingTasks: 0,
            lastTransitionAt: 30,
          },
        },
      },
    };

    runSynthesisControl();

    expect(Memory.runtime?.hub?.needsPlan).toBeFalsy();
  });

  it("does NOT set needsPlan for non-hub room not in synthesis config", () => {
    Memory.cfg!.synthesisControl!.rooms = {
      [HUB_ROOM]: { reactions: [] },
    };

    const auxRoom = createRoomWithResources({
      name: AUX_ROOM,
      mineralType: RESOURCE_KEANIUM,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM_HYDRIDE]: 200,
      },
    });
    const hubRoom = createRoomWithResources({
      name: HUB_ROOM,
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    Game.rooms[AUX_ROOM] = auxRoom;
    Game.rooms[HUB_ROOM] = hubRoom;

    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        needsPlan: false,
        lastPlanTick: 10,
      },
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [AUX_ROOM]: {
            stage: "synthesizing" as const,
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [`${AUX_ROOM}-lab-1`, `${AUX_ROOM}-lab-2`],
            productLabIds: [`${AUX_ROOM}-lab-3`],
            successfulRuns: 5,
            pendingTasks: 0,
            lastTransitionAt: 90,
          },
        },
      },
    };

    runSynthesisControl();

    expect(Memory.runtime?.hub?.needsPlan).toBeFalsy();
  });

  it("hub room signals needsPlan immediately without debounce", () => {
    Game.time = 51;
    const hubRoom = createRoomWithResources({
      name: HUB_ROOM,
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM_HYDRIDE]: 200,
      },
    });
    Game.rooms[HUB_ROOM] = hubRoom;

    Memory.cfg!.synthesisControl!.rooms![HUB_ROOM] = {
      enabled: true,
      reactions: [
        { product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 100, batchSize: 100, donorRoomNames: [] },
      ],
    };

    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        needsPlan: false,
        lastPlanTick: 50,
      },
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [HUB_ROOM]: {
            stage: "synthesizing" as const,
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [`${HUB_ROOM}-lab-1`, `${HUB_ROOM}-lab-2`],
            productLabIds: [`${HUB_ROOM}-lab-3`],
            successfulRuns: 5,
            pendingTasks: 0,
            lastTransitionAt: 30,
          },
        },
      },
    };

    runSynthesisControl();

    expect(Memory.runtime?.hub?.needsPlan).toBe(true);
  });
});
