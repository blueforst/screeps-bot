import type { RoleFactory } from "@/types/system";
import { getEnergySourceTarget, moveToTarget } from "@/roles/shared";

function isSource(target: AnyStoreStructure | Source): target is Source {
  return (target as Source).ticksToRegeneration !== undefined;
}

export const upgraderRole: RoleFactory = () => ({
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
    const controller = creep.room.controller;
    if (!controller) {
      return true;
    }

    const code = creep.upgradeController(controller);
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller);
      return false;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
