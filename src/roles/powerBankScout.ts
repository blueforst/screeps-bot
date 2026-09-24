import type { RoleFactory } from "@/types/system";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { invalidatePowerBankRegion } from "@/runtime/powerBankRegion";
import { getTickContextService } from "@/runtime/runtimeServices";
import { moveToTargetRoom } from "@/roles/shared";

const TRANSIT_DANGER_TTL = 500;

interface PatrolMemory {
  patrolIndex?: number;
  targetSignature?: string;
}

function ensurePatrolMemory(creep: Creep): PatrolMemory {
  if (!creep.memory._patrol) creep.memory._patrol = {};
  return creep.memory._patrol as PatrolMemory;
}

function parseTargets(encodedTargets?: string): string[] {
  if (!encodedTargets) return [];
  return [...new Set(encodedTargets.split("|").filter((roomName) => /^([WE])\d+([NS])\d+$/.test(roomName)))];
}

function getCurrentPatrolTarget(patrol: PatrolMemory, targets: string[]): string | undefined {
  if (targets.length === 0) return undefined;
  const signature = targets.join("|");
  if (patrol.targetSignature !== signature) {
    patrol.targetSignature = signature;
    patrol.patrolIndex = 0;
  }
  const index = ((patrol.patrolIndex ?? 0) % targets.length + targets.length) % targets.length;
  patrol.patrolIndex = index;
  return targets[index];
}

function advancePatrol(patrol: PatrolMemory, targets: string[]): void {
  if (targets.length <= 1) return;
  patrol.patrolIndex = ((patrol.patrolIndex ?? 0) + 1) % targets.length;
}

function scanRoomForPowerBanks(creep: Creep): void {
  if (Memory.runtime?.powerBankObserver?.lastVisibleAt?.[creep.room.name] === Game.time) return;
  const banks = creep.room.find(FIND_STRUCTURES).filter(
    (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
  );
  for (const bank of banks) recordPowerBankDiscovery(bank);
}

function hasHostileCombatPresence(room: Room): boolean {
  const context = getTickContextService().getRoomContext(room);
  const hostiles = context?.getHostileCreeps() ?? room.find(FIND_HOSTILE_CREEPS);
  for (const hostile of hostiles) {
    if (
      hostile.getActiveBodyparts(ATTACK) > 0 ||
      hostile.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      hostile.getActiveBodyparts(HEAL) > 0
    ) return true;
  }
  if ((context?.getHostilePowerCreeps() ?? room.find(FIND_HOSTILE_POWER_CREEPS)).length > 0) return true;
  const hostileStructures = context?.getHostileStructures() ?? room.find(FIND_HOSTILE_STRUCTURES);
  return hostileStructures.some((structure) =>
    structure.structureType === STRUCTURE_TOWER || structure.structureType === STRUCTURE_INVADER_CORE,
  );
}

function hasHostileController(room: Room): boolean {
  const controller = room.controller;
  if (controller?.owner && !controller.my) return true;
  if (!controller?.reservation) return false;
  const myUser = Object.values(Game.spawns)[0]?.owner.username ?? Object.values(Game.creeps)[0]?.owner.username;
  return !myUser || controller.reservation.username !== myUser;
}

function markTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.transitDangerRooms) Memory.runtime.transitDangerRooms = {};
  const expiry = Game.time + TRANSIT_DANGER_TTL;
  if ((Memory.runtime.transitDangerRooms[roomName] ?? 0) + 25 < expiry) {
    Memory.runtime.transitDangerRooms[roomName] = expiry;
    invalidatePowerBankRegion();
  }
}

function markPermanentTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.powerBankPermanentDangerRooms) Memory.runtime.powerBankPermanentDangerRooms = {};
  if (!Memory.runtime.powerBankPermanentDangerRooms[roomName]) {
    Memory.runtime.powerBankPermanentDangerRooms[roomName] = true;
    invalidatePowerBankRegion();
  }
}

export function getActiveTransitDangerRooms(): string[] {
  const runtime = Memory.runtime;
  if (!runtime) return [];
  const active = new Set<string>();
  for (const [roomName, expiresAt] of Object.entries(runtime.transitDangerRooms ?? {})) {
    if (expiresAt > Game.time) active.add(roomName);
  }
  for (const roomName of Object.keys(runtime.powerBankPermanentDangerRooms ?? {})) active.add(roomName);
  return [...active];
}

function checkAndMarkTransitDanger(creep: Creep): void {
  const roomName = creep.room.name;
  const lastHits = creep.memory._lastHits;
  const currentHits = creep.hits;
  creep.memory._lastHits = currentHits;

  if (hasHostileController(creep.room)) markPermanentTransitDanger(roomName);
  if ((lastHits !== undefined && currentHits < lastHits) || hasHostileCombatPresence(creep.room)) {
    markTransitDanger(roomName);
  }
}

export const powerBankScoutRole: RoleFactory = (encodedTargets?: string) => ({
  source: (creep: Creep): boolean => {
    const targets = parseTargets(encodedTargets);
    if (targets.length === 0) {
      creep.suicide();
      return false;
    }

    const patrol = ensurePatrolMemory(creep);
    const targetRoom = getCurrentPatrolTarget(patrol, targets);
    if (!targetRoom) {
      creep.suicide();
      return false;
    }

    checkAndMarkTransitDanger(creep);
    scanRoomForPowerBanks(creep);
    const avoidRooms = getActiveTransitDangerRooms().filter((roomName) => roomName !== targetRoom);

    if (creep.room.name === targetRoom) {
      advancePatrol(patrol, targets);
      const nextTarget = getCurrentPatrolTarget(patrol, targets);
      if (!nextTarget || nextTarget === creep.room.name) return false;
      moveToTargetRoom(creep, nextTarget, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
      return false;
    }

    moveToTargetRoom(creep, targetRoom, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
    return false;
  },
  target: (): boolean => false,
});
