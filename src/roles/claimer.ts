import type { RoleFactory } from "@/types/system";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

export const claimerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
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
