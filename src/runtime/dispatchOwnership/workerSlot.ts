import type { WorkerTask } from "@/types/system";
import {
  bindWorkerDispatchBinding,
  readWorkerDispatchBinding,
  releaseWorkerDispatchBinding,
} from "@/runtime/dispatchOwnership/actorBinding";
import {
  equalDispatchRefs,
  isWorkerDispatchRef,
  type WorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

export interface WorkerSlotClaimPort {
  acquire(actorName: string, ref: WorkerDispatchRef, task: WorkerTask): boolean;
  reconcile(actorName: string, ref: WorkerDispatchRef, task: WorkerTask): boolean;
  release(actorName: string, expectedRef: WorkerDispatchRef, task?: WorkerTask): boolean;
  clamp(ref: WorkerDispatchRef, task: WorkerTask): void;
  releaseTask(ref: WorkerDispatchRef, task: WorkerTask): void;
}

function taskMatchesRef(task: WorkerTask, ref: WorkerDispatchRef): boolean {
  return task.id === ref.localId && task.roomName === ref.scope.roomName;
}

interface AssigneeListSnapshot {
  readonly names: readonly string[];
  readonly normalized: boolean;
}

function inspectAssignees(task: WorkerTask): AssigneeListSnapshot {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(task, "assignedCreeps");
  } catch {
    return { names: [], normalized: false };
  }
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) {
    return { names: [], normalized: false };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  let normalized = true;
  for (const name of descriptor.value) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) {
      normalized = false;
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return { names, normalized };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((name, index) => name === right[index]);
}

function hasLiveCreep(actorName: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Game.creeps, actorName);
    return !!descriptor && "value" in descriptor && !!descriptor.value;
  } catch {
    return false;
  }
}

function replaceAssignees(
  task: WorkerTask,
  nextAssignees: readonly string[],
): (() => void) | undefined {
  let previous: PropertyDescriptor | undefined;
  try {
    previous = Object.getOwnPropertyDescriptor(task, "assignedCreeps");
    if (previous && !("value" in previous)) return undefined;
    Object.defineProperty(task, "assignedCreeps", previous
      ? { ...previous, value: [...nextAssignees] }
      : {
        value: [...nextAssignees],
        enumerable: true,
        configurable: true,
        writable: true,
      });
  } catch {
    return undefined;
  }

  return (): void => {
    try {
      if (previous) {
        Object.defineProperty(task, "assignedCreeps", previous);
      } else {
        delete (task as Partial<WorkerTask>).assignedCreeps;
      }
    } catch {
      // A rollback targets the descriptor that was just replaced; failure is
      // only possible if external code mutates the descriptor re-entrantly.
    }
  };
}

function acquireWorkerSlot(
  actorName: string,
  ref: WorkerDispatchRef,
  task: WorkerTask,
): boolean {
  if (
    actorName.length === 0
    || !isWorkerDispatchRef(ref)
    || !taskMatchesRef(task, ref)
    || task.status !== "active"
    || !Number.isInteger(task.maxAssignees)
    || task.maxAssignees < 1
    || readWorkerDispatchBinding(actorName)
  ) {
    return false;
  }

  const nextAssignees = inspectAssignees(task).names.filter((name) => name !== actorName);
  if (nextAssignees.length >= task.maxAssignees) return false;
  nextAssignees.push(actorName);

  const rollback = replaceAssignees(task, nextAssignees);
  if (!rollback) return false;
  if (!bindWorkerDispatchBinding(actorName, ref)) {
    rollback();
    return false;
  }
  return true;
}

function reconcileWorkerSlot(
  actorName: string,
  ref: WorkerDispatchRef,
  task: WorkerTask,
): boolean {
  if (
    actorName.length === 0
    || !isWorkerDispatchRef(ref)
    || !taskMatchesRef(task, ref)
    || task.status !== "active"
  ) {
    return false;
  }

  const current = readWorkerDispatchBinding(actorName);
  if (!current || !equalDispatchRefs(current, ref)) return false;

  const assignees = inspectAssignees(task);
  const actorListed = assignees.names.includes(actorName);
  const actorAlreadyUnique = assignees.normalized && actorListed;
  const nextAssignees = actorListed
    ? assignees.names
    : [...assignees.names, actorName];
  const rollback = actorAlreadyUnique
    ? undefined
    : replaceAssignees(task, nextAssignees);
  if (!actorAlreadyUnique && !rollback) return false;
  if (!bindWorkerDispatchBinding(actorName, ref, current)) {
    rollback?.();
    return false;
  }
  return true;
}

function releaseWorkerSlot(
  actorName: string,
  expectedRef: WorkerDispatchRef,
  task?: WorkerTask,
): boolean {
  if (actorName.length === 0 || !isWorkerDispatchRef(expectedRef)) return false;
  const current = readWorkerDispatchBinding(actorName);
  if (!current || !equalDispatchRefs(current, expectedRef)) return false;
  if (task && !taskMatchesRef(task, expectedRef)) return false;

  const nextAssignees = task
    ? inspectAssignees(task).names.filter((name) => name !== actorName)
    : undefined;
  const rollback = task && nextAssignees
    ? replaceAssignees(task, nextAssignees)
    : undefined;
  if (task && !rollback) return false;
  if (!releaseWorkerDispatchBinding(actorName, expectedRef)) {
    rollback?.();
    return false;
  }
  return true;
}

function clampWorkerSlotAssignees(
  ref: WorkerDispatchRef,
  task: WorkerTask,
): void {
  if (!isWorkerDispatchRef(ref) || !taskMatchesRef(task, ref)) return;

  const assignees = inspectAssignees(task);
  const retained: string[] = [];
  for (const actorName of assignees.names) {
    const binding = readWorkerDispatchBinding(actorName);
    const live = hasLiveCreep(actorName);
    if (live && binding && equalDispatchRefs(binding, ref)) {
      retained.push(actorName);
      continue;
    }
    if (!live && binding && equalDispatchRefs(binding, ref)) {
      releaseWorkerDispatchBinding(actorName, ref);
    }
  }
  if (!assignees.normalized || !sameNames(retained, assignees.names)) {
    replaceAssignees(task, retained);
  }
}

function releaseWorkerTaskSlots(ref: WorkerDispatchRef, task: WorkerTask): void {
  if (!isWorkerDispatchRef(ref) || !taskMatchesRef(task, ref)) return;
  for (const actorName of inspectAssignees(task).names) {
    const binding = readWorkerDispatchBinding(actorName);
    if (binding && equalDispatchRefs(binding, ref)) {
      releaseWorkerDispatchBinding(actorName, ref);
    }
  }
  replaceAssignees(task, []);
}

export const workerSlotClaimPort: WorkerSlotClaimPort = {
  acquire: acquireWorkerSlot,
  reconcile: reconcileWorkerSlot,
  release: releaseWorkerSlot,
  clamp: clampWorkerSlotAssignees,
  releaseTask: releaseWorkerTaskSlots,
};
