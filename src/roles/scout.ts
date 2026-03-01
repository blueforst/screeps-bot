import type { RoleFactory } from "@/types/system";
import { moveToTargetRoom } from "@/roles/shared";

export const scoutRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (!targetRoom) {
      return false;
    }

    if (creep.room.name === targetRoom) {
      creep.suicide();
      return false;
    }

    moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10, reusePath: 3 });
    return false;
  },
  target: (): boolean => false,
});
