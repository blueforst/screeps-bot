import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { isWalkableStructure } from "@/movement/common";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;
const ROUTE_BREACH_RESUME_TICKS = 5;

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

export function findTarget(creep: Creep): Creep | Structure | null {
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

export function findWarObjectiveTarget(creep: Creep): Creep | Structure | null {
  const hostileStructures = getHostileStructures(creep.room);
  const objectiveOrder: StructureConstant[] = [
    STRUCTURE_SPAWN,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_INVADER_CORE,
  ];

  for (const structureType of objectiveOrder) {
    const candidates = hostileStructures.filter((structure) => structure.structureType === structureType);
    if (candidates.length > 0) {
      return creep.pos.findClosestByRange(candidates);
    }
  }

  return findTarget(creep);
}

function isBreachTarget(structure: Structure): structure is StructureRampart | StructureWall {
  if (structure.structureType === STRUCTURE_WALL) return true;
  return structure.structureType === STRUCTURE_RAMPART;
}

function getCombatBreachCost(structure: StructureRampart | StructureWall, hostileCreeps: Creep[]): number {
  if (structure.structureType === STRUCTURE_RAMPART) return 0xfe;
  if (
    hostileCreeps.some(
      (hostile) => hostile.getActiveBodyparts(RANGED_ATTACK) > 0 && hostile.pos.getRangeTo(structure.pos) <= 3,
    )
  ) {
    return 0xfe;
  }
  return Math.min(0xfe, 20 + Math.ceil(structure.hits / 50_000));
}

function findFirstBreachOnCombatPath(creep: Creep, target: Creep | Structure): StructureRampart | StructureWall | null {
  if (target.pos.roomName !== creep.room.name) return null;

  const structures = creep.room.find(FIND_STRUCTURES);
  const breaches = structures.filter(
    (structure): structure is StructureRampart | StructureWall =>
      isBreachTarget(structure) && !(structure.structureType === STRUCTURE_RAMPART && structure.my),
  );
  if (breaches.length === 0) return null;

  const matrix = new PathFinder.CostMatrix();
  for (const structure of structures) {
    if (isBreachTarget(structure)) continue;
    if (structure.structureType === STRUCTURE_ROAD) {
      matrix.set(structure.pos.x, structure.pos.y, 1);
      continue;
    }
    if (!isWalkableStructure(structure)) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }

  const breachByPosition = new Map<string, StructureRampart | StructureWall>();
  const hostileCreeps = getHostileCreeps(creep.room);
  for (const breach of breaches) {
    matrix.set(breach.pos.x, breach.pos.y, getCombatBreachCost(breach, hostileCreeps));
    breachByPosition.set(`${breach.pos.x}:${breach.pos.y}`, breach);
  }

  const result = PathFinder.search(
    creep.pos,
    { pos: target.pos, range: 1 },
    {
      plainCost: 2,
      swampCost: 8,
      maxRooms: 1,
      roomCallback: (roomName) => (roomName === creep.room.name ? matrix : false),
    },
  );
  if (result.incomplete) return null;

  for (const step of result.path) {
    const breach = breachByPosition.get(`${step.x}:${step.y}`);
    if (breach) return breach;
  }
  return null;
}

function findAdjacentStructures(creep: Creep): Structure[] {
  if (typeof creep.pos.findInRange === "function") return creep.pos.findInRange(FIND_STRUCTURES, 1);
  if (typeof creep.room.find !== "function") return [];

  return creep.room.find(FIND_STRUCTURES).filter((structure) => creep.pos.getRangeTo(structure.pos) <= 1);
}

function findAdjacentHostiles(creep: Creep): Creep[] {
  if (typeof creep.pos.findInRange === "function") return creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
  if (typeof creep.room.find !== "function") return [];

  return creep.room.find(FIND_HOSTILE_CREEPS).filter((hostile) => creep.pos.getRangeTo(hostile.pos) <= 1);
}

function findWeakestAdjacentBreachTarget(creep: Creep, target?: Creep | Structure): StructureRampart | StructureWall | null {
  const blockers = findAdjacentStructures(creep).filter(isBreachTarget);
  if (blockers.length === 0) return null;

  return blockers.sort((left, right) => {
    if (left.hits !== right.hits) return left.hits - right.hits;
    if (target) {
      const leftRange = left.pos.getRangeTo(target.pos);
      const rightRange = right.pos.getRangeTo(target.pos);
      if (leftRange !== rightRange) return leftRange - rightRange;
    }

    return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
  })[0];
}

function findWeakestAdjacentHostileStructure(creep: Creep, target?: Creep | Structure): Structure | null {
  const hostileIds = new Set(getHostileStructures(creep.room).map((structure) => structure.id));
  const candidates = findAdjacentStructures(creep).filter((structure) => hostileIds.has(structure.id));
  if (candidates.length === 0) return null;

  return candidates.sort((left, right) => {
    if (left.hits !== right.hits) return left.hits - right.hits;
    if (target) {
      const leftRange = left.pos.getRangeTo(target.pos);
      const rightRange = right.pos.getRangeTo(target.pos);
      if (leftRange !== rightRange) return leftRange - rightRange;
    }
    return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
  })[0];
}

function attackAdjacentBreachTarget(creep: Creep, target: Creep | Structure): boolean {
  const blocker =
    findWeakestAdjacentBreachTarget(creep, target) ||
    findWeakestAdjacentHostileStructure(creep, target);
  if (!blocker) return false;

  measureCreepIntent(() => creep.attack(blocker));
  return true;
}

function isDangerousHostile(creep: Creep): boolean {
  return (
    creep.getActiveBodyparts(HEAL) > 0 ||
    creep.getActiveBodyparts(ATTACK) > 0 ||
    creep.getActiveBodyparts(RANGED_ATTACK) > 0
  );
}

function attackAdjacentHostileOnRoute(creep: Creep): boolean {
  const adjacent = findAdjacentHostiles(creep).filter(
    (hostile) => hostile.owner?.username && hostile.owner.username !== "Source Keeper",
  );
  if (adjacent.length === 0) return false;

  return adjacent
    .sort((left, right) => {
      const leftDangerous = isDangerousHostile(left);
      const rightDangerous = isDangerousHostile(right);
      if (leftDangerous !== rightDangerous) return leftDangerous ? -1 : 1;
      if (left.hits !== right.hits) return left.hits - right.hits;
      return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
    })
    .some((target) => measureCreepIntent(() => creep.attack(target)) === OK);
}

function attackWeakestAdjacentBreachTarget(creep: Creep): boolean {
  const blocker = findWeakestAdjacentBreachTarget(creep);
  if (!blocker) return false;

  measureCreepIntent(() => creep.attack(blocker));
  return true;
}

function attackAdjacentWhileHoldingFormation(creep: Creep, includeBreach: boolean): void {
  if (attackAdjacentHostileOnRoute(creep)) return;
  if (includeBreach) attackWeakestAdjacentBreachTarget(creep);
}

function attackRouteBreachWhileTraveling(creep: Creep): boolean {
  if (attackAdjacentHostileOnRoute(creep)) return false;
  if (creep.room.controller?.my) {
    delete creep.memory._warBreachTargetId;
    delete creep.memory._warBreachResumeUntil;
    return false;
  }

  const trackedId = creep.memory._warBreachTargetId;
  if (trackedId) {
    const tracked = Game.getObjectById(trackedId);
    if (!tracked || tracked.pos.roomName !== creep.room.name) {
      delete creep.memory._warBreachTargetId;
      creep.memory._warBreachResumeUntil = Game.time + ROUTE_BREACH_RESUME_TICKS;
      return false;
    }

    const attackCode = measureCreepIntent(() => creep.attack(tracked));
    if (attackCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, tracked, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
    }
    return true;
  }

  const resumeUntil = creep.memory._warBreachResumeUntil;
  if (resumeUntil !== undefined) {
    if (Game.time < resumeUntil) return false;
    delete creep.memory._warBreachResumeUntil;
  }

  const blocker = findWeakestAdjacentBreachTarget(creep);
  if (!blocker) return false;

  creep.memory._warBreachTargetId = blocker.id;
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

function isPoisedToCrossInto(creep: Creep, targetRoom: string): boolean {
  if (creep.room.name === targetRoom) return false;

  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return false;
  return isOnExitDirection(creep.pos, exitDirection as DirectionConstant);
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
      if (isPoisedToCrossInto(healer, targetRoom)) {
        moveOffExitIntoRoom(creep);
        return true;
      }
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
    if (targetRoom && waitForWarHealerFormation(creep, targetRoom)) {
      attackAdjacentWhileHoldingFormation(creep, creep.room.name === targetRoom);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      if (attackRouteBreachWhileTraveling(creep)) return false;
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (targetRoom && waitForWarHealerFormation(creep, targetRoom)) {
      attackAdjacentWhileHoldingFormation(creep, creep.room.name === targetRoom);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      if (attackRouteBreachWhileTraveling(creep)) return false;
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    if (targetRoom && attackAdjacentHostileOnRoute(creep)) {
      delete creep.memory._warBreachTargetId;
      return false;
    }

    const target = measureCreepDecision(() => (targetRoom ? findWarObjectiveTarget(creep) : findTarget(creep)));
    if (!target) {
      delete creep.memory._warBreachTargetId;
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

    if (targetRoom) {
      const plannedBreach = measureCreepDecision(() => findFirstBreachOnCombatPath(creep, target));
      if (plannedBreach) {
        creep.memory._warBreachTargetId = plannedBreach.id;
        const breachCode = measureCreepIntent(() => creep.attack(plannedBreach));
        if (breachCode === ERR_NOT_IN_RANGE) {
          moveToTarget(creep, plannedBreach, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        }
        return false;
      }
      delete creep.memory._warBreachTargetId;
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
