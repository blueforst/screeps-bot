import { upsertConfig } from "@/runtime/creepApi";

const runtimeGlobal = global;

function cleanupLegacyHarvesterConfigs(roomName: string, validConfigNames: Set<string>): void {
  const configs = runtimeGlobal.creepApi.list(`${roomName}:harvester:`);
  for (const configName of Object.keys(configs)) {
    if (!validConfigNames.has(configName)) {
      runtimeGlobal.creepApi.remove(configName);
    }
  }
}

export function bootstrapRooms(): void {
  const myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);

  for (const room of myRooms) {
    const sources = room.find(FIND_SOURCES);
    const validHarvesterConfigs = new Set<string>();

    sources.forEach((source) => {
      const configName = `${room.name}:harvester:${source.id}`;
      validHarvesterConfigs.add(configName);
      upsertConfig(configName, "harvester", [source.id], room.name);
    });

    cleanupLegacyHarvesterConfigs(room.name, validHarvesterConfigs);

    upsertConfig(`${room.name}:carrier:0`, "carrier", [], room.name);
    upsertConfig(`${room.name}:worker:0`, "worker", [], room.name);
  }
}
