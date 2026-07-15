import { isSpawnActive } from "@/runtime/tickContext";
import { getHarvesterBody, spawnProfiles } from "@/config/spawnProfiles";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import type { RoleName } from "@/types/system";

function isTransientConfigName(configName: string): boolean {
  return configName.includes(":manual:") || configName.includes(":emergency:");
}

function ensureQueue(spawn: StructureSpawn): string[] {
  if (!spawn.memory.spawnList) {
    spawn.memory.spawnList = [];
  }
  return spawn.memory.spawnList;
}

function chooseBody(spawn: StructureSpawn, configName: string): BodyPartConstant[] {
  const config = getCreepConfigService().get(configName);
  if (config?.body && config.body.length > 0) {
    return config.body;
  }

  if (!config) {
    return [WORK, CARRY, MOVE];
  }

  if (config.role === "harvester") {
    return getHarvesterBody(spawn.room);
  }

  return spawnProfiles[config.role](spawn.room);
}

function getCreepNamePrefix(role: RoleName): string {
  if (role === "worker") {
    return "worker";
  }

  return role;
}

function isWarConfigName(configName: string): boolean {
  return configName.includes(":war:");
}

function isSourceRoomCarrierConfig(spawn: StructureSpawn, configName: string): boolean {
  const config = getCreepConfigService().get(configName);
  return config?.role === "carrier" && config.roomName === spawn.room.name;
}

function hasWaitingWarSpawn(spawn: StructureSpawn): boolean {
  return Object.values(Game.spawns).some((candidate) => {
    if (candidate.name === spawn.name || candidate.room.name !== spawn.room.name) {
      return false;
    }
    if (candidate.spawning || !isSpawnActive(candidate)) {
      return false;
    }

    const configName = candidate.memory.spawnList?.[0];
    if (!configName || !isWarConfigName(configName)) {
      return false;
    }
    if (!getCreepConfigService().get(configName)) {
      return false;
    }

    const bodyCost = chooseBody(candidate, configName)
      .reduce((sum, part) => sum + BODYPART_COST[part], 0);
    return bodyCost <= candidate.room.energyCapacityAvailable;
  });
}

function shouldYieldEnergyToWar(spawn: StructureSpawn, configName: string): boolean {
  if (isWarConfigName(configName) || isSourceRoomCarrierConfig(spawn, configName)) {
    return false;
  }
  return hasWaitingWarSpawn(spawn);
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
    const creepConfigs = getCreepConfigService();
    const config = creepConfigs.get(configName);
    if (!config) {
      return true;
    }

    const body = chooseBody(this, configName);
    const name = config.name || `${getCreepNamePrefix(config.role)}-${Game.time}`;
    const code = this.spawnCreep(body, name, {
      memory: {
        role: config.role,
        roleArgs: [...config.args],
        configName,
        ready: false,
        working: false,
      },
    });

    if (code === OK) {
      recordFixedCpuAction("spawnWork");
      if (isTransientConfigName(configName)) {
        creepConfigs.remove(configName);
      }
    } else {
      this.memory._lastSpawnFail = {
        tick: Game.time,
        spawnName: this.name,
        configName,
        role: config.role,
        code,
        bodyCost: body.reduce((sum, part) => sum + BODYPART_COST[part], 0),
        bodyParts: body.length,
        roomEnergyAvailable: this.room.energyAvailable,
        roomEnergyCapacityAvailable: this.room.energyCapacityAvailable,
      };
    }

    return code === OK;
  };

  StructureSpawn.prototype.work = function work(): void {
    if (this.spawning) {
      return;
    }

    if (!isSpawnActive(this)) {
      return;
    }

    const queue = ensureQueue(this);
    if (queue.length === 0) {
      return;
    }

    const currentTask = queue[0];
    if (shouldYieldEnergyToWar(this, currentTask)) {
      return;
    }
    const success = this.mainSpawn(currentTask);
    if (success) {
      queue.shift();
    }
  };
}
