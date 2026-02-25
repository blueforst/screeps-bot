import type { RoleFactory } from "@/types/system";
import {
  getEnergyStoreTarget,
  isDroppedResourceTarget,
  moveToTarget,
} from "@/roles/shared";

type CarrierPickupTarget = Resource | StructureContainer;

function getCarrierPickupAmount(target: CarrierPickupTarget): number {
  if (isDroppedResourceTarget(target)) {
    return target.amount;
  }

  return target.store.getUsedCapacity(RESOURCE_ENERGY);
}

function getWeightedCarrierPickupTarget(creep: Creep): CarrierPickupTarget | null {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_CONTAINER &&
      (structure as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as StructureContainer[];

  const candidates: CarrierPickupTarget[] = [...dropped, ...containers];
  if (candidates.length === 0) {
    return null;
  }

  let bestTarget: CarrierPickupTarget | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const amount = getCarrierPickupAmount(candidate);
    if (amount <= 0) {
      continue;
    }

    const distance = Math.max(1, creep.pos.getRangeTo(candidate.pos));
    const score = amount / distance;
    if (score > bestScore) {
      bestScore = score;
      bestTarget = candidate;
    }
  }

  return bestTarget;
}

function pickupEnergyForCarrier(creep: Creep): { picked: boolean; outOfRange: boolean } {
  const sourceTarget = getWeightedCarrierPickupTarget(creep);
  if (!sourceTarget) {
    return { picked: false, outOfRange: false };
  }

  if (isDroppedResourceTarget(sourceTarget)) {
    const pickupCode = creep.pickup(sourceTarget);
    if (pickupCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
      return { picked: false, outOfRange: true };
    }

    return { picked: pickupCode === OK, outOfRange: false };
  }

  const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
  if (withdrawCode === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, sourceTarget);
    return { picked: false, outOfRange: true };
  }

  return { picked: withdrawCode === OK, outOfRange: false };
}

function setPostTransferPlan(creep: Creep, mode: "pickup" | "deliver", target: Resource | AnyStoreStructure): void {
  creep.memory.carrierPlanMode = mode;
  creep.memory.carrierPlanTargetId = target.id;
  creep.memory.carrierPlanTargetKind = isDroppedResourceTarget(target as Resource | AnyStoreStructure)
    ? "resource"
    : "structure";
}

function clearPostTransferPlan(creep: Creep): void {
  delete creep.memory.carrierPlanMode;
  delete creep.memory.carrierPlanTargetId;
  delete creep.memory.carrierPlanTargetKind;
}

function getPlannedTarget(creep: Creep): Resource | AnyStoreStructure | null {
  if (!creep.memory.carrierPlanTargetId || !creep.memory.carrierPlanTargetKind) {
    return null;
  }

  if (creep.memory.carrierPlanTargetKind === "resource") {
    return Game.getObjectById(creep.memory.carrierPlanTargetId as Id<Resource>);
  }

  return Game.getObjectById(creep.memory.carrierPlanTargetId as Id<AnyStoreStructure>);
}

function precomputePostTransferAction(creep: Creep, currentTarget: AnyStoreStructure): void {
  const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const free = currentTarget.store.getFreeCapacity(RESOURCE_ENERGY);

  if (energy <= free) {
    const pickupTarget = getWeightedCarrierPickupTarget(creep);
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

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    clearPostTransferPlan(creep);

    const result = pickupEnergyForCarrier(creep);
    if (!result.picked && !result.outOfRange) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
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
