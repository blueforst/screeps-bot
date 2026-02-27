import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";

export const claimerRole: RoleFactory = (targetRoom?: string) => ({
  source: (creep): boolean => {
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTarget(creep, new RoomPosition(25, 25, targetRoom));
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    const controller = creep.room.controller;
    if (!controller) {
      return false;
    }

    if (controller.my) {
      return false;
    }

    const code = creep.claimController(controller);
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller);
    }

    return false;
  },
});
