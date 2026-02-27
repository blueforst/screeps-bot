import { runPlannerForRoom, savePlannerForRoom } from "@/modules/autoplanner";

type ColonizationStatus = "claiming" | "waiting_plan" | "bootstrapping" | "managed";

interface ColonizationTask {
  targetRoom: string;
  sourceRoom: string;
  status: ColonizationStatus;
  flagName: string;
  planReady: boolean;
  claimCompleted: boolean;
  createdAt: number;
  updatedAt: number;
}

const CLAIMER_BODY: BodyPartConstant[] = [CLAIM, MOVE];
const BOOTSTRAP_WORKER_COUNT = 2;

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
  return Object.values(Game.spawns)
    .filter((spawn) => spawn.room.controller?.my)
    .map((spawn) => spawn.room.name);
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

function getTaskConfigName(task: ColonizationTask, role: "claimer" | "harvester" | "worker", indexOrSourceId: string): string {
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

function ensurePlanReady(task: ColonizationTask): void {
  if (task.planReady || Memory.data?.roomPlanner?.[task.targetRoom]) {
    task.planReady = true;
    return;
  }

  const planned = runPlannerForRoom(task.targetRoom);
  if (!planned) {
    return;
  }

  const saved = savePlannerForRoom(task.targetRoom);
  if (saved) {
    task.planReady = true;
  }
}

function ensureClaimer(task: ColonizationTask): void {
  const configName = getTaskConfigName(task, "claimer", "0");
  upsertConfig(configName, {
    role: "claimer",
    args: [task.targetRoom],
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
  upsertConfig(configName, {
    role: "colonizerHarvester",
    args: [task.targetRoom, sourceId],
    roomName: task.sourceRoom,
  });
}

function ensureBootstrapWorker(task: ColonizationTask, index: number): void {
  const configName = getTaskConfigName(task, "worker", String(index));
  upsertConfig(configName, {
    role: "colonizerWorker",
    args: [task.targetRoom],
    roomName: task.sourceRoom,
  });
}

function hasOwnedSpawnInTargetRoom(task: ColonizationTask): boolean {
  return Object.values(Game.spawns).some((spawn) => spawn.room.name === task.targetRoom);
}

function cleanupColonizationConfigs(task: ColonizationTask): boolean {
  const configNames = getTaskConfigNames(task);
  let removedAll = true;

  for (const configName of configNames) {
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
    task.status = "claiming";
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

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: existing?.status ?? "claiming",
    flagName: flag.name,
    planReady: existing?.planReady ?? false,
    claimCompleted: existing?.claimCompleted ?? false,
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
