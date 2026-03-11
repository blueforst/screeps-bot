import { getExpectedManagedConfigNames } from "@/runtime/roomWorkforce";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { cleanupCarrierTaskBoard } from "@/runtime/carrierTaskBoard";

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
const RESOURCE_CONTROL_TASK_TTL = 5000;
const CARRIER_TASK_BOARD_TTL = 500;

function getOwnedRoomNameSet(): Set<string> {
  return new Set(getTickContextService().getMyRooms().map((room) => room.name));
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
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();

  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      const queue = spawn.memory.spawnList;
      if (!queue || queue.length === 0) {
        continue;
      }

      const validQueue = queue.filter((configName) => !!creepConfigs.get(configName));
      if (validQueue.length !== queue.length) {
        spawn.memory.spawnList = validQueue;
        trimmed += queue.length - validQueue.length;
      }
    }
  }

  return trimmed;
}

function cleanupLegacyConfigMemory(): number {
  const configStore = getMemoryService().getCreepConfigStore();
  let removed = 0;
  for (const [configName, config] of Object.entries(configStore)) {
    if (!VALID_ROLES.has(config.role)) {
      delete configStore[configName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupManagedCreepConfigs(): number {
  const configStore = getMemoryService().getCreepConfigStore();
  const expected = new Set<string>();
  const myRooms = getTickContextService().getMyRooms();
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

  for (const [configName, config] of Object.entries(configStore)) {
    if (!VALID_ROLES.has(config.role)) {
      continue;
    }

    const hasLiveCreep = activeConfigNames.has(configName);
    if (!expected.has(configName) && !hasLiveCreep) {
      delete configStore[configName];
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

function cleanupResourceControlMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.resourceControl) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.resourceControl.rooms)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.resourceControl.rooms[roomName];
      removed += 1;
    }
  }

  const synthesisBindings = Memory.runtime.resourceControl.synthesisBindings;
  if (synthesisBindings) {
    for (const [key, binding] of Object.entries(synthesisBindings)) {
      const targetRoomName = key.split(":", 1)[0];
      const donorRoomName = binding.fromRoomName;
      const expired = binding.expiresAt < Game.time;
      if (expired || !ownedRooms.has(targetRoomName) || !ownedRooms.has(donorRoomName)) {
        delete synthesisBindings[key];
        removed += 1;
      }
    }
  }

  if (
    Object.keys(Memory.runtime.resourceControl.rooms).length === 0 &&
    (!synthesisBindings || Object.keys(synthesisBindings).length === 0)
  ) {
    delete Memory.runtime.resourceControl;
  }

  return removed;
}

function cleanupSynthesisControlMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.synthesisControl) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.synthesisControl.rooms)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.synthesisControl.rooms[roomName];
      removed += 1;
    }
  }

  for (const [key, binding] of Object.entries(Memory.runtime.synthesisControl.bindings)) {
    const targetRoomName = key.split(":", 1)[0];
    const donorRoomName = binding.fromRoomName;
    const expired = binding.expiresAt < Game.time;
    if (expired || !ownedRooms.has(targetRoomName) || !ownedRooms.has(donorRoomName)) {
      delete Memory.runtime.synthesisControl.bindings[key];
      removed += 1;
    }
  }

  if (
    Object.keys(Memory.runtime.synthesisControl.rooms).length === 0 &&
    Object.keys(Memory.runtime.synthesisControl.bindings).length === 0
  ) {
    delete Memory.runtime.synthesisControl;
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

function cleanupResourceControlTaskMemory(ownedRooms: Set<string>): number {
  const tasks = Memory.data?.resourceControl?.tasks;
  if (!tasks) {
    return 0;
  }

  let removed = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    const sourceOrTargetLost = !ownedRooms.has(task.fromRoomName) || !ownedRooms.has(task.toRoomName);
    const terminalStale =
      (task.status === "done" || task.status === "cancelled" || task.status === "failed") &&
      Game.time - task.updatedAt > RESOURCE_CONTROL_TASK_TTL;
    if (sourceOrTargetLost || terminalStale) {
      delete tasks[taskId];
      removed += 1;
    }
  }

  if (Object.keys(tasks).length === 0 && Memory.data?.resourceControl) {
    delete Memory.data.resourceControl;
  }

  return removed;
}

function cleanupCarrierTaskBoardMemory(ownedRooms: Set<string>): number {
  return cleanupCarrierTaskBoard(ownedRooms, CARRIER_TASK_BOARD_TTL);
}

function cleanupEmptyForeignRoomMemory(ownedRooms: Set<string>): number {
  if (!Memory.rooms) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, roomMemory] of Object.entries(Memory.rooms)) {
    if (ownedRooms.has(roomName)) {
      continue;
    }

    if (Object.keys(roomMemory || {}).length === 0) {
      delete Memory.rooms[roomName];
      removed += 1;
    }
  }

  return removed;
}

export function runMemoryCleanup(): void {
  if (Game.time % CLEANUP_INTERVAL !== 0) {
    return;
  }

  cleanupDeadCreepMemory();
  cleanupSpawnQueueMemory();
  cleanupLegacyConfigMemory();
  cleanupManagedCreepConfigs();
  const ownedRooms = getOwnedRoomNameSet();
  const colonizationTargets = getColonizationTargetRoomNameSet();
  cleanupRoomPlannerMemory(ownedRooms, colonizationTargets);
  cleanupRoomPlannerAutoMemory(ownedRooms);
  cleanupLinkNetworkMemory(ownedRooms);
  cleanupTowerEmergencyMemory(ownedRooms);
  cleanupResourceControlMemory(ownedRooms);
  cleanupSynthesisControlMemory(ownedRooms);
  cleanupPickupReservationMemory(ownedRooms);
  cleanupWarMemory(ownedRooms);
  cleanupInterShardPortalMemory();
  cleanupCrossShardRuntimeMemory();
  cleanupCrossShardColonizationMemory(ownedRooms);
  cleanupResourceControlTaskMemory(ownedRooms);
  cleanupCarrierTaskBoardMemory(ownedRooms);
  cleanupEmptyForeignRoomMemory(ownedRooms);
}
