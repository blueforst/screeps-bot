import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  getCreepAssignmentState,
  peekCreepAssignmentState,
  peekCreepAssignmentStates,
} from "@/runtime/creepAssignmentState";

type RuntimeGlobalWithAssignmentState = typeof global & {
  __creepAssignmentState?: Record<string, Record<string, unknown>>;
};

const runtimeGlobal = global as RuntimeGlobalWithAssignmentState;

describe("creepAssignmentState readonly selectors", () => {
  beforeEach(() => {
    clearCreepAssignmentStateForTest();
  });

  it("peeks reset and missing assignment state without creating the private global slot", () => {
    const privateKeysBefore = Reflect.ownKeys(global).filter(
      (key): key is string => typeof key === "string" && key.startsWith("__"),
    );

    expect(runtimeGlobal.__creepAssignmentState).toBeUndefined();
    expect(peekCreepAssignmentState("Worker1")).toBeUndefined();
    expect(peekCreepAssignmentStates()).toEqual({});
    expect(runtimeGlobal.__creepAssignmentState).toBeUndefined();
    expect(
      Reflect.ownKeys(global).filter(
        (key): key is string => typeof key === "string" && key.startsWith("__"),
      ),
    ).toEqual(privateKeysBefore);
  });

  it("returns precise isolated single and full snapshots while preserving the mutable getter ABI", () => {
    const workerState = ensureCreepAssignmentState("Worker1");
    workerState.taskId = "repair:r1";
    workerState.energyPickupTargetId = "storage1";
    const carrierState = ensureCreepAssignmentState("Carrier1");
    carrierState.synthesisCarrierTaskId = "carrier:t1";
    carrierState.synthesisCarrierPendingPickupTick = 123;
    const sourceStore = runtimeGlobal.__creepAssignmentState;

    expect(getCreepAssignmentState("Worker1")).toBe(workerState);
    expect(getCreepAssignmentState("Carrier1")).toBe(carrierState);

    const workerSnapshot = peekCreepAssignmentState("Worker1");
    const allSnapshots = peekCreepAssignmentStates();

    expect(workerSnapshot).toEqual(workerState);
    expect(workerSnapshot).not.toBe(workerState);
    expect(allSnapshots).toEqual({ Worker1: workerState, Carrier1: carrierState });
    expect(allSnapshots.Worker1).not.toBe(workerState);
    expect(allSnapshots.Carrier1).not.toBe(carrierState);
    expect(runtimeGlobal.__creepAssignmentState).toBe(sourceStore);

    const mutableWorkerSnapshot = workerSnapshot as Record<string, unknown>;
    mutableWorkerSnapshot.taskId = "snapshot-only";
    delete mutableWorkerSnapshot.energyPickupTargetId;
    const mutableAllSnapshots = allSnapshots as unknown as Record<string, Record<string, unknown>>;
    mutableAllSnapshots.Worker1.taskId = "full-snapshot-only";
    delete mutableAllSnapshots.Carrier1;
    mutableAllSnapshots.Ghost = { taskId: "ghost-task" };

    expect(workerState).toEqual({
      taskId: "repair:r1",
      energyPickupTargetId: "storage1",
    });
    expect(carrierState).toEqual({
      synthesisCarrierTaskId: "carrier:t1",
      synthesisCarrierPendingPickupTick: 123,
    });
    expect(runtimeGlobal.__creepAssignmentState).toBe(sourceStore);
    expect(Object.keys(runtimeGlobal.__creepAssignmentState || {})).toEqual(["Worker1", "Carrier1"]);
    expect(peekCreepAssignmentState("Worker1")).toEqual(workerState);
    expect(peekCreepAssignmentStates()).toEqual({ Worker1: workerState, Carrier1: carrierState });
  });

  it("preserves malformed state shape without hiding it or blocking valid siblings", () => {
    const validState = ensureCreepAssignmentState("Worker1");
    validState.taskId = "build:valid";
    const sourceStore = runtimeGlobal.__creepAssignmentState;
    (sourceStore as unknown as Record<string, unknown>).Broken = 42;

    const malformedSnapshot = peekCreepAssignmentState("Broken");
    const snapshots = peekCreepAssignmentStates();

    expect(malformedSnapshot as unknown).toBe(42);
    expect(snapshots.Broken as unknown).toBe(42);
    expect(snapshots.Worker1).toEqual(validState);
    expect(snapshots.Worker1).not.toBe(validState);
    expect(runtimeGlobal.__creepAssignmentState).toBe(sourceStore);
    expect((runtimeGlobal.__creepAssignmentState as unknown as Record<string, unknown>).Broken)
      .toBe(42);
    expect(getCreepAssignmentState("Worker1")).toBe(validState);
  });
});
