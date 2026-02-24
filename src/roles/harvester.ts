import type { RoleFactory } from "@/types/system";
import { getEnergyStoreTarget, moveToTarget } from "@/roles/shared";

export const harvesterRole: RoleFactory = (sourceId?: string) => ({
  source: (creep): boolean => {
    const source = sourceId ? Game.getObjectById(sourceId as Id<Source>) : creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (!source) {
      return true;
    }

    const harvestCode = creep.harvest(source);
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source);
      return false;
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
