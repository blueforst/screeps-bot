import { spawnProfiles } from "@/config/spawnProfiles";
import { spawnMaxCarrierRaw } from "@/runtime/consoleCommands";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";
const CARRIER_PRESPAWN_BUFFER_TICKS = 30;

function getSpawnRolePriority(role: CreepConfig["role"] | undefined): number {
  if (role === "carrier") {
    return 0;
  }

  if (role === "harvester" || role === "miner") {
    return 1;
  }

  if (role === "meleeAttacker" || role === "healer") {
    return 2;
  }

  return 3;
}

function ensureQueue(spawn: StructureSpawn): string[] {
  if (!spawn.memory.spawnList) {
    spawn.memory.spawnList = [];
  }

  return spawn.memory.spawnList;
}

function isConfigQueued(spawn: StructureSpawn, configName: string): boolean {
  return spawn.memory.spawnList?.includes(configName) ?? false;
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  return Object.values(Game.spawns).some((spawn) => {
    if (!spawn.spawning) {
      return false;
    }

    const spawningName = spawn.spawning.name;
    return creepMemory[spawningName]?.configName === configName;
  });
}

function getConfigCreeps(configName: string): Creep[] {
  return Object.values(Game.creeps).filter((creep) => creep.memory.configName === configName);
}

function getSourceIdFromConfig(config: CreepConfig): Id<Source> | undefined {
  if (config.role === "colonizerHarvester") {
    const sourceId = config.args[1];
    return sourceId ? (sourceId as Id<Source>) : undefined;
  }

  if (config.role === "harvester" || config.role === "miner") {
    const sourceId = config.args[0];
    return sourceId ? (sourceId as Id<Source>) : undefined;
  }

  return undefined;
}

function getSourceWorkerWorkPos(config: CreepConfig): RoomPosition | null {
  const sourceId = getSourceIdFromConfig(config);
  if (!sourceId) {
    return null;
  }

  const source = Game.getObjectById(sourceId);
  if (!source) {
    return null;
  }

  const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
  });
  if (containers.length > 0) {
    return containers[0].pos;
  }

  return source.pos;
}

function getSpawnBody(spawn: StructureSpawn, configName: string): BodyPartConstant[] {
  const config = getCreepConfigService().get(configName);
  if (!config) {
    return [WORK, MOVE];
  }

  if (config.body && config.body.length > 0) {
    return config.body;
  }

  return spawnProfiles[config.role](spawn.room);
}

function getSpawnTime(spawn: StructureSpawn, configName: string): number {
  const body = getSpawnBody(spawn, configName);
  return body.length * CREEP_SPAWN_TIME;
}

function estimateSourceWorkerPreSpawnThreshold(spawn: StructureSpawn, configName: string, config: CreepConfig): number {
  const workPos = getSourceWorkerWorkPos(config);
  if (!workPos) {
    return 0;
  }

  const path = spawn.pos.findPathTo(workPos, { ignoreCreeps: true, swampCost: 2 });
  const commuteTime = path.length;
  const produceTime = getSpawnTime(spawn, configName);

  return commuteTime + produceTime;
}

function shouldPreSpawnCarrier(spawn: StructureSpawn, configName: string): boolean {
  const creeps = getConfigCreeps(configName);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = getSpawnTime(spawn, configName) + CARRIER_PRESPAWN_BUFFER_TICKS;
  const soonestDying = creeps.reduce((minCreep, creep) =>
    creep.ticksToLive < minCreep.ticksToLive ? creep : minCreep,
  );

  return soonestDying.ticksToLive <= threshold;
}

function shouldPreSpawnSourceWorker(spawn: StructureSpawn, configName: string, config: CreepConfig): boolean {
  const creeps = getConfigCreeps(configName);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = estimateSourceWorkerPreSpawnThreshold(spawn, configName, config);
  const soonestDying = creeps.reduce((minCreep, creep) =>
    creep.ticksToLive < minCreep.ticksToLive ? creep : minCreep,
  );

  return soonestDying.ticksToLive <= threshold;
}

function shouldQueueConfig(spawn: StructureSpawn, configName: string, config: CreepConfig): boolean {
  if (isConfigQueued(spawn, configName) || isConfigSpawning(configName)) {
    return false;
  }

  if (config.role === "harvester" || config.role === "miner" || config.role === "colonizerHarvester") {
    return shouldPreSpawnSourceWorker(spawn, configName, config);
  }

  if (config.role === "carrier") {
    return shouldPreSpawnCarrier(spawn, configName);
  }

  return getConfigCreeps(configName).length === 0;
}

function queueConfig(spawn: StructureSpawn, configName: string, options?: { toFront?: boolean }): void {
  const queue = ensureQueue(spawn);

  if (options?.toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((item) => item !== configName)];
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
  }
}

function queueMissingConfig(spawn: StructureSpawn, configName: string, config: CreepConfig): void {
  if (shouldQueueConfig(spawn, configName, config)) {
    const shouldInsertCarrierAtFront = config.role === "carrier" && getConfigCreeps(configName).length === 0;
    queueConfig(spawn, configName, { toFront: shouldInsertCarrierAtFront });
  }
}

function prioritizeSpawnQueue(spawn: StructureSpawn): void {
  const queue = ensureQueue(spawn);
  if (queue.length < 2) {
    return;
  }

  const creepConfigs = getCreepConfigService();

  spawn.memory.spawnList = [...queue]
    .map((configName, index) => {
      const role = creepConfigs.get(configName)?.role;
      return {
        configName,
        index,
        priority: getSpawnRolePriority(role),
      };
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return a.index - b.index;
    })
    .map((item) => item.configName);
}

function hasLiveCarrierInRoom(roomName: string): boolean {
  return Object.values(Game.creeps).some((creep) => creep.memory.role === "carrier" && creep.room.name === roomName);
}

function hasSpawningCarrierInRoom(roomName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const creepConfigs = getCreepConfigService();
  return Object.values(Game.spawns).some((spawn) => {
    if (spawn.room.name !== roomName || !spawn.spawning) {
      return false;
    }

    const spawningName = spawn.spawning.name;
    const configName = creepMemory[spawningName]?.configName;
    if (!configName) {
      return false;
    }

    const config = creepConfigs.get(configName);
    return config?.role === "carrier";
  });
}

function ensureEmergencyCarrier(spawn: StructureSpawn): void {
  const roomName = spawn.room.name;
  if (hasLiveCarrierInRoom(roomName) || hasSpawningCarrierInRoom(roomName)) {
    return;
  }

  spawnMaxCarrierRaw(roomName);
}

export function scheduleSpawnTasks(): void {
  const spawnByRoom = new Map<string, StructureSpawn>();
  Object.values(Game.spawns).forEach((spawn) => {
    if (!spawnByRoom.has(spawn.room.name)) {
      spawnByRoom.set(spawn.room.name, spawn);
    }
  });

  for (const spawn of spawnByRoom.values()) {
    ensureEmergencyCarrier(spawn);
  }

  const configs = getCreepConfigService().list();
  for (const [configName, config] of Object.entries(configs)) {
    if (!config.roomName) {
      continue;
    }

    const spawn = spawnByRoom.get(config.roomName);
    if (!spawn) {
      continue;
    }

    queueMissingConfig(spawn, configName, config);
  }

  for (const spawn of spawnByRoom.values()) {
    prioritizeSpawnQueue(spawn);
  }
}
