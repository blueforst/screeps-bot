import { getExpectedManagedConfigNames } from "@/runtime/roomWorkforce";

const CLEANUP_INTERVAL = 17;
const VALID_ROLES = new Set([
  "harvester",
  "miner",
  "carrier",
  "worker",
  "scout",
  "claimer",
  "colonizerHarvester",
  "colonizerWorker",
  "meleeAttacker",
  "healer",
  "crossShardClaimer",
  "crossShardColonizerHarvester",
  "crossShardColonizerWorker",
]);
const ROOM_PLANNER_TTL = 50000;
const ROOM_PLANNER_AUTO_TTL = 20000;
const INTER_SHARD_PORTAL_TTL = 10000;
const INTER_SHARD_REMOTE_TTL = 500;
const INTER_SHARD_CLAIM_TTL = 5000;
const INTER_SHARD_ROOM_STATE_TTL = 5000;
const CROSS_SHARD_COLONIZATION_TTL = 5000;

function getOwnedRoomNameSet(): Set<string> {
  return new Set(
    Object.values(Game.rooms)
      .filter((room) => room.controller?.my)
      .map((room) => room.name),
  );
}

function getColonizationTargetRoomNameSet(): Set<string> {
  const colonization = Memory.data?.colonization;
  if (!colonization) {
    return new Set();
  }

  return new Set(Object.keys(colonization));
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

function cleanupRoomPlannerMemory(ownedRooms: Set<string>, colonizationTargets: Set<string>): number {
  if (!Memory.data?.roomPlanner) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, data] of Object.entries(Memory.data.roomPlanner)) {
    const staleByRoom = !ownedRooms.has(roomName) && !colonizationTargets.has(roomName);
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

function cleanupLinkNetworkMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.linkNetwork) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.linkNetwork)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.linkNetwork[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupTowerEmergencyMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.towerEmergencyRamparts) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.towerEmergencyRamparts)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.towerEmergencyRamparts[roomName];
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

function cleanupWarMemory(ownedRooms: Set<string>): number {
  if (!Memory.data?.war) {
    return 0;
  }

  let removed = 0;
  for (const [targetRoom, task] of Object.entries(Memory.data.war)) {
    const sourceRoomOwned = ownedRooms.has(task.sourceRoom);
    const terminalDone = task.status === "done" || task.status === "failed";
    const expiredTerminal = terminalDone && Game.time - task.updatedAt > 200;
    if (!sourceRoomOwned || expiredTerminal) {
      delete Memory.data.war[targetRoom];
      removed += 1;
    }
  }

  return removed;
}

function cleanupInterShardPortalMemory(): number {
  if (!Memory.data?.interShardPortals) {
    return 0;
  }

  let removed = 0;
  for (const [portalId, portal] of Object.entries(Memory.data.interShardPortals)) {
    const stale = Game.time - portal.lastSeenAt > INTER_SHARD_PORTAL_TTL;
    const decayed = typeof portal.ticksToDecay === "number" && portal.ticksToDecay <= 0;
    if (stale || decayed) {
      delete Memory.data.interShardPortals[portalId];
      removed += 1;
    }
  }

  return removed;
}

function cleanupCrossShardRuntimeMemory(): number {
  const crossShard = Memory.runtime?.crossShard;
  if (!crossShard) {
    return 0;
  }

  const remotes = crossShard.remotes || {};
  const claims = crossShard.claims || {};
  const rooms = crossShard.rooms || {};

  let removed = 0;
  for (const [shard, remote] of Object.entries(remotes)) {
    if (Game.time - remote.updatedAt > INTER_SHARD_REMOTE_TTL) {
      delete remotes[shard];
      removed += 1;
    }
  }

  for (const [roomName, claim] of Object.entries(claims)) {
    if (Game.time - claim.updatedAt > INTER_SHARD_CLAIM_TTL) {
      delete claims[roomName];
      removed += 1;
    }
  }

  for (const [roomName, summary] of Object.entries(rooms)) {
    if (Game.time - summary.updatedAt > INTER_SHARD_ROOM_STATE_TTL) {
      delete rooms[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupCrossShardColonizationMemory(ownedRooms: Set<string>): number {
  const store = Memory.data?.crossShardColonization;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const [taskId, task] of Object.entries(store)) {
    const sourceRoomLost = !!task.sourceRoom && !ownedRooms.has(task.sourceRoom);
    const staleTerminal =
      (task.status === "blocked" ||
        task.status === "failed" ||
        task.status === "claimed" ||
        task.status === "completed") &&
      Game.time - task.updatedAt > CROSS_SHARD_COLONIZATION_TTL;
    const malformed = !task.targetShard || !task.targetRoom;
    if (sourceRoomLost || staleTerminal || malformed) {
      delete store[taskId];
      removed += 1;
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
  const colonizationTargets = getColonizationTargetRoomNameSet();
  const removedRoomPlans = cleanupRoomPlannerMemory(ownedRooms, colonizationTargets);
  const removedRoomPlannerAuto = cleanupRoomPlannerAutoMemory(ownedRooms);
  const removedLinkNetwork = cleanupLinkNetworkMemory(ownedRooms);
  const removedTowerEmergency = cleanupTowerEmergencyMemory(ownedRooms);
  const removedPickupReservations = cleanupPickupReservationMemory(ownedRooms);
  const removedWarTasks = cleanupWarMemory(ownedRooms);
  const removedInterShardPortals = cleanupInterShardPortalMemory();
  const removedCrossShardRuntime = cleanupCrossShardRuntimeMemory();
  const removedCrossShardColonization = cleanupCrossShardColonizationMemory(ownedRooms);

  if (
    removedCreeps > 0 ||
    trimmedTasks > 0 ||
    removedConfigs > 0 ||
    removedManagedConfigs > 0 ||
    removedRoomPlans > 0 ||
    removedRoomPlannerAuto > 0 ||
    removedLinkNetwork > 0 ||
    removedTowerEmergency > 0 ||
    removedPickupReservations > 0 ||
    removedWarTasks > 0 ||
    removedInterShardPortals > 0 ||
    removedCrossShardRuntime > 0 ||
    removedCrossShardColonization > 0
  ) {
    console.log(
      `[memory] cleaned creeps=${removedCreeps}, spawnTasks=${trimmedTasks}, legacyConfigs=${removedConfigs}, managedConfigs=${removedManagedConfigs}, roomPlans=${removedRoomPlans}, roomPlannerAuto=${removedRoomPlannerAuto}, linkNetwork=${removedLinkNetwork}, towerEmergency=${removedTowerEmergency}, pickupReservations=${removedPickupReservations}, warTasks=${removedWarTasks}, interShardPortals=${removedInterShardPortals}, crossShardRuntime=${removedCrossShardRuntime}, crossShardColonization=${removedCrossShardColonization}`,
    );
  }
}
