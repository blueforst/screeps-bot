jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set<number>()),
}));

jest.mock("@/runtime/resourceControl", () => ({
  collectResourceControlSnapshots: jest.fn(() => []),
}));

import {
  clearCarrierTaskBoardForTest,
  claimCarrierTaskStepAmount,
  listCarrierTasksByRoom,
  peekCarrierTaskBoard,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import {
  assignWorkerTask,
  clearWorkerTaskBoardForTest,
  getWorkerTasksByRoom,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import carrierLogisticsAdapter from "@/runtime/taskSystem/adapters/carrierLogistics";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";
import { getMarketProtectionEntryKey } from "@/runtime/marketSaleProtection";
import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import type { WorkerTask } from "@/types/system";

interface MutableWorkerBindingState {
  taskId?: string;
  dispatchBindings?: {
    worker?: {
      system: "worker-work";
      namespace: "workerTaskPool";
      scope: { kind: "room"; roomName: string };
      localId: string;
    };
  };
}

function workerTask(
  roomName: string,
  assignedCreeps: string[],
  targetId = `target:${roomName}`,
): WorkerTask {
  return {
    id: "shared-local-id",
    type: "build",
    targetId,
    roomName,
    priority: 300,
    assignedCreeps,
    maxAssignees: 2,
    status: "active",
    updatedAt: Game.time,
  };
}

function carrierDraft(amount: number): CarrierTaskDraft {
  return {
    id: "shared-local-id",
    type: "terminal_feed",
    priority: 100,
    steps: [{
      id: "shared-step-id",
      resource: RESOURCE_ENERGY,
      fromKind: "storage",
      toKind: "terminal",
      fromId: "storage-id",
      toId: "terminal-id",
      amount,
    }],
  };
}

function room(name: string): Room {
  return { name } as Room;
}

function store(amount: number): StoreDefinition {
  return {
    [RESOURCE_ENERGY]: amount,
    getUsedCapacity(resource?: ResourceConstant): number {
      return resource === undefined || resource === RESOURCE_ENERGY ? amount : 0;
    },
    getFreeCapacity(): number {
      return 300_000;
    },
    getCapacity(): number {
      return 300_000;
    },
  } as unknown as StoreDefinition;
}

function worker(name: string, roomName: string): Creep {
  return {
    name,
    room: room(roomName),
    pos: {
      roomName,
      getRangeTo: jest.fn(() => 1),
    } as unknown as RoomPosition,
    memory: { role: "worker" } as CreepMemory,
  } as Creep;
}

describe("local dispatch full-ref target behavior", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearWorkerTaskBoardForTest();
    Game.time = 1_000;
    Game.creeps = {};
    Game.rooms = {};
    (Game as unknown as { market: Partial<Market> }).market = { orders: {} };
    Memory.cfg = {
      resourceControl: {
        capacityBalancing: {
          automaticTaskNoProgressTtl: 5_000,
        },
      },
    };
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    Memory.data = { resourceControl: { tasks: {} } };
  });

  test("Worker release touches only the bound room when local ids collide", () => {
    const creep = worker("Worker1", "W2N2");
    Game.creeps[creep.name] = creep;
    getWorkerTasksByRoom("W1N1")["shared-local-id"] = workerTask(
      "W1N1",
      [creep.name],
    );
    getWorkerTasksByRoom("W2N2")["shared-local-id"] = workerTask(
      "W2N2",
      [creep.name],
    );

    const state = ensureCreepAssignmentState(creep.name) as MutableWorkerBindingState;
    state.taskId = "shared-local-id";
    state.dispatchBindings = {
      worker: {
        system: "worker-work",
        namespace: "workerTaskPool",
        scope: { kind: "room", roomName: "W2N2" },
        localId: "shared-local-id",
      },
    };

    releaseWorkerTask(creep);

    expect(getWorkerTasksByRoom("W1N1")["shared-local-id"].assignedCreeps)
      .toEqual([creep.name]);
    expect(getWorkerTasksByRoom("W2N2")["shared-local-id"].assignedCreeps)
      .toEqual([]);
    expect(state.dispatchBindings?.worker).toBeUndefined();
    expect(state.taskId).toBeUndefined();
  });

  test("Worker room drift releases the old inverse before selecting in the current room", () => {
    const creep = worker("Worker1", "W2N2");
    Game.creeps[creep.name] = creep;
    Game.rooms.W2N2 = creep.room;
    const oldTask = workerTask("W1N1", [creep.name], "old-target");
    const currentTask = workerTask("W2N2", [], "current-target");
    getWorkerTasksByRoom("W1N1")[oldTask.id] = oldTask;
    getWorkerTasksByRoom("W2N2")[currentTask.id] = currentTask;
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => id === "current-target"
        ? ({ id, pos: { roomName: "W2N2", x: 20, y: 20 } } as unknown as RoomObject)
        : null,
    ) as unknown as Game["getObjectById"];

    const state = ensureCreepAssignmentState(creep.name) as MutableWorkerBindingState;
    state.taskId = oldTask.id;
    state.dispatchBindings = {
      worker: {
        system: "worker-work",
        namespace: "workerTaskPool",
        scope: { kind: "room", roomName: "W1N1" },
        localId: oldTask.id,
      },
    };

    expect(assignWorkerTask(creep)).toBe(currentTask);
    expect(oldTask.assignedCreeps).toEqual([]);
    expect(currentTask.assignedCreeps).toEqual([creep.name]);
    expect(state.dispatchBindings?.worker).toEqual({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: "W2N2" },
      localId: currentTask.id,
    });
  });

  test("Carrier board and amount budget isolate equal local and step ids by producer", () => {
    replaceCarrierTasksForProducerRoom(
      "producer:a",
      "W1N1",
      [carrierDraft(500)],
    );
    replaceCarrierTasksForProducerRoom(
      "producer:b",
      "W1N1",
      [carrierDraft(500)],
    );

    const tasks = listCarrierTasksByRoom("W1N1");
    expect(tasks.map((task) => task.producer).sort()).toEqual([
      "producer:a",
      "producer:b",
    ]);

    const first = tasks.find((task) => task.producer === "producer:a");
    const second = tasks.find((task) => task.producer === "producer:b");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    expect(claimCarrierTaskStepAmount(
      first,
      first.steps[0],
      "CarrierA",
      500,
    )?.amount).toBe(500);
    expect(claimCarrierTaskStepAmount(
      second,
      second.steps[0],
      "CarrierB",
      500,
    )?.amount).toBe(500);
  });

  test("Carrier projection emits both producer refs without collision-risk diagnostics", () => {
    replaceCarrierTasksForProducerRoom(
      "producer:a",
      "W1N1",
      [carrierDraft(500)],
    );
    replaceCarrierTasksForProducerRoom(
      "producer:b",
      "W1N1",
      [carrierDraft(500)],
    );

    const result = carrierLogisticsAdapter.snapshot({
      board: peekCarrierTaskBoard(),
    });

    expect(result.entries.map((entry) => entry.ref.namespace).sort()).toEqual([
      "producer:a",
      "producer:b",
    ]);
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "carrier-task-id-collision-risk",
    }));
  });

  test("Carrier downstream protection keeps equal task and step ids producer-scoped", () => {
    Game.rooms.W1N1 = {
      name: "W1N1",
      controller: { my: true, level: 8 },
      storage: {
        id: "storage-id",
        structureType: STRUCTURE_STORAGE,
        store: store(5_000),
      },
      terminal: {
        id: "terminal-id",
        structureType: STRUCTURE_TERMINAL,
        cooldown: 0,
        store: store(5_000),
      },
      find: jest.fn(() => []),
    } as unknown as Room;
    replaceCarrierTasksForProducerRoom(
      "producer:a:with:separator",
      "W1N1",
      [carrierDraft(500)],
    );
    replaceCarrierTasksForProducerRoom(
      "producer:b->with:separator",
      "W1N1",
      [carrierDraft(500)],
    );

    const config = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      configRevision: "local-dispatch-target",
      sellResources: [RESOURCE_ENERGY],
      hardFloor: { [RESOURCE_ENERGY]: 0 },
      forecastBuffer: { [RESOURCE_ENERGY]: 0 },
      minDealAmount: 100,
      makerBatchAmount: 100,
      creditReserve: 0,
    });
    const ledger = collectLiveMarketSaleProtectionLedger(
      config,
      undefined,
      { candidates: [{ roomName: "W1N1", resource: RESOURCE_ENERGY }] },
    );
    const entry = ledger.entries[
      getMarketProtectionEntryKey("W1N1", RESOURCE_ENERGY)
    ];
    const carrierContributions = entry.sourceContributions.filter(
      (contribution) => contribution.bucket === "carrierOrInFlight",
    );

    expect(carrierContributions).toHaveLength(2);
    expect(new Set(
      carrierContributions.map((contribution) => contribution.stableKey),
    ).size).toBe(2);
    expect(carrierContributions.map((contribution) => contribution.amount).sort())
      .toEqual([500, 500]);
  });
});
