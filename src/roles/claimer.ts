import type { RoleFactory } from "@/types/system";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";

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

    const code = measureCreepIntent(() => creep.claimController(controller));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
      return false;
    }

    if (code === ERR_INVALID_TARGET && controller.reservation && !controller.my) {
      const attackCode = measureCreepIntent(() => creep.attackController(controller));
      if (attackCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
      }
    }

    return false;
  },
});
