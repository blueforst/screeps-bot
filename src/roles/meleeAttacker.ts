import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

function getHostileCreeps(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });
}

function getHostileStructures(room: Room): Structure[] {
  return room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });
}

function findTarget(creep: Creep): Creep | Structure | null {
  const hostileCreeps = getHostileCreeps(creep.room);
  if (hostileCreeps.length > 0) {
    const dangerous = hostileCreeps
      .filter((hostile) => hostile.getActiveBodyparts(HEAL) > 0 || hostile.getActiveBodyparts(ATTACK) > 0)
      .sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos));
    if (dangerous.length > 0) {
      return dangerous[0];
    }

    return creep.pos.findClosestByRange(hostileCreeps);
  }

  const hostileStructures = getHostileStructures(creep.room);
  if (hostileStructures.length === 0) {
    return null;
  }

  const preferredOrder: StructureConstant[] = [
    STRUCTURE_TOWER,
    STRUCTURE_SPAWN,
    STRUCTURE_INVADER_CORE,
    STRUCTURE_RAMPART,
    STRUCTURE_WALL,
  ];
  for (const structureType of preferredOrder) {
    const candidates = hostileStructures.filter((structure) => structure.structureType === structureType);
    if (candidates.length > 0) {
      return creep.pos.findClosestByRange(candidates);
    }
  }

  return creep.pos.findClosestByRange(hostileStructures);
}

export const meleeAttackerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
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

    const target = measureCreepDecision(() => findTarget(creep));
    if (!target) {
      if (targetRoom) {
        moveToTarget(creep, new RoomPosition(25, 25, targetRoom), 3, {
          plainCost: 2,
          swampCost: 8,
          reusePath: 5,
          maxRooms: 1,
        });
      }
      return false;
    }

    const code = measureCreepIntent(() => creep.attack(target));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      return false;
    }

    if (code === ERR_INVALID_TARGET && (target as Creep | Structure).id) {
      const fallback = creep.pos.findClosestByRange(getHostileStructures(creep.room));
      if (fallback) {
        const fallbackCode = measureCreepIntent(() => creep.attack(fallback));
        if (fallbackCode === ERR_NOT_IN_RANGE) {
          moveToTarget(creep, fallback, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        }
      }
    }

    return false;
  },
});
