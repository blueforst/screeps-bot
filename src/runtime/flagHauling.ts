import { isDefenseMode } from "@/runtime/defenseMode";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

interface FlagHaulTask {
  targetRoom: string;
  sourceRoom: string;
  flagName: string;
  targetX: number;
  targetY: number;
  createdAt: number;
  updatedAt: number;
}

const FLAG_PREFIX = "HAUL";

function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function buildMaxCarrierBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(16, Math.floor(room.energyCapacityAvailable / pairCost)));
  const body: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    body.push(CARRY, MOVE);
  }

  return body;
}

function hasFlagHaulProductionCapability(spawn: StructureSpawn): boolean {
  return spawn.isActive() && spawn.room.energyCapacityAvailable >= getBodyCost([CARRY, MOVE]);
}

function getFlagHaulFlags(): Flag[] {
  return Object.values(Game.flags).filter((flag) => flag.name === FLAG_PREFIX || flag.name.startsWith(`${FLAG_PREFIX}_`));
}

function isRemoteHaulStructure(structure: Structure<StructureConstant>): structure is AnyStoreStructure {
  if (!("store" in structure)) {
    return false;
  }

  if (
    structure.structureType === STRUCTURE_CONTROLLER ||
    structure.structureType === STRUCTURE_SPAWN ||
    structure.structureType === STRUCTURE_EXTENSION
  ) {
    return false;
  }

  return (structure as AnyStoreStructure).store.getUsedCapacity() > 0;
}

function hasHaulableResources(room: Room): boolean {
  const structures = room.find(FIND_STRUCTURES, { filter: isRemoteHaulStructure });
  if (structures.length > 0) {
    return true;
  }

  const ruins = room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity() > 0,
  });

  return ruins.length > 0;
}

function getPreferredSourceFromFlagName(flagName: string): string | undefined {
  if (!flagName.startsWith(`${FLAG_PREFIX}_`)) {
    return undefined;
  }

  const match = /^HAUL_([WE]\d+[NS]\d+)/.exec(flagName.trim());
  return match?.[1];
}

function getOwnedSpawnRooms(): string[] {
  const tickContext = getTickContextService();
  const roomNames = new Set<string>();

  for (const room of tickContext.getMyRooms()) {
    if (isDefenseMode(room.name)) {
      continue;
    }

    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (hasFlagHaulProductionCapability(spawn)) {
        roomNames.add(room.name);
      }
    }
  }

  return [...roomNames];
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

function ensureFlagHaulStore(): Record<string, FlagHaulTask> {
  const data = getMemoryService().ensureData();
  if (!data.flagHauling) {
    data.flagHauling = {};
  }

  return data.flagHauling;
}

function getConfigName(task: FlagHaulTask): string {
  return `${task.sourceRoom}:haul:${task.targetRoom}:carrier:${task.flagName}`;
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName);
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};

  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      if (creepMemory[spawn.spawning.name]?.configName === configName) {
        return true;
      }
    }
  }

  return false;
}

function removeQueuedConfig(task: FlagHaulTask, configName: string): void {
  const spawn = getTickContextService().getPrimarySpawnByRoom(task.sourceRoom);
  if (!spawn?.memory.spawnList) {
    return;
  }

  spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
}

function cleanupFlagHaulConfig(task: FlagHaulTask): boolean {
  const configName = getConfigName(task);
  const store = getMemoryService().getCreepConfigStore();
  const config = store[configName];

  removeQueuedConfig(task, configName);
  if (config?.roomName) {
    delete config.roomName;
  }

  if (isConfigSpawning(configName) || getLiveCreepsByConfig(configName).length > 0) {
    return false;
  }

  if (store[configName]) {
    delete store[configName];
  }

  return true;
}

function upsertFlagHaulConfig(task: FlagHaulTask): void {
  const room = Game.rooms[task.sourceRoom];
  if (!room) {
    return;
  }

  const store = getMemoryService().getCreepConfigStore();
  const configName = getConfigName(task);
  const body = buildMaxCarrierBody(room);
  const nextConfig: CreepConfig = {
    role: "remoteCarrier",
    args: [task.targetRoom, String(task.targetX), String(task.targetY)],
    roomName: task.sourceRoom,
    body,
  };
  const existing = store[configName];

  if (
    existing?.role === nextConfig.role &&
    existing.roomName === nextConfig.roomName &&
    existing.args.join("|") === nextConfig.args.join("|") &&
    existing.body?.join("|") === body.join("|")
  ) {
    return;
  }

  store[configName] = nextConfig;
}

function upsertFlagHaulTask(flag: Flag): boolean {
  const targetRoom = flag.pos.roomName;
  const targetRoomVisible = Game.rooms[targetRoom];
  if (targetRoomVisible?.controller?.my) {
    return true;
  }

  if (targetRoomVisible && !hasHaulableResources(targetRoomVisible)) {
    flag.remove();
    return true;
  }

  const sourceRoom = selectSourceRoom(targetRoom, getPreferredSourceFromFlagName(flag.name));
  if (!sourceRoom) {
    return false;
  }

  const store = ensureFlagHaulStore();
  const existing = store[flag.name];
  const now = Game.time;

  if (existing && existing.sourceRoom !== sourceRoom) {
    cleanupFlagHaulConfig(existing);
  }

  store[flag.name] = {
    targetRoom,
    sourceRoom,
    flagName: flag.name,
    targetX: flag.pos.x,
    targetY: flag.pos.y,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (!existing) {
    console.log(`[flag-haul] started: flag=${flag.name} target=${targetRoom} source=${sourceRoom}`);
  }

  return true;
}

function processFlagHaulTask(task: FlagHaulTask): boolean {
  if (isDefenseMode(task.sourceRoom)) {
    cleanupFlagHaulConfig(task);
    task.updatedAt = Game.time;
    return true;
  }

  const targetRoom = Game.rooms[task.targetRoom];
  if (targetRoom?.controller?.my) {
    return cleanupFlagHaulConfig(task);
  }

  upsertFlagHaulConfig(task);
  task.updatedAt = Game.time;
  return true;
}

export function runFlagHaulingByFlag(): void {
  const flags = getFlagHaulFlags();
  const remoteFlagNames = new Set<string>();

  for (const flag of flags) {
    const scheduled = upsertFlagHaulTask(flag);
    const targetRoom = Game.rooms[flag.pos.roomName];
    if (!targetRoom?.controller?.my) {
      remoteFlagNames.add(flag.name);
    }
    if (!scheduled && Game.time % 100 === 0) {
      console.log(`[flag-haul] flag pending: ${flag.name} room=${flag.pos.roomName} reason=no_source_room`);
    }
  }

  const store = ensureFlagHaulStore();
  for (const task of Object.values(store)) {
    if (!remoteFlagNames.has(task.flagName) || !Game.flags[task.flagName]) {
      const cleaned = cleanupFlagHaulConfig(task);
      if (cleaned) {
        delete store[task.flagName];
        console.log(`[flag-haul] cancelled: flag=${task.flagName} target=${task.targetRoom}`);
      }
      continue;
    }

    processFlagHaulTask(task);
  }
}
