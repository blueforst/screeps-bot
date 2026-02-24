import type { RoleFactory } from "@/types/system";
import { getEnergyStoreTarget, getPreferredEnergyPickupTarget, isDroppedResourceTarget, moveToTarget } from "@/roles/shared";

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
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
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const transferCode = creep.transfer(target, RESOURCE_ENERGY);
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target);
      return false;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
