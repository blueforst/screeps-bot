export type CarrierTaskType = "lab_supply" | "lab_cleanup" | "mineral_haul" | "terminal_feed" | "terminal_offload";

export interface CarrierTaskStep {
  id: string;
  resource: ResourceConstant;
  fromKind: "lab" | "terminal" | "storage" | "container";
  toKind: "lab" | "terminal" | "storage";
  fromId: string;
  toId: string;
  amount: number;
}

export interface CarrierTask {
  id: string;
  producer: string;
  roomName: string;
  type: CarrierTaskType;
  priority: number;
  steps: CarrierTaskStep[];
  createdAt: number;
  updatedAt: number;
}

export interface CarrierTaskDraft {
  id: string;
  type: CarrierTaskType;
  priority: number;
  steps: CarrierTaskStep[];
}

type CarrierTaskBoardStore = Record<string, Record<string, CarrierTask>>;

type RuntimeGlobalWithCarrierTasks = typeof global & {
  __carrierTaskBoard?: CarrierTaskBoardStore;
};

const runtimeGlobal: RuntimeGlobalWithCarrierTasks = global;

function ensureCarrierTaskBoard(): CarrierTaskBoardStore {
  if (!runtimeGlobal.__carrierTaskBoard) {
    runtimeGlobal.__carrierTaskBoard = {};
  }

  return runtimeGlobal.__carrierTaskBoard;
}

function ensureRoomTaskStore(roomName: string): Record<string, CarrierTask> {
  const board = ensureCarrierTaskBoard();
  const existing = board[roomName];
  if (existing) {
    return existing;
  }

  board[roomName] = {};
  return board[roomName];
}

export function getCarrierTasksByRoom(roomName: string): Record<string, CarrierTask> {
  return ensureRoomTaskStore(roomName);
}

function cleanupRoomTaskStoreIfEmpty(roomName: string): void {
  const tasks = ensureCarrierTaskBoard()[roomName];
  if (!tasks) {
    return;
  }

  if (Object.keys(tasks).length > 0) {
    return;
  }

  delete ensureCarrierTaskBoard()[roomName];
}

export function listCarrierTasksByRoom(roomName: string): CarrierTask[] {
  const tasks = Object.values(getCarrierTasksByRoom(roomName))
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return left.createdAt - right.createdAt;
    });
  return tasks;
}

export function replaceCarrierTasksForProducerRoom(
  producer: string,
  roomName: string,
  drafts: CarrierTaskDraft[],
): void {
  const hasExistingForRoom = Object.values(getCarrierTasksByRoom(roomName)).some((task) => task.producer === producer);
  if (drafts.length === 0 && !hasExistingForRoom) {
    return;
  }

  const store = ensureRoomTaskStore(roomName);
  const nextIds = new Set<string>();

  for (const draft of drafts) {
    const filteredSteps = draft.steps.filter((step) => step.amount > 0);
    if (filteredSteps.length === 0) {
      continue;
    }

    nextIds.add(draft.id);
    const existing = store[draft.id];
    const createdAt =
      existing && existing.producer === producer
        ? existing.createdAt
        : Game.time;
    store[draft.id] = {
      id: draft.id,
      producer,
      roomName,
      type: draft.type,
      priority: draft.priority,
      steps: filteredSteps,
      createdAt,
      updatedAt: Game.time,
    };
  }

  for (const [taskId, task] of Object.entries(store)) {
    if (task.producer !== producer) {
      continue;
    }
    if (nextIds.has(taskId)) {
      continue;
    }
    delete store[taskId];
  }

  cleanupRoomTaskStoreIfEmpty(roomName);
}

export function pruneCarrierTasksForProducer(producer: string, validRoomNames: Set<string>): number {
  let removed = 0;
  for (const [roomName, tasks] of Object.entries(ensureCarrierTaskBoard())) {

    const roomInvalid = !validRoomNames.has(roomName);
    for (const [taskId, task] of Object.entries(tasks)) {
      if (task.producer !== producer) {
        continue;
      }
      if (!roomInvalid) {
        continue;
      }

      delete tasks[taskId];
      removed += 1;
    }

    cleanupRoomTaskStoreIfEmpty(roomName);
  }

  return removed;
}

export function cleanupCarrierTaskBoard(ownedRooms: Set<string>, ttl: number): number {
  let removed = 0;
  for (const [roomName, tasks] of Object.entries(ensureCarrierTaskBoard())) {

    const roomLost = !ownedRooms.has(roomName);
    for (const [taskId, task] of Object.entries(tasks)) {
      const stale = Game.time - task.updatedAt > ttl;
      const roomMismatch = task.roomName !== roomName;
      if (!roomLost && !stale && !roomMismatch) {
        continue;
      }

      delete tasks[taskId];
      removed += 1;
    }

    cleanupRoomTaskStoreIfEmpty(roomName);
  }

  return removed;
}

export function clearCarrierTaskBoardForTest(): void {
  delete runtimeGlobal.__carrierTaskBoard;
}
