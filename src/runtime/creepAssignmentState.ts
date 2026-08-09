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
