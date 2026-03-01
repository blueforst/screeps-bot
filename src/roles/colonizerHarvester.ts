import { harvesterRole } from "@/roles/harvester";
import { getCurrentColonizationRoute, moveToTargetRoom } from "@/roles/shared";
import type { RoleFactory } from "@/types/system";

export const colonizerHarvesterRole: RoleFactory = (targetRoom?: string, sourceId?: string, encodedRouteRooms?: string) => {
  const baseRole = harvesterRole(sourceId);

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        const activeRoute = getCurrentColonizationRoute(targetRoom, encodedRouteRooms);
        if (!activeRoute) {
          return false;
        }

        moveToTargetRoom(creep, targetRoom, activeRoute, { plainCost: 2, swampCost: 10 });
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (): boolean => false,
  };
};
