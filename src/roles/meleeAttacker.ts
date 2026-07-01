import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;

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

function isBreachTarget(structure: Structure): structure is StructureRampart | StructureWall {
  if (structure.structureType === STRUCTURE_WALL) return true;
  return structure.structureType === STRUCTURE_RAMPART;
}

function findAdjacentBreachTarget(creep: Creep, target: Creep | Structure): StructureRampart | StructureWall | null {
  const blockers = creep.pos.findInRange(FIND_STRUCTURES, 1, { filter: isBreachTarget });
  if (blockers.length === 0) return null;

  return blockers.sort((left, right) => {
    const leftRange = left.pos.getRangeTo(target.pos);
    const rightRange = right.pos.getRangeTo(target.pos);
    if (leftRange !== rightRange) return leftRange - rightRange;

    return left.hits - right.hits;
  })[0];
}

function attackAdjacentBreachTarget(creep: Creep, target: Creep | Structure): boolean {
  const blocker = findAdjacentBreachTarget(creep, target);
  if (!blocker) return false;

  measureCreepIntent(() => creep.attack(blocker));
  return true;
}

function findPairedWarHealer(creep: Creep): Creep | null {
  const configName = creep.memory.configName;
  if (!configName?.includes(":war:")) return null;

  const healerConfigName = configName.replace(":meleeAttacker:", ":healer:");
  if (healerConfigName === configName) return null;

  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "healer") continue;
    if (candidate.memory.configName !== healerConfigName) continue;
    return candidate;
  }

  return null;
}

function expectsWarHealer(creep: Creep): boolean {
  return creep.memory.configName?.includes(":war:") === true && creep.memory.configName.includes(":meleeAttacker:");
}

function isOnExitDirection(pos: RoomPosition, direction: DirectionConstant): boolean {
  if (direction === TOP) return pos.y <= 0;
  if (direction === RIGHT) return pos.x >= 49;
  if (direction === BOTTOM) return pos.y >= 49;
  if (direction === LEFT) return pos.x <= 0;
  return false;
}

function moveOffExitIntoRoom(creep: Creep): boolean {
  if (creep.pos.x <= 0) {
    measureCreepIntent(() => creep.move(RIGHT));
    return true;
  }
  if (creep.pos.x >= 49) {
    measureCreepIntent(() => creep.move(LEFT));
    return true;
  }
  if (creep.pos.y <= 0) {
    measureCreepIntent(() => creep.move(BOTTOM));
    return true;
  }
  if (creep.pos.y >= 49) {
    measureCreepIntent(() => creep.move(TOP));
    return true;
  }

  return false;
}

function moveToPartnerRoom(creep: Creep, roomName: string): void {
  const exitDirection = creep.room.findExitTo?.(roomName);
  if (
    typeof exitDirection === "number" &&
    exitDirection >= TOP &&
    exitDirection <= LEFT &&
    isOnExitDirection(creep.pos, exitDirection as DirectionConstant)
  ) {
    measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
    return;
  }

  moveToTargetRoom(creep, roomName, undefined, TRAVEL_OPTIONS);
}

function isReadyToCrossWithHealer(creep: Creep, healer: Creep, targetRoom: string): boolean {
  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return true;
  if (!isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) return true;

  return isOnExitDirection(healer.pos, exitDirection as DirectionConstant);
}

function moveAcrossExitToTargetRoom(creep: Creep, targetRoom: string): boolean {
  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return false;
  if (!isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) return false;

  measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
  return true;
}

function waitForWarHealerFormation(creep: Creep, targetRoom: string): boolean {
  if (!expectsWarHealer(creep)) return false;

  const healer = findPairedWarHealer(creep);
  if (!healer) return true;

  if (creep.room.name === targetRoom) {
    if (healer.room.name !== creep.room.name) {
      moveToPartnerRoom(creep, healer.room.name);
      return true;
    }

    return !creep.pos.isNearTo(healer.pos);
  }

  if (healer.room.name !== creep.room.name) {
    if (healer.room.name === targetRoom && moveAcrossExitToTargetRoom(creep, targetRoom)) return true;
    moveOffExitIntoRoom(creep);
    return true;
  }

  if (!creep.pos.isNearTo(healer.pos)) return true;
  return !isReadyToCrossWithHealer(creep, healer, targetRoom);
}

export const meleeAttackerRole: RoleFactory = (
  targetRoom?: string,
  encodedRouteRooms?: string,
  boostTaskId?: string,
  encodedBoostCompounds?: string,
) => ({
  prepare: (creep): boolean => prepareCombatBoost(creep, boostTaskId, encodedBoostCompounds),
  source: (creep): boolean => {
    if (targetRoom && waitForWarHealerFormation(creep, targetRoom)) return false;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (targetRoom && waitForWarHealerFormation(creep, targetRoom)) return false;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
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
      const moveCode = moveToTarget(creep, target, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      if (moveCode === ERR_NO_PATH && creep.room.name === target.pos.roomName) {
        attackAdjacentBreachTarget(creep, target);
      }
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
