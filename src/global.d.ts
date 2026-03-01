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
  var stopColonization: (targetRoom?: string) => string;
  var stopColonizationRaw: (targetRoom?: string) =>
    | {
        ok: true;
        scope: "all" | "room";
        targetRoom?: string;
        stoppedColonizationRooms: string[];
        stoppedCrossShardTasks: string[];
        stoppedWarRooms: string[];
        removedConfigs: number;
        removedQueuedTasks: number;
        cancelledSpawns: number;
        suicidedCreeps: number;
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
      crossShard?: {
        enabled?: boolean;
      };
    };
    runtime?: {
      lastDeployTag?: string;
      roomPlannerAuto?: Record<string, number>;
      linkNetwork?: Record<
        string,
        {
          updatedAt: number;
          senderIds: string[];
          receiverIds: string[];
        }
      >;
      towerEmergencyRamparts?: Record<string, Record<string, number>>;
      workerDynamic?: Record<
        string,
        {
          lastLooseEnergy: number;
          trend: number;
          lastTick: number;
        }
      >;
      crossShard?: {
        remotes?: Record<
          string,
          {
            updatedAt: number;
            remoteUpdatedAt: number;
            portalCount: number;
            colonyCount: number;
            claimCount: number;
            roomCount: number;
          }
        >;
        claims?: Record<
          string,
          {
            updatedAt: number;
            by?: string;
          }
        >;
        rooms?: Record<
          string,
          {
            updatedAt: number;
            hasSpawn: boolean;
            hasStorage: boolean;
          }
        >;
      };
    };
    data?: {
      creepConfigs?: Record<string, CreepConfig>;
      colonization?: Record<
        string,
        {
          targetRoom: string;
          sourceRoom: string;
          status: "claiming" | "clearing" | "waiting_plan" | "bootstrapping" | "managed";
          mode?: "normal" | "npcStronghold";
          flagName: string;
          planReady: boolean;
          claimCompleted: boolean;
          scoutSafe?: boolean;
          scoutRouteRooms?: string[];
          dangerousRooms?: string[];
          temporaryDangerousRooms?: Record<string, number>;
          permanentDangerousRooms?: string[];
          scoutedAt?: number;
          createdAt: number;
          updatedAt: number;
        }
      >;
      war?: Record<
        string,
        {
          targetRoom: string;
          sourceRoom: string;
          status: "staging" | "clearing" | "done" | "failed";
          reason: "npc_reservation" | "manual";
          routeRooms?: string[];
          attempts: number;
          createdAt: number;
          updatedAt: number;
          completedAt?: number;
        }
      >;
      roomPlanner?: {
        [roomName: string]: {
          layout: { [structureType: string]: { x: number; y: number }[] };
          timestamp: string;
          savedAt: number;
        };
      };
      crossShardColonization?: Record<
        string,
        {
          targetShard: string;
          targetRoom: string;
          preferredSourceRoom?: string;
          sourceRoom?: string;
          status:
            | "planning"
            | "ready"
            | "spawning"
            | "in_transit"
            | "claimed"
            | "bootstrapping"
            | "completed"
            | "blocked"
            | "failed";
          flagName: string;
          reason?: string;
          portalId?: string;
          portalRoom?: string;
          destinationRoom?: string;
          claimerConfigName?: string;
          claimerName?: string;
          bootstrapConfigNames?: string[];
          bootstrapDispatchedAt?: number;
          launchedAt?: number;
          claimedAt?: number;
          completedAt?: number;
          lastObservedAt?: number;
          createdAt: number;
          updatedAt: number;
          lastReadyAt?: number;
        }
      >;
      interShardPortals?: Record<
        string,
        {
          id: string;
          originRoom: string;
          destinationShard: string;
          destinationRoom?: string;
          discoveredAt: number;
          lastSeenAt: number;
          ticksToDecay?: number;
        }
      >;
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
    roleArgs?: string[];
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
    colonizationLastHits?: number;
    colonizationLastSeenAt?: number;
    colonizationLastRoomName?: string;
    colonizationLastRoomHostileOwned?: boolean;
    colonizationLastHadHostileCreepAttack?: boolean;
    colonizationDeathHandled?: boolean;
    scoutVisitedRooms?: string[];
    travelState?: {
      targetRoom: string;
      lastPosKey?: string;
      stuckTicks: number;
    };
  }

  interface RoomMemory {
    tasks?: Record<string, import("@/types/system").WorkerTask>;
    workerConstructionTier?: 0 | 1 | 2 | 3;
    coreRampartHits?: Record<string, number>;
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
    stopColonization: (targetRoom?: string) => string;
    stopColonizationRaw: (targetRoom?: string) =>
      | {
          ok: true;
          scope: "all" | "room";
          targetRoom?: string;
          stoppedColonizationRooms: string[];
          stoppedCrossShardTasks: string[];
          stoppedWarRooms: string[];
          removedConfigs: number;
          removedQueuedTasks: number;
          cancelledSpawns: number;
          suicidedCreeps: number;
        }
      | string;
    __screepsMounted?: boolean;
  }
}

export {};
