import { getMemoryService } from "@/runtime/runtimeServices";

export type ResourceTransferTaskStatus = "pending" | "done" | "cancelled" | "failed";

export interface ResourceTransferTask {
  id: string;
  resource: ResourceConstant;
  fromRoomName: string;
  toRoomName: string;
  amount: number;
  remainingAmount: number;
  status: ResourceTransferTaskStatus;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  lastError?: string;
}

export interface CreateResourceTransferTaskResult {
  ok: true;
  task: ResourceTransferTask;
}

export interface CancelResourceTransferTaskResult {
  ok: true;
  taskId: string;
  previousStatus: ResourceTransferTaskStatus;
}

export interface ListResourceTransferTasksResult {
  ok: true;
  tasks: ResourceTransferTask[];
}

let taskIdSequence = 0;
let taskIdSequenceTick = -1;

export function ensureResourceTransferTaskStore(): Record<string, ResourceTransferTask> {
  const data = getMemoryService().ensureData();
  data.resourceControl = data.resourceControl || { tasks: {} };
  data.resourceControl.tasks = data.resourceControl.tasks || {};
  return data.resourceControl.tasks;
}

export function getResourceTransferTaskListSorted(): ResourceTransferTask[] {
  return Object.values(ensureResourceTransferTaskStore()).sort((left, right) => left.createdAt - right.createdAt);
}

function createTaskId(resource: ResourceConstant, fromRoomName: string, toRoomName: string): string {
  if (taskIdSequenceTick !== Game.time) {
    taskIdSequenceTick = Game.time;
    taskIdSequence = 0;
  }

  taskIdSequence += 1;
  return `${Game.time}:${taskIdSequence}:${resource}:${fromRoomName}->${toRoomName}`;
}

function normalizeTaskReason(reason?: string): string | undefined {
  if (!reason) {
    return undefined;
  }

  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findMergeablePendingTask(
  tasks: Record<string, ResourceTransferTask>,
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  reason?: string,
): ResourceTransferTask | null {
  for (const task of Object.values(tasks)) {
    if (
      task.status === "pending" &&
      task.fromRoomName === fromRoomName &&
      task.toRoomName === toRoomName &&
      task.resource === resource &&
      task.reason === reason
    ) {
      return task;
    }
  }

  return null;
}

export function createResourceTransferTask(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): CreateResourceTransferTaskResult | string {
  if (!fromRoomName || !toRoomName) {
    return "ERR_INVALID_ROOM";
  }
  if (fromRoomName === toRoomName) {
    return "ERR_SAME_ROOM";
  }
  if (typeof resource !== "string" || resource.length === 0) {
    return "ERR_INVALID_RESOURCE";
  }
  if (!RESOURCES_ALL.includes(resource as ResourceConstant)) {
    return "ERR_INVALID_RESOURCE";
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }

  const normalizedAmount = Math.floor(amount);
  if (normalizedAmount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }

  const normalizedReason = normalizeTaskReason(reason);
  const store = ensureResourceTransferTaskStore();
  const mergeTarget = findMergeablePendingTask(store, fromRoomName, toRoomName, resource, normalizedReason);
  if (mergeTarget) {
    mergeTarget.amount += normalizedAmount;
    mergeTarget.remainingAmount += normalizedAmount;
    mergeTarget.updatedAt = Game.time;
    mergeTarget.lastError = undefined;
    return {
      ok: true,
      task: mergeTarget,
    };
  }

  const task: ResourceTransferTask = {
    id: createTaskId(resource, fromRoomName, toRoomName),
    resource,
    fromRoomName,
    toRoomName,
    amount: normalizedAmount,
    remainingAmount: normalizedAmount,
    status: "pending",
    createdAt: Game.time,
    updatedAt: Game.time,
    reason: normalizedReason,
  };

  store[task.id] = task;
  return {
    ok: true,
    task,
  };
}

export function cancelResourceTransferTask(taskId: string): CancelResourceTransferTaskResult | string {
  const store = ensureResourceTransferTaskStore();
  const task = store[taskId];
  if (!task) {
    return `ERR_TASK_NOT_FOUND:${taskId}`;
  }

  const previousStatus = task.status;
  task.status = "cancelled";
  task.updatedAt = Game.time;
  task.lastError = "cancelled_by_command";

  return {
    ok: true,
    taskId,
    previousStatus,
  };
}

export function listResourceTransferTasks(): ListResourceTransferTasksResult {
  return {
    ok: true,
    tasks: getResourceTransferTaskListSorted(),
  };
}

export function getOutgoingResourceTransferAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.fromRoomName === roomName && task.resource === resource) {
      total += task.remainingAmount;
    }
  }
  return total;
}

export function getIncomingResourceTransferAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.toRoomName === roomName && task.resource === resource) {
      total += task.remainingAmount;
    }
  }
  return total;
}

export function countPendingOutgoingResourceTransferTasksByRoom(roomName: string): number {
  let count = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.fromRoomName === roomName) {
      count += 1;
    }
  }

  return count;
}

export function countPendingIncomingResourceTransferTasksByRoom(roomName: string): number {
  let count = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.toRoomName === roomName) {
      count += 1;
    }
  }

  return count;
}

export function cleanupResourceTransferTaskStore(ownedRooms: Set<string>, taskTtl: number): number {
  const tasks = getMemoryService().ensureData().resourceControl?.tasks;
  if (!tasks) {
    return 0;
  }

  let removed = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    const sourceOrTargetLost = !ownedRooms.has(task.fromRoomName) || !ownedRooms.has(task.toRoomName);
    const terminalStale =
      (task.status === "done" || task.status === "cancelled" || task.status === "failed") &&
      Game.time - task.updatedAt > taskTtl;
    if (sourceOrTargetLost || terminalStale) {
      delete tasks[taskId];
      removed += 1;
    }
  }

  if (Object.keys(tasks).length === 0 && getMemoryService().ensureData().resourceControl) {
    delete getMemoryService().ensureData().resourceControl;
  }

  return removed;
}
