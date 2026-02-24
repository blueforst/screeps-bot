import type { RoleFactory } from "@/types/system";
import { getDroppedEnergyTarget, getWithdrawEnergyTarget, moveToTarget } from "@/roles/shared";

export const upgraderRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const dropped = getDroppedEnergyTarget(creep);
    if (dropped) {
      const pickupCode = creep.pickup(dropped);
      if (pickupCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, dropped);
      }
      return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
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
    const controller = creep.room.controller;
    if (!controller) {
      return true;
    }

    const code = creep.upgradeController(controller);
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller, { squareSize: 7 });
      return false;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
