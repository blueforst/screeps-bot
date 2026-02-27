import type { LoDashStatic } from "lodash";
import type { CreepApi, CreepConfig, RoleName, WorkerTaskType } from "@/types/system";

declare const _: LoDashStatic;

declare global {
  const __BUILD_VERSION__: string;
  const __BUILD_GIT_HASH__: string;
  const __BUILD_TIME__: string;
  const __BUILD_TAG__: string;

  var creepApi: CreepApi;
  var __screepsMounted: boolean | undefined;
  var RP: (room: string | Room) => { [structureType: string]: { x: number; y: number }[] } | undefined;
  var runPlan: (room: string | Room) => boolean;
  var visualizePlan: (roomName: string) => boolean;
  var listPlanCache: () => void;
  var clearRoomPlanCache: (roomName: string) => void;
  var savePlanToMemory: (roomName: string) => boolean;
  var reportProduction: (roomName?: string) => void;
  var reportProductionGlobal: () => void;
  var spawnMaxCarrier: (roomName: string) =>
    | {
        ok: true;
        roomName: string;
        spawnName: string;
        configName: string;
        energyAvailable: number;
        bodyParts: number;
        pairCount: number;
        queueTop: string[];
      }
    | string;

  interface Memory {
    cfg?: {
      worker?: {
        maxPerRoom?: number;
        dynamicBeforeRcl4?: boolean;
        dynamicMaxBonus?: number;
        useWorkPosAllocation?: boolean;
      };
      energyPickup?: {
        preferredMin?: number;
      };
      pixelGenerator?: {
        enabled?: boolean;
      };
      roomPlannerBuild?: {
        enabled?: boolean;
        maxNewSitesPerRoom?: number;
      };
      productionMonitor?: {
        enabled?: boolean;
      };
    };
    runtime?: {
      lastDeployTag?: string;
      roomPlannerAuto?: Record<string, number>;
      towerEmergencyRamparts?: Record<string, Record<string, number>>;
      workerDynamic?: Record<
        string,
        {
          lastLooseEnergy: number;
          trend: number;
          lastTick: number;
        }
      >;
    };
    data?: {
      creepConfigs?: Record<string, CreepConfig>;
      roomPlanner?: {
        [roomName: string]: {
          layout: { [structureType: string]: { x: number; y: number }[] };
          timestamp: string;
          savedAt: number;
        };
      };
    };
    analytics?: {
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
    };
  }

  interface CreepMemory {
    role?: RoleName;
    configName?: string;
    working?: boolean;
    ready?: boolean;
    carrierPlanMode?: "pickup" | "deliver";
    carrierPlanTargetId?: string;
    carrierPlanTargetKind?: "resource" | "structure";
    energyPickupTargetId?: string;
    energyPickupTargetKind?: "resource" | "structure";
    energyPickupRoomName?: string;
    taskId?: string;
    taskType?: WorkerTaskType;
    taskTargetId?: string;
  }

  interface RoomMemory {
    tasks?: Record<string, import("@/types/system").WorkerTask>;
    workerConstructionTier?: 0 | 1 | 2 | 3;
    pickupReservations?: Record<
      string,
      {
        kind: "resource" | "structure";
        claims: Record<string, { amount: number; until: number }>;
      }
    >;
  }

  interface SpawnMemory {
    spawnList?: string[];
  }

  interface Creep {
    work(): void;
  }

  interface StructureSpawn {
    work(): void;
    addTask(configName: string): number;
    mainSpawn(configName: string): boolean;
  }
}

declare namespace NodeJS {
  interface Global {
    Game: Game;
    Memory: Memory;
    _: LoDashStatic;
    creepApi: CreepApi;
    spawnMaxCarrier: (roomName: string) =>
      | {
          ok: true;
          roomName: string;
          spawnName: string;
          configName: string;
          energyAvailable: number;
          bodyParts: number;
          pairCount: number;
          queueTop: string[];
        }
      | string;
    __screepsMounted?: boolean;
  }
}

export {};
