import { createRuntimeMemoryService, type RuntimeMemoryService } from "@/runtime/memoryService";
import { createTickContextService, type TickContextService } from "@/runtime/tickContext";
import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

export interface CreepConfigService extends CreepApi {
  upsert(configName: string, role: RoleName, args: string[], roomName?: string): void;
}

export interface RuntimeServices {
  memory: RuntimeMemoryService;
  creepConfigs: CreepConfigService;
  tickContext: TickContextService;
}

type RuntimeGlobalWithServices = typeof global & {
  __runtimeServices?: RuntimeServices;
};

const runtimeGlobal: RuntimeGlobalWithServices = global;

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function isUpsertedConfigCurrent(current: CreepConfig | undefined, next: CreepConfig): boolean {
  if (!current) {
    return false;
  }

  return (
    current.role === next.role &&
    current.roomName === next.roomName &&
    current.name === undefined &&
    current.body === undefined &&
    areStringArraysEqual(current.args, next.args)
  );
}

function createCreepConfigService(memory: RuntimeMemoryService): CreepConfigService {
  return {
    add(configName, role, ...args) {
      memory.getCreepConfigStore()[configName] = { role, args };
      return `${configName} updated: role=${role}, args=${args.join(",")}`;
    },

    remove(configName) {
      delete memory.getCreepConfigStore()[configName];
      return `${configName} removed`;
    },

    get(configName) {
      return memory.getCreepConfigStore()[configName];
    },

    list(prefix) {
      const all = memory.getCreepConfigStore();
      if (!prefix) {
        return { ...all };
      }

      const filtered: Record<string, CreepConfig> = {};
      for (const key of Object.keys(all)) {
        if (key.startsWith(prefix)) {
          filtered[key] = all[key];
        }
      }

      return filtered;
    },

    upsert(configName, role, args, roomName) {
      const current = this.get(configName);
      const next: CreepConfig = { role, args, roomName };
      if (!isUpsertedConfigCurrent(current, next)) {
        memory.getCreepConfigStore()[configName] = next;
      }
    },
  };
}

function createRuntimeServices(): RuntimeServices {
  const memory = createRuntimeMemoryService();
  const creepConfigs = createCreepConfigService(memory);
  const tickContext = createTickContextService();
  return {
    memory,
    creepConfigs,
    tickContext,
  };
}

export function registerRuntimeServices(services?: RuntimeServices): RuntimeServices {
  if (!runtimeGlobal.__runtimeServices) {
    runtimeGlobal.__runtimeServices = services || createRuntimeServices();
  }
  return runtimeGlobal.__runtimeServices;
}

export function getRuntimeServices(): RuntimeServices {
  return registerRuntimeServices();
}

export function getCreepConfigService(): CreepConfigService {
  return getRuntimeServices().creepConfigs;
}

export function getMemoryService(): RuntimeMemoryService {
  return getRuntimeServices().memory;
}

export function getTickContextService(): TickContextService {
  return getRuntimeServices().tickContext;
}
