import { spawnProfiles } from "@/config/spawnProfiles";

const runtimeGlobal = global;

function ensureQueue(spawn: StructureSpawn): string[] {
  if (!spawn.memory.spawnList) {
    spawn.memory.spawnList = [];
  }
  return spawn.memory.spawnList;
}

function chooseBody(spawn: StructureSpawn, configName: string): BodyPartConstant[] {
  const config = runtimeGlobal.creepApi.get(configName);
  if (config?.body && config.body.length > 0) {
    return config.body;
  }

  if (!config) {
    return [WORK, CARRY, MOVE];
  }

  return spawnProfiles[config.role](spawn.room);
}

export function mountSpawn(): void {
  StructureSpawn.prototype.addTask = function addTask(configName: string): number {
    const queue = ensureQueue(this);
    if (!queue.includes(configName)) {
      queue.push(configName);
    }
    return queue.length;
  };

  StructureSpawn.prototype.mainSpawn = function mainSpawn(configName: string): boolean {
    const config = runtimeGlobal.creepApi.get(configName);
    if (!config) {
      return true;
    }

    const body = chooseBody(this, configName);
    const name = `${config.role}-${Game.time}`;
    const code = this.spawnCreep(body, name, {
      memory: {
        role: config.role,
        configName,
        ready: false,
        working: false,
      },
    });

    return code === OK;
  };

  StructureSpawn.prototype.work = function work(): void {
    if (this.spawning) {
      return;
    }

    const queue = ensureQueue(this);
    if (queue.length === 0) {
      return;
    }

    const currentTask = queue[0];
    const success = this.mainSpawn(currentTask);
    if (success) {
      queue.shift();
    }
  };
}
