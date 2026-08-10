import {
  claimCarrierTaskStepAmount,
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  listCarrierTasksByRoom,
  peekCarrierTaskBoard,
  peekCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
  pruneCarrierTasksForProducer,
  cleanupCarrierTaskBoard,
} from "@/runtime/carrierTaskBoard";
import type { CarrierTask, CarrierTaskDraft, CarrierTaskStep } from "@/runtime/carrierTaskBoard";
import { createCarrierTaskStepId, createSingleStepDraft, createCarrierTaskStep, resolveTerminalStorageTarget, terminalStorageKind } from "@/runtime/carrierTaskHelpers";

type CarrierTaskRuntimeGlobal = typeof global & {
  __carrierTaskBoard?: Record<string, Record<string, CarrierTask>>;
  __carrierTaskClaims?: unknown;
};

const carrierTaskRuntimeGlobal = global as CarrierTaskRuntimeGlobal;

function globalPropertyNames(): string[] {
  return Object.getOwnPropertyNames(global).sort();
}

function makeStep(overrides: Partial<CarrierTaskStep> = {}): CarrierTaskStep {
  return {
    id: "step1",
    resource: "U" as ResourceConstant,
    fromKind: "terminal",
    toKind: "lab",
    fromId: "term123",
    toId: "lab456",
    amount: 500,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<CarrierTaskDraft> & { id: string }): CarrierTaskDraft {
  return {
    type: "lab_supply",
    priority: 100,
    steps: [makeStep()],
    ...overrides,
  };
}

describe("carrierTaskBoard", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 1000;
    Game.creeps = {};
  });

  it("cleanup removes tasks in rooms not owned and stale tasks", () => {
    const d1 = makeDraft({ id: "keep:fresh" });
    Game.time = 1000;
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [d1]);

    const d2 = makeDraft({ id: "keep:unowned" });
    replaceCarrierTasksForProducerRoom("prodA", "W4N4", [d2]);

    const d3 = makeDraft({ id: "stale:owned" });
    Game.time = 800;
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [d3]);
    Game.time = 1000;

    const removed = cleanupCarrierTaskBoard(new Set(["W1N1"]), 100);
    expect(removed).toBe(2);
    expect(getCarrierTasksByRoom("W1N1")["keep:fresh"]).toBeDefined();
    expect(getCarrierTasksByRoom("W1N1")["stale:owned"]).toBeUndefined();
    // W4N4 room entry should be cleaned up entirely
    expect(getCarrierTasksByRoom("W4N4")["keep:unowned"]).toBeUndefined();
  });

  it("peek selectors stay side-effect free after global reset", () => {
    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskBoard"))
      .toBe(false);
    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskClaims"))
      .toBe(false);
    const propertiesBefore = globalPropertyNames();

    expect(peekCarrierTaskBoard()).toEqual({});
    expect(peekCarrierTasksByRoom("W9N9")).toEqual({});

    expect(globalPropertyNames()).toEqual(propertiesBefore);
    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskBoard"))
      .toBe(false);
    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskClaims"))
      .toBe(false);
  });

  it("peeks an absent room without creating it in an existing board", () => {
    replaceCarrierTasksForProducerRoom(
      "prodA",
      "W1N1",
      [makeDraft({ id: "prodA:task" })],
    );
    const boardBefore = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const propertiesBefore = globalPropertyNames();

    expect(peekCarrierTasksByRoom("W9N9")).toEqual({});

    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(boardBefore);
    expect(boardBefore?.W9N9).toBeUndefined();
    expect(globalPropertyNames()).toEqual(propertiesBefore);
  });

  it("preserves room, task, producer, step, and timestamp identity in peek snapshots", () => {
    const firstDraft = makeDraft({
      id: "prodA:task",
      dispatchClass: "capacity_relief",
      steps: [makeStep({ id: "prodA:step", amount: 321 })],
    });
    const secondDraft = makeDraft({
      id: "prodB:task",
      type: "terminal_offload",
      priority: 90,
      steps: [makeStep({
        id: "prodB:step",
        resource: RESOURCE_ENERGY,
        fromKind: "terminal",
        toKind: "storage",
        fromId: "terminal-b",
        toId: "storage-b",
        amount: 654,
      })],
    });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [firstDraft]);
    Game.time = 1001;
    replaceCarrierTasksForProducerRoom("prodB", "W2N2", [secondDraft]);

    expect(peekCarrierTaskBoard()).toEqual({
      W1N1: {
        "prodA:task": {
          id: "prodA:task",
          producer: "prodA",
          roomName: "W1N1",
          type: "lab_supply",
          priority: 100,
          dispatchClass: "capacity_relief",
          steps: [{
            id: "prodA:step",
            resource: "U",
            fromKind: "terminal",
            toKind: "lab",
            fromId: "term123",
            toId: "lab456",
            amount: 321,
          }],
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
      W2N2: {
        "prodB:task": {
          id: "prodB:task",
          producer: "prodB",
          roomName: "W2N2",
          type: "terminal_offload",
          priority: 90,
          steps: [{
            id: "prodB:step",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: "terminal-b",
            toId: "storage-b",
            amount: 654,
          }],
          createdAt: 1001,
          updatedAt: 1001,
        },
      },
    });
    expect(peekCarrierTasksByRoom("W2N2")).toEqual(
      peekCarrierTaskBoard().W2N2,
    );
  });

  it("deeply isolates room and full-board snapshots from domain records", () => {
    const taskId = "prodA:isolated";
    replaceCarrierTasksForProducerRoom(
      "prodA",
      "W1N1",
      [makeDraft({
        id: taskId,
        steps: [
          makeStep({ id: "step-a", amount: 300 }),
          makeStep({ id: "step-b", fromId: "term789", amount: 200 }),
        ],
      })],
    );
    const sourceStore = getCarrierTasksByRoom("W1N1");
    const sourceTask = sourceStore[taskId];
    const roomSnapshot = peekCarrierTasksByRoom("W1N1");
    const boardSnapshot = peekCarrierTaskBoard();

    expect(roomSnapshot[taskId]).not.toBe(sourceTask);
    expect(roomSnapshot[taskId].steps).not.toBe(sourceTask.steps);
    expect(roomSnapshot[taskId].steps[0]).not.toBe(sourceTask.steps[0]);
    expect(boardSnapshot.W1N1[taskId]).not.toBe(sourceTask);
    expect(boardSnapshot.W1N1[taskId]).not.toBe(roomSnapshot[taskId]);
    expect(boardSnapshot.W1N1[taskId].steps[0])
      .not.toBe(roomSnapshot[taskId].steps[0]);

    const mutableRoomSnapshot = roomSnapshot as unknown as Record<
      string,
      CarrierTask
    >;
    mutableRoomSnapshot[taskId].producer = "mutated-producer";
    mutableRoomSnapshot[taskId].steps[0].amount = 1;
    mutableRoomSnapshot[taskId].steps.push(makeStep({ id: "injected" }));
    delete mutableRoomSnapshot[taskId];

    const mutableBoardSnapshot = boardSnapshot as unknown as Record<
      string,
      Record<string, CarrierTask>
    >;
    mutableBoardSnapshot.W1N1[taskId].roomName = "W9N9";
    mutableBoardSnapshot.W1N1[taskId].steps[1].fromId = "mutated-source";
    delete mutableBoardSnapshot.W1N1;

    expect(sourceStore[taskId]).toBe(sourceTask);
    expect(sourceTask).toMatchObject({
      producer: "prodA",
      roomName: "W1N1",
      steps: [
        expect.objectContaining({ id: "step-a", amount: 300 }),
        expect.objectContaining({ id: "step-b", fromId: "term789" }),
      ],
    });
    expect(sourceTask.steps).toHaveLength(2);
    expect(peekCarrierTasksByRoom("W1N1")[taskId]).toEqual(sourceTask);
  });

  it("isolates malformed runtime task shapes without blocking valid siblings", () => {
    const validTaskId = "prodA:valid-sibling";
    replaceCarrierTasksForProducerRoom(
      "prodA",
      "W1N1",
      [makeDraft({
        id: validTaskId,
        steps: [makeStep({ id: "valid-step", amount: 500 })],
      })],
    );
    const boardBefore = carrierTaskRuntimeGlobal.__carrierTaskBoard!;
    const roomBefore = boardBefore.W1N1;
    const validTaskBefore = roomBefore[validTaskId];
    const firstClaim = claimCarrierTaskStepAmount(
      validTaskBefore,
      validTaskBefore.steps[0],
      "carrier-a",
      300,
    );
    expect(firstClaim?.amount).toBe(300);

    const malformedNonArraySteps = {
      ...validTaskBefore,
      id: "prodB:non-array-steps",
      producer: "prodB",
      steps: {
        legacy: true,
        nested: { amount: 125 },
      },
    };
    const malformedStep = {
      ...validTaskBefore,
      id: "prodC:malformed-step",
      producer: "prodC",
      steps: [
        null,
        7,
        { id: "partial", nested: { marker: "source" } },
      ],
    };
    const rawRoom = roomBefore as unknown as Record<string, unknown>;
    rawRoom["prodB:non-object"] = 42;
    rawRoom[malformedNonArraySteps.id] = malformedNonArraySteps;
    rawRoom[malformedStep.id] = malformedStep;

    const claimsBefore = carrierTaskRuntimeGlobal.__carrierTaskClaims;
    const propertiesBefore = globalPropertyNames();
    const roomSnapshot = peekCarrierTasksByRoom("W1N1");
    const boardSnapshot = peekCarrierTaskBoard();
    const rawRoomSnapshot = roomSnapshot as unknown as Record<string, any>;
    const rawBoardRoomSnapshot = boardSnapshot.W1N1 as unknown as Record<string, any>;

    expect(rawRoomSnapshot["prodB:non-object"]).toBe(42);
    expect(rawRoomSnapshot[malformedNonArraySteps.id]).toEqual(
      malformedNonArraySteps,
    );
    expect(rawRoomSnapshot[malformedStep.id]).toEqual(malformedStep);
    expect(rawBoardRoomSnapshot["prodB:non-object"]).toBe(42);
    expect(rawBoardRoomSnapshot[malformedNonArraySteps.id]).toEqual(
      malformedNonArraySteps,
    );
    expect(rawBoardRoomSnapshot[malformedStep.id]).toEqual(malformedStep);
    expect(rawRoomSnapshot[validTaskId]).toEqual(validTaskBefore);
    expect(rawRoomSnapshot[validTaskId]).not.toBe(validTaskBefore);
    expect(rawRoomSnapshot[malformedNonArraySteps.id])
      .not.toBe(malformedNonArraySteps);
    expect(rawRoomSnapshot[malformedNonArraySteps.id].steps)
      .not.toBe(malformedNonArraySteps.steps);
    expect(rawRoomSnapshot[malformedNonArraySteps.id].steps.nested)
      .not.toBe(malformedNonArraySteps.steps.nested);
    expect(rawRoomSnapshot[malformedStep.id].steps)
      .not.toBe(malformedStep.steps);
    expect(rawRoomSnapshot[malformedStep.id].steps[2])
      .not.toBe(malformedStep.steps[2]);
    expect(rawBoardRoomSnapshot[malformedStep.id])
      .not.toBe(rawRoomSnapshot[malformedStep.id]);

    rawRoomSnapshot[malformedNonArraySteps.id].steps.nested.amount = 1;
    rawRoomSnapshot[malformedStep.id].steps[2].nested.marker = "mutated";
    rawRoomSnapshot[validTaskId].steps[0].amount = 1;
    rawBoardRoomSnapshot[malformedStep.id].steps.push("injected");

    expect(malformedNonArraySteps.steps.nested.amount).toBe(125);
    expect(malformedStep.steps).toHaveLength(3);
    expect((malformedStep.steps[2] as { nested: { marker: string } }).nested.marker)
      .toBe("source");
    expect(validTaskBefore.steps[0].amount).toBe(500);
    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(boardBefore);
    expect(boardBefore.W1N1).toBe(roomBefore);
    expect(roomBefore[validTaskId]).toBe(validTaskBefore);
    expect(rawRoom[malformedNonArraySteps.id]).toBe(malformedNonArraySteps);
    expect(rawRoom[malformedStep.id]).toBe(malformedStep);
    expect(carrierTaskRuntimeGlobal.__carrierTaskClaims).toBe(claimsBefore);
    expect(globalPropertyNames()).toEqual(propertiesBefore);

    const secondClaim = claimCarrierTaskStepAmount(
      validTaskBefore,
      validTaskBefore.steps[0],
      "carrier-b",
      500,
    );
    expect(secondClaim?.amount).toBe(200);
    firstClaim?.release();
    secondClaim?.release();
  });

  it("does not invoke accessors or wash non-plain malformed tasks into plain records", () => {
    const validTaskId = "valid-sibling";
    replaceCarrierTasksForProducerRoom(
      "producer",
      "W1N1",
      [makeDraft({ id: validTaskId })],
    );
    const boardBefore = carrierTaskRuntimeGlobal.__carrierTaskBoard!;
    const roomBefore = boardBefore.W1N1;
    const rawRoom = roomBefore as unknown as Record<string, unknown>;

    let getterReads = 0;
    const accessorTask = {
      ...roomBefore[validTaskId],
      id: "accessor-task",
    } as Record<string, unknown>;
    Object.defineProperty(accessorTask, "producer", {
      enumerable: true,
      configurable: true,
      get(): string {
        getterReads += 1;
        throw new Error("selector must not evaluate task accessors");
      },
    });
    const customTask = Object.assign(
      Object.create({ sourcePrototype: true }) as Record<string, unknown>,
      {
        ...roomBefore[validTaskId],
        id: "custom-task",
        nested: { marker: "source" },
      },
    );
    const mapTask = new Map<string, unknown>([["producer", "map-producer"]]);
    const functionTask = Object.assign(
      function malformedCarrierTask(): undefined {
        return undefined;
      },
      {
        id: "function-task",
        producer: "function-producer",
      },
    );
    rawRoom["accessor-task"] = accessorTask;
    rawRoom["custom-task"] = customTask;
    rawRoom["map-task"] = mapTask;
    rawRoom["function-task"] = functionTask;

    const roomSnapshot = peekCarrierTasksByRoom("W1N1") as unknown as Record<
      string,
      any
    >;
    const boardRoomSnapshot = peekCarrierTaskBoard().W1N1 as unknown as Record<
      string,
      any
    >;

    expect(getterReads).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(
      roomSnapshot["accessor-task"],
      "producer",
    )).toBe(true);
    expect(roomSnapshot["accessor-task"].producer).toBeUndefined();
    for (const taskId of ["custom-task", "map-task"]) {
      const prototype = Object.getPrototypeOf(roomSnapshot[taskId]);
      expect(prototype).not.toBe(null);
      expect(prototype).not.toBe(Object.prototype);
      expect(Object.isFrozen(prototype)).toBe(true);
      expect(boardRoomSnapshot[taskId]).not.toBe(roomSnapshot[taskId]);
    }
    expect(typeof roomSnapshot["function-task"]).toBe("function");
    expect(roomSnapshot["function-task"]).not.toBe(functionTask);
    expect(boardRoomSnapshot["function-task"]).not.toBe(
      roomSnapshot["function-task"],
    );
    expect(roomSnapshot["custom-task"].nested).not.toBe(customTask.nested);

    roomSnapshot["custom-task"].nested.marker = "mutated";
    expect(customTask.nested).toEqual({ marker: "source" });
    expect(getterReads).toBe(0);
    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(boardBefore);
    expect(boardBefore.W1N1).toBe(roomBefore);
    expect(rawRoom["accessor-task"]).toBe(accessorTask);
    expect(rawRoom["custom-task"]).toBe(customTask);
    expect(rawRoom["map-task"]).toBe(mapTask);
    expect(rawRoom["function-task"]).toBe(functionTask);
    expect(roomBefore[validTaskId]).toBeDefined();
  });

  it("does not release claims or replace private slot references while peeking", () => {
    const taskId = "claimed-peek-task";
    replaceCarrierTasksForProducerRoom(
      "claim-test",
      "W1N1",
      [makeDraft({ id: taskId, steps: [makeStep({ amount: 500 })] })],
    );
    const task = getCarrierTasksByRoom("W1N1")[taskId];
    const firstClaim = claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-a",
      300,
    );
    expect(firstClaim?.amount).toBe(300);
    const boardBefore = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const claimsBefore = carrierTaskRuntimeGlobal.__carrierTaskClaims;
    const propertiesBefore = globalPropertyNames();

    peekCarrierTaskBoard();
    peekCarrierTasksByRoom("W1N1");

    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(boardBefore);
    expect(carrierTaskRuntimeGlobal.__carrierTaskClaims).toBe(claimsBefore);
    expect(globalPropertyNames()).toEqual(propertiesBefore);
    const secondClaim = claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-b",
      500,
    );
    expect(secondClaim?.amount).toBe(200);
    firstClaim?.release();
    secondClaim?.release();
  });

  it("keeps legacy get/list live-reference behavior separate from peek snapshots", () => {
    replaceCarrierTasksForProducerRoom(
      "prodA",
      "W1N1",
      [makeDraft({ id: "prodA:live" })],
    );
    const liveStore = getCarrierTasksByRoom("W1N1");

    expect(getCarrierTasksByRoom("W1N1")).toBe(liveStore);
    expect(listCarrierTasksByRoom("W1N1")[0]).toBe(liveStore["prodA:live"]);
    expect(peekCarrierTasksByRoom("W1N1")["prodA:live"])
      .not.toBe(liveStore["prodA:live"]);
  });

  it("lists higher numeric priority first and preserves creation order for ties", () => {
    replaceCarrierTasksForProducerRoom(
      "older-high",
      "W1N1",
      [makeDraft({ id: "older-high", priority: 10 })],
    );
    Game.time += 1;
    replaceCarrierTasksForProducerRoom(
      "newer-high",
      "W1N1",
      [makeDraft({ id: "newer-high", priority: 10 })],
    );
    replaceCarrierTasksForProducerRoom(
      "low",
      "W1N1",
      [makeDraft({ id: "low", priority: 0 })],
    );

    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual([
      "older-high",
      "newer-high",
      "low",
    ]);
  });

  it("preserves a dispatch class on refresh and clears it when the next draft omits it", () => {
    const classifiedDraft = makeDraft({
      id: "capacity-relief-task",
      dispatchClass: "capacity_relief",
    });
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      "W1N1",
      [classifiedDraft],
    );

    expect(getCarrierTasksByRoom("W1N1")[classifiedDraft.id]).toMatchObject({
      dispatchClass: "capacity_relief",
      createdAt: 1000,
      updatedAt: 1000,
    });

    Game.time = 1001;
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      "W1N1",
      [{ ...classifiedDraft, priority: 101 }],
    );
    expect(getCarrierTasksByRoom("W1N1")[classifiedDraft.id]).toMatchObject({
      dispatchClass: "capacity_relief",
      priority: 101,
      createdAt: 1000,
      updatedAt: 1001,
    });

    Game.time = 1002;
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      "W1N1",
      [makeDraft({ id: classifiedDraft.id, priority: 102 })],
    );
    const unclassifiedTask = getCarrierTasksByRoom("W1N1")[classifiedDraft.id];
    expect(unclassifiedTask).not.toHaveProperty("dispatchClass");
    expect(unclassifiedTask).toMatchObject({
      priority: 102,
      createdAt: 1000,
      updatedAt: 1002,
    });
  });

  it("atomically caps claims by both task and step across same-tick refresh", () => {
    const draft = makeDraft({
      id: "claimed-task",
      steps: [
        makeStep({ id: "storage-step", amount: 600 }),
        makeStep({ id: "terminal-step", fromId: "term789", amount: 400 }),
      ],
    });
    replaceCarrierTasksForProducerRoom("claim-test", "W1N1", [draft]);
    let task = getCarrierTasksByRoom("W1N1")[draft.id];

    const first = claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-a",
      800,
    );
    expect(first?.amount).toBe(600);
    first?.commit();
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-b",
      800,
    )).toBeNull();

    const second = claimCarrierTaskStepAmount(
      task,
      task.steps[1],
      "carrier-c",
      800,
    );
    expect(second?.amount).toBe(400);
    second?.commit();

    replaceCarrierTasksForProducerRoom("claim-test", "W1N1", [draft]);
    task = getCarrierTasksByRoom("W1N1")[draft.id];
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-d",
      800,
    )).toBeNull();

    Game.time += 1;
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-d",
      800,
    )?.amount).toBe(600);
  });

  it("releases active claims on failure and task cleanup", () => {
    const draft = makeDraft({ id: "released-task", steps: [makeStep({ amount: 1_000 })] });
    replaceCarrierTasksForProducerRoom("claim-test", "W1N1", [draft]);
    let task = getCarrierTasksByRoom("W1N1")[draft.id];

    const failed = claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "failed-carrier",
      1_000,
    );
    expect(failed?.amount).toBe(1_000);
    failed?.release();
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "retry-carrier",
      1_000,
    )?.amount).toBe(1_000);

    replaceCarrierTasksForProducerRoom("claim-test", "W1N1", []);
    replaceCarrierTasksForProducerRoom("claim-test", "W1N1", [draft]);
    task = getCarrierTasksByRoom("W1N1")[draft.id];
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "after-cleanup",
      1_000,
    )?.amount).toBe(1_000);
  });

  it("reclaims a committed slice when its live claimant disappears", () => {
    const draft = makeDraft({ id: "dead-claimant-task", steps: [makeStep({ amount: 1_000 })] });
    replaceCarrierTasksForProducerRoom("claim-test", "W1N1", [draft]);
    const task = getCarrierTasksByRoom("W1N1")[draft.id];
    Game.creeps["live-carrier"] = { name: "live-carrier" } as Creep;
    const accepted = claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "live-carrier",
      1_000,
    );
    accepted?.commit();
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "blocked-carrier",
      1_000,
    )).toBeNull();

    delete Game.creeps["live-carrier"];
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "replacement-carrier",
      1_000,
    )?.amount).toBe(1_000);
  });
});

describe("carrierTaskHelpers", () => {

  it("createSingleStepDraft produces a draft accepted by the board", () => {
    clearCarrierTaskBoardForTest();
    Game.time = 1000;
    const draft = createSingleStepDraft({
      taskId: "factoryControl:factory_supply:W1N1:battery",
      type: "factory_supply",
      priority: 110,
      producer: "factoryControl",
      roomName: "W1N1",
      resource: RESOURCE_BATTERY as ResourceConstant,
      fromKind: "storage",
      toKind: "factory",
      fromId: "storage-1",
      toId: "factory-1",
      amount: 500,
    });
    replaceCarrierTasksForProducerRoom("factoryControl", "W1N1", [draft]);

    const tasks = getCarrierTasksByRoom("W1N1");
    expect(tasks["factoryControl:factory_supply:W1N1:battery"]).toBeDefined();
    expect(tasks["factoryControl:factory_supply:W1N1:battery"].steps[0].id).toBe(
      "factoryControl:W1N1:battery:storage-1->factory-1",
    );
  });

  it("resolveTerminalStorageTarget prefers terminal when it has capacity", () => {
    const terminal = {
      id: "term-1",
      structureType: STRUCTURE_TERMINAL,
      store: { getFreeCapacity: () => 5000 },
    } as unknown as StructureTerminal;
    const storage = {
      id: "stor-1",
      structureType: STRUCTURE_STORAGE,
      store: { getFreeCapacity: () => 5000 },
    } as unknown as StructureStorage;
    const room = {
      terminal,
      storage,
    } as Room;

    const result = resolveTerminalStorageTarget(room, RESOURCE_ENERGY, "terminal");
    expect(result).toBe(terminal);
  });
});
