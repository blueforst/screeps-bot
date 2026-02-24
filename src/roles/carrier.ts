import type { RoleFactory } from "@/types/system";
import { getEnergySourceTarget, getEnergyStoreTarget, moveToTarget } from "@/roles/shared";

function isSource(target: AnyStoreStructure | Source): target is Source {
  return (target as Source).ticksToRegeneration !== undefined;
}

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
    });

    if (dropped && creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, dropped);
      return false;
    }

    const sourceTarget = getEnergySourceTarget(creep);
    if (!sourceTarget) {
      return false;
    }

    if (isSource(sourceTarget)) {
      const harvestCode = creep.harvest(sourceTarget);
      if (harvestCode === ERR_NOT_IN_RANGE) {
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
