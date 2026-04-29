import { harvesterRole } from "@/roles/harvester";
import { moveToTargetRoom } from "@/roles/shared";
import type { RoleFactory } from "@/types/system";

export const colonizerHarvesterRole: RoleFactory = (targetRoom?: string, sourceId?: string, encodedRouteRooms?: string) => {
  const baseRole = harvesterRole(sourceId);

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (): boolean => false,
  };
};
