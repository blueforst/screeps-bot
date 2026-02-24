const runtimeGlobal = global;

function isConfigActive(configName: string): boolean {
  const alive = Object.values(Game.creeps).some((creep) => creep.memory.configName === configName);
  if (alive) {
    return true;
  }

  return Object.values(Game.spawns).some((spawn) => {
    if (!spawn.spawning) {
      return false;
    }

    const spawningName = spawn.spawning.name;
    return Memory.creeps[spawningName]?.configName === configName;
  });
}

function queueMissingConfig(spawn: StructureSpawn, configName: string): void {
  if (!isConfigActive(configName)) {
    spawn.addTask(configName);
  }
}

export function scheduleSpawnTasks(): void {
  const spawnByRoom = new Map<string, StructureSpawn>();
  Object.values(Game.spawns).forEach((spawn) => {
    if (!spawnByRoom.has(spawn.room.name)) {
      spawnByRoom.set(spawn.room.name, spawn);
    }
  });

  const configs = runtimeGlobal.creepApi.list();
  for (const [configName, config] of Object.entries(configs)) {
    if (!config.roomName) {
      continue;
    }

    const spawn = spawnByRoom.get(config.roomName);
    if (!spawn) {
      continue;
    }

    queueMissingConfig(spawn, configName);
  }
}
