import type { RoleFactory } from "@/types/system";
import { getPreferredEnergyPickupTarget, isDroppedResourceTarget, moveToRemoteWorkTarget, moveToTarget } from "@/roles/shared";

export const workerRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const sourceTarget = getPreferredEnergyPickupTarget(creep);
    if (!sourceTarget) {
      return false;
    }

    if (isDroppedResourceTarget(sourceTarget)) {
      const pickupCode = creep.pickup(sourceTarget);
      if (pickupCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, sourceTarget);
      }
    } else {
      const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
      if (withdrawCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, sourceTarget);
      }
    }

    return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
  },
  target: (creep): boolean => {
    const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
    if (site) {
      const buildCode = creep.build(site);
      if (buildCode === ERR_NOT_IN_RANGE) {
        moveToRemoteWorkTarget(creep, site);
      }
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const controller = creep.room.controller;
    if (!controller) {
      return true;
    }

    const upgradeCode = creep.upgradeController(controller);
    if (upgradeCode === ERR_NOT_IN_RANGE) {
      moveToRemoteWorkTarget(creep, controller);
      return false;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
