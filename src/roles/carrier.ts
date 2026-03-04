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
import { isStorageReceiverLink } from "@/runtime/linkControl";

type CarrierPickupTarget = Resource | StructureContainer | StructureLink | Tombstone | Ruin;

function getCarrierPickupAmount(target: CarrierPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function isTombstonePickupTarget(target: Resource | AnyStoreStructure | Tombstone | Ruin): target is Tombstone {
  return (target as Tombstone).deathTime !== undefined;
}

function getWeightedCarrierPickupCandidates(creep: Creep): CarrierPickupTarget[] {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const structures = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      (structure.structureType === STRUCTURE_CONTAINER ||
        (structure.structureType === STRUCTURE_LINK && isStorageReceiverLink(structure as StructureLink))) &&
      (structure as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as (StructureContainer | StructureLink)[];
  const tombstones = creep.room.find(FIND_TOMBSTONES, {
    filter: (tombstone) => tombstone.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });
  const ruins = creep.room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const candidates: CarrierPickupTarget[] = [...dropped, ...structures, ...tombstones, ...ruins];
  if (candidates.length === 0) {
    return [];
  }

  return candidates
    .filter((candidate) => getCarrierPickupAmount(candidate) > 0)
    .sort((a, b) => {
      const aDistance = Math.max(1, creep.pos.getRangeTo(a.pos));
      const bDistance = Math.max(1, creep.pos.getRangeTo(b.pos));
      const aScore = getCarrierPickupAmount(a) / aDistance;
      const bScore = getCarrierPickupAmount(b) / bDistance;
      return bScore - aScore;
    });
}

function isCarrierPickupTarget(target: Resource | AnyStoreStructure | Tombstone | Ruin): target is CarrierPickupTarget {
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
  if (structureType === STRUCTURE_CONTAINER) {
    return true;
  }

  if (structureType === STRUCTURE_LINK) {
    return isStorageReceiverLink(target as StructureLink);
  }

  return false;
}

function pickupEnergyForCarrier(creep: Creep): { picked: boolean; outOfRange: boolean } {
  const desiredAmount = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

  let sourceTarget = getReservedPickupTarget(creep);
  if (sourceTarget && !isCarrierPickupTarget(sourceTarget)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (sourceTarget && !reservePickupTarget(creep, sourceTarget, desiredAmount)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (!sourceTarget) {
    const candidates = getWeightedCarrierPickupCandidates(creep);
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

function hasReplacementAliveOrSpawning(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) {
    return false;
  }

  const liveReplacement = Object.values(Game.creeps).some(
    (candidate) => candidate.name !== creep.name && candidate.memory.configName === configName,
  );
  if (liveReplacement) {
    return true;
  }

  const creepMemory = Memory.creeps || {};
  return Object.values(Game.spawns).some((spawn) => {
    if (!spawn.spawning) {
      return false;
    }

    const spawningName = spawn.spawning.name;
    return creepMemory[spawningName]?.configName === configName;
  });
}

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    clearPostTransferPlan(creep);

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && hasReplacementAliveOrSpawning(creep)) {
      releasePickupReservation(creep);
      creep.suicide();
      return false;
    }

    pickupEnergyForCarrier(creep);
    const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    if (hasEnergy) {
      releasePickupReservation(creep);
    }

    return hasEnergy;
  },
  target: (creep): boolean => {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      clearPostTransferPlan(creep);
      return true;
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

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
