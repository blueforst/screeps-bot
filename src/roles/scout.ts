import type { RoleFactory } from "@/types/system";
import { getCurrentScoutRoute, moveToTargetRoom } from "@/roles/shared";

function recordVisitedRoom(creep: Creep): void {
  const route = creep.memory.scoutVisitedRooms || [];
  const roomName = creep.room.name;

  if (route.length === 0) {
    route.push(roomName);
    creep.memory.scoutVisitedRooms = route;
    return;
  }

  const lastRoom = route[route.length - 1];
  if (lastRoom === roomName) {
    creep.memory.scoutVisitedRooms = route;
    return;
  }

  const existingIndex = route.lastIndexOf(roomName);
  if (existingIndex >= 0) {
    route.splice(existingIndex + 1);
  } else {
    route.push(roomName);
  }

  creep.memory.scoutVisitedRooms = route;
}

export const scoutRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (!targetRoom) {
      return false;
    }

    recordVisitedRoom(creep);

    if (creep.room.name === targetRoom) {
      creep.suicide();
      return false;
    }

    const activeRoute = getCurrentScoutRoute(targetRoom, encodedRouteRooms);
    moveToTargetRoom(creep, targetRoom, activeRoute || undefined, { plainCost: 2, swampCost: 10, reusePath: 5 });

    return false;
  },
  target: (): boolean => false,
});
