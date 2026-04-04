type CarrierPlanTargetKind = "resource" | "structure";
type CarrierPlanMode = "pickup" | "deliver";
type PickupTargetKind = "resource" | "structure";

export interface CreepAssignmentState {
  carrierPlanMode?: CarrierPlanMode;
  carrierPlanTargetId?: string;
  carrierPlanTargetKind?: CarrierPlanTargetKind;
  carrierStorageOnlyMode?: boolean;
  energyPickupTargetId?: string;
  energyPickupTargetKind?: PickupTargetKind;
  energyPickupRoomName?: string;
  taskId?: string;
  synthesisCarrierTaskId?: string;
}

type AssignmentStateStore = Record<string, CreepAssignmentState>;

type RuntimeGlobalWithAssignmentState = typeof global & {
  __creepAssignmentState?: AssignmentStateStore;
};

type LegacyAssignmentCreepMemory = CreepMemory & CreepAssignmentState;

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

  const legacy = Memory.creeps?.[creepName] as LegacyAssignmentCreepMemory | undefined;
  const state: CreepAssignmentState = {
    carrierPlanMode: legacy?.carrierPlanMode,
    carrierPlanTargetId: legacy?.carrierPlanTargetId,
    carrierPlanTargetKind: legacy?.carrierPlanTargetKind,
    carrierStorageOnlyMode: legacy?.carrierStorageOnlyMode,
    energyPickupTargetId: legacy?.energyPickupTargetId,
    energyPickupTargetKind: legacy?.energyPickupTargetKind,
    energyPickupRoomName: legacy?.energyPickupRoomName,
    taskId: legacy?.taskId,
    synthesisCarrierTaskId: legacy?.synthesisCarrierTaskId,
  };

  if (legacy) {
    delete legacy.carrierPlanMode;
    delete legacy.carrierPlanTargetId;
    delete legacy.carrierPlanTargetKind;
    delete legacy.carrierStorageOnlyMode;
    delete legacy.energyPickupTargetId;
    delete legacy.energyPickupTargetKind;
    delete legacy.energyPickupRoomName;
    delete legacy.taskId;
    delete legacy.synthesisCarrierTaskId;
  }

  store[creepName] = state;
  return state;
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

export function cleanupLegacyCreepAssignmentMemory(): number {
  if (!Memory.creeps) {
    return 0;
  }

  let removed = 0;
  for (const creepMemory of Object.values(Memory.creeps)) {
    const legacy = creepMemory as LegacyAssignmentCreepMemory;

    if (legacy.carrierPlanMode !== undefined) {
      delete legacy.carrierPlanMode;
      removed += 1;
    }
    if (legacy.carrierPlanTargetId !== undefined) {
      delete legacy.carrierPlanTargetId;
      removed += 1;
    }
    if (legacy.carrierPlanTargetKind !== undefined) {
      delete legacy.carrierPlanTargetKind;
      removed += 1;
    }
    if (legacy.carrierStorageOnlyMode !== undefined) {
      delete legacy.carrierStorageOnlyMode;
      removed += 1;
    }
    if (legacy.energyPickupTargetId !== undefined) {
      delete legacy.energyPickupTargetId;
      removed += 1;
    }
    if (legacy.energyPickupTargetKind !== undefined) {
      delete legacy.energyPickupTargetKind;
      removed += 1;
    }
    if (legacy.energyPickupRoomName !== undefined) {
      delete legacy.energyPickupRoomName;
      removed += 1;
    }
    if (legacy.taskId !== undefined) {
      delete legacy.taskId;
      removed += 1;
    }
    if (legacy.synthesisCarrierTaskId !== undefined) {
      delete legacy.synthesisCarrierTaskId;
      removed += 1;
    }
  }

  return removed;
}

export function clearCreepAssignmentStateForTest(): void {
  delete runtimeGlobal.__creepAssignmentState;
}
