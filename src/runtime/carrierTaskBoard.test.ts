import {
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
