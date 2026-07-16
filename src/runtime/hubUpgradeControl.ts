import { HUB_UPGRADER_BODY } from "@/config/spawnProfiles";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

export { HUB_UPGRADER_BODY };

export const HUB_UPGRADER_COUNT = 1;

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

function isHubUpgraderConfigName(configName: string): boolean {
  return configName.includes(":hubUpgrader:");
}

function cleanupSpawnedAndQueuedHubUpgraders(keptConfigNames: ReadonlySet<string>): void {
  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (queue?.length) {
      spawn.memory.spawnList = queue.filter((configName) =>
        !isHubUpgraderConfigName(configName) || keptConfigNames.has(configName)
      );
    }

    if (!spawn.spawning) continue;
    const spawningConfigName = Memory.creeps?.[spawn.spawning.name]?.configName;
    if (
      spawningConfigName &&
      isHubUpgraderConfigName(spawningConfigName) &&
      !keptConfigNames.has(spawningConfigName)
    ) {
      spawn.spawning.cancel();
    }
  }
}

function cleanupHubUpgraders(keepRoomNames: ReadonlySet<string> = new Set()): void {
  const configs = getMemoryService().getCreepConfigStore();
  const keptConfigNames = new Set(
    [...keepRoomNames].flatMap((roomName) =>
      Array.from({ length: HUB_UPGRADER_COUNT }, (_, index) => getConfigName(roomName, index))
    ),
  );
  const entries = getConfiguredHubUpgraders().filter(([configName]) => !keptConfigNames.has(configName));
  const roomNames = new Set(
    entries
      .map(([, config]) => config.roomName || config.args[0])
      .filter((roomName): roomName is string => !!roomName),
  );

  for (const taskId of Object.keys(Memory.runtime?.powerBankBoost || {})) {
    if (taskId.startsWith("hubUpgrade:")) {
      const taskRoomName = taskId.slice("hubUpgrade:".length);
      if (!keepRoomNames.has(taskRoomName)) {
        roomNames.add(taskRoomName);
      }
    }
  }

  cleanupSpawnedAndQueuedHubUpgraders(keptConfigNames);
  for (const creep of getTickContextService().getCreepsByRole("hubUpgrader")) {
    const configName = creep.memory.configName;
    if (!configName || !keptConfigNames.has(configName)) {
      creep.suicide();
    }
  }
  for (const [configName] of entries) {
    delete configs[configName];
  }

  for (const roomName of roomNames) {
    const taskId = getBoostTaskId(roomName);
    releaseBoostLabs(taskId, roomName);
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
  if (!hubConfig?.enabled) {
    cleanupHubUpgraders();
    return;
  }

  const configuredRoomNames = [...new Set([
    hubConfig.hubRoomName,
    ...(hubConfig.upgraderRoomNames || []),
  ].filter((roomName): roomName is string => !!roomName))];
  const activeRoomNames = configuredRoomNames.filter((roomName) => {
    const controller = Game.rooms[roomName]?.controller;
    return controller?.my === true && controller.level === 7;
  });
  const activeRoomSet = new Set(activeRoomNames);

  cleanupHubUpgraders(activeRoomSet);

  const configs = getMemoryService().getCreepConfigStore();
  for (const roomName of activeRoomNames) {
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
      releaseBoostLabs(boostTaskId, roomName);
      continue;
    }

    prepareBoosts(
      boostTaskId,
      roomName,
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, remainingWorkParts * LAB_BOOST_MINERAL]]),
      { requireLabEnergy: true },
    );
  }
}
