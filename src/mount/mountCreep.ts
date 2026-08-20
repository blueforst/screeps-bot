import { roleRegistry } from "@/roles";
import { clearMovementState } from "@/roles/shared";
import { decodeCrossShardTravelerName } from "@/runtime/crossShardNaming";
import { measureCreepDecision } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService } from "@/runtime/runtimeServices";

function tryRestoreRoleFromName(creep: Creep): boolean {
  const traveler = decodeCrossShardTravelerName(creep.name);
  if (!traveler) {
    return false;
  }

  const restoredRoleByKind = {
    claimer: "crossShardClaimer",
    harvester: "crossShardColonizerHarvester",
    worker: "crossShardColonizerWorker",
  } as const;

  creep.memory.role = restoredRoleByKind[traveler.kind];
  creep.memory.roleArgs = [
    traveler.targetShard,
    traveler.targetRoom,
    traveler.portalRoom,
    traveler.destinationRoom || "",
  ];
  creep.memory.ready = false;
  creep.memory.working = false;

  return true;
}

function resolveRoleLogic(creep: Creep): ReturnType<(typeof roleRegistry)[keyof typeof roleRegistry]> | null {
  const creepConfigs = getCreepConfigService();
  const configName = creep.memory.configName;
  if (configName) {
    const config = creepConfigs.get(configName);
    if (config) {
      const roleFactory = roleRegistry[config.role];
      if (!roleFactory) {
        return null;
      }

      return roleFactory(...config.args);
    }
  }

  const memoryRole = creep.memory.role;
  if (!memoryRole) {
    if (tryRestoreRoleFromName(creep)) {
      const restoredRole = creep.memory.role;
      if (restoredRole) {
        const restoredFactory = roleRegistry[restoredRole];
        return restoredFactory(...(creep.memory.roleArgs || []));
      }
    }

    return null;
  }

  const roleFactory = roleRegistry[memoryRole];
  if (!roleFactory) {
    return null;
  }

  return roleFactory(...(creep.memory.roleArgs || []));
}

export function mountCreep(): void {
  Creep.prototype.work = function work(): void {
    // spawn 让位指令优先：挡位 creep 的自身移动逻辑会覆盖 spawn 侧的
    // 直接 move（spawn.work 先执行），本 tick 让出一步并跳过自身行为，
    // 解除孵化冻结；指令带 tick，过期即忽略并清除。
    const spawnYield = this.memory._spawnYield;
    if (spawnYield) {
      delete this.memory._spawnYield;
      if (Game.time - spawnYield.tick >= 0 && Game.time - spawnYield.tick <= 2) {
        this.move(spawnYield.dir);
        return;
      }
    }

    const logic = measureCreepDecision(() => resolveRoleLogic(this));
    if (!logic) {
      clearMovementState(this);
      this.say("no-config");
      return;
    }

    if (!this.memory.ready) {
      this.memory.ready = measureCreepDecision(() => (logic.prepare ? logic.prepare(this) : true));
      return;
    }

    const isWorking = this.memory.working ?? false;
    let shouldSwitch = false;

    if (isWorking) {
      shouldSwitch = logic.target(this);
    } else if (logic.source) {
      shouldSwitch = logic.source(this);
    } else {
      shouldSwitch = true;
    }

    if (shouldSwitch) {
      clearMovementState(this);
      this.memory.working = !isWorking;

      const switchedToWorking = this.memory.working === true;
      if (switchedToWorking) {
        logic.target(this);
      } else if (logic.source) {
        logic.source(this);
      }
    }
  };
}
