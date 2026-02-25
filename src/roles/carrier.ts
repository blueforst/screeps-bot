import type { RoleFactory } from "@/types/system";
import { getEnergyStoreTarget, getPreferredEnergyPickupTarget, isDroppedResourceTarget, moveToTarget } from "@/roles/shared";

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
    const pickupTarget = getPreferredEnergyPickupTarget(creep);
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

    const sourceTarget = getPreferredEnergyPickupTarget(creep);
    if (!sourceTarget) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    }

    if (isDroppedResourceTarget(sourceTarget)) {
      const pickupCode = creep.pickup(sourceTarget);
      if (pickupCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, sourceTarget);
        return false;
      }
      if (pickupCode === OK) {
        return true;
      }
    } else {
      const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
      if (withdrawCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, sourceTarget);
        return false;
      }

      if (withdrawCode === OK) {
        return true;
      }
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
