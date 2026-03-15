import type { RoleFactory } from "@/types/system";

export const flagScoutRole: RoleFactory = (targetRoom?: string, x?: string, y?: string) => ({
  target: (creep): boolean => {
    if (!targetRoom || x === undefined || y === undefined) return false;

    const targetPos = new RoomPosition(Number(x), Number(y), targetRoom);

    if (creep.pos.isEqualTo(targetPos)) return false;

    creep.moveTo(targetPos, { reusePath: 10, maxRooms: 8 });
    return false;
  },
});
