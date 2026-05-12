import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  listCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
  pruneCarrierTasksForProducer,
  cleanupCarrierTaskBoard,
} from "@/runtime/carrierTaskBoard";
import type { CarrierTaskDraft, CarrierTaskStep } from "@/runtime/carrierTaskBoard";

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
  });

  it("creates tasks from drafts with correct metadata", () => {
    const draft = makeDraft({ id: "test:task:1" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draft]);

    const tasks = getCarrierTasksByRoom("W1N1");
    expect(Object.keys(tasks)).toEqual(["test:task:1"]);
    expect(tasks["test:task:1"]).toMatchObject({
      id: "test:task:1",
      producer: "prodA",
      roomName: "W1N1",
      type: "lab_supply",
      priority: 100,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(tasks["test:task:1"].steps).toEqual(draft.steps);
  });

  it("replaces tasks for one producer while preserving another producer's tasks", () => {
    const draftA = makeDraft({ id: "task:a" });
    const draftB = makeDraft({ id: "task:b" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draftA]);
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [draftB]);

    // Replace prodA's tasks with a new one
    const draftA2 = makeDraft({ id: "task:a2" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draftA2]);

    const tasks = getCarrierTasksByRoom("W1N1");
    expect(tasks["task:a"]).toBeUndefined();
    expect(tasks["task:a2"]).toBeDefined();
    expect(tasks["task:a2"].producer).toBe("prodA");
    expect(tasks["task:b"]).toBeDefined();
    expect(tasks["task:b"].producer).toBe("prodB");
  });

  it("removes all tasks for a producer when given empty drafts", () => {
    const draft = makeDraft({ id: "task:1" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draft]);

    // Also add a task from another producer
    const draftB = makeDraft({ id: "task:b" });
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [draftB]);

    // Clear prodA
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", []);

    const tasks = getCarrierTasksByRoom("W1N1");
    expect(tasks["task:1"]).toBeUndefined();
    expect(tasks["task:b"]).toBeDefined();
  });

  it("returns tasks sorted by priority descending, then createdAt ascending (FIFO)", () => {
    Game.time = 900;
    const low = makeDraft({ id: "low", priority: 50 });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [low]);

    Game.time = 910;
    const high = makeDraft({ id: "high", priority: 200 });
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [high]);

    Game.time = 920;
    const mid = makeDraft({ id: "mid", priority: 100 });
    replaceCarrierTasksForProducerRoom("prodC", "W1N1", [mid]);

    const list = listCarrierTasksByRoom("W1N1");
    expect(list.map((t) => t.id)).toEqual(["high", "mid", "low"]);
    expect(list[0].priority).toBeGreaterThan(list[1].priority);
    expect(list[1].priority).toBeGreaterThan(list[2].priority);
  });

  it("preserves createdAt when replacing a task with the same id from the same producer", () => {
    const draft1 = makeDraft({ id: "task:1", priority: 100 });
    Game.time = 500;
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draft1]);

    const originalTask = getCarrierTasksByRoom("W1N1")["task:1"];
    expect(originalTask!.createdAt).toBe(500);

    // Replace with updated steps
    Game.time = 800;
    const draft2 = makeDraft({
      id: "task:1",
      priority: 100,
      steps: [makeStep({ amount: 999 })],
    });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draft2]);

    const updated = getCarrierTasksByRoom("W1N1")["task:1"];
    expect(updated!.createdAt).toBe(500);
    expect(updated!.updatedAt).toBe(800);
    expect(updated!.steps[0].amount).toBe(999);
  });

  it("does not delete tasks in other rooms when replacing for one room", () => {
    const draft1 = makeDraft({ id: "task:r1" });
    const draft2 = makeDraft({ id: "task:r2" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draft1]);
    replaceCarrierTasksForProducerRoom("prodA", "W2N2", [draft2]);

    // Replace W1N1 tasks only
    const draft1b = makeDraft({ id: "task:r1b" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [draft1b]);

    expect(getCarrierTasksByRoom("W2N2")["task:r2"]).toBeDefined();
    expect(getCarrierTasksByRoom("W1N1")["task:r1b"]).toBeDefined();
    expect(getCarrierTasksByRoom("W1N1")["task:r1"]).toBeUndefined();
  });

  it("prunes tasks in rooms not in the valid set", () => {
    const d1 = makeDraft({ id: "t1" });
    const d2 = makeDraft({ id: "t2" });
    const d3 = makeDraft({ id: "t3" });
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [d1]);
    replaceCarrierTasksForProducerRoom("prodA", "W2N2", [d2]);
    replaceCarrierTasksForProducerRoom("prodA", "W3N3", [d3]);

    const removed = pruneCarrierTasksForProducer("prodA", new Set(["W1N1", "W2N2"]));
    expect(removed).toBe(1);
    expect(getCarrierTasksByRoom("W1N1")["t1"]).toBeDefined();
    expect(getCarrierTasksByRoom("W2N2")["t2"]).toBeDefined();
    expect(getCarrierTasksByRoom("W3N3")["t3"]).toBeUndefined();
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
});
