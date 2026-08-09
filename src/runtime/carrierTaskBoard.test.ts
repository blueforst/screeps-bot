import {
  claimCarrierTaskStepAmount,
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  listCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
  pruneCarrierTasksForProducer,
  cleanupCarrierTaskBoard,
} from "@/runtime/carrierTaskBoard";
import type { CarrierTaskDraft, CarrierTaskStep } from "@/runtime/carrierTaskBoard";
import { createCarrierTaskStepId, createSingleStepDraft, createCarrierTaskStep, resolveTerminalStorageTarget, terminalStorageKind } from "@/runtime/carrierTaskHelpers";

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
