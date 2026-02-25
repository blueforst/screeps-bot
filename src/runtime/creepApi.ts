import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

const runtimeGlobal = global;

function getStore(): Record<string, CreepConfig> {
  Memory.data = Memory.data || {};
  if (!Memory.data.creepConfigs) {
    Memory.data.creepConfigs = {};
  }
  return Memory.data.creepConfigs;
}

const apiImpl: CreepApi = {
  add(configName, role, ...args) {
    getStore()[configName] = { role, args };
    return `${configName} updated: role=${role}, args=${args.join(",")}`;
  },
  remove(configName) {
    delete getStore()[configName];
    return `${configName} removed`;
  },
  get(configName) {
    return getStore()[configName];
  },
  list(prefix) {
    const all = getStore();
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
};

export function registerGlobalApi(): void {
  runtimeGlobal.creepApi = apiImpl;
}

export function upsertConfig(configName: string, role: RoleName, args: string[], roomName?: string): void {
  const current = runtimeGlobal.creepApi.get(configName);
  const next: CreepConfig = { role, args, roomName };
  if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
    getStore()[configName] = next;
  }
}
