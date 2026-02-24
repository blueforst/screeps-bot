import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

function getStore(): Record<string, CreepConfig> {
  if (!Memory.creepConfigs) {
    Memory.creepConfigs = {};
  }
  return Memory.creepConfigs;
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
    return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(prefix)));
  },
};

export function registerGlobalApi(): void {
  globalThis.creepApi = apiImpl;
}

export function upsertConfig(configName: string, role: RoleName, args: string[], roomName?: string): void {
  const current = globalThis.creepApi.get(configName);
  const next: CreepConfig = { role, args, roomName };
  if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
    getStore()[configName] = next;
  }
}
