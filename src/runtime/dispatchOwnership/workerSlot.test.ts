import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import {
  bindWorkerDispatchBinding,
  readWorkerDispatchBinding,
} from "@/runtime/dispatchOwnership/actorBinding";
import { createWorkerDispatchRef } from "@/runtime/dispatchOwnership/ref";
import { workerSlotClaimPort } from "@/runtime/dispatchOwnership/workerSlot";
import type { WorkerTask } from "@/types/system";

function task(roomName: string, localId: string, maxAssignees = 1): WorkerTask {
  return {
    id: localId,
    type: "build",
    targetId: `${localId}:target`,
    roomName,
    priority: 300,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

describe("WorkerSlotClaimPort", () => {
  beforeEach(() => {
    clearCreepAssignmentStateForTest();
    Game.creeps = {};
  });

  afterEach(() => {
    clearCreepAssignmentStateForTest();
  });

  test("acquires one exact slot and rejects a new actor at capacity", () => {
    const ref = createWorkerDispatchRef("W1N1", "build:site");
    if (!ref) throw new Error("expected valid ref");
    const sourceTask = task("W1N1", "build:site");

    expect(workerSlotClaimPort.acquire("Worker1", ref, sourceTask)).toBe(true);
    expect(workerSlotClaimPort.acquire("Worker2", ref, sourceTask)).toBe(false);
    expect(sourceTask.assignedCreeps).toEqual(["Worker1"]);
    expect(readWorkerDispatchBinding("Worker1")).toEqual(ref);
    expect(ensureCreepAssignmentState("Worker1").taskId).toBe(ref.localId);
    expect(readWorkerDispatchBinding("Worker2")).toBeUndefined();
  });

  test("reconciles an existing sticky slot after capacity shrink and heals both mirrors", () => {
    const ref = createWorkerDispatchRef("W1N1", "build:site");
    if (!ref) throw new Error("expected valid ref");
    const sourceTask = task("W1N1", "build:site", 1);
    sourceTask.assignedCreeps = ["Existing"];
    expect(bindWorkerDispatchBinding("Sticky", ref)).toBe(true);
    ensureCreepAssignmentState("Sticky").taskId = "drifted";

    expect(workerSlotClaimPort.reconcile("Sticky", ref, sourceTask)).toBe(true);
    expect(sourceTask.assignedCreeps).toEqual(["Existing", "Sticky"]);
    expect(ensureCreepAssignmentState("Sticky").taskId).toBe(ref.localId);
  });

  test("does not rewrite an unchanged sticky inverse and still repairs mirror drift", () => {
    const ref = createWorkerDispatchRef("W1N1", "build:site");
    if (!ref) throw new Error("expected valid ref");
    const sourceTask = task("W1N1", "build:site", 1);
    let assigneeDescriptorWrites = 0;
    const observedTask = new Proxy(sourceTask, {
      defineProperty(target, property, attributes): boolean {
        if (property === "assignedCreeps") assigneeDescriptorWrites += 1;
        return Reflect.defineProperty(target, property, attributes);
      },
    });
    Game.creeps.Worker = { name: "Worker" } as Creep;
    expect(workerSlotClaimPort.acquire("Worker", ref, observedTask)).toBe(true);
    const stableAssignees = sourceTask.assignedCreeps;
    assigneeDescriptorWrites = 0;

    workerSlotClaimPort.clamp(ref, observedTask);
    expect(workerSlotClaimPort.reconcile("Worker", ref, observedTask)).toBe(true);

    expect(assigneeDescriptorWrites).toBe(0);
    expect(sourceTask.assignedCreeps).toBe(stableAssignees);

    ensureCreepAssignmentState("Worker").taskId = "drifted";
    expect(workerSlotClaimPort.reconcile("Worker", ref, observedTask)).toBe(true);
    expect(assigneeDescriptorWrites).toBe(0);
    expect(sourceTask.assignedCreeps).toBe(stableAssignees);
    expect(ensureCreepAssignmentState("Worker").taskId).toBe(ref.localId);
  });

  test("still rewrites duplicate or missing sticky inverse evidence exactly once", () => {
    const ref = createWorkerDispatchRef("W1N1", "build:site");
    if (!ref) throw new Error("expected valid ref");
    const sourceTask = task("W1N1", "build:site", 1);
    expect(bindWorkerDispatchBinding("Worker", ref)).toBe(true);
    let assigneeDescriptorWrites = 0;
    const observedTask = new Proxy(sourceTask, {
      defineProperty(target, property, attributes): boolean {
        if (property === "assignedCreeps") assigneeDescriptorWrites += 1;
        return Reflect.defineProperty(target, property, attributes);
      },
    });

    sourceTask.assignedCreeps = ["Worker", "Worker"];
    expect(workerSlotClaimPort.reconcile("Worker", ref, observedTask)).toBe(true);
    expect(sourceTask.assignedCreeps).toEqual(["Worker"]);
    expect(assigneeDescriptorWrites).toBe(1);

    sourceTask.assignedCreeps = [];
    assigneeDescriptorWrites = 0;
    expect(workerSlotClaimPort.reconcile("Worker", ref, observedTask)).toBe(true);
    expect(sourceTask.assignedCreeps).toEqual(["Worker"]);
    expect(assigneeDescriptorWrites).toBe(1);
  });

  test("an old expected-ref release cannot clear a newer assignment", () => {
    const refA = createWorkerDispatchRef("W1N1", "shared");
    const refB = createWorkerDispatchRef("W2N2", "shared");
    if (!refA || !refB) throw new Error("expected valid refs");
    const taskA = task("W1N1", "shared");
    const taskB = task("W2N2", "shared");
    expect(workerSlotClaimPort.acquire("Worker", refA, taskA)).toBe(true);
    expect(workerSlotClaimPort.release("Worker", refA, taskA)).toBe(true);
    expect(workerSlotClaimPort.acquire("Worker", refB, taskB)).toBe(true);

    expect(workerSlotClaimPort.release("Worker", refA, taskA)).toBe(false);
    expect(readWorkerDispatchBinding("Worker")).toEqual(refB);
    expect(taskB.assignedCreeps).toEqual(["Worker"]);
  });

  test("rolls the inverse index back when canonical acquire CAS fails", () => {
    const ref = createWorkerDispatchRef("W1N1", "build:site");
    if (!ref) throw new Error("expected valid ref");
    const sourceTask = task("W1N1", "build:site", 2);
    sourceTask.assignedCreeps = ["Existing"];
    ensureCreepAssignmentState("Worker").dispatchBindings = {
      worker: { malformed: true } as never,
    };

    expect(workerSlotClaimPort.acquire("Worker", ref, sourceTask)).toBe(false);
    expect(sourceTask.assignedCreeps).toEqual(["Existing"]);
    expect(readWorkerDispatchBinding("Worker")).toBeUndefined();
  });

  test("does not drift either side when an assignee accessor rejects acquire or release", () => {
    const ref = createWorkerDispatchRef("W1N1", "build:site");
    if (!ref) throw new Error("expected valid ref");
    const acquireTask = task("W1N1", "build:site");
    const acquireSetter = jest.fn(() => {
      throw new Error("setter must not run");
    });
    Object.defineProperty(acquireTask, "assignedCreeps", {
      get: () => [],
      set: acquireSetter,
      enumerable: true,
      configurable: true,
    });

    expect(workerSlotClaimPort.acquire("Worker", ref, acquireTask)).toBe(false);
    expect(readWorkerDispatchBinding("Worker")).toBeUndefined();
    expect(acquireSetter).not.toHaveBeenCalled();

    const releaseTask = task("W1N1", "build:site");
    expect(workerSlotClaimPort.acquire("Worker", ref, releaseTask)).toBe(true);
    const retained = ["Worker"];
    const releaseSetter = jest.fn(() => {
      throw new Error("setter must not run");
    });
    Object.defineProperty(releaseTask, "assignedCreeps", {
      get: () => retained,
      set: releaseSetter,
      enumerable: true,
      configurable: true,
    });

    expect(workerSlotClaimPort.release("Worker", ref, releaseTask)).toBe(false);
    expect(readWorkerDispatchBinding("Worker")).toEqual(ref);
    expect(retained).toEqual(["Worker"]);
    expect(releaseSetter).not.toHaveBeenCalled();
  });

  test("clamps by exact ref and releases a dead actor without crossing rooms", () => {
    const refA = createWorkerDispatchRef("W1N1", "shared");
    const refB = createWorkerDispatchRef("W2N2", "shared");
    if (!refA || !refB) throw new Error("expected valid refs");
    const taskA = task("W1N1", "shared", 3);
    taskA.assignedCreeps = ["WrongRoom", "Dead", "WrongRoom"];
    expect(bindWorkerDispatchBinding("WrongRoom", refB)).toBe(true);
    expect(bindWorkerDispatchBinding("Dead", refA)).toBe(true);

    workerSlotClaimPort.clamp(refA, taskA);

    expect(taskA.assignedCreeps).toEqual([]);
    expect(readWorkerDispatchBinding("WrongRoom")).toEqual(refB);
    expect(readWorkerDispatchBinding("Dead")).toBeUndefined();
  });
});
