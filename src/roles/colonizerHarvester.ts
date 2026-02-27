import { harvesterRole } from "@/roles/harvester";
import { moveToTarget } from "@/roles/shared";
import type { RoleFactory } from "@/types/system";

export const colonizerHarvesterRole: RoleFactory = (targetRoom?: string, sourceId?: string) => {
  const baseRole = harvesterRole(sourceId);

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTarget(creep, new RoomPosition(25, 25, targetRoom));
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (): boolean => false,
  };
};
