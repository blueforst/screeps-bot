import { isSpawnActive } from "@/runtime/tickContext";
import { spawnProfiles } from "@/config/spawnProfiles";
import { isDefenseMode } from "@/runtime/defenseMode";
import { spawnMaxCarrierRaw } from "@/runtime/emergencySpawning";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import { isInsideSafeZone } from "@/runtime/safeZoneHelpers";
import type { CreepConfig } from "@/types/system";

const CARRIER_PRESPAWN_BUFFER_TICKS = 30;
const SOURCE_WORKER_COMMUTE_CACHE_TTL = 1000;

interface SpawnPlanningContext {
  spawnTimeByConfigName: Map<string, number>;
  sourceWorkerThresholdByKey: Map<string, number>;
  configCreepsByName: Map<string, Creep[]>;
  spawningConfigNames: Set<string>;
}

const RESERVER_PRESPAWN_BUFFER_TICKS = 100;

function getSpawnRolePriority(role: CreepConfig["role"] | undefined): number {
  if (role === "carrier" || role === "remoteCarrier") {
    return 0;
  }

  if (role === "harvester" || role === "miner" || role === "colonizerHarvester" || role === "remoteMiningReserver") {
    return 1;
  }

  if (role === "mineralHarvester") {
    return 1;
  }

  if (role === "meleeAttacker" || role === "healer") {
    return 2;
  }

  if (role === "powerBankAttacker" || role === "powerBankHealer") {
    return 0;
  }

  if (role === "powerBankHauler") {
    return 1;
  }

  return 3;
}

function getSpawnConfigPriority(roomName: string, configName: string): number {
  const config = getCreepConfigService().get(configName);
  if (isEmergencyCarrierConfigName(roomName, configName)) {
    return 0;
  }
  if (config?.role === "carrier" && config.roomName === roomName) {
    return 1;
  }
  if (configName.includes(":war:")) {
    return 2;
  }
  if (config?.role === "hubUpgrader") {
    return 3;
  }
  return 4 + getSpawnRolePriority(config?.role);
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

function ensureSpawnPlannerRuntimeStore(): NonNullable<NonNullable<Memory["runtime"]>["spawnPlanner"]> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.spawnPlanner = runtime.spawnPlanner || {
    sourceWorkerCommutes: {},
  };

  return runtime.spawnPlanner;
}

function getCachedSourceWorkerCommute(cacheKey: string): number | undefined {
  const cache = Memory.runtime?.spawnPlanner?.sourceWorkerCommutes?.[cacheKey];
  if (!cache) {
    return undefined;
  }

  if (Game.time - cache.updatedAt > SOURCE_WORKER_COMMUTE_CACHE_TTL) {
    delete Memory.runtime?.spawnPlanner?.sourceWorkerCommutes?.[cacheKey];
    return undefined;
  }

  return cache.commute;
}

function setCachedSourceWorkerCommute(cacheKey: string, commute: number): void {
  const store = ensureSpawnPlannerRuntimeStore();
  store.sourceWorkerCommutes[cacheKey] = {
    commute,
    updatedAt: Game.time,
  };
}

function getRoomCenterAnchor(spawn: StructureSpawn): RoomPosition {
  return spawn.room.storage?.pos || spawn.pos;
}

function getAnchorSpawnBuffer(anchor: RoomPosition, spawn: StructureSpawn): number {
  return Math.max(Math.abs(anchor.x - spawn.pos.x), Math.abs(anchor.y - spawn.pos.y));
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

  return getPlannedSourceContainerPos(source) ?? source.pos;
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

  const anchor = getRoomCenterAnchor(spawn);
  const anchorBuffer = getAnchorSpawnBuffer(anchor, spawn);
  const cacheKey = `${spawn.room.name}:${anchor.roomName}:${anchor.x}:${anchor.y}:${workPos.roomName}:${workPos.x}:${workPos.y}`;
  const cached = context?.sourceWorkerThresholdByKey.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const persistedCommute = getCachedSourceWorkerCommute(cacheKey);
  if (persistedCommute !== undefined) {
    const threshold = persistedCommute + anchorBuffer + getSpawnTime(spawn, configName, context);
    context?.sourceWorkerThresholdByKey.set(cacheKey, threshold);
    return threshold;
  }

  const path = anchor.findPathTo(workPos, { ignoreCreeps: true, swampCost: 2 });
  const commuteTime = path.length + anchorBuffer;
  const produceTime = getSpawnTime(spawn, configName, context);
  const threshold = commuteTime + produceTime;

  context?.sourceWorkerThresholdByKey.set(cacheKey, threshold);
  setCachedSourceWorkerCommute(cacheKey, commuteTime - anchorBuffer);

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

function shouldPreSpawnReserver(
  spawn: StructureSpawn,
  configName: string,
  context?: SpawnPlanningContext,
): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = getSpawnTime(spawn, configName, context) + RESERVER_PRESPAWN_BUFFER_TICKS;
  const soonestDying = creeps.reduce((minCreep, creep) =>
    creep.ticksToLive < minCreep.ticksToLive ? creep : minCreep,
  );

  return soonestDying.ticksToLive <= threshold;
}

function shouldQueueConfig(
  spawns: StructureSpawn[],
  estimateSpawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): boolean {
  if (isConfigQueuedInSpawns(spawns, configName) || isConfigSpawning(configName, context || createSpawnPlanningContext())) {
    return false;
  }

  if (config.spawnOnce?.queuedAt !== undefined) {
    return false;
  }

  if (config.roomName && shouldSkipConfigInDefenseMode(config)) {
    return false;
  }

  if (config.role === "mineralHarvester") {
    const mineralId = getMineralIdFromConfig(config);
    if (mineralId) {
      const mineral = Game.getObjectById<Mineral>(mineralId);
      if (!mineral || mineral.mineralAmount <= 0) {
        return false;
      }
    } else {
      return false;
    }

    return shouldPreSpawnSourceWorker(estimateSpawn, configName, config, context);
  }

  if (
    config.role === "harvester" ||
    config.role === "miner" ||
    config.role === "colonizerHarvester"
  ) {
    return shouldPreSpawnSourceWorker(estimateSpawn, configName, config, context);
  }

  if (config.role === "carrier") {
    return shouldPreSpawnCarrier(estimateSpawn, configName, context);
  }

  if (config.role === "remoteMiningReserver") {
    return shouldPreSpawnReserver(estimateSpawn, configName, context);
  }

  return getConfigCreeps(configName, context).length === 0;
}

function isOutboundNonWarRole(role: CreepConfig["role"]): boolean {
  return role === "colonizerHarvester" ||
    role === "colonizerWorker" ||
    role === "crossShardColonizerHarvester" ||
    role === "crossShardColonizerWorker" ||
    role === "crossShardClaimer" ||
    role === "remoteCarrier" ||
    role === "remoteMiningCarrier" ||
    role === "remoteMiningReserver" ||
    role === "remoteWorker" ||
    role === "remoteDefender" ||
    role === "claimer" ||
    role === "scout" ||
    role === "powerBankScout" ||
    role === "powerBankAttacker" ||
    role === "powerBankHealer" ||
    role === "powerBankHauler";
}

function isWorkPositionOutsideSafeZone(roomName: string, workPos: RoomPosition | null): boolean {
  if (!workPos) {
    return false;
  }

  const safeZone = getSafeZone(roomName);
  if (safeZone.size === 0) {
    return false;
  }

  return workPos.roomName !== roomName || !isInsideSafeZone(workPos, safeZone);
}

function shouldSkipConfigInDefenseMode(config: CreepConfig): boolean {
  const roomName = config.roomName;
  if (!roomName || !isDefenseMode(roomName)) {
    return false;
  }

  if (isOutboundNonWarRole(config.role)) {
    return true;
  }

  if (config.role === "harvester" || config.role === "miner" || config.role === "mineralHarvester") {
    return isWorkPositionOutsideSafeZone(roomName, getSourceWorkerWorkPos(config));
  }

  return false;
}

function queueConfig(spawn: StructureSpawn, configName: string, options?: { toFront?: boolean }): void {
  const queue = ensureQueue(spawn);
  const config = getCreepConfigService().get(configName);

  if (options?.toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((item) => item !== configName)];
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
  }
}

function queueMissingConfig(
  spawns: StructureSpawn[],
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): void {
  const emergencySpawn = config.role === "carrier" && config.roomName
    ? findQueuedEmergencyCarrierSpawn(spawns, config.roomName)
    : undefined;
  const targetSpawn = emergencySpawn || selectLeastLoadedSpawn(spawns);
  if (!targetSpawn) {
    return;
  }

  if (shouldQueueConfig(spawns, targetSpawn, configName, config, context)) {
    const shouldInsertCarrierAtFront = !emergencySpawn && config.role === "carrier" && getConfigCreeps(configName, context).length === 0;
    queueConfig(targetSpawn, configName, { toFront: shouldInsertCarrierAtFront });
  }
}

function isConfigQueuedInSpawns(spawns: StructureSpawn[], configName: string): boolean {
  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;
  return candidates.some((spawn) => isConfigQueued(spawn, configName));
}

function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;

  return [...candidates].sort((left, right) => {
    const loadDiff = getSpawnQueueLoad(left) - getSpawnQueueLoad(right);
    if (loadDiff !== 0) return loadDiff;
    return left.name.localeCompare(right.name);
  })[0];
}

function findQueuedEmergencyCarrierSpawn(spawns: StructureSpawn[], roomName: string): StructureSpawn | undefined {
  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;
  return candidates.find((spawn) =>
    spawn.memory.spawnList?.some((configName) => isEmergencyCarrierConfigName(roomName, configName)),
  );
}

function queuePowerBankHaulerConfig(
  spawns: StructureSpawn[],
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): void {
  if (spawns.length === 0) return;
  if (isPowerBankHaulingExhausted(configName)) return;
  if (isConfigQueuedInSpawns(spawns, configName)) return;
  if (isConfigSpawning(configName, context)) return;
  if (config.roomName && shouldSkipConfigInDefenseMode(config)) return;
  if (getConfigCreeps(configName, context).length > 0) return;

  const targetSpawn = selectLeastLoadedSpawn(spawns);
  if (targetSpawn) {
    queueConfig(targetSpawn, configName);
  }
}

function isPowerBankHaulingExhausted(configName: string): boolean {
  const parts = configName.split(":");
  if (parts.length < 5 || parts[1] !== "powerbank" || parts[3] !== "hauler") return false;

  const [sourceRoom, , targetRoom] = parts;
  const tasks = Memory.data?.powerBankHarvest;
  if (!tasks) return false;

  return Object.values(tasks).some((task) =>
    task.sourceRoom === sourceRoom &&
    task.targetRoom === targetRoom &&
    task.status === "hauling" &&
    task.haulingEmptySince !== undefined,
  );
}

function prioritizeSpawnQueue(spawn: StructureSpawn): void {
  const queue = ensureQueue(spawn);
  if (queue.length < 2) {
    return;
  }

  let previousPriority = getSpawnConfigPriority(spawn.room.name, queue[0]);
  for (let index = 1; index < queue.length; index++) {
    const priority = getSpawnConfigPriority(spawn.room.name, queue[index]);
    if (priority < previousPriority) {
      spawn.memory.spawnList = [...queue]
        .map((configName, queueIndex) => {
          return {
            configName,
            index: queueIndex,
            priority: getSpawnConfigPriority(spawn.room.name, configName),
          };
        })
        .sort((a, b) => {
          if (a.priority !== b.priority) {
            return a.priority - b.priority;
          }

          return a.index - b.index;
        })
        .map((item) => item.configName);
      return;
    }

    previousPriority = priority;
  }
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
    const spawningMemory = creepMemory[spawningName];
    if (spawningMemory?.role === "carrier") {
      return true;
    }

    const configName = spawningMemory?.configName;
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

function isEmergencyCarrierConfigName(roomName: string, configName: string): boolean {
  return configName.startsWith(`${roomName}:manual:maxcarrier:`);
}

function isSpawnableEmergencyCarrierConfig(spawn: StructureSpawn, roomName: string, configName: string): boolean {
  if (!isEmergencyCarrierConfigName(roomName, configName)) {
    return false;
  }

  const config = getCreepConfigService().get(configName);
  if (config?.role !== "carrier" || config.roomName !== roomName || !config.body ||
      config.body.length === 0 || config.body.length > MAX_CREEP_SIZE) {
    return false;
  }

  const bodyCost = config.body.reduce((sum, part) => {
    const partCost = BODYPART_COST[part];
    return typeof partCost === "number" && Number.isFinite(partCost) ? sum + partCost : Number.NaN;
  }, 0);
  return Number.isFinite(bodyCost) && bodyCost <= spawn.room.energyCapacityAvailable;
}

function pruneEmergencyCarrierQueue(roomName: string, keepOne: boolean): boolean {
  const creepConfigs = getCreepConfigService();
  const spawns = getTickContextService().getSpawnsByRoom(roomName);
  const activeSpawns = spawns.filter(isSpawnActive);
  const eligibleSpawns = new Set(activeSpawns.length > 0 ? activeSpawns : spawns);
  let kept = false;

  for (const spawn of spawns) {
    const queue = spawn.memory.spawnList;
    if (!queue?.some((configName) => isEmergencyCarrierConfigName(roomName, configName))) {
      continue;
    }

    spawn.memory.spawnList = queue.filter((configName) => {
      if (!isEmergencyCarrierConfigName(roomName, configName)) {
        return true;
      }

      if (!isSpawnableEmergencyCarrierConfig(spawn, roomName, configName)) {
        creepConfigs.remove(configName);
        return false;
      }

      if (keepOne && !kept && eligibleSpawns.has(spawn)) {
        kept = true;
        return true;
      }

      creepConfigs.remove(configName);
      return false;
    });
  }

  return kept;
}

function ensureEmergencyCarrier(spawn: StructureSpawn): void {
  const roomName = spawn.room.name;
  const hasLiveCarrier = hasLiveCarrierInRoom(roomName);
  const hasSpawningCarrier = hasSpawningCarrierInRoom(roomName);
  const hasQueuedEmergencyCarrier = pruneEmergencyCarrierQueue(
    roomName,
    !hasLiveCarrier && !hasSpawningCarrier,
  );

  if (hasLiveCarrier || hasSpawningCarrier || hasQueuedEmergencyCarrier) {
    return;
  }

  spawnMaxCarrierRaw(roomName);
}

/**
 * RCL1 with zero creeps in the room: only queue one harvester and skip
 * everything else (carrier, workers, etc.) so the very first creep to
 * land is always a harvester, not a carrier.
 */
function tryQueueInitialHarvester(
  room: Room,
  spawns: StructureSpawn[],
  configs: Record<string, CreepConfig>,
  context: SpawnPlanningContext,
): boolean {
  if ((room.controller?.level ?? 0) !== 1) return false;
  if (getTickContextService().getCreepsByRoom(room.name).length > 0) return false;

  const harvesterEntry = Object.entries(configs).find(
    ([, cfg]) => cfg.roomName === room.name && cfg.role === "harvester",
  );
  const creepConfigs = getCreepConfigService();
  for (const configName of Object.keys(configs)) {
    if (isEmergencyCarrierConfigName(room.name, configName)) {
      creepConfigs.remove(configName);
    }
  }
  for (const spawn of spawns) {
    for (const configName of spawn.memory.spawnList ?? []) {
      const config = creepConfigs.get(configName);
      if (config?.spawnOnce?.queuedAt !== undefined && !isConfigSpawning(configName, context)) {
        delete config.spawnOnce.queuedAt;
      }
    }
    spawn.memory.spawnList = [];
  }
  if (!harvesterEntry) return true;

  const [configName] = harvesterEntry;
  if (!isConfigSpawning(configName, context)) {
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) {
      queueConfig(targetSpawn, configName);
    }
  }
  return true;
}

export function scheduleSpawnTasks(): void {
  const tickContext = getTickContextService();
  const planningContext = createSpawnPlanningContext();
  const spawnByRoom = new Map<string, StructureSpawn>();
  const spawnsByRoom = new Map<string, StructureSpawn[]>();
  for (const room of tickContext.getMyRooms()) {
    spawnsByRoom.set(room.name, tickContext.getSpawnsByRoom(room.name));
    const spawn = tickContext.getPrimarySpawnByRoom(room.name);
    if (spawn) {
      spawnByRoom.set(room.name, spawn);
    }
  }

  const initialConfigs = getCreepConfigService().list();

  // RCL1 rooms with no creeps get exactly one harvester queued; skip all other logic.
  const initialHarvesterRooms = new Set<string>();
  for (const room of tickContext.getMyRooms()) {
    const spawns = spawnsByRoom.get(room.name) ?? [];
    if (tryQueueInitialHarvester(room, spawns, initialConfigs, planningContext)) {
      initialHarvesterRooms.add(room.name);
    }
  }

  for (const spawn of spawnByRoom.values()) {
    if (!initialHarvesterRooms.has(spawn.room.name)) {
      ensureEmergencyCarrier(spawn);
    }
  }

  const configs = getCreepConfigService().list();
  for (const [configName, config] of Object.entries(configs)) {
    if (!config.roomName) {
      continue;
    }

    if (initialHarvesterRooms.has(config.roomName)) {
      continue;
    }

    if (config.role === "powerBankHauler") {
      queuePowerBankHaulerConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
      continue;
    }

    queueMissingConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
  }

  for (const spawn of Array.from(spawnsByRoom.values()).flat()) {
    prioritizeSpawnQueue(spawn);
  }
}
