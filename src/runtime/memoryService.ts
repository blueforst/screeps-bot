import type { CreepConfig } from "@/types/system";

export interface RuntimeMemoryService {
  ensureCfg(): NonNullable<Memory["cfg"]>;
  ensureRuntime(): NonNullable<Memory["runtime"]>;
  ensureData(): NonNullable<Memory["data"]>;
  ensureAnalytics(): NonNullable<Memory["analytics"]>;
  getCreepConfigStore(): Record<string, CreepConfig>;
}

export function ensureRuntimeMemoryRoot(): NonNullable<Memory["runtime"]> {
  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  return Memory.runtime;
}

export function createRuntimeMemoryService(): RuntimeMemoryService {
  return {
    ensureCfg(): NonNullable<Memory["cfg"]> {
      if (!Memory.cfg) {
        Memory.cfg = {};
      }
      return Memory.cfg;
    },

    ensureRuntime(): NonNullable<Memory["runtime"]> {
      return ensureRuntimeMemoryRoot();
    },

    ensureData(): NonNullable<Memory["data"]> {
      if (!Memory.data) {
        Memory.data = {};
      }
      return Memory.data;
    },

    ensureAnalytics(): NonNullable<Memory["analytics"]> {
      if (!Memory.analytics) {
        Memory.analytics = {};
      }
      return Memory.analytics;
    },

    getCreepConfigStore(): Record<string, CreepConfig> {
      const data = this.ensureData();
      if (!data.creepConfigs) {
        data.creepConfigs = {};
      }
      return data.creepConfigs;
    },
  };
}
