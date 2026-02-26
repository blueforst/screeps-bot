import { upsertConfig } from "@/runtime/creepApi";
import { getExpectedManagedConfigNames } from "@/runtime/roomWorkforce";

const runtimeGlobal = global;

function hasLiveCreepForConfig(configName: string): boolean {
  return Object.values(Game.creeps).some((creep) => creep.memory.configName === configName);
}

function cleanupLegacyHarvesterConfigs(roomName: string, validConfigNames: Set<string>): void {
  const configs = runtimeGlobal.creepApi.list(`${roomName}:harvester:`);
  for (const configName of Object.keys(configs)) {
    if (!validConfigNames.has(configName) && !hasLiveCreepForConfig(configName)) {
      runtimeGlobal.creepApi.remove(configName);
    }
  }
}

function cleanupWorkerConfigs(roomName: string, validConfigNames: Set<string>): void {
  const configs = runtimeGlobal.creepApi.list(`${roomName}:worker:`);
  for (const configName of Object.keys(configs)) {
    if (!validConfigNames.has(configName) && !hasLiveCreepForConfig(configName)) {
      runtimeGlobal.creepApi.remove(configName);
    }
  }
}

export function bootstrapRooms(): void {
  const myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);

  for (const room of myRooms) {
    const expectedConfigNames = new Set(getExpectedManagedConfigNames(room));
    const sources = room.find(FIND_SOURCES);

    for (const source of sources) {
      const configName = `${room.name}:harvester:${source.id}`;
      upsertConfig(configName, "harvester", [source.id], room.name);
    }

    cleanupLegacyHarvesterConfigs(room.name, expectedConfigNames);

    upsertConfig(`${room.name}:carrier:0`, "carrier", [], room.name);

    for (const configName of expectedConfigNames) {
      if (configName.startsWith(`${room.name}:worker:`)) {
        upsertConfig(configName, "worker", [], room.name);
      }
    }

    cleanupWorkerConfigs(room.name, expectedConfigNames);
  }
}
