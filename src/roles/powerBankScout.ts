import type { RoleFactory } from "@/types/system";
import { POWER_BANK_PATROL_ROOMS, isPowerBankPatrolRoom } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { moveToTargetRoom } from "@/roles/shared";

const TRANSIT_DANGER_TTL = 500;

interface PatrolMemory {
  patrolIndex?: number;
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
  const current = patrol.patrolIndex ?? 0;
  patrol.patrolIndex = (current + 1) % POWER_BANK_PATROL_ROOMS.length;
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

function hasHostilePresence(room: Room): boolean {
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

export function getActiveTransitDangerRooms(): string[] {
  const map = Memory.runtime?.transitDangerRooms;
  if (!map) return [];
  const now = Game.time;
  const active: string[] = [];
  for (const [room, expiresAt] of Object.entries(map)) {
    if (expiresAt <= now || isPowerBankPatrolRoom(room)) {
      delete map[room];
      continue;
    }
    active.push(room);
  }
  return active;
}

function checkAndMarkTransitDanger(creep: Creep): void {
  const roomName = creep.room.name;
  if (isPowerBankPatrolRoom(roomName)) return;

  const lastHits = creep.memory._lastHits;
  const currentHits = creep.hits;
  creep.memory._lastHits = currentHits;

  let damaged = false;
  if (lastHits !== undefined && currentHits < lastHits) {
    damaged = true;
  }

  if (damaged || hasHostilePresence(creep.room)) {
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
