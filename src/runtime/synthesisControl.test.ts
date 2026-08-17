import { runSynthesisControl, pauseSynthesisForBoost, resumeSynthesisAfterBoost } from "@/runtime/synthesisControl";
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
        getFreeCapacity: () => 100000,
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

describe("synthesis boost pause/resume contract", () => {
  const ROOM = "W1N1";

  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 100;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          [ROOM]: {
            enabled: true,
            reactions: [
              { product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5000, batchSize: 500 },
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

  function setupActiveRoom(): void {
    const room = createRoomWithResources({
      name: ROOM,
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    Game.rooms[ROOM] = room;

    Memory.runtime = {
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [ROOM]: {
            stage: "synthesizing",
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            reagentA: RESOURCE_UTRIUM,
            reagentB: RESOURCE_HYDROGEN,
            targetAmount: 5000,
            batchSize: 500,
            reagentLabIds: [`${ROOM}-lab-1`, `${ROOM}-lab-2`],
            productLabIds: [`${ROOM}-lab-3`],
            successfulRuns: 10,
            pendingTasks: 0,
            lastTransitionAt: 90,
            nextReactionAt: 150,
          },
        },
      },
    };
  }

  it("tracks concurrent boost tasks and resumes only after the last release", () => {
    setupActiveRoom();
    const first = pauseSynthesisForBoost(ROOM, "pb-task-1");
    expect(first).toBe(true);

    const second = pauseSynthesisForBoost(ROOM, "pb-task-2");
    expect(second).toBe(true);

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause!.taskId).toBe("pb-task-1");
    expect(roomState.boostPause!.taskIds).toEqual(["pb-task-1", "pb-task-2"]);
    expect(roomState.nextReactionAt).toBeUndefined();

    resumeSynthesisAfterBoost(ROOM, "pb-task-1");
    expect(roomState.boostPause!.taskId).toBe("pb-task-2");
    expect(roomState.activeProduct).toBeUndefined();

    resumeSynthesisAfterBoost(ROOM, "pb-task-2");
    expect(roomState.boostPause).toBeUndefined();
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(roomState.nextReactionAt).toBeUndefined();
  });
});
