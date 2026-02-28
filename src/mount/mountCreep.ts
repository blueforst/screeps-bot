import { roleRegistry } from "@/roles";
import { decodeCrossShardTravelerName } from "@/runtime/crossShardNaming";

const runtimeGlobal = global;

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
  const configName = creep.memory.configName;
  if (configName) {
    const config = runtimeGlobal.creepApi.get(configName);
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
    const logic = resolveRoleLogic(this);
    if (!logic) {
      this.say("no-config");
      return;
    }

    if (!this.memory.ready) {
      this.memory.ready = logic.prepare ? logic.prepare(this) : true;
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
