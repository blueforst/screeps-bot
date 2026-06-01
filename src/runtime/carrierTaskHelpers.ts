import type { CarrierStructureKind, CarrierTaskDraft, CarrierTaskStep, CarrierTaskType } from "./carrierTaskBoard";

export type TerminalStoragePreference = "terminal" | "storage";

export function resolveTerminalStorageTarget(
  room: Room,
  resource: ResourceConstant,
  preferred: TerminalStoragePreference = "terminal",
): StructureTerminal | StructureStorage | null {
  const primary = preferred === "terminal" ? room.terminal : room.storage;
  const fallback = preferred === "terminal" ? room.storage : room.terminal;

  if (primary && primary.store.getFreeCapacity(resource) > 0) {
    return primary;
  }
  if (fallback && fallback.store.getFreeCapacity(resource) > 0) {
    return fallback;
  }
  return null;
}

export function terminalStorageKind(
  structure: StructureTerminal | StructureStorage,
): "terminal" | "storage" {
  return structure.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage";
}

export function createCarrierTaskStepId(params: {
  producer: string;
  roomName: string;
  resource: ResourceConstant;
  fromId: string;
  toId: string;
}): string {
  return `${params.producer}:${params.roomName}:${params.resource}:${params.fromId}->${params.toId}`;
}

export function createCarrierTaskStep(params: {
  producer: string;
  roomName: string;
  resource: ResourceConstant;
  fromKind: CarrierStructureKind;
  toKind: CarrierStructureKind;
  fromId: string;
  toId: string;
  amount: number;
}): CarrierTaskStep {
  return {
    id: createCarrierTaskStepId({
      producer: params.producer,
      roomName: params.roomName,
      resource: params.resource,
      fromId: params.fromId,
      toId: params.toId,
    }),
    resource: params.resource,
    fromKind: params.fromKind,
    toKind: params.toKind,
    fromId: params.fromId,
    toId: params.toId,
    amount: params.amount,
  };
}

export function createSingleStepDraft(params: {
  taskId: string;
  type: CarrierTaskType;
  priority: number;
  producer: string;
  roomName: string;
  resource: ResourceConstant;
  fromKind: CarrierStructureKind;
  toKind: CarrierStructureKind;
  fromId: string;
  toId: string;
  amount: number;
}): CarrierTaskDraft {
  return {
    id: params.taskId,
    type: params.type,
    priority: params.priority,
    steps: [createCarrierTaskStep({
      producer: params.producer,
      roomName: params.roomName,
      resource: params.resource,
      fromKind: params.fromKind,
      toKind: params.toKind,
      fromId: params.fromId,
      toId: params.toId,
      amount: params.amount,
    })],
  };
}
