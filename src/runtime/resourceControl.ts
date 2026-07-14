import {
  listCarrierTasksByRoom,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { limitActionLog } from "@/runtime/actionLog";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  cancelResourceTransferTask,
  clearResourceTransferTaskBlocker,
  createAutomaticResourceTransferTask,
  getResourceTransferTaskListSorted,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  markResourceTransferTaskBlocked,
  reconcileResourceTransferTasks,
  recordResourceTransferTaskProgress,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  DEFAULT_CAPACITY_HEADROOM_POLICY,
  getReceiverSafeCapacity,
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
  type CapacityHeadroomPolicy,
  type CapacityState,
} from "@/runtime/logistics/capacityHeadroom";
import {
  createReceiverCapacityLedger,
  type ReceiverCapacityLedger,
} from "@/runtime/logistics/receiverCapacityLedger";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import {
  resolveRoomEnergyPolicy,
  type RoomEnergyPolicy,
} from "@/runtime/roomEnergyPolicy";
import { getReservedProductionAmount } from "@/runtime/resourceReservation";
import { HUB_TARGET_COMPOUNDS } from "@/config/hub";

type ResourceControlState = "survival" | "balanced" | "export";
type ResourceCapacityState = CapacityState;
type ResourceThresholdMap = Partial<Record<ResourceConstant, number>>;

const BASE_MINERALS: ResourceConstant[] = [RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST];
const DEFAULT_MARKET_SELL_RESOURCES: ResourceConstant[] = [...BASE_MINERALS];

const HUB_INTERMEDIATES: ResourceConstant[] = [
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_GHODIUM,
  RESOURCE_UTRIUM_HYDRIDE,
  RESOURCE_UTRIUM_OXIDE,
  RESOURCE_KEANIUM_HYDRIDE,
  RESOURCE_KEANIUM_OXIDE,
  RESOURCE_LEMERGIUM_HYDRIDE,
  RESOURCE_LEMERGIUM_OXIDE,
  RESOURCE_ZYNTHIUM_HYDRIDE,
  RESOURCE_ZYNTHIUM_OXIDE,
  RESOURCE_GHODIUM_HYDRIDE,
  RESOURCE_GHODIUM_OXIDE,
  RESOURCE_UTRIUM_ACID,
  RESOURCE_UTRIUM_ALKALIDE,
  RESOURCE_KEANIUM_ACID,
  RESOURCE_KEANIUM_ALKALIDE,
  RESOURCE_LEMERGIUM_ACID,
  RESOURCE_LEMERGIUM_ALKALIDE,
  RESOURCE_ZYNTHIUM_ACID,
  RESOURCE_ZYNTHIUM_ALKALIDE,
  RESOURCE_GHODIUM_ACID,
  RESOURCE_GHODIUM_ALKALIDE,
];

interface ResourceControlRoomConfig extends RoomEnergyPolicy {
  transferBatchSize: number;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
}

interface ResourceControlMarketConfig {
  enabled: boolean;
  emergencyBuyEnabled: boolean;
  nativeMineralAutoSellThreshold: number;
  maxDealsPerRun: number;
  minDealAmount: number;
  maxDealAmount: number;
  maxDealEnergyCostRatio: number;
  minSellPrice: ResourceThresholdMap;
  maxBuyPrice: ResourceThresholdMap;
  sellResources: ResourceConstant[];
  buyResources: ResourceConstant[];
}

interface ResourceCapacityConfig extends CapacityHeadroomPolicy {
  maxPlannedAmountPerTask: number;
  maxNewTasksPerRun: number;
  automaticTaskNoProgressTtl: number;
  sourceDepletedGraceTicks: number;
  t3ReservePerRoom: number;
}

export interface ResourceControlCapacityIndexBuildCounter {
  count: number;
}

interface SynthesisProducerBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisProducerBinding>;

interface InternalSendBudget {
  remaining: number;
}

interface ResourceControlTaskHealth {
  pendingIncoming: number;
  pendingOutgoing: number;
  blockedIncoming: Partial<Record<NonNullable<ResourceTransferTask["blockedReason"]>, number>>;
  blockedOutgoing: Partial<Record<NonNullable<ResourceTransferTask["blockedReason"]>, number>>;
}

interface CapacityReliefRoute {
  tick: number;
  taskId: string;
  fromRoomName: string;
  toRoomName: string;
  resource: ResourceConstant;
  amount: number;
  transferCost: number;
}

interface ResourceControlTransferContext {
  tasks: ResourceTransferTask[];
  taskById: Map<string, ResourceTransferTask>;
  snapshotByRoom: Map<string, ResourceControlSnapshot>;
  receiverCapacityLedger: ReceiverCapacityLedger;
  healthyOutgoingByRoomResource: Map<string, number>;
  healthyIncomingByRoomResource: Map<string, number>;
  outgoingFeeByRoom: Map<string, number>;
  outgoingFeeByTaskId: Map<string, number>;
  healthyIncomingEnergyRooms: Set<string>;
  healthyIncomingEnergyRoomRefCount: Map<string, number>;
  carrierProductionByRoomResource: Map<string, number>;
  taskContributionById: Map<string, ResourceControlTransferTaskContribution>;
  taskContributionIndex: ResourceControlTaskContributionIndexProbe;
}

interface ResourceControlTransferTaskContribution {
  readonly outgoingKey?: string;
  readonly outgoingAmount?: number;
  readonly incomingKey?: string;
  readonly incomingAmount?: number;
  readonly outgoingFeeRoomName?: string;
  readonly outgoingFee?: number;
  readonly incomingEnergyRoomName?: string;
}

interface ResourceControlTaskContributionIndexProbe {
  initialTaskCount: number;
  syncCount: number;
  contributionEvaluationCount: number;
}

interface TerminalStagingBatch {
  resource: ResourceConstant;
  amount: number;
  transactionFee: number;
}

interface TerminalEnergyPlanOptions {
  stagingBatch?: TerminalStagingBatch;
  legacyBacklog?: boolean;
}

const MAX_RECENT_CAPACITY_RELIEF_ROUTES = 20;

export interface ResourceControlSnapshot {
  roomName: string;
  state: ResourceControlState;
  capacityState: ResourceCapacityState;
  storageUsedCapacity: number;
  storageFreeCapacity: number;
  terminalUsedCapacity: number;
  terminalFreeCapacity: number;
  storageEnergy: number;
  terminalEnergy: number;
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
  transferBatchSize: number;
  terminalResourceAmounts?: Partial<Record<ResourceConstant, number>>;
  nativeMineralType?: MineralConstant;
  canMineNative: boolean;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
  storage?: StructureStorage;
  terminal: StructureTerminal;
}

const DEFAULT_INTERVAL = 10;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 100;
const DEFAULT_TASK_MAX_PER_RUN = 5;
const MIN_TASK_MAX_PER_RUN = 1;
const MAX_TASK_MAX_PER_RUN = 5;
const RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER = "resourceControl:preload";
const RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY = 80;
const RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY = 90;
const TERMINAL_STORAGE_CAPACITY = 300_000;
const TERMINAL_TOTAL_STORAGE_CAP = 250_000;
const DEFAULT_CAPACITY_CONFIG: ResourceCapacityConfig = {
  ...DEFAULT_CAPACITY_HEADROOM_POLICY,
  maxPlannedAmountPerTask: 50_000,
  maxNewTasksPerRun: 5,
  automaticTaskNoProgressTtl: 5_000,
  sourceDepletedGraceTicks: 100,
  t3ReservePerRoom: 5_000,
};

const DEFAULT_ROOM_CONFIG: Omit<ResourceControlRoomConfig, keyof RoomEnergyPolicy> = {
  transferBatchSize: 10_000,
  mineralFloor: {
    [RESOURCE_HYDROGEN]: 5_000,
    [RESOURCE_OXYGEN]: 5_000,
    [RESOURCE_UTRIUM]: 5_000,
    [RESOURCE_LEMERGIUM]: 5_000,
    [RESOURCE_KEANIUM]: 5_000,
    [RESOURCE_ZYNTHIUM]: 5_000,
    [RESOURCE_CATALYST]: 3_000,
  },
  mineralExportStart: {
    [RESOURCE_HYDROGEN]: 15_000,
    [RESOURCE_OXYGEN]: 15_000,
    [RESOURCE_UTRIUM]: 15_000,
    [RESOURCE_LEMERGIUM]: 15_000,
    [RESOURCE_KEANIUM]: 15_000,
    [RESOURCE_ZYNTHIUM]: 15_000,
    [RESOURCE_CATALYST]: 10_000,
  },
};

const DEFAULT_MARKET_CONFIG: ResourceControlMarketConfig = {
  enabled: true,
  emergencyBuyEnabled: true,
  nativeMineralAutoSellThreshold: 10_000,
  maxDealsPerRun: 1,
  minDealAmount: 1_000,
  maxDealAmount: 10_000,
  maxDealEnergyCostRatio: 0.35,
  minSellPrice: {},
  maxBuyPrice: {
    [RESOURCE_ENERGY]: 0.12,
  },
  sellResources: DEFAULT_MARKET_SELL_RESOURCES,
  buyResources: BASE_MINERALS,
};

function normalizeInterval(value: unknown): number {
  return normalizeNumber(value, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL);
}

function normalizeTaskMaxPerRun(value: unknown): number {
  return normalizeNumber(value, DEFAULT_TASK_MAX_PER_RUN, MIN_TASK_MAX_PER_RUN, MAX_TASK_MAX_PER_RUN);
}

function normalizeResourceThresholdMap(
  value: unknown,
  fallback: ResourceThresholdMap,
  min: number,
  max: number,
): ResourceThresholdMap {
  const map = value && typeof value === "object" ? (value as Partial<Record<ResourceConstant, unknown>>) : {};
  const next: ResourceThresholdMap = {};

  for (const resource of Object.keys(fallback) as ResourceConstant[]) {
    next[resource] = normalizeNumber(map[resource], fallback[resource] || 0, min, max);
  }

  for (const resource of BASE_MINERALS) {
    if (next[resource] === undefined) {
      next[resource] = normalizeNumber(map[resource], fallback[resource] || 0, min, max);
    }
  }

  return next;
}

function normalizeResourceList(value: unknown, fallback: ResourceConstant[]): ResourceConstant[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value.filter((item): item is ResourceConstant => typeof item === "string" && item.length > 0);
  return normalized.length > 0 ? normalized : [...fallback];
}


function normalizeRoomConfig(value: unknown): ResourceControlRoomConfig {
  const config = value && typeof value === "object"
    ? (value as Partial<ResourceControlRoomConfig>)
    : {};
  const energyPolicy = resolveRoomEnergyPolicy(config);
  const transferBatchSize = normalizeNumber(
    config.transferBatchSize,
    DEFAULT_ROOM_CONFIG.transferBatchSize,
    100,
    50_000,
  );
  const mineralFloor = normalizeResourceThresholdMap(
    config.mineralFloor,
    DEFAULT_ROOM_CONFIG.mineralFloor,
    0,
    500_000,
  );
  const mineralExportStart = normalizeResourceThresholdMap(
    config.mineralExportStart,
    DEFAULT_ROOM_CONFIG.mineralExportStart,
    0,
    1_000_000,
  );

  for (const resource of BASE_MINERALS) {
    const floor = mineralFloor[resource] || 0;
    const exportStart = mineralExportStart[resource] || 0;
    if (exportStart < floor) {
      mineralExportStart[resource] = floor;
    }
  }

  return {
    ...energyPolicy,
    transferBatchSize,
    mineralFloor,
    mineralExportStart,
  };
}

function normalizeMarketConfig(value: unknown): ResourceControlMarketConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_MARKET_CONFIG.enabled),
    emergencyBuyEnabled: normalizeBoolean(raw.emergencyBuyEnabled, DEFAULT_MARKET_CONFIG.emergencyBuyEnabled),
    nativeMineralAutoSellThreshold: normalizeNumber(
      raw.nativeMineralAutoSellThreshold,
      DEFAULT_MARKET_CONFIG.nativeMineralAutoSellThreshold,
      0,
      1_000_000,
    ),
    maxDealsPerRun: normalizeNumber(raw.maxDealsPerRun, DEFAULT_MARKET_CONFIG.maxDealsPerRun, 1, 5),
    minDealAmount: normalizeNumber(raw.minDealAmount, DEFAULT_MARKET_CONFIG.minDealAmount, 100, 20_000),
    maxDealAmount: normalizeNumber(raw.maxDealAmount, DEFAULT_MARKET_CONFIG.maxDealAmount, 500, 50_000),
    maxDealEnergyCostRatio: Math.max(
      0,
      Math.min(5, typeof raw.maxDealEnergyCostRatio === "number" ? raw.maxDealEnergyCostRatio : DEFAULT_MARKET_CONFIG.maxDealEnergyCostRatio),
    ),
    minSellPrice: normalizeResourceThresholdMap(raw.minSellPrice, DEFAULT_MARKET_CONFIG.minSellPrice, 0, 1000),
    maxBuyPrice: normalizeResourceThresholdMap(raw.maxBuyPrice, DEFAULT_MARKET_CONFIG.maxBuyPrice, 0, 1000),
    sellResources: normalizeResourceList(raw.sellResources, DEFAULT_MARKET_CONFIG.sellResources),
    buyResources: normalizeResourceList(raw.buyResources, DEFAULT_MARKET_CONFIG.buyResources),
  };
}

export function normalizeCapacityConfig(value: unknown): ResourceCapacityConfig {
  const raw = value && typeof value === "object" ? (value as Partial<ResourceCapacityConfig>) : {};
  return {
    ...normalizeCapacityHeadroomPolicy(raw),
    maxPlannedAmountPerTask: normalizeNumber(
      raw.maxPlannedAmountPerTask,
      DEFAULT_CAPACITY_CONFIG.maxPlannedAmountPerTask,
      100,
      300_000,
    ),
    maxNewTasksPerRun: normalizeNumber(
      raw.maxNewTasksPerRun,
      DEFAULT_CAPACITY_CONFIG.maxNewTasksPerRun,
      1,
      5,
    ),
    automaticTaskNoProgressTtl: normalizeNumber(
      raw.automaticTaskNoProgressTtl,
      DEFAULT_CAPACITY_CONFIG.automaticTaskNoProgressTtl,
      100,
      100_000,
    ),
    sourceDepletedGraceTicks: normalizeNumber(
      raw.sourceDepletedGraceTicks,
      DEFAULT_CAPACITY_CONFIG.sourceDepletedGraceTicks,
      1,
      5_000,
    ),
    t3ReservePerRoom: normalizeNumber(
      raw.t3ReservePerRoom,
      DEFAULT_CAPACITY_CONFIG.t3ReservePerRoom,
      0,
      500_000,
    ),
  };
}

function resolveRoomConfig(roomName: string): ResourceControlRoomConfig {
  const cfg = Memory.cfg?.resourceControl;
  const roomConfigRaw = cfg?.rooms ? cfg.rooms[roomName] : undefined;
  return normalizeRoomConfig(roomConfigRaw);
}

function resolveMarketConfig(): ResourceControlMarketConfig {
  const cfg = Memory.cfg?.resourceControl;
  return normalizeMarketConfig(cfg?.market);
}

function resolveCapacityConfig(): ResourceCapacityConfig {
  return normalizeCapacityConfig(Memory.cfg?.resourceControl?.capacityBalancing);
}

function getSynthesisDemandTarget(roomName: string, resource: ResourceConstant): number {
  const value = Memory.cfg?.resourceControl?.synthesis?.rooms?.[roomName]?.demands?.[resource];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function getActiveSynthesisMissing(roomName: string, resource: ResourceConstant): number {
  const value = Memory.runtime?.synthesisControl?.rooms?.[roomName]?.missing?.[resource];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function resolveTaskMaxPerRun(): number {
  return normalizeTaskMaxPerRun(Memory.cfg?.resourceControl?.taskMaxPerRun);
}

export function getResourceControlSampleInterval(): number {
  return normalizeInterval(Memory.cfg?.resourceControl?.sampleInterval);
}

function resolveState(storageEnergy: number, config: ResourceControlRoomConfig): ResourceControlState {
  if (storageEnergy < config.energyFloor) {
    return "survival";
  }
  if (storageEnergy >= config.energyExportStart) {
    return "export";
  }
  return "balanced";
}

export function collectResourceControlSnapshots(): ResourceControlSnapshot[] {
  const rooms = getTickContextService().getMyRooms().filter((room) => !!room.terminal);
  const capacityConfig = resolveCapacityConfig();

  return rooms.map((room) => {
    const config = resolveRoomConfig(room.name);
    const storageEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const terminalEnergy = room.terminal?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const storageUsedCapacity = room.storage?.store.getUsedCapacity() || 0;
    const storageFreeCapacity = room.storage?.store.getFreeCapacity() || 0;
    const terminalUsedCapacity = room.terminal?.store.getUsedCapacity() || 0;
    const terminalFreeCapacity = room.terminal?.store.getFreeCapacity() || 0;
    const terminalResourceAmounts: Partial<Record<ResourceConstant, number>> = {};
    for (const resource of RESOURCES_ALL) {
      terminalResourceAmounts[resource] = room.terminal?.store.getUsedCapacity(resource) || 0;
    }
    const previousCapacityState = Memory.runtime?.resourceControl?.rooms?.[room.name]?.capacityState;
    const mineral = room.find(FIND_MINERALS)[0] || null;
    const extractor = room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_EXTRACTOR,
    })[0] as StructureExtractor | undefined;

    return {
      roomName: room.name,
      state: resolveState(storageEnergy, config),
      capacityState: room.storage
        ? resolveCapacityState(
            storageFreeCapacity,
            terminalFreeCapacity,
            capacityConfig,
            previousCapacityState,
          )
        : "normal",
      storageUsedCapacity,
      storageFreeCapacity,
      terminalUsedCapacity,
      terminalFreeCapacity,
      storageEnergy,
      terminalEnergy,
      energyFloor: config.energyFloor,
      energyTarget: config.energyTarget,
      energyExportStart: config.energyExportStart,
      terminalEnergyReserve: config.terminalEnergyReserve,
      transferBatchSize: config.transferBatchSize,
      terminalResourceAmounts,
      nativeMineralType: mineral?.mineralType,
      canMineNative: !!mineral && !!extractor,
      mineralFloor: config.mineralFloor,
      mineralExportStart: config.mineralExportStart,
      storage: room.storage || undefined,
      terminal: room.terminal as StructureTerminal,
    };
  });
}

function getTerminalResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const projected = snapshot.terminalResourceAmounts?.[resource];
  return typeof projected === "number"
    ? projected
    : snapshot.terminal.store.getUsedCapacity(resource);
}

function setTerminalResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
): void {
  snapshot.terminalResourceAmounts = snapshot.terminalResourceAmounts || {};
  snapshot.terminalResourceAmounts[resource] = Math.max(0, Math.floor(amount));
}

function getStock(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
  if (resource === RESOURCE_ENERGY) {
    return snapshot.storageEnergy + snapshot.terminalEnergy;
  }
  return (snapshot.storage?.store.getUsedCapacity(resource) || 0) +
    getTerminalResourceAmount(snapshot, resource);
}

function isEnergyExportEligible(snapshot: ResourceControlSnapshot): boolean {
  return snapshot.storageEnergy >= snapshot.energyExportStart;
}

function roomResourceKey(roomName: string, resource: ResourceConstant): string {
  return `${roomName}:${resource}`;
}

export function createResourceControlTransferContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  buildCounter: ResourceControlCapacityIndexBuildCounter,
): ResourceControlTransferContext {
  buildCounter.count += 1;
  const tasks = getResourceTransferTaskListSorted();
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const snapshotByRoom = new Map(snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const));
  const healthyOutgoingByRoomResource = new Map<string, number>();
  const healthyIncomingByRoomResource = new Map<string, number>();
  const outgoingFeeByRoom = new Map<string, number>();
  const outgoingFeeByTaskId = new Map<string, number>();
  const healthyIncomingEnergyRooms = new Set<string>();
  const healthyIncomingEnergyRoomRefCount = new Map<string, number>();
  const carrierProductionByRoomResource = new Map<string, number>();
  const taskContributionById = new Map<string, ResourceControlTransferTaskContribution>();
  const taskContributionIndex: ResourceControlTaskContributionIndexProbe = {
    initialTaskCount: tasks.length,
    syncCount: 0,
    contributionEvaluationCount: 0,
  };
  const receiverCapacityLedger = createReceiverCapacityLedger({
    receivers: snapshots
      .filter((snapshot) => !!snapshot.storage)
      .map((snapshot) => ({
        roomName: snapshot.roomName,
        storageFreeCapacity: snapshot.storageFreeCapacity,
        terminalFreeCapacity: snapshot.terminalFreeCapacity,
        getTerminalResourceFreeCapacity: (resource: ResourceConstant) =>
          getReceiverTerminalFreeCapacity(snapshot, resource),
      })),
    tasks,
    storageSafetyReserve: capacityConfig.storagePressureFreeCapacity,
    terminalSafetyReserve: capacityConfig.terminalPressureFreeCapacity,
    isTaskEndpointValid: (task) =>
      !!snapshotByRoom.get(task.fromRoomName)?.storage &&
      !!snapshotByRoom.get(task.toRoomName)?.storage,
    isTaskHealthy: (task) =>
      isHealthyReceiverCapacityCommitment(task, capacityConfig.automaticTaskNoProgressTtl),
  });

  for (const snapshot of snapshots) {
    for (const task of listCarrierTasksByRoom(snapshot.roomName)) {
      if (task.type !== "lab_supply" && task.type !== "factory_supply") continue;
      for (const step of task.steps) {
        if (step.fromKind !== "storage" && step.fromKind !== "terminal") continue;
        const key = roomResourceKey(snapshot.roomName, step.resource);
        carrierProductionByRoomResource.set(
          key,
          (carrierProductionByRoomResource.get(key) || 0) + step.amount,
        );
      }
    }
  }

  const context: ResourceControlTransferContext = {
    tasks,
    taskById,
    snapshotByRoom,
    receiverCapacityLedger,
    healthyOutgoingByRoomResource,
    healthyIncomingByRoomResource,
    outgoingFeeByRoom,
    outgoingFeeByTaskId,
    healthyIncomingEnergyRooms,
    healthyIncomingEnergyRoomRefCount,
    carrierProductionByRoomResource,
    taskContributionById,
    taskContributionIndex,
  };
  for (const task of tasks) {
    const contribution = deriveResourceControlTransferTaskContribution(context, task);
    context.taskContributionById.set(task.id, contribution);
    applyResourceControlTransferTaskContribution(context, task.id, contribution, 1);
  }
  return context;
}

function adjustIndexedAmount(index: Map<string, number>, key: string, delta: number): void {
  const amount = Math.max(0, (index.get(key) || 0) + delta);
  if (amount > 0) {
    index.set(key, amount);
  } else {
    index.delete(key);
  }
}

function deriveResourceControlTransferTaskContribution(
  context: ResourceControlTransferContext,
  task: ResourceTransferTask,
): ResourceControlTransferTaskContribution {
  context.taskContributionIndex.contributionEvaluationCount += 1;
  const contribution: {
    outgoingKey?: string;
    outgoingAmount?: number;
    incomingKey?: string;
    incomingAmount?: number;
    outgoingFeeRoomName?: string;
    outgoingFee?: number;
    incomingEnergyRoomName?: string;
  } = {};

  if (isHealthyResourceTransferTaskReservation(task, "outgoing")) {
    contribution.outgoingKey = roomResourceKey(task.fromRoomName, task.resource);
    contribution.outgoingAmount = task.remainingAmount;
    const source = context.snapshotByRoom.get(task.fromRoomName);
    const batchAmount = source
      ? Math.min(source.transferBatchSize, task.remainingAmount)
      : 0;
    if (batchAmount > 0) {
      contribution.outgoingFeeRoomName = task.fromRoomName;
      contribution.outgoingFee = Game.market.calcTransactionCost(
        batchAmount,
        task.fromRoomName,
        task.toRoomName,
      );
    }
  }
  if (isHealthyResourceTransferTaskReservation(task, "incoming")) {
    contribution.incomingKey = roomResourceKey(task.toRoomName, task.resource);
    contribution.incomingAmount = task.remainingAmount;
    if (task.resource === RESOURCE_ENERGY) {
      contribution.incomingEnergyRoomName = task.toRoomName;
    }
  }

  return Object.freeze(contribution);
}

function applyResourceControlTransferTaskContribution(
  context: ResourceControlTransferContext,
  taskId: string,
  contribution: ResourceControlTransferTaskContribution,
  direction: 1 | -1,
): void {
  if (contribution.outgoingKey && contribution.outgoingAmount) {
    adjustIndexedAmount(
      context.healthyOutgoingByRoomResource,
      contribution.outgoingKey,
      direction * contribution.outgoingAmount,
    );
  }
  if (contribution.incomingKey && contribution.incomingAmount) {
    adjustIndexedAmount(
      context.healthyIncomingByRoomResource,
      contribution.incomingKey,
      direction * contribution.incomingAmount,
    );
  }
  if (contribution.outgoingFeeRoomName && contribution.outgoingFee) {
    adjustIndexedAmount(
      context.outgoingFeeByRoom,
      contribution.outgoingFeeRoomName,
      direction * contribution.outgoingFee,
    );
    if (direction > 0) {
      context.outgoingFeeByTaskId.set(taskId, contribution.outgoingFee);
    } else {
      context.outgoingFeeByTaskId.delete(taskId);
    }
  } else if (direction < 0) {
    context.outgoingFeeByTaskId.delete(taskId);
  }
  if (contribution.incomingEnergyRoomName) {
    adjustIndexedAmount(
      context.healthyIncomingEnergyRoomRefCount,
      contribution.incomingEnergyRoomName,
      direction,
    );
    if ((context.healthyIncomingEnergyRoomRefCount.get(contribution.incomingEnergyRoomName) || 0) > 0) {
      context.healthyIncomingEnergyRooms.add(contribution.incomingEnergyRoomName);
    } else {
      context.healthyIncomingEnergyRooms.delete(contribution.incomingEnergyRoomName);
    }
  }
}

function syncResourceControlTransferTask(
  context: ResourceControlTransferContext,
  task: ResourceTransferTask,
): void {
  if (!context.taskById.has(task.id)) {
    context.tasks.push(task);
  }
  const previousContribution = context.taskContributionById.get(task.id);
  if (previousContribution) {
    applyResourceControlTransferTaskContribution(
      context,
      task.id,
      previousContribution,
      -1,
    );
  }
  context.taskById.set(task.id, task);
  context.receiverCapacityLedger.syncTask(task);
  const contribution = deriveResourceControlTransferTaskContribution(context, task);
  context.taskContributionById.set(task.id, contribution);
  applyResourceControlTransferTaskContribution(context, task.id, contribution, 1);
  context.taskContributionIndex.syncCount += 1;
}

function getOutgoingTransactionFeeReserve(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  return Math.max(
    0,
    (context.outgoingFeeByRoom.get(snapshot.roomName) || 0) -
      (excludeTaskId ? context.outgoingFeeByTaskId.get(excludeTaskId) || 0 : 0),
  );
}

function getProductionCommitmentAmount(
  roomName: string,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
): number {
  return (
    getReservedProductionAmount(roomName, resource) +
    (context.carrierProductionByRoomResource.get(roomResourceKey(roomName, resource)) || 0)
  );
}

function getEnergyBalancingSurplus(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (!isEnergyExportEligible(snapshot)) {
    return 0;
  }
  return Math.max(
    0,
    getStock(snapshot, RESOURCE_ENERGY) -
      snapshot.energyTarget -
      getProductionCommitmentAmount(snapshot.roomName, RESOURCE_ENERGY, context) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
        excludeTaskId,
      ) -
      getOutgoingTransactionFeeReserve(snapshot, context, excludeTaskId),
  );
}

export function getResourceControlRoomStock(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }

  const consumers = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_LAB ||
      structure.structureType === STRUCTURE_FACTORY ||
      structure.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of consumers) {
    total += structure.store.getUsedCapacity(resource);
  }

  return total;
}

function getEnergyAvailableForFees(snapshot: ResourceControlSnapshot): number {
  return Math.max(0, snapshot.terminalEnergy - snapshot.terminalEnergyReserve);
}

function computeLargestAffordableAmount(
  maximum: number,
  canAfford: (amount: number) => boolean,
): number {
  let low = 1;
  let high = Math.max(0, Math.floor(maximum));
  let result = 0;

  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (canAfford(candidate)) {
      result = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }

  return result;
}

function computeSendAmount(
  donor: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  targetAmount: number,
): number {
  const availableResource = resource === RESOURCE_ENERGY
    ? donor.terminalEnergy
    : getTerminalResourceAmount(donor, resource);
  const maximum = Math.floor(
    Math.min(targetAmount, donor.transferBatchSize, availableResource),
  );
  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      donor.roomName,
      receiverRoomName,
    );
    const requiredEnergy = resource === RESOURCE_ENERGY ? amount + fee : fee;
    return requiredEnergy <= donor.terminalEnergy;
  });
}

function computeTransferAmount(
  from: ResourceControlSnapshot,
  to: ResourceControlSnapshot,
  receiverNeed: number,
  receiverCapacity: number,
  context: ResourceControlTransferContext,
): number {
  if (receiverNeed <= 0 || receiverCapacity <= 0) {
    return 0;
  }
  const donorBudget = getEnergyBalancingSurplus(from, context);
  const terminalBudget = Math.max(
    0,
    from.terminalEnergy - getOutgoingTransactionFeeReserve(from, context),
  );
  const maximum = Math.floor(
    Math.min(
      from.transferBatchSize,
      receiverNeed,
      receiverCapacity,
      donorBudget,
      from.terminalEnergy,
    ),
  );
  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(amount, from.roomName, to.roomName);
    return amount + fee <= donorBudget && amount + fee <= terminalBudget;
  });
}

function applyPostSendDelta(
  donor: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
): number {
  const transferCost = Game.market.calcTransactionCost(amount, donor.roomName, receiver.roomName);
  const donorEnergyDelta = (resource === RESOURCE_ENERGY ? amount : 0) + transferCost;
  donor.terminalEnergy = Math.max(0, donor.terminalEnergy - donorEnergyDelta);
  setTerminalResourceAmount(donor, RESOURCE_ENERGY, donor.terminalEnergy);
  if (resource !== RESOURCE_ENERGY) {
    setTerminalResourceAmount(
      donor,
      resource,
      getTerminalResourceAmount(donor, resource) - amount,
    );
  }
  donor.terminalUsedCapacity = Math.max(0, donor.terminalUsedCapacity - amount - transferCost);
  donor.terminalFreeCapacity = Math.max(0, donor.terminalFreeCapacity + amount + transferCost);

  if (resource === RESOURCE_ENERGY) {
    receiver.terminalEnergy += amount;
    setTerminalResourceAmount(receiver, RESOURCE_ENERGY, receiver.terminalEnergy);
  } else {
    setTerminalResourceAmount(
      receiver,
      resource,
      getTerminalResourceAmount(receiver, resource) + amount,
    );
  }
  receiver.terminalUsedCapacity += amount;
  receiver.terminalFreeCapacity = Math.max(0, receiver.terminalFreeCapacity - amount);

  return transferCost;
}

function applyInternalBalancing(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  sendBudget: InternalSendBudget,
  context: ResourceControlTransferContext,
  remainingEnergyNeedByRoom: Map<string, number>,
): string[] {
  const actions: string[] = [];
  const donors = snapshots
    .filter(
      (snapshot) =>
        snapshot.terminal.cooldown === 0 &&
        getEnergyBalancingSurplus(snapshot, context) > 0,
    )
    .sort(
      (left, right) =>
        getEnergyBalancingSurplus(right, context) -
        getEnergyBalancingSurplus(left, context),
    );
  const receivers = snapshots
    .filter((snapshot) => (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0)
    .filter((snapshot) => !context.healthyIncomingEnergyRooms.has(snapshot.roomName))
    .sort((left, right) => {
      const needDiff =
        (remainingEnergyNeedByRoom.get(right.roomName) || 0) -
        (remainingEnergyNeedByRoom.get(left.roomName) || 0);
      return needDiff || left.roomName.localeCompare(right.roomName);
    });

  for (const donor of donors) {
    if (sendBudget.remaining <= 0) break;
    if (terminalBusy.has(donor.roomName)) continue;

    for (const receiver of receivers) {
      if (donor.roomName === receiver.roomName) continue;
      const receiverCapacity = context.receiverCapacityLedger.getAvailableAmount(
        receiver.roomName,
        RESOURCE_ENERGY,
      );
      const receiverNeed = remainingEnergyNeedByRoom.get(receiver.roomName) || 0;
      const amount = computeTransferAmount(
        donor,
        receiver,
        receiverNeed,
        receiverCapacity,
        context,
      );
      if (amount <= 0) continue;

      const code = donor.terminal.send(
        RESOURCE_ENERGY,
        amount,
        receiver.roomName,
        "resourceControl:auto-balance",
      );
      if (code !== OK) {
        actions.push(`send-failed:${donor.roomName}->${receiver.roomName}:code=${code}`);
        continue;
      }
      recordFixedCpuAction("resourceControl");
      const transferCost = applyPostSendDelta(
        donor,
        receiver,
        RESOURCE_ENERGY,
        amount,
      );
      context.receiverCapacityLedger.applySend(
        receiver.roomName,
        RESOURCE_ENERGY,
        amount,
      );
      remainingEnergyNeedByRoom.set(receiver.roomName, Math.max(0, receiverNeed - amount));
      actions.push(
        `send:${donor.roomName}->${receiver.roomName}:energy=${amount}:cost=${transferCost}`,
      );
      terminalBusy.add(donor.roomName);
      sendBudget.remaining -= 1;
      break;
    }
  }

  return actions;
}

function isStorageConstrained(
  snapshot: ResourceControlSnapshot | undefined,
  capacityConfig: ResourceCapacityConfig,
): boolean {
  return (snapshot?.storage?.store.getFreeCapacity() ?? 0) <=
    capacityConfig.storagePressureFreeCapacity;
}

function getReceiverStorageFreeCapacity(receiver: ResourceControlSnapshot): number {
  const free = receiver.storage?.store.getFreeCapacity();
  return typeof free === "number" ? Math.max(0, free) : 0;
}

function getTransferTaskPriority(
  task: ResourceTransferTask,
  energyDeficitRooms: Set<string>,
  storageConstrainedRooms: Set<string>,
  capacityStateByRoom: Map<string, ResourceCapacityState>,
): number {
  if (task.resource === RESOURCE_ENERGY && energyDeficitRooms.has(task.toRoomName)) return 0;
  const reason = task.reason;
  if (task.origin === "manual" && (!reason || reason.startsWith("manual:"))) return 1;
  if (!reason) return 3;
  if (reason.startsWith("capacity:relief:")) {
    return capacityStateByRoom.get(task.fromRoomName) === "emergency" ? 1 : 3;
  }
  if (
    reason.startsWith("synthesis:") ||
    reason.startsWith("auto:synthesis:") ||
    reason.startsWith("powerBankBoost")
  ) return 2;
  if (reason.startsWith("hub:export:") && storageConstrainedRooms.has(task.fromRoomName)) return 4;
  if (reason.startsWith("hub:import:")) return 5;
  if (reason.startsWith("hub:reclaim:")) return 6;
  if (reason.startsWith("hub:export:")) return 7;
  return 3;
}

interface TransferTaskPriorityContext {
  energyDeficitRooms: Set<string>;
  storageConstrainedRooms: Set<string>;
  capacityStateByRoom: Map<string, ResourceCapacityState>;
}

function createTransferTaskPriorityContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  remainingEnergyNeedByRoom: Map<string, number>,
): TransferTaskPriorityContext {
  return {
    energyDeficitRooms: new Set(
      snapshots
        .filter((snapshot) => (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0)
        .map((snapshot) => snapshot.roomName),
    ),
    storageConstrainedRooms: new Set(
      snapshots
        .filter((snapshot) => isStorageConstrained(snapshot, capacityConfig))
        .map((snapshot) => snapshot.roomName),
    ),
    capacityStateByRoom: new Map(
      snapshots.map((snapshot) => [snapshot.roomName, snapshot.capacityState] as const),
    ),
  };
}

function sortTransferTasksByPriority(
  tasks: ResourceTransferTask[],
  priorityContext: TransferTaskPriorityContext,
): ResourceTransferTask[] {
  return [...tasks].sort((a, b) => {
    const pa = getTransferTaskPriority(
      a,
      priorityContext.energyDeficitRooms,
      priorityContext.storageConstrainedRooms,
      priorityContext.capacityStateByRoom,
    );
    const pb = getTransferTaskPriority(
      b,
      priorityContext.energyDeficitRooms,
      priorityContext.storageConstrainedRooms,
      priorityContext.capacityStateByRoom,
    );
    if (pa !== pb) return pa - pb;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function getReceiverTerminalFreeCapacity(receiver: ResourceControlSnapshot, resource: ResourceConstant): number {
  const totalFree = receiver.terminal.store.getFreeCapacity();
  const resourceFree = receiver.terminal.store.getFreeCapacity(resource);
  if (typeof totalFree === "number" && typeof resourceFree === "number") {
    return Math.max(0, Math.min(totalFree, resourceFree));
  }
  if (typeof totalFree === "number") return Math.max(0, totalFree);
  return typeof resourceFree === "number" ? Math.max(0, resourceFree) : 0;
}

function getReceiverReceivableCapacity(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  capacityConfig: ResourceCapacityConfig,
): number {
  return getReceiverSafeCapacity(
    getReceiverStorageFreeCapacity(receiver),
    getReceiverTerminalFreeCapacity(receiver, resource),
    capacityConfig,
  );
}

function getHealthyOutgoingCommitment(
  roomName: string,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  let total = context.healthyOutgoingByRoomResource.get(roomResourceKey(roomName, resource)) || 0;
  if (excludeTaskId) {
    const excluded = context.taskById.get(excludeTaskId);
    if (
      excluded?.fromRoomName === roomName &&
      excluded.resource === resource &&
      isHealthyResourceTransferTaskReservation(excluded, "outgoing")
    ) {
      total -= excluded.remainingAmount;
    }
  }
  return Math.max(0, total);
}

function getProtectedResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  let safetyFloor = snapshot.mineralFloor[resource] || 0;
  if (resource === RESOURCE_ENERGY) {
    safetyFloor =
      snapshot.energyTarget +
      getOutgoingTransactionFeeReserve(snapshot, context, excludeTaskId);
  } else if (HUB_TARGET_COMPOUNDS.includes(resource)) {
    safetyFloor = Math.max(safetyFloor, config.t3ReservePerRoom);
  }
  return safetyFloor +
    getProductionCommitmentAmount(snapshot.roomName, resource, context);
}

function getMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  location: "storage" | "terminal",
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY && !isEnergyExportEligible(snapshot)) return 0;
  const totalStock = getStock(snapshot, resource);
  const movableTotal = Math.max(
    0,
    totalStock -
      getProtectedResourceAmount(snapshot, resource, config, context, excludeTaskId) -
      getHealthyOutgoingCommitment(snapshot.roomName, resource, context, excludeTaskId),
  );
  const structureStock = location === "terminal"
    ? getTerminalResourceAmount(snapshot, resource)
    : snapshot.storage?.store.getUsedCapacity(resource) || 0;
  return Math.min(structureStock, movableTotal);
}

function getTotalMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY && !isEnergyExportEligible(snapshot)) return 0;
  return Math.max(
    0,
    getStock(snapshot, resource) -
      getProtectedResourceAmount(snapshot, resource, config, context, excludeTaskId) -
      getHealthyOutgoingCommitment(snapshot.roomName, resource, context, excludeTaskId),
  );
}

function getCapacityReliefRecoveryGap(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): number {
  if (source.terminalFreeCapacity < config.terminalReliefTargetFreeCapacity) {
    return config.terminalReliefTargetFreeCapacity - source.terminalFreeCapacity;
  }
  return Math.max(0, config.storageReliefTargetFreeCapacity - source.storageFreeCapacity);
}

function computeSafeCapacityReliefAmount(
  source: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  requestedAmount: number,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  const resourceMovable = getTotalMovableResourceAmount(
    source,
    resource,
    config,
    context,
    excludeTaskId,
  );
  const candidate = Math.floor(Math.min(requestedAmount, resourceMovable));
  if (resource !== RESOURCE_ENERGY) {
    return candidate;
  }

  const energyBudget = getTotalMovableResourceAmount(
    source,
    RESOURCE_ENERGY,
    config,
    context,
    excludeTaskId,
  );
  return computeLargestAffordableAmount(candidate, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    return amount + fee <= energyBudget;
  });
}

function getStoredResources(store: StoreDefinition): ResourceConstant[] {
  return RESOURCES_ALL.filter((resource) => store.getUsedCapacity(resource) > 0);
}

function selectTerminalReliefResource(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  includeEnergy = true,
): { resource: ResourceConstant; movableAmount: number } | null {
  if (source.terminalFreeCapacity >= config.terminalReliefTargetFreeCapacity) {
    return null;
  }

  const candidates = getStoredResources(source.terminal.store)
    .map((resource) => ({
      resource,
      movableAmount: getMovableResourceAmount(source, resource, "terminal", config, context),
    }))
    .filter((candidate) => includeEnergy || candidate.resource !== RESOURCE_ENERGY)
    .filter((candidate) => candidate.movableAmount > 0)
    .sort((left, right) => {
      if (left.resource === RESOURCE_ENERGY && right.resource !== RESOURCE_ENERGY) return 1;
      if (right.resource === RESOURCE_ENERGY && left.resource !== RESOURCE_ENERGY) return -1;
      if (left.movableAmount !== right.movableAmount) return right.movableAmount - left.movableAmount;
      return left.resource.localeCompare(right.resource);
    });
  return candidates[0] || null;
}

function selectStorageReliefResource(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  includeEnergy = true,
): { resource: ResourceConstant; movableAmount: number } | null {
  if (!source.storage || source.storageFreeCapacity >= config.storageReliefTargetFreeCapacity) {
    return null;
  }

  const candidates = getStoredResources(source.storage.store)
    .map((resource) => ({
      resource,
      movableAmount: getMovableResourceAmount(source, resource, "storage", config, context),
    }))
    .filter((candidate) => includeEnergy || candidate.resource !== RESOURCE_ENERGY)
    .filter((candidate) => candidate.movableAmount > 0)
    .sort((left, right) => {
      if (left.movableAmount !== right.movableAmount) return right.movableAmount - left.movableAmount;
      return left.resource.localeCompare(right.resource);
    });
  return candidates[0] || null;
}

function getCapacityReliefReceivableAmount(
  receiver: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): number {
  return Math.max(
    0,
    getReceiverSafeCapacity(
      receiver.storageFreeCapacity,
      receiver.terminalFreeCapacity,
      config,
    ) - 1,
  );
}

function getCapacityReliefLedgerAvailableAmount(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  return Math.max(
    0,
    context.receiverCapacityLedger.getAvailableAmount(
      receiver.roomName,
      resource,
      excludeTaskId,
    ) - 1,
  );
}

function isCapacityReliefReceiverEligible(
  receiver: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): boolean {
  return !!receiver.storage && isReceiverAdmissionEligible(
    receiver.storageFreeCapacity,
    receiver.terminalFreeCapacity,
    receiver.capacityState,
    config,
  );
}

function planCapacityReliefTasks(
  snapshots: ResourceControlSnapshot[],
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  remainingEnergyNeedByRoom: Map<string, number>,
): string[] {
  if (!config.enabled) {
    return [];
  }

  const actions: string[] = [];
  let created = 0;
  const planningEnergyNeedByRoom = new Map(
    snapshots.map((snapshot) => [
      snapshot.roomName,
      Math.max(
        0,
        (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) -
          (context.healthyIncomingByRoomResource.get(
            roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
          ) || 0),
      ),
    ]),
  );
  const existingCapacityTaskBySource = new Map<string, ResourceTransferTask>();
  const activeOutgoingSourceRooms = new Set<string>();
  for (const task of context.tasks) {
    if (
      !existingCapacityTaskBySource.has(task.fromRoomName) &&
      task.reason?.startsWith("capacity:relief:") &&
      isHealthyResourceTransferTaskReservation(task, "outgoing")
    ) {
      existingCapacityTaskBySource.set(task.fromRoomName, task);
    }
    if (
      task.status === "pending" &&
      task.blockedReason === undefined &&
      !task.reason?.startsWith("capacity:relief:")
    ) {
      activeOutgoingSourceRooms.add(task.fromRoomName);
    }
  }

  const sources = snapshots
    .filter((snapshot) => snapshot.storage && snapshot.capacityState !== "normal")
    .sort((left, right) => {
      if (left.capacityState !== right.capacityState) {
        return left.capacityState === "emergency" ? -1 : 1;
      }
      return left.roomName.localeCompare(right.roomName);
    });

  for (const source of sources) {
    if (created >= config.maxNewTasksPerRun) break;
    const existing = existingCapacityTaskBySource.get(source.roomName);
    const terminalRecoveryReplacement = !!(
      existing?.origin === "automatic" &&
      source.terminalFreeCapacity < config.terminalReliefTargetFreeCapacity &&
      getMovableResourceAmount(
        source,
        existing.resource,
        "terminal",
        config,
        context,
        existing.id,
      ) <= 0
    );
    const isRetarget =
      existing?.origin === "automatic" && existing.blockedReason === "receiver_capacity";
    if (existing && !isRetarget && !terminalRecoveryReplacement) continue;
    if (!existing && activeOutgoingSourceRooms.has(source.roomName)) continue;

    const hasPlanningEnergyDemand = snapshots
      .filter((receiver) => receiver.roomName !== source.roomName)
      .filter(
        (receiver) =>
          !existing ||
          terminalRecoveryReplacement ||
          receiver.roomName !== existing.toRoomName,
      )
      .filter((receiver) => isCapacityReliefReceiverEligible(receiver, config))
      .some((receiver) => {
        const excludesExisting = terminalRecoveryReplacement &&
          existing?.toRoomName === receiver.roomName;
        const safeCapacity = Math.min(
          getCapacityReliefReceivableAmount(receiver, config),
          getCapacityReliefLedgerAvailableAmount(
            receiver,
            existing?.resource || RESOURCE_ENERGY,
            context,
            excludesExisting ? existing?.id : undefined,
          ),
        );
        const oldReservation = excludesExisting &&
          isHealthyResourceTransferTaskReservation(existing, "incoming")
          ? existing.remainingAmount
          : 0;
        const restoredEnergyNeed = existing?.resource === RESOURCE_ENERGY
          ? oldReservation
          : 0;
        return safeCapacity > 0 &&
          (planningEnergyNeedByRoom.get(receiver.roomName) || 0) + restoredEnergyNeed > 0;
      });
    const staleEnergyReliefReplacement = !!(
      isRetarget &&
      existing?.resource === RESOURCE_ENERGY &&
      !hasPlanningEnergyDemand
    );
    const selectsReplacementResource =
      terminalRecoveryReplacement || staleEnergyReliefReplacement;
    const terminalCandidate = existing && !selectsReplacementResource
      ? null
      : selectTerminalReliefResource(
          source,
          config,
          context,
          hasPlanningEnergyDemand,
        );
    if (existing && terminalRecoveryReplacement && !terminalCandidate) {
      const cancelled = cancelResourceTransferTask(existing.id);
      if (typeof cancelled === "string") {
        actions.push(`capacity-terminal-priority-failed:${source.roomName}:${existing.resource}:${cancelled}`);
      } else {
        existing.lastError = "capacity_terminal_priority_replaced";
        syncResourceControlTransferTask(context, existing);
        actions.push(`capacity-terminal-priority-cancelled:${source.roomName}:${existing.resource}`);
      }
      continue;
    }
    const location: "terminal" | "storage" = terminalCandidate ? "terminal" : "storage";
    const candidate = existing && !selectsReplacementResource
      ? {
          resource: existing.resource,
          movableAmount: getTotalMovableResourceAmount(
            source,
            existing.resource,
            config,
            context,
            existing.id,
          ),
        }
      : terminalCandidate || (
        source.terminalFreeCapacity >= config.terminalReliefTargetFreeCapacity
          ? selectStorageReliefResource(
              source,
              config,
              context,
              hasPlanningEnergyDemand,
            )
          : null
      );
    if (!candidate) continue;

    const receivers = snapshots
      .filter((receiver) => receiver.roomName !== source.roomName)
      .filter(
        (receiver) =>
          !existing ||
          selectsReplacementResource ||
          receiver.roomName !== existing.toRoomName,
      )
      .filter((receiver) => isCapacityReliefReceiverEligible(receiver, config))
      .map((receiver) => {
        const excludesExisting = selectsReplacementResource &&
          existing?.toRoomName === receiver.roomName;
        const safeCapacity = Math.min(
          getCapacityReliefReceivableAmount(receiver, config),
          getCapacityReliefLedgerAvailableAmount(
            receiver,
            candidate.resource,
            context,
            excludesExisting ? existing?.id : undefined,
          ),
        );
        const oldReservation = excludesExisting &&
          isHealthyResourceTransferTaskReservation(existing, "incoming")
          ? existing.remainingAmount
          : 0;
        const planningEnergyNeed = Math.max(
          0,
          (planningEnergyNeedByRoom.get(receiver.roomName) || 0) +
            (existing?.resource === RESOURCE_ENERGY ? oldReservation : 0),
        );
        const estimatedAmount = Math.max(
          1,
          Math.floor(
            Math.min(
              source.transferBatchSize,
              candidate.movableAmount,
              safeCapacity,
              config.maxPlannedAmountPerTask,
              candidate.resource === RESOURCE_ENERGY
                ? planningEnergyNeed
                : Number.POSITIVE_INFINITY,
            ),
          ),
        );
        return {
          receiver,
          safeCapacity,
          planningEnergyNeed,
          transferCost: Game.market.calcTransactionCost(
            estimatedAmount,
            source.roomName,
            receiver.roomName,
          ),
        };
      })
      .filter(
        (entry) =>
          entry.safeCapacity > 0 &&
          (candidate.resource !== RESOURCE_ENERGY || entry.planningEnergyNeed > 0),
      )
      .sort((left, right) => {
        if (left.safeCapacity !== right.safeCapacity) return right.safeCapacity - left.safeCapacity;
        const leftStock = getStock(left.receiver, candidate.resource);
        const rightStock = getStock(right.receiver, candidate.resource);
        if (leftStock !== rightStock) return leftStock - rightStock;
        if (left.transferCost !== right.transferCost) return left.transferCost - right.transferCost;
        return left.receiver.roomName.localeCompare(right.receiver.roomName);
      });
    const target = receivers[0];
    if (!target) continue;

    const recoveryGap = existing && !terminalRecoveryReplacement
      ? Math.min(existing.remainingAmount, getCapacityReliefRecoveryGap(source, config))
      : location === "terminal"
        ? Math.max(0, config.terminalReliefTargetFreeCapacity - source.terminalFreeCapacity)
        : Math.max(0, config.storageReliefTargetFreeCapacity - source.storageFreeCapacity);
    const requestedAmount = Math.floor(
      Math.min(
        recoveryGap,
        candidate.movableAmount,
        target.safeCapacity,
        config.maxPlannedAmountPerTask,
        candidate.resource === RESOURCE_ENERGY
          ? target.planningEnergyNeed
          : Number.POSITIVE_INFINITY,
      ),
    );
    const amount = computeSafeCapacityReliefAmount(
      source,
      target.receiver.roomName,
      candidate.resource,
      requestedAmount,
      config,
      context,
      existing?.id,
    );
    if (amount <= 0) continue;

    const result = createAutomaticResourceTransferTask(
      source.roomName,
      target.receiver.roomName,
      candidate.resource,
      amount,
      `capacity:relief:${candidate.resource}`,
    );
    if (typeof result === "string") {
      actions.push(`capacity-plan-failed:${source.roomName}:${candidate.resource}:${result}`);
      continue;
    }
    syncResourceControlTransferTask(context, result.task);
    if (existing) {
      const cancelled = cancelResourceTransferTask(existing.id);
      if (typeof cancelled === "string") {
        result.task.status = "cancelled";
        result.task.updatedAt = Game.time;
        result.task.lastError = "capacity_retarget_rollback";
        syncResourceControlTransferTask(context, result.task);
        actions.push(`capacity-retarget-failed:${source.roomName}:${candidate.resource}:${cancelled}`);
        continue;
      }
      syncResourceControlTransferTask(context, existing);
      if (terminalRecoveryReplacement) {
        existing.lastError = "capacity_terminal_priority_replaced";
        actions.push(
          `capacity-terminal-priority:${source.roomName}:${existing.resource}->${candidate.resource}:${candidate.resource}=${amount}`,
        );
      } else {
        existing.lastError = "capacity_receiver_retargeted";
        actions.push(
          `capacity-retarget:${source.roomName}:${existing.toRoomName}->${target.receiver.roomName}:${candidate.resource}=${amount}`,
        );
      }
    }
    if (candidate.resource === RESOURCE_ENERGY) {
      planningEnergyNeedByRoom.set(
        target.receiver.roomName,
        Math.max(0, target.planningEnergyNeed - amount),
      );
    }
    created += 1;
    actions.push(
      `capacity-plan:${source.roomName}->${target.receiver.roomName}:${candidate.resource}=${amount}`,
    );
  }

  return actions;
}

function getHubPendingImportResources(tasks: ResourceTransferTask[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!isHealthyResourceTransferTaskReservation(task, "incoming")) continue;
    const reason = task.reason;
    if (reason && (reason.startsWith("hub:import:") || reason.startsWith("hub:reclaim:"))) {
      const resource = reason.split(":").pop()!;
      let set = result.get(task.toRoomName);
      if (!set) {
        set = new Set<string>();
        result.set(task.toRoomName, set);
      }
      set.add(resource);
    }
  }
  return result;
}

function executeTransferTasks(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  capacityConfig: ResourceCapacityConfig,
  sendBudget: InternalSendBudget,
  capacityReliefRoutes: CapacityReliefRoute[],
  remainingEnergyNeedByRoom: Map<string, number>,
  context: ResourceControlTransferContext,
): string[] {
  const actions: string[] = [];
  const byRoomName = snapshots.reduce(
    (result, snapshot) => {
      result[snapshot.roomName] = snapshot;
      return result;
    },
    {} as Record<string, ResourceControlSnapshot>,
  );
  const energyDeficitRooms = new Set(
    snapshots
      .filter((snapshot) => (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0)
      .map((snapshot) => snapshot.roomName),
  );
  const storageConstrainedRooms = new Set(
    snapshots
      .filter((snapshot) => isStorageConstrained(snapshot, capacityConfig))
      .map((snapshot) => snapshot.roomName),
  );
  const capacityStateByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot.capacityState] as const),
  );
  const hubPendingImportResources = getHubPendingImportResources(context.tasks);
  const tasks = sortTransferTasksByPriority(context.tasks, {
    energyDeficitRooms,
    storageConstrainedRooms,
    capacityStateByRoom,
  });

  for (const task of tasks) {
    if (task.status !== "pending") {
      continue;
    }

    if (task.remainingAmount <= 0) {
      task.status = "done";
      task.updatedAt = Game.time;
      task.blockedReason = undefined;
      task.blockedSince = undefined;
      task.lastError = undefined;
      syncResourceControlTransferTask(context, task);
      actions.push(`task-auto-done:${task.id}:non_positive_remaining`);
      continue;
    }

    const donor = byRoomName[task.fromRoomName];
    const receiver = byRoomName[task.toRoomName];
    if (!donor || !receiver) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "room_not_ready";
      syncResourceControlTransferTask(context, task);
      actions.push(`task-failed:${task.id}:room_not_ready`);
      continue;
    }
    if (donor.roomName === receiver.roomName) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "same_room";
      syncResourceControlTransferTask(context, task);
      actions.push(`task-failed:${task.id}:same_room`);
      continue;
    }
    const taskReason = task.reason || "";
    const isCapacityRelief = taskReason.startsWith("capacity:relief:");
    const recoveryGap = isCapacityRelief
      ? getCapacityReliefRecoveryGap(donor, capacityConfig)
      : Number.POSITIVE_INFINITY;
    if (isCapacityRelief && (donor.capacityState === "normal" || recoveryGap <= 0)) {
      task.status = "cancelled";
      task.updatedAt = Game.time;
      task.blockedReason = undefined;
      task.blockedSince = undefined;
      task.lastError = "capacity_source_recovered";
      syncResourceControlTransferTask(context, task);
      actions.push(`capacity-task-cancelled:${task.id}:source_recovered`);
      continue;
    }
    if (getStock(donor, task.resource) <= 0) {
      markResourceTransferTaskBlocked(task, "source_depleted");
      syncResourceControlTransferTask(context, task);
      continue;
    }
    if (task.blockedReason === "source_depleted") {
      clearResourceTransferTaskBlocker(task);
      syncResourceControlTransferTask(context, task);
    }

    const taskAvailableCapacity = context.receiverCapacityLedger.getAvailableAmount(
      receiver.roomName,
      task.resource,
      task.id,
    );
    const receiverCapacity = isCapacityRelief
      ? Math.min(
          Math.max(0, taskAvailableCapacity - 1),
          getCapacityReliefReceivableAmount(receiver, capacityConfig),
        )
      : taskAvailableCapacity;
    if (
      receiverCapacity <= 0 ||
      (isCapacityRelief && receiver.capacityState !== "normal")
    ) {
      markResourceTransferTaskBlocked(task, "receiver_capacity");
      syncResourceControlTransferTask(context, task);
      continue;
    }
    if (task.blockedReason === "receiver_capacity") {
      clearResourceTransferTaskBlocker(task);
      syncResourceControlTransferTask(context, task);
    }

    if (taskReason.startsWith("hub:export:")) {
      const exportResource = taskReason.split(":").pop()!;
      const pendingResources = hubPendingImportResources.get(task.fromRoomName);
      if (pendingResources && pendingResources.has(exportResource) && !storageConstrainedRooms.has(task.fromRoomName)) {
        continue;
      }
    }

    let requestedAmount = Math.min(task.remainingAmount, donor.transferBatchSize, receiverCapacity);
    if (task.resource === RESOURCE_ENERGY) {
      const receiverNeed = remainingEnergyNeedByRoom.get(receiver.roomName) || 0;
      if (receiverNeed <= 0) {
        markResourceTransferTaskBlocked(task, "receiver_capacity");
        syncResourceControlTransferTask(context, task);
        continue;
      }
      const exportBudget = getEnergyBalancingSurplus(donor, context, task.id);
      const maximum = Math.min(requestedAmount, receiverNeed, exportBudget);
      requestedAmount = computeLargestAffordableAmount(maximum, (amount) => {
        const fee = Game.market.calcTransactionCost(
          amount,
          donor.roomName,
          receiver.roomName,
        );
        return amount + fee <= exportBudget;
      });
      if (requestedAmount <= 0) {
        markResourceTransferTaskBlocked(task, "insufficient_terminal_resource_or_fee");
        syncResourceControlTransferTask(context, task);
        continue;
      }
    }
    if (isCapacityRelief) {
      requestedAmount = computeSafeCapacityReliefAmount(
        donor,
        receiver.roomName,
        task.resource,
        Math.min(requestedAmount, recoveryGap),
        capacityConfig,
        context,
        task.id,
      );
      if (requestedAmount <= 0) {
        markResourceTransferTaskBlocked(task, "insufficient_terminal_resource_or_fee");
        syncResourceControlTransferTask(context, task);
        continue;
      }
    }
    const amount = computeSendAmount(
      donor,
      receiver.roomName,
      task.resource,
      requestedAmount,
    );
    if (amount <= 0) {
      markResourceTransferTaskBlocked(task, "insufficient_terminal_resource_or_fee");
      syncResourceControlTransferTask(context, task);
      continue;
    }

    if (
      sendBudget.remaining <= 0 ||
      terminalBusy.has(donor.roomName) ||
      donor.terminal.cooldown > 0
    ) {
      if (task.blockedReason === "insufficient_terminal_resource_or_fee") {
        clearResourceTransferTaskBlocker(task);
        syncResourceControlTransferTask(context, task);
      }
      continue;
    }

    const allocatedAmount = context.receiverCapacityLedger.reserve(
      task.id,
      receiver.roomName,
      task.resource,
      amount,
      { ownerTaskId: task.id },
    );
    if (allocatedAmount <= 0) {
      markResourceTransferTaskBlocked(task, "receiver_capacity");
      syncResourceControlTransferTask(context, task);
      continue;
    }

    const code = donor.terminal.send(
      task.resource,
      allocatedAmount,
      receiver.roomName,
      `resourceControl:task:${task.id}`,
    );
    if (code !== OK) {
      task.updatedAt = Game.time;
      task.lastError = `send_code_${code}`;
      if (code === ERR_INVALID_ARGS || code === ERR_INVALID_TARGET) {
        task.status = "failed";
        syncResourceControlTransferTask(context, task);
        actions.push(`task-failed:${task.id}:send_code_${code}`);
        continue;
      }
      actions.push(`task-send-failed:${task.id}:code=${code}`);
      continue;
    }
    recordFixedCpuAction("resourceControl");

    const transferCost = applyPostSendDelta(
      donor,
      receiver,
      task.resource,
      allocatedAmount,
    );
    context.receiverCapacityLedger.applySend(
      receiver.roomName,
      task.resource,
      allocatedAmount,
      task.id,
    );
    if (task.resource === RESOURCE_ENERGY) {
      remainingEnergyNeedByRoom.set(
        receiver.roomName,
        Math.max(
          0,
          (remainingEnergyNeedByRoom.get(receiver.roomName) || 0) - allocatedAmount,
        ),
      );
    }
    task.remainingAmount = Math.max(0, task.remainingAmount - allocatedAmount);
    recordResourceTransferTaskProgress(task);
    if (task.remainingAmount <= 0) {
      task.status = "done";
    }
    syncResourceControlTransferTask(context, task);

    terminalBusy.add(donor.roomName);
    sendBudget.remaining -= 1;
    actions.push(`task-send:${task.id}:${task.resource}=${allocatedAmount}:cost=${transferCost}`);
    if (task.reason?.startsWith("capacity:relief:")) {
      capacityReliefRoutes.push({
        tick: Game.time,
        taskId: task.id,
        fromRoomName: task.fromRoomName,
        toRoomName: task.toRoomName,
        resource: task.resource,
        amount: allocatedAmount,
        transferCost,
      });
      actions.push(
        `capacity-relief-send:${task.fromRoomName}->${task.toRoomName}:${task.resource}=${allocatedAmount}:cost=${transferCost}`,
      );
    }
  }

  return actions;
}

function createTerminalFeedTask(room: ResourceControlSnapshot, resource: ResourceConstant, targetStock: number): CarrierTaskDraft | null {
  if (!room.storage || targetStock <= 0) {
    return null;
  }

  const terminalAmount = getTerminalResourceAmount(room, resource);
  const storageAmount = room.storage.store.getUsedCapacity(resource);
  const terminalFree = Math.min(
    room.terminalFreeCapacity,
    room.terminal.store.getFreeCapacity(resource),
  );
  const missing = Math.min(storageAmount, terminalFree, Math.max(0, targetStock - terminalAmount));
  if (missing <= 0) {
    return null;
  }

  return {
    id: `resourceControl:terminal_feed:${room.roomName}:${resource}`,
    type: "terminal_feed",
    priority: RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY,
    steps: [
      {
        id: `${resource}:${room.storage.id}->${room.terminal.id}`,
        resource,
        fromKind: "storage",
        toKind: "terminal",
        fromId: room.storage.id,
        toId: room.terminal.id,
        amount: missing,
      },
    ],
  };
}

function createTerminalOffloadTask(
  room: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
  availableAmount = getTerminalResourceAmount(room, resource),
): CarrierTaskDraft | null {
  if (!room.storage || amount <= 0) {
    return null;
  }

  const storageFree = room.storage.store.getFreeCapacity(resource);
  const movable = Math.min(availableAmount, storageFree, amount);
  if (movable <= 0) {
    return null;
  }

  return {
    id: `resourceControl:terminal_offload:${room.roomName}:${resource}`,
    type: "terminal_offload",
    priority: RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY,
    steps: [
      {
        id: `${resource}:${room.terminal.id}->${room.storage.id}`,
        resource,
        fromKind: "terminal",
        toKind: "storage",
        fromId: room.terminal.id,
        toId: room.storage.id,
        amount: movable,
      },
    ],
  };
}

function getPlannedEnergySendBatch(
  room: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  if (!isEnergyExportEligible(room)) return 0;
  if (options.legacyBacklog) {
    const outgoingEnergy = context.healthyOutgoingByRoomResource.get(
      roomResourceKey(room.roomName, RESOURCE_ENERGY),
    ) || 0;
    return outgoingEnergy > 0
      ? Math.min(room.transferBatchSize, outgoingEnergy)
      : room.transferBatchSize;
  }
  if (options.stagingBatch) {
    return options.stagingBatch.resource === RESOURCE_ENERGY
      ? options.stagingBatch.amount
      : 0;
  }
  return room.transferBatchSize;
}

function getEnergySendFeeBudget(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  amount: number,
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  if (!options.legacyBacklog && options.stagingBatch) {
    return options.stagingBatch.transactionFee;
  }
  if (options.legacyBacklog) {
    const pendingFeeBudget = context.outgoingFeeByRoom.get(room.roomName) || 0;
    if (amount <= 0) return pendingFeeBudget;
    const outgoingEnergy = context.healthyOutgoingByRoomResource.get(
      roomResourceKey(room.roomName, RESOURCE_ENERGY),
    ) || 0;
    if (outgoingEnergy > 0 || !isEnergyExportEligible(room)) {
      return pendingFeeBudget;
    }
    const receiver = snapshots
      .filter(
        (snapshot) =>
          snapshot.roomName !== room.roomName &&
          snapshot.storageEnergy < snapshot.energyTarget,
      )
      .sort((left, right) => {
        const leftNeed = left.energyTarget - left.storageEnergy;
        const rightNeed = right.energyTarget - right.storageEnergy;
        return rightNeed - leftNeed || left.roomName.localeCompare(right.roomName);
      })[0];
    return receiver
      ? pendingFeeBudget + Game.market.calcTransactionCost(
          amount,
          room.roomName,
          receiver.roomName,
        )
      : pendingFeeBudget;
  }
  if (amount <= 0 || !isEnergyExportEligible(room)) {
    return 0;
  }
  const receiver = snapshots
    .filter(
      (snapshot) =>
        snapshot.roomName !== room.roomName &&
        snapshot.storageEnergy < snapshot.energyTarget,
    )
    .sort((left, right) => {
      const leftNeed = left.energyTarget - left.storageEnergy;
      const rightNeed = right.energyTarget - right.storageEnergy;
      return rightNeed - leftNeed || left.roomName.localeCompare(right.roomName);
    })[0];
  return receiver
    ? Game.market.calcTransactionCost(
        amount,
        room.roomName,
        receiver.roomName,
      )
    : 0;
}

function getNativeMineralAutoSellSurplus(
  room: ResourceControlSnapshot,
  nativeMineralAutoSellThreshold: number,
): number {
  if (!room.canMineNative || !room.nativeMineralType) {
    return 0;
  }

  return Math.max(0, getStock(room, room.nativeMineralType) - nativeMineralAutoSellThreshold);
}

function getNativeMineralAutoSellTerminalTarget(
  room: ResourceControlSnapshot,
  marketCfg: ResourceControlMarketConfig,
): number {
  if (!marketCfg.enabled) {
    return 0;
  }

  const surplus = getNativeMineralAutoSellSurplus(room, marketCfg.nativeMineralAutoSellThreshold);
  if (surplus < marketCfg.minDealAmount) {
    return 0;
  }

  const target = Math.min(surplus, marketCfg.maxDealAmount);
  return target >= marketCfg.minDealAmount ? target : 0;
}

function getSellResourcesForRoom(room: ResourceControlSnapshot, marketCfg: ResourceControlMarketConfig): ResourceConstant[] {
  const sellResources = marketCfg.sellResources.filter((resource) => resource !== RESOURCE_ENERGY);
  const hubSellResources = room.roomName === Memory.cfg?.hub?.hubRoomName ? getHubMarketSellResources() : [];
  const combined = [...new Set([...hubSellResources, ...sellResources])];
  if (!room.canMineNative || !room.nativeMineralType) {
    return combined;
  }

  return [room.nativeMineralType, ...combined.filter((resource) => resource !== room.nativeMineralType)];
}

function getReservedTerminalEnergyForPendingSends(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  const stagedEnergy = getPlannedEnergySendBatch(room, context, options);
  const feeBudget = getEnergySendFeeBudget(
    room,
    snapshots,
    stagedEnergy,
    context,
    options,
  );
  return stagedEnergy + feeBudget;
}

function getProtectedTerminalEnergy(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  const protectedEnergy = Math.max(
    25_000,
    snapshot.terminalEnergyReserve +
      getReservedTerminalEnergyForPendingSends(
        snapshot,
        snapshots,
        context,
        options,
      ),
  );
  return options.legacyBacklog
    ? protectedEnergy
    : protectedEnergy +
        getProductionCommitmentAmount(snapshot.roomName, RESOURCE_ENERGY, context);
}

function createEnergyTerminalTask(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): CarrierTaskDraft | null {
  if (!room.storage) {
    return null;
  }

  const terminalEnergy = room.terminalEnergy;
  const reservedTerminalEnergy = getReservedTerminalEnergyForPendingSends(
    room,
    snapshots,
    context,
    options,
  );
  const protectedTerminalEnergy = getProtectedTerminalEnergy(
    room,
    snapshots,
    context,
    options,
  );
  const trueOffloadableTerminalEnergy = Math.max(0, terminalEnergy - protectedTerminalEnergy);

  const storageDeficit = room.energyTarget - room.storageEnergy;
  if (storageDeficit > room.transferBatchSize && trueOffloadableTerminalEnergy >= room.transferBatchSize) {
    return createTerminalOffloadTask(
      room,
      RESOURCE_ENERGY,
      Math.min(room.transferBatchSize, storageDeficit),
      trueOffloadableTerminalEnergy,
    );
  }

  const stagedEnergy = getPlannedEnergySendBatch(room, context, options);
  const feeBudget = reservedTerminalEnergy - stagedEnergy;
  const desiredTerminalEnergy = room.terminalEnergyReserve + stagedEnergy + feeBudget;
  return createTerminalFeedTask(room, RESOURCE_ENERGY, desiredTerminalEnergy);
}

interface TerminalOverflowPlan {
  desiredUsedCapacity: number;
  storageOffloadCapacity: number;
  recoveryOffloadBudget?: number;
  energyOptions?: TerminalEnergyPlanOptions;
  getProtectedNonEnergy(resource: ResourceConstant, stored: number): number;
}

function appendTerminalOverflowDrafts(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  drafts: CarrierTaskDraft[],
  offloadedResources: Set<ResourceConstant>,
  plan: TerminalOverflowPlan,
): void {
  if (!snapshot.storage || snapshot.terminalUsedCapacity <= plan.desiredUsedCapacity) {
    return;
  }

  let overflowTotal = snapshot.terminalUsedCapacity;
  let storageOffloadCapacity = plan.storageOffloadCapacity;
  let recoveryOffloadBudget = plan.recoveryOffloadBudget ?? Number.POSITIVE_INFINITY;
  const allResources = RESOURCES_ALL.filter(
    (resource) =>
      getTerminalResourceAmount(snapshot, resource) > 0 &&
      !offloadedResources.has(resource),
  );
  allResources.sort((a, b) => {
    if (a === RESOURCE_ENERGY && b !== RESOURCE_ENERGY) return 1;
    if (a !== RESOURCE_ENERGY && b === RESOURCE_ENERGY) return -1;
    return 0;
  });

  for (const resource of allResources) {
    const stored = getTerminalResourceAmount(snapshot, resource);
    if (stored <= 0) continue;
    const protectedAmount = resource === RESOURCE_ENERGY
      ? getProtectedTerminalEnergy(
          snapshot,
          snapshots,
          context,
          plan.energyOptions,
        )
      : plan.getProtectedNonEnergy(resource, stored);
    const amount = Math.min(
      stored - protectedAmount,
      overflowTotal - plan.desiredUsedCapacity,
      snapshot.transferBatchSize,
      storageOffloadCapacity,
      recoveryOffloadBudget,
    );
    if (amount <= 0) continue;
    const draft = createTerminalOffloadTask(snapshot, resource, amount);
    if (!draft) continue;

    drafts.push(draft);
    offloadedResources.add(resource);
    overflowTotal -= amount;
    storageOffloadCapacity -= amount;
    recoveryOffloadBudget -= amount;
  }
}

function appendTerminalResourceFeedDrafts(
  snapshot: ResourceControlSnapshot,
  marketCfg: ResourceControlMarketConfig,
  drafts: CarrierTaskDraft[],
  offloadedResources: Set<ResourceConstant>,
  desiredFeedByResource: Map<ResourceConstant, number>,
  initialFeedCapacity: number,
): void {
  if (
    snapshot.nativeMineralType &&
    !offloadedResources.has(snapshot.nativeMineralType)
  ) {
    const target = getNativeMineralAutoSellTerminalTarget(snapshot, marketCfg);
    if (target > 0) {
      desiredFeedByResource.set(
        snapshot.nativeMineralType,
        Math.max(
          desiredFeedByResource.get(snapshot.nativeMineralType) || 0,
          target,
        ),
      );
    }
  }

  let feedCapacity = initialFeedCapacity;
  for (const [resource, target] of desiredFeedByResource.entries()) {
    if (feedCapacity <= 0) break;
    const draft = createTerminalFeedTask(
      snapshot,
      resource,
      Math.min(target, feedCapacity),
    );
    if (!draft) continue;
    const feedAmount = draft.steps.reduce(
      (sum, step) => sum + step.amount,
      0,
    );
    feedCapacity -= feedAmount;
    drafts.push(draft);
  }
}

function commitTerminalLogisticsDrafts(
  snapshot: ResourceControlSnapshot,
  drafts: CarrierTaskDraft[],
  actions: string[],
): void {
  replaceCarrierTasksForProducerRoom(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    snapshot.roomName,
    drafts,
  );
  if (drafts.length > 0) {
    actions.push(`terminal-logistics:${snapshot.roomName}:count=${drafts.length}`);
  }
}

function syncLegacyTerminalFeedTasks(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
): string[] {
  const pendingByRoom = new Map<string, Map<ResourceConstant, number>>();
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  for (const task of context.tasks) {
    if (task.status !== "pending" || task.resource === RESOURCE_ENERGY) {
      continue;
    }

    let pendingAmount = task.remainingAmount;
    if (task.reason?.startsWith("capacity:relief:")) {
      const source = snapshotByRoom.get(task.fromRoomName);
      const receiver = snapshotByRoom.get(task.toRoomName);
      if (
        !source ||
        !receiver ||
        source.capacityState === "normal" ||
        receiver.capacityState !== "normal" ||
        task.blockedReason === "receiver_capacity"
      ) {
        continue;
      }
      pendingAmount = computeSafeCapacityReliefAmount(
        source,
        task.toRoomName,
        task.resource,
        Math.min(
          task.remainingAmount,
          getCapacityReliefRecoveryGap(source, capacityConfig),
        ),
        capacityConfig,
        context,
        task.id,
      );
      if (
        source.terminalFreeCapacity <
        capacityConfig.terminalReliefTargetFreeCapacity
      ) {
        pendingAmount = Math.min(
          pendingAmount,
          getMovableResourceAmount(
            source,
            task.resource,
            "terminal",
            capacityConfig,
            context,
            task.id,
          ),
        );
      }
      if (pendingAmount <= 0) continue;
    }

    const roomPending =
      pendingByRoom.get(task.fromRoomName) ||
      new Map<ResourceConstant, number>();
    roomPending.set(
      task.resource,
      (roomPending.get(task.resource) || 0) + pendingAmount,
    );
    pendingByRoom.set(task.fromRoomName, roomPending);
  }

  const validRoomNames = new Set(
    snapshots.map((snapshot) => snapshot.roomName),
  );
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    const drafts: CarrierTaskDraft[] = [];
    const energyDraft = createEnergyTerminalTask(
      snapshot,
      snapshots,
      context,
      { legacyBacklog: true },
    );
    if (energyDraft) {
      drafts.push(energyDraft);
    }

    const offloadedResources = new Set<ResourceConstant>();
    const roomPending = pendingByRoom.get(snapshot.roomName);
    appendTerminalOverflowDrafts(
      snapshot,
      snapshots,
      context,
      drafts,
      offloadedResources,
      {
        desiredUsedCapacity: TERMINAL_TOTAL_STORAGE_CAP,
        storageOffloadCapacity: snapshot.storage?.store.getFreeCapacity() || 0,
        energyOptions: { legacyBacklog: true },
        getProtectedNonEnergy: (resource, stored) =>
          Math.min(stored, roomPending?.get(resource) ?? 0),
      },
    );

    const offloadTotal = drafts.reduce(
      (sum, draft) =>
        draft.type === "terminal_offload"
          ? sum + draft.steps.reduce((stepSum, step) => stepSum + step.amount, 0)
          : sum,
      0,
    );
    const feedCapacity = Math.max(
      0,
      TERMINAL_TOTAL_STORAGE_CAP -
        (snapshot.terminalUsedCapacity - offloadTotal),
    );

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    if (roomPending) {
      for (const [resource, amount] of roomPending.entries()) {
        if (offloadedResources.has(resource)) continue;
        desiredFeedByResource.set(
          resource,
          Math.min(snapshot.transferBatchSize, amount),
        );
      }
    }
    appendTerminalResourceFeedDrafts(
      snapshot,
      marketCfg,
      drafts,
      offloadedResources,
      desiredFeedByResource,
      feedCapacity,
    );
    commitTerminalLogisticsDrafts(snapshot, drafts, actions);
  }

  pruneCarrierTasksForProducer(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    validRoomNames,
  );
  return actions;
}

function limitCarrierTaskDraftAmount(
  draft: CarrierTaskDraft,
  maximumAmount: number,
): CarrierTaskDraft | null {
  let remaining = Math.max(0, Math.floor(maximumAmount));
  const steps = draft.steps
    .map((step) => {
      const amount = Math.min(step.amount, remaining);
      remaining -= amount;
      return { ...step, amount };
    })
    .filter((step) => step.amount > 0);
  return steps.length > 0 ? { ...draft, steps } : null;
}

function getTerminalLogisticsCapacityPlan(
  snapshot: ResourceControlSnapshot,
  capacityConfig: ResourceCapacityConfig,
): {
  recoveringTerminal: boolean;
  desiredTerminalUsedCapacity: number;
  feedCapacity: number;
} {
  const recoveringTerminal =
    capacityConfig.terminalHeadroomRecoveryEnabled &&
    snapshot.capacityState !== "normal";
  const desiredTerminalUsedCapacity = recoveringTerminal
    ? Math.max(
        0,
        TERMINAL_STORAGE_CAPACITY - capacityConfig.terminalReliefTargetFreeCapacity,
      )
    : TERMINAL_TOTAL_STORAGE_CAP;
  return {
    recoveringTerminal,
    desiredTerminalUsedCapacity,
    feedCapacity: Math.min(
      snapshot.terminalFreeCapacity,
      Math.max(0, desiredTerminalUsedCapacity - snapshot.terminalUsedCapacity),
    ),
  };
}

function reserveEnergyDeficitStagingBatch(
  source: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  planningEnergyNeedByRoom: Map<string, number>,
  context: ResourceControlTransferContext,
  capacityConfig: ResourceCapacityConfig,
): TerminalStagingBatch | undefined {
  if (
    !source.storage ||
    !isEnergyExportEligible(source) ||
    (context.healthyOutgoingByRoomResource.get(
      roomResourceKey(source.roomName, RESOURCE_ENERGY),
    ) || 0) > 0
  ) {
    return undefined;
  }

  const sourceEnergyBudget = getEnergyBalancingSurplus(source, context);
  if (sourceEnergyBudget <= 0) return undefined;
  const { feedCapacity } = getTerminalLogisticsCapacityPlan(
    source,
    capacityConfig,
  );
  if (feedCapacity <= 0) return undefined;

  const canStageBatch = (amount: number, receiverRoomName: string): boolean => {
    const transactionFee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    if (amount + transactionFee > sourceEnergyBudget) return false;
    const energyDraft = createEnergyTerminalTask(
      source,
      snapshots,
      context,
      {
        stagingBatch: {
          resource: RESOURCE_ENERGY,
          amount,
          transactionFee,
        },
      },
    );
    if (!energyDraft) return true;
    return energyDraft.type === "terminal_feed" &&
      energyDraft.steps.reduce((sum, step) => sum + step.amount, 0) <= feedCapacity;
  };

  const receivers = snapshots
    .filter((receiver) => receiver.roomName !== source.roomName && !!receiver.storage)
    .filter(
      (receiver) =>
        (planningEnergyNeedByRoom.get(receiver.roomName) || 0) > 0,
    )
    .sort((left, right) => {
      const leftNeed = planningEnergyNeedByRoom.get(left.roomName) || 0;
      const rightNeed = planningEnergyNeedByRoom.get(right.roomName) || 0;
      return rightNeed - leftNeed || left.roomName.localeCompare(right.roomName);
    });

  for (const receiver of receivers) {
    const receiverNeed = planningEnergyNeedByRoom.get(receiver.roomName) || 0;
    const receiverCapacity = context.receiverCapacityLedger.getAvailableAmount(
      receiver.roomName,
      RESOURCE_ENERGY,
    );
    const maximum = Math.floor(
      Math.min(
        source.transferBatchSize,
        receiverNeed,
        receiverCapacity,
        sourceEnergyBudget,
      ),
    );
    const amount = computeLargestAffordableAmount(
      maximum,
      (candidate) => canStageBatch(candidate, receiver.roomName),
    );
    if (amount <= 0) continue;

    const reservationId = `resourceControl:terminal-energy-staging:${source.roomName}`;
    const grantedAmount = context.receiverCapacityLedger.reserve(
      reservationId,
      receiver.roomName,
      RESOURCE_ENERGY,
      amount,
    );
    const reservedAmount = computeLargestAffordableAmount(
      Math.min(grantedAmount, receiverNeed),
      (candidate) => canStageBatch(candidate, receiver.roomName),
    );
    context.receiverCapacityLedger.reserve(
      reservationId,
      receiver.roomName,
      RESOURCE_ENERGY,
      reservedAmount,
    );
    if (reservedAmount <= 0) continue;

    const batch = {
      resource: RESOURCE_ENERGY,
      amount: reservedAmount,
      transactionFee: Game.market.calcTransactionCost(
        reservedAmount,
        source.roomName,
        receiver.roomName,
      ),
    };
    const energyDraft = createEnergyTerminalTask(
      source,
      snapshots,
      context,
      { stagingBatch: batch },
    );
    if (
      energyDraft?.type !== "terminal_feed" ||
      energyDraft.steps.reduce((sum, step) => sum + step.amount, 0) > feedCapacity
    ) {
      context.receiverCapacityLedger.reserve(
        reservationId,
        receiver.roomName,
        RESOURCE_ENERGY,
        0,
      );
      continue;
    }

    planningEnergyNeedByRoom.set(
      receiver.roomName,
      Math.max(0, receiverNeed - reservedAmount),
    );
    return batch;
  }

  return undefined;
}

function syncTerminalFeedTasks(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  remainingEnergyNeedByRoom: Map<string, number>,
): string[] {
  if (!capacityConfig.terminalHeadroomRecoveryEnabled) {
    return syncLegacyTerminalFeedTasks(
      snapshots,
      marketCfg,
      capacityConfig,
      context,
    );
  }

  const stagingBatchByRoom = new Map<string, TerminalStagingBatch>();
  const planningEnergyNeedByRoom = new Map(remainingEnergyNeedByRoom);
  const snapshotByRoom = new Map(snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const));
  for (const snapshot of snapshots) {
    const energyBatch = reserveEnergyDeficitStagingBatch(
      snapshot,
      snapshots,
      planningEnergyNeedByRoom,
      context,
      capacityConfig,
    );
    if (energyBatch) {
      stagingBatchByRoom.set(snapshot.roomName, energyBatch);
    }
  }
  const priorityContext = createTransferTaskPriorityContext(
    snapshots,
    capacityConfig,
    remainingEnergyNeedByRoom,
  );
  for (const task of sortTransferTasksByPriority(context.tasks, priorityContext)) {
    if (
      task.status !== "pending" ||
      stagingBatchByRoom.has(task.fromRoomName) ||
      task.blockedReason === "receiver_capacity" ||
      task.blockedReason === "source_depleted"
    ) {
      continue;
    }

    const source = snapshotByRoom.get(task.fromRoomName);
    const receiver = snapshotByRoom.get(task.toRoomName);
    if (!source?.storage || !receiver?.storage) continue;

    let pendingAmount = Math.min(task.remainingAmount, source.transferBatchSize);
    if (task.reason?.startsWith("capacity:relief:")) {
      if (
        source.capacityState === "normal" ||
        receiver.capacityState !== "normal"
      ) {
        continue;
      }
      pendingAmount = computeSafeCapacityReliefAmount(
        source,
        task.toRoomName,
        task.resource,
        Math.min(
          task.remainingAmount,
          source.transferBatchSize,
          getCapacityReliefRecoveryGap(source, capacityConfig),
          getCapacityReliefReceivableAmount(receiver, capacityConfig),
          getCapacityReliefLedgerAvailableAmount(
            receiver,
            task.resource,
            context,
            task.id,
          ),
        ),
        capacityConfig,
        context,
        task.id,
      );
      if (source.terminalFreeCapacity < capacityConfig.terminalReliefTargetFreeCapacity) {
        pendingAmount = Math.min(
          pendingAmount,
          getMovableResourceAmount(
            source,
            task.resource,
            "terminal",
            capacityConfig,
            context,
            task.id,
          ),
        );
      }
      if (pendingAmount <= 0) continue;
    } else {
      pendingAmount = Math.min(
        pendingAmount,
        context.receiverCapacityLedger.getAvailableAmount(
          receiver.roomName,
          task.resource,
          task.id,
        ),
      );
    }

    pendingAmount = Math.min(pendingAmount, getStock(source, task.resource));
    if (task.resource === RESOURCE_ENERGY && !isEnergyExportEligible(source)) continue;
    if (pendingAmount <= 0) continue;

    const transactionFee = Game.market.calcTransactionCost(
      pendingAmount,
      source.roomName,
      receiver.roomName,
    );
    const requiredEnergy = transactionFee +
      (task.resource === RESOURCE_ENERGY ? pendingAmount : 0);
    if (getStock(source, RESOURCE_ENERGY) < requiredEnergy) continue;

    stagingBatchByRoom.set(task.fromRoomName, {
      resource: task.resource,
      amount: pendingAmount,
      transactionFee,
    });
  }

  const validRoomNames = new Set(snapshots.map((snapshot) => snapshot.roomName));
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    const drafts: CarrierTaskDraft[] = [];
    const stagingBatch = stagingBatchByRoom.get(snapshot.roomName);
    const energyDraft = createEnergyTerminalTask(
      snapshot,
      snapshots,
      context,
      { stagingBatch },
    );
    const {
      recoveringTerminal,
      desiredTerminalUsedCapacity,
      feedCapacity: safeFeedCapacity,
    } = getTerminalLogisticsCapacityPlan(snapshot, capacityConfig);

    // Terminal overflow: offload surplus above cap to storage
    // Compute offload drafts first so we can suppress conflicting feed drafts
    const offloadedResources = new Set<ResourceConstant>();
    let storageOffloadCapacity = snapshot.storage
      ? Math.max(
          0,
          snapshot.storage.store.getFreeCapacity() -
            capacityConfig.storageReliefTargetFreeCapacity,
        )
      : 0;
    if (!recoveringTerminal && energyDraft?.type === "terminal_offload") {
      const limitedEnergyOffload = limitCarrierTaskDraftAmount(
        energyDraft,
        storageOffloadCapacity,
      );
      if (limitedEnergyOffload) {
        const amount = limitedEnergyOffload.steps.reduce((sum, step) => sum + step.amount, 0);
        drafts.push(limitedEnergyOffload);
        offloadedResources.add(RESOURCE_ENERGY);
        storageOffloadCapacity -= amount;
      }
    }

    appendTerminalOverflowDrafts(
      snapshot,
      snapshots,
      context,
      drafts,
      offloadedResources,
      {
        desiredUsedCapacity: desiredTerminalUsedCapacity,
        storageOffloadCapacity,
        recoveryOffloadBudget: recoveringTerminal
          ? Math.min(
              snapshot.terminalUsedCapacity - desiredTerminalUsedCapacity,
              snapshot.transferBatchSize,
              storageOffloadCapacity,
            )
          : Number.POSITIVE_INFINITY,
        energyOptions: { stagingBatch },
        getProtectedNonEnergy: (resource, stored) =>
          Math.min(
            stored,
            (stagingBatch?.resource === resource ? stagingBatch.amount : 0) +
              getProductionCommitmentAmount(
                snapshot.roomName,
                resource,
                context,
              ),
          ),
      },
    );

    let feedCapacity = safeFeedCapacity;
    if (
      energyDraft?.type === "terminal_feed" &&
      !offloadedResources.has(RESOURCE_ENERGY)
    ) {
      const limitedEnergyFeed = limitCarrierTaskDraftAmount(energyDraft, feedCapacity);
      if (limitedEnergyFeed) {
        const amount = limitedEnergyFeed.steps.reduce((sum, step) => sum + step.amount, 0);
        drafts.push(limitedEnergyFeed);
        feedCapacity -= amount;
      }
    }

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    if (
      stagingBatch &&
      stagingBatch.resource !== RESOURCE_ENERGY &&
      !offloadedResources.has(stagingBatch.resource)
    ) {
      desiredFeedByResource.set(
        stagingBatch.resource,
        Math.min(snapshot.transferBatchSize, stagingBatch.amount),
      );
    }

    appendTerminalResourceFeedDrafts(
      snapshot,
      marketCfg,
      drafts,
      offloadedResources,
      desiredFeedByResource,
      feedCapacity,
    );
    commitTerminalLogisticsDrafts(snapshot, drafts, actions);
  }

  pruneCarrierTasksForProducer(RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER, validRoomNames);
  return actions;
}

export function getResourceControlDonorAvailable(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
  const total = getStock(snapshot, resource);
  if (resource === RESOURCE_ENERGY) {
    return isEnergyExportEligible(snapshot)
      ? Math.max(0, total - snapshot.energyTarget)
      : 0;
  }
  const floor = snapshot.mineralFloor[resource] || 0;
  return Math.max(0, total - floor);
}

function shouldSkipMarketBuyForResource(snapshot: ResourceControlSnapshot, resource: ResourceConstant): boolean {
  if (resource === RESOURCE_ENERGY) {
    return false;
  }

  return snapshot.canMineNative && snapshot.nativeMineralType === resource;
}

function getMarketBuyDemandDeficit(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
): number {
  if (resource === RESOURCE_ENERGY) {
    return 0;
  }

  const activeMissing = getActiveSynthesisMissing(snapshot.roomName, resource);
  if (activeMissing > 0) {
    return activeMissing;
  }

  const demandTarget = getSynthesisDemandTarget(snapshot.roomName, resource);
  if (demandTarget <= 0) {
    return 0;
  }

  const room = Game.rooms[snapshot.roomName];
  const current = room?.controller?.my ? getResourceControlRoomStock(room, resource) : getStock(snapshot, resource);
  const incoming = context.healthyIncomingByRoomResource.get(
    roomResourceKey(snapshot.roomName, resource),
  ) || 0;
  return Math.max(0, demandTarget - current - incoming);
}

function findBestBuyOrder(
  type: ORDER_BUY | ORDER_SELL,
  resource: ResourceConstant,
  roomName: string,
  amount: number,
  maxDealEnergyCostRatio: number,
  priceCap?: number,
  priceFloor?: number,
): Order | null {
  const orders = Game.market.getAllOrders({ type, resourceType: resource });
  let best: Order | null = null;

  for (const order of orders) {
    if (order.amount < amount || !order.roomName) {
      continue;
    }

    if (priceCap !== undefined && order.price > priceCap) {
      continue;
    }
    if (priceFloor !== undefined && order.price < priceFloor) {
      continue;
    }

    const cost = Game.market.calcTransactionCost(amount, roomName, order.roomName);
    const ratio = amount > 0 ? cost / amount : Infinity;
    if (ratio > maxDealEnergyCostRatio) {
      continue;
    }

    if (!best) {
      best = order;
      continue;
    }

    if (type === ORDER_BUY) {
      if (order.price > best.price) {
        best = order;
      }
    } else if (order.price < best.price) {
      best = order;
    }
  }

  return best;
}

function isHubProtectedResource(resource: ResourceConstant, roomName: string): boolean {
  const hubCfg = Memory.cfg?.hub;
  if (!hubCfg) {
    return false;
  }

  const isHubRoom = hubCfg.hubRoomName === roomName;
  const targetCompounds = hubCfg.targetCompounds || [];

  if (!isHubRoom) {
    if (targetCompounds.includes(resource)) return true;
    if (isResourceCommittedToDistributedSynthesis(roomName, resource)) return true;
    return false;
  }

  const surplus = Memory.runtime?.hub?.marketSellSurplus?.[resource];
  if (surplus != null && surplus > 0) {
    return false;
  }

  return targetCompounds.includes(resource)
    || HUB_INTERMEDIATES.includes(resource)
    || BASE_MINERALS.includes(resource);
}

function isResourceCommittedToDistributedSynthesis(roomName: string, resource: ResourceConstant): boolean {
  const assignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments;
  if (!assignments) return false;

  const assignment = assignments.find(a => a.roomName === roomName);
  if (!assignment) return false;

  const routeDecisions = Memory.runtime?.hub?.distributedSynthesis?.routeDecisions ?? [];
  for (const route of routeDecisions) {
    if (route.fromRoom === roomName && route.resource === resource && route.amount > 0) {
      return true;
    }
  }

  return false;
}

function getHubMarketSellResources(): ResourceConstant[] {
  if (!Memory.cfg?.hub?.marketSellEnabled) return [];
  const surplus = Memory.runtime?.hub?.marketSellSurplus;
  if (!surplus) return [];
  return (Object.entries(surplus) as [ResourceConstant, number][])
    .filter(([, amount]) => amount > 0)
    .map(([resource]) => resource);
}

function applyMarketOps(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  terminalBusy: Set<string>,
  context: ResourceControlTransferContext,
): string[] {
  if (!marketCfg.enabled || marketCfg.maxDealsPerRun <= 0) {
    return [];
  }

  const actions: string[] = [];
  let dealsDone = 0;

  const exportRooms = snapshots
    .filter((snapshot) => snapshot.terminal.cooldown === 0)
    .filter(
      (snapshot) =>
        snapshot.state === "export" ||
        getNativeMineralAutoSellSurplus(snapshot, marketCfg.nativeMineralAutoSellThreshold) >= marketCfg.minDealAmount,
    )
    .sort((left, right) => right.storageEnergy - left.storageEnergy);

  for (const room of exportRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    for (const resource of getSellResourcesForRoom(room, marketCfg)) {
      if (resource !== RESOURCE_ENERGY && isHubProtectedResource(resource, room.roomName)) {
        continue;
      }

      const isNativeAutoSell = room.canMineNative && room.nativeMineralType === resource;
      const hubSurplusAmount = Memory.runtime?.hub?.marketSellSurplus?.[resource];
      const isHubSurplusSell = room.roomName === Memory.cfg?.hub?.hubRoomName && hubSurplusAmount != null && hubSurplusAmount > 0;
      if (room.state !== "export" && !isNativeAutoSell && !isHubSurplusSell) {
        continue;
      }

      const total = getStock(room, resource);
      const outgoingReserved = resource === RESOURCE_ENERGY
        ? 0
        : context.healthyOutgoingByRoomResource.get(roomResourceKey(room.roomName, resource)) || 0;
      const effectiveTotal = Math.max(0, total - outgoingReserved);
      const exportStart = resource === RESOURCE_ENERGY ? room.energyExportStart : room.mineralExportStart[resource] || 0;
      const sellThreshold = isHubSurplusSell
        ? Math.max(0, effectiveTotal - hubSurplusAmount!)
        : isNativeAutoSell
          ? Math.min(exportStart, marketCfg.nativeMineralAutoSellThreshold)
          : exportStart;
      const surplus = isHubSurplusSell ? hubSurplusAmount! : Math.max(0, effectiveTotal - sellThreshold);
      if (surplus < marketCfg.minDealAmount) {
        continue;
      }

      const terminalResource = getTerminalResourceAmount(room, resource);
      let amount = Math.min(surplus, terminalResource, marketCfg.maxDealAmount);
      if (amount < marketCfg.minDealAmount) {
        continue;
      }

      if (resource === RESOURCE_ENERGY) {
        amount = Math.min(amount, Math.max(0, getEnergyAvailableForFees(room)));
        if (amount < marketCfg.minDealAmount) {
          continue;
        }
      }

      const minSellPrice = marketCfg.minSellPrice[resource];
      const order = findBestBuyOrder(
        ORDER_BUY,
        resource,
        room.roomName,
        amount,
        marketCfg.maxDealEnergyCostRatio,
        undefined,
        minSellPrice,
      );
      if (!order || !order.roomName) {
        continue;
      }

      const cost = Game.market.calcTransactionCost(amount, room.roomName, order.roomName);
      if (resource === RESOURCE_ENERGY && amount + cost > getEnergyAvailableForFees(room)) {
        continue;
      }
      if (resource !== RESOURCE_ENERGY && cost > getEnergyAvailableForFees(room)) {
        continue;
      }

      const code = Game.market.deal(order.id, amount, room.roomName);
      if (code !== OK) {
        actions.push(`market-sell-failed:${room.roomName}:${resource}:code=${code}`);
        continue;
      }

      room.terminalEnergy = Math.max(0, room.terminalEnergy - (resource === RESOURCE_ENERGY ? amount : 0) - cost);
      dealsDone += 1;
      actions.push(`market-sell:${room.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${cost}`);
      break;
    }
  }

  const hubCfg = Memory.cfg?.hub;
  if (hubCfg?.hubRoomName && dealsDone < marketCfg.maxDealsPerRun) {
    const hubSnapshot = snapshots.find(s => s.roomName === hubCfg.hubRoomName);
    if (hubSnapshot && hubSnapshot.terminal.cooldown === 0 && !terminalBusy.has(hubSnapshot.roomName)) {
      for (const resource of getHubMarketSellResources()) {
        if (dealsDone >= marketCfg.maxDealsPerRun) break;
        if (resource === RESOURCE_ENERGY || resource === RESOURCE_POWER || resource === RESOURCE_OPS) continue;

        const surplusAmount = Memory.runtime?.hub?.marketSellSurplus?.[resource];
        if (surplusAmount == null || surplusAmount < marketCfg.minDealAmount) continue;

        const terminalResource = getTerminalResourceAmount(hubSnapshot, resource);
        const amount = Math.min(surplusAmount, terminalResource, marketCfg.maxDealAmount);
        if (amount < marketCfg.minDealAmount) continue;

        const sellOrders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resource });
        const referencePrice = sellOrders.length > 0 ? Math.min(...sellOrders.map(o => o.price)) : 0;
        const priceFloor = referencePrice > 0 ? referencePrice * 0.5 : marketCfg.minSellPrice[resource];
        const order = findBestBuyOrder(ORDER_BUY, resource, hubSnapshot.roomName, amount, marketCfg.maxDealEnergyCostRatio, undefined, priceFloor);
        if (!order || !order.roomName) continue;

        const actualCost = Game.market.calcTransactionCost(amount, hubSnapshot.roomName, order.roomName);
        if (actualCost > hubSnapshot.terminalEnergy) continue;

        const code = Game.market.deal(order.id, amount, hubSnapshot.roomName);
        if (code !== OK) {
          actions.push(`hub-surplus-sell-failed:${hubSnapshot.roomName}:${resource}:code=${code}`);
          continue;
        }

        hubSnapshot.terminalEnergy = Math.max(0, hubSnapshot.terminalEnergy - actualCost);
        dealsDone += 1;
        actions.push(`hub-surplus-sell:${hubSnapshot.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${actualCost}`);
      }
    }
  }

  if (!marketCfg.emergencyBuyEnabled || dealsDone >= marketCfg.maxDealsPerRun) {
    return actions;
  }

  const survivalRooms = snapshots
    .filter((snapshot) => snapshot.state === "survival" && snapshot.terminal.cooldown === 0)
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const room of survivalRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    const need = Math.max(0, room.energyTarget - room.storageEnergy);
    if (need < marketCfg.minDealAmount) {
      continue;
    }

    if (shouldSkipMarketBuyForResource(room, RESOURCE_ENERGY)) {
      continue;
    }

    const terminalFree = Math.min(
      room.terminalFreeCapacity,
      room.terminal.store.getFreeCapacity(RESOURCE_ENERGY),
    );
    const amount = Math.min(need, marketCfg.maxDealAmount, terminalFree);
    if (amount < marketCfg.minDealAmount) {
      continue;
    }

    const maxBuyPrice = marketCfg.maxBuyPrice[RESOURCE_ENERGY];
    const order = findBestBuyOrder(
      ORDER_SELL,
      RESOURCE_ENERGY,
      room.roomName,
      amount,
      marketCfg.maxDealEnergyCostRatio,
      maxBuyPrice,
      undefined,
    );
    if (!order || !order.roomName) {
      continue;
    }

    const transferCost = Game.market.calcTransactionCost(amount, room.roomName, order.roomName);
    if (transferCost > room.terminalEnergy) {
      continue;
    }

    const code = Game.market.deal(order.id, amount, room.roomName);
    if (code !== OK) {
      actions.push(`market-buy-failed:${room.roomName}:energy:code=${code}`);
      continue;
    }

    room.terminalEnergy = Math.max(0, room.terminalEnergy + amount - transferCost);
    dealsDone += 1;
    actions.push(`market-buy:${room.roomName}:energy=${amount}:price=${order.price.toFixed(3)}:cost=${transferCost}`);
  }

  if (dealsDone >= marketCfg.maxDealsPerRun) {
    return actions;
  }

  const mineralBuyRooms = snapshots
    .filter((snapshot) => snapshot.terminal.cooldown === 0)
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const room of mineralBuyRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    // Skip market buys for hub room when internalOnly is active
    const hubCfg = Memory.cfg?.hub;
    if (hubCfg && hubCfg.enabled !== false && hubCfg.hubRoomName === room.roomName && hubCfg.internalOnly !== false) {
      continue;
    }

    for (const resource of marketCfg.buyResources) {
      if (dealsDone >= marketCfg.maxDealsPerRun) {
        break;
      }
      if (resource === RESOURCE_ENERGY || !BASE_MINERALS.includes(resource)) {
        continue;
      }
      if (shouldSkipMarketBuyForResource(room, resource)) {
        continue;
      }

      const deficit = getMarketBuyDemandDeficit(room, resource, context);
      if (deficit < marketCfg.minDealAmount) {
        continue;
      }

      const maxBuyPrice = marketCfg.maxBuyPrice[resource];
      if (typeof maxBuyPrice !== "number" || !Number.isFinite(maxBuyPrice) || maxBuyPrice <= 0) {
        continue;
      }

      const terminalFree = Math.min(
        room.terminalFreeCapacity,
        room.terminal.store.getFreeCapacity(resource),
      );
      const amount = Math.min(deficit, marketCfg.maxDealAmount, terminalFree);
      if (amount < marketCfg.minDealAmount) {
        continue;
      }

      const order = findBestBuyOrder(
        ORDER_SELL,
        resource,
        room.roomName,
        amount,
        marketCfg.maxDealEnergyCostRatio,
        maxBuyPrice,
        undefined,
      );
      if (!order || !order.roomName) {
        continue;
      }

      const transferCost = Game.market.calcTransactionCost(amount, room.roomName, order.roomName);
      if (transferCost > room.terminalEnergy) {
        continue;
      }

      const code = Game.market.deal(order.id, amount, room.roomName);
      if (code !== OK) {
        actions.push(`market-buy-failed:${room.roomName}:${resource}:code=${code}`);
        continue;
      }

      room.terminalEnergy = Math.max(0, room.terminalEnergy - transferCost);
      dealsDone += 1;
      actions.push(`market-buy:${room.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${transferCost}`);
    }
  }

  return actions;
}

function persistResourceControlState(
  snapshots: ResourceControlSnapshot[],
  actions: string[],
  marketActions: string[],
  context: ResourceControlTransferContext,
  capacityIndexBuildCount: number,
  synthesisBindings?: SynthesisBindingStore,
  capacityReliefRoutes: CapacityReliefRoute[] = [],
): void {
  const runtime = getMemoryService().ensureRuntime();
  const previousResourceControl = runtime.resourceControl;
  const previousBindings = previousResourceControl?.synthesisBindings;
  const taskHealthByRoom = new Map<string, ResourceControlTaskHealth>();
  for (const snapshot of snapshots) {
    taskHealthByRoom.set(snapshot.roomName, {
      pendingIncoming: 0,
      pendingOutgoing: 0,
      blockedIncoming: {},
      blockedOutgoing: {},
    });
  }

  const taskSummary = {
    pending: 0,
    manualPending: 0,
    automaticPending: 0,
    blockedByReason: {} as Partial<Record<NonNullable<ResourceTransferTask["blockedReason"]>, number>>,
  };
  for (const task of context.tasks) {
    if (task.status !== "pending") continue;
    taskSummary.pending += 1;
    if (task.origin === "automatic") taskSummary.automaticPending += 1;
    else taskSummary.manualPending += 1;

    const outgoing = taskHealthByRoom.get(task.fromRoomName);
    const incoming = taskHealthByRoom.get(task.toRoomName);
    if (outgoing) outgoing.pendingOutgoing += 1;
    if (incoming) incoming.pendingIncoming += 1;
    if (!task.blockedReason) continue;

    taskSummary.blockedByReason[task.blockedReason] =
      (taskSummary.blockedByReason[task.blockedReason] || 0) + 1;
    if (outgoing) {
      outgoing.blockedOutgoing[task.blockedReason] =
        (outgoing.blockedOutgoing[task.blockedReason] || 0) + 1;
    }
    if (incoming) {
      incoming.blockedIncoming[task.blockedReason] =
        (incoming.blockedIncoming[task.blockedReason] || 0) + 1;
    }
  }

  const recentCapacityReliefRoutes = [
    ...(previousResourceControl?.recentCapacityReliefRoutes || []),
    ...capacityReliefRoutes,
  ].slice(-MAX_RECENT_CAPACITY_RELIEF_ROUTES);
  runtime.resourceControl = {
    updatedAt: Game.time,
    capacityIndexBuildCount,
    taskContributionIndex: { ...context.taskContributionIndex },
    rooms: snapshots.reduce(
      (result, snapshot) => {
        const minerals: Partial<Record<ResourceConstant, number>> = {};
        for (const resource of BASE_MINERALS) {
          minerals[resource] = getStock(snapshot, resource);
        }

        result[snapshot.roomName] = {
          state: snapshot.state,
          capacityState: snapshot.capacityState,
          storageUsedCapacity: snapshot.storageUsedCapacity,
          storageFreeCapacity: snapshot.storageFreeCapacity,
          terminalUsedCapacity: snapshot.terminalUsedCapacity,
          terminalFreeCapacity: snapshot.terminalFreeCapacity,
          storageEnergy: snapshot.storageEnergy,
          terminalEnergy: snapshot.terminalEnergy,
          energyFloor: snapshot.energyFloor,
          energyTarget: snapshot.energyTarget,
          energyExportStart: snapshot.energyExportStart,
          terminalEnergyReserve: snapshot.terminalEnergyReserve,
          nativeMineralType: snapshot.nativeMineralType,
          canMineNative: snapshot.canMineNative,
          minerals,
          taskHealth: taskHealthByRoom.get(snapshot.roomName)!,
        };
        return result;
      },
      {} as Record<
        string,
        {
          state: ResourceControlState;
          capacityState: ResourceCapacityState;
          storageUsedCapacity: number;
          storageFreeCapacity: number;
          terminalUsedCapacity: number;
          terminalFreeCapacity: number;
          storageEnergy: number;
          terminalEnergy: number;
          energyFloor: number;
          energyTarget: number;
          energyExportStart: number;
          terminalEnergyReserve: number;
          nativeMineralType?: MineralConstant;
          canMineNative: boolean;
          minerals: Partial<Record<ResourceConstant, number>>;
          taskHealth: ResourceControlTaskHealth;
        }
      >,
    ),
    lastActions: limitActionLog(actions),
    lastMarketActions: limitActionLog(marketActions),
    taskSummary,
    recentCapacityReliefRoutes,
    synthesisBindings: synthesisBindings || previousBindings || {},
  };
}

export function runResourceControl(): void {
  const cfg = Memory.cfg?.resourceControl;
  if (cfg?.enabled === false) {
    return;
  }

  const interval = normalizeInterval(cfg?.sampleInterval);
  if (Game.time % interval !== 0) {
    return;
  }

  const capacityConfig = resolveCapacityConfig();
  reconcileResourceTransferTasks({
    automaticTaskNoProgressTtl: capacityConfig.automaticTaskNoProgressTtl,
    sourceDepletedGraceTicks: capacityConfig.sourceDepletedGraceTicks,
  });
  const snapshots = collectResourceControlSnapshots();
  if (snapshots.length === 0) {
    return;
  }

  const marketConfig = resolveMarketConfig();
  const capacityIndexBuildCounter: ResourceControlCapacityIndexBuildCounter = { count: 0 };
  const context = createResourceControlTransferContext(
    snapshots,
    capacityConfig,
    capacityIndexBuildCounter,
  );

  const terminalBusy = new Set<string>();
  const sendBudget: InternalSendBudget = { remaining: resolveTaskMaxPerRun() };
  const capacityReliefRoutes: CapacityReliefRoute[] = [];
  const remainingEnergyNeedByRoom = new Map(
    snapshots.map((snapshot) => [
      snapshot.roomName,
      Math.max(0, snapshot.energyTarget - snapshot.storageEnergy),
    ]),
  );
  const actions = applyInternalBalancing(
    snapshots,
    terminalBusy,
    sendBudget,
    context,
    remainingEnergyNeedByRoom,
  );
  const capacityActions = planCapacityReliefTasks(
    snapshots,
    capacityConfig,
    context,
    remainingEnergyNeedByRoom,
  );
  const taskActions = executeTransferTasks(
    snapshots,
    terminalBusy,
    capacityConfig,
    sendBudget,
    capacityReliefRoutes,
    remainingEnergyNeedByRoom,
    context,
  );
  const preloadActions = syncTerminalFeedTasks(
    snapshots,
    marketConfig,
    capacityConfig,
    context,
    remainingEnergyNeedByRoom,
  );
  const marketActions = applyMarketOps(
    snapshots,
    marketConfig,
    terminalBusy,
    context,
  );
  persistResourceControlState(
    snapshots,
    [...actions, ...capacityActions, ...taskActions, ...preloadActions],
    marketActions,
    context,
    capacityIndexBuildCounter.count,
    undefined,
    capacityReliefRoutes,
  );
}
