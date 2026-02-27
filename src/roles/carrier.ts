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

type CarrierPickupTarget = Resource | StructureContainer | Tombstone;

function getCarrierPickupAmount(target: CarrierPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function isTombstonePickupTarget(target: Resource | AnyStoreStructure | Tombstone): target is Tombstone {
  return (target as Tombstone).deathTime !== undefined;
}

function getWeightedCarrierPickupCandidates(creep: Creep): CarrierPickupTarget[] {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_CONTAINER &&
      (structure as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as StructureContainer[];
  const tombstones = creep.room.find(FIND_TOMBSTONES, {
    filter: (tombstone) => tombstone.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const candidates: CarrierPickupTarget[] = [...dropped, ...containers, ...tombstones];
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

function isCarrierPickupTarget(target: Resource | AnyStoreStructure | Tombstone): target is CarrierPickupTarget {
  if (isDroppedResourceTarget(target)) {
    return true;
  }

  return (target as Structure).structureType === STRUCTURE_CONTAINER || (target as Tombstone).deathTime !== undefined;
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

function setPostTransferPlan(creep: Creep, mode: "pickup" | "deliver", target: Resource | AnyStoreStructure | Tombstone): void {
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

function getPlannedTarget(creep: Creep): Resource | AnyStoreStructure | Tombstone | null {
  if (!creep.memory.carrierPlanTargetId || !creep.memory.carrierPlanTargetKind) {
    return null;
  }

  if (creep.memory.carrierPlanTargetKind === "resource") {
    return Game.getObjectById(creep.memory.carrierPlanTargetId as Id<Resource>);
  }

  return Game.getObjectById(creep.memory.carrierPlanTargetId as Id<AnyStoreStructure | Tombstone>);
}

function precomputePostTransferAction(creep: Creep, currentTarget: AnyStoreStructure): void {
  const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const free = currentTarget.store.getFreeCapacity(RESOURCE_ENERGY);

  if (energy <= free) {
    const pickupTarget = getWeightedCarrierPickupCandidates(creep)[0] || null;
    if (pickupTarget) {
      setPostTransferPlan(creep, "pickup", pickupTarget);
      return;
    }
  } else {
    const nextTarget = getEnergyStoreTarget(creep, { excludeIds: [currentTarget.id] });
    if (nextTarget) {
      setPostTransferPlan(creep, "deliver", nextTarget);
      return;
    }
  }

  clearPostTransferPlan(creep);
}

function hasReplacementQueuedOrSpawning(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) {
    return false;
  }

  const queued = Object.values(Game.spawns).some((spawn) => spawn.memory.spawnList?.includes(configName));
  if (queued) {
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

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && hasReplacementQueuedOrSpawning(creep)) {
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
    const target = getEnergyStoreTarget(creep);
    if (!target) {
      clearPostTransferPlan(creep);
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    if (creep.pos.getRangeTo(target) <= 2) {
      precomputePostTransferAction(creep, target);
    }

    const transferCode = creep.transfer(target, RESOURCE_ENERGY);
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target);
      return false;
    }

    if (transferCode === OK) {
      const plannedTarget = getPlannedTarget(creep);
      if (plannedTarget) {
        moveToTarget(creep, plannedTarget);
      }
      clearPostTransferPlan(creep);
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
