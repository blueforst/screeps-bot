import type { RoleFactory } from "@/types/system";
import { getEnergySourceTarget, moveToTarget } from "@/roles/shared";

function isSource(target: AnyStoreStructure | Source): target is Source {
  return (target as Source).ticksToRegeneration !== undefined;
}

export const builderRole: RoleFactory = () => ({
  source: (creep): boolean => {
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
    const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
    if (site) {
      const buildCode = creep.build(site);
      if (buildCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, site);
      }
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const controller = creep.room.controller;
    if (controller) {
      const upgradeCode = creep.upgradeController(controller);
      if (upgradeCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, controller);
      }
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
