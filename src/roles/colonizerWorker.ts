import { moveToTargetRoom } from "@/roles/shared";
import { workerRole } from "@/roles/worker";
import type { RoleFactory } from "@/types/system";

export const colonizerWorkerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => {
  const baseRole = workerRole();

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
        return false;
      }

      return baseRole.target(creep);
    },
  };
};
