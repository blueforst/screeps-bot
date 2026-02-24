import type { RoleFactory } from "@/types/system";
import { getEnergyStoreTarget, getWithdrawEnergyTarget, moveToTarget } from "@/roles/shared";

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
    });

    if (dropped) {
      const pickupCode = creep.pickup(dropped);
      if (pickupCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, dropped);
      }
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        return true;
      }
    }

    const sourceTarget = getWithdrawEnergyTarget(creep);
    if (!sourceTarget) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    }

    const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
    if (withdrawCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
      return false;
    }

    if (withdrawCode === OK) {
      return true;
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
