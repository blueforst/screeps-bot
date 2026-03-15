import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import { buyBoostIfNeeded, clearBoostLabTasks, shouldBoostDefender, syncBoostLabTask } from "@/runtime/boostControl";

const DANGEROUS_BODY_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, WORK];
const DEFENDER_COUNT = 1;

function getPlayerHostiles(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) =>
      creep.owner.username !== "Source Keeper" &&
      (creep.owner.username !== "Invader" || creep.getActiveBodyparts(WORK) > 0) &&
      DANGEROUS_BODY_PARTS.some((part) => creep.getActiveBodyparts(part) > 0),
  });
}

function getConfigName(roomName: string, index: number): string {
  return `${roomName}:homeDefense:defender:${index}`;
}

function getPrimarySpawn(roomName: string): StructureSpawn | null {
  return getTickContextService().getPrimarySpawnByRoom(roomName) || null;
}

function isLiveOrSpawning(configName: string): boolean {
  const tickContext = getTickContextService();
  if (tickContext.getCreepsByConfigName(configName).length > 0) return true;

  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (spawn.spawning && Memory.creeps[spawn.spawning.name]?.configName === configName) {
        return true;
      }
    }
  }

  return false;
}

function ensureDefenders(room: Room): void {
  const configStore = getMemoryService().getCreepConfigStore();
  const spawn = getPrimarySpawn(room.name);
  if (!spawn) return;

  for (let i = 0; i < DEFENDER_COUNT; i++) {
    const configName = getConfigName(room.name, i);
    configStore[configName] = {
      role: "homeDefender",
      args: [room.name],
      roomName: room.name,
    };

    if (!isLiveOrSpawning(configName)) {
      const queue = spawn.memory.spawnList || [];
      if (!queue.includes(configName)) {
        spawn.addTask(configName);
      }
    }
  }
}

function removeDefenders(roomName: string): void {
  const configStore = getCreepConfigService();
  const spawn = getPrimarySpawn(roomName);

  for (let i = 0; i < DEFENDER_COUNT; i++) {
    const configName = getConfigName(roomName, i);
    configStore.remove(configName);

    if (spawn?.memory.spawnList) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

export function runHomeDefense(): void {
  const tickContext = getTickContextService();

  for (const room of tickContext.getMyRooms()) {
    const safeZone = getSafeZone(room.name);
    if (safeZone.size === 0) continue;

    const playerHostiles = getPlayerHostiles(room);
    if (playerHostiles.length > 0) {
      ensureDefenders(room);
      if (shouldBoostDefender(room, playerHostiles)) {
        buyBoostIfNeeded(room);
        syncBoostLabTask(room);
      } else {
        clearBoostLabTasks(room.name);
      }
    } else {
      removeDefenders(room.name);
      clearBoostLabTasks(room.name);
    }
  }
}
