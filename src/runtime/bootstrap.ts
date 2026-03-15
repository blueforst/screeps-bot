import { upsertConfig } from "@/runtime/creepApi";
import { getEligibleMineralIds, getExpectedManagedConfigNames } from "@/runtime/roomWorkforce";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import type { TickContextService } from "@/runtime/tickContext";
import { hasSourceAdjacentLink } from "@/runtime/sourceLink";
type SourceWorkerRole = "harvester" | "miner";

function hasLiveCreepForConfig(configName: string, tickContext: TickContextService): boolean {
  return tickContext.getCreepsByConfigName(configName).length > 0;
}

function cleanupConfigsByPrefix(
  roomName: string,
  prefix: string,
  validConfigNames: Set<string>,
  tickContext: TickContextService,
): void {
  const creepConfigs = getCreepConfigService();
  const configs = creepConfigs.list(`${roomName}:${prefix}:`);
  for (const configName of Object.keys(configs)) {
    if (!validConfigNames.has(configName) && !hasLiveCreepForConfig(configName, tickContext)) {
      creepConfigs.remove(configName);
    }
  }
}

function cleanupSourceConfigs(roomName: string, validConfigNames: Set<string>, tickContext: TickContextService): void {
  cleanupConfigsByPrefix(roomName, "harvester", validConfigNames, tickContext);
  cleanupConfigsByPrefix(roomName, "miner", validConfigNames, tickContext);
  cleanupConfigsByPrefix(roomName, "mineralHarvester", validConfigNames, tickContext);
}

function cleanupWorkerConfigs(roomName: string, validConfigNames: Set<string>, tickContext: TickContextService): void {
  cleanupConfigsByPrefix(roomName, "worker", validConfigNames, tickContext);
}

function isSourceRoleConfigName(roomName: string, configName: string): boolean {
  return (
    configName.startsWith(`${roomName}:harvester:`) ||
    configName.startsWith(`${roomName}:miner:`) ||
    configName.startsWith(`${roomName}:mineralHarvester:`)
  );
}

function cleanupSourceRoleQueueEntries(
  roomName: string,
  validConfigNames: Set<string>,
  tickContext: TickContextService,
): void {
  for (const spawn of tickContext.getSpawnsByRoom(roomName)) {
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
  const tickContext = getTickContextService();
  const myRooms = tickContext.getMyRooms();

  for (const room of myRooms) {
    const expectedConfigNames = new Set(getExpectedManagedConfigNames(room));
    const sources = room.find(FIND_SOURCES);

    for (const source of sources) {
      const role: SourceWorkerRole = hasSourceAdjacentLink(source) ? "miner" : "harvester";
      const configName = `${room.name}:${role}:${source.id}`;
      upsertConfig(configName, role, [source.id], room.name);
    }

    for (const mineralId of getEligibleMineralIds(room)) {
      const configName = `${room.name}:mineralHarvester:${mineralId}`;
      upsertConfig(configName, "mineralHarvester", [mineralId], room.name);
    }

    cleanupSourceRoleQueueEntries(room.name, expectedConfigNames, tickContext);
    cleanupSourceConfigs(room.name, expectedConfigNames, tickContext);

    upsertConfig(`${room.name}:carrier:0`, "carrier", [], room.name);

    for (const configName of expectedConfigNames) {
      if (configName.startsWith(`${room.name}:worker:`)) {
        upsertConfig(configName, "worker", [], room.name);
      }
    }

    cleanupWorkerConfigs(room.name, expectedConfigNames, tickContext);

    // In reserve mode, orphan any lingering worker configs that still have live creeps
    // so spawn planner does not prespawn replacements.
    if (isRoomInReserveMode(room.name)) {
      const creepConfigs = getCreepConfigService();
      for (const config of Object.values(creepConfigs.list(`${room.name}:worker:`))) {
        if (config.roomName) {
          delete config.roomName;
        }
      }
    }
  }
}
