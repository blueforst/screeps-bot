import { pruneCarrierTasksForProducer, replaceCarrierTasksForProducerRoom, type CarrierTaskDraft } from "@/runtime/carrierTaskBoard";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

type ResourceControlState = "survival" | "balanced" | "export";
type ResourceThresholdMap = Partial<Record<ResourceConstant, number>>;

const BASE_MINERALS: ResourceConstant[] = [RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST];
const DEFAULT_MARKET_SELL_RESOURCES: ResourceConstant[] = [RESOURCE_ENERGY, ...BASE_MINERALS];

interface ResourceControlRoomConfig {
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
  transferBatchSize: number;
  transferMinAmount: number;
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

interface ResourceControlSynthesisRoomConfig {
  demands: ResourceThresholdMap;
  donorRoomNames?: string[];
}

interface ResourceControlSynthesisConfig {
  enabled: boolean;
  maxGeneratedPerRun: number;
  rooms: Record<string, ResourceControlSynthesisRoomConfig>;
}

interface SynthesisProducerBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisProducerBinding>;

interface ResourceControlSnapshot {
  roomName: string;
  state: ResourceControlState;
  storageEnergy: number;
  terminalEnergy: number;
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
  transferBatchSize: number;
  transferMinAmount: number;
  nativeMineralType?: MineralConstant;
  canMineNative: boolean;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
  storage?: StructureStorage;
  terminal: StructureTerminal;
}

type ResourceTransferTaskStatus = "pending" | "done" | "cancelled" | "failed";

interface ResourceTransferTask {
  id: string;
  resource: ResourceConstant;
  fromRoomName: string;
  toRoomName: string;
  amount: number;
  remainingAmount: number;
  status: ResourceTransferTaskStatus;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  lastError?: string;
}

interface CreateResourceTransferTaskResult {
  ok: true;
  task: ResourceTransferTask;
}

interface CancelResourceTransferTaskResult {
  ok: true;
  taskId: string;
  previousStatus: ResourceTransferTaskStatus;
}

interface ListResourceTransferTasksResult {
  ok: true;
  tasks: ResourceTransferTask[];
}

const DEFAULT_INTERVAL = 10;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 100;
const DEFAULT_TASK_MAX_PER_RUN = 1;
const MIN_TASK_MAX_PER_RUN = 1;
const MAX_TASK_MAX_PER_RUN = 5;
const DEFAULT_SYNTHESIS_MAX_GENERATED_PER_RUN = 2;
const MIN_SYNTHESIS_MAX_GENERATED_PER_RUN = 0;
const MAX_SYNTHESIS_MAX_GENERATED_PER_RUN = 10;
const SYNTHESIS_BINDING_LEASE_TICKS = 200;
const SYNTHESIS_BINDING_STICKY_BONUS = 5;
const SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO = 1.2;
const RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER = "resourceControl:preload";
const RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY = 80;
const RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY = 90;

let taskIdSequence = 0;
let taskIdSequenceTick = -1;

const DEFAULT_ROOM_CONFIG: ResourceControlRoomConfig = {
  energyFloor: 120_000,
  energyTarget: 200_000,
  energyExportStart: 250_000,
  terminalEnergyReserve: 20_000,
  transferBatchSize: 10_000,
  transferMinAmount: 1_000,
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
  nativeMineralAutoSellThreshold: 5_000,
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

const DEFAULT_SYNTHESIS_CONFIG: ResourceControlSynthesisConfig = {
  enabled: false,
  maxGeneratedPerRun: DEFAULT_SYNTHESIS_MAX_GENERATED_PER_RUN,
  rooms: {},
};

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return Math.max(min, Math.min(max, normalized));
}

function normalizeInterval(value: unknown): number {
  return normalizeNumber(value, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL);
}

function normalizeTaskMaxPerRun(value: unknown): number {
  return normalizeNumber(value, DEFAULT_TASK_MAX_PER_RUN, MIN_TASK_MAX_PER_RUN, MAX_TASK_MAX_PER_RUN);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "boolean") {
    return fallback;
  }
  return value;
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

function normalizeRoomNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeRoomConfig(value: unknown): ResourceControlRoomConfig {
  const config = value && typeof value === "object" ? (value as Partial<ResourceControlRoomConfig>) : {};
  const energyFloor = normalizeNumber(config.energyFloor, DEFAULT_ROOM_CONFIG.energyFloor, 0, 3_000_000);
  const energyTarget = normalizeNumber(config.energyTarget, DEFAULT_ROOM_CONFIG.energyTarget, 0, 3_000_000);
  const energyExportStart = normalizeNumber(
    config.energyExportStart,
    DEFAULT_ROOM_CONFIG.energyExportStart,
    0,
    3_000_000,
  );
  const terminalEnergyReserve = normalizeNumber(
    config.terminalEnergyReserve,
    DEFAULT_ROOM_CONFIG.terminalEnergyReserve,
    0,
    300_000,
  );
  const transferBatchSize = normalizeNumber(config.transferBatchSize, DEFAULT_ROOM_CONFIG.transferBatchSize, 100, 50_000);
  const transferMinAmount = normalizeNumber(config.transferMinAmount, DEFAULT_ROOM_CONFIG.transferMinAmount, 100, 10_000);
  const mineralFloor = normalizeResourceThresholdMap(config.mineralFloor, DEFAULT_ROOM_CONFIG.mineralFloor, 0, 500_000);
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
    energyFloor,
    energyTarget: Math.max(energyFloor, energyTarget),
    energyExportStart: Math.max(energyTarget, energyExportStart),
    terminalEnergyReserve,
    transferBatchSize,
    transferMinAmount,
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

function normalizeSynthesisConfig(value: unknown): ResourceControlSynthesisConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const roomsRaw = raw.rooms && typeof raw.rooms === "object" ? (raw.rooms as Record<string, unknown>) : {};
  const rooms: Record<string, ResourceControlSynthesisRoomConfig> = {};

  for (const [roomName, roomCfg] of Object.entries(roomsRaw)) {
    if (!roomCfg || typeof roomCfg !== "object") {
      continue;
    }

    const roomRecord = roomCfg as Record<string, unknown>;
    const demands = normalizeResourceThresholdMap(roomRecord.demands, {}, 0, 1_000_000);
    if (Object.keys(demands).length === 0) {
      continue;
    }

    rooms[roomName] = {
      demands,
      donorRoomNames: normalizeRoomNameList(roomRecord.donorRoomNames),
    };
  }

  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_SYNTHESIS_CONFIG.enabled),
    maxGeneratedPerRun: normalizeNumber(
      raw.maxGeneratedPerRun,
      DEFAULT_SYNTHESIS_CONFIG.maxGeneratedPerRun,
      MIN_SYNTHESIS_MAX_GENERATED_PER_RUN,
      MAX_SYNTHESIS_MAX_GENERATED_PER_RUN,
    ),
    rooms,
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

function resolveTaskMaxPerRun(): number {
  return normalizeTaskMaxPerRun(Memory.cfg?.resourceControl?.taskMaxPerRun);
}

function resolveSynthesisConfig(): ResourceControlSynthesisConfig {
  return normalizeSynthesisConfig(Memory.cfg?.resourceControl?.synthesis);
}

function getBindingKey(targetRoomName: string, resource: ResourceConstant): string {
  return `${targetRoomName}:${resource}`;
}

function getSynthesisBindings(): SynthesisBindingStore {
  return Memory.runtime?.resourceControl?.synthesisBindings || {};
}

function getActiveSynthesisBinding(
  bindings: SynthesisBindingStore,
  targetRoomName: string,
  resource: ResourceConstant,
): SynthesisProducerBinding | null {
  const key = getBindingKey(targetRoomName, resource);
  const binding = bindings[key];
  if (!binding) {
    return null;
  }

  if (binding.expiresAt < Game.time) {
    delete bindings[key];
    return null;
  }

  return binding;
}

function setSynthesisBinding(
  bindings: SynthesisBindingStore,
  targetRoomName: string,
  resource: ResourceConstant,
  fromRoomName: string,
): void {
  const key = getBindingKey(targetRoomName, resource);
  bindings[key] = {
    fromRoomName,
    updatedAt: Game.time,
    expiresAt: Game.time + SYNTHESIS_BINDING_LEASE_TICKS,
  };
}

function ensureTaskStore(): Record<string, ResourceTransferTask> {
  const data = getMemoryService().ensureData();
  data.resourceControl = data.resourceControl || { tasks: {} };
  data.resourceControl.tasks = data.resourceControl.tasks || {};
  return data.resourceControl.tasks;
}

function getTaskListSorted(): ResourceTransferTask[] {
  return Object.values(ensureTaskStore()).sort((left, right) => left.createdAt - right.createdAt);
}

function createTaskId(resource: ResourceConstant, fromRoomName: string, toRoomName: string): string {
  if (taskIdSequenceTick !== Game.time) {
    taskIdSequenceTick = Game.time;
    taskIdSequence = 0;
  }

  taskIdSequence += 1;
  return `${Game.time}:${taskIdSequence}:${resource}:${fromRoomName}->${toRoomName}`;
}

function normalizeTaskReason(reason?: string): string | undefined {
  if (!reason) {
    return undefined;
  }

  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findMergeablePendingTask(
  tasks: Record<string, ResourceTransferTask>,
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  reason?: string,
): ResourceTransferTask | null {
  for (const task of Object.values(tasks)) {
    if (
      task.status === "pending" &&
      task.fromRoomName === fromRoomName &&
      task.toRoomName === toRoomName &&
      task.resource === resource &&
      task.reason === reason
    ) {
      return task;
    }
  }

  return null;
}

export function createResourceTransferTask(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): CreateResourceTransferTaskResult | string {
  if (!fromRoomName || !toRoomName) {
    return "ERR_INVALID_ROOM";
  }
  if (fromRoomName === toRoomName) {
    return "ERR_SAME_ROOM";
  }
  if (typeof resource !== "string" || resource.length === 0) {
    return "ERR_INVALID_RESOURCE";
  }
  if (!RESOURCES_ALL.includes(resource as ResourceConstant)) {
    return "ERR_INVALID_RESOURCE";
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }

  const normalizedAmount = Math.floor(amount);
  if (normalizedAmount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }
  const normalizedReason = normalizeTaskReason(reason);
  const store = ensureTaskStore();
  const mergeTarget = findMergeablePendingTask(store, fromRoomName, toRoomName, resource, normalizedReason);
  if (mergeTarget) {
    mergeTarget.amount += normalizedAmount;
    mergeTarget.remainingAmount += normalizedAmount;
    mergeTarget.updatedAt = Game.time;
    mergeTarget.lastError = undefined;
    return {
      ok: true,
      task: mergeTarget,
    };
  }

  const task: ResourceTransferTask = {
    id: createTaskId(resource, fromRoomName, toRoomName),
    resource,
    fromRoomName,
    toRoomName,
    amount: normalizedAmount,
    remainingAmount: normalizedAmount,
    status: "pending",
    createdAt: Game.time,
    updatedAt: Game.time,
    reason: normalizedReason,
  };

  store[task.id] = task;
  return {
    ok: true,
    task,
  };
}

export function cancelResourceTransferTask(taskId: string): CancelResourceTransferTaskResult | string {
  const store = ensureTaskStore();
  const task = store[taskId];
  if (!task) {
    return `ERR_TASK_NOT_FOUND:${taskId}`;
  }

  const previousStatus = task.status;
  task.status = "cancelled";
  task.updatedAt = Game.time;
  task.lastError = "cancelled_by_command";

  return {
    ok: true,
    taskId,
    previousStatus,
  };
}

export function listResourceTransferTasks(): ListResourceTransferTasksResult {
  return {
    ok: true,
    tasks: getTaskListSorted(),
  };
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

function collectSnapshots(): ResourceControlSnapshot[] {
  const rooms = getTickContextService().getMyRooms().filter((room) => !!room.terminal);

  return rooms.map((room) => {
    const config = resolveRoomConfig(room.name);
    const storageEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const terminalEnergy = room.terminal?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const mineral = room.find(FIND_MINERALS)[0] || null;
    const extractor = room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_EXTRACTOR,
    })[0] as StructureExtractor | undefined;

    return {
      roomName: room.name,
      state: resolveState(storageEnergy, config),
      storageEnergy,
      terminalEnergy,
      energyFloor: config.energyFloor,
      energyTarget: config.energyTarget,
      energyExportStart: config.energyExportStart,
      terminalEnergyReserve: config.terminalEnergyReserve,
      transferBatchSize: config.transferBatchSize,
      transferMinAmount: config.transferMinAmount,
      nativeMineralType: mineral?.mineralType,
      canMineNative: !!mineral && !!extractor,
      mineralFloor: config.mineralFloor,
      mineralExportStart: config.mineralExportStart,
      storage: room.storage || undefined,
      terminal: room.terminal as StructureTerminal,
    };
  });
}

function getStock(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
  return (snapshot.storage?.store.getUsedCapacity(resource) || 0) + snapshot.terminal.store.getUsedCapacity(resource);
}

function getRoomStock(room: Room, resource: ResourceConstant): number {
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

function computeSendAmount(
  donor: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  targetAmount: number,
): number {
  if (donor.terminal.cooldown > 0 || targetAmount <= 0) {
    return 0;
  }

  const availableResource = donor.terminal.store.getUsedCapacity(resource);
  if (availableResource <= 0) {
    return 0;
  }

  let candidate = Math.min(targetAmount, donor.transferBatchSize, availableResource);
  if (candidate < donor.transferMinAmount) {
    return 0;
  }

  while (candidate >= donor.transferMinAmount) {
    const transferCost = Game.market.calcTransactionCost(candidate, donor.roomName, receiverRoomName);
    if (resource === RESOURCE_ENERGY) {
      if (candidate + transferCost <= getEnergyAvailableForFees(donor)) {
        return candidate;
      }
    } else if (transferCost <= getEnergyAvailableForFees(donor)) {
      return candidate;
    }

    candidate = Math.floor(candidate / 2);
  }

  return 0;
}

function computeTransferAmount(from: ResourceControlSnapshot, to: ResourceControlSnapshot): number {
  const receiverNeed = Math.max(0, to.energyTarget - to.storageEnergy);
  if (receiverNeed <= 0) {
    return 0;
  }

  const donorStorageSurplus = Math.max(0, from.storageEnergy - from.energyTarget);
  if (donorStorageSurplus <= 0) {
    return 0;
  }

  const terminalFreeForSend = Math.max(0, from.terminalEnergy - from.terminalEnergyReserve);
  if (terminalFreeForSend <= 0) {
    return 0;
  }

  let candidate = Math.min(from.transferBatchSize, receiverNeed, donorStorageSurplus, terminalFreeForSend);
  if (candidate < from.transferMinAmount) {
    return 0;
  }

  while (candidate >= from.transferMinAmount) {
    const transferCost = Game.market.calcTransactionCost(candidate, from.roomName, to.roomName);
    if (candidate + transferCost <= terminalFreeForSend) {
      return candidate;
    }
    candidate = Math.floor(candidate / 2);
  }

  return 0;
}

function applyPostSendDelta(
  donor: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
): number {
  const transferCost = Game.market.calcTransactionCost(amount, donor.roomName, receiver.roomName);
  donor.terminalEnergy = Math.max(0, donor.terminalEnergy - (resource === RESOURCE_ENERGY ? amount : 0) - transferCost);
  if (resource === RESOURCE_ENERGY) {
    receiver.terminalEnergy += amount;
  }

  return transferCost;
}

function applyInternalBalancing(snapshots: ResourceControlSnapshot[], terminalBusy: Set<string>): string[] {
  const actions: string[] = [];
  const donors = snapshots
    .filter((snapshot) => snapshot.state === "export" && snapshot.terminal.cooldown === 0)
    .sort((left, right) => right.storageEnergy - left.storageEnergy);
  const receivers = snapshots
    .filter((snapshot) => snapshot.state === "survival")
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const donor of donors) {
    if (terminalBusy.has(donor.roomName)) {
      continue;
    }

    for (const receiver of receivers) {
      if (donor.roomName === receiver.roomName) {
        continue;
      }

      const amount = computeTransferAmount(donor, receiver);
      if (amount <= 0) {
        continue;
      }

      const code = donor.terminal.send(RESOURCE_ENERGY, amount, receiver.roomName, "resourceControl:auto-balance");
      if (code !== OK) {
        actions.push(`send-failed:${donor.roomName}->${receiver.roomName}:code=${code}`);
        continue;
      }
      recordFixedCpuAction("resourceControl");

      const transferCost = applyPostSendDelta(donor, receiver, RESOURCE_ENERGY, amount);

      actions.push(`send:${donor.roomName}->${receiver.roomName}:energy=${amount}:cost=${transferCost}`);
      terminalBusy.add(donor.roomName);
      break;
    }
  }

  return actions;
}

function executeTransferTasks(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  maxPerRun: number,
): string[] {
  const actions: string[] = [];
  const byRoomName = snapshots.reduce(
    (result, snapshot) => {
      result[snapshot.roomName] = snapshot;
      return result;
    },
    {} as Record<string, ResourceControlSnapshot>,
  );
  let executed = 0;

  for (const task of getTaskListSorted()) {
    if (executed >= maxPerRun) {
      break;
    }
    if (task.status !== "pending") {
      continue;
    }
    if (task.remainingAmount <= 0) {
      task.status = "done";
      task.updatedAt = Game.time;
      task.lastError = undefined;
      actions.push(`task-auto-done:${task.id}:non_positive_remaining`);
      continue;
    }

    const donor = byRoomName[task.fromRoomName];
    const receiver = byRoomName[task.toRoomName];
    if (!donor || !receiver) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "room_not_ready";
      actions.push(`task-failed:${task.id}:room_not_ready`);
      continue;
    }
    if (donor.roomName === receiver.roomName) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "same_room";
      actions.push(`task-failed:${task.id}:same_room`);
      continue;
    }
    if (terminalBusy.has(donor.roomName) || donor.terminal.cooldown > 0) {
      continue;
    }
    if (task.remainingAmount < donor.transferMinAmount) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "remaining_below_transfer_min";
      actions.push(`task-failed:${task.id}:remaining_below_transfer_min`);
      continue;
    }

    const amount = computeSendAmount(
      donor,
      receiver.roomName,
      task.resource,
      Math.min(task.remainingAmount, donor.transferBatchSize),
    );
    if (amount <= 0) {
      task.updatedAt = Game.time;
      task.lastError = "insufficient_terminal_resource_or_fee";
      continue;
    }

    const code = donor.terminal.send(task.resource, amount, receiver.roomName, `resourceControl:task:${task.id}`);
    if (code !== OK) {
      task.updatedAt = Game.time;
      task.lastError = `send_code_${code}`;
      if (code === ERR_INVALID_ARGS || code === ERR_INVALID_TARGET) {
        task.status = "failed";
        actions.push(`task-failed:${task.id}:send_code_${code}`);
        continue;
      }
      actions.push(`task-send-failed:${task.id}:code=${code}`);
      continue;
    }
    recordFixedCpuAction("resourceControl");

    const transferCost = applyPostSendDelta(donor, receiver, task.resource, amount);
    task.remainingAmount = Math.max(0, task.remainingAmount - amount);
    task.updatedAt = Game.time;
    task.lastError = undefined;
    if (task.remainingAmount <= 0) {
      task.status = "done";
    }

    terminalBusy.add(donor.roomName);
    executed += 1;
    actions.push(`task-send:${task.id}:${task.resource}=${amount}:cost=${transferCost}`);
  }

  return actions;
}

function createTerminalFeedTask(room: ResourceControlSnapshot, resource: ResourceConstant, targetStock: number): CarrierTaskDraft | null {
  if (!room.storage || targetStock <= 0) {
    return null;
  }

  const terminalAmount = room.terminal.store.getUsedCapacity(resource);
  const storageAmount = room.storage.store.getUsedCapacity(resource);
  const terminalFree = room.terminal.store.getFreeCapacity(resource);
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
  availableAmount = room.terminal.store.getUsedCapacity(resource),
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

function getPlannedEnergySendBatch(room: ResourceControlSnapshot): number {
  const outgoingEnergy = getOutgoingPendingAmount(room.roomName, RESOURCE_ENERGY);
  if (outgoingEnergy > 0) {
    return Math.min(room.transferBatchSize, outgoingEnergy);
  }

  if (room.state === "export") {
    return room.transferBatchSize;
  }

  return 0;
}

function getEnergySendFeeBudget(room: ResourceControlSnapshot, snapshots: ResourceControlSnapshot[], amount: number): number {
  if (amount <= 0) {
    return 0;
  }

  const pendingEnergyTask = getTaskListSorted().find(
    (task) => task.status === "pending" && task.fromRoomName === room.roomName && task.resource === RESOURCE_ENERGY,
  );
  if (pendingEnergyTask) {
    return Game.market.calcTransactionCost(amount, room.roomName, pendingEnergyTask.toRoomName);
  }

  if (room.state !== "export") {
    return 0;
  }

  const receiver = snapshots
    .filter((snapshot) => snapshot.roomName !== room.roomName && snapshot.state === "survival")
    .sort((left, right) => left.storageEnergy - right.storageEnergy)[0];

  if (!receiver) {
    return 0;
  }

  return Game.market.calcTransactionCost(amount, room.roomName, receiver.roomName);
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
  if (!room.canMineNative || !room.nativeMineralType) {
    return marketCfg.sellResources;
  }

  return [room.nativeMineralType, ...marketCfg.sellResources.filter((resource) => resource !== room.nativeMineralType)];
}

function getReservedTerminalEnergyForPendingSends(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
): number {
  const stagedEnergy = getPlannedEnergySendBatch(room);
  const feeBudget = getEnergySendFeeBudget(room, snapshots, stagedEnergy);
  return stagedEnergy + feeBudget;
}

function createEnergyTerminalTask(room: ResourceControlSnapshot, snapshots: ResourceControlSnapshot[]): CarrierTaskDraft | null {
  if (!room.storage) {
    return null;
  }

  const terminalEnergy = room.terminalEnergy;
  const reservedTerminalEnergy = getReservedTerminalEnergyForPendingSends(room, snapshots);
  const offloadableTerminalEnergy = Math.max(0, terminalEnergy - reservedTerminalEnergy);

  if (room.storageEnergy < room.energyTarget && offloadableTerminalEnergy > 0) {
    return createTerminalOffloadTask(
      room,
      RESOURCE_ENERGY,
      Math.min(room.transferBatchSize, room.energyTarget - room.storageEnergy),
      offloadableTerminalEnergy,
    );
  }

  if (room.storageEnergy < room.energyTarget) {
    return null;
  }

  const stagedEnergy = getPlannedEnergySendBatch(room);
  const feeBudget = reservedTerminalEnergy - stagedEnergy;
  const desiredTerminalEnergy = room.terminalEnergyReserve + stagedEnergy + feeBudget;
  return createTerminalFeedTask(room, RESOURCE_ENERGY, desiredTerminalEnergy);
}

function syncTerminalFeedTasks(snapshots: ResourceControlSnapshot[], marketCfg: ResourceControlMarketConfig): string[] {
  const pendingByRoom = new Map<string, Map<ResourceConstant, number>>();
  for (const task of Object.values(ensureTaskStore())) {
    if (task.status !== "pending" || task.resource === RESOURCE_ENERGY) {
      continue;
    }

    const roomPending = pendingByRoom.get(task.fromRoomName) || new Map<ResourceConstant, number>();
    roomPending.set(task.resource, (roomPending.get(task.resource) || 0) + task.remainingAmount);
    pendingByRoom.set(task.fromRoomName, roomPending);
  }

  const validRoomNames = new Set(snapshots.map((snapshot) => snapshot.roomName));
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    const drafts: CarrierTaskDraft[] = [];
    const energyDraft = createEnergyTerminalTask(snapshot, snapshots);
    if (energyDraft) {
      drafts.push(energyDraft);
    }

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    const roomPending = pendingByRoom.get(snapshot.roomName);
    if (roomPending) {
      for (const [resource, amount] of roomPending.entries()) {
        desiredFeedByResource.set(resource, Math.min(snapshot.transferBatchSize, amount));
      }
    }

    if (snapshot.nativeMineralType) {
      const target = getNativeMineralAutoSellTerminalTarget(snapshot, marketCfg);
      if (target > 0) {
        desiredFeedByResource.set(
          snapshot.nativeMineralType,
          Math.max(desiredFeedByResource.get(snapshot.nativeMineralType) || 0, target),
        );
      }
    }

    drafts.push(
      ...Array.from(desiredFeedByResource.entries())
        .map(([resource, target]) => createTerminalFeedTask(snapshot, resource, target))
        .filter((draft): draft is CarrierTaskDraft => !!draft),
    );

    replaceCarrierTasksForProducerRoom(RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER, snapshot.roomName, drafts);
    if (drafts.length > 0) {
      actions.push(`terminal-logistics:${snapshot.roomName}:count=${drafts.length}`);
    }
  }

  pruneCarrierTasksForProducer(RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER, validRoomNames);
  return actions;
}

function getOutgoingPendingAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  for (const task of Object.values(ensureTaskStore())) {
    if (task.status === "pending" && task.fromRoomName === roomName && task.resource === resource) {
      total += task.remainingAmount;
    }
  }
  return total;
}

function getIncomingPendingAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  for (const task of Object.values(ensureTaskStore())) {
    if (task.status === "pending" && task.toRoomName === roomName && task.resource === resource) {
      total += task.remainingAmount;
    }
  }
  return total;
}

function getDonorAvailable(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
  const total = getStock(snapshot, resource);
  if (resource === RESOURCE_ENERGY) {
    return Math.max(0, total - snapshot.energyTarget);
  }

  const floor = snapshot.mineralFloor[resource] || 0;
  return Math.max(0, total - floor);
}

function countPendingOutgoingTaskByRoom(roomName: string): number {
  let count = 0;
  for (const task of Object.values(ensureTaskStore())) {
    if (task.status === "pending" && task.fromRoomName === roomName) {
      count += 1;
    }
  }

  return count;
}

function scoreDonorCandidate(
  donor: ResourceControlSnapshot,
  targetRoomName: string,
  resource: ResourceConstant,
  amount: number,
  currentBinding: SynthesisProducerBinding | null,
): number {
  const available = getDonorAvailable(donor, resource);
  const stockScore = Math.min(30, available / Math.max(1, amount));
  const transferCost = Game.market.calcTransactionCost(amount, donor.roomName, targetRoomName);
  const transferCostRatio = amount > 0 ? transferCost / amount : Infinity;
  const costPenalty = transferCostRatio * 8;
  const pendingPenalty = countPendingOutgoingTaskByRoom(donor.roomName) * 1.2;
  const stickyBonus = currentBinding?.fromRoomName === donor.roomName ? SYNTHESIS_BINDING_STICKY_BONUS : 0;

  return stockScore - costPenalty - pendingPenalty + stickyBonus;
}

function generateSynthesisTransferTasks(snapshots: ResourceControlSnapshot[]): { actions: string[]; bindings: SynthesisBindingStore } {
  if (Memory.cfg?.synthesisControl?.enabled === true) {
    return {
      actions: [],
      bindings: getSynthesisBindings(),
    };
  }

  const synthesisCfg = resolveSynthesisConfig();
  if (!synthesisCfg.enabled || synthesisCfg.maxGeneratedPerRun <= 0) {
    return { actions: [], bindings: getSynthesisBindings() };
  }

  const actions: string[] = [];
  const bindings = getSynthesisBindings();
  let created = 0;

  for (const [targetRoomName, targetCfg] of Object.entries(synthesisCfg.rooms)) {
    if (created >= synthesisCfg.maxGeneratedPerRun) {
      break;
    }

    const targetRoom = Game.rooms[targetRoomName];
    if (!targetRoom?.controller?.my || !targetRoom.terminal) {
      continue;
    }

    for (const [resourceName, demandTarget] of Object.entries(targetCfg.demands)) {
      if (created >= synthesisCfg.maxGeneratedPerRun) {
        break;
      }

      const resource = resourceName as ResourceConstant;
      const targetAmount = Math.max(0, Math.floor(demandTarget || 0));
      if (targetAmount <= 0) {
        continue;
      }

      const current = getRoomStock(targetRoom, resource);
      const incoming = getIncomingPendingAmount(targetRoomName, resource);
      const deficit = Math.max(0, targetAmount - current - incoming);
      if (deficit <= 0) {
        continue;
      }

      const donorCandidates = snapshots
        .filter((snapshot) => snapshot.roomName !== targetRoomName)
        .filter((snapshot) => snapshot.terminal.cooldown === 0)
        .filter((snapshot) =>
          targetCfg.donorRoomNames && targetCfg.donorRoomNames.length > 0
            ? targetCfg.donorRoomNames.includes(snapshot.roomName)
            : true,
        )
        .map((snapshot) => {
          const outgoing = getOutgoingPendingAmount(snapshot.roomName, resource);
          const available = Math.max(0, getDonorAvailable(snapshot, resource) - outgoing);
          return {
            snapshot,
            available,
          };
        })
        .filter((entry) => entry.available >= snapshotMinAmount(entry.snapshot))
        .sort((left, right) => right.available - left.available);

      if (donorCandidates.length === 0) {
        continue;
      }

      const binding = getActiveSynthesisBinding(bindings, targetRoomName, resource);
      const scored = donorCandidates
        .map((entry) => {
          const amountForScore = Math.min(deficit, entry.available, entry.snapshot.transferBatchSize);
          return {
            entry,
            amountForScore,
            score: scoreDonorCandidate(entry.snapshot, targetRoomName, resource, amountForScore, binding),
          };
        })
        .filter((item) => item.amountForScore >= snapshotMinAmount(item.entry.snapshot))
        .sort((left, right) => right.score - left.score);
      if (scored.length === 0) {
        continue;
      }

      const best = scored[0];
      let selected = best;
      if (binding) {
        const bound = scored.find((item) => item.entry.snapshot.roomName === binding.fromRoomName);
        if (bound && best.score < bound.score * SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO) {
          selected = bound;
        }
      }

      const donor = selected.entry.snapshot;
      const suggested = Math.min(deficit, selected.entry.available, donor.transferBatchSize);
      const amount = Math.max(0, Math.floor(suggested));
      if (amount < snapshotMinAmount(donor)) {
        continue;
      }

      const result = createResourceTransferTask(
        donor.roomName,
        targetRoomName,
        resource,
        amount,
        `auto:synthesis:${targetRoomName}:${resource}`,
      );
      if (typeof result === "string") {
        actions.push(`task-generate-failed:${targetRoomName}:${resource}:${result}`);
        continue;
      }

      setSynthesisBinding(bindings, targetRoomName, resource, donor.roomName);

      created += 1;
      actions.push(`task-generated:${result.task.id}:${resource}=${amount}:${donor.roomName}->${targetRoomName}`);
    }
  }

  return { actions, bindings };
}

function snapshotMinAmount(snapshot: ResourceControlSnapshot): number {
  return snapshot.transferMinAmount;
}

function shouldSkipMarketBuyForResource(snapshot: ResourceControlSnapshot, resource: ResourceConstant): boolean {
  if (resource === RESOURCE_ENERGY) {
    return false;
  }

  return snapshot.canMineNative && snapshot.nativeMineralType === resource;
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

function applyMarketOps(snapshots: ResourceControlSnapshot[], marketCfg: ResourceControlMarketConfig): string[] {
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

    for (const resource of getSellResourcesForRoom(room, marketCfg)) {
      const isNativeAutoSell = room.canMineNative && room.nativeMineralType === resource;
      if (room.state !== "export" && !isNativeAutoSell) {
        continue;
      }

      const total = getStock(room, resource);
      const exportStart = resource === RESOURCE_ENERGY ? room.energyExportStart : room.mineralExportStart[resource] || 0;
      const sellThreshold = isNativeAutoSell
        ? Math.min(exportStart, marketCfg.nativeMineralAutoSellThreshold)
        : exportStart;
      const surplus = Math.max(0, total - sellThreshold);
      if (surplus < marketCfg.minDealAmount) {
        continue;
      }

      const terminalResource = room.terminal.store.getUsedCapacity(resource);
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

    const need = Math.max(0, room.energyTarget - room.storageEnergy);
    if (need < marketCfg.minDealAmount) {
      continue;
    }

    if (shouldSkipMarketBuyForResource(room, RESOURCE_ENERGY)) {
      continue;
    }

    const terminalFree = room.terminal.store.getFreeCapacity(RESOURCE_ENERGY);
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

      const floor = room.mineralFloor[resource] || 0;
      if (floor <= 0) {
        continue;
      }

      const current = getStock(room, resource);
      const deficit = Math.max(0, floor - current);
      if (deficit < marketCfg.minDealAmount) {
        continue;
      }

      const maxBuyPrice = marketCfg.maxBuyPrice[resource];
      if (typeof maxBuyPrice !== "number" || !Number.isFinite(maxBuyPrice) || maxBuyPrice <= 0) {
        continue;
      }

      const terminalFree = room.terminal.store.getFreeCapacity(resource);
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
  synthesisBindings?: SynthesisBindingStore,
): void {
  const runtime = getMemoryService().ensureRuntime();
  const previousBindings = runtime.resourceControl?.synthesisBindings;
  runtime.resourceControl = {
    updatedAt: Game.time,
    rooms: snapshots.reduce(
      (result, snapshot) => {
        const minerals: Partial<Record<ResourceConstant, number>> = {};
        for (const resource of BASE_MINERALS) {
          minerals[resource] = getStock(snapshot, resource);
        }

        result[snapshot.roomName] = {
          state: snapshot.state,
          storageEnergy: snapshot.storageEnergy,
          terminalEnergy: snapshot.terminalEnergy,
          energyFloor: snapshot.energyFloor,
          energyTarget: snapshot.energyTarget,
          energyExportStart: snapshot.energyExportStart,
          nativeMineralType: snapshot.nativeMineralType,
          canMineNative: snapshot.canMineNative,
          minerals,
        };
        return result;
      },
      {} as Record<
        string,
        {
          state: ResourceControlState;
          storageEnergy: number;
          terminalEnergy: number;
          energyFloor: number;
          energyTarget: number;
          energyExportStart: number;
          nativeMineralType?: MineralConstant;
          canMineNative: boolean;
          minerals: Partial<Record<ResourceConstant, number>>;
        }
      >,
    ),
    lastActions: actions,
    lastMarketActions: marketActions,
    synthesisBindings: synthesisBindings || previousBindings || {},
  };
}

export function runSynthesisTaskPlanning(): string[] | null {
  const cfg = Memory.cfg?.resourceControl;
  if (cfg?.enabled === false) {
    return null;
  }

  const interval = normalizeInterval(cfg?.sampleInterval);
  if (Game.time % interval !== 0) {
    return null;
  }

  const snapshots = collectSnapshots();
  if (snapshots.length === 0) {
    return null;
  }

  const autoTaskResult = generateSynthesisTransferTasks(snapshots);
  const runtime = getMemoryService().ensureRuntime();
  runtime.resourceControl = runtime.resourceControl || {
    updatedAt: Game.time,
    rooms: {},
    lastActions: [],
    lastMarketActions: [],
    synthesisBindings: {},
  };
  runtime.resourceControl.synthesisBindings = autoTaskResult.bindings;
  return autoTaskResult.actions;
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

  const snapshots = collectSnapshots();
  if (snapshots.length === 0) {
    return;
  }

  const marketConfig = resolveMarketConfig();

  const terminalBusy = new Set<string>();
  const actions = applyInternalBalancing(snapshots, terminalBusy);
  const taskActions = executeTransferTasks(snapshots, terminalBusy, resolveTaskMaxPerRun());
  const preloadActions = syncTerminalFeedTasks(snapshots, marketConfig);
  const marketActions = applyMarketOps(snapshots, marketConfig);
  persistResourceControlState(snapshots, [...actions, ...taskActions, ...preloadActions], marketActions);
}
