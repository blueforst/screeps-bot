import { upsertConfig } from "@/runtime/creepApi";
import { getExpectedManagedConfigNames } from "@/runtime/roomWorkforce";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { hasSourceAdjacentLink } from "@/runtime/sourceLink";
type SourceWorkerRole = "harvester" | "miner";

function hasLiveCreepForConfig(configName: string): boolean {
  return Object.values(Game.creeps).some((creep) => creep.memory.configName === configName);
}

function cleanupConfigsByPrefix(roomName: string, prefix: string, validConfigNames: Set<string>): void {
  const creepConfigs = getCreepConfigService();
  const configs = creepConfigs.list(`${roomName}:${prefix}:`);
  for (const configName of Object.keys(configs)) {
    if (!validConfigNames.has(configName) && !hasLiveCreepForConfig(configName)) {
      creepConfigs.remove(configName);
    }
  }
}

function cleanupSourceConfigs(roomName: string, validConfigNames: Set<string>): void {
  cleanupConfigsByPrefix(roomName, "harvester", validConfigNames);
  cleanupConfigsByPrefix(roomName, "miner", validConfigNames);
}

function cleanupWorkerConfigs(roomName: string, validConfigNames: Set<string>): void {
  cleanupConfigsByPrefix(roomName, "worker", validConfigNames);
}

function isSourceRoleConfigName(roomName: string, configName: string): boolean {
  return configName.startsWith(`${roomName}:harvester:`) || configName.startsWith(`${roomName}:miner:`);
}

function cleanupSourceRoleQueueEntries(roomName: string, validConfigNames: Set<string>): void {
  for (const spawn of Object.values(Game.spawns)) {
    if (spawn.room.name !== roomName) {
      continue;
    }

    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) {
      continue;
    }

    spawn.memory.spawnList = queue.filter((configName) => {
      if (!isSourceRoleConfigName(roomName, configName)) {
        return true;
      }

      return validConfigNames.has(configName);
    });
  }
}

export function bootstrapRooms(): void {
  const myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);

  for (const room of myRooms) {
    const expectedConfigNames = new Set(getExpectedManagedConfigNames(room));
    const sources = room.find(FIND_SOURCES);

    for (const source of sources) {
      const role: SourceWorkerRole = hasSourceAdjacentLink(source) ? "miner" : "harvester";
      const configName = `${room.name}:${role}:${source.id}`;
      upsertConfig(configName, role, [source.id], room.name);
    }

    cleanupSourceRoleQueueEntries(room.name, expectedConfigNames);
    cleanupSourceConfigs(room.name, expectedConfigNames);

    upsertConfig(`${room.name}:carrier:0`, "carrier", [], room.name);

    for (const configName of expectedConfigNames) {
      if (configName.startsWith(`${room.name}:worker:`)) {
        upsertConfig(configName, "worker", [], room.name);
      }
    }

    cleanupWorkerConfigs(room.name, expectedConfigNames);
  }
}
