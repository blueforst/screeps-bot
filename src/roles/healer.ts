import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import {
  findWarObjectiveTarget,
  isWarCounterstrikeCoordinationValid,
  shouldWarHealerHoldForCounterstrike,
} from "@/roles/meleeAttacker";
import { moveOffExit } from "@/movement/traffic";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;
const TARGET_ROOM_MOVE_OPTIONS = {
  plainCost: 2,
  swampCost: 8,
  reusePath: 0,
  maxRooms: 1,
  avoidExitTiles: true,
  ignoreCreeps: false,
} as const;

function findPairedWarAttacker(creep: Creep): Creep | null {
  const configName = creep.memory.configName;
  if (!configName?.includes(":war:")) return null;

  const attackerConfigName = configName.replace(":healer:", ":meleeAttacker:");
  if (attackerConfigName === configName) return null;

  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "meleeAttacker") continue;
    if (candidate.memory.configName !== attackerConfigName) continue;
    return candidate;
  }

  return null;
}

function expectsWarAttacker(creep: Creep): boolean {
  return creep.memory._warDetached !== true
    && creep.memory.configName?.includes(":war:") === true
    && creep.memory.configName.includes(":healer:");
}

function isOnExitDirection(pos: RoomPosition, direction: DirectionConstant): boolean {
  if (direction === TOP) return pos.y <= 0;
  if (direction === RIGHT) return pos.x >= 49;
  if (direction === BOTTOM) return pos.y >= 49;
  if (direction === LEFT) return pos.x <= 0;
  return false;
}

function isOnRoomExit(pos: RoomPosition): boolean {
  return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function moveOffExitIntoRoom(creep: Creep): boolean {
  if (!isOnRoomExit(creep.pos)) return false;
  moveOffExit(creep);
  return true;
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

function isPoisedToCrossInto(creep: Creep, targetRoom: string): boolean {
  if (creep.room.name === targetRoom) return false;

  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return false;

  return isOnExitDirection(creep.pos, exitDirection as DirectionConstant);
}

function getValidExitDirection(room: Room, targetRoom: string): DirectionConstant | null {
  const exitDirection = room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return null;

  return exitDirection as DirectionConstant;
}

function shouldHoldForAttackerAtExit(creep: Creep, attacker: Creep, targetRoom: string): boolean {
  const exitDirection = getValidExitDirection(creep.room, targetRoom);
  if (!exitDirection) return false;

  return isOnExitDirection(creep.pos, exitDirection) && !isOnExitDirection(attacker.pos, exitDirection);
}

function healAttacker(creep: Creep, attacker: Creep): void {
  const shouldHealSelf =
    creep.hits < creep.hitsMax &&
    (attacker.room.name !== creep.room.name ||
      attacker.hits >= attacker.hitsMax ||
      creep.hits * attacker.hitsMax <= attacker.hits * creep.hitsMax);
  if (shouldHealSelf) {
    measureCreepIntent(() => creep.heal(creep));
    return;
  }

  if (attacker.room.name !== creep.room.name) {
    return;
  }

  const range = creep.pos.getRangeTo(attacker.pos);
  if (range <= 1) {
    measureCreepIntent(() => creep.heal(attacker));
  } else if (range <= 3) {
    measureCreepIntent(() => creep.rangedHeal(attacker));
  }
}

function coordinateCounterstrike(creep: Creep, attacker: Creep): boolean {
  const state = attacker.memory._warCounterstrike;
  if (!state?.healerCoordinated) return false;
  const elapsed = Game.time - state.createdAt;
  if (elapsed < 0 || elapsed > 2) return false;
  if (!isWarCounterstrikeCoordinationValid(attacker, creep, state)) {
    delete attacker.memory._warCounterstrike;
    return false;
  }
  if (elapsed === 0) return true;
  if (elapsed === 1) {
    state.healerReadyAt = Game.time;
    return true;
  }
  if (state.healerReadyAt !== state.createdAt + 1) {
    delete attacker.memory._warCounterstrike;
    return false;
  }
  if (!state.healerSwap) return true;

  const direction = creep.pos.getDirectionTo(attacker.pos);
  if (!direction) return false;
  clearMovementState(creep);
  measureCreepIntent(() => creep.move(direction));
  return true;
}

function getSharedWarBreachTarget(attacker: Creep): StructureRampart | StructureWall | null {
  const targetId = attacker.memory._warBreachTargetId;
  if (!targetId) return null;

  const target = Game.getObjectById(targetId);
  if (
    !target ||
    target.pos.roomName !== attacker.room.name ||
    (target.structureType !== STRUCTURE_WALL && target.structureType !== STRUCTURE_RAMPART)
  ) {
    delete attacker.memory._warBreachTargetId;
    return null;
  }
  return target;
}

function moveWithWarAttackerFormation(creep: Creep, targetRoom: string, encodedRouteRooms?: string): boolean {
  if (!expectsWarAttacker(creep)) return false;

  const attacker = findPairedWarAttacker(creep);
  if (!attacker) return true;

  healAttacker(creep, attacker);
  if (coordinateCounterstrike(creep, attacker)) return true;
  if (shouldWarHealerHoldForCounterstrike(attacker, creep, targetRoom)) return true;

  if (creep.room.name === targetRoom && attacker.room.name !== targetRoom) {
    if (isPoisedToCrossInto(attacker, targetRoom)) {
      moveOffExitIntoRoom(creep);
      return true;
    }
    moveToPartnerRoom(creep, attacker.room.name);
    return true;
  }

  if (creep.room.name === targetRoom && attacker.room.name === targetRoom && isOnRoomExit(creep.pos)) {
    moveOffExit(creep);
    return true;
  }

  if (attacker.room.name !== creep.room.name) {
    moveToPartnerRoom(creep, attacker.room.name);
    return true;
  }

  if (!creep.pos.isNearTo(attacker.pos)) {
    moveToTarget(creep, attacker, 1, TARGET_ROOM_MOVE_OPTIONS);
    return true;
  }

  if (creep.room.name !== targetRoom) {
    if (shouldHoldForAttackerAtExit(creep, attacker, targetRoom)) return true;
    moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
    return true;
  }

  const combatTarget = getSharedWarBreachTarget(attacker) || findWarObjectiveTarget(attacker);
  if (combatTarget) {
    moveToTarget(creep, combatTarget, 2, TARGET_ROOM_MOVE_OPTIONS);
  }

  return true;
}

function getEscortTarget(creep: Creep, targetRoom?: string): Creep | null {
  const pairedAttacker = findPairedWarAttacker(creep);
  if (pairedAttacker && (!targetRoom || pairedAttacker.room.name === targetRoom)) {
    return pairedAttacker;
  }

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

export const healerRole: RoleFactory = (
  targetRoom?: string,
  encodedRouteRooms?: string,
  boostTaskId?: string,
  encodedBoostCompounds?: string,
) => ({
  prepare: (creep): boolean => prepareCombatBoost(creep, boostTaskId, encodedBoostCompounds),
  source: (creep): boolean => {
    if (targetRoom && moveWithWarAttackerFormation(creep, targetRoom, encodedRouteRooms)) return false;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (targetRoom && moveWithWarAttackerFormation(creep, targetRoom, encodedRouteRooms)) return false;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
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
