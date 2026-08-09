export type CarrierTaskType = "lab_supply" | "lab_cleanup" | "lab_product_unload" | "mineral_haul" | "terminal_feed" | "terminal_offload" | "factory_supply" | "factory_unload" | "power_spawn_supply" | "nuker_supply";

export type CarrierStructureKind = "lab" | "terminal" | "storage" | "container" | "factory" | "power_spawn" | "nuker";

export interface CarrierTaskStep {
  id: string;
  resource: ResourceConstant;
  fromKind: CarrierStructureKind;
  toKind: CarrierStructureKind;
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

export interface CarrierTaskStepAmountClaim {
  readonly amount: number;
  commit(): void;
  release(): void;
}

type CarrierTaskBoardStore = Record<string, Record<string, CarrierTask>>;

interface CarrierTaskClaimRecord {
  stepId: string;
  amount: number;
  committed: boolean;
  claimantWasLiveAtClaim: boolean;
}

interface CarrierTaskClaimBudget {
  claims: Map<string, CarrierTaskClaimRecord>;
}

interface CarrierTaskClaimRuntime {
  tick: number;
  game: Game;
  budgets: Map<string, CarrierTaskClaimBudget>;
}

type RuntimeGlobalWithCarrierTasks = typeof global & {
  __carrierTaskBoard?: CarrierTaskBoardStore;
  __carrierTaskClaims?: CarrierTaskClaimRuntime;
};

const runtimeGlobal: RuntimeGlobalWithCarrierTasks = global;

function ensureCarrierTaskBoard(): CarrierTaskBoardStore {
  if (!runtimeGlobal.__carrierTaskBoard) {
    runtimeGlobal.__carrierTaskBoard = {};
  }

  return runtimeGlobal.__carrierTaskBoard;
}

function normalizeClaimAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(amount));
}

function addClaimAmount(total: number, amount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + amount);
}

function getCarrierTaskClaimKey(task: CarrierTask): string {
  return `${task.roomName}\u0000${task.producer}\u0000${task.id}`;
}

function ensureCarrierTaskClaimRuntime(): CarrierTaskClaimRuntime {
  const existing = runtimeGlobal.__carrierTaskClaims;
  if (
    existing &&
    existing.tick === Game.time &&
    existing.game === Game
  ) {
    return existing;
  }

  const created: CarrierTaskClaimRuntime = {
    tick: Game.time,
    game: Game,
    budgets: new Map(),
  };
  runtimeGlobal.__carrierTaskClaims = created;
  return created;
}

function pruneDeadCarrierTaskClaims(
  budget: CarrierTaskClaimBudget,
): void {
  for (const [claimantId, claim] of budget.claims) {
    if (!claim.claimantWasLiveAtClaim || Game.creeps[claimantId]) {
      continue;
    }
    budget.claims.delete(claimantId);
  }
}

function releaseActiveCarrierTaskClaims(task: CarrierTask): void {
  const runtime = runtimeGlobal.__carrierTaskClaims;
  if (
    !runtime ||
    runtime.tick !== Game.time ||
    runtime.game !== Game
  ) {
    return;
  }

  const key = getCarrierTaskClaimKey(task);
  const budget = runtime.budgets.get(key);
  if (!budget) return;

  for (const [claimantId, claim] of budget.claims) {
    if (!claim.committed) {
      budget.claims.delete(claimantId);
    }
  }
  if (budget.claims.size === 0) {
    runtime.budgets.delete(key);
  }
}

/**
 * Atomically claims a same-tick execution slice from both the whole task and
 * one step. Successful intents commit the slice until tick rollover; failed
 * intents release it immediately. This runtime-only ledger never enters
 * Memory and therefore cannot leave a cross-tick stale lock.
 */
export function claimCarrierTaskStepAmount(
  task: CarrierTask,
  step: CarrierTaskStep,
  claimantId: string,
  requestedAmount: number,
): CarrierTaskStepAmountClaim | null {
  const normalizedRequest = normalizeClaimAmount(requestedAmount);
  if (!claimantId || normalizedRequest <= 0) return null;

  const currentStep = task.steps.find((candidate) => candidate.id === step.id);
  if (!currentStep) return null;
  const stepLimit = normalizeClaimAmount(currentStep.amount);
  let taskLimit = 0;
  for (const taskStep of task.steps) {
    taskLimit = addClaimAmount(
      taskLimit,
      normalizeClaimAmount(taskStep.amount),
    );
  }
  if (stepLimit <= 0 || taskLimit <= 0) return null;

  const runtime = ensureCarrierTaskClaimRuntime();
  const key = getCarrierTaskClaimKey(task);
  const budget = runtime.budgets.get(key) || { claims: new Map() };
  runtime.budgets.set(key, budget);
  pruneDeadCarrierTaskClaims(budget);
  if (budget.claims.has(claimantId)) return null;

  let taskClaimed = 0;
  let stepClaimed = 0;
  for (const claim of budget.claims.values()) {
    taskClaimed = addClaimAmount(taskClaimed, claim.amount);
    if (claim.stepId === currentStep.id) {
      stepClaimed = addClaimAmount(stepClaimed, claim.amount);
    }
  }
  const amount = Math.min(
    normalizedRequest,
    Math.max(0, taskLimit - taskClaimed),
    Math.max(0, stepLimit - stepClaimed),
  );
  if (amount <= 0) return null;

  const record: CarrierTaskClaimRecord = {
    stepId: currentStep.id,
    amount,
    committed: false,
    claimantWasLiveAtClaim: !!Game.creeps[claimantId],
  };
  budget.claims.set(claimantId, record);

  const isCurrentRecord = (): boolean =>
    runtimeGlobal.__carrierTaskClaims === runtime &&
    runtime.tick === Game.time &&
    runtime.game === Game &&
    runtime.budgets.get(key) === budget &&
    budget.claims.get(claimantId) === record;

  return {
    amount,
    commit(): void {
      if (!isCurrentRecord()) return;
      record.committed = true;
    },
    release(): void {
      if (!isCurrentRecord() || record.committed) return;
      budget.claims.delete(claimantId);
      if (budget.claims.size === 0) {
        runtime.budgets.delete(key);
      }
    },
  };
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

export function listCarrierTasksForProducer(producer: string): CarrierTask[] {
  const tasks: CarrierTask[] = [];
  for (const roomTasks of Object.values(ensureCarrierTaskBoard())) {
    for (const task of Object.values(roomTasks)) {
      if (task.producer === producer) {
        tasks.push(task);
      }
    }
  }
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
    releaseActiveCarrierTaskClaims(task);
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

      releaseActiveCarrierTaskClaims(task);
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

      releaseActiveCarrierTaskClaims(task);
      delete tasks[taskId];
      removed += 1;
    }

    cleanupRoomTaskStoreIfEmpty(roomName);
  }

  return removed;
}

export function clearCarrierTaskBoardForTest(): void {
  delete runtimeGlobal.__carrierTaskBoard;
  delete runtimeGlobal.__carrierTaskClaims;
}
