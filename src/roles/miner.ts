import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";
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

    const harvestCode = creep.harvest(source);
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

    const transferCode = creep.transfer(link, RESOURCE_ENERGY);
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, link);
      return false;
    }

    if (transferCode === OK) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    if (transferCode === ERR_FULL) {
      return false;
    }

    return false;
  },
});
