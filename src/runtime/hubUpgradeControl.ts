import { HUB_UPGRADER_BODY } from "@/config/spawnProfiles";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { getMemoryService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

export { HUB_UPGRADER_BODY };

export const UPGRADER_COUNT = 1;

export interface ManualUpgraderResult {
  ok: true;
  roomName: string;
  active: boolean;
  configName: string;
  creepNames: string[];
  boosted: boolean;
  createdAt?: number;
}

function getBoostTaskId(roomName: string): string {
  return `upgrader:${roomName}`;
}

function getConfigName(roomName: string, index = 0): string {
  return `${roomName}:upgrader:${index}`;
}

function isManagedUpgraderConfigName(configName: string): boolean {
  return configName.includes(":upgrader:") || configName.includes(":hubUpgrader:");
}

function isManagedUpgraderConfig(configName: string, config: CreepConfig): boolean {
  return isManagedUpgraderConfigName(configName) || config.role === "upgrader" || config.role === "hubUpgrader";
}

function getManualUpgraderStore(): NonNullable<NonNullable<Memory["data"]>["manualUpgraders"]> {
  const data = getMemoryService().ensureData();
  data.manualUpgraders = data.manualUpgraders || {};
  return data.manualUpgraders;
}

function getConfigRoomName(config: CreepConfig): string | undefined {
  return config.roomName || config.args[0];
}

function getManagedConfigEntries(): Array<[string, CreepConfig]> {
  return Object.entries(getMemoryService().getCreepConfigStore())
    .filter(([configName, config]) => isManagedUpgraderConfig(configName, config));
}

function cleanupSpawnedAndQueuedUpgraders(keptConfigNames: ReadonlySet<string>): void {
  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (queue?.length) {
      spawn.memory.spawnList = queue.filter((configName) =>
        !isManagedUpgraderConfigName(configName) || keptConfigNames.has(configName)
      );
    }

    if (!spawn.spawning) continue;
    const spawningConfigName = Memory.creeps?.[spawn.spawning.name]?.configName;
    if (
      spawningConfigName &&
      isManagedUpgraderConfigName(spawningConfigName) &&
      !keptConfigNames.has(spawningConfigName)
    ) {
      spawn.spawning.cancel();
    }
  }
}

function cleanupManagedUpgraders(keptConfigNames: ReadonlySet<string>): void {
  const configs = getMemoryService().getCreepConfigStore();
  const entries = getManagedConfigEntries().filter(([configName]) => !keptConfigNames.has(configName));
  const roomNames = new Set(
    entries
      .map(([, config]) => getConfigRoomName(config))
      .filter((roomName): roomName is string => !!roomName),
  );

  for (const taskId of Object.keys(Memory.runtime?.powerBankBoost || {})) {
    const roomName = taskId.startsWith("upgrader:")
      ? taskId.slice("upgrader:".length)
      : taskId.startsWith("hubUpgrade:")
        ? taskId.slice("hubUpgrade:".length)
        : undefined;
    if (roomName && !keptConfigNames.has(getConfigName(roomName))) {
      roomNames.add(roomName);
    }
  }

  cleanupSpawnedAndQueuedUpgraders(keptConfigNames);
  for (const creep of Object.values(Game.creeps)) {
    const configName = creep.memory.configName;
    if (
      (creep.memory.role === "upgrader" || creep.memory.role === "hubUpgrader" || (configName && isManagedUpgraderConfigName(configName))) &&
      (!configName || !keptConfigNames.has(configName))
    ) {
      creep.suicide();
    }
  }
  for (const [configName] of entries) {
    delete configs[configName];
  }
  for (const roomName of roomNames) {
    releaseBoostLabs(getBoostTaskId(roomName), roomName);
    releaseBoostLabs(`hubUpgrade:${roomName}`, roomName);
  }
}

function getUpgraderBody(room: Room): BodyPartConstant[] {
  const fixedBodyCost = HUB_UPGRADER_BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  if (room.energyCapacityAvailable >= fixedBodyCost) {
    return [...HUB_UPGRADER_BODY];
  }

  const body: BodyPartConstant[] = [];
  let remainingCapacity = room.energyCapacityAvailable;
  const workPairCost = BODYPART_COST[WORK] * 2 + BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  while (remainingCapacity >= workPairCost && body.length + 4 <= MAX_CREEP_SIZE) {
    body.push(WORK, WORK, CARRY, MOVE);
    remainingCapacity -= workPairCost;
  }

  const fallbackCost = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  if (remainingCapacity >= fallbackCost && body.length + 3 <= MAX_CREEP_SIZE) {
    body.push(WORK, CARRY, MOVE);
  }

  return body.length > 0 ? body : [WORK, CARRY, MOVE];
}

function countRemainingWorkParts(configName: string, body: readonly BodyPartConstant[]): number {
  const creeps = Object.values(Game.creeps).filter((creep) => creep.memory.configName === configName);
  if (creeps.length === 0) return body.filter((part) => part === WORK).length;

  return creeps.reduce((sum, creep) => sum + creep.body.filter((part) =>
    part.type === WORK &&
    part.hits > 0 &&
    part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID
  ).length, 0);
}

function getLocalUpgraderBoostInventory(room: Room): { amount: number; labCount: number } {
  let total = room.storage?.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID) || 0;
  total += room.terminal?.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID) || 0;

  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (structure): structure is StructureLab => structure.structureType === STRUCTURE_LAB,
  });
  for (const lab of labs) {
    total += lab.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID);
  }
  return {
    amount: total,
    labCount: labs.length,
  };
}

function isOwnedUpgraderRoom(roomName: string): boolean {
  const controller = Game.rooms[roomName]?.controller;
  return controller?.my === true;
}

function ensureOwnedRoomUpgraderTasks(): string[] {
  const tasks = getManualUpgraderStore();
  const ownedRoomNames = Object.values(Game.rooms)
    .filter((room) => room.controller?.my)
    .map((room) => room.name);
  const ownedRoomSet = new Set(ownedRoomNames);

  for (const roomName of ownedRoomNames) {
    const existing = tasks[roomName];
    if (!existing) {
      tasks[roomName] = {
        createdAt: Game.time,
        updatedAt: Game.time,
      };
    }
  }

  for (const roomName of Object.keys(tasks)) {
    if (!ownedRoomSet.has(roomName)) {
      delete tasks[roomName];
    }
  }

  return ownedRoomNames;
}

export function startUpgrader(roomName: string): ManualUpgraderResult | string {
  if (!isOwnedUpgraderRoom(roomName)) {
    return `ERR_UPGRADER_REQUIRES_OWNED_ROOM:${roomName}`;
  }

  const tasks = getManualUpgraderStore();
  const existing = tasks[roomName];
  tasks[roomName] = {
    createdAt: existing?.createdAt ?? Game.time,
    updatedAt: Game.time,
  };
  runHubUpgradeControl();
  return getUpgraderStatus(roomName) as ManualUpgraderResult;
}

export function stopUpgrader(roomName: string): ManualUpgraderResult | string {
  const tasks = getManualUpgraderStore();
  if (!tasks[roomName]) {
    return `ERR_NO_UPGRADER_TASK:${roomName}`;
  }
  if (isOwnedUpgraderRoom(roomName)) {
    return `ERR_UPGRADER_REQUIRED_FOR_OWNED_ROOM:${roomName}`;
  }

  delete tasks[roomName];
  runHubUpgradeControl();
  return `ERR_NO_UPGRADER_TASK:${roomName}`;
}

export function getUpgraderStatus(roomName?: string): ManualUpgraderResult[] | ManualUpgraderResult | string {
  const tasks = getManualUpgraderStore();
  const roomNames = roomName ? [roomName] : Object.keys(tasks);
  const statuses = roomNames.map((name): ManualUpgraderResult => {
    const configName = getConfigName(name);
    const config = getMemoryService().getCreepConfigStore()[configName];
    return {
      ok: true,
      roomName: name,
      active: isOwnedUpgraderRoom(name),
      configName,
      creepNames: Object.values(Game.creeps)
        .filter((creep) => creep.memory.configName === configName)
        .map((creep) => creep.name),
      boosted: config?.args[1] === getBoostTaskId(name),
      createdAt: tasks[name]?.createdAt,
    };
  });

  if (!roomName) return statuses;
  return statuses[0] || `ERR_NO_UPGRADER_TASK:${roomName}`;
}

export function runHubUpgradeControl(): void {
  const activeRoomNames = ensureOwnedRoomUpgraderTasks();
  const keptConfigNames = new Set(activeRoomNames.map((roomName) => getConfigName(roomName)));
  cleanupManagedUpgraders(keptConfigNames);

  const configs = getMemoryService().getCreepConfigStore();
  for (const roomName of activeRoomNames) {
    const room = Game.rooms[roomName]!;
    const configName = getConfigName(roomName);
    const boostTaskId = getBoostTaskId(roomName);
    const body = getUpgraderBody(room);
    const remainingWorkParts = countRemainingWorkParts(configName, body);
    const requiredBoostAmount = remainingWorkParts * LAB_BOOST_MINERAL;
    const boostInventory = getLocalUpgraderBoostInventory(room);
    const canBoostLocally = requiredBoostAmount > 0 &&
      boostInventory.labCount > 0 &&
      boostInventory.amount >= requiredBoostAmount;

    configs[configName] = {
      role: "upgrader",
      args: canBoostLocally ? [roomName, boostTaskId] : [roomName],
      roomName,
      body,
    };

    if (!canBoostLocally) {
      releaseBoostLabs(boostTaskId, roomName);
      continue;
    }

    prepareBoosts(
      boostTaskId,
      roomName,
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, requiredBoostAmount]]),
      { requireLabEnergy: true },
    );
  }
}
