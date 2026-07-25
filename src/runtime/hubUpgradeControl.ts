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

function countRemainingWorkParts(configName: string): number {
  const creeps = Object.values(Game.creeps).filter((creep) => creep.memory.configName === configName);
  if (creeps.length === 0) return HUB_UPGRADER_BODY.filter((part) => part === WORK).length;

  return creeps.reduce((sum, creep) => sum + creep.body.filter((part) =>
    part.type === WORK &&
    part.hits > 0 &&
    part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID
  ).length, 0);
}

function getLocalUpgraderBoostAmount(room: Room): number {
  let total = room.storage?.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID) || 0;
  total += room.terminal?.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID) || 0;

  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (structure): structure is StructureLab => structure.structureType === STRUCTURE_LAB,
  });
  for (const lab of labs) {
    total += lab.store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID);
  }
  return total;
}

function isActiveManualUpgraderRoom(roomName: string): boolean {
  const controller = Game.rooms[roomName]?.controller;
  return controller?.my === true && controller.level === 7;
}

export function startUpgrader(roomName: string): ManualUpgraderResult | string {
  if (!isActiveManualUpgraderRoom(roomName)) {
    return `ERR_UPGRADER_REQUIRES_OWNED_RCL7_ROOM:${roomName}`;
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

  delete tasks[roomName];
  const keptConfigNames = new Set(
    Object.keys(tasks)
      .filter(isActiveManualUpgraderRoom)
      .map((activeRoomName) => getConfigName(activeRoomName)),
  );
  cleanupManagedUpgraders(keptConfigNames);
  return {
    ok: true,
    roomName,
    active: false,
    configName: getConfigName(roomName),
    creepNames: [],
    boosted: false,
  };
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
      active: isActiveManualUpgraderRoom(name),
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
  const tasks = getManualUpgraderStore();
  const activeRoomNames = Object.keys(tasks).filter((roomName) => {
    const active = isActiveManualUpgraderRoom(roomName);
    if (!active) {
      delete tasks[roomName];
    }
    return active;
  });
  const keptConfigNames = new Set(activeRoomNames.map((roomName) => getConfigName(roomName)));
  cleanupManagedUpgraders(keptConfigNames);

  const configs = getMemoryService().getCreepConfigStore();
  for (const roomName of activeRoomNames) {
    const room = Game.rooms[roomName]!;
    const configName = getConfigName(roomName);
    const boostTaskId = getBoostTaskId(roomName);
    const remainingWorkParts = countRemainingWorkParts(configName);
    const requiredBoostAmount = remainingWorkParts * LAB_BOOST_MINERAL;
    const canBoostLocally = requiredBoostAmount > 0 && getLocalUpgraderBoostAmount(room) >= requiredBoostAmount;

    configs[configName] = {
      role: "upgrader",
      args: canBoostLocally ? [roomName, boostTaskId] : [roomName],
      roomName,
      body: [...HUB_UPGRADER_BODY],
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
