import workerWorkAdapter, {
  type WorkerWorkAdapterContext,
} from "@/runtime/taskSystem/adapters/workerWork";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  peekCreepAssignmentStates,
  type CreepAssignmentStateStoreSnapshot,
} from "@/runtime/creepAssignmentState";
import type { WorkerTaskBoardSnapshot } from "@/runtime/workerTaskPool";

type MutableRecord = Record<string, unknown>;

function task(overrides: MutableRecord = {}): MutableRecord {
  return {
    id: "build:site-1",
    type: "build",
    targetId: "site-1",
    roomName: "W1N1",
    priority: 850,
    requiredWork: 2_000,
    assignedCreeps: [],
    maxAssignees: 2,
    status: "active",
    updatedAt: 123,
    ...overrides,
  };
}


function context(
  board: unknown,
  assignments: unknown = {},
): WorkerWorkAdapterContext {
  return {
    board: board as WorkerTaskBoardSnapshot,
    assignments: assignments as CreepAssignmentStateStoreSnapshot,
  };
}

describe("workerWorkAdapter", () => {
  afterEach(() => {
    clearCreepAssignmentStateForTest();
  });

  test("fails closed for malformed roots and assignment records", () => {
    expect(workerWorkAdapter.snapshot({} as WorkerWorkAdapterContext)).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "worker-context-malformed",
        message: expect.any(String),
        field: "context",
      }],
    });
    expect(workerWorkAdapter.snapshot(context([], {}))).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "worker-board-malformed",
        message: expect.any(String),
        field: "board",
      }],
    });

    const result = workerWorkAdapter.snapshot(context(
      { W1N1: { "build:site-1": task({ assignedCreeps: ["Broken"] }) } },
      { Broken: 1, EmptyTask: { taskId: "" } },
    ));

    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].authorities).toEqual([
      { role: "producer", id: "workerTaskPool" },
    ]);
    expect(result.entries[0].issues).toContainEqual(expect.objectContaining({
      code: "worker-assignment-evidence-malformed",
    }));
    expect(result.invalidCount).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "worker-assignment-record-malformed",
      "worker-assignment-task-id-invalid",
    ]);

    const malformedAssignments = workerWorkAdapter.snapshot(context(
      { W1N1: { "build:site-1": task() } },
      [],
    ));
    expect(malformedAssignments.entries[0].activity).toBe("unknown");
    expect(malformedAssignments.invalidCount).toBe(1);
    expect(malformedAssignments.issues).toEqual([
      expect.objectContaining({ code: "worker-assignments-malformed" }),
    ]);
  });

  test("counts malformed assignment state preserved by the safe selector without dropping valid work", () => {
    const validState = ensureCreepAssignmentState("Worker1");
    validState.taskId = "build:site-1";
    const runtimeGlobal = global as typeof global & {
      __creepAssignmentState?: Record<string, unknown>;
    };
    const sourceStore = runtimeGlobal.__creepAssignmentState;
    if (!sourceStore) throw new Error("assignment store was not created");
    sourceStore.Broken = 42;

    const result = workerWorkAdapter.snapshot(context(
      { W1N1: { "build:site-1": task({ assignedCreeps: ["Worker1"] }) } },
      peekCreepAssignmentStates(),
    ));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].sourceState).toBe("active");
    expect(result.entries[0].authorities).toEqual([
      { role: "producer", id: "workerTaskPool" },
    ]);
    expect(result.invalidCount).toBe(1);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "worker-assignment-record-malformed",
      field: "Broken",
    }));
    expect(runtimeGlobal.__creepAssignmentState).toBe(sourceStore);
    expect(sourceStore.Broken).toBe(42);
    expect(ensureCreepAssignmentState("Worker1")).toBe(validState);
  });
});
