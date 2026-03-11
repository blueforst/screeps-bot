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
  var spawnMaxCarrierRaw: (roomName: string) =>
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
  var startTelemetry: (sampleInterval?: number, segmentId?: number) => string;
  var startTelemetryRaw: (sampleInterval?: number, segmentId?: number) =>
    | {
        ok: true;
        enabled: boolean;
        previousEnabled: boolean;
        sampleInterval: number;
        segmentId: number;
      }
    | string;
  var stopTelemetry: () => string;
  var stopTelemetryRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    segmentId: number;
  };
  var statusTelemetry: () => string;
  var statusTelemetryRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    segmentId: number;
  };
  var startCpuProfiler: (sampleInterval?: number, historyLimit?: number) => string;
  var startCpuProfilerRaw: (sampleInterval?: number, historyLimit?: number) =>
    | {
        ok: true;
        enabled: boolean;
        previousEnabled: boolean;
        sampleInterval: number;
        historyLimit: number;
      }
    | string;
  var stopCpuProfiler: () => string;
  var stopCpuProfilerRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    historyLimit: number;
  };
  var statusCpuProfiler: () => string;
  var statusCpuProfilerRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    historyLimit: number;
  };
  var cpuMonitor: () => string;
  var cpuMonitorRaw: () => {
    ok: true;
    enabled: boolean;
    sampleInterval: number;
    historyLimit: number;
    historySize: number;
    latest:
      | {
          tick: number;
          shard: string;
          totalUsed: number;
          bucket: number;
          limit: number;
          tickLimit: number;
          phases: Record<string, number>;
          untracked: number;
        }
      | null;
    recentHistory: Array<{
      tick: number;
      shard: string;
      totalUsed: number;
      bucket: number;
      limit: number;
      tickLimit: number;
      phases: Record<string, number>;
      untracked: number;
    }>;
    summary:
      | {
          ticks: number;
          avgTotalUsed: number;
          maxTotalUsed: number;
          minBucket: number;
          maxBucket: number;
          avgBucket: number;
          avgUntracked: number;
          avgPhases: Record<string, number>;
        }
      | null;
  };
  var statusSynthesisControl: () => string;
  var statusSynthesisControlRaw: () => {
    ok: true;
    enabled: boolean;
    state:
      | {
          updatedAt: number;
          generatedTaskCount: number;
          failedTaskCount: number;
          successfulRunCount: number;
          lastActions: string[];
        }
      | null;
  };
  var addResourceTransferTask: (
    fromRoomName: string,
    toRoomName: string,
    resource: ResourceConstant,
    amount: number,
    reason?: string,
  ) => string;
  var addResourceTransferTaskRaw: (
    fromRoomName: string,
    toRoomName: string,
    resource: ResourceConstant,
    amount: number,
    reason?: string,
  ) =>
    | {
        ok: true;
        task: {
          id: string;
          resource: ResourceConstant;
          fromRoomName: string;
          toRoomName: string;
          amount: number;
          remainingAmount: number;
          status: "pending" | "done" | "cancelled" | "failed";
          createdAt: number;
          updatedAt: number;
          reason?: string;
          lastError?: string;
        };
      }
    | string;
  var cancelResourceTransferTask: (taskId: string) => string;
  var cancelResourceTransferTaskRaw: (taskId: string) =>
    | {
        ok: true;
        taskId: string;
        previousStatus: "pending" | "done" | "cancelled" | "failed";
      }
    | string;
  var listResourceTransferTasks: () => string;
  var listResourceTransferTasksRaw: () => {
    ok: true;
    tasks: Array<{
      id: string;
      resource: ResourceConstant;
      fromRoomName: string;
      toRoomName: string;
      amount: number;
      remainingAmount: number;
      status: "pending" | "done" | "cancelled" | "failed";
      createdAt: number;
      updatedAt: number;
      reason?: string;
      lastError?: string;
    }>;
  };

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
      telemetry?: {
        enabled?: boolean;
        sampleInterval?: number;
        segmentId?: number;
      };
      cpuProfiler?: {
        enabled?: boolean;
        sampleInterval?: number;
        historyLimit?: number;
      };
      synthesisControl?: {
        enabled?: boolean;
        sampleInterval?: number;
        defaultBatchSize?: number;
        defaultMaxRunsPerTick?: number;
        rooms?: Record<
          string,
          {
            enabled?: boolean;
            batchSize?: number;
            maxRunsPerTick?: number;
            donorRoomNames?: string[];
            reagentLabIds?: string[];
            reactions?: Array<
              {
                product?: ResourceConstant;
                targetAmount?: number;
                batchSize?: number;
                donorRoomNames?: string[];
              }
            >;
          }
        >;
      };
      resourceControl?: {
        enabled?: boolean;
        sampleInterval?: number;
        taskMaxPerRun?: number;
        rooms?: Record<
          string,
          {
            energyFloor?: number;
            energyTarget?: number;
            energyExportStart?: number;
            terminalEnergyReserve?: number;
            transferBatchSize?: number;
            transferMinAmount?: number;
            mineralFloor?: Partial<Record<ResourceConstant, number>>;
            mineralExportStart?: Partial<Record<ResourceConstant, number>>;
          }
        >;
        market?: {
          enabled?: boolean;
          emergencyBuyEnabled?: boolean;
          maxDealsPerRun?: number;
          minDealAmount?: number;
          maxDealAmount?: number;
          maxDealEnergyCostRatio?: number;
          minSellPrice?: Partial<Record<ResourceConstant, number>>;
          maxBuyPrice?: Partial<Record<ResourceConstant, number>>;
          sellResources?: ResourceConstant[];
          buyResources?: ResourceConstant[];
        };
        synthesis?: {
          enabled?: boolean;
          maxGeneratedPerRun?: number;
          rooms?: Record<
            string,
            {
              demands?: Partial<Record<ResourceConstant, number>>;
              donorRoomNames?: string[];
            }
          >;
        };
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
      towerCombat?: Record<
        string,
        {
          focusTargetId?: string;
          lastFocusHits?: number;
          stalledTicks?: number;
          spreadUntil?: number;
        }
      >;
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
      resourceControl?: {
        updatedAt: number;
        rooms: Record<
          string,
          {
            state: "survival" | "balanced" | "export";
            storageEnergy: number;
            terminalEnergy: number;
            energyFloor: number;
            energyTarget: number;
            energyExportStart: number;
            nativeMineralType?: MineralConstant;
            canMineNative: boolean;
            minerals: Partial<Record<ResourceConstant, number>>;
          }
        >;
        lastActions: string[];
        lastMarketActions: string[];
        synthesisBindings?: Record<
          string,
          {
            fromRoomName: string;
            updatedAt: number;
            expiresAt: number;
          }
        >;
      };
      synthesisControl?: {
        updatedAt: number;
        generatedTaskCount: number;
        failedTaskCount: number;
        successfulRunCount: number;
        lastActions: string[];
        bindings: Record<
          string,
          {
            fromRoomName: string;
            updatedAt: number;
            expiresAt: number;
          }
        >;
        rooms: Record<
          string,
          {
            stage: "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked";
            activeProduct?: ResourceConstant;
            reagentA?: ResourceConstant;
            reagentB?: ResourceConstant;
            targetAmount?: number;
            batchSize?: number;
            reagentLabIds: string[];
            productLabIds: string[];
            successfulRuns: number;
            pendingTasks: number;
            missing?: Partial<Record<ResourceConstant, number>>;
            cleanupTasks?: Array<{
              labId: string;
              resource: ResourceConstant;
              amount: number;
              target: "terminal" | "storage";
            }>;
            lastError?: string;
            lastTransitionAt: number;
          }
        >;
      };
    };
    data?: {
      creepConfigs?: Record<string, CreepConfig>;
      resourceControl?: {
        tasks?: Record<
          string,
          {
            id: string;
            resource: ResourceConstant;
            fromRoomName: string;
            toRoomName: string;
            amount: number;
            remainingAmount: number;
            status: "pending" | "done" | "cancelled" | "failed";
            createdAt: number;
            updatedAt: number;
            reason?: string;
            lastError?: string;
          }
        >;
      };
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
          untracked: number;
        };
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
    carrierStorageOnlyMode?: boolean;
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
    synthesisCarrierTaskId?: string;
    travelState?: {
      targetRoom: string;
      lastPosKey?: string;
      stuckTicks: number;
    };
    movePathState?: {
      key: string;
      path: string;
      targetRoom: string;
      targetX: number;
      targetY: number;
      range: 0 | 1 | 3;
      lastPosKey?: string;
      stuckTicks: number;
      expiresAt: number;
    };
  }

  interface RoomMemory {
    tasks?: Record<string, import("@/types/system").WorkerTask>;
    carrierTasks?: Record<
      string,
      {
        id: string;
        producer: string;
        roomName: string;
        type: "lab_supply" | "lab_cleanup";
        priority: number;
        steps: Array<{
          id: string;
          resource: ResourceConstant;
          fromKind: "lab" | "terminal" | "storage";
          toKind: "lab" | "terminal" | "storage";
          fromId: string;
          toId: string;
          amount: number;
        }>;
        createdAt: number;
        updatedAt: number;
      }
    >;
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
    reportProduction: (roomName?: string) => void;
    reportProductionGlobal: () => void;
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
    spawnMaxCarrierRaw: (roomName: string) =>
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
    startTelemetry: (sampleInterval?: number, segmentId?: number) => string;
    startTelemetryRaw: (sampleInterval?: number, segmentId?: number) =>
      | {
          ok: true;
          enabled: boolean;
          previousEnabled: boolean;
          sampleInterval: number;
          segmentId: number;
        }
      | string;
    stopTelemetry: () => string;
    stopTelemetryRaw: () => {
      ok: true;
      enabled: boolean;
      previousEnabled: boolean;
      sampleInterval: number;
      segmentId: number;
    };
    statusTelemetry: () => string;
    statusTelemetryRaw: () => {
      ok: true;
      enabled: boolean;
      previousEnabled: boolean;
      sampleInterval: number;
      segmentId: number;
    };
    startCpuProfiler: (sampleInterval?: number, historyLimit?: number) => string;
    startCpuProfilerRaw: (sampleInterval?: number, historyLimit?: number) =>
      | {
          ok: true;
          enabled: boolean;
          previousEnabled: boolean;
          sampleInterval: number;
          historyLimit: number;
        }
      | string;
    stopCpuProfiler: () => string;
    stopCpuProfilerRaw: () => {
      ok: true;
      enabled: boolean;
      previousEnabled: boolean;
      sampleInterval: number;
      historyLimit: number;
    };
    statusCpuProfiler: () => string;
    statusCpuProfilerRaw: () => {
      ok: true;
      enabled: boolean;
      previousEnabled: boolean;
      sampleInterval: number;
      historyLimit: number;
    };
    cpuMonitor: () => string;
    cpuMonitorRaw: () => {
      ok: true;
      enabled: boolean;
      sampleInterval: number;
      historyLimit: number;
      historySize: number;
      latest:
        | {
            tick: number;
            shard: string;
            totalUsed: number;
            bucket: number;
            limit: number;
            tickLimit: number;
            phases: Record<string, number>;
            untracked: number;
          }
        | null;
      recentHistory: Array<{
        tick: number;
        shard: string;
        totalUsed: number;
        bucket: number;
        limit: number;
        tickLimit: number;
        phases: Record<string, number>;
        untracked: number;
      }>;
      summary:
        | {
            ticks: number;
            avgTotalUsed: number;
            maxTotalUsed: number;
            minBucket: number;
            maxBucket: number;
            avgBucket: number;
            avgUntracked: number;
            avgPhases: Record<string, number>;
          }
        | null;
    };
    statusSynthesisControl: () => string;
    statusSynthesisControlRaw: () => {
      ok: true;
      enabled: boolean;
      state:
        | {
            updatedAt: number;
            generatedTaskCount: number;
            failedTaskCount: number;
            successfulRunCount: number;
            lastActions: string[];
          }
        | null;
    };
    addResourceTransferTask: (
      fromRoomName: string,
      toRoomName: string,
      resource: ResourceConstant,
      amount: number,
      reason?: string,
    ) => string;
    addResourceTransferTaskRaw: (
      fromRoomName: string,
      toRoomName: string,
      resource: ResourceConstant,
      amount: number,
      reason?: string,
    ) =>
      | {
          ok: true;
          task: {
            id: string;
            resource: ResourceConstant;
            fromRoomName: string;
            toRoomName: string;
            amount: number;
            remainingAmount: number;
            status: "pending" | "done" | "cancelled" | "failed";
            createdAt: number;
            updatedAt: number;
            reason?: string;
            lastError?: string;
          };
        }
      | string;
    cancelResourceTransferTask: (taskId: string) => string;
    cancelResourceTransferTaskRaw: (taskId: string) =>
      | {
          ok: true;
          taskId: string;
          previousStatus: "pending" | "done" | "cancelled" | "failed";
        }
      | string;
    listResourceTransferTasks: () => string;
    listResourceTransferTasksRaw: () => {
      ok: true;
      tasks: Array<{
        id: string;
        resource: ResourceConstant;
        fromRoomName: string;
        toRoomName: string;
        amount: number;
        remainingAmount: number;
        status: "pending" | "done" | "cancelled" | "failed";
        createdAt: number;
        updatedAt: number;
        reason?: string;
        lastError?: string;
      }>;
    };
    __screepsMounted?: boolean;
  }
}

export {};
