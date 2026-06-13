import type { RoleFactory } from "@/types/system";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

export const flagScoutRole: RoleFactory = (targetRoom?: string, x?: string, y?: string) => ({
  target: (creep): boolean => {
    if (!targetRoom || x === undefined || y === undefined) return false;

    const targetPos = new RoomPosition(Number(x), Number(y), targetRoom);

    if (creep.pos.isEqualTo(targetPos)) return false;

    if (creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, undefined, { reusePath: 10, maxRooms: 8 });
    } else {
      moveToTarget(creep, targetPos, 0, { reusePath: 10 });
    }

    return false;
  },
});
