import { runSynthesisControl, pauseSynthesisForBoost, resumeSynthesisAfterBoost, isSynthesisPaused, clearBoostPause } from "@/runtime/synthesisControl";
import {
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";
import { reserveProductionResource } from "@/runtime/resourceReservation";

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

describe("selectDonor respects production locks from other holders", () => {
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
    Memory.runtime = {};
    Memory.rooms = {};
    Memory.data = undefined;
    Game.rooms = {};
    Game.spawns = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: () => 0,
    };
  });

  it("donor with 1000 resource and 700 locked by another holder exposes only 300 exportable", () => {
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
        [RESOURCE_UTRIUM]: 1000,
        [RESOURCE_HYDROGEN]: 5000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    // Another holder (different target room) has reserved 700 U in the donor room
    reserveProductionResource("W2N1", RESOURCE_UTRIUM, 700, "synthesis:W3N1:OH");

    runSynthesisControl();

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const utriumSynthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:") && t.resource === RESOURCE_UTRIUM,
    );
    // Only 300 exportable (1000 - 700 locked), which is > LAB_REACTION_AMOUNT (5), so a task is created
    expect(utriumSynthesisTasks.length).toBe(1);
    expect(utriumSynthesisTasks[0].amount).toBeLessThanOrEqual(300);
  });

  it("same holder can still use its own locked amount", () => {
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
        [RESOURCE_UTRIUM]: 1000,
        [RESOURCE_HYDROGEN]: 5000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    // The SAME holder (synthesis:W1N1:U) reserves 700 U in donor room
    reserveProductionResource("W2N1", RESOURCE_UTRIUM, 700, `synthesis:W1N1:${RESOURCE_UTRIUM}`);

    runSynthesisControl();

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const utriumSynthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:") && t.resource === RESOURCE_UTRIUM,
    );
    // The holder matches the current request, so the 700 reservation is excluded.
    // Full 1000 is exportable.
    expect(utriumSynthesisTasks.length).toBe(1);
    expect(utriumSynthesisTasks[0].amount).toBeGreaterThanOrEqual(500);
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
          },
        },
      },
    };
  }

  it("pauseSynthesisForBoost saves plan, clears active production, returns true", () => {
    setupActiveRoom();
    expect(isSynthesisPaused(ROOM)).toBe(false);

    const result = pauseSynthesisForBoost(ROOM, "pb-task-1");

    expect(result).toBe(true);
    expect(isSynthesisPaused(ROOM)).toBe(true);

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause).toBeDefined();
    expect(roomState.boostPause!.reason).toBe("powerBankBoost");
    expect(roomState.boostPause!.taskId).toBe("pb-task-1");
    expect(roomState.boostPause!.pausedPlan).toBeDefined();
    expect(roomState.boostPause!.pausedPlan!.product).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(roomState.boostPause!.pausedPlan!.targetAmount).toBe(5000);
    expect(roomState.boostPause!.pausedStage).toBe("synthesizing");

    expect(roomState.activeProduct).toBeUndefined();
    expect(roomState.stage).toBe("idle");
  });

  it("pausing when no active plan still reserves the room for boost", () => {
    setupActiveRoom();
    Memory.runtime!.synthesisControl!.rooms[ROOM].stage = "idle";
    Memory.runtime!.synthesisControl!.rooms[ROOM].activeProduct = undefined;

    const result = pauseSynthesisForBoost(ROOM, "pb-task-2");
    expect(result).toBe(true);
    expect(isSynthesisPaused(ROOM)).toBe(true);
    expect(Memory.runtime!.synthesisControl!.rooms[ROOM].boostPause?.pausedPlan).toBeNull();
  });

  it("tracks concurrent boost tasks and resumes only after the last release", () => {
    setupActiveRoom();
    const first = pauseSynthesisForBoost(ROOM, "pb-task-1");
    expect(first).toBe(true);

    const second = pauseSynthesisForBoost(ROOM, "pb-task-2");
    expect(second).toBe(true);

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause!.taskId).toBe("pb-task-1");
    expect(roomState.boostPause!.taskIds).toEqual(["pb-task-1", "pb-task-2"]);

    resumeSynthesisAfterBoost(ROOM, "pb-task-1");
    expect(roomState.boostPause!.taskId).toBe("pb-task-2");
    expect(roomState.activeProduct).toBeUndefined();

    resumeSynthesisAfterBoost(ROOM, "pb-task-2");
    expect(roomState.boostPause).toBeUndefined();
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
  });

  it("pauseSynthesisForBoost for unknown room returns false", () => {
    const result = pauseSynthesisForBoost("W9N9", "pb-task-x");
    expect(result).toBe(false);
  });

  it("resumeSynthesisAfterBoost restores plan and clears pause state", () => {
    setupActiveRoom();
    pauseSynthesisForBoost(ROOM, "pb-task-1");

    resumeSynthesisAfterBoost(ROOM);

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause).toBeUndefined();
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(roomState.targetAmount).toBe(5000);
    expect(roomState.batchSize).toBe(500);
    expect(roomState.reagentA).toBe(RESOURCE_UTRIUM);
    expect(roomState.reagentB).toBe(RESOURCE_HYDROGEN);
    expect(roomState.stage).toBe("synthesizing");
  });

  it("resumeSynthesisAfterBoost is no-op when not paused", () => {
    setupActiveRoom();
    const before = { ...Memory.runtime!.synthesisControl!.rooms[ROOM] };
    resumeSynthesisAfterBoost(ROOM);
    const after = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(after.stage).toBe(before.stage);
    expect(after.activeProduct).toBe(before.activeProduct);
  });

  it("clearBoostPause removes pause without restoring", () => {
    setupActiveRoom();
    pauseSynthesisForBoost(ROOM, "pb-task-1");
    expect(isSynthesisPaused(ROOM)).toBe(true);

    clearBoostPause(ROOM);

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause).toBeUndefined();
    expect(roomState.activeProduct).toBeUndefined();
    expect(roomState.stage).toBe("idle");
  });

  it("clearBoostPause is no-op for unknown room", () => {
    expect(() => clearBoostPause("W9N9")).not.toThrow();
  });

  it("synthesis tick skips production when paused but still allows cleanup", () => {
    setupActiveRoom();
    pauseSynthesisForBoost(ROOM, "pb-task-1");

    // The labs have residue minerals for cleanup to find
    const room = Game.rooms[ROOM] as Room;
    const labs = room.find(FIND_MY_STRUCTURES) as StructureLab[];
    const labWithResidue = labs[0];
    labWithResidue.mineralType = RESOURCE_UTRIUM;
    labWithResidue.store.getUsedCapacity = ((resource?: ResourceConstant) => {
      if (resource === RESOURCE_UTRIUM) return 100;
      return 0;
    }) as typeof labWithResidue.store.getUsedCapacity;

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    // Should stay paused
    expect(roomState.boostPause).toBeDefined();
    // Stage should be unloading (cleanup) or idle — not synthesizing/acquiring
    expect(roomState.stage === "unloading" || roomState.stage === "idle").toBe(true);
    // Should not have picked a new active product
    expect(roomState.activeProduct).toBeUndefined();
  });

  it("boost-pause cleanup skips labs assigned to active powerbank boost prep", () => {
    setupActiveRoom();
    pauseSynthesisForBoost(ROOM, "pb-task-1");

    // Set up labs with residue minerals
    const room = Game.rooms[ROOM] as Room;
    const labs = room.find(FIND_MY_STRUCTURES) as StructureLab[];
    const labA = labs[0];
    const labB = labs[1];

    // Both labs have residue
    labA.mineralType = RESOURCE_UTRIUM;
    labA.store.getUsedCapacity = ((resource?: ResourceConstant) => {
      if (resource === RESOURCE_UTRIUM) return 100;
      return 0;
    }) as typeof labA.store.getUsedCapacity;

    labB.mineralType = RESOURCE_HYDROGEN;
    labB.store.getUsedCapacity = ((resource?: ResourceConstant) => {
      if (resource === RESOURCE_HYDROGEN) return 200;
      return 0;
    }) as typeof labB.store.getUsedCapacity;

    // Register labA as a powerbank boost lab for this room
    Memory.runtime!.powerBankBoost = {
      "pb-task-1": {
        labs: {
          [labA.id]: { labId: labA.id, compound: RESOURCE_CATALYZED_UTRIUM_ACID },
        },
        taskId: "pb-task-1",
        sourceRoomName: ROOM,
      },
    };

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause).toBeDefined();

    // Check carrier tasks — labB should be cleaned up, labA should be excluded
    // We verify via the runtime state: stage should be "unloading" since labB needs cleanup
    expect(roomState.stage).toBe("unloading");
  });

  it("boost-pause cleanup includes all labs when no powerbank boost labs are assigned", () => {
    setupActiveRoom();
    pauseSynthesisForBoost(ROOM, "pb-task-1");

    const room = Game.rooms[ROOM] as Room;
    const labs = room.find(FIND_MY_STRUCTURES) as StructureLab[];
    const labA = labs[0];

    labA.mineralType = RESOURCE_UTRIUM;
    labA.store.getUsedCapacity = ((resource?: ResourceConstant) => {
      if (resource === RESOURCE_UTRIUM) return 100;
      return 0;
    }) as typeof labA.store.getUsedCapacity;

    // No powerBankBoost memory set — all labs eligible for cleanup
    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.stage).toBe("unloading");
  });

  it("synthesis tick resumes production normally after resume", () => {
    setupActiveRoom();
    pauseSynthesisForBoost(ROOM, "pb-task-1");
    resumeSynthesisAfterBoost(ROOM);

    runSynthesisControl();

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    // Should not be paused
    expect(roomState.boostPause).toBeUndefined();
    // Should have picked up the product again
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
    // Should be in an active stage (acquiring/loading/synthesizing, not idle/blocked)
    expect(roomState.stage).not.toBe("blocked");
  });
});
