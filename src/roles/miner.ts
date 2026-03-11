import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getSourceAdjacentLink } from "@/runtime/sourceLink";

function getSource(sourceId?: string): Source | null {
  if (!sourceId) {
    return null;
  }

  return Game.getObjectById(sourceId as Id<Source>);
}

export const minerRole: RoleFactory = (sourceId?: string) => ({
  source: (creep): boolean => {
    const source = getSource(sourceId);
    if (!source) {
      return false;
    }

    const harvestCode = measureCreepIntent(() => creep.harvest(source));
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source);
    }

    return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
  },
  target: (creep): boolean => {
    const source = getSource(sourceId);
    if (!source) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const link = getSourceAdjacentLink(source);
    if (!link) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (usedEnergy <= 0) {
      return true;
    }

    const capacity = creep.store.getCapacity(RESOURCE_ENERGY);
    if (capacity > 0 && usedEnergy < capacity) {
      return true;
    }

    const linkFreeCapacity = link.store.getFreeCapacity(RESOURCE_ENERGY);
    if (linkFreeCapacity <= 0) {
      return false;
    }

    const transferCode = measureCreepIntent(() => creep.transfer(link, RESOURCE_ENERGY));
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, link);
      return false;
    }

    if (transferCode === OK) {
      return true;
    }

    if (transferCode === ERR_FULL) {
      return false;
    }

    return false;
  },
});
