import { moveToTarget } from "@/roles/shared";
import { workerRole } from "@/roles/worker";
import type { RoleFactory } from "@/types/system";

export const colonizerWorkerRole: RoleFactory = (targetRoom?: string) => {
  const baseRole = workerRole();

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTarget(creep, new RoomPosition(25, 25, targetRoom));
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTarget(creep, new RoomPosition(25, 25, targetRoom));
        return false;
      }

      return baseRole.target(creep);
    },
  };
};
