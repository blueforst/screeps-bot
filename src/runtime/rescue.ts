import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

type RescueStatus = "bootstrapping" | "managed";

interface RescueTask {
  targetRoom: string;
  sourceRoom: string;
  status: RescueStatus;
  routeRooms?: string[];
  createdAt: number;
  updatedAt: number;
}

const RESCUE_WORKER_COUNT = 3;

function ensureRescueStore(): Record<string, RescueTask> {
  const data = getMemoryService().ensureData();
  if (!data.rescue) {
    data.rescue = {};
  }
  return data.rescue;
}

function ensureConfigStore(): Record<string, import("@/types/system").CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function getOwnedSpawnRooms(): string[] {
  const tickContext = getTickContextService();
  const rooms = tickContext
    .getMyRooms()
    .flatMap((room) => tickContext.getSpawnsByRoom(room.name))
    .filter((spawn) => spawn.isActive() && spawn.room.energyCapacityAvailable >= 300)
    .map((spawn) => spawn.room.name);
  return [...new Set(rooms)];
}

function selectSourceRoom(targetRoom: string, preferredRoom?: string): string | null {
  const ownedSpawnRooms = getOwnedSpawnRooms();
  if (ownedSpawnRooms.length === 0) return null;

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
  if (!flagName.startsWith("RESCUE_")) return undefined;
  const suffix = flagName.slice(7).trim();
  return suffix.length > 0 ? suffix : undefined;
}

function getRescueFlags(): Flag[] {
  return Object.values(Game.flags).filter(
    (flag) => flag.name === "RESCUE" || flag.name.startsWith("RESCUE_"),
  );
}

function getTaskConfigName(task: RescueTask, role: "harvester" | "worker", indexOrSourceId: string): string {
  return `${task.sourceRoom}:rescue:${task.targetRoom}:${role}:${indexOrSourceId}`;
}

function getTaskConfigNames(task: RescueTask): string[] {
  const prefix = `${task.sourceRoom}:rescue:${task.targetRoom}:`;
  return Object.keys(getCreepConfigService().list(prefix));
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName);
}

function getSpawnForRoom(roomName: string): StructureSpawn | null {
  return getTickContextService().getPrimarySpawnByRoom(roomName) || null;
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) continue;
      if (creepMemory[spawn.spawning.name]?.configName === configName) return true;
    }
  }
  return false;
}

function upsertConfig(configName: string, config: import("@/types/system").CreepConfig): void {
  ensureConfigStore()[configName] = config;
}

function removeQueuedConfig(task: RescueTask, configName: string): void {
  const spawn = getSpawnForRoom(task.sourceRoom);
  if (!spawn?.memory.spawnList) return;
  spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
}

function ensureRescueHarvester(task: RescueTask, sourceId: Id<Source>): void {
  const configName = getTaskConfigName(task, "harvester", sourceId);
  const encodedRoute = task.routeRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerHarvester",
    args: [task.targetRoom, sourceId, encodedRoute],
    roomName: task.sourceRoom,
  });
}

function ensureRescueWorker(task: RescueTask, index: number): void {
  const configName = getTaskConfigName(task, "worker", String(index));
  const encodedRoute = task.routeRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerWorker",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
  });
}

function cleanupRescueConfigs(task: RescueTask): boolean {
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

    if (store[configName]) {
      delete store[configName];
    }
  }

  return removedAll;
}

function hasOwnedSpawnInTargetRoom(task: RescueTask): boolean {
  return getTickContextService().getSpawnsByRoom(task.targetRoom).length > 0;
}

function computeRoute(task: RescueTask): string[] | null {
  const route = Game.map.findRoute(task.sourceRoom, task.targetRoom, {
    routeCallback: (roomName) => {
      if (roomName === task.sourceRoom || roomName === task.targetRoom) return 1;
      if (Game.map.getRoomStatus(roomName).status !== "normal") return Infinity;
      return 2;
    },
  });

  if (route === ERR_NO_PATH) return null;

  const routeRooms: string[] = [task.sourceRoom];
  for (const step of route) {
    if (step.room !== routeRooms[routeRooms.length - 1]) {
      routeRooms.push(step.room);
    }
  }

  if (routeRooms[routeRooms.length - 1] !== task.targetRoom) {
    routeRooms.push(task.targetRoom);
  }

  return routeRooms;
}

function processRescueTask(task: RescueTask): void {
  if (hasOwnedSpawnInTargetRoom(task)) {
    task.status = "managed";
    const cleaned = cleanupRescueConfigs(task);
    if (cleaned) {
      const store = ensureRescueStore();
      delete store[task.targetRoom];
      console.log(`[rescue] complete: ${task.targetRoom} spawn rebuilt, rescue squad recalled`);
    }
    return;
  }

  // Ensure route is computed once
  if (!task.routeRooms || task.routeRooms.length === 0) {
    const route = computeRoute(task);
    if (!route) {
      console.log(`[rescue] no route found from ${task.sourceRoom} to ${task.targetRoom}`);
      return;
    }
    task.routeRooms = route;
    console.log(`[rescue] route: ${route.join(" → ")}`);
  }

  // Always maintain workers: they travel first and provide vision
  for (let i = 0; i < RESCUE_WORKER_COUNT; i++) {
    ensureRescueWorker(task, i);
  }

  // Maintain harvesters once we have vision of the target room
  const targetRoom = Game.rooms[task.targetRoom];
  if (targetRoom) {
    const sources = targetRoom.find(FIND_SOURCES);
    for (const source of sources) {
      ensureRescueHarvester(task, source.id);
    }
  }
}

function upsertRescueTask(flag: Flag): boolean {
  const targetRoom = flag.pos.roomName;
  const preferredRoom = getPreferredSourceFromFlagName(flag.name);
  const sourceRoom = selectSourceRoom(targetRoom, preferredRoom);

  if (!sourceRoom) return false;

  if (getTickContextService().getSpawnsByRoom(targetRoom).length > 0) {
    console.log(`[rescue] flag ignored: ${flag.name} target=${targetRoom} reason=spawn_exists`);
    return true;
  }

  const store = ensureRescueStore();
  const existing = store[targetRoom];
  const now = Game.time;

  if (existing && existing.sourceRoom !== sourceRoom) {
    cleanupRescueConfigs(existing);
  }

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: existing?.status ?? "bootstrapping",
    routeRooms: existing?.routeRooms,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  return true;
}

export function isRescueRoom(roomName: string): boolean {
  return !!Memory.data?.rescue?.[roomName];
}

export function runRescueByFlag(): void {
  const flags = getRescueFlags();
  for (const flag of flags) {
    const scheduled = upsertRescueTask(flag);
    if (!scheduled) {
      console.log(`[rescue] flag ignored: ${flag.name} room=${flag.pos.roomName} reason=no_source_room`);
      continue;
    }

    flag.remove();
    const task = Memory.data?.rescue?.[flag.pos.roomName];
    if (task) {
      console.log(`[rescue] started: target=${task.targetRoom} source=${task.sourceRoom}`);
    }
  }

  const store = ensureRescueStore();
  for (const task of Object.values(store)) {
    processRescueTask(task);
    task.updatedAt = Game.time;
  }
}
