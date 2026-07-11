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

export interface ResourceTransferTaskAmountIndex {
  getOutgoing(roomName: string, resource: ResourceConstant): number;
  getPendingOutgoing(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
  getIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
  getPendingIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
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

export const BLOCKING_ERRORS = new Set([
  "insufficient_terminal_resource_or_fee",
]);

const PHANTOM_INCOMING_SOURCE_CHECK_TICKS = 100;

function getVisibleSourceRoomStock(task: ResourceTransferTask): number | null {
  const room = Game.rooms[task.fromRoomName];
  if (!room) {
    return null;
  }

  const terminalAmount = room.terminal?.store.getUsedCapacity(task.resource) ?? 0;
  const storageAmount = room.storage?.store.getUsedCapacity(task.resource) ?? 0;
  return terminalAmount + storageAmount;
}

function isPendingTransferStillSupplyable(task: ResourceTransferTask): boolean {
  if (BLOCKING_ERRORS.has(task.lastError ?? "")) {
    return false;
  }

  if (Game.time - task.createdAt < PHANTOM_INCOMING_SOURCE_CHECK_TICKS) {
    return true;
  }

  const visibleSourceStock = getVisibleSourceRoomStock(task);
  return visibleSourceStock == null || visibleSourceStock > 0;
}

function transferAmountKey(roomName: string, resource: ResourceConstant): string {
  return `${roomName}:${resource}`;
}

function getIndexedAmount(
  totals: Map<string, number>,
  byReason: Map<string, Map<string, number>>,
  roomName: string,
  resource: ResourceConstant,
  reasonPrefix?: string,
): number {
  const key = transferAmountKey(roomName, resource);
  if (!reasonPrefix) return totals.get(key) || 0;

  let total = 0;
  for (const [reason, amount] of byReason.get(key) || []) {
    if (reason.startsWith(reasonPrefix)) total += amount;
  }
  return total;
}

/**
 * Builds a point-in-time lookup for transfer planning. Only pending tasks
 * contribute, matching the public incoming/outgoing amount helpers.
 */
export function createResourceTransferTaskAmountIndex(): ResourceTransferTaskAmountIndex {
  const incoming = new Map<string, number>();
  const incomingByReason = new Map<string, Map<string, number>>();
  const outgoing = new Map<string, number>();
  const outgoingByReason = new Map<string, Map<string, number>>();
  const pendingIncoming = new Map<string, number>();
  const pendingIncomingByReason = new Map<string, Map<string, number>>();

  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending") continue;

    const outgoingKey = transferAmountKey(task.fromRoomName, task.resource);
    outgoing.set(outgoingKey, (outgoing.get(outgoingKey) || 0) + task.remainingAmount);
    const reason = task.reason || "";
    const outgoingReasonAmounts = outgoingByReason.get(outgoingKey) || new Map<string, number>();
    outgoingReasonAmounts.set(reason, (outgoingReasonAmounts.get(reason) || 0) + task.remainingAmount);
    outgoingByReason.set(outgoingKey, outgoingReasonAmounts);

    const incomingKey = transferAmountKey(task.toRoomName, task.resource);
    pendingIncoming.set(incomingKey, (pendingIncoming.get(incomingKey) || 0) + task.remainingAmount);
    const pendingReasonAmounts = pendingIncomingByReason.get(incomingKey) || new Map<string, number>();
    pendingReasonAmounts.set(reason, (pendingReasonAmounts.get(reason) || 0) + task.remainingAmount);
    pendingIncomingByReason.set(incomingKey, pendingReasonAmounts);

    if (!isPendingTransferStillSupplyable(task)) continue;
    incoming.set(incomingKey, (incoming.get(incomingKey) || 0) + task.remainingAmount);
    const reasonAmounts = incomingByReason.get(incomingKey) || new Map<string, number>();
    reasonAmounts.set(reason, (reasonAmounts.get(reason) || 0) + task.remainingAmount);
    incomingByReason.set(incomingKey, reasonAmounts);
  }

  return {
    getOutgoing(roomName: string, resource: ResourceConstant): number {
      return outgoing.get(transferAmountKey(roomName, resource)) || 0;
    },
    getPendingOutgoing(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number {
      return getIndexedAmount(outgoing, outgoingByReason, roomName, resource, reasonPrefix);
    },
    getIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number {
      return getIndexedAmount(incoming, incomingByReason, roomName, resource, reasonPrefix);
    },
    getPendingIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number {
      return getIndexedAmount(pendingIncoming, pendingIncomingByReason, roomName, resource, reasonPrefix);
    },
  };
}

export function getIncomingResourceTransferAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (
      task.status === "pending" &&
      task.toRoomName === roomName &&
      task.resource === resource &&
      isPendingTransferStillSupplyable(task)
    ) {
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

export function cleanupResourceTransferTaskStore(
  ownedRooms: Set<string>,
  terminalTaskTtl: number,
  blockingTaskTtl = terminalTaskTtl,
): number {
  const tasks = getMemoryService().ensureData().resourceControl?.tasks;
  if (!tasks) {
    return 0;
  }

  let removed = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    const sourceOrTargetLost = !ownedRooms.has(task.fromRoomName) || !ownedRooms.has(task.toRoomName);
    const terminalStale =
      (task.status === "done" || task.status === "cancelled" || task.status === "failed") &&
      Game.time - task.updatedAt > terminalTaskTtl;
    const blockingStale =
      task.status === "pending" &&
      task.lastError != null &&
      BLOCKING_ERRORS.has(task.lastError) &&
      Game.time - task.createdAt > blockingTaskTtl;
    if (sourceOrTargetLost || terminalStale || blockingStale) {
      delete tasks[taskId];
      removed += 1;
    }
  }

  if (Object.keys(tasks).length === 0 && getMemoryService().ensureData().resourceControl) {
    delete getMemoryService().ensureData().resourceControl;
  }

  return removed;
}
