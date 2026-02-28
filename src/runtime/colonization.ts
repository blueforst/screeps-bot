import { runPlannerForRoom, savePlannerForRoom } from "@/modules/autoplanner";
import { spawnProfiles } from "@/config/spawnProfiles";
import { clearWarRoomTask, isWarRoomClearDone, requestWarRoomClear } from "@/runtime/warControl";

type ColonizationStatus = "claiming" | "clearing" | "waiting_plan" | "bootstrapping" | "managed";
type ColonizationMode = "normal" | "npcStronghold";

interface ColonizationTask {
  targetRoom: string;
  sourceRoom: string;
  status: ColonizationStatus;
  flagName: string;
  planReady: boolean;
  claimCompleted: boolean;
  scoutSafe?: boolean;
  scoutRouteRooms?: string[];
  dangerousRooms?: string[];
  mode?: ColonizationMode;
  scoutedAt?: number;
  createdAt: number;
  updatedAt: number;
}

const CLAIMER_BODY: BodyPartConstant[] = [CLAIM, MOVE];
const SCOUT_BODY: BodyPartConstant[] = [MOVE];
const BOOTSTRAP_WORKER_COUNT = 2;
const MAX_SAFE_ROUTE_LENGTH = 500;

function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function hasColonizationSquadProductionCapability(spawn: StructureSpawn): boolean {
  const minimumRequiredEnergyCapacity = Math.max(
    getBodyCost(SCOUT_BODY),
    getBodyCost(CLAIMER_BODY),
    getBodyCost(spawnProfiles.colonizerHarvester(spawn.room)),
    getBodyCost([WORK, CARRY, MOVE]),
  );

  return spawn.isActive() && spawn.room.energyCapacityAvailable >= minimumRequiredEnergyCapacity;
}

function ensureColonizationStore(): Record<string, ColonizationTask> {
  Memory.data = Memory.data || {};
  if (!Memory.data.colonization) {
    Memory.data.colonization = {};
  }

  return Memory.data.colonization;
}

function ensureConfigStore(): Record<string, import("@/types/system").CreepConfig> {
  Memory.data = Memory.data || {};
  if (!Memory.data.creepConfigs) {
    Memory.data.creepConfigs = {};
  }

  return Memory.data.creepConfigs;
}

function getOwnedSpawnRooms(): string[] {
  const rooms = Object.values(Game.spawns)
    .filter((spawn) => spawn.room.controller?.my)
    .filter((spawn) => hasColonizationSquadProductionCapability(spawn))
    .map((spawn) => spawn.room.name);

  return [...new Set(rooms)];
}

function selectSourceRoom(targetRoom: string, preferredRoom?: string): string | null {
  const ownedSpawnRooms = getOwnedSpawnRooms();
  if (ownedSpawnRooms.length === 0) {
    return null;
  }

  if (preferredRoom && ownedSpawnRooms.includes(preferredRoom)) {
    return preferredRoom;
  }

  let bestRoom: string | null = null;
  let minDistance = Infinity;

  for (const roomName of ownedSpawnRooms) {
    const distance = Game.map.getRoomLinearDistance(roomName, targetRoom);
    if (distance < minDistance) {
      minDistance = distance;
      bestRoom = roomName;
    }
  }

  return bestRoom;
}

function getPreferredSourceFromFlagName(flagName: string): string | undefined {
  if (!flagName.startsWith("CL_")) {
    return undefined;
  }

  const suffix = flagName.slice(3).trim();
  return suffix.length > 0 ? suffix : undefined;
}

function getColonizationFlags(): Flag[] {
  return Object.values(Game.flags).filter((flag) => flag.name === "CL" || flag.name.startsWith("CL_"));
}

function getTaskConfigName(
  task: ColonizationTask,
  role: "scout" | "claimer" | "harvester" | "worker",
  indexOrSourceId: string,
): string {
  return `${task.sourceRoom}:colonize:${task.targetRoom}:${role}:${indexOrSourceId}`;
}

function getTaskConfigNames(task: ColonizationTask): string[] {
  const prefix = `${task.sourceRoom}:colonize:${task.targetRoom}:`;
  return Object.keys(global.creepApi.list(prefix));
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return Object.values(Game.creeps).filter((creep) => creep.memory.configName === configName);
}

function getSpawnForRoom(roomName: string): StructureSpawn | null {
  const spawn = Object.values(Game.spawns).find((item) => item.room.name === roomName);
  return spawn || null;
}

function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  if (toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
  }
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  return Object.values(Game.spawns).some((spawn) => {
    if (!spawn.spawning) {
      return false;
    }

    return creepMemory[spawn.spawning.name]?.configName === configName;
  });
}

function upsertConfig(
  configName: string,
  config: import("@/types/system").CreepConfig,
): void {
  const store = ensureConfigStore();
  store[configName] = config;
}

function removeConfigWhenIdle(configName: string): void {
  const liveCount = getLiveCreepsByConfig(configName).length;
  if (liveCount > 0) {
    return;
  }

  const store = ensureConfigStore();
  if (store[configName]) {
    delete store[configName];
  }
}

function removeQueuedConfig(task: ColonizationTask, configName: string): void {
  const spawn = getSpawnForRoom(task.sourceRoom);
  if (!spawn?.memory.spawnList) {
    return;
  }

  spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
}

function getMyUsername(): string | null {
  const firstSpawn = Object.values(Game.spawns)[0];
  if (firstSpawn) {
    return firstSpawn.owner.username;
  }

  const firstCreep = Object.values(Game.creeps)[0];
  if (firstCreep) {
    return firstCreep.owner.username;
  }

  return null;
}

function isDangerousVisibleRoom(roomName: string, myUsername: string | null): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }

  if (room.find(FIND_HOSTILE_CREEPS).length > 0) {
    return true;
  }

  const controller = room.controller;
  if (controller?.owner && !controller.my) {
    return true;
  }

  if (controller?.reservation) {
    if (!myUsername) {
      return true;
    }

    if (controller.reservation.username !== myUsername) {
      return true;
    }
  }

  return false;
}

function estimateRouteLength(task: ColonizationTask, routeRooms: string[]): number {
  const allowedRooms = new Set(routeRooms);
  if (!allowedRooms.has(task.sourceRoom) || !allowedRooms.has(task.targetRoom)) {
    return Infinity;
  }

  const spawn = getSpawnForRoom(task.sourceRoom);
  const startPos = spawn ? spawn.pos : new RoomPosition(25, 25, task.sourceRoom);
  const targetPos = new RoomPosition(25, 25, task.targetRoom);

  const search = PathFinder.search(
    startPos,
    { pos: targetPos, range: 20 },
    {
      maxOps: 20000,
      maxRooms: Math.max(1, allowedRooms.size),
      plainCost: 2,
      swampCost: 10,
      roomCallback: (roomName) => {
        if (!allowedRooms.has(roomName)) {
          return false;
        }

        return new PathFinder.CostMatrix();
      },
    },
  );

  if (search.incomplete) {
    return Infinity;
  }

  return search.path.length;
}

function findSafeRoute(task: ColonizationTask): string[] | null {
  const myUsername = getMyUsername();
  const dangerousRooms = new Set(task.dangerousRooms ?? []);
  const route = Game.map.findRoute(task.sourceRoom, task.targetRoom, {
    routeCallback: (roomName) => {
      if (roomName === task.sourceRoom || roomName === task.targetRoom) {
        return 1;
      }

      if (dangerousRooms.has(roomName)) {
        return Infinity;
      }

      if (Game.map.getRoomStatus(roomName).status !== "normal") {
        return Infinity;
      }

      if (isDangerousVisibleRoom(roomName, myUsername)) {
        return Infinity;
      }

      return 2;
    },
  });

  if (route === ERR_NO_PATH) {
    return null;
  }

  const routeRooms: string[] = [task.sourceRoom];
  for (const step of route) {
    if (step.room === task.sourceRoom) {
      continue;
    }

    if (routeRooms[routeRooms.length - 1] !== step.room) {
      routeRooms.push(step.room);
    }
  }

  if (routeRooms[routeRooms.length - 1] !== task.targetRoom) {
    routeRooms.push(task.targetRoom);
  }

  const routeLength = estimateRouteLength(task, routeRooms);
  if (routeLength > MAX_SAFE_ROUTE_LENGTH) {
    return null;
  }

  return routeRooms;
}

function markDangerousRoom(task: ColonizationTask, roomName: string): void {
  if (roomName === task.sourceRoom) {
    return;
  }

  task.dangerousRooms = task.dangerousRooms || [];
  if (!task.dangerousRooms.includes(roomName)) {
    task.dangerousRooms.push(roomName);
  }
}

function ensureScout(task: ColonizationTask): void {
  if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
    return;
  }

  const configName = getTaskConfigName(task, "scout", "0");
  upsertConfig(configName, {
    role: "scout",
    args: [task.targetRoom, task.scoutRouteRooms.join("|")],
    roomName: task.sourceRoom,
    body: SCOUT_BODY,
  });

  const spawn = getSpawnForRoom(task.sourceRoom);
  if (!spawn) {
    return;
  }

  const hasLive = getLiveCreepsByConfig(configName).length > 0;
  const queued = spawn.memory.spawnList?.includes(configName) ?? false;
  const spawning = isConfigSpawning(configName);

  if (!hasLive && !queued && !spawning) {
    enqueueConfig(spawn, configName, true);
  }
}

function abandonColonization(task: ColonizationTask, reason: string): void {
  const configNames = getTaskConfigNames(task);
  for (const configName of configNames) {
    for (const creep of getLiveCreepsByConfig(configName)) {
      creep.suicide();
    }
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
  }

  const store = ensureColonizationStore();
  delete store[task.targetRoom];
  console.log(`[colonization] abandon ${task.targetRoom}: ${reason}`);
}

function ensureScoutSafety(task: ColonizationTask): "pending" | "safe" | "abandon" {
  if (task.scoutSafe) {
    return "safe";
  }

  const myUsername = getMyUsername();
  const scoutConfigName = getTaskConfigName(task, "scout", "0");
  const scouts = getLiveCreepsByConfig(scoutConfigName);
  for (const scout of scouts) {
    if (isDangerousVisibleRoom(scout.room.name, myUsername)) {
      if (scout.room.name !== task.targetRoom) {
        markDangerousRoom(task, scout.room.name);
        task.scoutRouteRooms = undefined;
        task.scoutSafe = false;
      }
    }
  }

  if (scouts.some((scout) => scout.room.name === task.targetRoom)) {
    if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
      const recoveredRoute = findSafeRoute(task);
      if (recoveredRoute) {
        task.scoutRouteRooms = recoveredRoute;
      }
    }

    const targetRoom = Game.rooms[task.targetRoom];
    if (targetRoom) {
      const myUsername = getMyUsername();
      const hasHostileReservation =
        !!targetRoom.controller?.reservation &&
        (!myUsername || targetRoom.controller.reservation.username !== myUsername);
      const hasInvaderCore =
        targetRoom.find(FIND_HOSTILE_STRUCTURES, {
          filter: (structure) => structure.structureType === STRUCTURE_INVADER_CORE,
        }).length > 0;
      task.mode = hasHostileReservation || hasInvaderCore ? "npcStronghold" : "normal";
      task.scoutedAt = Game.time;
    }

    task.scoutSafe = true;
    removeQueuedConfig(task, scoutConfigName);
    removeConfigWhenIdle(scoutConfigName);
    return "safe";
  }

  if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
    const routeRooms = findSafeRoute(task);
    if (!routeRooms) {
      return "abandon";
    }

    task.scoutRouteRooms = routeRooms;
  }

  ensureScout(task);
  return "pending";
}

function hasSavedPlanWithSpawn(roomName: string): boolean {
  const layout = Memory.data?.roomPlanner?.[roomName]?.layout;
  return (layout?.[STRUCTURE_SPAWN]?.length ?? 0) > 0;
}

function ensurePlanReady(task: ColonizationTask): void {
  if (hasSavedPlanWithSpawn(task.targetRoom)) {
    task.planReady = true;
    return;
  }

  task.planReady = false;

  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    return;
  }

  const planned = runPlannerForRoom(task.targetRoom);
  if (!planned) {
    return;
  }

  const saved = savePlannerForRoom(task.targetRoom);
  if (saved && hasSavedPlanWithSpawn(task.targetRoom)) {
    task.planReady = true;
  }
}

function ensureClaimer(task: ColonizationTask): void {
  const configName = getTaskConfigName(task, "claimer", "0");
  const encodedRouteRooms = task.scoutRouteRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "claimer",
    args: [task.targetRoom, encodedRouteRooms],
    roomName: task.sourceRoom,
    body: CLAIMER_BODY,
  });

  const spawn = getSpawnForRoom(task.sourceRoom);
  if (!spawn) {
    return;
  }

  const hasLive = getLiveCreepsByConfig(configName).length > 0;
  const queued = spawn.memory.spawnList?.includes(configName) ?? false;
  const spawning = isConfigSpawning(configName);

  if (!hasLive && !queued && !spawning) {
    enqueueConfig(spawn, configName, true);
  }
}

function ensureBootstrapHarvester(task: ColonizationTask, sourceId: Id<Source>): void {
  const configName = getTaskConfigName(task, "harvester", sourceId);
  const encodedRouteRooms = task.scoutRouteRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerHarvester",
    args: [task.targetRoom, sourceId, encodedRouteRooms],
    roomName: task.sourceRoom,
  });
}

function ensureBootstrapWorker(task: ColonizationTask, index: number): void {
  const configName = getTaskConfigName(task, "worker", String(index));
  const encodedRouteRooms = task.scoutRouteRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerWorker",
    args: [task.targetRoom, encodedRouteRooms],
    roomName: task.sourceRoom,
  });
}

function hasOwnedSpawnInTargetRoom(task: ColonizationTask): boolean {
  return Object.values(Game.spawns).some((spawn) => spawn.room.name === task.targetRoom);
}

function cleanupColonizationConfigs(task: ColonizationTask): boolean {
  const configNames = getTaskConfigNames(task);
  const store = ensureConfigStore();
  let removedAll = true;

  for (const configName of configNames) {
    removeQueuedConfig(task, configName);

    const config = store[configName];
    if (config?.roomName) {
      delete config.roomName;
    }

    if (isConfigSpawning(configName)) {
      removedAll = false;
      continue;
    }

    const liveCount = getLiveCreepsByConfig(configName).length;
    if (liveCount > 0) {
      removedAll = false;
      continue;
    }

    removeConfigWhenIdle(configName);
  }

  return removedAll;
}

function processTask(task: ColonizationTask): void {
  ensurePlanReady(task);

  if (hasOwnedSpawnInTargetRoom(task)) {
    task.status = "managed";
    const cleaned = cleanupColonizationConfigs(task);
    if (cleaned) {
      const store = ensureColonizationStore();
      delete store[task.targetRoom];
    }
    return;
  }

  const targetRoom = Game.rooms[task.targetRoom];
  const hasMyController = !!targetRoom?.controller?.my;
  if (!hasMyController) {
    const claimerConfigName = getTaskConfigName(task, "claimer", "0");
    removeQueuedConfig(task, claimerConfigName);
    removeConfigWhenIdle(claimerConfigName);

    const scoutSafety = ensureScoutSafety(task);
    if (scoutSafety === "abandon") {
      abandonColonization(task, "no safe route or route length exceeded 500");
      return;
    }

    if (scoutSafety !== "safe") {
      return;
    }

    if (task.status === "clearing") {
      if (!isWarRoomClearDone(task.targetRoom)) {
        requestWarRoomClear(task.targetRoom, task.sourceRoom, {
          routeRooms: task.scoutRouteRooms,
          reason: "npc_reservation",
        });
        return;
      }

      clearWarRoomTask(task.targetRoom);
      task.status = "claiming";
      task.mode = "normal";
    }

    if (task.mode === "npcStronghold") {
      task.status = "clearing";
      requestWarRoomClear(task.targetRoom, task.sourceRoom, {
        routeRooms: task.scoutRouteRooms,
        reason: "npc_reservation",
      });
      return;
    }

    task.status = "claiming";

    const scoutConfigName = getTaskConfigName(task, "scout", "0");
    removeQueuedConfig(task, scoutConfigName);
    removeConfigWhenIdle(scoutConfigName);

    if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
      const recoveredRoute = findSafeRoute(task);
      if (!recoveredRoute) {
        task.scoutSafe = false;
        return;
      }

      task.scoutRouteRooms = recoveredRoute;
    }

    ensureClaimer(task);
    return;
  }

  task.claimCompleted = true;
  task.status = task.planReady ? "bootstrapping" : "waiting_plan";
  removeConfigWhenIdle(getTaskConfigName(task, "claimer", "0"));

  if (task.status !== "bootstrapping") {
    return;
  }

  if (!targetRoom) {
    return;
  }

  const sources = targetRoom.find(FIND_SOURCES);
  for (const source of sources) {
    ensureBootstrapHarvester(task, source.id);
  }

  for (let i = 0; i < BOOTSTRAP_WORKER_COUNT; i++) {
    ensureBootstrapWorker(task, i);
  }
}

function upsertColonizationTask(flag: Flag): boolean {
  const targetRoom = flag.pos.roomName;
  const preferredRoom = getPreferredSourceFromFlagName(flag.name);
  const sourceRoom = selectSourceRoom(targetRoom, preferredRoom);

  if (!sourceRoom) {
    return false;
  }

  const store = ensureColonizationStore();
  const existing = store[targetRoom];
  const now = Game.time;

  if (existing && existing.sourceRoom !== sourceRoom) {
    cleanupColonizationConfigs(existing);
    if (existing.status === "clearing") {
      clearWarRoomTask(targetRoom);
    }
  }

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: existing?.status ?? "claiming",
    flagName: flag.name,
    planReady: existing?.planReady ?? false,
    claimCompleted: existing?.claimCompleted ?? false,
    scoutSafe: existing?.scoutSafe ?? false,
    scoutRouteRooms: existing?.scoutRouteRooms,
    dangerousRooms: existing?.dangerousRooms ?? [],
    mode: existing?.mode,
    scoutedAt: existing?.scoutedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  return true;
}

export function isColonizationBootstrapRoom(roomName: string): boolean {
  const task = Memory.data?.colonization?.[roomName];
  return task?.status === "bootstrapping";
}

export function runColonizationByFlag(): void {
  const flags = getColonizationFlags();
  for (const flag of flags) {
    const scheduled = upsertColonizationTask(flag);
    if (!scheduled) {
      continue;
    }

    flag.remove();
  }

  const store = ensureColonizationStore();
  for (const task of Object.values(store)) {
    processTask(task);
    task.updatedAt = Game.time;
  }
}
