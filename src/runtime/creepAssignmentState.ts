import type { CarrierTaskType } from "@/runtime/carrierTaskBoard";

type CarrierPlanTargetKind = "resource" | "structure";
type CarrierPlanMode = "pickup" | "deliver";
type PickupTargetKind = "resource" | "structure";

export interface CreepAssignmentState {
  carrierPlanMode?: CarrierPlanMode;
  carrierPlanTargetId?: string;
  carrierPlanTargetKind?: CarrierPlanTargetKind;
  carrierStorageOnlyMode?: boolean;
  yieldAfterCapacityReliefPickup?: boolean;
  energyPickupTargetId?: string;
  energyPickupTargetKind?: PickupTargetKind;
  energyPickupRoomName?: string;
  taskId?: string;
  synthesisCarrierTaskId?: string;
  synthesisCarrierPendingPickupTick?: number;
  synthesisCarrierPendingStepId?: string;
  synthesisCarrierPendingDeliveryTick?: number;
  synthesisCarrierPendingFromId?: string;
  synthesisCarrierPendingToId?: string;
  synthesisCarrierPendingResource?: ResourceConstant;
  synthesisCarrierPendingTaskType?: CarrierTaskType;
}

type AssignmentStateStore = Record<string, CreepAssignmentState>;

export type CreepAssignmentStateSnapshot = Readonly<CreepAssignmentState>;
export type CreepAssignmentStateStoreSnapshot = Readonly<Record<string, CreepAssignmentStateSnapshot>>;

type RuntimeGlobalWithAssignmentState = typeof global & {
  __creepAssignmentState?: AssignmentStateStore;
};

const runtimeGlobal: RuntimeGlobalWithAssignmentState = global;

function ensureAssignmentStateStore(): AssignmentStateStore {
  if (!runtimeGlobal.__creepAssignmentState) {
    runtimeGlobal.__creepAssignmentState = {};
  }

  return runtimeGlobal.__creepAssignmentState;
}

export function ensureCreepAssignmentState(creepName: string): CreepAssignmentState {
  const store = ensureAssignmentStateStore();
  const existing = store[creepName];
  if (existing) {
    return existing;
  }

  store[creepName] = {};
  return store[creepName];
}

export function getCreepAssignmentState(creepName: string): CreepAssignmentState | undefined {
  return runtimeGlobal.__creepAssignmentState?.[creepName];
}

function defineAssignmentSnapshotProperty(
  target: object,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneAssignmentSnapshotValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) {
    return existing;
  }

  let snapshot: object;
  if (Array.isArray(value)) {
    snapshot = new Array(value.length);
  } else if (typeof value === "function") {
    snapshot = function assignmentSnapshotFunction(): undefined {
      return undefined;
    };
  } else {
    const prototype = Object.getPrototypeOf(source);
    if (prototype === null) {
      snapshot = Object.create(null) as object;
    } else if (prototype === Object.prototype) {
      snapshot = {};
    } else {
      snapshot = Object.create(Object.freeze({})) as object;
    }
  }
  seen.set(source, snapshot);

  for (const key of Object.keys(source)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      defineAssignmentSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    if (!descriptor || !("value" in descriptor)) {
      defineAssignmentSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    let clonedValue: unknown;
    try {
      clonedValue = cloneAssignmentSnapshotValue(descriptor.value, seen);
    } catch {
      clonedValue = undefined;
    }
    defineAssignmentSnapshotProperty(snapshot, key, clonedValue);
  }

  return snapshot;
}

function snapshotCreepAssignmentState(state: CreepAssignmentState): CreepAssignmentStateSnapshot {
  return cloneAssignmentSnapshotValue(state) as CreepAssignmentStateSnapshot;
}

/** Returns one isolated assignment snapshot without creating assignment state. */
export function peekCreepAssignmentState(creepName: string): CreepAssignmentStateSnapshot | undefined {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store || !Object.prototype.hasOwnProperty.call(store, creepName)) {
    return undefined;
  }
  return snapshotCreepAssignmentState(store[creepName]);
}

/** Returns an isolated assignment-store snapshot without creating the private heap store. */
export function peekCreepAssignmentStates(): CreepAssignmentStateStoreSnapshot {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store) {
    return {};
  }

  return cloneAssignmentSnapshotValue(store) as CreepAssignmentStateStoreSnapshot;
}

export function clearCreepAssignmentState(creepName: string): void {
  delete ensureAssignmentStateStore()[creepName];
}

export function pruneDeadCreepAssignmentState(): number {
  const store = runtimeGlobal.__creepAssignmentState;
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
    delete runtimeGlobal.__creepAssignmentState;
  }

  return removed;
}

export function clearCreepAssignmentStateForTest(): void {
  delete runtimeGlobal.__creepAssignmentState;
}
