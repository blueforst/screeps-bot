import type { RoleFactory } from "@/types/system";
import { POWER_BANK_PATROL_ROOMS, isPowerBankPatrolRoom } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { moveToTargetRoom } from "@/roles/shared";

const TRANSIT_DANGER_TTL = 500;

interface PatrolMemory {
  patrolIndex?: number;
  patrolDirection?: 1 | -1;
}

function ensurePatrolMemory(creep: Creep): PatrolMemory {
  if (!creep.memory._patrol) {
    creep.memory._patrol = {};
  }
  return creep.memory._patrol as PatrolMemory;
}

function getCurrentPatrolTarget(patrol: PatrolMemory): string {
  const index = patrol.patrolIndex ?? 0;
  return POWER_BANK_PATROL_ROOMS[index % POWER_BANK_PATROL_ROOMS.length];
}

function advancePatrol(patrol: PatrolMemory): void {
  const length = POWER_BANK_PATROL_ROOMS.length;
  if (length <= 1) return;

  const rawIndex = patrol.patrolIndex ?? 0;
  const current = ((rawIndex % length) + length) % length;
  const direction = patrol.patrolDirection === -1 ? -1 : 1;
  const lastIndex = length - 1;

  if (current === lastIndex) {
    patrol.patrolIndex = lastIndex - 1;
    patrol.patrolDirection = -1;
    return;
  }

  if (current === 0 && direction === -1) {
    patrol.patrolIndex = 1;
    patrol.patrolDirection = 1;
    return;
  }

  patrol.patrolIndex = current + direction;
  patrol.patrolDirection = direction;
}

function scanRoomForPowerBanks(creep: Creep): void {
  if (!isPowerBankPatrolRoom(creep.room.name)) {
    return;
  }

  const banks = creep.room.find(FIND_STRUCTURES).filter(
    (s): s is StructurePowerBank => s.structureType === STRUCTURE_POWER_BANK,
  );

  for (const bank of banks) {
    recordPowerBankDiscovery(bank);
  }
}

function hasHostileCombatPresence(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  for (const h of hostiles) {
    if (
      h.getActiveBodyparts(ATTACK) > 0 ||
      h.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      h.getActiveBodyparts(HEAL) > 0
    ) {
      return true;
    }
  }
  if (room.find(FIND_HOSTILE_POWER_CREEPS).length > 0) {
    return true;
  }
  return false;
}

function hasHostileController(room: Room): boolean {
  if (room.controller?.owner && !room.controller.my) {
    return true;
  }
  if (room.controller?.reservation && !room.controller.my) {
    const myUser =
      Object.values(Game.spawns)[0]?.owner.username ||
      Object.values(Game.creeps)[0]?.owner.username;
    if (!myUser || room.controller.reservation.username !== myUser) {
      return true;
    }
  }
  return false;
}

function markTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.transitDangerRooms) Memory.runtime.transitDangerRooms = {};
  Memory.runtime.transitDangerRooms[roomName] = Game.time + TRANSIT_DANGER_TTL;
}

function markPermanentTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.powerBankPermanentDangerRooms) Memory.runtime.powerBankPermanentDangerRooms = {};
  Memory.runtime.powerBankPermanentDangerRooms[roomName] = true;
}

export function getActiveTransitDangerRooms(): string[] {
  const runtime = Memory.runtime;
  if (!runtime) return [];

  const now = Game.time;
  const active = new Set<string>();
  const permanent = runtime.powerBankPermanentDangerRooms;
  if (permanent) {
    for (const room of Object.keys(permanent)) {
      if (isPowerBankPatrolRoom(room)) {
        delete permanent[room];
        continue;
      }
      active.add(room);
    }
  }

  const temporary = runtime.transitDangerRooms;
  if (temporary) {
    for (const [room, expiresAt] of Object.entries(temporary)) {
      if (expiresAt <= now || isPowerBankPatrolRoom(room)) {
        delete temporary[room];
        continue;
      }
      active.add(room);
    }
  }

  return [...active];
}

function checkAndMarkTransitDanger(creep: Creep): void {
  const roomName = creep.room.name;
  if (isPowerBankPatrolRoom(roomName)) return;

  const lastHits = creep.memory._lastHits;
  const currentHits = creep.hits;
  creep.memory._lastHits = currentHits;

  const damaged = lastHits !== undefined && currentHits < lastHits;
  if (hasHostileController(creep.room)) {
    markPermanentTransitDanger(roomName);
  }
  if (damaged || hasHostileCombatPresence(creep.room)) {
    markTransitDanger(roomName);
  }
}

export const powerBankScoutRole: RoleFactory = () => ({
  source: (creep: Creep): boolean => {
    const patrol = ensurePatrolMemory(creep);
    const targetRoom = getCurrentPatrolTarget(patrol);

    checkAndMarkTransitDanger(creep);
    scanRoomForPowerBanks(creep);

    const avoidRooms = getActiveTransitDangerRooms();

    if (creep.room.name === targetRoom) {
      advancePatrol(patrol);
      const nextTarget = getCurrentPatrolTarget(patrol);
      moveToTargetRoom(creep, nextTarget, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
      return false;
    }

    moveToTargetRoom(creep, targetRoom, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
    return false;
  },
  target: (): boolean => false,
});
