import type { LoDashStatic } from "lodash";
import type { CreepApi, CreepConfig, RoleName, RoomType, WorkerTaskType } from "@/types/system";
import type { HubProgressSnapshot } from "@/runtime/hubProgress";
import type {
  SynthesisRoomCapability,
  SynthesisDispatchAssignment,
  AllocationLedgerEntry,
  DirectRouteDecision,
  ProgressEdge,
} from "@/runtime/hubPlanner";

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
          fixedActionCounts: Record<string, number>;
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
  var statusHub: () => string;
  var statusHubRaw: () => Record<string, unknown>;
  var stopHub: () => string;
  var stopHubRaw: () => Record<string, unknown>;
  var hubProgress: () => string;
  var hubProgressRaw: () => HubProgressSnapshot;
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

  type PowerBankHarvestStatus =
    | "discovered"
    | "preparing_boosts"
    | "spawning"
    | "boosting"
    | "renewing"
    | "travelling"
    | "attacking"
    | "hauling"
    | "complete"
    | "failed"
    | "aborted";

  interface PowerBankHarvestTask {
    id: string;
    status: PowerBankHarvestStatus;
    sourceRoom: string;
    targetRoom: string;
    bankId: string;
    bankPos: { x: number; y: number };
    hits: number;
    power: number;
    ticksToDecay: number;
    freeTiles: number;
    discoveredTick: number;
    lastSeenTick: number;
    attackerId?: string;
    healerId?: string;
    haulerIds: string[];
    boostLabs: string[];
    compoundTransferTaskIds: string[];
  }

  interface PowerBankScoutMemory {
    taskId: string;
  }

  interface PowerBankAttackerMemory {
    taskId: string;
  }

  interface PowerBankHealerMemory {
    taskId: string;
  }

  interface PowerBankHaulerMemory {
    taskId: string;
  }

  interface Memory {
    cfg?: {
      rooms?: Record<
        string,
        {
          type?: RoomType;
        }
      >;
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
      homeDefense?: {
        boostTarget?: number;
        maxDefenders?: number;
        maxBoostBuyPrice?: number;
        maxBoostDealEnergyCostRatio?: number;
        rooms?: Record<string, { boostLabId?: string }>;
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
            mineralFloor?: Partial<Record<ResourceConstant, number>>;
            mineralExportStart?: Partial<Record<ResourceConstant, number>>;
          }
        >;
        market?: {
          enabled?: boolean;
          emergencyBuyEnabled?: boolean;
          nativeMineralAutoSellThreshold?: number;
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
      hub?: {
        enabled?: boolean;
        hubRoomName?: string;
        planInterval?: number;
        reservePerRoom?: number;
        hubReservePerCompound?: number;
        targetCompounds?: ResourceConstant[];
        storagePauseFreeCapacity?: number;
        surplusThreshold?: number;
        internalOnly?: boolean;
        marketSellEnabled?: boolean;
      };
    };
    runtime?: {
      lastDeployTag?: string;
      spawnPlanner?: {
        sourceWorkerCommutes: Record<
          string,
          {
            commute: number;
            updatedAt: number;
          }
        >;
      };
      roomPlannerBuild?: {
        rooms: Record<
          string,
          {
            lastRunAt?: number;
          }
        >;
      };
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
      illegalStructureCleanup?: {
        rooms: Record<
          string,
          {
            completedAt: number;
            layoutSavedAt: number;
          }
        >;
      };
      defenseCoordination?: Record<
        string,
        {
          fronts: Array<{
            id: string;
            hostileIds: string[];
            centroid: { x: number; y: number };
            threatScore: number;
          }>; 
          towerFocusFrontId?: string;
          defenderAssignments?: Record<string, string>;
          defenderRoles?: Record<string, "primary" | "secondary">;
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
            loadingSinceTick?: number;
            boostPause?: {
              reason: "powerBankBoost";
              taskId: string;
              createdTick: number;
              pausedPlan: {
                product: ResourceConstant;
                targetAmount: number;
                batchSize: number;
                donorRoomNames: string[];
              } | null;
              pausedStage: "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked";
            };
          }
        >;
      };
      hub?: {
        status?: "idle" | "importing" | "synthesizing" | "distributing" | "blocked";
        updatedAt?: number;
        activeProduct?: string;
        activeStep?: number;
        missingResources?: string[];
        lastPlanActions?: string[];
        needsPlan?: boolean;
        lastPlanTick?: number;
        lastError?: string;
        marketSellSurplus?: Partial<Record<ResourceConstant, number>>;
        distributedSynthesis?: {
          roomCapabilities?: Record<string, SynthesisRoomCapability>;
          dispatchAssignments?: SynthesisDispatchAssignment[];
          allocationLedger?: Record<string, AllocationLedgerEntry>;
          routeDecisions?: DirectRouteDecision[];
          progressEdges?: ProgressEdge[];
        };
      };
      resourceReservations?: Record<
        string,
        {
          roomName: string;
          resource: ResourceConstant;
          holderId: string;
          amount: number;
          updatedAt: number;
          expiresAt: number;
        }
      >;
      powerBankBoost?: Record<
        string,
        {
          labs: Record<string, { labId: string; compound: ResourceConstant }>;
          taskId: string;
          sourceRoomName: string;
        }
      >;
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
          cachedTravelPath?: {
            key: string;
            sourceRoom: string;
            targetRoom: string;
            routeRooms: string[];
            positions: { x: number; y: number; roomName: string }[];
            generatedAt: number;
          };
          dangerousRooms?: string[];
          temporaryDangerousRooms?: Record<string, number>;
          permanentDangerousRooms?: string[];
          scoutedAt?: number;
          safeRouteRetryAt?: number;
          safeRouteRetryKey?: string;
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
      rescue?: Record<
        string,
        {
          targetRoom: string;
          sourceRoom: string;
          status: "bootstrapping" | "managed";
          flagName: string;
          routeRooms?: string[];
          createdAt: number;
          updatedAt: number;
        }
      >;
      flagHauling?: Record<
        string,
        {
          targetRoom: string;
          sourceRoom: string;
          flagName: string;
          targetX: number;
          targetY: number;
          createdAt: number;
          updatedAt: number;
        }
      >;
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
      powerBankHarvest?: Record<string, PowerBankHarvestTask>;
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
          fixedActionCounts: Record<string, number>;
          untracked: number;
        };
      };
      hub?: {
        updatedAt: number;
        enabled: boolean;
        hubRoomName: string;
        hubRoomVisible: boolean;
        status: string | null;
        stage: string | null;
        activeProduct: string | null;
        lastPlanActions: string[];
        missingResources: string[];
        lastError: string | null;
        needsPlan: boolean;
        hubStorageEnergy: number;
        hubTerminalEnergy: number;
        hubInventory: Record<string, number>;
        pendingImports: number;
        pendingReclaims: number;
        pendingExports: number;
        pendingTasks: Array<{
          resource: string;
          from: string;
          to: string;
          remaining: number;
          reason: string;
        }>;
        roomTerminalBlockers: Array<{
          room: string;
          terminalEnergy: number;
          reserve: number;
          pendingNonEnergy: number;
        }>;
        productionRooms: Array<{
          roomName: string;
          product: ResourceConstant;
          stage: string;
          progressPercent: number;
          currentAmount: number;
          targetAmount: number;
          isHubRoom: boolean;
          upstream: Array<{ roomName: string; resource: ResourceConstant }>;
          downstream: Array<{ roomName: string; resource: ResourceConstant }>;
          directSupplyAmount: number;
          hubSurplusAmount: number;
          blocker: string | null;
        }>;
      };
    };
  }

  interface CreepMemory {
    role?: RoleName;
    roleArgs?: string[];
    configName?: string;
    working?: boolean;
    ready?: boolean;
    colonizationLastHits?: number;
    colonizationLastSeenAt?: number;
    colonizationLastRoomName?: string;
    colonizationLastRoomHostileOwned?: boolean;
    colonizationLastHadHostileCreepAttack?: boolean;
    colonizationDeathHandled?: boolean;
    scoutVisitedRooms?: string[];
    _patrol?: { patrolIndex?: number };
    _move?: {
      dest?: {
        x: number;
        y: number;
        room: string;
      };
      path?: string;
      time?: number;
      room?: string;
    };
  }

  interface RoomMemory {
    workerConstructionTier?: 0 | 1 | 2 | 3;
    coreRampartHits?: Record<string, number>;
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
            fixedActionCounts: Record<string, number>;
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
        fixedActionCounts: Record<string, number>;
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
          avgFixedActionCounts: Record<string, number>;
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
    statusHub: () => string;
    statusHubRaw: () => Record<string, unknown>;
    stopHub: () => string;
    stopHubRaw: () => Record<string, unknown>;
    hubProgress: () => string;
    hubProgressRaw: () => HubProgressSnapshot;
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
