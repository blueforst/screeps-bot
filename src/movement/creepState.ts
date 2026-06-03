import type { MovePathState, TravelState, WorkAnchor } from "@/movement/types";

export interface CreepMovementState {
  movePathState?: MovePathState;
  travelState?: TravelState;
  movementPushedAt?: number;
  pathingRequestedAt?: number;
  workAnchor?: WorkAnchor;
}

type MovementStateStore = Record<string, CreepMovementState>;

type RuntimeGlobalWithMovementState = typeof global & {
  __creepMovementState?: MovementStateStore;
};

const runtimeGlobal: RuntimeGlobalWithMovementState = global;

function ensureMovementStateStore(): MovementStateStore {
  if (!runtimeGlobal.__creepMovementState) {
    runtimeGlobal.__creepMovementState = {};
  }

  return runtimeGlobal.__creepMovementState;
}

export function ensureCreepMovementState(creepName: string): CreepMovementState {
  const store = ensureMovementStateStore();
  const existing = store[creepName];
  if (existing) {
    return existing;
  }

  store[creepName] = {};
  return store[creepName];
}

export function getCreepMovementState(creepName: string): CreepMovementState | undefined {
  return runtimeGlobal.__creepMovementState?.[creepName];
}

export function clearCreepMovementState(creepName: string): void {
  delete ensureMovementStateStore()[creepName];
}

export function pruneDeadCreepMovementState(): number {
  const store = runtimeGlobal.__creepMovementState;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const creepName of Object.keys(store)) {
    if (Game.creeps[creepName]) {
      continue;
    }

    delete store[creepName];
    removed += 1;
  }

  if (Object.keys(store).length === 0) {
    delete runtimeGlobal.__creepMovementState;
  }

  return removed;
}

export function clearCreepMovementStateForTest(): void {
  delete runtimeGlobal.__creepMovementState;
}
