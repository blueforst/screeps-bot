/**
 * Hub planner config schema, defaults, runtime state, and chain planning.
 *
 * PRODUCTION-RATE EXPECTATION:
 * Producing 1000 each of 10 T3 compounds (~10000 total T3 units) requires ~54k
 * base minerals and takes ~20k–30k ticks under one-room sequential lab execution
 * (3+ labs), depending on terminal contention and cleanup ticks.
 *
 * The 38 sequential reactions range from shared intermediates (OH, ZK, UL, G)
 * through tier-1, tier-2, to final T3 compounds. Each reaction cycle consumes
 * 5 ticks per batch; total duration is dominated by the depth of the longest
 * dependency chain plus terminal transfer overhead between rooms.
 */

import {
  createAutomaticResourceTransferTask,
  createResourceTransferTaskAmountIndex,
  ensureResourceTransferTaskStore,
  isHealthyResourceTransferTaskReservation,
  type ResourceTransferTaskAmountIndex,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  getReceiverSafeCapacity,
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
} from "@/runtime/logistics/capacityHeadroom";
import {
  HUB_DISTRIBUTED_STORAGE,
  HUB_INTERNAL_ONLY,
  HUB_PLAN_INTERVAL,
  HUB_RESERVE_PER_COMPOUND,
  HUB_RESERVE_PER_ROOM,
  HUB_STORAGE_PAUSE_FREE_CAPACITY,
  HUB_SURPLUS_THRESHOLD,
  HUB_TARGET_COMPOUNDS,
} from "@/config/hub";
import { getTickContextService } from "@/runtime/runtimeServices";
import { collectCarrierCargoInventory } from "@/runtime/hubProgress";
import { getProductReagentMap, roundUpReactionAmount } from "@/runtime/reactionMap";

export function getDefaultHubConfig(): NonNullable<Memory["cfg"]>["hub"] {
  return {
    enabled: false,
    hubRoomName: "",
    planInterval: HUB_PLAN_INTERVAL,
    reservePerRoom: HUB_RESERVE_PER_ROOM,
    hubReservePerCompound: HUB_RESERVE_PER_COMPOUND,
    targetCompounds: [...HUB_TARGET_COMPOUNDS],
    storagePauseFreeCapacity: HUB_STORAGE_PAUSE_FREE_CAPACITY,
    surplusThreshold: HUB_SURPLUS_THRESHOLD,
    internalOnly: HUB_INTERNAL_ONLY,
    distributedStorage: HUB_DISTRIBUTED_STORAGE,
  };
}

export function getDefaultHubRuntime(): NonNullable<Memory["runtime"]>["hub"] {
  return {
    status: "idle",
    updatedAt: 0,
    activeProduct: "",
    activeStep: 0,
    missingResources: [],
    lastPlanActions: [],
    needsPlan: false,
  };
}

const OLD_DEFAULT_TARGET_COMPOUNDS = new Set<ResourceConstant>([
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
  RESOURCE_CATALYZED_GHODIUM_ACID, // XGH2O
  RESOURCE_CATALYZED_UTRIUM_ACID, // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE, // XUHO2
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
]);

export function normalizeHubConfig(cfg: NonNullable<Memory["cfg"]>["hub"]): NonNullable<Memory["cfg"]>["hub"] {
  let migrated = { ...cfg };

  const compounds = cfg?.targetCompounds;
  if (compounds && compounds.length === OLD_DEFAULT_TARGET_COMPOUNDS.size) {
    const compoundSet = new Set(compounds);
    let matchesOldDefault = true;
    for (const c of OLD_DEFAULT_TARGET_COMPOUNDS) {
      if (!compoundSet.has(c)) {
        matchesOldDefault = false;
        break;
      }
    }
    if (matchesOldDefault) {
      migrated = { ...migrated, targetCompounds: [...HUB_TARGET_COMPOUNDS] };
    }
  }

  if ((migrated.reservePerRoom ?? 0) < HUB_RESERVE_PER_ROOM) {
    migrated = { ...migrated, reservePerRoom: HUB_RESERVE_PER_ROOM };
  }

  if (migrated.distributedStorage === undefined) {
    migrated = { ...migrated, distributedStorage: HUB_DISTRIBUTED_STORAGE };
  }

  return migrated;
}

export interface ChainStep {
  product: ResourceConstant;
  targetAmount: number;
  reagents: [ResourceConstant, ResourceConstant];
}

// ---------------------------------------------------------------------------
// Distributed synthesis type contract — multi-room hub dispatch planning types
// ---------------------------------------------------------------------------

/** Describes a room's capability to participate in distributed synthesis. */
export interface SynthesisRoomCapability {
  roomName: string;
  labCount: number;
  hasTerminal: boolean;
  hasStorage: boolean;
  /** If this room has a lab reserved for boost operations (not available for synthesis). */
  boostLabExclusive: boolean;
  /** Distinct minerals available in this room (storage + terminal + lab). */
  mineralInventory: Partial<Record<ResourceConstant, number>>;
}

/** A dispatch assignment: which room should synthesize what, and how much. */
export interface SynthesisDispatchAssignment {
  roomName: string;
  product: ResourceConstant;
  targetAmount: number;
  /** Whether this is the hub room itself or an auxiliary room. */
  isHubRoom: boolean;
  /** The final T3 target this assignment contributes to. Optional/backward-compatible. */
  finalTarget?: ResourceConstant;
}

/** Tracks resource allocation commitments across rooms. */
export interface AllocationLedgerEntry {
  resource: ResourceConstant;
  totalAmount: number;
  /** How much each room has committed or holds. */
  roomCommitments: Record<string, number>;
}

/** A decision to send resources directly between rooms via terminal. */
export interface DirectRouteDecision {
  fromRoom: string;
  toRoom: string;
  resource: ResourceConstant;
  amount: number;
  /** Terminal send fee in energy. */
  fee: number;
  /**
   * True when this route carries a reagent demand for the hub room's own active
   * synthesis (toRoom === hubRoomName because the hub is synthesizing). Such
   * routes are NOT surplus returns and survive under distributedStorage even for
   * non-T3 resources. Untagged hub-bound routes are treated as surplus returns.
   */
  isHubReagentDemand?: boolean;
}

/** Represents an edge in the upstream/downstream production progress graph. */
export interface ProgressEdge {
  /** The room providing the resource (upstream). */
  fromRoom: string;
  /** The room receiving the resource (downstream). */
  toRoom: string;
  /** The resource flowing along this edge. */
  resource: ResourceConstant;
  /** How many units have been delivered so far. */
  delivered: number;
  /** Total units to deliver. */
  total: number;
}

const PROCESS_ORDER: ResourceConstant[] = [
  // T3 products (catalyzed)
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
  RESOURCE_CATALYZED_KEANIUM_ACID,
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
  RESOURCE_CATALYZED_LEMERGIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ACID,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  // T2 intermediates
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
  // T1 intermediates
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
  // Base intermediates
  RESOURCE_GHODIUM,
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
];

const T3_TARGETS: ResourceConstant[] = [
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
  RESOURCE_CATALYZED_KEANIUM_ACID,
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
  RESOURCE_CATALYZED_LEMERGIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ACID,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
];

const BASE_MINERALS: ResourceConstant[] = [
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
];

const INTERMEDIATE_COMPOUNDS: ResourceConstant[] = [
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
  RESOURCE_GHODIUM_ALKALIDE,
  RESOURCE_GHODIUM_ACID,
];

const BASE_MINERAL_SAFETY_FLOOR = 500;

const SHARED_BASE_INTERMEDIATES = new Set<ResourceConstant>([
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_GHODIUM,
]);

const MIN_HUB_IMPORT_AMOUNT = 100;

const HUB_RUNTIME_ARRAY_CAP = 20;

export function planHubChains(
  hubInventory: Record<string, number>,
  incomingResources: Record<string, number>,
  targetReserve: number,
  targetCompounds: ResourceConstant[] = T3_TARGETS,
): { steps: ChainStep[]; blocked: boolean; missingResources: ResourceConstant[] } {
  // 1. Merge hub inventory + healthy incoming into available pool
  const available: Record<string, number> = {};
  const merge = (rec: Record<string, number>) => {
    for (const [k, v] of Object.entries(rec)) {
      available[k] = (available[k] || 0) + v;
    }
  };
  merge(hubInventory);
  merge(incomingResources);

  // 2. Seed demand only for the target compounds parameter. Store the reserve
  // target here, not the deficit: the propagation pass subtracts current
  // inventory once for every product, including T3 targets.
  const needed: Record<string, number> = {};
  for (const t3 of targetCompounds) {
    const have = available[t3] || 0;
    if (have < targetReserve) {
      needed[t3] = targetReserve;
    }
  }

  // If all targets are at reserve, nothing to produce
  if (Object.keys(needed).length === 0) {
    return { steps: [], blocked: false, missingResources: [] };
  }

  // 3. Propagate deficits down PROCESS_ORDER (T3 → base intermediates)
  for (const product of PROCESS_ORDER) {
    const demand = needed[product] || 0;
    if (demand <= 0) continue;

    const have = available[product] || 0;
    const toProduce = Math.max(0, demand - have);
    needed[product] = toProduce;

    if (toProduce > 0) {
      const reagents = getProductReagentMap()[product];
      if (reagents) {
        for (const r of reagents) {
          needed[r] = (needed[r] || 0) + toProduce;
        }
      }
    }
  }

  // 4. Build candidates: products with demand > 0 AND both reagents available
  const OUTPUT_ORDER: ResourceConstant[] = [
    // Base intermediates
    RESOURCE_HYDROXIDE,
    RESOURCE_ZYNTHIUM_KEANITE,
    RESOURCE_UTRIUM_LEMERGITE,
    RESOURCE_GHODIUM,
    // T1 intermediates
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
    // T2 intermediates
    RESOURCE_UTRIUM_ACID,
    RESOURCE_UTRIUM_ALKALIDE,
    RESOURCE_KEANIUM_ACID,
    RESOURCE_KEANIUM_ALKALIDE,
    RESOURCE_LEMERGIUM_ACID,
    RESOURCE_LEMERGIUM_ALKALIDE,
    RESOURCE_ZYNTHIUM_ACID,
    RESOURCE_ZYNTHIUM_ALKALIDE,
    RESOURCE_GHODIUM_ALKALIDE,
    RESOURCE_GHODIUM_ACID,
    // T3 products
    RESOURCE_CATALYZED_UTRIUM_ACID,
    RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
    RESOURCE_CATALYZED_KEANIUM_ACID,
    RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
    RESOURCE_CATALYZED_LEMERGIUM_ACID,
    RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
    RESOURCE_CATALYZED_ZYNTHIUM_ACID,
    RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
    RESOURCE_CATALYZED_GHODIUM_ACID,
    RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  ];

  const candidates: ChainStep[] = [];
  for (const product of OUTPUT_ORDER) {
    const demand = needed[product] || 0;
    if (demand <= 0) continue;

    const reagents = getProductReagentMap()[product];
    if (!reagents) continue;

    const availA = available[reagents[0]] || 0;
    const availB = available[reagents[1]] || 0;

    if (availA <= 0 || availB <= 0) continue;

    const amount = Math.max(1, Math.min(demand, availA, availB));
    candidates.push({ product, targetAmount: amount, reagents });
  }

  // 5. If we have feasible candidates, return them unblocked
  if (candidates.length > 0) {
    return { steps: candidates, blocked: false, missingResources: [] };
  }

  // 6. No candidate has both reagents — find blocking base minerals
  // Report only bases that block ALL remaining feasible paths
  const missingResources: ResourceConstant[] = [];
  for (const base of BASE_MINERALS) {
    const have = available[base] || 0;
    const need = needed[base] || 0;
    if (need > have) {
      missingResources.push(base);
    }
  }

  return {
    steps: [],
    blocked: true,
    missingResources,
  };
}

function countLabs(room: Room): number {
  return room.find(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_LAB },
  }).length;
}

/**
 * Compute direct-supply commitment for a satellite room's resource.
 * This is the sum of outgoing direct-supply transfers (synthesis:direct:*)
 * and route-decision demands from the active distributed synthesis plan.
 */
function getDirectSupplyCommitment(
  satelliteName: string,
  resource: ResourceConstant,
  transferAmounts: ResourceTransferTaskAmountIndex,
): number {
  let commitment = 0;

  commitment += transferAmounts.getPendingOutgoing(satelliteName, resource, "synthesis:direct:");
  commitment += transferAmounts.getPendingOutgoing(satelliteName, resource, "synthesis:hub-route:");

  const routeDecisions = Memory.runtime?.hub?.distributedSynthesis?.routeDecisions;
  if (routeDecisions) {
    for (const route of routeDecisions) {
      if (route.fromRoom === satelliteName && route.resource === resource) {
        commitment += route.amount;
      }
    }
  }

  return commitment;
}

/**
 * Compute the local reserve for a satellite room's resource based on
 * active distributed synthesis assignments. For T3 products, uses
 * reservePerRoom. For intermediates/base minerals needed by an active
 * reaction, returns the reagent demand for the assigned product's batch.
 */
function getLocalReserveForSynthesis(
  satelliteName: string,
  resource: string,
  reservePerRoom: number,
  targetCompounds: ResourceConstant[],
): number {
  if (targetCompounds.includes(resource as ResourceConstant)) {
    return reservePerRoom;
  }

  const assignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments;
  if (!assignments) return 0;

  const assignment = assignments.find(a => a.roomName === satelliteName);
  if (!assignment) return 0;

  const product = assignment.product as string;

  const batchSize = getBatchSizeForRoom(satelliteName);
  if (isReagentInChain(product, resource)) {
    return batchSize;
  }

  return 0;
}

/** Get the configured batch size for a room's synthesis reaction, default 5. */
function getBatchSizeForRoom(roomName: string): number {
  const roomCfg = Memory.cfg?.synthesisControl?.rooms?.[roomName];
  const reactions = roomCfg?.reactions;
  if (reactions && reactions.length > 0 && reactions[0].batchSize) {
    return reactions[0].batchSize;
  }
  return roomCfg?.batchSize ?? 5;
}

/** Check if a resource appears as a reagent anywhere in the reaction chain for a product. */
function isReagentInChain(product: string, resource: string): boolean {
  const visited = new Set<string>();
  const stack: string[] = [product];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const reagents = getProductReagentMap()[current];
    if (!reagents) continue;

    if (reagents[0] === resource || reagents[1] === resource) return true;
    stack.push(reagents[0], reagents[1]);
  }

  return false;
}

export function planHubImports(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): string[] {
  if (!cfg?.hubRoomName) return [];

  const hubRoom = Game.rooms[cfg.hubRoomName];
  if (!hubRoom?.storage) return [];

  const hubFreeCapacity = hubRoom.storage.store.getFreeCapacity();
  if (hubFreeCapacity < (cfg.storagePauseFreeCapacity ?? HUB_STORAGE_PAUSE_FREE_CAPACITY)) return [];

  const actions: string[] = [];
  const reservePerRoom = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const surplusThreshold = cfg.surplusThreshold ?? HUB_SURPLUS_THRESHOLD;
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;

  const existingKeys = new Set<string>();
  const taskStore = ensureResourceTransferTaskStore();
  for (const task of Object.values(taskStore)) {
    if (
      task.toRoomName === cfg.hubRoomName &&
      isHealthyResourceTransferTaskReservation(task, "incoming")
    ) {
      existingKeys.add(`${task.fromRoomName}:${task.resource}:${task.reason}`);
    }
  }

  const myRooms = getTickContextService().getMyRooms();
  const satellites = myRooms.filter(
    (room) =>
      room.name !== cfg.hubRoomName &&
      room.controller?.my &&
      room.storage &&
      room.terminal,
  );

  for (const satellite of satellites) {
    const satResources: Record<string, number> = {};
    const storageStore = satellite.storage!.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(storageStore)) {
      if (res !== RESOURCE_ENERGY && typeof amt === "number" && amt > 0) {
        satResources[res] = amt;
      }
    }
    const terminalStore = satellite.terminal!.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(terminalStore)) {
      if (res !== RESOURCE_ENERGY && typeof amt === "number" && amt > 0) {
        satResources[res] = (satResources[res] || 0) + amt;
      }
    }

    // Distributed storage keeps base/intermediate surplus local; T3 reclaim stays
    // hub-bound.
    if (cfg.distributedStorage !== true) {
      for (const mineral of BASE_MINERALS) {
        const amount = satResources[mineral] || 0;
        if (amount <= BASE_MINERAL_SAFETY_FLOOR) continue;
        const directCommitment = getDirectSupplyCommitment(satellite.name, mineral, transferAmounts);
        const localReserve = getLocalReserveForSynthesis(satellite.name, mineral, reservePerRoom, targetCompounds);
        const sendAmount = amount - BASE_MINERAL_SAFETY_FLOOR - directCommitment - localReserve;
        if (sendAmount < MIN_HUB_IMPORT_AMOUNT) continue;
        const reason = `hub:import:${mineral}`;
        const key = `${satellite.name}:${mineral}:${reason}`;
        if (existingKeys.has(key)) continue;
        const result = createAutomaticResourceTransferTask(satellite.name, cfg.hubRoomName, mineral, sendAmount, reason);
        if (typeof result === "object" && result.ok) {
          actions.push(`import:${satellite.name}:${mineral}=${sendAmount}`);
        }
      }

      for (const compound of INTERMEDIATE_COMPOUNDS) {
        const amount = satResources[compound] || 0;
        if (amount <= 0) continue;
        const directCommitment = getDirectSupplyCommitment(satellite.name, compound, transferAmounts);
        const localReserve = getLocalReserveForSynthesis(satellite.name, compound, reservePerRoom, targetCompounds);
        const sendAmount = amount - directCommitment - localReserve;
        if (sendAmount < MIN_HUB_IMPORT_AMOUNT) continue;
        const reason = `hub:import:${compound}`;
        const key = `${satellite.name}:${compound}:${reason}`;
        if (existingKeys.has(key)) continue;
        const result = createAutomaticResourceTransferTask(satellite.name, cfg.hubRoomName, compound, sendAmount, reason);
        if (typeof result === "object" && result.ok) {
          actions.push(`import:${satellite.name}:${compound}=${sendAmount}`);
        }
      }
    }

    for (const t3 of targetCompounds) {
      const amount = satResources[t3] || 0;
      if (amount <= surplusThreshold) continue;
      const directCommitment = getDirectSupplyCommitment(satellite.name, t3, transferAmounts);
      const localReserve = getLocalReserveForSynthesis(satellite.name, t3, reservePerRoom, targetCompounds);
      const sendAmount = amount - directCommitment - localReserve;
      if (sendAmount <= 0) continue;
      const reason = `hub:reclaim:${t3}`;
      const key = `${satellite.name}:${t3}:${reason}`;
      if (existingKeys.has(key)) continue;
      const result = createAutomaticResourceTransferTask(satellite.name, cfg.hubRoomName, t3, sendAmount, reason);
      if (typeof result === "object" && result.ok) {
        actions.push(`reclaim:${satellite.name}:${t3}=${sendAmount}`);
      }
    }
  }

  return actions;
}

export function planHubDistribution(cfg: NonNullable<Memory["cfg"]>["hub"]): string[] {
  if (!cfg?.hubRoomName) return [];

  const hubRoom = Game.rooms[cfg.hubRoomName];
  if (!hubRoom?.storage || !hubRoom?.terminal) return [];

  const reservePerRoom = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;
  const capacityPolicy = normalizeCapacityHeadroomPolicy(
    Memory.cfg?.resourceControl?.capacityBalancing,
  );

  const hubT3Available: Record<string, number> = {};
  const hubStorageStore = hubRoom.storage.store as unknown as Record<string, number>;
  const hubTerminalStore = hubRoom.terminal.store as unknown as Record<string, number>;
  for (const t3 of targetCompounds) {
    hubT3Available[t3] = (hubStorageStore[t3] || 0) + (hubTerminalStore[t3] || 0);
  }

  const taskStore = ensureResourceTransferTaskStore();
  const hubPendingOutgoing: Record<string, number> = {};
  for (const task of Object.values(taskStore)) {
    if (
      isHealthyResourceTransferTaskReservation(task, "outgoing") &&
      task.fromRoomName === cfg.hubRoomName &&
      task.reason?.startsWith("hub:export:")
    ) {
      hubPendingOutgoing[task.resource] = (hubPendingOutgoing[task.resource] || 0) + task.remainingAmount;
    }
  }

  const hubReservePerCompound = cfg.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND;
  const hubRemaining: Record<string, number> = {};
  for (const t3 of targetCompounds) {
    hubRemaining[t3] = Math.max(0, (hubT3Available[t3] || 0) - (hubPendingOutgoing[t3] || 0) - hubReservePerCompound);
  }

  const myRooms = getTickContextService().getMyRooms();
  const satellites = myRooms.filter(
    (room) =>
      room.name !== cfg.hubRoomName &&
      room.controller?.my &&
      room.storage &&
      room.terminal,
  );

  const actions: string[] = [];

  for (const satellite of satellites) {
    const satStorageFree = satellite.storage!.store.getFreeCapacity();
    const satTerminalFree = satellite.terminal!.store.getFreeCapacity();
    const capacityState = resolveCapacityState(
      satStorageFree,
      satTerminalFree,
      capacityPolicy,
      Memory.runtime?.resourceControl?.rooms?.[satellite.name]?.capacityState,
    );
    if (!isReceiverAdmissionEligible(
      satStorageFree,
      satTerminalFree,
      capacityState,
      capacityPolicy,
    )) {
      continue;
    }
    const receivableCapacity = getReceiverSafeCapacity(
      satStorageFree,
      satTerminalFree,
      capacityPolicy,
    );
    if (receivableCapacity <= 0) continue;

    for (const t3 of targetCompounds) {
      if (hubRemaining[t3] <= 0) continue;

      const satStorage = satellite.storage!.store as unknown as Record<string, number>;
      const satTerminal = satellite.terminal!.store as unknown as Record<string, number>;
      const current = (satStorage[t3] || 0) + (satTerminal[t3] || 0);

      const effectiveTotal = current;
      if (effectiveTotal >= reservePerRoom) continue;

      const shortage = reservePerRoom - effectiveTotal;
      const cappedByHub = Math.min(shortage, hubRemaining[t3]);
      const amount = Math.min(cappedByHub, receivableCapacity);

      if (amount <= 0) continue;

      const reason = `hub:export:${t3}`;
      const result = createAutomaticResourceTransferTask(cfg.hubRoomName, satellite.name, t3, amount, reason);

      if (typeof result === "object" && result.ok) {
        actions.push(`export:${satellite.name}:${t3}=${amount}`);
        hubRemaining[t3] -= amount;
      }
    }
  }

  return actions;
}

export function writeSynthesisConfig(
  hubRoomName: string,
  steps: ChainStep[],
  hubInventory: Record<string, number>,
): void {
  if (!Memory.cfg) return;
  if (!Memory.cfg.synthesisControl) {
    Memory.cfg.synthesisControl = {};
  }
  Memory.cfg.synthesisControl.enabled = true;

  if (!Memory.cfg.synthesisControl.rooms) {
    Memory.cfg.synthesisControl.rooms = {};
  }

  const nextStep = steps.length > 0 ? steps[0] : null;

  if (!nextStep) {
    const roomCfg = Memory.cfg.synthesisControl.rooms[hubRoomName];
    if (roomCfg) {
      roomCfg.reactions = [];
    }
    return;
  }

  if (!Memory.cfg.synthesisControl.rooms[hubRoomName]) {
    Memory.cfg.synthesisControl.rooms[hubRoomName] = {
      enabled: true,
      donorRoomNames: [],
    };
  }

  const roomCfg = Memory.cfg.synthesisControl.rooms[hubRoomName];
  roomCfg.enabled = true;

  roomCfg.reactions = [
    {
      product: nextStep.product,
      targetAmount: roundUpReactionAmount((hubInventory[nextStep.product] || 0) + nextStep.targetAmount),
      batchSize: Math.min(3000, Math.max(5, roundUpReactionAmount(nextStep.targetAmount))),
      donorRoomNames: [],
    },
  ];
}

/**
 * Clear stale hub synthesis reactions when hub planning is blocked or disabled.
 * Preserves lab IDs and all other room config metadata.
 */
export function clearHubSynthesisReactions(hubRoomName: string): void {
  const roomCfg = Memory.cfg?.synthesisControl?.rooms?.[hubRoomName];
  if (roomCfg) {
    roomCfg.reactions = [];
  }
}

function computeTotalSatelliteDeficit(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  targetCompounds: ResourceConstant[],
  transferAmounts: ResourceTransferTaskAmountIndex,
): number {
  const reservePerRoom = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const myRooms = getTickContextService().getMyRooms();
  const satellites = myRooms.filter(
    (room) =>
      room.name !== cfg.hubRoomName &&
      room.controller?.my &&
      room.storage &&
      room.terminal,
  );

  let totalDeficit = 0;
  for (const satellite of satellites) {
    for (const t3 of targetCompounds) {
      const satStorage = satellite.storage!.store as unknown as Record<string, number>;
      const satTerminal = satellite.terminal!.store as unknown as Record<string, number>;
      const current = (satStorage[t3] || 0) + (satTerminal[t3] || 0);

      // Count pending incoming for this satellite+resource
      const pendingIncoming = transferAmounts.getPendingIncoming(satellite.name, t3, "hub:export:");

      const effectiveTotal = current + pendingIncoming;
      const deficit = Math.max(0, reservePerRoom - effectiveTotal);
      totalDeficit += deficit;
    }
  }
  return totalDeficit;
}

/**
 * Discover all eligible rooms for distributed synthesis and score their capacity.
 *
 * Eligibility: visible owned room with storage, terminal, and at least 3 labs.
 * Labs must not ALL be boost-reserved (a single boost lab is fine).
 * Survival-state rooms ARE eligible.
 */
export function getEligibleSynthesisRooms(): SynthesisRoomCapability[] {
  const myRooms = getTickContextService().getMyRooms();
  const results: SynthesisRoomCapability[] = [];

  for (const room of myRooms) {
    if (!room.storage || !room.terminal) continue;

    const labCount = countLabs(room);
    if (labCount < 3) continue;

    // boostLabExclusive: a single boost lab is fine; only exclude when ALL labs are boost-reserved
    const boostLabId = Memory.cfg?.homeDefense?.rooms?.[room.name]?.boostLabId;
    const boostLabExclusive = labCount >= 1 && boostLabId != null && labCount <= 1;

    if (boostLabExclusive) continue;

    const mineralInventory: Partial<Record<ResourceConstant, number>> = {};

    const storageStore = room.storage.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(storageStore)) {
      if (res !== RESOURCE_ENERGY && amt > 0) {
        mineralInventory[res as ResourceConstant] = amt;
      }
    }

    const terminalStore = room.terminal.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(terminalStore)) {
      if (res !== RESOURCE_ENERGY && amt > 0) {
        mineralInventory[res as ResourceConstant] = (mineralInventory[res as ResourceConstant] || 0) + amt;
      }
    }

    results.push({
      roomName: room.name,
      labCount,
      hasTerminal: true,
      hasStorage: true,
      boostLabExclusive: false,
      mineralInventory,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Distributed synthesis: concurrent chain demand + global allocation ledger
// ---------------------------------------------------------------------------

/** Result of distributed synthesis planning across multiple rooms. */
export interface DistributedSynthesisPlan {
  /** Room → product assignments for concurrent synthesis. */
  dispatchAssignments: SynthesisDispatchAssignment[];
  /** Per-resource allocation ledger tracking committed amounts per room. */
  allocationLedger: Record<string, AllocationLedgerEntry>;
  /** Terminal transfer decisions for cross-room reagent routing. */
  routeDecisions: DirectRouteDecision[];
  /** T3 targets that cannot be produced due to insufficient global resources. */
  blockedTargets: ResourceConstant[];
}

/**
 * Compute concurrent chain demand for all configured T3 targets across
 * multiple synthesis-capable rooms and build a global allocation ledger.
 *
 * Leverages `planHubChains()` for demand propagation. The allocation ledger
 * is populated from room inventories (accounting for pending transfers and
 * local reserves) and decremented atomically as assignments are proposed,
 * ensuring two rooms cannot consume the same mineral stock.
 */
export function planDistributedSynthesis(
  hubRoomName: string,
  targetCompounds: ResourceConstant[],
  hubReservePerCompound: number,
  reservePerRoom: number,
  hubInventory: Record<string, number>,
  /**
   * Effective T3 production target to plan toward. Defaults to
   * `hubReservePerCompound` for backward compatibility. When the hub planner
   * computes `chainTarget = hubReservePerCompound + satelliteDeficit`, that
   * value must be passed here so distributed synthesis covers satellite export
   * demand instead of stopping at the bare hub reserve.
   */
  effectiveTargetReserve?: number,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): DistributedSynthesisPlan {
  const targetReserve = effectiveTargetReserve ?? hubReservePerCompound;
  const rooms = getEligibleSynthesisRooms();
  const allResources = [...BASE_MINERALS, ...INTERMEDIATE_COMPOUNDS, ...T3_TARGETS];

  // 1. Build per-room effective inventories (with pending transfers and reserves)
  const roomEffective: Record<string, Record<string, number>> = {};
  for (const room of rooms) {
    const effective: Record<string, number> = {};
    for (const [res, amt] of Object.entries(room.mineralInventory)) {
      effective[res] = amt;
    }
    for (const res of allResources) {
      const rc = res as ResourceConstant;
      const incoming = transferAmounts.getIncoming(room.roomName, rc);
      const outgoing = transferAmounts.getOutgoing(room.roomName, rc);
      effective[res] = (effective[res] || 0) + incoming - outgoing;
    }
    // Subtract local reserve for base minerals
    for (const base of BASE_MINERALS) {
      const have = effective[base] || 0;
      effective[base] = have > reservePerRoom ? have - reservePerRoom : 0;
    }
    roomEffective[room.roomName] = effective;
  }

  // 2. Build allocation ledger from per-room effective inventories
  const ledger: Record<string, AllocationLedgerEntry> = {};
  for (const room of rooms) {
    for (const res of allResources) {
      const amt = roomEffective[room.roomName][res] || 0;
      if (amt <= 0) continue;
      if (!ledger[res]) {
        ledger[res] = { resource: res as ResourceConstant, totalAmount: 0, roomCommitments: {} };
      }
      ledger[res].totalAmount += amt;
      ledger[res].roomCommitments[room.roomName] = amt;
    }
  }

  // 3-4. T3 reserve demand is hub-centric, but distributed synthesis can use
  // reagents held outside the hub. Use hub inventory for T3 target accounting
  // and the allocation ledger for base/intermediate feasibility.
  const chainInventory: Record<string, number> = {};
  for (const res of allResources) {
    const resource = res as ResourceConstant;
    chainInventory[res] = T3_TARGETS.includes(resource)
      ? hubInventory[res] || 0
      : ledger[res]?.totalAmount ?? 0;
  }
  const chainResult = planHubChains(chainInventory, {}, targetReserve, targetCompounds);

  // 5. Assign steps to rooms using logistics-cost-aware scoring, decrementing ledger atomically
  const assignments: SynthesisDispatchAssignment[] = [];
  const routeDecisions: DirectRouteDecision[] = [];
  const blockedTargets: ResourceConstant[] = [];

  const roomOrder = [
    hubRoomName,
    ...rooms.filter(r => r.roomName !== hubRoomName).map(r => r.roomName),
  ];

  // 5a. Cap each step's targetAmount so shared reagents are distributed fairly.
  // Without this, the first step consuming a shared reagent (e.g. OH consuming
  // all O, or the first T2 step consuming all OH) starves subsequent steps.
  // Applies to ALL reagents (base minerals, T1 intermediates like OH/UO, etc.)
  // because any can be a bottleneck shared across multiple chain steps.

  // Count how many steps need each reagent
  const reagentDemandCount: Record<string, number> = {};
  for (const step of chainResult.steps) {
    for (const reagent of step.reagents) {
      reagentDemandCount[reagent] = (reagentDemandCount[reagent] || 0) + 1;
    }
  }

  // Cap each step's targetAmount to its fair share of any reagent
  const cappedSteps = chainResult.steps.map(step => {
    let cap = step.targetAmount;
    for (const reagent of step.reagents) {
      const demandCount = reagentDemandCount[reagent] || 1;
      if (demandCount <= 1) continue; // no contention, skip
      const available = ledger[reagent]?.totalAmount ?? 0;
      const share = Math.floor(available / demandCount);
      cap = Math.min(cap, share);
    }
    return { ...step, targetAmount: Math.max(0, cap) };
  });

  // 5b. Tag capped steps with their possible final T3 targets, then
  // assign using first-pass diversification (one assignment per distinct
  // final T3 target) before allowing duplicate targets.

  interface TaggedStep {
    step: ChainStep;
    possibleTargets: ResourceConstant[];
    originalIndex: number;
  }

  const taggedSteps: TaggedStep[] = cappedSteps
    .filter(step => step.targetAmount > 0)
    .map((step, idx) => ({
      step,
      possibleTargets: getPossibleT3Targets(step.product, targetCompounds),
      originalIndex: idx,
    }));

  // Sort by specificity (fewer possible targets first) with original order
  // as tiebreaker. This ensures unique intermediates (UH→XUH2O) are assigned
  // before shared ones (OH→[XUH2O,XUHO2,...]), preventing shared intermediates
  // from claiming a target that a specific intermediate needs.
  taggedSteps.sort((a, b) => {
    const diff = a.possibleTargets.length - b.possibleTargets.length;
    return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
  });

  const depGraph = new DependencyGraph();
  const usedRooms = new Set<string>();
  const assignedTargets = new Set<ResourceConstant>();
  const assignedIndices = new Set<number>();
  const deferredIndices: number[] = [];

  // First pass: one assignment per distinct final T3 target
  for (let i = 0; i < taggedSteps.length; i++) {
    const { step, possibleTargets } = taggedSteps[i];
    const target = possibleTargets.find(t => !assignedTargets.has(t));

    if (target) {
      const result = assignStepToRoom(ledger, step, roomOrder, hubRoomName, rooms, depGraph, usedRooms, transferAmounts);
      if (result) {
        result.assignment.finalTarget = target;
        assignments.push(result.assignment);
        routeDecisions.push(...result.routes);
        usedRooms.add(result.assignment.roomName);
        assignedTargets.add(target);
        assignedIndices.add(i);
      } else {
        deferredIndices.push(i);
      }
    } else {
      deferredIndices.push(i);
    }
  }

  // Second pass: assign shared intermediates (OH, ZK, UL, G) and steps
  // with uncovered targets. Skip uniquely-traceable steps (T1/T2/T3) whose
  // single target is already covered — those would create traceProductToFinalT3
  // duplicates without providing diversification value.
  for (const i of deferredIndices) {
    const { step, possibleTargets } = taggedSteps[i];
    if (
      possibleTargets.length === 1 &&
      !SHARED_BASE_INTERMEDIATES.has(step.product) &&
      assignedTargets.has(possibleTargets[0])
    ) continue;

    const target = possibleTargets.find(t => !assignedTargets.has(t)) ?? possibleTargets[0];
    const result = assignStepToRoom(ledger, step, roomOrder, hubRoomName, rooms, depGraph, usedRooms, transferAmounts);
    if (result) {
      result.assignment.finalTarget = target;
      assignments.push(result.assignment);
      routeDecisions.push(...result.routes);
      usedRooms.add(result.assignment.roomName);
      if (!assignedTargets.has(target)) assignedTargets.add(target);
      assignedIndices.add(i);
    }
  }

  // Third pass: fallback — allow duplicate uniquely-traceable steps when
  // unused rooms remain after diversification (feasibleTargets < rooms).
  const unusedRoomCount = roomOrder.filter(r => !usedRooms.has(r)).length;
  if (unusedRoomCount > 0) {
    for (let i = 0; i < taggedSteps.length; i++) {
      if (assignedIndices.has(i)) continue;
      const { step, possibleTargets } = taggedSteps[i];
      const result = assignStepToRoom(ledger, step, roomOrder, hubRoomName, rooms, depGraph, usedRooms, transferAmounts);
      if (result) {
        result.assignment.finalTarget = possibleTargets[0] ?? undefined;
        assignments.push(result.assignment);
        routeDecisions.push(...result.routes);
        usedRooms.add(result.assignment.roomName);
        assignedIndices.add(i);
      }
    }
  }

  // 6. Blocked targets: only when planHubChains reports global resource shortage
  if (chainResult.blocked) {
    blockedTargets.push(...targetCompounds);
  }

  return { dispatchAssignments: assignments, allocationLedger: ledger, routeDecisions, blockedTargets };
}

/**
 * Trace a product upward through getProductReagentMap() consumers to find which
 * configured T3 targets it ultimately feeds into.
 * T3 products map to themselves. T1/T2 intermediates map to their unique T3.
 * Shared intermediates (OH, ZK, UL, G) map to all configured T3 targets that
 * consume them through any chain path.
 */
function getPossibleT3Targets(product: ResourceConstant, targetCompounds: ResourceConstant[]): ResourceConstant[] {
  if (targetCompounds.includes(product)) return [product];

  const results: ResourceConstant[] = [];
  const visited = new Set<string>();
  const stack: string[] = [product];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const [consumer, reagents] of Object.entries(getProductReagentMap())) {
      if (reagents[0] === current || reagents[1] === current) {
        const consumerRC = consumer as ResourceConstant;
        if (targetCompounds.includes(consumerRC)) {
          if (!results.includes(consumerRC)) {
            results.push(consumerRC);
          }
        } else {
          stack.push(consumer);
        }
      }
    }
  }

  return results;
}

const BUSY_STAGES = new Set(["loading", "synthesizing", "unloading", "cleanup"]);

interface RoomDispatchScore {
  roomName: string;
  score: number;
}

export function scoreRoomForStep(
  roomName: string,
  step: ChainStep,
  ledger: Record<string, AllocationLedgerEntry>,
  hubRoomName: string,
  roomCapabilities: SynthesisRoomCapability[],
  usedRooms?: Set<string>,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): RoomDispatchScore {
  const [reagentA, reagentB] = step.reagents;
  const needed = step.targetAmount;
  let score = 0;

  // Heavily penalize rooms that already have an assignment so other rooms
  // are preferred.  -300 is stronger than the +100 local-reagent bonus,
  // effectively reserving used rooms as a last resort.
  if (usedRooms?.has(roomName)) {
    score -= 300;
  }

  if (roomName === hubRoomName) {
    score += 1;
  }

  const localA = ledger[reagentA]?.roomCommitments[roomName] ?? 0;
  const localB = ledger[reagentB]?.roomCommitments[roomName] ?? 0;
  if (localA >= needed && localB >= needed) {
    score += 100;
  } else if (localA > 0 && localB > 0) {
    score += 20 + Math.min(localA, localB) / needed * 30;
  } else if (localA > 0 || localB > 0) {
    score += 10;
  }

  const needsExternalA = localA < needed;
  const needsExternalB = localB < needed;
  if (roomName !== hubRoomName && (needsExternalA || needsExternalB)) {
    if (typeof Game.market?.calcTransactionCost === "function") {
      const feeDirect = Game.market.calcTransactionCost(needed, hubRoomName, roomName);
      score -= feeDirect / needed * 5;
    } else {
      score -= 5;
    }
  }

  const stage = Memory.runtime?.synthesisControl?.rooms?.[roomName]?.stage;
  if (stage && BUSY_STAGES.has(stage)) {
    score -= 200;
  }

  const cap = roomCapabilities.find(r => r.roomName === roomName);
  if (cap) {
    let loadA = 0;
    let loadB = 0;
    for (const res of [reagentA, reagentB] as ResourceConstant[]) {
      const outgoing = transferAmounts.getOutgoing(roomName, res);
      const incoming = transferAmounts.getIncoming(roomName, res);
      if (res === reagentA) loadA = outgoing + incoming;
      if (res === reagentB) loadB = outgoing + incoming;
    }
    const totalLoad = loadA + loadB;
    score -= totalLoad / (needed * 2 + 1) * 10;
  }

  return { roomName, score };
}

export class DependencyGraph {
  private deps: Map<string, Set<string>> = new Map();

  add(room: string, dependsOn: string): void {
    if (!this.deps.has(room)) {
      this.deps.set(room, new Set());
    }
    this.deps.get(room)!.add(dependsOn);
  }

  wouldCreateCycle(room: string, dependsOn: string): boolean {
    return this.reachable(dependsOn, room);
  }

  private reachable(from: string, target: string): boolean {
    const visited = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const depSet = this.deps.get(current);
      if (depSet) {
        for (const d of depSet) {
          stack.push(d);
        }
      }
    }
    return false;
  }
}

function assignStepToRoom(
  ledger: Record<string, AllocationLedgerEntry>,
  step: ChainStep,
  roomOrder: string[],
  hubRoomName: string,
  roomCapabilities: SynthesisRoomCapability[],
  depGraph: DependencyGraph,
  usedRooms: Set<string>,
  transferAmounts: ResourceTransferTaskAmountIndex,
): { assignment: SynthesisDispatchAssignment; routes: DirectRouteDecision[] } | null {
  const [reagentA, reagentB] = step.reagents;
  const globalA = ledger[reagentA]?.totalAmount ?? 0;
  const globalB = ledger[reagentB]?.totalAmount ?? 0;
  if (globalA <= 0 || globalB <= 0) return null;
  let needed = Math.min(step.targetAmount, globalA, globalB);
  if (needed <= 0) return null;

  const scored = roomOrder
    .map(r => scoreRoomForStep(r, step, ledger, hubRoomName, roomCapabilities, usedRooms, transferAmounts))
    .sort((a, b) => b.score - a.score);

  for (const { roomName } of scored) {
    if (shouldSkipStalledActiveProduct(roomName, step.product, transferAmounts)) continue;

    const availA = ledger[reagentA]?.roomCommitments[roomName] ?? 0;
    const availB = ledger[reagentB]?.roomCommitments[roomName] ?? 0;
    if (availA >= needed && availB >= needed) {
      ledger[reagentA]!.roomCommitments[roomName] -= needed;
      ledger[reagentA]!.totalAmount -= needed;
      ledger[reagentB]!.roomCommitments[roomName] -= needed;
      ledger[reagentB]!.totalAmount -= needed;
      return {
        assignment: { roomName, product: step.product, targetAmount: needed, isHubRoom: roomName === hubRoomName },
        routes: [],
      };
    }

    const routes: DirectRouteDecision[] = [];
    const changes: Array<{ res: string; room: string; amt: number }> = [];
    const newDeps = new Set<string>();
    let remA = needed;
    let remB = needed;
    const isHubTarget = roomName === hubRoomName;

    const localA = availA;
    if (localA > 0) {
      const use = Math.min(localA, remA);
      changes.push({ res: reagentA, room: roomName, amt: use });
      remA -= use;
    }
    const localB = availB;
    if (localB > 0) {
      const use = Math.min(localB, remB);
      changes.push({ res: reagentB, room: roomName, amt: use });
      remB -= use;
    }

    for (const from of roomOrder) {
      if (remA <= 0 && remB <= 0) break;
      if (from === roomName) continue;

      if (depGraph.wouldCreateCycle(roomName, from)) continue;

      if (remA > 0) {
        const avail = ledger[reagentA]?.roomCommitments[from] ?? 0;
        if (avail > 0) {
          const send = Math.min(avail, remA);
          routes.push({ fromRoom: from, toRoom: roomName, resource: reagentA, amount: send, fee: 0, isHubReagentDemand: isHubTarget });
          changes.push({ res: reagentA, room: from, amt: send });
          newDeps.add(from);
          remA -= send;
        }
      }
      if (remB > 0) {
        const avail = ledger[reagentB]?.roomCommitments[from] ?? 0;
        if (avail > 0) {
          const send = Math.min(avail, remB);
          routes.push({ fromRoom: from, toRoom: roomName, resource: reagentB, amount: send, fee: 0, isHubReagentDemand: isHubTarget });
          changes.push({ res: reagentB, room: from, amt: send });
          newDeps.add(from);
          remB -= send;
        }
      }
    }

    if (remA <= 0 && remB <= 0) {
      for (const c of changes) {
        ledger[c.res]!.roomCommitments[c.room] -= c.amt;
        ledger[c.res]!.totalAmount -= c.amt;
      }
      for (const dep of newDeps) {
        depGraph.add(roomName, dep);
      }
      return {
        assignment: { roomName, product: step.product, targetAmount: needed, isHubRoom: roomName === hubRoomName },
        routes,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Distributed synthesis config writer — multi-room reaction assignment
// ---------------------------------------------------------------------------

const ACCEPT_REASSIGN_STAGES = new Set<string>(["idle", "blocked"]);

function isMissingInputUnserved(roomName: string, transferAmounts: ResourceTransferTaskAmountIndex): boolean {
  const roomState = Memory.runtime?.synthesisControl?.rooms?.[roomName];
  const missing = roomState?.missing;
  if (!missing) return false;
  if ((roomState.pendingTasks ?? 0) > 0) return false;

  const deficits = Object.entries(missing)
    .filter(([, deficit]) => (deficit ?? 0) > 0) as Array<[ResourceConstant, number]>;
  if (deficits.length === 0) return false;

  return deficits.every(([resource]) => transferAmounts.getIncoming(roomName, resource) <= 0);
}

function canRewriteSynthesisRoom(
  roomName: string,
  stage: string | undefined,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): boolean {
  if (!stage || ACCEPT_REASSIGN_STAGES.has(stage)) return true;
  return (stage === "acquiring" || stage === "loading") && isMissingInputUnserved(roomName, transferAmounts);
}

function shouldSkipStalledActiveProduct(
  roomName: string,
  product: ResourceConstant,
  transferAmounts: ResourceTransferTaskAmountIndex,
): boolean {
  const roomState = Memory.runtime?.synthesisControl?.rooms?.[roomName];
  if (roomState?.activeProduct !== product) return false;
  const stage = roomState.stage;
  if (stage !== "acquiring" && stage !== "loading") return false;
  return isMissingInputUnserved(roomName, transferAmounts);
}

/**
 * Write distributed synthesis reaction configs to multiple rooms.
 *
 * For each dispatch assignment, writes a reaction config to the target room
 * only if its runtime stage is idle, blocked, or undefined (never written to).
 * Preserves active reactions for rooms in loading/synthesizing/unloading/cleanup.
 *
 * Returns true if distributed mode was used (multiple rooms assigned),
 * false if hub-only fallback should be used instead.
 */
export function wireRouteTransferTasks(
  routeDecisions: DirectRouteDecision[],
  hubRoomName: string,
  reservePerRoom: number,
  distributedStorage?: boolean,
): void {
  const directRoutes = routeDecisions.filter(r => r.toRoom !== hubRoomName);
  const hubRoutes = routeDecisions.filter(r => r.toRoom === hubRoomName);
  const plannedRoutes = new Map<string, DirectRouteDecision & { reason: string }>();

  function addPlannedRoute(
    fromRoom: string,
    toRoom: string,
    resource: ResourceConstant,
    amount: number,
    fee: number,
    reason: string,
  ): void {
    if (amount <= 0) return;

    const key = getSynthesisRouteTaskKey(fromRoom, toRoom, resource, reason);
    const existing = plannedRoutes.get(key);
    if (existing) {
      existing.amount += amount;
      return;
    }

    plannedRoutes.set(key, { fromRoom, toRoom, resource, amount, fee, reason });
  }

  const hubReagentDemandRoutes = hubRoutes.filter(r => r.isHubReagentDemand === true);
  const hubSurplusRoutes = hubRoutes.filter(r => r.isHubReagentDemand !== true);

  const directCommitment: Record<string, number> = {};
  for (const route of directRoutes) {
    const key = `${route.fromRoom}:${route.resource}`;
    directCommitment[key] = (directCommitment[key] || 0) + route.amount;
  }
  for (const route of hubReagentDemandRoutes) {
    const key = `${route.fromRoom}:${route.resource}`;
    directCommitment[key] = (directCommitment[key] || 0) + route.amount;
  }

  for (const route of directRoutes) {
    if (route.amount <= 0) continue;

    let preferDirect = true;
    // Source IS hub → hub-route creates same-room task (ERR_SAME_ROOM).
    if (route.fromRoom !== hubRoomName && typeof Game.market?.calcTransactionCost === "function") {
      const directFee = Game.market.calcTransactionCost(route.amount, route.fromRoom, route.toRoom);
      const feeToHub = Game.market.calcTransactionCost(route.amount, route.fromRoom, hubRoomName);
      const feeHubToTarget = Game.market.calcTransactionCost(route.amount, hubRoomName, route.toRoom);
      if (directFee >= feeToHub + feeHubToTarget) {
        preferDirect = false;
      }
    }

    if (preferDirect) {
      addPlannedRoute(
        route.fromRoom,
        route.toRoom,
        route.resource,
        route.amount,
        route.fee,
        `synthesis:direct:${route.resource}`,
      );
    } else {
      addPlannedRoute(
        route.fromRoom,
        hubRoomName,
        route.resource,
        route.amount,
        route.fee,
        `synthesis:hub-route:${route.resource}`,
      );
    }
  }

  // Active hub reagent demand: reagents the hub needs for its own synthesis.
  // Non-surplus reason, no reservePerRoom subtraction, survives distributedStorage.
  for (const route of hubReagentDemandRoutes) {
    if (route.amount <= 0) continue;
    addPlannedRoute(
      route.fromRoom,
      hubRoomName,
      route.resource,
      route.amount,
      route.fee,
      `synthesis:direct:${route.resource}`,
    );
  }

  // True surplus returns: existing behavior preserved.
  for (const route of hubSurplusRoutes) {
    if (route.amount <= 0) continue;

    const isT3 = T3_TARGETS.includes(route.resource);
    // Hub-bound route decisions without active downstream demand are surplus returns.
    // In distributed storage mode, only T3 surplus remains hub-central.
    if (distributedStorage === true && !isT3) continue;

    const key = `${route.fromRoom}:${route.resource}`;
    const committed = directCommitment[key] || 0;
    const effectiveAmount = route.amount - committed - reservePerRoom;
    if (effectiveAmount <= 0) continue;

    addPlannedRoute(
      route.fromRoom,
      hubRoomName,
      route.resource,
      effectiveAmount,
      route.fee,
      `synthesis:surplus:${route.resource}`,
    );
  }

  cancelStaleSynthesisRouteTasks(new Set(plannedRoutes.keys()));
  for (const route of plannedRoutes.values()) {
    upsertSynthesisRouteTask(route.fromRoom, route.toRoom, route.resource, route.amount, route.reason);
  }
}

function getSynthesisRouteTaskKey(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  reason: string,
): string {
  return `${fromRoomName}->${toRoomName}:${resource}:${reason}`;
}

function upsertSynthesisRouteTask(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason: string,
): void {
  const taskStore = ensureResourceTransferTaskStore();
  for (const task of Object.values(taskStore)) {
    if (
      task.status === "pending" &&
      task.origin === "automatic" &&
      task.fromRoomName === fromRoomName &&
      task.toRoomName === toRoomName &&
      task.resource === resource &&
      task.reason === reason
    ) {
      const normalizedAmount = Math.floor(amount);
      task.amount = normalizedAmount;
      task.remainingAmount = normalizedAmount;
      return;
    }
  }

  createAutomaticResourceTransferTask(fromRoomName, toRoomName, resource, amount, reason);
}

function cancelStaleSynthesisRouteTasks(activeRouteKeys: Set<string>): number {
  const taskStore = ensureResourceTransferTaskStore();
  let cancelled = 0;
  for (const task of Object.values(taskStore)) {
    if (
      task.status === "pending" &&
      task.origin === "automatic" &&
      (task.reason?.startsWith("synthesis:direct:") || task.reason?.startsWith("synthesis:hub-route:") || task.reason?.startsWith("synthesis:surplus:"))
    ) {
      const key = getSynthesisRouteTaskKey(task.fromRoomName, task.toRoomName, task.resource, task.reason);
      if (activeRouteKeys.has(key)) continue;

      task.status = "cancelled";
      task.updatedAt = Game.time;
      task.lastError = "cancelled_by_replan";
      cancelled++;
    }
  }
  return cancelled;
}

export function resupplyBusySynthesisRooms(
  hubRoomName: string,
  hubInventory: Record<string, number>,
  reservePerRoom: number,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): string[] {
  const actions: string[] = [];

  const myRooms = getTickContextService().getMyRooms();
  const synthesisRooms = Memory.runtime?.synthesisControl?.rooms;
  if (!synthesisRooms) return actions;

  for (const room of myRooms) {
    if (room.name === hubRoomName) continue;
    if (!room.controller?.my || !room.terminal || !room.storage) continue;

    const roomState = synthesisRooms[room.name];
    if (!roomState) continue;

    const stage = roomState.stage;
    if (!stage || ACCEPT_REASSIGN_STAGES.has(stage)) continue;

    const missing = roomState.missing;
    if (!missing) continue;

    for (const [resource, deficit] of Object.entries(missing)) {
      if (!deficit || deficit <= 0) continue;
      const rc = resource as ResourceConstant;

      const incoming = transferAmounts.getIncoming(room.name, rc);
      if (incoming >= deficit) continue;

      const needed = deficit - incoming;

      const hubHas = hubInventory[rc] || 0;
      const hubOutgoing = transferAmounts.getOutgoing(hubRoomName, rc);
      const hubExportable = Math.max(0, hubHas - hubOutgoing - reservePerRoom);
      if (hubExportable <= 0) continue;

      const amount = Math.min(needed, hubExportable);
      const reason = `synthesis:resupply:${rc}`;
      const result = createAutomaticResourceTransferTask(hubRoomName, room.name, rc, amount, reason);
      if (typeof result === "object" && result.ok) {
        actions.push(`resupply:${room.name}:${rc}=${amount}`);
      }
    }
  }

  return actions;
}

function getDirectReagents(product: ResourceConstant | undefined): Set<ResourceConstant> {
  if (!product) return new Set();
  const pair = getProductReagentMap()[product];
  if (!pair) return new Set();
  return new Set(pair as ResourceConstant[]);
}

export function wireDistributedSynthesis(
  hubRoomName: string,
  targetCompounds: ResourceConstant[],
  hubReservePerCompound: number,
  reservePerRoom: number,
  hubInventory: Record<string, number>,
  steps: ChainStep[],
  distributedStorage?: boolean,
  effectiveTargetReserve?: number,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): boolean {
  const eligibleRooms = getEligibleSynthesisRooms();
  const auxRooms = eligibleRooms.filter(r => r.roomName !== hubRoomName);

  if (auxRooms.length === 0) {
    return false;
  }

  const plan = planDistributedSynthesis(
    hubRoomName,
    targetCompounds,
    hubReservePerCompound,
    reservePerRoom,
    hubInventory,
    effectiveTargetReserve,
    transferAmounts,
  );

  if (!Memory.runtime?.hub) return true;
  Memory.runtime.hub.distributedSynthesis = {
    roomCapabilities: {},
    dispatchAssignments: plan.dispatchAssignments,
    allocationLedger: plan.allocationLedger,
    routeDecisions: plan.routeDecisions,
  };

  for (const room of eligibleRooms) {
    Memory.runtime.hub.distributedSynthesis.roomCapabilities![room.roomName] = room;
  }

  if (!Memory.cfg) return true;
  if (!Memory.cfg.synthesisControl) {
    Memory.cfg.synthesisControl = {};
  }
  Memory.cfg.synthesisControl.enabled = true;
  if (!Memory.cfg.synthesisControl.rooms) {
    Memory.cfg.synthesisControl.rooms = {};
  }

  for (const assignment of plan.dispatchAssignments) {
    const roomName = assignment.roomName;

    const stage = Memory.runtime?.synthesisControl?.rooms?.[roomName]?.stage;
    if (!canRewriteSynthesisRoom(roomName, stage, transferAmounts)) {
      continue;
    }

    const reagents = getProductReagentMap()[assignment.product];
    if (!reagents) continue;

    if (!Memory.cfg.synthesisControl.rooms[roomName]) {
      Memory.cfg.synthesisControl.rooms[roomName] = {
        enabled: true,
        donorRoomNames: [],
      };
    }

    const roomCfg = Memory.cfg.synthesisControl.rooms[roomName];
    roomCfg.enabled = true;

    const roomObj = Game.rooms[roomName];
    let existingAmount = 0;
    if (roomObj?.storage) {
      const s = roomObj.storage.store as unknown as Record<string, number>;
      existingAmount += (s[assignment.product] || 0);
    }
    if (roomObj?.terminal) {
      const t = roomObj.terminal.store as unknown as Record<string, number>;
      existingAmount += (t[assignment.product] || 0);
    }

    roomCfg.reactions = [
      {
        product: assignment.product,
        targetAmount: roundUpReactionAmount(existingAmount + assignment.targetAmount),
        batchSize: Math.min(3000, Math.max(5, roundUpReactionAmount(assignment.targetAmount))),
        donorRoomNames: [],
      },
    ];
  }

  // Second pass: reconcile busy rooms with dispatch assignments.
  // Three cases: absent (add), matching (no-op), mismatched (replace).
  const existing = Memory.runtime.hub.distributedSynthesis.dispatchAssignments;
  const mismatches: Array<{ roomName: string; oldProduct: ResourceConstant; actualProduct: ResourceConstant }> = [];

  for (const room of eligibleRooms) {
    const runtimeRoom = Memory.runtime?.synthesisControl?.rooms?.[room.roomName];
    const stage = runtimeRoom?.stage;
    if (canRewriteSynthesisRoom(room.roomName, stage, transferAmounts)) continue;

    const activeProduct = runtimeRoom?.activeProduct as ResourceConstant | undefined;
    if (!activeProduct) continue;

    const existingIndex = existing.findIndex(a => a.roomName === room.roomName);

    if (existingIndex < 0) {
      // Absent: push runtime product (preserves existing behavior)
      existing.push({
        roomName: room.roomName,
        product: activeProduct,
        targetAmount: runtimeRoom?.targetAmount ?? 0,
        isHubRoom: room.roomName === hubRoomName,
      });

      const reagents = getProductReagentMap()[activeProduct];
      if (reagents && !Memory.cfg.synthesisControl.rooms[room.roomName]) {
        Memory.cfg.synthesisControl.rooms[room.roomName] = {
          enabled: true,
          donorRoomNames: [],
        };
      }
    } else if (existing[existingIndex].product !== activeProduct) {
      // Mismatched: planner assigned new product but room is busy with different one
      const oldProduct = existing[existingIndex].product as ResourceConstant;
      mismatches.push({ roomName: room.roomName, oldProduct, actualProduct: activeProduct });

      existing[existingIndex] = {
        ...existing[existingIndex],
        product: activeProduct,
        targetAmount: runtimeRoom?.targetAmount ?? 0,
      };
    }
    // else: matching — no change needed
  }

  // Filter stale route decisions for mismatched rooms
  let filteredRouteDecisions = plan.routeDecisions;
  if (mismatches.length > 0) {
    const mismatchMap = new Map(mismatches.map(m => [m.roomName, m]));
    filteredRouteDecisions = plan.routeDecisions.filter(route => {
      const mismatch = mismatchMap.get(route.toRoom);
      if (!mismatch) return true;
      const oldReagents = getDirectReagents(mismatch.oldProduct);
      const actualReagents = getDirectReagents(mismatch.actualProduct);
      // Drop if resource is old-only direct reagent (not shared with actual product)
      return !(oldReagents.has(route.resource as ResourceConstant) && !actualReagents.has(route.resource as ResourceConstant));
    });
    Memory.runtime.hub.distributedSynthesis.routeDecisions = filteredRouteDecisions;
  }

  // Hub-room synthesis config fallback:
  // When distributedStorage is active, the hub room may not appear in dispatch
  // assignments (planner assigns aux rooms instead). This block ensures the hub
  // room's synthesisControl config stays synchronized with the chain steps,
  // using the same write-pattern as writeSynthesisConfig.
  //
  // Guard: when the plan DOES include an explicit hub-room dispatch assignment,
  // the first-pass assignment writer above already owns the hub room config. The
  // fallback must not run in that case — otherwise, with empty `steps`, it would
  // clear the just-written hub assignment (e.g. reactions=[] overwriting UH).
  if (distributedStorage) {
    const hubHasDispatchAssignment = plan.dispatchAssignments.some(a => a.roomName === hubRoomName);
    if (!hubHasDispatchAssignment) {
      const hubStage = Memory.runtime?.synthesisControl?.rooms?.[hubRoomName]?.stage;
      if (canRewriteSynthesisRoom(hubRoomName, hubStage, transferAmounts)) {
        const nextStep = steps.length > 0 ? steps[0] : null;

        if (!nextStep) {
          const roomCfg = Memory.cfg.synthesisControl.rooms[hubRoomName];
          if (roomCfg) {
            roomCfg.reactions = [];
          }
        } else {
          if (!Memory.cfg.synthesisControl.rooms[hubRoomName]) {
            Memory.cfg.synthesisControl.rooms[hubRoomName] = {
              enabled: true,
              donorRoomNames: [],
            };
          }

          const roomCfg = Memory.cfg.synthesisControl.rooms[hubRoomName];
          roomCfg.enabled = true;
          roomCfg.reactions = [
            {
              product: nextStep.product,
              targetAmount: roundUpReactionAmount((hubInventory[nextStep.product] || 0) + nextStep.targetAmount),
              batchSize: Math.min(3000, Math.max(5, roundUpReactionAmount(nextStep.targetAmount))),
              donorRoomNames: [],
            },
          ];
        }
      }
    }
  }

  wireRouteTransferTasks(filteredRouteDecisions, hubRoomName, reservePerRoom, distributedStorage);

  return true;
}

export function runHubPlanner(): void {
  let cfg = Memory.cfg?.hub;
  if (cfg?.enabled !== true || !cfg.hubRoomName) {
    if (cfg?.hubRoomName) clearHubSynthesisReactions(cfg.hubRoomName);
    return;
  }

  cfg = normalizeHubConfig(cfg);
  if (cfg !== Memory.cfg?.hub) {
    Memory.cfg!.hub = cfg;
  }

  const rt = Memory.runtime?.hub;
  if (!rt) return;

  const onCadence = Game.time % (cfg.planInterval || 50) === 0;
  if (!onCadence && rt.needsPlan !== true) return;

  const room = Game.rooms[cfg.hubRoomName];
  if (!room) {
    rt.status = "blocked";
    clearHubSynthesisReactions(cfg.hubRoomName);
    return;
  }

  if (!room.controller?.my) {
    rt.status = "blocked";
    clearHubSynthesisReactions(cfg.hubRoomName);
    return;
  }

  if (!room.storage) {
    rt.status = "blocked";
    clearHubSynthesisReactions(cfg.hubRoomName);
    return;
  }

  if (!room.terminal) {
    rt.status = "blocked";
    clearHubSynthesisReactions(cfg.hubRoomName);
    return;
  }

  if (countLabs(room) < 3) {
    rt.status = "blocked";
    clearHubSynthesisReactions(cfg.hubRoomName);
    return;
  }

  const hubInventory: Record<string, number> = {};
  const storage = room.storage.store as unknown as Record<string, number>;
  for (const [res, amt] of Object.entries(storage)) {
    if (res !== RESOURCE_ENERGY && amt > 0) {
      hubInventory[res] = amt;
    }
  }
  const terminal = room.terminal.store as unknown as Record<string, number>;
  for (const [res, amt] of Object.entries(terminal)) {
    if (res !== RESOURCE_ENERGY && amt > 0) {
      hubInventory[res] = (hubInventory[res] || 0) + amt;
    }
  }

  // Include lab/factory/power-spawn mineral contents so hub inventory agrees
  // with synthesisControl roomResourceAmount (which also counts these structures).
  const labLikeStructures = room.find(FIND_MY_STRUCTURES, {
    filter: (s: Structure) =>
      s.structureType === STRUCTURE_LAB ||
      s.structureType === STRUCTURE_FACTORY ||
      s.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of labLikeStructures) {
    if (!structure.store) continue;
    const store = structure.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(store)) {
      if (res !== RESOURCE_ENERGY && amt > 0) {
        hubInventory[res] = (hubInventory[res] || 0) + amt;
      }
    }
  }

  const carrierCargo = collectCarrierCargoInventory(cfg.hubRoomName);
  for (const [res, amt] of Object.entries(carrierCargo)) {
    if (amt > 0) {
      hubInventory[res] = (hubInventory[res] || 0) + amt;
    }
  }

  const allRelevantResources = [...BASE_MINERALS, ...INTERMEDIATE_COMPOUNDS, ...T3_TARGETS];
  const transferAmountsBeforeImports = createResourceTransferTaskAmountIndex();
  const incomingResources: Record<string, number> = {};
  for (const res of allRelevantResources) {
    const amount = transferAmountsBeforeImports.getIncoming(cfg.hubRoomName, res);
    if (amount > 0) {
      incomingResources[res] = amount;
    }
  }

  const hubReservePerCompound = cfg.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND;
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;
  const satelliteDeficit = computeTotalSatelliteDeficit(cfg, targetCompounds, transferAmountsBeforeImports);
  const chainTarget = hubReservePerCompound + satelliteDeficit;

  const result = planHubChains(hubInventory, incomingResources, chainTarget, targetCompounds);

  planHubImports(cfg, transferAmountsBeforeImports);
  const transferAmountsAfterImports = createResourceTransferTaskAmountIndex();

  rt.needsPlan = false;
  rt.lastPlanTick = Game.time;
  rt.updatedAt = Game.time;

  const distributedPreview = result.blocked
    ? planDistributedSynthesis(
        cfg.hubRoomName,
        targetCompounds,
        hubReservePerCompound,
        cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM,
        hubInventory,
        chainTarget,
        transferAmountsAfterImports,
      )
    : null;
  const distributedAssignments = distributedPreview?.dispatchAssignments ?? [];
  const distributedCanProceed = distributedAssignments.length > 0;

  rt.missingResources = result.blocked && !distributedCanProceed
    ? result.missingResources.slice(0, HUB_RUNTIME_ARRAY_CAP)
    : [];

  if (result.blocked && !distributedCanProceed) {
    rt.status = "blocked";
    rt.activeProduct = "";
    rt.activeStep = 0;
    rt.lastPlanActions = [];
    clearHubSynthesisReactions(cfg.hubRoomName);
  } else if (result.steps.length === 0 && !distributedCanProceed) {
    rt.status = "distributing";
    rt.activeProduct = "";
    rt.activeStep = 0;
    rt.lastPlanActions = [];
  } else {
    rt.status = "importing";
    rt.activeProduct = result.steps[0]?.product ?? distributedAssignments[0]?.product ?? "";
    rt.activeStep = 0;
    rt.lastPlanActions = (result.steps.length > 0
      ? result.steps.map((s) => s.product)
      : distributedAssignments.map((assignment) => assignment.product)
    ).slice(0, HUB_RUNTIME_ARRAY_CAP);
  }

  if (!result.blocked || distributedCanProceed) {
    const hubReservePerCompound2 = cfg.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND;
    const reservePerRoom2 = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
    const targetCompounds2 = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;

    const distributed = wireDistributedSynthesis(
      cfg.hubRoomName,
      targetCompounds2,
      hubReservePerCompound2,
      reservePerRoom2,
      hubInventory,
      result.steps,
      cfg.distributedStorage,
      chainTarget,
      transferAmountsAfterImports,
    );

    if (!distributed) {
      writeSynthesisConfig(cfg.hubRoomName, result.steps, hubInventory);
    }
  }

  const reservePerRoom3 = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  resupplyBusySynthesisRooms(cfg.hubRoomName, hubInventory, reservePerRoom3);

  if (room.storage && room.terminal) {
    planHubDistribution(cfg);
  }

  computeAndStoreMarketSellSurplus(cfg, hubInventory, chainTarget, targetCompounds);
}

function computeAndStoreMarketSellSurplus(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  hubInventory: Record<string, number>,
  chainTarget: number,
  targetCompounds: ResourceConstant[],
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): void {
  const surplus: Partial<Record<ResourceConstant, number>> = {};
  const hubRoomName = cfg.hubRoomName;

  for (const [res, amount] of Object.entries(hubInventory)) {
    if (res === RESOURCE_ENERGY || res === RESOURCE_POWER || res === RESOURCE_OPS) {
      continue;
    }
    if (amount <= 0) continue;
    const resource = res as ResourceConstant;

    if (!targetCompounds.includes(resource)) {
      continue;
    }

    const outgoing = transferAmounts.getOutgoing(hubRoomName, resource);
    const effective = Math.max(0, amount - outgoing);

    const sellable = Math.max(0, effective - chainTarget);
    if (sellable >= 100) {
      surplus[resource] = sellable;
    }
  }

  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.hub) Memory.runtime.hub = {};
  Memory.runtime.hub.marketSellSurplus = surplus;
}
