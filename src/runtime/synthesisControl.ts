import {
  countPendingIncomingResourceTransferTasksByRoom,
  countPendingOutgoingResourceTransferTasksByRoom,
  createResourceTransferTask,
  getIncomingResourceTransferAmount,
  getOutgoingResourceTransferAmount,
} from "@/runtime/logistics/resourceTransferTasks";
import { limitActionLog } from "@/runtime/actionLog";
import { runSynthesisTaskPlanningCompatibility } from "@/runtime/synthesisCompatibilityPlanning";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
  type CarrierTaskStep,
} from "@/runtime/carrierTaskBoard";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";

type SynthesisStage = "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked";

interface SynthesisReactionPlan {
  product: ResourceConstant;
  targetAmount: number;
  batchSize: number;
  donorRoomNames: string[];
}

interface SynthesisRoomConfig {
  enabled: boolean;
  batchSize: number;
  maxRunsPerTick: number;
  donorRoomNames: string[];
  reagentLabIds: string[];
  reactions: SynthesisReactionPlan[];
}

interface SynthesisControlConfig {
  enabled: boolean;
  sampleInterval: number;
  defaultBatchSize: number;
  defaultMaxRunsPerTick: number;
  rooms: Record<string, SynthesisRoomConfig>;
}

interface SynthesisBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisBinding>;

interface SynthesisRoomRuntimeState {
  stage: SynthesisStage;
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

interface SynthesisRuntimeState {
  updatedAt: number;
  generatedTaskCount: number;
  failedTaskCount: number;
  successfulRunCount: number;
  autoOhTarget?: number;
  autoOhCurrent?: number;
  autoOhProducerRoomName?: string;
  lastActions: string[];
  bindings: SynthesisBindingStore;
  rooms: Record<string, SynthesisRoomRuntimeState>;
}

interface LabTopology {
  reagentLabs: [StructureLab, StructureLab];
  productLabs: StructureLab[];
}

interface DonorCandidate {
  room: Room;
  sendable: number;
  score: number;
}

interface AutoOhPlanSelection {
  roomName: string;
  targetAmount: number;
  currentAmount: number;
  plan: SynthesisReactionPlan;
}

const DEFAULT_SAMPLE_INTERVAL = 10;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_RUNS_PER_TICK = 6;
const MIN_SAMPLE_INTERVAL = 5;
const MAX_SAMPLE_INTERVAL = 100;
const MIN_BATCH_SIZE = LAB_REACTION_AMOUNT;
const MAX_BATCH_SIZE = 3000;
const MIN_MAX_RUNS_PER_TICK = 1;
const MAX_MAX_RUNS_PER_TICK = 20;

function roundUpReactionAmount(amount: number): number {
  return Math.ceil(amount / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
}
const SYNTHESIS_BINDING_LEASE_TICKS = 200;
const SYNTHESIS_BINDING_STICKY_BONUS = 5;
const SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO = 1.2;
const SYNTHESIS_CARRIER_TASK_PRODUCER = "synthesisControl";

let productReagentCache: Partial<Record<ResourceConstant, [ResourceConstant, ResourceConstant]>> | undefined;

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return Math.max(min, Math.min(max, normalized));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRoomNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function getProductReagentMap(): Partial<Record<ResourceConstant, [ResourceConstant, ResourceConstant]>> {
  if (productReagentCache) {
    return productReagentCache;
  }

  const map: Partial<Record<ResourceConstant, [ResourceConstant, ResourceConstant]>> = {};
  const raw = REACTIONS as unknown as Record<string, Record<string, string>>;
  for (const [reagentA, children] of Object.entries(raw)) {
    for (const [reagentB, product] of Object.entries(children)) {
      map[product as ResourceConstant] = [reagentA as ResourceConstant, reagentB as ResourceConstant];
    }
  }

  productReagentCache = map;
  return map;
}

function resolveReagents(product: ResourceConstant): [ResourceConstant, ResourceConstant] | null {
  const map = getProductReagentMap();
  return map[product] || null;
}

function normalizeReactionPlan(raw: unknown, roomCfg: SynthesisRoomConfig, defaultBatchSize: number): SynthesisReactionPlan | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const product = typeof record.product === "string" ? (record.product as ResourceConstant) : null;
  if (!product || !resolveReagents(product)) {
    return null;
  }

  const targetAmount = normalizeNumber(record.targetAmount, 0, 0, 500_000);
  if (targetAmount <= 0) {
    return null;
  }

  const batchSize = normalizeNumber(record.batchSize, roomCfg.batchSize || defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE);
  const donorRoomNames = normalizeRoomNameList(record.donorRoomNames);
  return {
    product,
    targetAmount,
    batchSize,
    donorRoomNames,
  };
}

function normalizeRoomConfig(
  _roomName: string,
  raw: unknown,
  defaultBatchSize: number,
  defaultMaxRunsPerTick: number,
): SynthesisRoomConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const roomCfg: SynthesisRoomConfig = {
    enabled: normalizeBoolean(record.enabled, true),
    batchSize: normalizeNumber(record.batchSize, defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE),
    maxRunsPerTick: normalizeNumber(
      record.maxRunsPerTick,
      defaultMaxRunsPerTick,
      MIN_MAX_RUNS_PER_TICK,
      MAX_MAX_RUNS_PER_TICK,
    ),
    donorRoomNames: normalizeRoomNameList(record.donorRoomNames),
    reagentLabIds: normalizeRoomNameList(record.reagentLabIds),
    reactions: [],
  };

  if (roomCfg.reagentLabIds.length > 2) {
    roomCfg.reagentLabIds = roomCfg.reagentLabIds.slice(0, 2);
  }

  const reactionsRaw = Array.isArray(record.reactions) ? record.reactions : [];
  roomCfg.reactions = reactionsRaw
    .map((entry) => normalizeReactionPlan(entry, roomCfg, defaultBatchSize))
    .filter((entry): entry is SynthesisReactionPlan => !!entry);

  if (roomCfg.reagentLabIds.length > 0 && roomCfg.reagentLabIds.length < 2) {
    roomCfg.enabled = false;
  }

  return roomCfg;
}

function normalizeConfig(): SynthesisControlConfig {
  const raw = Memory.cfg?.synthesisControl;
  const enabled = normalizeBoolean(raw?.enabled, false);
  const sampleInterval = normalizeNumber(raw?.sampleInterval, DEFAULT_SAMPLE_INTERVAL, MIN_SAMPLE_INTERVAL, MAX_SAMPLE_INTERVAL);
  const defaultBatchSize = normalizeNumber(raw?.defaultBatchSize, DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE);
  const defaultMaxRunsPerTick = normalizeNumber(
    raw?.defaultMaxRunsPerTick,
    DEFAULT_MAX_RUNS_PER_TICK,
    MIN_MAX_RUNS_PER_TICK,
    MAX_MAX_RUNS_PER_TICK,
  );

  const roomsRaw = raw?.rooms && typeof raw.rooms === "object" ? (raw.rooms as Record<string, unknown>) : {};
  const rooms: Record<string, SynthesisRoomConfig> = {};
  for (const [roomName, roomCfg] of Object.entries(roomsRaw)) {
    rooms[roomName] = normalizeRoomConfig(roomName, roomCfg, defaultBatchSize, defaultMaxRunsPerTick);
  }

  return {
    enabled,
    sampleInterval,
    defaultBatchSize,
    defaultMaxRunsPerTick,
    rooms,
  };
}

function getLogisticsRooms(): Room[] {
  return getTickContextService()
    .getMyRooms()
    .filter((room) => !!room.controller?.my && !!room.terminal);
}

function roomHasSynthesisLabs(room: Room): boolean {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_LAB,
  });
  return labs.length >= 3;
}

function selectAutoOhProducerRoom(cfg: SynthesisControlConfig, rooms: Room[]): Room | null {
  const candidates = rooms
    .filter((room) => (cfg.rooms[room.name] ? cfg.rooms[room.name].enabled : true))
    .filter((room) => roomHasSynthesisLabs(room))
    .map((room) => {
      const mineral = room.find(FIND_MINERALS)[0] || null;
      return {
        room,
        reagentMatch:
          mineral?.mineralType === RESOURCE_HYDROGEN || mineral?.mineralType === RESOURCE_OXYGEN ? 1 : 0,
        storageEnergy: room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) || 0,
      };
    })
    .sort((left, right) => {
      if (left.reagentMatch !== right.reagentMatch) {
        return right.reagentMatch - left.reagentMatch;
      }
      if (left.storageEnergy !== right.storageEnergy) {
        return right.storageEnergy - left.storageEnergy;
      }
      return left.room.name.localeCompare(right.room.name);
    });

  return candidates[0]?.room || null;
}

function getAutoOhPlan(cfg: SynthesisControlConfig): AutoOhPlanSelection | null {
  const logisticsRooms = getLogisticsRooms();
  const targetAmount = logisticsRooms.length * 2000;
  if (targetAmount <= 0) {
    return null;
  }

  const currentAmount = logisticsRooms.reduce((sum, room) => sum + roomResourceAmount(room, RESOURCE_HYDROXIDE), 0);
  if (currentAmount >= targetAmount) {
    return null;
  }

  const room = selectAutoOhProducerRoom(cfg, logisticsRooms);
  if (!room) {
    return null;
  }

  const roomCurrent = roomResourceAmount(room, RESOURCE_HYDROXIDE);
  const deficit = Math.max(0, targetAmount - currentAmount);
  return {
    roomName: room.name,
    targetAmount,
    currentAmount,
    plan: {
      product: RESOURCE_HYDROXIDE,
      targetAmount: roomCurrent + deficit,
      batchSize: cfg.rooms[room.name]?.batchSize || cfg.defaultBatchSize,
      donorRoomNames: [],
    },
  };
}

function createAutoManagedRoomConfig(cfg: SynthesisControlConfig): SynthesisRoomConfig {
  return {
    enabled: true,
    batchSize: cfg.defaultBatchSize,
    maxRunsPerTick: cfg.defaultMaxRunsPerTick,
    donorRoomNames: [],
    reagentLabIds: [],
    reactions: [],
  };
}

function getRuntimeState(): SynthesisRuntimeState {
  const runtime = getMemoryService().ensureRuntime();
  runtime.synthesisControl = runtime.synthesisControl || {
    updatedAt: Game.time,
    generatedTaskCount: 0,
    failedTaskCount: 0,
    successfulRunCount: 0,
    lastActions: [],
    bindings: {},
    rooms: {},
  };

  runtime.synthesisControl.rooms = runtime.synthesisControl.rooms || {};
  runtime.synthesisControl.bindings = runtime.synthesisControl.bindings || {};
  return runtime.synthesisControl;
}

function roomResourceAmount(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }

  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_LAB ||
      structure.structureType === STRUCTURE_FACTORY ||
      structure.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of structures) {
    total += structure.store.getUsedCapacity(resource);
  }

  return total;
}

function roomTransferableAmount(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }
  return total;
}

function countInFlightSynthesisCargo(labId: string, resource: ResourceConstant): number {
  let total = 0;
  for (const creep of Object.values(Game.creeps)) {
    const state = getCreepAssignmentState(creep.name);
    if (!state) continue;
    if (state.synthesisCarrierPendingToId !== labId) continue;
    if (state.synthesisCarrierPendingResource !== resource) continue;
    const carried = creep.store.getUsedCapacity(resource);
    if (carried > 0) {
      total += carried;
    }
  }
  return total;
}

function getResourceReserve(roomName: string, resource: ResourceConstant): number {
  const roomCfg = Memory.cfg?.resourceControl?.rooms?.[roomName];
  if (resource === RESOURCE_ENERGY) {
    const energyTarget = roomCfg?.energyTarget;
    return typeof energyTarget === "number" && Number.isFinite(energyTarget)
      ? Math.max(0, Math.floor(energyTarget))
      : 200_000;
  }

  const floor = roomCfg?.mineralFloor?.[resource];
  return typeof floor === "number" && Number.isFinite(floor) ? Math.max(0, Math.floor(floor)) : 0;
}

function getBindingKey(targetRoomName: string, resource: ResourceConstant): string {
  return `${targetRoomName}:${resource}`;
}

function getActiveBinding(bindings: SynthesisBindingStore, targetRoomName: string, resource: ResourceConstant): SynthesisBinding | null {
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

function setBinding(bindings: SynthesisBindingStore, targetRoomName: string, resource: ResourceConstant, fromRoomName: string): void {
  const key = getBindingKey(targetRoomName, resource);
  bindings[key] = {
    fromRoomName,
    updatedAt: Game.time,
    expiresAt: Game.time + SYNTHESIS_BINDING_LEASE_TICKS,
  };
}

function selectDonor(
  targetRoom: Room,
  resource: ResourceConstant,
  amount: number,
  donorRoomNames: string[],
  bindings: SynthesisBindingStore,
): DonorCandidate | null {
  const binding = getActiveBinding(bindings, targetRoom.name, resource);
  const candidates: DonorCandidate[] = [];

  for (const room of getTickContextService().getMyRooms()) {
    if (room.name === targetRoom.name || !room.terminal || room.terminal.cooldown > 0) {
      continue;
    }
    if (donorRoomNames.length > 0 && !donorRoomNames.includes(room.name)) {
      continue;
    }

    const total = roomResourceAmount(room, resource);
    const reserve = getResourceReserve(room.name, resource);
    const outgoing = getOutgoingResourceTransferAmount(room.name, resource);
    const exportable = Math.max(0, total - reserve - outgoing);
    if (exportable <= 0) {
      continue;
    }

    const terminalAmount = room.terminal.store.getUsedCapacity(resource);
    const sendable = Math.min(exportable, terminalAmount);
    if (sendable < LAB_REACTION_AMOUNT) {
      continue;
    }

    const scoreAmount = Math.max(1, Math.min(amount, sendable));
    const transferCost = Game.market.calcTransactionCost(scoreAmount, room.name, targetRoom.name);
    const transferCostRatio = transferCost / scoreAmount;
    const queuePenalty = countPendingOutgoingResourceTransferTasksByRoom(room.name) * 0.6;
    const stickyBonus = binding?.fromRoomName === room.name ? SYNTHESIS_BINDING_STICKY_BONUS : 0;
    const score = sendable / scoreAmount - transferCostRatio * 6 - queuePenalty + stickyBonus;
    candidates.push({ room, sendable, score });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!binding) {
    return best;
  }

  const bound = candidates.find((candidate) => candidate.room.name === binding.fromRoomName);
  if (!bound) {
    return best;
  }

  if (best.score >= bound.score * SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO) {
    return best;
  }

  return bound;
}

function getConfiguredLab(room: Room, id: string): StructureLab | null {
  const candidate = Game.getObjectById(id as Id<StructureLab>);
  if (!candidate || candidate.room.name !== room.name || candidate.structureType !== STRUCTURE_LAB) {
    return null;
  }
  return candidate;
}

function resolveLabTopology(room: Room, roomCfg: SynthesisRoomConfig): LabTopology | null {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_LAB,
  }) as StructureLab[];
  if (labs.length < 3) {
    return null;
  }

  if (roomCfg.reagentLabIds.length === 2) {
    const first = getConfiguredLab(room, roomCfg.reagentLabIds[0]);
    const second = getConfiguredLab(room, roomCfg.reagentLabIds[1]);
    if (first && second) {
      const productLabs = labs.filter(
        (lab) =>
          lab.id !== first.id &&
          lab.id !== second.id &&
          lab.pos.inRangeTo(first.pos, 2) &&
          lab.pos.inRangeTo(second.pos, 2),
      );
      if (productLabs.length > 0) {
        return {
          reagentLabs: [first, second],
          productLabs,
        };
      }
    }
  }

  let best: LabTopology | null = null;
  for (let i = 0; i < labs.length; i += 1) {
    for (let j = i + 1; j < labs.length; j += 1) {
      const first = labs[i];
      const second = labs[j];
      const productLabs = labs.filter(
        (lab) =>
          lab.id !== first.id &&
          lab.id !== second.id &&
          lab.pos.inRangeTo(first.pos, 2) &&
          lab.pos.inRangeTo(second.pos, 2),
      );
      if (productLabs.length === 0) {
        continue;
      }

      if (!best || productLabs.length > best.productLabs.length) {
        best = {
          reagentLabs: [first, second],
          productLabs,
        };
      }
    }
  }

  return best;
}

function isLabContaminatedForExpected(lab: StructureLab, expectedMineral: ResourceConstant): boolean {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (!mineralType) {
    return false;
  }

  if (lab.store.getUsedCapacity(mineralType) <= 0) {
    return false;
  }

  return mineralType !== expectedMineral;
}

function isReagentReady(lab: StructureLab, reagent: ResourceConstant): boolean {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (mineralType && mineralType !== reagent) {
    return false;
  }

  return lab.store.getUsedCapacity(reagent) >= LAB_REACTION_AMOUNT;
}

function canAcceptProduct(lab: StructureLab, product: ResourceConstant): boolean {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (mineralType && mineralType !== product) {
    return false;
  }

  const used = mineralType ? lab.store.getUsedCapacity(mineralType) : 0;
  return used < LAB_MINERAL_CAPACITY;
}

function reagentAssignmentPenalty(lab: StructureLab, reagent: ResourceConstant): number {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (!mineralType) {
    return 0;
  }
  if (mineralType === reagent || lab.store.getUsedCapacity(mineralType) <= 0) {
    return 0;
  }
  return 100;
}

function orderReagentLabs(
  reagentLabs: [StructureLab, StructureLab],
  reagents: [ResourceConstant, ResourceConstant],
): [StructureLab, StructureLab] {
  const directPenalty =
    reagentAssignmentPenalty(reagentLabs[0], reagents[0]) +
    reagentAssignmentPenalty(reagentLabs[1], reagents[1]);
  const swappedPenalty =
    reagentAssignmentPenalty(reagentLabs[0], reagents[1]) +
    reagentAssignmentPenalty(reagentLabs[1], reagents[0]);

  if (swappedPenalty < directPenalty) {
    return [reagentLabs[1], reagentLabs[0]];
  }

  return reagentLabs;
}

function createRoomState(stage: SynthesisStage, lastTransitionAt: number): SynthesisRoomRuntimeState {
  return {
    stage,
    reagentLabIds: [],
    productLabIds: [],
    successfulRuns: 0,
    pendingTasks: 0,
    lastTransitionAt,
  };
}

function createCarrierTaskId(type: "lab_supply" | "lab_cleanup" | "lab_product_unload", roomName: string, product: ResourceConstant): string {
  return `synthesis:${type}:${roomName}:${product}`;
}

function createCarrierTaskStepId(resource: ResourceConstant, fromId: string, toId: string): string {
  return `${resource}:${fromId}->${toId}`;
}

function resolveCleanupTargetStructure(room: Room, resource: ResourceConstant): StructureTerminal | StructureStorage | null {
  if (room.terminal && room.terminal.store.getFreeCapacity(resource) > 0) {
    return room.terminal;
  }
  if (room.storage && room.storage.store.getFreeCapacity(resource) > 0) {
    return room.storage;
  }

  return null;
}

function resolveSupplySourceStructure(room: Room, resource: ResourceConstant): StructureTerminal | StructureStorage | null {
  const terminalAmount = room.terminal?.store.getUsedCapacity(resource) || 0;
  const storageAmount = room.storage?.store.getUsedCapacity(resource) || 0;
  if (terminalAmount <= 0 && storageAmount <= 0) {
    return null;
  }

  if (terminalAmount >= storageAmount && room.terminal && terminalAmount > 0) {
    return room.terminal;
  }
  if (room.storage && storageAmount > 0) {
    return room.storage;
  }

  return room.terminal && terminalAmount > 0 ? room.terminal : null;
}

function generateCleanupTask(
  room: Room,
  orderedReagentLabs: [StructureLab, StructureLab],
  productLabs: StructureLab[],
  reagents: [ResourceConstant, ResourceConstant],
  product: ResourceConstant,
): CarrierTaskDraft | null {
  const steps: CarrierTaskStep[] = [];
  const expectedByLab = new Map<string, ResourceConstant>([
    [orderedReagentLabs[0].id, reagents[0]],
    [orderedReagentLabs[1].id, reagents[1]],
  ]);
  for (const lab of productLabs) {
    expectedByLab.set(lab.id, product);
  }

  for (const [labId, expectedMineral] of expectedByLab.entries()) {
    const lab = Game.getObjectById(labId as Id<StructureLab>);
    if (!lab) {
      continue;
    }

    const mineralType = lab.mineralType as ResourceConstant | undefined;
    if (!mineralType || mineralType === expectedMineral) {
      continue;
    }

    const amount = lab.store.getUsedCapacity(mineralType);
    if (amount <= 0) {
      continue;
    }

    const target = resolveCleanupTargetStructure(room, mineralType);
    if (!target) {
      if (Memory.cfg.hub?.hubRoomName === room.name) {
        if (!Memory.runtime.hub) Memory.runtime.hub = {};
        Memory.runtime.hub.lastError = "lab_cleanup_destination_full";
      }
      continue;
    }

    steps.push({
      id: createCarrierTaskStepId(mineralType, lab.id, target.id),
      resource: mineralType,
      amount,
      fromKind: "lab",
      toKind: target.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    id: createCarrierTaskId("lab_cleanup", room.name, product),
    type: "lab_cleanup",
    priority: 200,
    steps,
  };
}

function resolveProductUnloadTargetStructure(room: Room, resource: ResourceConstant): StructureStorage | StructureTerminal | null {
  if (room.storage && room.storage.store.getFreeCapacity(resource) > 0) {
    return room.storage;
  }
  if (room.terminal && room.terminal.store.getFreeCapacity(resource) > 0) {
    return room.terminal;
  }
  return null;
}

function generateProductUnloadTask(
  room: Room,
  productLabs: StructureLab[],
  product: ResourceConstant,
  targetAmount: number,
): CarrierTaskDraft | null {
  const transferableCurrent = roomTransferableAmount(room, product);
  if (transferableCurrent >= targetAmount) {
    return null;
  }

  const steps: CarrierTaskStep[] = [];
  for (const lab of productLabs) {
    if (lab.mineralType !== product) {
      continue;
    }
    const amount = lab.store.getUsedCapacity(product);
    if (amount < 700) {
      continue;
    }

    const target = resolveProductUnloadTargetStructure(room, product);
    if (!target) {
      if (Memory.cfg.hub?.hubRoomName === room.name) {
        if (!Memory.runtime.hub) Memory.runtime.hub = {};
        Memory.runtime.hub.lastError = "lab_product_unload_destination_full";
      }
      continue;
    }

    steps.push({
      id: createCarrierTaskStepId(product, lab.id, target.id),
      resource: product,
      amount,
      fromKind: "lab",
      toKind: target.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    id: createCarrierTaskId("lab_product_unload", room.name, product),
    type: "lab_product_unload",
    priority: 180,
    steps,
  };
}

function generateStrandedProductUnloadTask(
  room: Room,
  productLabs: StructureLab[],
  roomCfg: SynthesisRoomConfig,
  autoPlan?: SynthesisReactionPlan | null,
): { task: CarrierTaskDraft; product: ResourceConstant; targetAmount?: number } | null {
  const steps: CarrierTaskStep[] = [];
  let firstDetectedMineral: ResourceConstant | undefined;

  for (const lab of productLabs) {
    const mineralType = lab.mineralType;
    if (!mineralType) continue;
    const amount = lab.store.getUsedCapacity(mineralType);
    if (amount < 700) continue;

    const target = resolveProductUnloadTargetStructure(room, mineralType);
    if (!target) continue;

    if (!firstDetectedMineral) {
      firstDetectedMineral = mineralType;
    }

    steps.push({
      id: createCarrierTaskStepId(mineralType, lab.id, target.id),
      resource: mineralType,
      amount,
      fromKind: "lab",
      toKind: target.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0 || !firstDetectedMineral) {
    return null;
  }

  const detectedProduct = firstDetectedMineral as ResourceConstant;

  // Derive targetAmount from matching reaction in roomCfg or autoPlan
  let targetAmount: number | undefined;
  const matchingReaction = roomCfg.reactions.find((r) => r.product === detectedProduct);
  if (matchingReaction) {
    targetAmount = matchingReaction.targetAmount;
  } else if (autoPlan && autoPlan.product === detectedProduct) {
    targetAmount = autoPlan.targetAmount;
  }

  return {
    task: {
      id: createCarrierTaskId("lab_product_unload", room.name, detectedProduct),
      type: "lab_product_unload",
      priority: 180,
      steps,
    },
    product: detectedProduct,
    targetAmount,
  };
}

function generateReagentCleanupTask(
  room: Room,
  allLabs: StructureLab[],
): CarrierTaskDraft | null {
  const steps: CarrierTaskStep[] = [];

  for (const lab of allLabs) {
    const mineralType = lab.mineralType;
    if (!mineralType) continue;
    const amount = lab.store.getUsedCapacity(mineralType);
    if (amount <= 0) continue;

    const target = resolveProductUnloadTargetStructure(room, mineralType);
    if (!target) continue;

    steps.push({
      id: createCarrierTaskStepId(mineralType, lab.id, target.id),
      resource: mineralType,
      amount,
      fromKind: "lab",
      toKind: target.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0) return null;

  return {
    id: `synthesis:lab_cleanup:${room.name}:reagent-residue`,
    type: "lab_cleanup",
    priority: 190,
    steps,
  };
}

function generateSupplyTask(
  room: Room,
  orderedReagentLabs: [StructureLab, StructureLab],
  reagents: [ResourceConstant, ResourceConstant],
  batchSize: number,
  product: ResourceConstant,
  targetAmount: number,
): CarrierTaskDraft | null {
  const steps: CarrierTaskStep[] = [];
  const productDeficit = Math.max(0, targetAmount - roomResourceAmount(room, product));
  const deficitBoundedAmount = productDeficit > 0 ? roundUpReactionAmount(productDeficit) : 0;
  const desiredLabAmount = productDeficit > 0
    ? Math.min(LAB_MINERAL_CAPACITY, batchSize, deficitBoundedAmount)
    : Math.min(LAB_MINERAL_CAPACITY, Math.max(LAB_REACTION_AMOUNT, batchSize));

  for (let index = 0; index < orderedReagentLabs.length; index += 1) {
    const lab = orderedReagentLabs[index];
    const reagent = reagents[index];
    const mineralType = lab.mineralType as ResourceConstant | undefined;
    if (mineralType && mineralType !== reagent && lab.store.getUsedCapacity(mineralType) > 0) {
      continue;
    }

    const currentAmount = mineralType === reagent ? lab.store.getUsedCapacity(reagent) : 0;
    const inFlightAmount = countInFlightSynthesisCargo(lab.id, reagent);
    const effectiveCurrentAmount = currentAmount + inFlightAmount;
    if (effectiveCurrentAmount > 2200) continue;
    const deficit = Math.max(0, desiredLabAmount - effectiveCurrentAmount);
    const isPartialTopUp = deficit > 0 && deficit < LAB_REACTION_AMOUNT
      && desiredLabAmount >= LAB_REACTION_AMOUNT
      && effectiveCurrentAmount > 0;
    if (deficit < LAB_REACTION_AMOUNT && !isPartialTopUp) {
      continue;
    }

    const source = resolveSupplySourceStructure(room, reagent);
    if (!source) {
      continue;
    }

    const available = source.store.getUsedCapacity(reagent);
    const amount = Math.min(deficit, available);
    const isAmountPartialTopUp = amount > 0 && amount < LAB_REACTION_AMOUNT
      && desiredLabAmount >= LAB_REACTION_AMOUNT
      && effectiveCurrentAmount > 0;
    if (amount < LAB_REACTION_AMOUNT && !isAmountPartialTopUp) {
      continue;
    }

    steps.push({
      id: createCarrierTaskStepId(reagent, source.id, lab.id),
      resource: reagent,
      amount,
      fromKind: source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
      toKind: "lab",
      fromId: source.id,
      toId: lab.id,
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    id: createCarrierTaskId("lab_supply", room.name, product),
    type: "lab_supply",
    priority: 100,
    steps,
  };
}

function chooseActivePlan(room: Room, roomCfg: SynthesisRoomConfig, autoPlan?: SynthesisReactionPlan | null): SynthesisReactionPlan | null {
  for (const plan of roomCfg.reactions) {
    const current = roomResourceAmount(room, plan.product);
    if (current < plan.targetAmount) {
      return plan;
    }
  }

  if (autoPlan) {
    const current = roomResourceAmount(room, autoPlan.product);
    if (current < autoPlan.targetAmount) {
      return autoPlan;
    }
  }

  return null;
}

function mergeDonorPriority(roomCfg: SynthesisRoomConfig, reactionPlan: SynthesisReactionPlan): string[] {
  if (reactionPlan.donorRoomNames.length > 0) {
    return reactionPlan.donorRoomNames;
  }

  return roomCfg.donorRoomNames;
}

function countPendingToRoom(roomName: string): number {
  return countPendingIncomingResourceTransferTasksByRoom(roomName);
}

function maybeGenerateSupplyTasks(
  room: Room,
  roomCfg: SynthesisRoomConfig,
  reactionPlan: SynthesisReactionPlan,
  reagents: [ResourceConstant, ResourceConstant],
  topology: LabTopology,
  runtime: SynthesisRuntimeState,
  actions: string[],
): { generated: number; failed: number; missing: Partial<Record<ResourceConstant, number>> } {
  const missing: Partial<Record<ResourceConstant, number>> = {};
  let generated = 0;
  let failed = 0;
  const mergedDonors = mergeDonorPriority(roomCfg, reactionPlan);

  const reagentNeedMap = new Map<ResourceConstant, number>();
  for (const reagent of reagents) {
    reagentNeedMap.set(reagent, (reagentNeedMap.get(reagent) || 0) + reactionPlan.batchSize);
  }

  for (const [reagent, needAmount] of reagentNeedMap.entries()) {
    const bufferedInLabs = topology.reagentLabs.reduce((sum, lab) => {
      const mineralType = lab.mineralType as ResourceConstant | undefined;
      if (!mineralType || mineralType !== reagent) {
        return sum;
      }

      return sum + lab.store.getUsedCapacity(reagent);
    }, 0);
    const current = roomTransferableAmount(room, reagent) + bufferedInLabs;
    const incoming = getIncomingResourceTransferAmount(room.name, reagent);
    const deficit = Math.max(0, needAmount - current - incoming);
    if (deficit <= 0) {
      continue;
    }

    missing[reagent] = deficit;
    const donor = selectDonor(room, reagent, deficit, mergedDonors, runtime.bindings);
    if (!donor) {
      failed += 1;
      actions.push(`synthesis-task-failed:${room.name}:${reagent}:no_donor`);
      continue;
    }

    const amount = Math.min(deficit, donor.sendable, reactionPlan.batchSize);
    if (amount < LAB_REACTION_AMOUNT) {
      failed += 1;
      actions.push(`synthesis-task-failed:${room.name}:${reagent}:amount_too_small`);
      continue;
    }

    const task = createResourceTransferTask(
      donor.room.name,
      room.name,
      reagent,
      amount,
      `synthesis:${room.name}:${reactionPlan.product}`,
    );
    if (typeof task === "string") {
      failed += 1;
      actions.push(`synthesis-task-failed:${room.name}:${reagent}:${task}`);
      continue;
    }

    setBinding(runtime.bindings, room.name, reagent, donor.room.name);
    generated += 1;
    actions.push(`synthesis-task-generated:${task.task.id}:${reagent}=${amount}:${donor.room.name}->${room.name}`);
  }

  return {
    generated,
    failed,
    missing,
  };
}

function handleRoom(
  roomName: string,
  roomCfg: SynthesisRoomConfig,
  planningTick: boolean,
  runtime: SynthesisRuntimeState,
  actions: string[],
  autoPlan?: SynthesisReactionPlan | null,
): { generated: number; failed: number; runs: number } {
  let generated = 0;
  let failed = 0;
  let runs = 0;

  const roomState = runtime.rooms[roomName] || createRoomState("idle", Game.time);
  runtime.rooms[roomName] = roomState;

  if (!roomCfg.enabled) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      cleanupTasks: undefined,
      lastError: "room_config_disabled",
      lastTransitionAt: Game.time,
    };
    return { generated, failed, runs };
  }

  const room = Game.rooms[roomName];
  if (!room?.controller?.my || !room.terminal) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      cleanupTasks: undefined,
      lastError: "room_or_terminal_unavailable",
      lastTransitionAt: Game.time,
    };
    return { generated, failed, runs };
  }

  const topology = resolveLabTopology(room, roomCfg);
  if (!topology) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      lastError: "lab_topology_unavailable",
      lastTransitionAt: Game.time,
      reagentLabIds: [],
      productLabIds: [],
      cleanupTasks: undefined,
    };
    return { generated, failed, runs };
  }

  const activePlan = chooseActivePlan(room, roomCfg, autoPlan);
  if (!activePlan) {
    const unloadProduct = roomState.activeProduct as ResourceConstant | undefined;
    const unloadTarget = roomState.targetAmount as number | undefined;
    let productUnloadTask = unloadProduct && unloadTarget
      ? generateProductUnloadTask(room, topology.productLabs, unloadProduct, unloadTarget)
      : null;

    let strandedResult: ReturnType<typeof generateStrandedProductUnloadTask> = null;
    if (!productUnloadTask && (!unloadProduct || !unloadTarget)) {
      strandedResult = generateStrandedProductUnloadTask(room, topology.productLabs, roomCfg, autoPlan);
      if (strandedResult) {
        productUnloadTask = strandedResult.task;
      }
    }

    let reagentCleanupTask: CarrierTaskDraft | null = null;
    if (!productUnloadTask) {
      const allLabs = [...topology.reagentLabs, ...topology.productLabs];
      reagentCleanupTask = generateReagentCleanupTask(room, allLabs);
    }

    const allTasks = [
      ...(productUnloadTask ? [productUnloadTask] : []),
      ...(reagentCleanupTask ? [reagentCleanupTask] : []),
    ];
    replaceCarrierTasksForProducerRoom(
      SYNTHESIS_CARRIER_TASK_PRODUCER,
      roomName,
      allTasks,
    );

    const hasAnyCleanup = productUnloadTask || reagentCleanupTask;
    runtime.rooms[roomName] = {
      ...roomState,
      stage: hasAnyCleanup ? "unloading" : "idle",
      activeProduct: hasAnyCleanup
        ? (strandedResult ? strandedResult.product : unloadProduct ?? undefined)
        : undefined,
      reagentA: undefined,
      reagentB: undefined,
      targetAmount: hasAnyCleanup
        ? (strandedResult ? strandedResult.targetAmount ?? unloadTarget : unloadTarget) ?? undefined
        : undefined,
      batchSize: undefined,
      missing: undefined,
      cleanupTasks: undefined,
      lastError: undefined,
      pendingTasks: countPendingToRoom(roomName),
      reagentLabIds: topology.reagentLabs.map((lab) => lab.id),
      productLabIds: topology.productLabs.map((lab) => lab.id),
    };

    if (!hasAnyCleanup && roomState.stage === "unloading" && Memory.cfg.hub?.hubRoomName === room.name) {
      if (!Memory.runtime.hub) {
        Memory.runtime.hub = { needsPlan: true, updatedAt: Game.time };
      } else {
        Memory.runtime.hub.needsPlan = true;
      }
    }

    // Signal hub planner when an actively synthesizing room runs out of reactions.
    // Do NOT signal during product-unload (stage="unloading"): hubPlanner uses
    // storage+terminal inventory, which hasn't changed yet — signalling would
    // cause an infinite needsPlan loop (hub rewrites same step every tick).
    if (roomState.stage !== "idle" && roomState.stage !== "unloading" && Memory.cfg.hub?.hubRoomName === room.name) {
      if (!Memory.runtime.hub) {
        Memory.runtime.hub = { needsPlan: true, updatedAt: Game.time };
      } else {
        Memory.runtime.hub.needsPlan = true;
      }
    }

    return { generated, failed, runs };
  }

  const reagents = resolveReagents(activePlan.product);
  if (!reagents) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      activeProduct: activePlan.product,
      targetAmount: activePlan.targetAmount,
      batchSize: activePlan.batchSize,
      cleanupTasks: undefined,
      lastError: "invalid_reaction_product",
      pendingTasks: countPendingToRoom(roomName),
      reagentLabIds: topology.reagentLabs.map((lab) => lab.id),
      productLabIds: topology.productLabs.map((lab) => lab.id),
      lastTransitionAt: Game.time,
    };
    return { generated, failed, runs };
  }

  let stage = roomState.stage;
  if (
    roomState.activeProduct !== activePlan.product ||
    roomState.batchSize !== activePlan.batchSize ||
    roomState.targetAmount !== activePlan.targetAmount
  ) {
    stage = "acquiring";
    roomState.lastTransitionAt = Game.time;
  }

  if (stage === "idle" || stage === "blocked") {
    stage = "acquiring";
    roomState.lastTransitionAt = Game.time;
  }

  const orderedReagentLabs = orderReagentLabs(topology.reagentLabs, reagents);
  const hasContamination =
    isLabContaminatedForExpected(orderedReagentLabs[0], reagents[0]) ||
    isLabContaminatedForExpected(orderedReagentLabs[1], reagents[1]) ||
    topology.productLabs.some((lab) => isLabContaminatedForExpected(lab, activePlan.product));
  const cleanupTask = hasContamination
    ? generateCleanupTask(room, orderedReagentLabs, topology.productLabs, reagents, activePlan.product)
    : null;
  const supplyTask = hasContamination
    ? null
    : generateSupplyTask(room, orderedReagentLabs, reagents, activePlan.batchSize, activePlan.product, activePlan.targetAmount);
  // Only generate product unload when NOT actively synthesizing.
  // During synthesis the product lab accumulates; unload after batch completes.
  const productUnloadTask = !hasContamination && stage !== "synthesizing" && stage !== "acquiring" && stage !== "loading"
    ? generateProductUnloadTask(room, topology.productLabs, activePlan.product, activePlan.targetAmount)
    : null;
  const prevProductUnloadTask = roomState.activeProduct && roomState.activeProduct !== activePlan.product && roomState.targetAmount
    ? generateProductUnloadTask(room, topology.productLabs, roomState.activeProduct as ResourceConstant, roomState.targetAmount as number)
    : null;
  const boardTasks = hasContamination
    ? [...(cleanupTask ? [cleanupTask] : []), ...(prevProductUnloadTask ? [prevProductUnloadTask] : [])]
    : [...(supplyTask ? [supplyTask] : []), ...(productUnloadTask ? [productUnloadTask] : []), ...(prevProductUnloadTask ? [prevProductUnloadTask] : [])];
  replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, boardTasks);
  const cleanupTaskView = (cleanupTask?.steps || []).map((step) => ({
    labId: step.fromId,
    resource: step.resource,
    amount: step.amount,
    target: (step.toKind === "terminal" ? "terminal" : "storage") as "terminal" | "storage",
  }));

  if (hasContamination && stage !== "unloading") {
    stage = "unloading";
    roomState.lastTransitionAt = Game.time;
  }

  if (planningTick && (stage === "acquiring" || stage === "loading")) {
    const taskResult = maybeGenerateSupplyTasks(room, roomCfg, activePlan, reagents, topology, runtime, actions);
    generated += taskResult.generated;
    failed += taskResult.failed;
    roomState.missing = taskResult.missing;
  }

  const reagentReady =
    isReagentReady(orderedReagentLabs[0], reagents[0]) &&
    isReagentReady(orderedReagentLabs[1], reagents[1]);
  const productLabAvailable = topology.productLabs.some((lab) => canAcceptProduct(lab, activePlan.product));

  if (stage === "acquiring" && reagentReady && productLabAvailable && !hasContamination) {
    stage = "synthesizing";
    roomState.lastTransitionAt = Game.time;
  } else if (stage === "loading" && reagentReady && productLabAvailable && !hasContamination) {
    stage = "synthesizing";
    roomState.lastTransitionAt = Game.time;
  } else if (stage === "synthesizing" && hasContamination) {
    stage = "unloading";
    roomState.lastTransitionAt = Game.time;
  } else if (stage === "unloading" && !hasContamination) {
    stage = "loading";
    roomState.lastTransitionAt = Game.time;
  }

  if (stage === "synthesizing") {
    let roomRuns = 0;
    for (const lab of topology.productLabs) {
      if (roomRuns >= roomCfg.maxRunsPerTick) {
        break;
      }
      if (lab.cooldown > 0 || !canAcceptProduct(lab, activePlan.product)) {
        continue;
      }

      const code = lab.runReaction(orderedReagentLabs[0], orderedReagentLabs[1]);
      if (code === OK) {
        recordFixedCpuAction("synthesisControl");
        roomRuns += 1;
      } else if (code === ERR_NOT_ENOUGH_RESOURCES || code === ERR_INVALID_ARGS) {
        stage = hasContamination ? "unloading" : "loading";
      }
    }

    if (roomRuns > 0) {
      runs += roomRuns;
      actions.push(`synthesis-runs:${room.name}:${activePlan.product}:count=${roomRuns}`);
    }
  }

  const productCurrent = roomResourceAmount(room, activePlan.product);
  if (productCurrent >= activePlan.targetAmount && !hasContamination) {
    stage = "idle";
    roomState.lastTransitionAt = Game.time;

    // Signal hub planner to plan next step immediately
    if (Memory.cfg.hub?.hubRoomName === room.name) {
      if (!Memory.runtime.hub) {
        Memory.runtime.hub = { needsPlan: true, updatedAt: Game.time };
      } else {
        Memory.runtime.hub.needsPlan = true;
      }
    }
  } else if (!reagentReady && !hasContamination) {
    stage = "loading";
  }

  runtime.rooms[roomName] = {
    ...roomState,
    stage,
    activeProduct: activePlan.product,
    reagentA: reagents[0],
    reagentB: reagents[1],
    targetAmount: activePlan.targetAmount,
    batchSize: activePlan.batchSize,
    pendingTasks: countPendingToRoom(roomName),
    reagentLabIds: orderedReagentLabs.map((lab) => lab.id),
    productLabIds: topology.productLabs.map((lab) => lab.id),
    successfulRuns: (roomState.successfulRuns || 0) + runs,
    lastError: stage === "unloading" ? "lab_contaminated_waiting_clear" : undefined,
    missing: roomState.missing,
    cleanupTasks: stage === "unloading" ? cleanupTaskView : undefined,
  };

  return { generated, failed, runs };
}

export function runSynthesisControl(): void {
  const runtime = getRuntimeState();
  const cfg = normalizeConfig();
  const actions: string[] = [];

  if (!cfg.enabled) {
    pruneCarrierTasksForProducer(SYNTHESIS_CARRIER_TASK_PRODUCER, new Set());
    const compatibilityActions = runSynthesisTaskPlanningCompatibility();
    if (!compatibilityActions) {
      return;
    }

    runtime.updatedAt = Game.time;
    runtime.generatedTaskCount = compatibilityActions.filter((action) => action.startsWith("task-generated:")).length;
    runtime.failedTaskCount = compatibilityActions.filter((action) => action.startsWith("task-generate-failed:")).length;
    runtime.successfulRunCount = 0;
    runtime.lastActions = limitActionLog(compatibilityActions);
    return;
  }

  const planningTick = Game.time % cfg.sampleInterval === 0;
  const autoOhPlan = getAutoOhPlan(cfg);
  const roomEntries = new Map(Object.entries(cfg.rooms));
  if (autoOhPlan && !roomEntries.has(autoOhPlan.roomName)) {
    roomEntries.set(autoOhPlan.roomName, createAutoManagedRoomConfig(cfg));
  }
  const configuredRoomNames = new Set(roomEntries.keys());
  runtime.generatedTaskCount = 0;
  runtime.failedTaskCount = 0;
  runtime.successfulRunCount = 0;
  runtime.autoOhTarget = autoOhPlan?.targetAmount;
  runtime.autoOhCurrent = autoOhPlan?.currentAmount;
  runtime.autoOhProducerRoomName = autoOhPlan?.roomName;

  for (const [roomName, roomCfg] of roomEntries.entries()) {
    const result = handleRoom(
      roomName,
      roomCfg,
      planningTick,
      runtime,
      actions,
      autoOhPlan?.roomName === roomName ? autoOhPlan.plan : null,
    );
    runtime.generatedTaskCount += result.generated;
    runtime.failedTaskCount += result.failed;
    runtime.successfulRunCount += result.runs;
  }
  pruneCarrierTasksForProducer(SYNTHESIS_CARRIER_TASK_PRODUCER, configuredRoomNames);

  runtime.updatedAt = Game.time;
  runtime.lastActions = limitActionLog(actions);
}
