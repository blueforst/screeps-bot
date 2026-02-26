import { getExpectedManagedConfigNames } from "@/runtime/roomWorkforce";

const CLEANUP_INTERVAL = 17;
const VALID_ROLES = new Set(["harvester", "carrier", "worker"]);
const ROOM_PLANNER_TTL = 50000;
const ROOM_PLANNER_AUTO_TTL = 20000;

function getOwnedRoomNameSet(): Set<string> {
  return new Set(
    Object.values(Game.rooms)
      .filter((room) => room.controller?.my)
      .map((room) => room.name),
  );
}

function cleanupDeadCreepMemory(): number {
  if (!Memory.creeps) {
    return 0;
  }

  let removed = 0;

  for (const creepName of Object.keys(Memory.creeps)) {
    if (!Game.creeps[creepName]) {
      delete Memory.creeps[creepName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupSpawnQueueMemory(): number {
  let trimmed = 0;

  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) {
      continue;
    }

    const validQueue = queue.filter((configName) => !!global.creepApi.get(configName));
    if (validQueue.length !== queue.length) {
      spawn.memory.spawnList = validQueue;
      trimmed += queue.length - validQueue.length;
    }
  }

  return trimmed;
}

function cleanupLegacyConfigMemory(): number {
  if (!Memory.data?.creepConfigs) {
    return 0;
  }

  let removed = 0;
  for (const [configName, config] of Object.entries(Memory.data.creepConfigs)) {
    if (!VALID_ROLES.has(config.role)) {
      delete Memory.data.creepConfigs[configName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupManagedCreepConfigs(): number {
  if (!Memory.data?.creepConfigs) {
    return 0;
  }

  const expected = new Set<string>();
  const myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
  for (const room of myRooms) {
    for (const name of getExpectedManagedConfigNames(room)) {
      expected.add(name);
    }
  }
  const activeConfigNames = new Set(
    Object.values(Game.creeps)
      .map((creep) => creep.memory.configName)
      .filter((name): name is string => !!name),
  );
  let removed = 0;

  for (const [configName, config] of Object.entries(Memory.data.creepConfigs)) {
    if (!VALID_ROLES.has(config.role)) {
      continue;
    }

    const hasLiveCreep = activeConfigNames.has(configName);
    if (!expected.has(configName) && !hasLiveCreep) {
      delete Memory.data.creepConfigs[configName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupRoomPlannerMemory(ownedRooms: Set<string>): number {
  if (!Memory.data?.roomPlanner) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, data] of Object.entries(Memory.data.roomPlanner)) {
    const staleByRoom = !ownedRooms.has(roomName);
    const staleByTime = Game.time - data.savedAt > ROOM_PLANNER_TTL;

    if (staleByRoom || staleByTime) {
      delete Memory.data.roomPlanner[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupRoomPlannerAutoMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.roomPlannerAuto) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, touchedAt] of Object.entries(Memory.runtime.roomPlannerAuto)) {
    const staleByRoom = !ownedRooms.has(roomName);
    const staleByTime = Game.time - touchedAt > ROOM_PLANNER_AUTO_TTL;

    if (staleByRoom || staleByTime) {
      delete Memory.runtime.roomPlannerAuto[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupPickupReservationMemory(ownedRooms: Set<string>): number {
  if (!Memory.rooms) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, roomMemory] of Object.entries(Memory.rooms)) {
    if (!ownedRooms.has(roomName)) {
      continue;
    }

    const reservations = roomMemory.pickupReservations;
    if (!reservations) {
      continue;
    }

    for (const [targetId, reservation] of Object.entries(reservations)) {
      for (const [creepName, claim] of Object.entries(reservation.claims)) {
        if (claim.until < Game.time || !Game.creeps[creepName]) {
          delete reservation.claims[creepName];
          removed += 1;
        }
      }

      if (Object.keys(reservation.claims).length === 0) {
        delete reservations[targetId];
      }
    }
  }

  return removed;
}

export function runMemoryCleanup(): void {
  if (Game.time % CLEANUP_INTERVAL !== 0) {
    return;
  }

  const removedCreeps = cleanupDeadCreepMemory();
  const trimmedTasks = cleanupSpawnQueueMemory();
  const removedConfigs = cleanupLegacyConfigMemory();
  const removedManagedConfigs = cleanupManagedCreepConfigs();
  const ownedRooms = getOwnedRoomNameSet();
  const removedRoomPlans = cleanupRoomPlannerMemory(ownedRooms);
  const removedRoomPlannerAuto = cleanupRoomPlannerAutoMemory(ownedRooms);
  const removedPickupReservations = cleanupPickupReservationMemory(ownedRooms);

  if (
    removedCreeps > 0 ||
    trimmedTasks > 0 ||
    removedConfigs > 0 ||
    removedManagedConfigs > 0 ||
    removedRoomPlans > 0 ||
    removedRoomPlannerAuto > 0 ||
    removedPickupReservations > 0
  ) {
    console.log(
      `[memory] cleaned creeps=${removedCreeps}, spawnTasks=${trimmedTasks}, legacyConfigs=${removedConfigs}, managedConfigs=${removedManagedConfigs}, roomPlans=${removedRoomPlans}, roomPlannerAuto=${removedRoomPlannerAuto}, pickupReservations=${removedPickupReservations}`,
    );
  }
}
