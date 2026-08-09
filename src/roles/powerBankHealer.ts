import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import {
  getPowerBankAvoidRooms,
  getPowerBankEncodedRouteBetween,
  getPowerBankNextRouteRoom,
  getPowerBankTaskForCreep,
  pairReadyForTravel,
  resolvePowerBankPair,
  type PowerBankPairContext,
} from "@/roles/powerBankCombatPair";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
  "failed",
  "aborted",
]);

function retireIfOrphanedPowerBankCreep(creep: Creep): boolean {
  if (!creep.memory.configName?.includes(":powerbank:")) return false;
  creep.suicide();
  return true;
}

function canHeal(creep: Creep): boolean {
  return creep.getActiveBodyparts(HEAL) > 0;
}

function healPairedAttacker(creep: Creep, attacker: Creep): { sameRoom: boolean; range: number } {
  const sameRoom = attacker.room.name === creep.room.name;
  const range = sameRoom ? creep.pos.getRangeTo(attacker.pos) : Infinity;

  if (canHeal(creep) && sameRoom) {
    if (range <= 1) {
      measureCreepIntent(() => creep.heal(attacker));
    } else if (range <= 3) {
      measureCreepIntent(() => creep.rangedHeal(attacker));
    }
  }

  if (canHeal(creep) && creep.hits < creep.hitsMax && (!sameRoom || range > 3)) {
    measureCreepIntent(() => creep.heal(creep));
  }

  return { sameRoom, range };
}

function getExitMoveDirection(room: Room, targetRoom: string): DirectionConstant | null {
  const exitDirection = typeof room.findExitTo === "function" ? room.findExitTo(targetRoom) : ERR_NO_PATH;
  switch (exitDirection) {
    case FIND_EXIT_TOP:
      return TOP;
    case FIND_EXIT_RIGHT:
      return RIGHT;
    case FIND_EXIT_BOTTOM:
      return BOTTOM;
    case FIND_EXIT_LEFT:
      return LEFT;
    default:
      return null;
  }
}

function isHealerAheadOfAttacker(healer: Creep, attacker: Creep, nextRoom: string): boolean {
  if (healer.room.name !== attacker.room.name) return false;
  const direction = getExitMoveDirection(attacker.room, nextRoom);
  if (!direction) return false;

  switch (direction) {
    case TOP:
      return healer.pos.y < attacker.pos.y;
    case RIGHT:
      return healer.pos.x > attacker.pos.x;
    case BOTTOM:
      return healer.pos.y > attacker.pos.y;
    case LEFT:
      return healer.pos.x < attacker.pos.x;
    default:
      return false;
  }
}

function isWalkableSideStep(creep: Creep, direction: DirectionConstant): boolean {
  const offsets: Record<DirectionConstant, { x: number; y: number }> = {
    [TOP]: { x: 0, y: -1 },
    [TOP_RIGHT]: { x: 1, y: -1 },
    [RIGHT]: { x: 1, y: 0 },
    [BOTTOM_RIGHT]: { x: 1, y: 1 },
    [BOTTOM]: { x: 0, y: 1 },
    [BOTTOM_LEFT]: { x: -1, y: 1 },
    [LEFT]: { x: -1, y: 0 },
    [TOP_LEFT]: { x: -1, y: -1 },
  };
  const offset = offsets[direction];
  const pos = { x: creep.pos.x + offset.x, y: creep.pos.y + offset.y, roomName: creep.pos.roomName };
  if (pos.x < 1 || pos.x > 48 || pos.y < 1 || pos.y > 48) return false;

  const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
  if (terrain === TERRAIN_MASK_WALL) return false;

  if (typeof creep.room.lookForAt === "function") {
    const structures = creep.room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    if (structures.some((structure) =>
      structure.structureType !== STRUCTURE_ROAD &&
      structure.structureType !== STRUCTURE_CONTAINER &&
      structure.structureType !== STRUCTURE_PORTAL &&
      !(structure.structureType === STRUCTURE_RAMPART && ((structure as StructureRampart).my || (structure as StructureRampart).isPublic))
    )) return false;

    const creeps = creep.room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (creeps.length > 0) return false;
  }

  return true;
}

function sidestepOutOfAttackerLane(creep: Creep, attacker: Creep, nextRoom: string): boolean {
  if (!isHealerAheadOfAttacker(creep, attacker, nextRoom)) return false;
  const exitDirection = getExitMoveDirection(attacker.room, nextRoom);
  if (!exitDirection) return false;

  const sidesteps: DirectionConstant[] = exitDirection === LEFT || exitDirection === RIGHT
    ? [TOP, BOTTOM, exitDirection === LEFT ? RIGHT : LEFT]
    : [LEFT, RIGHT, exitDirection === TOP ? BOTTOM : TOP];
  const direction = sidesteps.find((candidate) => isWalkableSideStep(creep, candidate));
  if (!direction) return false;

  // Tactical directional move — not destination pathfinding.
  measureCreepIntent(() => creep.move(direction));
  return true;
}

/** The healer is the follower; it rejoins the leader instead of routing ahead. */
function followAttacker(creep: Creep, pair: PowerBankPairContext, fallbackEncodedRoute?: string): void {
  if (!pairReadyForTravel(pair)) return;

  const attacker = pair.attacker;
  const { sameRoom, range } = healPairedAttacker(creep, attacker);
  if (!sameRoom) {
    moveToTargetRoom(
      creep,
      attacker.room.name,
      getPowerBankEncodedRouteBetween(pair.task, creep.room.name, attacker.room.name, fallbackEncodedRoute),
      { ...TRAVEL_OPTIONS, avoidRooms: getPowerBankAvoidRooms(pair.task) },
    );
    return;
  }

  const nextRoom = getPowerBankNextRouteRoom(pair.task, attacker.room.name);
  if (attacker.room.name !== pair.task.targetRoom && sidestepOutOfAttackerLane(creep, attacker, nextRoom)) return;
  if (range > 1) {
    moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
  }
}

function supportAttacker(creep: Creep, pair: PowerBankPairContext, fallbackEncodedRoute?: string): void {
  const attacker = pair.attacker;
  const { sameRoom, range } = healPairedAttacker(creep, attacker);
  if (!sameRoom) {
    moveToTargetRoom(
      creep,
      attacker.room.name,
      getPowerBankEncodedRouteBetween(pair.task, creep.room.name, attacker.room.name, fallbackEncodedRoute),
      { ...TRAVEL_OPTIONS, avoidRooms: getPowerBankAvoidRooms(pair.task) },
    );
    return;
  }
  if (range > 1) {
    moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
  }
}

function selfHealIfPossible(creep: Creep): void {
  if (canHeal(creep) && creep.hits < creep.hitsMax) {
    measureCreepIntent(() => creep.heal(creep));
  }
}

export const powerBankHealerRole: RoleFactory = (_targetRoomArg?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) {
      selfHealIfPossible(creep);
      return false;
    }

    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== task.targetRoom)) {
      followAttacker(creep, pair, encodedRouteRooms);
      return false;
    }

    return pair.stage === "attacking";
  },

  target: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) {
      selfHealIfPossible(creep);
      return false;
    }

    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== task.targetRoom)) {
      followAttacker(creep, pair, encodedRouteRooms);
      return false;
    }
    if (pair.stage !== "attacking") return false;

    supportAttacker(creep, pair, encodedRouteRooms);
    return false;
  },
});
