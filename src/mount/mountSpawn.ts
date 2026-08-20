import { isSpawnActive } from "@/runtime/tickContext";
import { getHarvesterBody, spawnProfiles } from "@/config/spawnProfiles";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { isRcl8MaintenanceUpgraderConfig } from "@/runtime/upgraderPolicy";
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

function getSpawnExitDirections(spawn: StructureSpawn): DirectionConstant[] | undefined {
  if (spawn.room.name === "E5N59" && spawn.name === "Spawn20") {
    // Spawn20 的南侧出口通向永久封闭的双格空间，只允许从北侧落地。
    return [TOP];
  }

  return undefined;
}

const EXIT_DIRECTION_DELTAS: Readonly<Record<DirectionConstant, readonly [number, number]>> = {
  [TOP]: [0, -1],
  [TOP_RIGHT]: [1, -1],
  [RIGHT]: [1, 0],
  [BOTTOM_RIGHT]: [1, 1],
  [BOTTOM]: [0, 1],
  [BOTTOM_LEFT]: [-1, 1],
  [LEFT]: [-1, 0],
  [TOP_LEFT]: [-1, -1],
};

const DEFAULT_EXIT_DIRECTIONS: readonly DirectionConstant[] = [
  TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT,
];

function isClearSpawnExit(room: Room, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 49 || y < 0 || y > 49) {
    return false;
  }
  const pos = room.getPositionAt(x, y);
  if (!pos || pos.lookFor(LOOK_TERRAIN)[0] === "wall") {
    return false;
  }
  if (pos.lookFor(LOOK_STRUCTURES).some((structure) =>
    (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType)
  )) {
    return false;
  }
  return pos.lookFor(LOOK_CREEPS).length === 0;
}

/**
 * 出生位被已出生 creep 占据会让 Spawning 卡死到移开为止。
 * 孵化期间向挡位 creep 发出一步让路指令；命令可能被该 creep
 * 自身随后执行的移动逻辑覆盖，这对正常运转的 creep 无副作用，
 * 而停摆 creep（真正的阻塞来源）会按指令离开出生位。
 */
function directBlockingCreepsOffSpawn(spawn: StructureSpawn): void {
  const blockers = spawn.pos.lookFor(LOOK_CREEPS);
  if (blockers.length === 0) {
    return;
  }
  const candidates = getSpawnExitDirections(spawn) ?? DEFAULT_EXIT_DIRECTIONS;
  const exit = candidates.find((direction) => {
    const [dx, dy] = EXIT_DIRECTION_DELTAS[direction];
    return isClearSpawnExit(spawn.room, spawn.pos.x + dx, spawn.pos.y + dy);
  });
  if (!exit) {
    return;
  }
  for (const creep of blockers) {
    creep.move(exit);
  }
}

function isWarConfigName(configName: string): boolean {
  return configName.includes(":war:");
}

function isSourceRoomCarrierConfig(spawn: StructureSpawn, configName: string): boolean {
  const config = getCreepConfigService().get(configName);
  return config?.role === "carrier" && config.roomName === spawn.room.name;
}

function isEmergencyCarrierConfigName(roomName: string, configName: string): boolean {
  return configName.startsWith(`${roomName}:manual:maxcarrier:`);
}

function isSpawnableEmergencyCarrierConfig(spawn: StructureSpawn, configName: string): boolean {
  if (!isEmergencyCarrierConfigName(spawn.room.name, configName)) {
    return false;
  }

  const config = getCreepConfigService().get(configName);
  if (config?.role !== "carrier" || config.roomName !== spawn.room.name || !config.body ||
      config.body.length === 0 || config.body.length > MAX_CREEP_SIZE) {
    return false;
  }

  const bodyCost = config.body.reduce((sum, part) => {
    const partCost = BODYPART_COST[part];
    return typeof partCost === "number" && Number.isFinite(partCost) ? sum + partCost : Number.NaN;
  }, 0);
  return Number.isFinite(bodyCost) && bodyCost <= spawn.room.energyCapacityAvailable;
}

function hasWaitingEmergencyCarrierOnAnotherSpawn(spawn: StructureSpawn): boolean {
  return Object.values(Game.spawns).some((candidate) => {
    if (candidate === spawn || candidate.room.name !== spawn.room.name || !isSpawnActive(candidate)) {
      return false;
    }

    const configName = candidate.memory.spawnList?.[0];
    return !!configName && isSpawnableEmergencyCarrierConfig(candidate, configName);
  });
}

function hasWaitingWarSpawn(spawn: StructureSpawn): boolean {
  return Object.values(Game.spawns).some((candidate) => {
    if (candidate.room.name !== spawn.room.name) {
      return false;
    }
    if (!isSpawnActive(candidate)) {
      return false;
    }

    return (candidate.memory.spawnList ?? []).some((configName) => {
      if (!isWarConfigName(configName) || !getCreepConfigService().get(configName)) {
        return false;
      }

      const bodyCost = chooseBody(candidate, configName)
        .reduce((sum, part) => sum + BODYPART_COST[part], 0);
      return bodyCost <= candidate.room.energyCapacityAvailable;
    });
  });
}

function shouldYieldEnergyToWar(spawn: StructureSpawn, configName: string): boolean {
  if (isWarConfigName(configName) || isSourceRoomCarrierConfig(spawn, configName)) {
    return false;
  }
  return hasWaitingWarSpawn(spawn);
}

function shouldYieldToEmergencyCarrier(spawn: StructureSpawn, configName: string): boolean {
  return !isEmergencyCarrierConfigName(spawn.room.name, configName) &&
    hasWaitingEmergencyCarrierOnAnotherSpawn(spawn);
}

function hasWaitingRcl8MaintenanceOnAnotherSpawn(spawn: StructureSpawn): boolean {
  const creepConfigs = getCreepConfigService();
  return Object.values(Game.spawns).some((candidate) => {
    if (
      candidate === spawn ||
      candidate.room.name !== spawn.room.name ||
      candidate.spawning ||
      !isSpawnActive(candidate)
    ) {
      return false;
    }

    const configName = candidate.memory.spawnList?.[0];
    return !!configName && isRcl8MaintenanceUpgraderConfig(
      configName,
      creepConfigs.get(configName),
    );
  });
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
    const options: SpawnOptions = {
      memory: {
        role: config.role,
        roleArgs: [...config.args],
        configName,
        ready: false,
        working: false,
      },
    };
    const directions = getSpawnExitDirections(this);
    if (directions) {
      options.directions = directions;
    }
    const code = this.spawnCreep(body, name, options);

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
      directBlockingCreepsOffSpawn(this);
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
    const currentConfig = getCreepConfigService().get(currentTask);
    const isRcl8Maintenance = isRcl8MaintenanceUpgraderConfig(currentTask, currentConfig);
    if (!isRcl8Maintenance && hasWaitingRcl8MaintenanceOnAnotherSpawn(this)) {
      return;
    }
    if (!isRcl8Maintenance && shouldYieldEnergyToWar(this, currentTask)) {
      return;
    }
    if (!isRcl8Maintenance && shouldYieldToEmergencyCarrier(this, currentTask)) {
      return;
    }
    const success = this.mainSpawn(currentTask);
    if (success) {
      queue.shift();
    }
  };
}
