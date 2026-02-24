const CLEANUP_INTERVAL = 17;

function cleanupDeadCreepMemory(): number {
  let removed = 0;

  for (const creepName of Object.keys(Memory.creeps)) {
    if (!Game.creeps[creepName]) {
      delete Memory.creeps[creepName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupSpawnQueueMemory(): number {
  let trimmed = 0;

  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) {
      continue;
    }

    const validQueue = queue.filter((configName) => !!global.creepApi.get(configName));
    if (validQueue.length !== queue.length) {
      spawn.memory.spawnList = validQueue;
      trimmed += queue.length - validQueue.length;
    }
  }

  return trimmed;
}

export function runMemoryCleanup(): void {
  if (Game.time % CLEANUP_INTERVAL !== 0) {
    return;
  }

  const removedCreeps = cleanupDeadCreepMemory();
  const trimmedTasks = cleanupSpawnQueueMemory();

  if (removedCreeps > 0 || trimmedTasks > 0) {
    console.log(`[memory] cleaned creeps=${removedCreeps}, spawnTasks=${trimmedTasks}`);
  }
}
