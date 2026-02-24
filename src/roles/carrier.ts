import type { RoleFactory } from "@/types/system";
import { getEnergyStoreTarget, getWithdrawEnergyTarget, moveToTarget } from "@/roles/shared";

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
    });

    if (dropped && creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, dropped);
      return false;
    }

    const sourceTarget = getWithdrawEnergyTarget(creep);
    if (!sourceTarget) {
      return false;
    }

    const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
    if (withdrawCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
    }

    return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
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
