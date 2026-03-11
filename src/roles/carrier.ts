import type { RoleFactory } from "@/types/system";
import {
  getEnergyStoreTarget,
  isDroppedResourceTarget,
  moveToTarget,
} from "@/roles/shared";
import {
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} from "@/runtime/energyPickupReservation";
import { listCarrierTasksByRoom, type CarrierTask, type CarrierTaskStep } from "@/runtime/carrierTaskBoard";
import { isStorageReceiverLink } from "@/runtime/linkControl";
import { getTickContextService } from "@/runtime/runtimeServices";

type CarrierPickupTarget = Resource | StructureContainer | StructureLink | StructureStorage | Tombstone | Ruin;

function isEmergencyResponseCarrier(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) {
    return false;
  }

  return configName.includes(":manual:maxcarrier:") || configName.includes(":emergency:");
}

function getCarrierPickupAmount(target: CarrierPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function isTombstonePickupTarget(target: Resource | AnyStoreStructure | Tombstone | Ruin): target is Tombstone {
  return (target as Tombstone).deathTime !== undefined;
}

function isControllerAdjacentLink(link: StructureLink): boolean {
  const controllerPos = link.room.controller?.pos;
  return !!controllerPos && link.pos.getRangeTo(controllerPos) <= 2;
}

function getWeightedCarrierPickupCandidates(creep: Creep, options?: { includeStorage?: boolean }): CarrierPickupTarget[] {
  const roomContext = getTickContextService().getRoomContext(creep.room);
  const dropped = roomContext?.getDroppedEnergyResources() || [];
  const allStructures = roomContext?.getStructures() || [];
  const structures = allStructures.filter(
    (structure): structure is StructureContainer | StructureLink =>
      (structure.structureType === STRUCTURE_CONTAINER ||
        (structure.structureType === STRUCTURE_LINK &&
          isStorageReceiverLink(structure as StructureLink) &&
          !isControllerAdjacentLink(structure as StructureLink))) &&
      (structure as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  );
  const tombstones = roomContext?.getEnergyTombstones() || [];
  const ruins = roomContext?.getEnergyRuins() || [];
  const storage =
    options?.includeStorage && creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0
      ? [creep.room.storage]
      : [];

  const candidates: CarrierPickupTarget[] = [...dropped, ...structures, ...tombstones, ...ruins, ...storage];
  if (candidates.length === 0) {
    return [];
  }

  return candidates
    .map((candidate) => {
      const amount = getCarrierPickupAmount(candidate);
      const distance = Math.max(1, creep.pos.getRangeTo(candidate.pos));
      return {
        candidate,
        amount,
        score: amount / distance,
      };
    })
    .filter((entry) => entry.amount > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate);
}

function isCarrierPickupTarget(
  target: Resource | AnyStoreStructure | Tombstone | Ruin,
  options?: { includeStorage?: boolean },
): target is CarrierPickupTarget {
  if (isDroppedResourceTarget(target)) {
    return true;
  }

  if ((target as Tombstone).deathTime !== undefined) {
    return true;
  }

  if ((target as Ruin).ticksToDecay !== undefined) {
    return true;
  }

  const structureType = (target as Structure).structureType;
  if (options?.includeStorage && structureType === STRUCTURE_STORAGE) {
    return true;
  }

  if (structureType === STRUCTURE_CONTAINER) {
    return true;
  }

  if (structureType === STRUCTURE_LINK) {
    const link = target as StructureLink;
    return isStorageReceiverLink(link) && !isControllerAdjacentLink(link);
  }

  return false;
}

function pickupEnergyForCarrier(creep: Creep, options?: { includeStorage?: boolean }): { picked: boolean; outOfRange: boolean } {
  const desiredAmount = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

  let sourceTarget = getReservedPickupTarget(creep);
  if (sourceTarget && !isCarrierPickupTarget(sourceTarget, options)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (sourceTarget && !reservePickupTarget(creep, sourceTarget, desiredAmount)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (!sourceTarget) {
    const candidates = getWeightedCarrierPickupCandidates(creep, options);
    for (const candidate of candidates) {
      if (reservePickupTarget(creep, candidate, desiredAmount)) {
        sourceTarget = candidate;
        break;
      }
    }
  }

  if (!sourceTarget) {
    return { picked: false, outOfRange: false };
  }

  if (isDroppedResourceTarget(sourceTarget)) {
    const pickupCode = creep.pickup(sourceTarget);
    if (pickupCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
      return { picked: false, outOfRange: true };
    }

    if (pickupCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    return { picked: pickupCode === OK, outOfRange: false };
  }

  if (isTombstonePickupTarget(sourceTarget)) {
    const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
    if (withdrawCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
      return { picked: false, outOfRange: true };
    }

    if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    return { picked: withdrawCode === OK, outOfRange: false };
  }

  const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
  if (withdrawCode === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, sourceTarget);
    return { picked: false, outOfRange: true };
  }

  if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
    releasePickupReservation(creep, sourceTarget.id);
    return { picked: false, outOfRange: false };
  }

  return { picked: withdrawCode === OK, outOfRange: false };
}

function setPostTransferPlan(
  creep: Creep,
  mode: "pickup" | "deliver",
  target: Resource | AnyStoreStructure | Tombstone | Ruin,
): void {
  creep.memory.carrierPlanMode = mode;
  creep.memory.carrierPlanTargetId = target.id;
  creep.memory.carrierPlanTargetKind = isDroppedResourceTarget(target)
    ? "resource"
    : "structure";
}

function clearPostTransferPlan(creep: Creep): void {
  delete creep.memory.carrierPlanMode;
  delete creep.memory.carrierPlanTargetId;
  delete creep.memory.carrierPlanTargetKind;
}

function getPlannedTarget(creep: Creep): Resource | AnyStoreStructure | Tombstone | Ruin | null {
  if (!creep.memory.carrierPlanTargetId || !creep.memory.carrierPlanTargetKind) {
    return null;
  }

  if (creep.memory.carrierPlanTargetKind === "resource") {
    return Game.getObjectById(creep.memory.carrierPlanTargetId as Id<Resource>);
  }

  return Game.getObjectById(creep.memory.carrierPlanTargetId as Id<AnyStoreStructure | Tombstone | Ruin>);
}

function getPlannedDeliveryTarget(creep: Creep): AnyStoreStructure | null {
  if (creep.memory.carrierPlanMode !== "deliver") {
    return null;
  }

  const plannedTarget = getPlannedTarget(creep);
  if (!plannedTarget) {
    clearPostTransferPlan(creep);
    return null;
  }

  if (isDroppedResourceTarget(plannedTarget) || isTombstonePickupTarget(plannedTarget) || (plannedTarget as Ruin).ticksToDecay !== undefined) {
    clearPostTransferPlan(creep);
    return null;
  }

  const structureTarget = plannedTarget as AnyStoreStructure;
  if (structureTarget.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
    clearPostTransferPlan(creep);
    return null;
  }

  return structureTarget;
}

function hasNewerLiveReplacement(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) {
    return false;
  }

  return getTickContextService().getCreepsByConfigName(configName).some(
    (candidate) =>
      candidate.name !== creep.name &&
      candidate.memory.configName === configName &&
      candidate.ticksToLive > creep.ticksToLive,
  );
}

function getSynthesisCarrierTasks(roomName: string): CarrierTask[] {
  return listCarrierTasksByRoom(roomName);
}

function clearSynthesisCarrierTaskPlan(creep: Creep): void {
  delete creep.memory.synthesisCarrierTaskId;
}

function getAssignedSynthesisCarrierTask(creep: Creep): CarrierTask | null {
  const taskId = creep.memory.synthesisCarrierTaskId;
  if (!taskId) {
    return null;
  }

  return getSynthesisCarrierTasks(creep.room.name).find((item) => item.id === taskId) || null;
}

function resolveTaskStructure(id: string): AnyStoreStructure | null {
  return Game.getObjectById(id as Id<AnyStoreStructure>) || null;
}

function isCarrierTaskStepRunnable(step: CarrierTaskStep): boolean {
  const from = resolveTaskStructure(step.fromId);
  const to = resolveTaskStructure(step.toId);
  if (!from || !to) {
    return false;
  }
  if (from.store.getUsedCapacity(step.resource) <= 0) {
    return false;
  }
  if (to.store.getFreeCapacity(step.resource) <= 0) {
    return false;
  }
  return true;
}

function selectPickupStep(task: CarrierTask, creep: Creep): CarrierTaskStep | null {
  const candidates = task.steps
    .filter((step) => isCarrierTaskStepRunnable(step))
    .sort((left, right) => {
      const leftFrom = resolveTaskStructure(left.fromId);
      const rightFrom = resolveTaskStructure(right.fromId);
      const leftRange = leftFrom ? creep.pos.getRangeTo(leftFrom.pos) : 99;
      const rightRange = rightFrom ? creep.pos.getRangeTo(rightFrom.pos) : 99;
      return leftRange - rightRange;
    });
  return candidates.length > 0 ? candidates[0] : null;
}

function selectDeliveryStep(task: CarrierTask, creep: Creep): CarrierTaskStep | null {
  const candidates = task.steps
    .filter((step) => creep.store.getUsedCapacity(step.resource) > 0)
    .filter((step) => {
      const to = resolveTaskStructure(step.toId);
      return !!to && to.store.getFreeCapacity(step.resource) > 0;
    })
    .sort((left, right) => {
      const leftTo = resolveTaskStructure(left.toId);
      const rightTo = resolveTaskStructure(right.toId);
      const leftRange = leftTo ? creep.pos.getRangeTo(leftTo.pos) : 99;
      const rightRange = rightTo ? creep.pos.getRangeTo(rightTo.pos) : 99;
      return leftRange - rightRange;
    });
  return candidates.length > 0 ? candidates[0] : null;
}

function isCarrierTaskRunnable(task: CarrierTask): boolean {
  return task.steps.some((step) => isCarrierTaskStepRunnable(step));
}

function assignSynthesisCarrierTask(creep: Creep): { task: CarrierTask; step: CarrierTaskStep } | null {
  const assigned = getAssignedSynthesisCarrierTask(creep);
  if (assigned) {
    const assignedStep = selectPickupStep(assigned, creep);
    if (assignedStep) {
      return { task: assigned, step: assignedStep };
    }
  }

  const candidates = getSynthesisCarrierTasks(creep.room.name)
    .filter((task) => isCarrierTaskRunnable(task))
    .map((task) => ({
      task,
      step: selectPickupStep(task, creep),
    }))
    .filter((entry): entry is { task: CarrierTask; step: CarrierTaskStep } => !!entry.step)
    .sort((left, right) => {
      if (left.task.priority !== right.task.priority) {
        return right.task.priority - left.task.priority;
      }
      const leftFrom = resolveTaskStructure(left.step.fromId);
      const rightFrom = resolveTaskStructure(right.step.fromId);
      const leftRange = leftFrom ? creep.pos.getRangeTo(leftFrom.pos) : 99;
      const rightRange = rightFrom ? creep.pos.getRangeTo(rightFrom.pos) : 99;
      return leftRange - rightRange;
    });

  if (candidates.length <= 0) {
    clearSynthesisCarrierTaskPlan(creep);
    return null;
  }

  creep.memory.synthesisCarrierTaskId = candidates[0].task.id;
  return candidates[0];
}

function pickupSynthesisCarrierResource(creep: Creep): { picked: boolean; outOfRange: boolean } {
  if (creep.store.getUsedCapacity() > 0) {
    return { picked: false, outOfRange: false };
  }

  const assignment = assignSynthesisCarrierTask(creep);
  if (!assignment) {
    return { picked: false, outOfRange: false };
  }

  const from = resolveTaskStructure(assignment.step.fromId);
  if (!from || from.store.getUsedCapacity(assignment.step.resource) <= 0) {
    clearSynthesisCarrierTaskPlan(creep);
    return { picked: false, outOfRange: false };
  }

  const code = creep.withdraw(from, assignment.step.resource);
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, from);
    return { picked: false, outOfRange: true };
  }
  if (code !== OK) {
    clearSynthesisCarrierTaskPlan(creep);
    return { picked: false, outOfRange: false };
  }

  return {
    picked: creep.store.getUsedCapacity() > 0,
    outOfRange: false,
  };
}

function getFirstNonEnergyResource(creep: Creep): ResourceConstant | null {
  for (const resource of Object.keys(creep.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) {
      continue;
    }
    if (creep.store.getUsedCapacity(resource) > 0) {
      return resource;
    }
  }

  return null;
}

function getSynthesisCleanupDeliveryTarget(creep: Creep, resource: ResourceConstant): AnyStoreStructure | null {
  if (creep.room.terminal && creep.room.terminal.store.getFreeCapacity(resource) > 0) {
    return creep.room.terminal;
  }
  if (creep.room.storage && creep.room.storage.store.getFreeCapacity(resource) > 0) {
    return creep.room.storage;
  }

  return null;
}

function deliverSynthesisCarrierResource(creep: Creep): boolean {
  const resource = getFirstNonEnergyResource(creep);
  if (!resource) {
    clearSynthesisCarrierTaskPlan(creep);
    return false;
  }

  const assigned = getAssignedSynthesisCarrierTask(creep);
  const assignedStep = assigned ? selectDeliveryStep(assigned, creep) : null;
  const assignedTarget = assignedStep ? resolveTaskStructure(assignedStep.toId) : null;
  const target =
    assignedTarget && assignedTarget.store.getFreeCapacity(resource) > 0
      ? assignedTarget
      : getSynthesisCleanupDeliveryTarget(creep, resource);
  if (!target) {
    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  }

  const code = creep.transfer(target, resource);
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, target);
    return true;
  }
  if (code !== OK) {
    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  }

  if (!getFirstNonEnergyResource(creep)) {
    clearSynthesisCarrierTaskPlan(creep);
  }
  return true;
}

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    clearPostTransferPlan(creep);
    const emergencyResponseMode = isEmergencyResponseCarrier(creep);

    if (creep.store.getUsedCapacity() > 0) {
      releasePickupReservation(creep);
      return true;
    }

    const energyDemandTarget = getEnergyStoreTarget(creep, {
      includeTerminal: false,
      includeStorage: false,
    });

    if (energyDemandTarget) {
      delete creep.memory.carrierStorageOnlyMode;

      if (creep.store.getUsedCapacity() === 0 && hasNewerLiveReplacement(creep)) {
        releasePickupReservation(creep);
        clearSynthesisCarrierTaskPlan(creep);
        creep.suicide();
        return false;
      }

      pickupEnergyForCarrier(creep, {
        includeStorage: emergencyResponseMode,
      });
      const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
      if (hasEnergy) {
        releasePickupReservation(creep);
      }
      return hasEnergy;
    }

    const carrierTaskPickup = pickupSynthesisCarrierResource(creep);
    if (carrierTaskPickup.picked || carrierTaskPickup.outOfRange) {
      delete creep.memory.carrierStorageOnlyMode;
      if (carrierTaskPickup.picked) {
        releasePickupReservation(creep);
      }
      return creep.store.getUsedCapacity() > 0;
    }

    if (creep.store.getUsedCapacity() === 0 && hasNewerLiveReplacement(creep)) {
      releasePickupReservation(creep);
      creep.suicide();
      return false;
    }

    creep.memory.carrierStorageOnlyMode = true;

    pickupEnergyForCarrier(creep, {
      includeStorage: emergencyResponseMode,
    });
    const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    if (hasEnergy) {
      releasePickupReservation(creep);
    }

    return hasEnergy;
  },
  target: (creep): boolean => {
    if (deliverSynthesisCarrierResource(creep)) {
      return creep.store.getUsedCapacity() === 0;
    }

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      clearPostTransferPlan(creep);
      return true;
    }

    if (creep.memory.carrierStorageOnlyMode) {
      const storageTarget = creep.room.storage || creep.room.terminal;
      if (!storageTarget) {
        return false;
      }

      const code = creep.transfer(storageTarget, RESOURCE_ENERGY);
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, storageTarget);
        return false;
      }
      if (code !== OK) {
        return false;
      }

      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        delete creep.memory.carrierStorageOnlyMode;
        clearPostTransferPlan(creep);
        return true;
      }

      return false;
    }

    let target = getPlannedDeliveryTarget(creep);
    if (!target) {
      target = getEnergyStoreTarget(creep);
      if (target) {
        setPostTransferPlan(creep, "deliver", target);
      }
    }

    if (!target) {
      clearPostTransferPlan(creep);
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const transferCode = creep.transfer(target, RESOURCE_ENERGY);
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target);
      return false;
    }

    if (transferCode === ERR_FULL || transferCode === ERR_INVALID_TARGET) {
      clearPostTransferPlan(creep);
      return false;
    }

    if (transferCode !== OK) {
      clearPostTransferPlan(creep);
      return false;
    }

    const remainingEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (remainingEnergy > 0) {
      const nextTarget = getEnergyStoreTarget(creep, { excludeIds: [target.id] });
      if (nextTarget) {
        setPostTransferPlan(creep, "deliver", nextTarget);
        moveToTarget(creep, nextTarget);
        return false;
      }
    }

    clearPostTransferPlan(creep);
    delete creep.memory.carrierStorageOnlyMode;

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
