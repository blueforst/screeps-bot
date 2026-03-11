import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

function getEscortTarget(creep: Creep, targetRoom?: string): Creep | null {
  const friendlies = creep.room.find(FIND_MY_CREEPS, {
    filter: (ally) => ally.name !== creep.name && ally.memory.role === "meleeAttacker",
  });
  if (friendlies.length === 0) {
    return null;
  }

  const inTargetRoom = targetRoom ? friendlies.filter((ally) => ally.room.name === targetRoom) : friendlies;
  if (inTargetRoom.length > 0) {
    const damaged = inTargetRoom.filter((ally) => ally.hits < ally.hitsMax);
    if (damaged.length > 0) {
      return creep.pos.findClosestByRange(damaged);
    }

    return creep.pos.findClosestByRange(inTargetRoom);
  }

  return creep.pos.findClosestByRange(friendlies);
}

export const healerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 8 });
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 8 });
      return false;
    }

    const escortTarget = measureCreepDecision(() => getEscortTarget(creep, targetRoom));
    if (escortTarget) {
      if (escortTarget.hits < escortTarget.hitsMax) {
        const healCode = measureCreepIntent(() => creep.heal(escortTarget));
        if (healCode === ERR_NOT_IN_RANGE) {
          measureCreepIntent(() => creep.rangedHeal(escortTarget));
          moveToTarget(creep, escortTarget, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        }
      } else if (!creep.pos.isNearTo(escortTarget)) {
        moveToTarget(creep, escortTarget, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      }
    }

    if (creep.hits < creep.hitsMax) {
      measureCreepIntent(() => creep.heal(creep));
    }

    return false;
  },
});
