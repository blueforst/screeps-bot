import type { CpuMonitorMemoryV2 } from "@/runtime/cpuMonitor";
import type { HubProgressSnapshot } from "@/runtime/hubProgress";
import type { WarStatusTaskSnapshot } from "@/runtime/warControl";

declare global {
  interface ScreepsMemoryAnalytics {
    production?: {
      rooms?: Record<
        string,
        {
          updatedAt: number;
          signal?: {
            looseEnergyTrend: number;
            sourceEnergyTrend: number;
            upgradeRate: number;
            spawnBusy: number;
          };
          latest?: {
            tick: number;
            looseEnergy: number;
            storedEnergy: number;
            sourceEnergy: number;
            workerCount: number;
            carrierCount: number;
            harvesterCount: number;
            spawnSpawning: number;
            controllerLevel: number;
            controllerProgress: number;
          };
        }
      >;
    };
    war?: {
      updatedAt: number;
      clearDebounceTicks: number;
      tasks: Record<string, WarStatusTaskSnapshot>;
    };
    moduleCpu?: {
      updatedAt: number;
      sampleInterval: number;
      historyLimit: number;
      latest: {
        tick: number;
        shard: string;
        totalUsed: number;
        bucket: number;
        limit: number;
        tickLimit: number;
        phases: Record<string, number>;
        fixedActionCounts: Record<string, number>;
        untracked: number;
      };
    };
    /** CPU Monitor v2 (canonical). Legacy moduleCpu kept during migration. */
    cpuMonitor?: CpuMonitorMemoryV2;
    hub?: HubProgressSnapshot;
  }
}

export {};
