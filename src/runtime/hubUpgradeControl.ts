import { HUB_UPGRADER_BODY } from "@/config/spawnProfiles";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { getPowerBankBoostPrep } from "@/runtime/powerBankBoostMemory";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

export { HUB_UPGRADER_BODY };

export const HUB_UPGRADER_COUNT = 2;

function getBoostTaskId(roomName: string): string {
  return `hubUpgrade:${roomName}`;
}

function getConfigName(roomName: string, index: number): string {
  return `${roomName}:hubUpgrader:${index}`;
}

function getConfiguredHubUpgraders(): Array<[string, CreepConfig]> {
  return Object.entries(getMemoryService().getCreepConfigStore())
    .filter((entry): entry is [string, CreepConfig] => entry[1].role === "hubUpgrader");
}

function removeQueuedConfigs(configNames: Set<string>): void {
  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    spawn.memory.spawnList = queue.filter((configName) => !configNames.has(configName));
  }
}

function cleanupHubUpgraders(keepRoomName?: string): void {
  const configs = getMemoryService().getCreepConfigStore();
  const entries = getConfiguredHubUpgraders().filter(([, config]) =>
    !keepRoomName || (config.roomName || config.args[0]) !== keepRoomName
  );
  const configNames = new Set(entries.map(([configName]) => configName));
  const roomNames = new Set(
    entries
      .map(([, config]) => config.roomName || config.args[0])
      .filter((roomName): roomName is string => !!roomName),
  );

  for (const taskId of Object.keys(Memory.runtime?.powerBankBoost || {})) {
    if (taskId.startsWith("hubUpgrade:")) {
      const taskRoomName = taskId.slice("hubUpgrade:".length);
      if (!keepRoomName || taskRoomName !== keepRoomName) {
        roomNames.add(taskRoomName);
      }
    }
  }

  removeQueuedConfigs(configNames);
  for (const configName of configNames) {
    delete configs[configName];
  }

  for (const roomName of roomNames) {
    const taskId = getBoostTaskId(roomName);
    if (getPowerBankBoostPrep(taskId)) {
      releaseBoostLabs(taskId, roomName);
    }
  }
}

function countRemainingWorkParts(configName: string): number {
  const creeps = getTickContextService().getCreepsByConfigName(configName);
  if (creeps.length === 0) return 15;

  return creeps.reduce((sum, creep) => sum + creep.body.filter((part) =>
    part.type === WORK &&
    part.hits > 0 &&
    part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID
  ).length, 0);
}

export function runHubUpgradeControl(): void {
  const hubConfig = Memory.cfg?.hub;
  const roomName = hubConfig?.hubRoomName;
  if (!hubConfig?.enabled || !roomName) {
    cleanupHubUpgraders();
    return;
  }

  const room = Game.rooms[roomName];
  if (!room?.controller?.my || room.controller.level !== 7) {
    cleanupHubUpgraders();
    return;
  }

  cleanupHubUpgraders(roomName);

  const configs = getMemoryService().getCreepConfigStore();
  const boostTaskId = getBoostTaskId(roomName);
  for (let index = 0; index < HUB_UPGRADER_COUNT; index += 1) {
    configs[getConfigName(roomName, index)] = {
      role: "hubUpgrader",
      args: [roomName, boostTaskId],
      roomName,
      body: [...HUB_UPGRADER_BODY],
    };
  }

  const remainingWorkParts = Array.from({ length: HUB_UPGRADER_COUNT }, (_, index) =>
    countRemainingWorkParts(getConfigName(roomName, index))
  ).reduce((sum, count) => sum + count, 0);

  if (remainingWorkParts <= 0) {
    if (getPowerBankBoostPrep(boostTaskId)) {
      releaseBoostLabs(boostTaskId, roomName);
    }
    return;
  }

  prepareBoosts(
    boostTaskId,
    roomName,
    0,
    new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, remainingWorkParts * LAB_BOOST_MINERAL]]),
    { requireLabEnergy: true },
  );
}
