import type { LoDashStatic } from "lodash";
import type { CreepApi, CreepConfig, RoleName, RoomType } from "@/types/system";
import type { HubProgressSnapshot } from "@/runtime/hubProgress";
import type { RemoteMiningTask } from "@/runtime/remoteMining";
import type {
  SynthesisRoomCapability,
  SynthesisDispatchAssignment,
  AllocationLedgerEntry,
  DirectRouteDecision,
  ProgressEdge,
} from "@/runtime/hubPlanner";
import type { CpuMonitorMemoryV2, CpuMonitorHeapSnapshot } from "@/runtime/cpuMonitor";
import type { AddFactoryTaskResult, CancelFactoryTaskResult, FactoryTask } from "@/runtime/factoryControl";
import type { StartWarOptions, StartWarResult, StopWarOptions, StopWarResult, WarStatusSnapshot, WarStatusTaskSnapshot } from "@/runtime/warControl";
import type { RemoteDefenseStatusSnapshot } from "@/runtime/console/remoteDefenseCommands";

declare const _: LoDashStatic;

type ResourceTransferTaskConsoleRecord = {
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

type ManualResourceTransferRequest =
  | [toRoomName: string, resource: ResourceConstant, amount: number, reason?: string]
  | {
      toRoomName: string;
      resource: ResourceConstant;
      amount: number;
      reason?: string;
    };

type AddResourceTransferTasksResult = {
  ok: true;
  fromRoomName: string;
  created: ResourceTransferTaskConsoleRecord[];
  errors: Array<{
    index: number;
    request: ManualResourceTransferRequest;
    error: string;
  }>;
};

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
  var stopWar: (targetRoom: string, suicide?: boolean) => string;
  var stopWarRaw: (targetRoom: string, options?: StopWarOptions) => StopWarResult | string;
  var startWar: (targetRoom: string, sourceRoom: string, squad?: "standard" | "t3Duo", routeRooms?: string[] | string, oneShot?: boolean) => string;
  var startWarRaw: (targetRoom: string, sourceRoom: string, options?: StartWarOptions) => StartWarResult | string;
  var warStatus: (targetRoom?: string) => string;
  var warStatusRaw: (targetRoom?: string) => WarStatusSnapshot;
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
    version: 2;
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
          emaTotalUsed: number;
          rooms: Record<
            string,
            {
              totalUsed: number;
              roles: Record<string, { count: number; used: number }>;
            }
          >;
          heap: CpuMonitorHeapSnapshot | null;
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
      emaTotalUsed: number;
      rooms: Record<
        string,
        {
          totalUsed: number;
          roles: Record<string, { count: number; used: number }>;
        }
      >;
      heap: CpuMonitorHeapSnapshot | null;
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
          emaTotalUsed: number;
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
          task: ResourceTransferTaskConsoleRecord;
        }
      | string;
  var addResourceTransferTasks: (
    fromRoomName: string,
    requests: ManualResourceTransferRequest[],
    reason?: string,
  ) => string;
  var addResourceTransferTasksRaw: (
    fromRoomName: string,
    requests: ManualResourceTransferRequest[],
    reason?: string,
  ) => AddResourceTransferTasksResult | string;
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
    tasks: ResourceTransferTaskConsoleRecord[];
  };
  var addFactoryTask: (roomName: string, type: "decompress_battery", amount: number) => string;
  var addFactoryTaskRaw: (roomName: string, type: "decompress_battery", amount: number) => AddFactoryTaskResult | string;
  var decompressBattery: (roomName: string, amount: number) => string;
  var decompressBatteryRaw: (roomName: string, amount: number) => AddFactoryTaskResult | string;
  var cancelFactoryTask: (taskId: string) => string;
  var cancelFactoryTaskRaw: (taskId: string) => CancelFactoryTaskResult | string;
  var listFactoryTasks: (roomName?: string) => string;
  var listFactoryTasksRaw: (roomName?: string) => FactoryTask[];
  var remoteDefenseStatus: (targetRoom: string) => string;
  var remoteDefenseStatusRaw: (targetRoom: string) => RemoteDefenseStatusSnapshot | string;

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

  type PowerBankReinforcementStage = "spawning" | "renewing" | "boosting" | "travelling" | "attacking";

  interface PowerBankReinforcementState {
    index: number;
    stage: PowerBankReinforcementStage;
    attackerId?: string;
    healerId?: string;
    attackerReady?: boolean;
    healerReady?: boolean;
  }

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
    /** Body tier (RCL number) selected by viability assessment. */
    tier?: number;
    /** Linear distance from source room to target room. */
    routeDistance?: number;
    /** Number of haulers needed to collect the dropped power. */
    haulerCount?: number;
    /** Viability failure reason(s), set when status becomes failed. */
    failReason?: string;
    /** Tick when task entered a terminal state (complete/failed/aborted). */
    terminalTick?: number;
    /** Whether the attacker has been fully boosted and is ready. */
    attackerReady?: boolean;
    /** Whether the healer has been fully boosted and is ready. */
    healerReady?: boolean;
    /** Tick when the task entered hauling after the bank disappeared. */
    haulingStartedTick?: number;
    /** Tick when the target room was visible with no dropped power remaining. */
    haulingEmptySince?: number;
    /** Optional replacement combat pair prepared while the active pair keeps attacking. */
    reinforcement?: PowerBankReinforcementState;
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
        /** Room names where carriers may withdraw ENERGY from terminal as a generic pickup source. */
        terminalPickupRooms?: Record<string, boolean>;
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
        emaAlpha?: number;
        roomRoleAggregation?: boolean;
        heapStats?: boolean;
        fixedActionCpuCost?: number;
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
        capacityBalancing?: {
          enabled?: boolean;
          terminalHeadroomRecoveryEnabled?: boolean;
          storagePressureFreeCapacity?: number;
          storageReliefTargetFreeCapacity?: number;
          receiverStorageMinFreeCapacity?: number;
          terminalPressureFreeCapacity?: number;
          terminalReliefTargetFreeCapacity?: number;
          receiverTerminalMinFreeCapacity?: number;
          maxPlannedAmountPerTask?: number;
          maxNewTasksPerRun?: number;
          automaticTaskNoProgressTtl?: number;
          sourceDepletedGraceTicks?: number;
          t3ReservePerRoom?: number;
        };
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
        /** When true (default), non-T3 surplus stays local; only T3 centralizes to hub. */
        distributedStorage?: boolean;
      };
      factoryControl?: {
        enabled?: boolean;
        terminalEnergyReserve?: number;
        market?: {
          enabled?: boolean;
          sellResources?: ResourceConstant[];
          minSellPrice?: Partial<Record<ResourceConstant, number>>;
          minNetCredits?: number;
          minOrderAmount?: number;
          minPriceRatio?: number;
          maxEnergyCostRatio?: number;
          orderBlacklist?: string[];
          orderAllowlist?: string[];
          roomAllowlist?: string[];
          purchaseEnabled?: boolean;
          maxBuyPrice?: Partial<Record<ResourceConstant, number>>;
          maxBatch?: number;
          dailyBudget?: number;
          creditReserve?: number;
          buyResources?: ResourceConstant[];
        };
        targetQueue?: ResourceConstant[];
        targets?: Array<{
          resource: ResourceConstant;
          targetAmount?: number;
          cap?: number;
        }>;
        resourceFloors?: Partial<Record<ResourceConstant, number>>;
        productionCaps?: Partial<Record<ResourceConstant, number>>;
        sleepSettings?: {
          cooldownOnError?: number;
          cooldownOnMissing?: number;
          maxSleepTicks?: number;
        };
        rooms?: Record<
          string,
          {
            enabled?: boolean;
            targetQueue?: ResourceConstant[];
            targets?: Array<{
              resource: ResourceConstant;
              targetAmount?: number;
              cap?: number;
            }>;
            resourceFloors?: Partial<Record<ResourceConstant, number>>;
            productionCaps?: Partial<Record<ResourceConstant, number>>;
            sleepTicks?: number;
          }
        >;
      };
      remoteMining?: {
        enabled?: boolean;
        scanInterval?: number;
        roadInterval?: number;
        scoutTimeout?: number;
        maxRemoteRoomsPerSourceRoom?: number;
        maintenanceReserveEnergy?: number;
        maxRemoteSitesPerRun?: number;
        remoteSafeTicksToResume?: number;
        remoteReservationRenewAt?: number;
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
        capacityPolicy?: {
          terminalHeadroomRecoveryEnabled: boolean;
          storagePressureFreeCapacity: number;
          storageReliefTargetFreeCapacity: number;
          receiverStorageMinFreeCapacity: number;
          terminalPressureFreeCapacity: number;
          receiverTerminalMinFreeCapacity: number;
          terminalReliefTargetFreeCapacity: number;
        };
        rooms: Record<
          string,
          {
            state: "survival" | "balanced" | "export";
            capacityState?: "normal" | "pressure" | "emergency";
            storageUsedCapacity?: number;
            storageFreeCapacity?: number;
            terminalUsedCapacity?: number;
            terminalFreeCapacity?: number;
            storageEnergy: number;
            terminalEnergy: number;
            energyFloor: number;
            energyTarget: number;
            energyExportStart: number;
            terminalEnergyReserve?: number;
            nativeMineralType?: MineralConstant;
            canMineNative: boolean;
            minerals: Partial<Record<ResourceConstant, number>>;
            taskHealth?: {
              pendingIncoming: number;
              pendingOutgoing: number;
              blockedIncoming: Partial<
                Record<
                  "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
                  number
                >
              >;
              blockedOutgoing: Partial<
                Record<
                  "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
                  number
                >
              >;
            };
          }
        >;
        lastActions: string[];
        lastMarketActions: string[];
        taskSummary?: {
          pending: number;
          manualPending: number;
          automaticPending: number;
          blockedByReason: Partial<
            Record<
              "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
              number
            >
          >;
        };
        recentCapacityReliefRoutes?: Array<{
          tick: number;
          taskId: string;
          fromRoomName: string;
          toRoomName: string;
          resource: ResourceConstant;
          amount: number;
          transferCost: number;
        }>;
        synthesisBindings?: Record<
          string,
          {
            fromRoomName: string;
            updatedAt: number;
            expiresAt: number;
          }
        >;
      };
      factoryControl?: {
        updatedAt?: number;
        rooms: Record<
          string,
          {
            stage: "idle" | "acquiring" | "loading" | "producing" | "unloading" | "blocked" | "sleeping";
            activeTarget?: ResourceConstant;
            missing?: Partial<Record<ResourceConstant, number>>;
            sleepReason?: string;
            sleepUntilTick?: number;
            lastError?: string;
            lastTransitionAt: number;
            loadingSinceTick?: number;
          }
        >;
        claimedOrders?: Array<{
          orderId: string;
          roomName: string;
          tick: number;
          purpose: "sell" | "buy";
        }>;
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
      powerBankObserver?: {
        patrolIndex: number;
        updatedAt: number;
        lastObservedRooms: string[];
        coveredRooms: string[];
      };
      remoteMining?: {
        lastScanAt?: number;
      };
      /** Power bank scout transit danger rooms: roomName -> expiresAt tick. */
      transitDangerRooms?: Record<string, number>;
      /** Power bank scout hostile-owned or hostile-reserved transit rooms. */
      powerBankPermanentDangerRooms?: Record<string, true>;
    };
    data?: {
      creepConfigs?: Record<string, CreepConfig>;
      resourceControl?: {
        taskSchemaVersion?: number;
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
            origin: "manual" | "automatic";
            lastProgressAt: number;
            blockedReason?: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee";
            blockedSince?: number;
            reason?: string;
            lastError?: string;
          }
        >;
      };
      factoryTasks?: Record<
        string,
        {
          id: string;
          roomName: string;
          type: "decompress_battery";
          status: "pending" | "loading" | "producing" | "unloading" | "done" | "cancelled" | "failed";
          requestedBatteryAmount: number;
          remainingBatteryAmount: number;
          producedEnergyAmount: number;
          createdAt: number;
          updatedAt: number;
          completedAt?: number;
          lastError?: string;
        }
      >;
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
          squad?: "standard" | "t3Duo";
          boostTier?: "t3";
          boostLabs?: string[];
          boostStatus?: "preparing" | "ready" | "failed";
          oneShot?: boolean;
          failReason?: string;
          attempts: number;
          createdAt: number;
          updatedAt: number;
          statusSince?: number;
          lastHostileSeenAt?: number;
          clearSince?: number;
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
      remoteMining?: Record<string, RemoteMiningTask>;
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
    _lastHits?: number;
    _rmcWait?: { ticks: number };
    _rmcSelectedSource?: string;
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
    _lastSpawnFail?: {
      tick: number;
      spawnName: string;
      configName: string;
      role: string;
      code: number;
      bodyCost: number;
      bodyParts: number;
      roomEnergyAvailable: number;
      roomEnergyCapacityAvailable: number;
    };
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
    stopWar: (targetRoom: string, suicide?: boolean) => string;
    stopWarRaw: (targetRoom: string, options?: StopWarOptions) => StopWarResult | string;
    startWar: (targetRoom: string, sourceRoom: string, squad?: "standard" | "t3Duo", routeRooms?: string[] | string, oneShot?: boolean) => string;
    startWarRaw: (targetRoom: string, sourceRoom: string, options?: StartWarOptions) => StartWarResult | string;
    warStatus: (targetRoom?: string) => string;
    warStatusRaw: (targetRoom?: string) => WarStatusSnapshot;
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
      version: 2;
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
            emaTotalUsed: number;
            rooms: Record<
              string,
              {
                totalUsed: number;
                roles: Record<string, { count: number; used: number }>;
              }
            >;
            heap: CpuMonitorHeapSnapshot | null;
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
        emaTotalUsed: number;
        rooms: Record<
          string,
          {
            totalUsed: number;
            roles: Record<string, { count: number; used: number }>;
          }
        >;
        heap: CpuMonitorHeapSnapshot | null;
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
            emaTotalUsed: number;
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
          task: ResourceTransferTaskConsoleRecord;
        }
      | string;
    addResourceTransferTasks: (
      fromRoomName: string,
      requests: ManualResourceTransferRequest[],
      reason?: string,
    ) => string;
    addResourceTransferTasksRaw: (
      fromRoomName: string,
      requests: ManualResourceTransferRequest[],
      reason?: string,
    ) => AddResourceTransferTasksResult | string;
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
      tasks: ResourceTransferTaskConsoleRecord[];
    };
    addFactoryTask: (roomName: string, type: "decompress_battery", amount: number) => string;
    addFactoryTaskRaw: (roomName: string, type: "decompress_battery", amount: number) => AddFactoryTaskResult | string;
    decompressBattery: (roomName: string, amount: number) => string;
    decompressBatteryRaw: (roomName: string, amount: number) => AddFactoryTaskResult | string;
    cancelFactoryTask: (taskId: string) => string;
    cancelFactoryTaskRaw: (taskId: string) => CancelFactoryTaskResult | string;
    listFactoryTasks: (roomName?: string) => string;
    listFactoryTasksRaw: (roomName?: string) => FactoryTask[];
    remoteDefenseStatus: (targetRoom: string) => string;
    remoteDefenseStatusRaw: (targetRoom: string) => RemoteDefenseStatusSnapshot | string;
    __screepsMounted?: boolean;
  }
}

export {};
