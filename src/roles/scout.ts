import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";

function parseRouteRooms(encoded?: string): string[] {
  if (!encoded) {
    return [];
  }

  return encoded
    .split("|")
    .map((roomName) => roomName.trim())
    .filter((roomName) => roomName.length > 0);
}

function getNextRoom(currentRoom: string, routeRooms: string[], fallbackRoom: string): string {
  if (routeRooms.length === 0) {
    return fallbackRoom;
  }

  const currentIndex = routeRooms.indexOf(currentRoom);
  if (currentIndex >= 0 && currentIndex < routeRooms.length - 1) {
    return routeRooms[currentIndex + 1];
  }

  if (currentIndex === routeRooms.length - 1) {
    return fallbackRoom;
  }

  return routeRooms[0];
}

export const scoutRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (!targetRoom) {
      return false;
    }

    if (creep.room.name === targetRoom) {
      creep.suicide();
      return false;
    }

    const routeRooms = parseRouteRooms(encodedRouteRooms);
    const nextRoom = getNextRoom(creep.room.name, routeRooms, targetRoom);
    moveToTarget(creep, new RoomPosition(25, 25, nextRoom), 1, { swampCost: 8 });
    return false;
  },
  target: (): boolean => false,
});
