import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;

type PowerBankHealerRuntimeMemory = CreepMemory & { taskId?: string; powerBankReinforcementStage?: PowerBankReinforcementStage };

const BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "preparing_boosts",
  "spawning",
  "renewing",
  "boosting",
]);

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
]);

const REINFORCEMENT_BLOCKED_STAGES: ReadonlySet<string> = new Set(["spawning", "renewing", "boosting"]);

function getTaskForCreep(creep: Creep): PowerBankHarvestTask | null {
  const taskId = (creep.memory as PowerBankHealerRuntimeMemory).taskId;
  if (!taskId) return null;
  return Memory.data?.powerBankHarvest?.[taskId] ?? null;
}

function isReinforcementBlocked(creep: Creep): boolean {
  const stage = (creep.memory as PowerBankHealerRuntimeMemory).powerBankReinforcementStage;
  return !!stage && REINFORCEMENT_BLOCKED_STAGES.has(stage);
}

function retireIfOrphanedPowerBankCreep(creep: Creep): boolean {
  if (!creep.memory.configName?.includes(":powerbank:")) return false;
  creep.suicide();
  return true;
}

function findPairedAttacker(creep: Creep): Creep | null {
  const configPaired = findConfigPairedAttacker(creep);
  if (configPaired) return configPaired;

  const task = getTaskForCreep(creep);
  if (!task) return null;

  if (task.attackerId) {
    const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
    if (attacker) return attacker;
  }

  const taskId = (creep.memory as PowerBankHealerRuntimeMemory).taskId;
  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "powerBankAttacker") continue;
    if ((candidate.memory as PowerBankHealerRuntimeMemory).taskId !== taskId) continue;
    return candidate;
  }

  return null;
}

function findConfigPairedAttacker(creep: Creep): Creep | null {
  const configName = creep.memory.configName;
  if (!configName) return null;

  const attackerConfigName = configName.replace(":healer:", ":attacker:");
  if (attackerConfigName === configName) return null;
  const taskId = (creep.memory as PowerBankHealerRuntimeMemory).taskId;

  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "powerBankAttacker") continue;
    if (candidate.memory.configName !== attackerConfigName) continue;
    if (taskId && (candidate.memory as PowerBankHealerRuntimeMemory).taskId !== taskId) continue;
    return candidate;
  }

  return null;
}

function supportAttacker(creep: Creep, attacker: Creep): void {
  const { sameRoom, range } = healPairedAttacker(creep, attacker);
  if (sameRoom && range > 1) {
    moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
  } else if (!sameRoom) {
    moveToTargetRoom(creep, attacker.room.name, undefined, TRAVEL_OPTIONS);
  }
}

function healPairedAttacker(creep: Creep, attacker: Creep): { sameRoom: boolean; attackerDamaged: boolean; range: number } {
  const sameRoom = attacker.room.name === creep.room.name;
  const attackerDamaged = attacker.hits < attacker.hitsMax;
  const range = sameRoom ? creep.pos.getRangeTo(attacker.pos) : Infinity;

  if (sameRoom) {
    if (range <= 1) {
      measureCreepIntent(() => creep.heal(attacker));
    } else if (range <= 3) {
      measureCreepIntent(() => creep.rangedHeal(attacker));
    }
  }

  if (creep.hits < creep.hitsMax && (!sameRoom || range > 3)) {
    measureCreepIntent(() => creep.heal(creep));
  }

  return { sameRoom, attackerDamaged, range };
}

function isExitTile(pos: RoomPosition): boolean {
  return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function moveOffTargetRoomExit(creep: Creep): boolean {
  let horizontal: DirectionConstant | null = null;
  let vertical: DirectionConstant | null = null;

  if (creep.pos.x <= 0) horizontal = RIGHT;
  else if (creep.pos.x >= 49) horizontal = LEFT;

  if (creep.pos.y <= 0) vertical = BOTTOM;
  else if (creep.pos.y >= 49) vertical = TOP;

  let direction: DirectionConstant | null = null;
  if (horizontal && vertical) {
    if (horizontal === RIGHT && vertical === BOTTOM) direction = BOTTOM_RIGHT;
    else if (horizontal === RIGHT && vertical === TOP) direction = TOP_RIGHT;
    else if (horizontal === LEFT && vertical === BOTTOM) direction = BOTTOM_LEFT;
    else direction = TOP_LEFT;
  } else {
    direction = horizontal ?? vertical;
  }

  if (!direction) return false;
  // Tactical directional move — not destination pathfinding
  measureCreepIntent(() => creep.move(direction));
  return true;
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

function isHealerAheadOfAttacker(healer: Creep, attacker: Creep, targetRoom: string): boolean {
  if (healer.room.name !== attacker.room.name) return false;
  const direction = getExitMoveDirection(attacker.room, targetRoom);
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

function sidestepOutOfAttackerLane(creep: Creep, attacker: Creep, targetRoom: string): boolean {
  if (!isHealerAheadOfAttacker(creep, attacker, targetRoom)) return false;
  const exitDirection = getExitMoveDirection(attacker.room, targetRoom);
  if (!exitDirection) return false;

  const sidesteps: DirectionConstant[] = exitDirection === LEFT || exitDirection === RIGHT
    ? [TOP, BOTTOM, exitDirection === LEFT ? RIGHT : LEFT]
    : [LEFT, RIGHT, exitDirection === TOP ? BOTTOM : TOP];

  const direction = sidesteps.find((candidate) => isWalkableSideStep(creep, candidate));
  if (!direction) return false;

  // Tactical directional move — not destination pathfinding
  measureCreepIntent(() => creep.move(direction));
  return true;
}

export const powerBankHealerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (isReinforcementBlocked(creep)) return false;

    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;
    if (task?.status && RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    if (task?.status === "travelling") {
      const attacker = findPairedAttacker(creep);
      if (!attacker) return false;

      if (attacker.room.name !== creep.room.name) {
        moveToTargetRoom(creep, attacker.room.name, "", TRAVEL_OPTIONS);
        return false;
      }

      healPairedAttacker(creep, attacker);

      if (attacker.room.name !== task.targetRoom && sidestepOutOfAttackerLane(creep, attacker, task.targetRoom)) {
        return false;
      }

      if (creep.pos.getRangeTo(attacker.pos) > 1) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        return false;
      }
    }

    if (!task) {
      if (retireIfOrphanedPowerBankCreep(creep)) return false;
      const attacker = findConfigPairedAttacker(creep);
      if (attacker) supportAttacker(creep, attacker);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (isReinforcementBlocked(creep)) return false;

    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;
    if (task?.status && RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const attacker = findPairedAttacker(creep);

    if (task?.status === "travelling") {
      if (!attacker) return false;

      const sameRoom = attacker.room.name === creep.room.name;
      if (sameRoom && attacker.room.name !== task.targetRoom && sidestepOutOfAttackerLane(creep, attacker, task.targetRoom)) {
        return false;
      }

      if (sameRoom && creep.pos.getRangeTo(attacker.pos) > 1) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        return false;
      }
      if (!sameRoom) {
        if (creep.room.name === task.targetRoom && isExitTile(creep.pos)) {
          moveOffTargetRoomExit(creep);
          return false;
        }
        moveToTargetRoom(creep, attacker.room.name, undefined, TRAVEL_OPTIONS);
        return false;
      }
    }

    if (!task) {
      if (retireIfOrphanedPowerBankCreep(creep)) return false;
      if (attacker) supportAttacker(creep, attacker);
      return false;
    }

    if (!attacker) {
      if (creep.hits < creep.hitsMax) {
        measureCreepIntent(() => creep.heal(creep));
      }
      return false;
    }

    const { sameRoom, attackerDamaged, range } = healPairedAttacker(creep, attacker);

    if (sameRoom && attackerDamaged) {
      if (range > 1 && range <= 3) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      } else if (range > 3) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      }
    } else if (sameRoom && !attackerDamaged) {
      if (!creep.pos.isNearTo(attacker.pos)) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      }
    } else {
      moveToTargetRoom(creep, attacker.room.name, undefined, TRAVEL_OPTIONS);
    }

    return false;
  },
});
