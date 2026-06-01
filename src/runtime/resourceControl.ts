import { pruneCarrierTasksForProducer, replaceCarrierTasksForProducerRoom, type CarrierTaskDraft } from "@/runtime/carrierTaskBoard";
import { limitActionLog } from "@/runtime/actionLog";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  countPendingOutgoingResourceTransferTasksByRoom,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  getOutgoingResourceTransferAmount,
  getResourceTransferTaskListSorted,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";

type ResourceControlState = "survival" | "balanced" | "export";
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

interface ResourceControlRoomConfig {
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
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

interface SynthesisProducerBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisProducerBinding>;

export interface ResourceControlSnapshot {
  roomName: string;
  state: ResourceControlState;
  storageEnergy: number;
  terminalEnergy: number;
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
  transferBatchSize: number;
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
const TERMINAL_TOTAL_STORAGE_CAP = 250_000;
const RECEIVER_STORAGE_FREE_BUFFER = 100_000;

const DEFAULT_ROOM_CONFIG: ResourceControlRoomConfig = {
  energyFloor: 120_000,
  energyTarget: 200_000,
  energyExportStart: 250_000,
  terminalEnergyReserve: 20_000,
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

function resolveRoomConfig(roomName: string): ResourceControlRoomConfig {
  const cfg = Memory.cfg?.resourceControl;
  const roomConfigRaw = cfg?.rooms ? cfg.rooms[roomName] : undefined;
  return normalizeRoomConfig(roomConfigRaw);
}

function resolveMarketConfig(): ResourceControlMarketConfig {
  const cfg = Memory.cfg?.resourceControl;
  return normalizeMarketConfig(cfg?.market);
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
  while (candidate > 0) {
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
  while (candidate > 0) {
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

function isStorageConstrained(snapshot: ResourceControlSnapshot | undefined): boolean {
  return (snapshot?.storage?.store.getFreeCapacity() ?? 0) < RECEIVER_STORAGE_FREE_BUFFER;
}

function getTransferTaskPriority(
  task: ResourceTransferTask,
  survivalRooms: Set<string>,
  storageConstrainedRooms: Set<string>,
): number {
  if (task.resource === RESOURCE_ENERGY && survivalRooms.has(task.toRoomName)) {
    return 0;
  }

  const reason = task.reason;
  if (!reason) {
    return 5;
  }

  if (reason.startsWith("hub:export:") && storageConstrainedRooms.has(task.fromRoomName)) return 1;
  if (reason.startsWith("hub:import:")) return 2;
  if (reason.startsWith("hub:reclaim:")) return 3;
  if (reason.startsWith("hub:export:")) return 4;
  return 1;
}

function getReceiverTerminalFreeCapacity(receiver: ResourceControlSnapshot, resource: ResourceConstant): number {
  const resourceFree = receiver.terminal.store.getFreeCapacity(resource);
  if (typeof resourceFree === "number") {
    return Math.max(0, resourceFree);
  }

  const totalFree = receiver.terminal.store.getFreeCapacity();
  return typeof totalFree === "number" ? Math.max(0, totalFree) : 0;
}

function getHubPendingImportResources(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending") continue;
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
  const survivalRooms = new Set(
    snapshots.filter((s) => s.state === "survival").map((s) => s.roomName),
  );
  const storageConstrainedRooms = new Set(
    snapshots.filter((snapshot) => isStorageConstrained(snapshot)).map((snapshot) => snapshot.roomName),
  );
  const hubPendingImportResources = getHubPendingImportResources();

  const tasks = getResourceTransferTaskListSorted().sort((a, b) => {
    const pa = getTransferTaskPriority(a, survivalRooms, storageConstrainedRooms);
    const pb = getTransferTaskPriority(b, survivalRooms, storageConstrainedRooms);
    if (pa !== pb) return pa - pb;
    return a.createdAt - b.createdAt;
  });

  let executed = 0;

    for (const task of tasks) {
    if (executed >= maxPerRun) {
      break;
    }
    if (task.status !== "pending") {
      continue;
    }

    const taskReason = task.reason || "";
    if (taskReason.startsWith("hub:export:")) {
      const exportResource = taskReason.split(":").pop()!;
      const pendingResources = hubPendingImportResources.get(task.fromRoomName);
      if (pendingResources && pendingResources.has(exportResource) && !storageConstrainedRooms.has(task.fromRoomName)) {
        continue;
      }
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
    const receiverTerminalFree = getReceiverTerminalFreeCapacity(receiver, task.resource);
    if (receiverTerminalFree <= 0) {
      continue;
    }
    if (task.resource !== RESOURCE_ENERGY && isStorageConstrained(receiver)) {
      continue;
    }

    const amount = computeSendAmount(
      donor,
      receiver.roomName,
      task.resource,
      Math.min(task.remainingAmount, donor.transferBatchSize, receiverTerminalFree),
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
  const outgoingEnergy = getOutgoingResourceTransferAmount(room.roomName, RESOURCE_ENERGY);
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

  const pendingEnergyTask = getResourceTransferTaskListSorted().find(
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
): number {
  const stagedEnergy = getPlannedEnergySendBatch(room);
  const feeBudget = getEnergySendFeeBudget(room, snapshots, stagedEnergy);
  let mineralFeeBudget = 0;
  for (const task of getResourceTransferTaskListSorted()) {
    if (task.status !== "pending" || task.fromRoomName !== room.roomName || task.resource === RESOURCE_ENERGY) {
      continue;
    }
    const batchAmount = Math.min(room.transferBatchSize, task.remainingAmount);
    mineralFeeBudget += Game.market.calcTransactionCost(batchAmount, room.roomName, task.toRoomName);
  }
  return stagedEnergy + feeBudget + mineralFeeBudget;
}

function getProtectedTerminalEnergy(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
): number {
  return Math.max(25_000, snapshot.terminalEnergyReserve + getReservedTerminalEnergyForPendingSends(snapshot, snapshots));
}

function createEnergyTerminalTask(room: ResourceControlSnapshot, snapshots: ResourceControlSnapshot[]): CarrierTaskDraft | null {
  if (!room.storage) {
    return null;
  }

  const terminalEnergy = room.terminalEnergy;
  const reservedTerminalEnergy = getReservedTerminalEnergyForPendingSends(room, snapshots);
  const protectedTerminalEnergy = getProtectedTerminalEnergy(room, snapshots);
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

  const stagedEnergy = getPlannedEnergySendBatch(room);
  const feeBudget = reservedTerminalEnergy - stagedEnergy;
  const desiredTerminalEnergy = room.terminalEnergyReserve + stagedEnergy + feeBudget;
  return createTerminalFeedTask(room, RESOURCE_ENERGY, desiredTerminalEnergy);
}

function syncTerminalFeedTasks(snapshots: ResourceControlSnapshot[], marketCfg: ResourceControlMarketConfig): string[] {
  const pendingByRoom = new Map<string, Map<ResourceConstant, number>>();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
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

    // Terminal overflow: offload surplus above cap to storage
    // Compute offload drafts first so we can suppress conflicting feed drafts
    const offloadedResources = new Set<ResourceConstant>();
    if (snapshot.storage) {
      let overflowTotal = snapshot.terminal.store.getUsedCapacity();
      if (overflowTotal > TERMINAL_TOTAL_STORAGE_CAP) {
        const roomPending = pendingByRoom.get(snapshot.roomName);
        let storageFree = snapshot.storage.store.getFreeCapacity();
        const allResources = Object.keys(snapshot.terminal.store) as ResourceConstant[];
        allResources.sort((a, b) => {
          if (a === RESOURCE_ENERGY && b !== RESOURCE_ENERGY) return 1;
          if (a !== RESOURCE_ENERGY && b === RESOURCE_ENERGY) return -1;
          return 0;
        });
        for (const resource of allResources) {
          const stored = snapshot.terminal.store[resource];
          if (typeof stored !== "number" || stored <= 0) continue;

          let protectedAmount: number;
          if (resource === RESOURCE_ENERGY) {
            protectedAmount = getProtectedTerminalEnergy(snapshot, snapshots);
          } else {
            protectedAmount = Math.min(stored, roomPending?.get(resource) ?? 0);
          }

          const offloadable = stored - protectedAmount;
          if (offloadable <= 0) continue;
          const amount = Math.min(offloadable, overflowTotal - TERMINAL_TOTAL_STORAGE_CAP, snapshot.transferBatchSize, storageFree);
          if (amount <= 0) continue;
          const draft = createTerminalOffloadTask(snapshot, resource, amount);
          if (draft) {
            drafts.push(draft);
            offloadedResources.add(resource);
            overflowTotal -= amount;
            storageFree -= amount;
          }
        }
      }
    }

    const offloadTotal = drafts.reduce(
      (sum, d) => (d.type === "terminal_offload" ? sum + d.steps.reduce((s, step) => s + step.amount, 0) : sum),
      0,
    );
    let feedCapacity = Math.max(0, TERMINAL_TOTAL_STORAGE_CAP - (snapshot.terminal.store.getUsedCapacity() - offloadTotal));

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    const roomPending = pendingByRoom.get(snapshot.roomName);
    if (roomPending) {
      for (const [resource, amount] of roomPending.entries()) {
        if (offloadedResources.has(resource)) continue;
        desiredFeedByResource.set(resource, Math.min(snapshot.transferBatchSize, amount));
      }
    }

    if (snapshot.nativeMineralType && !offloadedResources.has(snapshot.nativeMineralType)) {
      const target = getNativeMineralAutoSellTerminalTarget(snapshot, marketCfg);
      if (target > 0) {
        desiredFeedByResource.set(
          snapshot.nativeMineralType,
          Math.max(desiredFeedByResource.get(snapshot.nativeMineralType) || 0, target),
        );
      }
    }

    for (const [resource, target] of desiredFeedByResource.entries()) {
      if (feedCapacity <= 0) break;
      const cappedTarget = Math.min(target, feedCapacity);
      const draft = createTerminalFeedTask(snapshot, resource, cappedTarget);
      if (draft) {
        const feedAmount = draft.steps.reduce((s, step) => s + step.amount, 0);
        feedCapacity -= feedAmount;
        drafts.push(draft);
      }
    }

    replaceCarrierTasksForProducerRoom(RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER, snapshot.roomName, drafts);
    if (drafts.length > 0) {
      actions.push(`terminal-logistics:${snapshot.roomName}:count=${drafts.length}`);
    }
  }

  pruneCarrierTasksForProducer(RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER, validRoomNames);
  return actions;
}

export function getResourceControlDonorAvailable(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
  const total = getStock(snapshot, resource);
  if (resource === RESOURCE_ENERGY) {
    return Math.max(0, total - snapshot.energyTarget);
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

function getMarketBuyDemandDeficit(snapshot: ResourceControlSnapshot, resource: ResourceConstant): number {
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
  const incoming = getIncomingResourceTransferAmount(snapshot.roomName, resource);
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

function hasHubMarketSellSurplus(roomName: string): boolean {
  const hubCfg = Memory.cfg?.hub;
  if (!hubCfg || hubCfg.hubRoomName !== roomName) return false;
  const surplus = Memory.runtime?.hub?.marketSellSurplus;
  if (!surplus) return false;
  return Object.values(surplus).some(v => v != null && v > 0);
}

function getHubMarketSellResources(): ResourceConstant[] {
  if (!Memory.cfg?.hub?.marketSellEnabled) return [];
  const surplus = Memory.runtime?.hub?.marketSellSurplus;
  if (!surplus) return [];
  return (Object.entries(surplus) as [ResourceConstant, number][])
    .filter(([, amount]) => amount > 0)
    .map(([resource]) => resource);
}

function applyMarketOps(snapshots: ResourceControlSnapshot[], marketCfg: ResourceControlMarketConfig, terminalBusy: Set<string>): string[] {
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
      const outgoingReserved = resource === RESOURCE_ENERGY ? 0 : getOutgoingResourceTransferAmount(room.roomName, resource);
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

  const hubCfg = Memory.cfg?.hub;
  if (hubCfg?.hubRoomName && dealsDone < marketCfg.maxDealsPerRun) {
    const hubSnapshot = snapshots.find(s => s.roomName === hubCfg.hubRoomName);
    if (hubSnapshot && hubSnapshot.terminal.cooldown === 0 && !terminalBusy.has(hubSnapshot.roomName)) {
      for (const resource of getHubMarketSellResources()) {
        if (dealsDone >= marketCfg.maxDealsPerRun) break;
        if (resource === RESOURCE_ENERGY || resource === RESOURCE_POWER || resource === RESOURCE_OPS) continue;

        const surplusAmount = Memory.runtime?.hub?.marketSellSurplus?.[resource];
        if (surplusAmount == null || surplusAmount < marketCfg.minDealAmount) continue;

        const terminalResource = hubSnapshot.terminal.store.getUsedCapacity(resource);
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

      const deficit = getMarketBuyDemandDeficit(room, resource);
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
    lastActions: limitActionLog(actions),
    lastMarketActions: limitActionLog(marketActions),
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

  const snapshots = collectResourceControlSnapshots();
  if (snapshots.length === 0) {
    return;
  }

  const marketConfig = resolveMarketConfig();

  const terminalBusy = new Set<string>();
  const actions = applyInternalBalancing(snapshots, terminalBusy);
  const taskActions = executeTransferTasks(snapshots, terminalBusy, resolveTaskMaxPerRun());
  const preloadActions = syncTerminalFeedTasks(snapshots, marketConfig);
  const marketActions = applyMarketOps(snapshots, marketConfig, terminalBusy);
  persistResourceControlState(snapshots, [...actions, ...taskActions, ...preloadActions], marketActions);
}
