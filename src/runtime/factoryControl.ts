/**
 * Factory target queue planning, surplus checks, and production state machine.
 *
 * Normalizes config, enumerates eligible rooms, resolves the target queue with
 * recursive COMMODITIES decomposition, then drives the production lifecycle:
 * publishes factory_supply / factory_unload carrier tasks, calls
 * factory.produce() when gated conditions are met, and tracks stage transitions.
 * Market deals are NOT handled here.
 */

import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import { getReservedProductionAmountExcludingHolder } from "@/runtime/resourceReservation";
import {
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import {
  createSingleStepDraft,
  terminalStorageKind,
} from "@/runtime/carrierTaskHelpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FactoryStage =
  | "idle"
  | "acquiring"
  | "loading"
  | "producing"
  | "unloading"
  | "blocked"
  | "sleeping";

interface TargetEntry {
  resource: ResourceConstant;
  targetAmount: number;
  cap: number;
}

interface RoomPlanConfig {
  enabled: boolean;
  targetQueue: TargetEntry[];
  resourceFloors: Partial<Record<ResourceConstant, number>>;
  productionCaps: Partial<Record<ResourceConstant, number>>;
  sleepTicks: number;
}

interface FactoryControlConfig {
  enabled: boolean;
  terminalEnergyReserve: number;
  targetQueue: TargetEntry[];
  resourceFloors: Partial<Record<ResourceConstant, number>>;
  productionCaps: Partial<Record<ResourceConstant, number>>;
  sleepSettings: {
    cooldownOnError: number;
    cooldownOnMissing: number;
    maxSleepTicks: number;
  };
  rooms: Record<string, RoomPlanConfig>;
}

interface RoomRuntimeState {
  stage: FactoryStage;
  activeTarget?: ResourceConstant;
  missing?: Partial<Record<ResourceConstant, number>>;
  sleepReason?: string;
  sleepUntilTick?: number;
  lastError?: string;
  lastTransitionAt: number;
  loadingSinceTick?: number;
}

interface FactoryControlRuntime {
  updatedAt?: number;
  rooms: Record<string, RoomRuntimeState>;
  claimedOrders?: Array<{
    orderId: string;
    roomName: string;
    tick: number;
    purpose: "sell" | "buy";
  }>;
}

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

function normalizeTargetEntries(
  raw: unknown,
): TargetEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: TargetEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) {
      entries.push({
        resource: item as ResourceConstant,
        targetAmount: 0,
        cap: 0,
      });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const resource = rec.resource;
    if (typeof resource !== "string" || resource.length === 0) continue;

    entries.push({
      resource: resource as ResourceConstant,
      targetAmount:
        typeof rec.targetAmount === "number" && Number.isFinite(rec.targetAmount) && rec.targetAmount > 0
          ? Math.floor(rec.targetAmount)
          : 0,
      cap:
        typeof rec.cap === "number" && Number.isFinite(rec.cap) && rec.cap > 0
          ? Math.floor(rec.cap)
          : 0,
    });
  }
  return entries;
}

function normalizeResourceMap(raw: unknown): Partial<Record<ResourceConstant, number>> {
  if (!raw || typeof raw !== "object") return {};
  const result: Partial<Record<ResourceConstant, number>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      result[key as ResourceConstant] = Math.floor(val);
    }
  }
  return result;
}

function normalizeSleepSettings(raw: unknown): FactoryControlConfig["sleepSettings"] {
  if (!raw || typeof raw !== "object") {
    return { cooldownOnError: 20, cooldownOnMissing: 10, maxSleepTicks: 500 };
  }
  const s = raw as Record<string, unknown>;
  return {
    cooldownOnError: normalizeNumber(s.cooldownOnError, 20, 1, 1000),
    cooldownOnMissing: normalizeNumber(s.cooldownOnMissing, 10, 1, 1000),
    maxSleepTicks: normalizeNumber(s.maxSleepTicks, 500, 1, 10000),
  };
}

function parseConfig(): FactoryControlConfig {
  const raw = Memory.cfg?.factoryControl;
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      terminalEnergyReserve: 0,
      targetQueue: [],
      resourceFloors: {},
      productionCaps: {},
      sleepSettings: { cooldownOnError: 20, cooldownOnMissing: 10, maxSleepTicks: 500 },
      rooms: {},
    };
  }

  const rooms: Record<string, RoomPlanConfig> = {};
  const rawRooms = raw.rooms;
  if (rawRooms && typeof rawRooms === "object") {
    for (const [roomName, roomCfg] of Object.entries(rawRooms)) {
      if (!roomCfg || typeof roomCfg !== "object") continue;
      const rc = roomCfg as Record<string, unknown>;

      rooms[roomName] = {
        enabled: normalizeBoolean(rc.enabled, true),
        targetQueue: normalizeTargetEntries(rc.targetQueue ?? rc.targets),
        resourceFloors: normalizeResourceMap(rc.resourceFloors),
        productionCaps: normalizeResourceMap(rc.productionCaps),
        sleepTicks: normalizeNumber(rc.sleepTicks, 0, 0, 10000),
      };
    }
  }

  return {
    enabled: normalizeBoolean(raw.enabled, false),
    terminalEnergyReserve: normalizeNumber(raw.terminalEnergyReserve, 0, 0, 500000),
    targetQueue: normalizeTargetEntries(raw.targetQueue ?? raw.targets),
    resourceFloors: normalizeResourceMap(raw.resourceFloors),
    productionCaps: normalizeResourceMap(raw.productionCaps),
    sleepSettings: normalizeSleepSettings(raw.sleepSettings),
    rooms,
  };
}

// ---------------------------------------------------------------------------
// Room eligibility
// ---------------------------------------------------------------------------

function findFactoryInRoom(room: Room): StructureFactory | null {
  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: (s: Structure) => s.structureType === STRUCTURE_FACTORY,
  });
  return (structures[0] as StructureFactory | undefined) ?? null;
}

function isEligibleRoom(room: Room): boolean {
  if (!room.controller?.my) return false;
  if (!room.terminal) return false;
  const factory = findFactoryInRoom(room);
  return factory !== null;
}

// ---------------------------------------------------------------------------
// Resource stock helpers
// ---------------------------------------------------------------------------

function getRoomStock(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource) ?? 0;
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource) ?? 0;
  }
  const factory = findFactoryInRoom(room);
  if (factory) {
    total += factory.store.getUsedCapacity(resource) ?? 0;
  }
  return total;
}

function computeSurplus(
  room: Room,
  resource: ResourceConstant,
  floor: number,
  holderId: string,
): number {
  const stock = getRoomStock(room, resource);
  const reserved = getReservedProductionAmountExcludingHolder(room.name, resource, holderId);
  return Math.max(0, stock - floor - reserved);
}

// ---------------------------------------------------------------------------
// COMMODITIES decomposition
// ---------------------------------------------------------------------------

interface CommodityRecipe {
  amount: number;
  cooldown: number;
  level?: number;
  components: Partial<Record<ResourceConstant, number>>;
}

/**
 * Base resources that cannot be factory-produced (minerals, deposit resources,
 * energy, power). These terminate decomposition and appear in `missing`.
 */
const BASE_RESOURCES: Set<string> = new Set([
  "energy", "power",
  "H", "O", "U", "K", "L", "Z", "X", "G",
  "silicon", "biomass", "metal", "mist",
]);

const FACTORY_CARRIER_TASK_PRODUCER = "factoryControl";

function getCommodityRecipe(resource: ResourceConstant): CommodityRecipe | null {
  if (typeof COMMODITIES === "undefined") return null;
  const entry = (COMMODITIES as Record<string, CommodityRecipe>)[resource];
  if (!entry) return null;
  return entry;
}

function isProducible(resource: ResourceConstant): boolean {
  if (BASE_RESOURCES.has(resource)) return false;
  return getCommodityRecipe(resource) !== null;
}

function getRequiredFactoryLevel(resource: ResourceConstant): number {
  const recipe = getCommodityRecipe(resource);
  return recipe?.level ?? 0;
}

/**
 * Recursively walk COMMODITIES tree for a target product.
 * Returns the list of resources to produce in dependency order,
 * starting from the deepest missing component.
 *
 * If all components are available in sufficient surplus (above floors/reservations),
 * returns the original target. Otherwise returns the first missing producible component.
 * Base resources (not in COMMODITIES) that are missing are added to `missing`.
 */
interface DecompositionResult {
  /** The resource we should plan to produce (target or missing sub-component). */
  productionTarget: ResourceConstant;
  /** Base/producible resources that are missing and cannot be produced by factory. */
  missing: Partial<Record<ResourceConstant, number>>;
  /** Factory level required for the production target. */
  requiredLevel: number;
}

function decomposeTarget(
  targetResource: ResourceConstant,
  targetAmount: number,
  room: Room,
  resourceFloors: Partial<Record<ResourceConstant, number>>,
  holderId: string,
  visited: Set<ResourceConstant> = new Set(),
): DecompositionResult {
  // Guard against cycles
  if (visited.has(targetResource)) {
    return {
      productionTarget: targetResource,
      missing: {},
      requiredLevel: getRequiredFactoryLevel(targetResource),
    };
  }
  visited.add(targetResource);

  const recipe = getCommodityRecipe(targetResource);
  if (!recipe) {
    // Not a producible commodity — it's a base resource, report as missing
    return {
      productionTarget: targetResource,
      missing: { [targetResource]: targetAmount },
      requiredLevel: 0,
    };
  }

  const requiredLevel = recipe.level ?? 0;
  const components = recipe.components;

  // Check if we have enough surplus of each component
  const missing: Partial<Record<ResourceConstant, number>> = {};
  const missingProducible: Array<{ resource: ResourceConstant; needed: number }> = [];

  for (const [component, amountNeeded] of Object.entries(components)) {
    if (!amountNeeded || amountNeeded <= 0) continue;
    const comp = component as ResourceConstant;
    const floor = resourceFloors[comp] ?? 0;
    const surplus = computeSurplus(room, comp, floor, holderId);

    // Calculate total needed for the target amount
    const batchesNeeded = Math.ceil(targetAmount / recipe.amount);
    const totalNeeded = amountNeeded * batchesNeeded;

    if (surplus < totalNeeded) {
      const deficit = totalNeeded - surplus;
      if (isProducible(comp) && !BASE_RESOURCES.has(comp)) {
        missingProducible.push({ resource: comp, needed: deficit });
      } else {
        // Base or non-producible resource — report as missing
        missing[comp] = (missing[comp] ?? 0) + deficit;
      }
    }
  }

  // If we have missing producible components, recurse into the first one
  if (missingProducible.length > 0) {
    const firstMissing = missingProducible[0];
    const subResult = decomposeTarget(
      firstMissing.resource,
      firstMissing.needed,
      room,
      resourceFloors,
      holderId,
      new Set(visited),
    );

    // Merge missing from sub-result
    for (const [res, amt] of Object.entries(subResult.missing)) {
      if (amt && amt > 0) {
        missing[res as ResourceConstant] = (missing[res as ResourceConstant] ?? 0) + amt;
      }
    }

    return {
      productionTarget: subResult.productionTarget,
      missing,
      requiredLevel: subResult.requiredLevel,
    };
  }

  return {
    productionTarget: targetResource,
    missing,
    requiredLevel,
  };
}

// ---------------------------------------------------------------------------
// Target queue planning
// ---------------------------------------------------------------------------

function resolveTargetQueue(
  config: FactoryControlConfig,
  roomName: string,
): TargetEntry[] {
  const roomCfg = config.rooms[roomName];
  if (roomCfg && roomCfg.targetQueue.length > 0) {
    return roomCfg.targetQueue;
  }
  return config.targetQueue;
}

function resolveResourceFloors(
  config: FactoryControlConfig,
  roomName: string,
): Partial<Record<ResourceConstant, number>> {
  const roomCfg = config.rooms[roomName];
  if (roomCfg && Object.keys(roomCfg.resourceFloors).length > 0) {
    return roomCfg.resourceFloors;
  }
  return config.resourceFloors;
}

function resolveProductionCaps(
  config: FactoryControlConfig,
  roomName: string,
): Partial<Record<ResourceConstant, number>> {
  const roomCfg = config.rooms[roomName];
  if (roomCfg && Object.keys(roomCfg.productionCaps).length > 0) {
    return roomCfg.productionCaps;
  }
  return config.productionCaps;
}

// ---------------------------------------------------------------------------
// Runtime state helpers
// ---------------------------------------------------------------------------

function ensureRuntimeState(): FactoryControlRuntime {
  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  if (!Memory.runtime.factoryControl) {
    Memory.runtime.factoryControl = {
      updatedAt: 0,
      rooms: {},
      claimedOrders: [],
    };
  }
  return Memory.runtime.factoryControl as unknown as FactoryControlRuntime;
}

function getRoomState(runtime: FactoryControlRuntime, roomName: string): RoomRuntimeState {
  if (!runtime.rooms[roomName]) {
    runtime.rooms[roomName] = {
      stage: "idle",
      lastTransitionAt: Game.time,
    };
  }
  return runtime.rooms[roomName];
}

function resolveSupplySourceStructure(
  room: Room,
  resource: ResourceConstant,
): StructureTerminal | StructureStorage | null {
  const terminalAmount = room.terminal?.store.getUsedCapacity(resource) ?? 0;
  const storageAmount = room.storage?.store.getUsedCapacity(resource) ?? 0;
  if (terminalAmount <= 0 && storageAmount <= 0) return null;
  if (terminalAmount >= storageAmount && room.terminal && terminalAmount > 0) {
    return room.terminal;
  }
  if (room.storage && storageAmount > 0) {
    return room.storage;
  }
  return room.terminal && terminalAmount > 0 ? room.terminal : null;
}

function generateFactorySupplyDrafts(
  room: Room,
  factory: StructureFactory,
  recipe: CommodityRecipe,
  roomName: string,
): CarrierTaskDraft[] {
  const drafts: CarrierTaskDraft[] = [];
  for (const [component, neededPerBatch] of Object.entries(recipe.components)) {
    if (!neededPerBatch || neededPerBatch <= 0) continue;
    const comp = component as ResourceConstant;

    const inFactory = factory.store.getUsedCapacity(comp) ?? 0;
    if (inFactory >= neededPerBatch) continue;

    const deficit = neededPerBatch - inFactory;
    const source = resolveSupplySourceStructure(room, comp);
    if (!source) continue;

    const sourceAmount = source.store.getUsedCapacity(comp) ?? 0;
    if (sourceAmount <= 0) continue;

    const fromKind = source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage";

    drafts.push(createSingleStepDraft({
      taskId: `factoryControl:factory_supply:${roomName}:${comp}`,
      type: "factory_supply",
      priority: 100,
      producer: FACTORY_CARRIER_TASK_PRODUCER,
      roomName,
      resource: comp,
      fromKind,
      toKind: "factory",
      fromId: source.id,
      toId: factory.id,
      amount: Math.min(deficit, sourceAmount),
    }));
  }
  return drafts;
}

function resolveFactoryUnloadTarget(
  room: Room,
  product: ResourceConstant,
): StructureTerminal | StructureStorage | null {
  if (room.terminal && room.terminal.store.getFreeCapacity(product) > 0) {
    return room.terminal;
  }
  const isLowRisk = product === RESOURCE_ENERGY || product === RESOURCE_BATTERY;
  if (isLowRisk && room.storage && room.storage.store.getFreeCapacity(product) > 0) {
    return room.storage;
  }
  return null;
}

function generateFactoryUnloadDraft(
  room: Room,
  factory: StructureFactory,
  product: ResourceConstant,
  roomName: string,
): CarrierTaskDraft | null {
  const productAmount = factory.store.getUsedCapacity(product) ?? 0;
  if (productAmount <= 0) return null;

  const target = resolveFactoryUnloadTarget(room, product);
  if (!target) return null;

  const toKind = terminalStorageKind(target);

  return createSingleStepDraft({
    taskId: `factoryControl:factory_unload:${roomName}:${product}`,
    type: "factory_unload",
    priority: 180,
    producer: FACTORY_CARRIER_TASK_PRODUCER,
    roomName,
    resource: product,
    fromKind: "factory",
    toKind,
    fromId: factory.id,
    toId: target.id,
    amount: productAmount,
  });
}

function executeProductionCycle(
  room: Room,
  factory: StructureFactory,
  state: RoomRuntimeState,
  config: FactoryControlConfig,
  roomName: string,
): void {
  const product = state.activeTarget!;
  const recipe = getCommodityRecipe(product);
  if (!recipe) {
    state.stage = "blocked";
    state.sleepReason = "no_recipe";
    state.lastError = "no_recipe";
    replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
    return;
  }

  const productInFactory = factory.store.getUsedCapacity(product) ?? 0;
  const hasProduct = productInFactory > 0;

  let allInputsPresent = true;
  for (const [comp, needed] of Object.entries(recipe.components)) {
    if (!needed || needed <= 0) continue;
    const inFactory = factory.store.getUsedCapacity(comp as ResourceConstant) ?? 0;
    if (inFactory < needed) {
      allInputsPresent = false;
      break;
    }
  }

  let drafts: CarrierTaskDraft[] = [];
  const previousStage = state.stage;

  if (hasProduct) {
    const unloadDraft = generateFactoryUnloadDraft(room, factory, product, roomName);
    if (unloadDraft) {
      state.stage = "unloading";
      drafts = [unloadDraft];
    } else {
      state.stage = "blocked";
      state.sleepReason = "unload_target_full";
      state.lastError = "terminal_and_storage_full";
    }
  } else if (allInputsPresent) {
    if (factory.cooldown > 0) {
      state.stage = "producing";
    } else {
      const factoryFree = factory.store.getFreeCapacity() ?? 0;
      const hasOutputCapacity = factoryFree >= recipe.amount;
      const unloadTarget = resolveFactoryUnloadTarget(room, product);

      if (hasOutputCapacity && unloadTarget) {
        state.stage = "producing";
        const result = factory.produce(product as CommodityConstant);
        if (result !== OK) {
          state.lastError = `produce_${result}`;
          if (result === ERR_NOT_ENOUGH_RESOURCES) {
            state.stage = "loading";
            if (!state.loadingSinceTick) {
              state.loadingSinceTick = Game.time;
            }
            drafts = generateFactorySupplyDrafts(room, factory, recipe, roomName);
          } else {
            state.stage = "blocked";
            state.sleepReason = `produce_error_${result}`;
            state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnError;
          }
        }
      } else {
        state.stage = "blocked";
        if (!hasOutputCapacity) {
          state.sleepReason = "factory_output_full";
          state.lastError = "factory_full";
        } else {
          state.sleepReason = "terminal_backpressure";
          state.lastError = "unload_target_full";
        }
        state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnError;
      }
    }
  } else {
    state.stage = "loading";
    if (!state.loadingSinceTick) {
      state.loadingSinceTick = Game.time;
    }
    drafts = generateFactorySupplyDrafts(room, factory, recipe, roomName);
  }

  if (state.stage !== previousStage) {
    state.lastTransitionAt = Game.time;
    if (state.stage as string !== "loading" && state.stage as string !== "acquiring") {
      state.loadingSinceTick = undefined;
    }
  }

  replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, drafts);
}

// ---------------------------------------------------------------------------
// Main planning function
// ---------------------------------------------------------------------------

export function runFactoryControl(): void {
  const config = parseConfig();
  if (!config.enabled) return;

  const runtime = ensureRuntimeState();
  runtime.updatedAt = Game.time;

  for (const room of Object.values(Game.rooms)) {
    if (!isEligibleRoom(room)) continue;

    const roomName = room.name;
    const roomCfg = config.rooms[roomName];
    if (roomCfg && !roomCfg.enabled) continue;

    const factory = findFactoryInRoom(room);
    if (!factory) continue;

    const state = getRoomState(runtime, roomName);
    const holderId = factory.id as string;
    const previousActiveTarget = state.activeTarget;

    const targetQueue = resolveTargetQueue(config, roomName);
    const resourceFloors = resolveResourceFloors(config, roomName);
    const productionCaps = resolveProductionCaps(config, roomName);

    if (targetQueue.length === 0) {
      state.stage = "sleeping";
      state.sleepReason = "empty_target_queue";
      state.activeTarget = undefined;
      state.missing = undefined;
      state.lastTransitionAt = Game.time;
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
      continue;
    }

    // Check if currently sleeping
    if (state.sleepUntilTick && state.sleepUntilTick > Game.time) {
      continue;
    }

    // Clear sleep if expired
    if (state.sleepUntilTick && state.sleepUntilTick <= Game.time) {
      state.sleepUntilTick = undefined;
      state.sleepReason = undefined;
    }

    let highestLevelGated: { resource: ResourceConstant; requiredLevel: number } | null = null;

    // Evaluate each target in queue order
    let planned = false;
    for (const target of targetQueue) {
      const resource = target.resource;
      const targetAmount = target.targetAmount || 0;
      const cap = target.cap || 0;

      const requiredLevel = getRequiredFactoryLevel(resource);
      if (requiredLevel > (factory.level ?? 0)) {
        if (!highestLevelGated || requiredLevel > highestLevelGated.requiredLevel) {
          highestLevelGated = { resource, requiredLevel };
        }
        continue;
      }

      // Check production cap
      const currentStock = getRoomStock(room, resource);
      const effectiveCap = productionCaps[resource] ?? cap;
      if (effectiveCap > 0 && currentStock >= effectiveCap) {
        continue;
      }

      // Check if target amount already satisfied
      if (targetAmount > 0 && currentStock >= targetAmount) {
        continue;
      }

      // Decompose to find what we actually need to produce
      const effectiveTarget = targetAmount > 0 ? targetAmount - currentStock : (effectiveCap > 0 ? effectiveCap - currentStock : 1);
      const decomposition = decomposeTarget(
        resource,
        Math.max(1, effectiveTarget),
        room,
        resourceFloors,
        holderId,
      );

      if (decomposition.requiredLevel > (factory.level ?? 0)) {
        if (!highestLevelGated || decomposition.requiredLevel > highestLevelGated.requiredLevel) {
          highestLevelGated = { resource, requiredLevel: decomposition.requiredLevel };
        }
        continue;
      }

      // Set active target
      if (decomposition.productionTarget === resource) {
        state.activeTarget = resource;
      } else {
        state.activeTarget = decomposition.productionTarget;
      }

      if (state.activeTarget !== previousActiveTarget) {
        state.loadingSinceTick = undefined;
      }

      state.missing = Object.keys(decomposition.missing).length > 0
        ? decomposition.missing
        : undefined;

      if (Object.keys(decomposition.missing).length > 0) {
        state.stage = "blocked";
        state.sleepReason = "missing_base_inputs";
        state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnMissing;
      } else {
        state.stage = "idle";
        state.sleepReason = undefined;
      }

      state.lastTransitionAt = Game.time;
      planned = true;
      break;
    }

    if (!planned) {
      state.activeTarget = undefined;
      state.missing = undefined;
      state.lastTransitionAt = Game.time;

      if (highestLevelGated) {
        state.stage = "sleeping";
        state.sleepReason = `factory_level_${highestLevelGated.requiredLevel}_required`;
        state.sleepUntilTick = Game.time + config.sleepSettings.maxSleepTicks;
      } else {
        state.stage = "sleeping";
        state.sleepReason = "all_targets_skipped";
        state.sleepUntilTick = Game.time + config.sleepSettings.maxSleepTicks;
      }
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
      continue;
    }

    if (state.stage === "blocked") {
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
      continue;
    }

    executeProductionCycle(room, factory, state, config, roomName);
  }
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

export {
  parseConfig,
  isEligibleRoom,
  findFactoryInRoom,
  getRoomStock,
  computeSurplus,
  decomposeTarget,
  resolveTargetQueue,
  getRequiredFactoryLevel,
  isProducible,
  type TargetEntry,
  type RoomPlanConfig,
  type FactoryControlConfig,
  type FactoryStage,
  type RoomRuntimeState,
  type FactoryControlRuntime,
};
