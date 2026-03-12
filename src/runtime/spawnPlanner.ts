import { spawnProfiles } from "@/config/spawnProfiles";
import { spawnMaxCarrierRaw } from "@/runtime/emergencySpawning";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";
const CARRIER_PRESPAWN_BUFFER_TICKS = 30;

interface SpawnPlanningContext {
  spawnTimeByConfigName: Map<string, number>;
  sourceWorkerThresholdByKey: Map<string, number>;
  configCreepsByName: Map<string, Creep[]>;
  spawningConfigNames: Set<string>;
}

function getSpawnRolePriority(role: CreepConfig["role"] | undefined): number {
  if (role === "carrier") {
    return 0;
  }

  if (role === "harvester" || role === "miner") {
    return 1;
  }

  if (role === "mineralHarvester") {
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

function createSpawnPlanningContext(): SpawnPlanningContext {
  const spawningConfigNames = new Set<string>();
  const tickContext = getTickContextService();
  const creepMemory = Memory.creeps || {};

  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      const configName = creepMemory[spawn.spawning.name]?.configName;
      if (typeof configName === "string") {
        spawningConfigNames.add(configName);
      }
    }
  }

  return {
    spawnTimeByConfigName: new Map<string, number>(),
    sourceWorkerThresholdByKey: new Map<string, number>(),
    configCreepsByName: new Map<string, Creep[]>(),
    spawningConfigNames,
  };
}

function isConfigSpawning(configName: string, context: SpawnPlanningContext): boolean {
  return context.spawningConfigNames.has(configName);
}

function getConfigCreeps(configName: string, context?: SpawnPlanningContext): Creep[] {
  if (!context) {
    return getTickContextService().getCreepsByConfigName(configName);
  }

  const cached = context.configCreepsByName.get(configName);
  if (cached) {
    return cached;
  }

  const creeps = getTickContextService().getCreepsByConfigName(configName);
  context.configCreepsByName.set(configName, creeps);
  return creeps;
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

function getMineralIdFromConfig(config: CreepConfig): Id<Mineral> | undefined {
  if (config.role !== "mineralHarvester") {
    return undefined;
  }

  const mineralId = config.args[0];
  return mineralId ? (mineralId as Id<Mineral>) : undefined;
}

function getSourceWorkerWorkPos(config: CreepConfig): RoomPosition | null {
  const mineralId = getMineralIdFromConfig(config);
  if (mineralId) {
    const mineral = Game.getObjectById(mineralId);
    if (!mineral) {
      return null;
    }

    const containers = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
    });
    if (containers.length > 0) {
      return containers[0].pos;
    }

    return mineral.pos;
  }

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

function getSpawnTime(spawn: StructureSpawn, configName: string, context?: SpawnPlanningContext): number {
  if (context) {
    const cached = context.spawnTimeByConfigName.get(configName);
    if (cached !== undefined) {
      return cached;
    }
  }

  const body = getSpawnBody(spawn, configName);
  const spawnTime = body.length * CREEP_SPAWN_TIME;
  context?.spawnTimeByConfigName.set(configName, spawnTime);
  return spawnTime;
}

function estimateSourceWorkerPreSpawnThreshold(
  spawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): number {
  const workPos = getSourceWorkerWorkPos(config);
  if (!workPos) {
    return 0;
  }

  const cacheKey = `${spawn.id}:${configName}:${workPos.roomName}:${workPos.x}:${workPos.y}`;
  const cached = context?.sourceWorkerThresholdByKey.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const path = spawn.pos.findPathTo(workPos, { ignoreCreeps: true, swampCost: 2 });
  const commuteTime = path.length;
  const produceTime = getSpawnTime(spawn, configName, context);
  const threshold = commuteTime + produceTime;

  context?.sourceWorkerThresholdByKey.set(cacheKey, threshold);

  return threshold;
}

function shouldPreSpawnCarrier(spawn: StructureSpawn, configName: string, context?: SpawnPlanningContext): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = getSpawnTime(spawn, configName, context) + CARRIER_PRESPAWN_BUFFER_TICKS;
  const soonestDying = creeps.reduce((minCreep, creep) =>
    creep.ticksToLive < minCreep.ticksToLive ? creep : minCreep,
  );

  return soonestDying.ticksToLive <= threshold;
}

function shouldPreSpawnSourceWorker(
  spawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = estimateSourceWorkerPreSpawnThreshold(spawn, configName, config, context);
  const soonestDying = creeps.reduce((minCreep, creep) =>
    creep.ticksToLive < minCreep.ticksToLive ? creep : minCreep,
  );

  return soonestDying.ticksToLive <= threshold;
}

function shouldQueueConfig(
  spawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): boolean {
  if (isConfigQueued(spawn, configName) || isConfigSpawning(configName, context || createSpawnPlanningContext())) {
    return false;
  }

  if (
    config.role === "harvester" ||
    config.role === "miner" ||
    config.role === "mineralHarvester" ||
    config.role === "colonizerHarvester"
  ) {
    return shouldPreSpawnSourceWorker(spawn, configName, config, context);
  }

  if (config.role === "carrier") {
    return shouldPreSpawnCarrier(spawn, configName, context);
  }

  return getConfigCreeps(configName, context).length === 0;
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

function queueMissingConfig(
  spawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): void {
  if (shouldQueueConfig(spawn, configName, config, context)) {
    const shouldInsertCarrierAtFront = config.role === "carrier" && getConfigCreeps(configName, context).length === 0;
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
  return getTickContextService().getCreepsByRoom(roomName).some((creep) => creep.memory.role === "carrier");
}

function hasSpawningCarrierInRoom(roomName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const creepConfigs = getCreepConfigService();
  for (const spawn of getTickContextService().getSpawnsByRoom(roomName)) {
    if (!spawn.spawning) {
      continue;
    }

    const spawningName = spawn.spawning.name;
    const configName = creepMemory[spawningName]?.configName;
    if (!configName) {
      continue;
    }

    const config = creepConfigs.get(configName);
    if (config?.role === "carrier") {
      return true;
    }
  }

  return false;
}

function ensureEmergencyCarrier(spawn: StructureSpawn): void {
  const roomName = spawn.room.name;
  if (hasLiveCarrierInRoom(roomName) || hasSpawningCarrierInRoom(roomName)) {
    return;
  }

  spawnMaxCarrierRaw(roomName);
}

export function scheduleSpawnTasks(): void {
  const tickContext = getTickContextService();
  const planningContext = createSpawnPlanningContext();
  const spawnByRoom = new Map<string, StructureSpawn>();
  for (const room of tickContext.getMyRooms()) {
    const spawn = tickContext.getPrimarySpawnByRoom(room.name);
    if (spawn) {
      spawnByRoom.set(room.name, spawn);
    }
  }

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

    queueMissingConfig(spawn, configName, config, planningContext);
  }

  for (const spawn of spawnByRoom.values()) {
    prioritizeSpawnQueue(spawn);
  }
}
