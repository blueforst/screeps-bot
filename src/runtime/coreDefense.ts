import { getTickContextService } from "@/runtime/runtimeServices";

const CORE_RAMPART_ATTACK_RANGE = 3;
const NUKE_IGNORE_TIME_TO_LAND = 1;
const NUKE_DAMAGE_RANGE = 2;

function getCoreRampartHitStore(room: Room): Record<string, number> {
  room.memory.coreRampartHits = room.memory.coreRampartHits || {};
  return room.memory.coreRampartHits;
}

function getCorePositionsFromPlan(room: Room): RoomPosition[] {
  const layout = Memory.data?.roomPlanner?.[room.name]?.layout;
  if (!layout) {
    return [];
  }

  const merged = [...(layout[STRUCTURE_SPAWN] ?? []), ...(layout[STRUCTURE_STORAGE] ?? [])];
  const seen = new Set<string>();
  const result: RoomPosition[] = [];

  for (const pos of merged) {
    const key = `${pos.x}:${pos.y}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(new RoomPosition(pos.x, pos.y, room.name));
  }

  return result;
}

function getRampartAtPosition(pos: RoomPosition): StructureRampart | null {
  const structures = pos.lookFor(LOOK_STRUCTURES);
  const rampart = structures.find((structure) => structure.structureType === STRUCTURE_RAMPART);
  return (rampart as StructureRampart | undefined) || null;
}

function hasCreepThreatNearRampart(room: Room, rampart: StructureRampart): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) =>
      (creep.getActiveBodyparts(ATTACK) > 0 ||
        creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
        creep.getActiveBodyparts(WORK) > 0) &&
      creep.pos.getRangeTo(rampart.pos) <= CORE_RAMPART_ATTACK_RANGE,
  });

  return hostiles.length > 0;
}

function hasNukeDamageAtPosition(room: Room, pos: RoomPosition): boolean {
  const nukes = room.find(FIND_NUKES);
  return nukes.some(
    (nuke) => nuke.timeToLand <= NUKE_IGNORE_TIME_TO_LAND && nuke.pos.getRangeTo(pos) <= NUKE_DAMAGE_RANGE,
  );
}

function getExpectedNaturalRampartLoss(previousHits: number): number {
  if (Game.time % RAMPART_DECAY_TIME !== 0) {
    return 0;
  }

  return Math.min(previousHits, RAMPART_DECAY_AMOUNT);
}

function canActivateSafeMode(room: Room): boolean {
  const controller = room.controller;
  if (!controller || !controller.my) {
    return false;
  }

  if ((controller.safeMode ?? 0) > 0) {
    return false;
  }

  if ((controller.safeModeCooldown ?? 0) > 0) {
    return false;
  }

  return (controller.safeModeAvailable ?? 0) > 0;
}

function tryActivateSafeMode(room: Room): boolean {
  if (!canActivateSafeMode(room)) {
    return false;
  }

  const code = room.controller!.activateSafeMode();
  if (code === OK) {
    console.log(`[coreDefense] ${room.name} activated safe mode: core rampart under creep attack`);
    return true;
  }

  return false;
}

function evaluateRoomCoreRamparts(room: Room): void {
  const hitStore = getCoreRampartHitStore(room);
  const corePositions = getCorePositionsFromPlan(room);
  const validKeys = new Set<string>();
  let safeModeTriggered = false;

  for (const pos of corePositions) {
    const key = `${pos.x}:${pos.y}`;
    validKeys.add(key);

    const rampart = getRampartAtPosition(pos);
    if (!rampart) {
      delete hitStore[key];
      continue;
    }

    const previousHits = hitStore[key];
    const hitLoss = previousHits === undefined ? 0 : previousHits - rampart.hits;
    const naturalLoss = previousHits === undefined ? 0 : getExpectedNaturalRampartLoss(previousHits);
    const hostileLoss = hitLoss - naturalLoss;
    if (
      !safeModeTriggered &&
      previousHits !== undefined &&
      hitLoss > 0 &&
      hostileLoss > 0 &&
      !hasNukeDamageAtPosition(room, rampart.pos) &&
      hasCreepThreatNearRampart(room, rampart)
    ) {
      safeModeTriggered = tryActivateSafeMode(room);
    }

    hitStore[key] = rampart.hits;
  }

  for (const key of Object.keys(hitStore)) {
    if (!validKeys.has(key)) {
      delete hitStore[key];
    }
  }
}

export function runCoreDefense(): void {
  const rooms = getTickContextService().getMyRooms();
  for (const room of rooms) {
    evaluateRoomCoreRamparts(room);
  }
}
