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

function resetSlotScenario(): void {
  clearCreepAssignmentStateForTest();
  Game.creeps = {};
}

describe("WorkerSlotClaimPort", () => {
  beforeEach(resetSlotScenario);
  afterEach(clearCreepAssignmentStateForTest);

  test("enforces new-actor capacity while healing sticky inverse evidence exactly", () => {
    resetSlotScenario();
    const capacityRef = createWorkerDispatchRef("W1N1", "build:capacity");
    if (!capacityRef) throw new Error("expected valid capacity ref");
    const capacityTask = task("W1N1", "build:capacity");
    expect(workerSlotClaimPort.acquire("Worker1", capacityRef, capacityTask)).toBe(true);
    expect(workerSlotClaimPort.acquire("Worker2", capacityRef, capacityTask)).toBe(false);
    expect(capacityTask.assignedCreeps).toEqual(["Worker1"]);
    expect(readWorkerDispatchBinding("Worker1")).toEqual(capacityRef);
    expect(readWorkerDispatchBinding("Worker2")).toBeUndefined();

    resetSlotScenario();
    const stickyRef = createWorkerDispatchRef("W1N1", "build:sticky");
    if (!stickyRef) throw new Error("expected valid sticky ref");
    const stickyTask = task("W1N1", "build:sticky", 1);
    stickyTask.assignedCreeps = ["Existing"];
    expect(bindWorkerDispatchBinding("Sticky", stickyRef)).toBe(true);
    ensureCreepAssignmentState("Sticky").taskId = "drifted";
    expect(workerSlotClaimPort.reconcile("Sticky", stickyRef, stickyTask)).toBe(true);
    expect(stickyTask.assignedCreeps).toEqual(["Existing", "Sticky"]);
    expect(ensureCreepAssignmentState("Sticky").taskId).toBe(stickyRef.localId);

    resetSlotScenario();
    const stableRef = createWorkerDispatchRef("W1N1", "build:stable");
    if (!stableRef) throw new Error("expected valid stable ref");
    const stableTask = task("W1N1", "build:stable", 1);
    let stableWrites = 0;
    const observedStableTask = new Proxy(stableTask, {
      defineProperty(target, property, attributes): boolean {
        if (property === "assignedCreeps") stableWrites += 1;
        return Reflect.defineProperty(target, property, attributes);
      },
    });
    Game.creeps.Worker = { name: "Worker" } as Creep;
    expect(workerSlotClaimPort.acquire("Worker", stableRef, observedStableTask)).toBe(true);
    const stableAssignees = stableTask.assignedCreeps;
    stableWrites = 0;
    workerSlotClaimPort.clamp(stableRef, observedStableTask);
    expect(workerSlotClaimPort.reconcile("Worker", stableRef, observedStableTask)).toBe(true);
    expect(stableWrites).toBe(0);
    expect(stableTask.assignedCreeps).toBe(stableAssignees);
    ensureCreepAssignmentState("Worker").taskId = "drifted";
    expect(workerSlotClaimPort.reconcile("Worker", stableRef, observedStableTask)).toBe(true);
    expect(stableWrites).toBe(0);
    expect(stableTask.assignedCreeps).toBe(stableAssignees);
    expect(ensureCreepAssignmentState("Worker").taskId).toBe(stableRef.localId);

    resetSlotScenario();
    const inverseRef = createWorkerDispatchRef("W1N1", "build:inverse");
    if (!inverseRef) throw new Error("expected valid inverse ref");
    const inverseTask = task("W1N1", "build:inverse", 1);
    expect(bindWorkerDispatchBinding("Worker", inverseRef)).toBe(true);
    let inverseWrites = 0;
    const observedInverseTask = new Proxy(inverseTask, {
      defineProperty(target, property, attributes): boolean {
        if (property === "assignedCreeps") inverseWrites += 1;
        return Reflect.defineProperty(target, property, attributes);
      },
    });
    inverseTask.assignedCreeps = ["Worker", "Worker"];
    expect(workerSlotClaimPort.reconcile("Worker", inverseRef, observedInverseTask)).toBe(true);
    expect(inverseTask.assignedCreeps).toEqual(["Worker"]);
    expect(inverseWrites).toBe(1);
    inverseTask.assignedCreeps = [];
    inverseWrites = 0;
    expect(workerSlotClaimPort.reconcile("Worker", inverseRef, observedInverseTask)).toBe(true);
    expect(inverseTask.assignedCreeps).toEqual(["Worker"]);
    expect(inverseWrites).toBe(1);
  });

  test("keeps exact ownership atomic across stale release, CAS failure, accessors, and dead clamp", () => {
    resetSlotScenario();
    const refA = createWorkerDispatchRef("W1N1", "shared");
    const refB = createWorkerDispatchRef("W2N2", "shared");
    if (!refA || !refB) throw new Error("expected valid stale-release refs");
    const taskA = task("W1N1", "shared");
    const taskB = task("W2N2", "shared");
    expect(workerSlotClaimPort.acquire("Worker", refA, taskA)).toBe(true);
    expect(workerSlotClaimPort.release("Worker", refA, taskA)).toBe(true);
    expect(workerSlotClaimPort.acquire("Worker", refB, taskB)).toBe(true);
    expect(workerSlotClaimPort.release("Worker", refA, taskA)).toBe(false);
    expect(readWorkerDispatchBinding("Worker")).toEqual(refB);
    expect(taskB.assignedCreeps).toEqual(["Worker"]);

    resetSlotScenario();
    const casRef = createWorkerDispatchRef("W1N1", "build:cas");
    if (!casRef) throw new Error("expected valid CAS ref");
    const casTask = task("W1N1", "build:cas", 2);
    casTask.assignedCreeps = ["Existing"];
    ensureCreepAssignmentState("Worker").dispatchBindings = {
      worker: { malformed: true } as never,
    };
    expect(workerSlotClaimPort.acquire("Worker", casRef, casTask)).toBe(false);
    expect(casTask.assignedCreeps).toEqual(["Existing"]);
    expect(readWorkerDispatchBinding("Worker")).toBeUndefined();

    resetSlotScenario();
    const accessorRef = createWorkerDispatchRef("W1N1", "build:accessor");
    if (!accessorRef) throw new Error("expected valid accessor ref");
    const acquireTask = task("W1N1", "build:accessor");
    const acquireSetter = jest.fn(() => {
      throw new Error("setter must not run");
    });
    Object.defineProperty(acquireTask, "assignedCreeps", {
      get: () => [],
      set: acquireSetter,
      enumerable: true,
      configurable: true,
    });
    expect(workerSlotClaimPort.acquire("Worker", accessorRef, acquireTask)).toBe(false);
    expect(readWorkerDispatchBinding("Worker")).toBeUndefined();
    expect(acquireSetter).not.toHaveBeenCalled();

    const releaseTask = task("W1N1", "build:accessor");
    expect(workerSlotClaimPort.acquire("Worker", accessorRef, releaseTask)).toBe(true);
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
    expect(workerSlotClaimPort.release("Worker", accessorRef, releaseTask)).toBe(false);
    expect(readWorkerDispatchBinding("Worker")).toEqual(accessorRef);
    expect(retained).toEqual(["Worker"]);
    expect(releaseSetter).not.toHaveBeenCalled();

    resetSlotScenario();
    const clampRefA = createWorkerDispatchRef("W1N1", "shared");
    const clampRefB = createWorkerDispatchRef("W2N2", "shared");
    if (!clampRefA || !clampRefB) throw new Error("expected valid clamp refs");
    const clampTask = task("W1N1", "shared", 3);
    clampTask.assignedCreeps = ["WrongRoom", "Dead", "WrongRoom"];
    expect(bindWorkerDispatchBinding("WrongRoom", clampRefB)).toBe(true);
    expect(bindWorkerDispatchBinding("Dead", clampRefA)).toBe(true);
    workerSlotClaimPort.clamp(clampRefA, clampTask);
    expect(clampTask.assignedCreeps).toEqual([]);
    expect(readWorkerDispatchBinding("WrongRoom")).toEqual(clampRefB);
    expect(readWorkerDispatchBinding("Dead")).toBeUndefined();
  });
});
