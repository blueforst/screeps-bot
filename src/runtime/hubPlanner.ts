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

import { createResourceTransferTask, ensureResourceTransferTaskStore, getIncomingResourceTransferAmount } from "@/runtime/logistics/resourceTransferTasks";
import { getTickContextService } from "@/runtime/runtimeServices";
import { collectCarrierCargoInventory } from "@/runtime/hubProgress";

const DEFAULT_TARGET_COMPOUNDS: ResourceConstant[] = [
  RESOURCE_CATALYZED_UTRIUM_ACID, // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE, // XUHO2
  RESOURCE_CATALYZED_KEANIUM_ACID, // XKH2O
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE, // XKHO2
  RESOURCE_CATALYZED_LEMERGIUM_ACID, // XLH2O
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
  RESOURCE_CATALYZED_ZYNTHIUM_ACID, // XZH2O
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, // XZHO2
  RESOURCE_CATALYZED_GHODIUM_ACID, // XGH2O
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
];

const DEFAULT_RESERVE_PER_ROOM = 1000;

export function getDefaultHubConfig(): NonNullable<Memory["cfg"]>["hub"] {
  return {
    enabled: false,
    hubRoomName: "",
    planInterval: 50,
    reservePerRoom: DEFAULT_RESERVE_PER_ROOM,
    hubReservePerCompound: 20000,
    targetCompounds: [...DEFAULT_TARGET_COMPOUNDS],
    storagePauseFreeCapacity: 100_000,
    surplusThreshold: DEFAULT_RESERVE_PER_ROOM + 500,
    internalOnly: true,
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
      return { ...cfg, targetCompounds: [...DEFAULT_TARGET_COMPOUNDS] };
    }
  }
  return cfg;
}

export interface ChainStep {
  product: ResourceConstant;
  targetAmount: number;
  reagents: [ResourceConstant, ResourceConstant];
}

const REACTION_MAP: Record<string, [ResourceConstant, ResourceConstant]> = {
  // Base intermediates
  [RESOURCE_HYDROXIDE]: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN],
  [RESOURCE_ZYNTHIUM_KEANITE]: [RESOURCE_ZYNTHIUM, RESOURCE_KEANIUM],
  [RESOURCE_UTRIUM_LEMERGITE]: [RESOURCE_UTRIUM, RESOURCE_LEMERGIUM],
  [RESOURCE_GHODIUM]: [RESOURCE_ZYNTHIUM_KEANITE, RESOURCE_UTRIUM_LEMERGITE],
  // U chains (Utrium)
  [RESOURCE_UTRIUM_HYDRIDE]: [RESOURCE_UTRIUM, RESOURCE_HYDROGEN],
  [RESOURCE_UTRIUM_OXIDE]: [RESOURCE_UTRIUM, RESOURCE_OXYGEN],
  [RESOURCE_UTRIUM_ACID]: [RESOURCE_UTRIUM_HYDRIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_UTRIUM_ALKALIDE]: [RESOURCE_UTRIUM_OXIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_CATALYZED_UTRIUM_ACID]: [RESOURCE_CATALYST, RESOURCE_UTRIUM_ACID],
  [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: [RESOURCE_CATALYST, RESOURCE_UTRIUM_ALKALIDE],
  // K chains (Keanium)
  [RESOURCE_KEANIUM_HYDRIDE]: [RESOURCE_KEANIUM, RESOURCE_HYDROGEN],
  [RESOURCE_KEANIUM_OXIDE]: [RESOURCE_KEANIUM, RESOURCE_OXYGEN],
  [RESOURCE_KEANIUM_ACID]: [RESOURCE_KEANIUM_HYDRIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_KEANIUM_ALKALIDE]: [RESOURCE_KEANIUM_OXIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_CATALYZED_KEANIUM_ACID]: [RESOURCE_CATALYST, RESOURCE_KEANIUM_ACID],
  [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: [RESOURCE_CATALYST, RESOURCE_KEANIUM_ALKALIDE],
  // L chains (Lemergium)
  [RESOURCE_LEMERGIUM_HYDRIDE]: [RESOURCE_LEMERGIUM, RESOURCE_HYDROGEN],
  [RESOURCE_LEMERGIUM_OXIDE]: [RESOURCE_LEMERGIUM, RESOURCE_OXYGEN],
  [RESOURCE_LEMERGIUM_ACID]: [RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_LEMERGIUM_ALKALIDE]: [RESOURCE_LEMERGIUM_OXIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_CATALYZED_LEMERGIUM_ACID]: [RESOURCE_CATALYST, RESOURCE_LEMERGIUM_ACID],
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: [RESOURCE_CATALYST, RESOURCE_LEMERGIUM_ALKALIDE],
  // Z chains (Zynthium)
  [RESOURCE_ZYNTHIUM_HYDRIDE]: [RESOURCE_ZYNTHIUM, RESOURCE_HYDROGEN],
  [RESOURCE_ZYNTHIUM_OXIDE]: [RESOURCE_ZYNTHIUM, RESOURCE_OXYGEN],
  [RESOURCE_ZYNTHIUM_ACID]: [RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_ZYNTHIUM_ALKALIDE]: [RESOURCE_ZYNTHIUM_OXIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: [RESOURCE_CATALYST, RESOURCE_ZYNTHIUM_ACID],
  [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: [RESOURCE_CATALYST, RESOURCE_ZYNTHIUM_ALKALIDE],
  // G chains (Ghodium)
  [RESOURCE_GHODIUM_HYDRIDE]: [RESOURCE_GHODIUM, RESOURCE_HYDROGEN],
  [RESOURCE_GHODIUM_OXIDE]: [RESOURCE_GHODIUM, RESOURCE_OXYGEN],
  [RESOURCE_GHODIUM_ACID]: [RESOURCE_GHODIUM_HYDRIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_GHODIUM_ALKALIDE]: [RESOURCE_GHODIUM_OXIDE, RESOURCE_HYDROXIDE],
  [RESOURCE_CATALYZED_GHODIUM_ACID]: [RESOURCE_CATALYST, RESOURCE_GHODIUM_ACID],
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: [RESOURCE_CATALYST, RESOURCE_GHODIUM_ALKALIDE],
};

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

  // 2. Seed demand only for the target compounds parameter
  const needed: Record<string, number> = {};
  for (const t3 of targetCompounds) {
    const have = available[t3] || 0;
    const deficit = Math.max(0, targetReserve - have);
    if (deficit > 0) {
      needed[t3] = deficit;
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
      const reagents = REACTION_MAP[product];
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

    const reagents = REACTION_MAP[product];
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

export function planHubImports(cfg: NonNullable<Memory["cfg"]>["hub"]): string[] {
  if (!cfg?.hubRoomName) return [];

  const hubRoom = Game.rooms[cfg.hubRoomName];
  if (!hubRoom?.storage) return [];

  const hubFreeCapacity = hubRoom.storage.store.getFreeCapacity();
  if (hubFreeCapacity < (cfg.storagePauseFreeCapacity ?? 100_000)) return [];

  const actions: string[] = [];
  const reservePerRoom = cfg.reservePerRoom ?? DEFAULT_RESERVE_PER_ROOM;
  const surplusThreshold = cfg.surplusThreshold ?? (DEFAULT_RESERVE_PER_ROOM + 500);
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : DEFAULT_TARGET_COMPOUNDS;

  const existingKeys = new Set<string>();
  const taskStore = ensureResourceTransferTaskStore();
  for (const task of Object.values(taskStore)) {
    if (task.status === "pending" && task.toRoomName === cfg.hubRoomName) {
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

    for (const mineral of BASE_MINERALS) {
      const amount = satResources[mineral] || 0;
      if (amount <= BASE_MINERAL_SAFETY_FLOOR) continue;
      const sendAmount = amount - BASE_MINERAL_SAFETY_FLOOR;
      if (sendAmount < MIN_HUB_IMPORT_AMOUNT) continue;
      const reason = `hub:import:${mineral}`;
      const key = `${satellite.name}:${mineral}:${reason}`;
      if (existingKeys.has(key)) continue;
      const result = createResourceTransferTask(satellite.name, cfg.hubRoomName, mineral, sendAmount, reason);
      if (typeof result === "object" && result.ok) {
        actions.push(`import:${satellite.name}:${mineral}=${sendAmount}`);
      }
    }

    for (const compound of INTERMEDIATE_COMPOUNDS) {
      const amount = satResources[compound] || 0;
      if (amount <= 0) continue;
      if (amount < MIN_HUB_IMPORT_AMOUNT) continue;
      const reason = `hub:import:${compound}`;
      const key = `${satellite.name}:${compound}:${reason}`;
      if (existingKeys.has(key)) continue;
      const result = createResourceTransferTask(satellite.name, cfg.hubRoomName, compound, amount, reason);
      if (typeof result === "object" && result.ok) {
        actions.push(`import:${satellite.name}:${compound}=${amount}`);
      }
    }

    for (const t3 of targetCompounds) {
      const amount = satResources[t3] || 0;
      if (amount <= surplusThreshold) continue;
      const sendAmount = amount - reservePerRoom;
      const reason = `hub:reclaim:${t3}`;
      const key = `${satellite.name}:${t3}:${reason}`;
      if (existingKeys.has(key)) continue;
      const result = createResourceTransferTask(satellite.name, cfg.hubRoomName, t3, sendAmount, reason);
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

  const reservePerRoom = cfg.reservePerRoom ?? DEFAULT_RESERVE_PER_ROOM;
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : DEFAULT_TARGET_COMPOUNDS;

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
      task.status === "pending" &&
      task.fromRoomName === cfg.hubRoomName &&
      task.reason?.startsWith("hub:export:")
    ) {
      hubPendingOutgoing[task.resource] = (hubPendingOutgoing[task.resource] || 0) + task.remainingAmount;
    }
  }

  const hubReservePerCompound = cfg.hubReservePerCompound ?? 20000;
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
    if (satStorageFree + satTerminalFree < 10000) continue;

    for (const t3 of targetCompounds) {
      if (hubRemaining[t3] <= 0) continue;

      const satStorage = satellite.storage!.store as unknown as Record<string, number>;
      const satTerminal = satellite.terminal!.store as unknown as Record<string, number>;
      const current = (satStorage[t3] || 0) + (satTerminal[t3] || 0);

      const effectiveTotal = current;
      if (effectiveTotal >= reservePerRoom) continue;

      const shortage = reservePerRoom - effectiveTotal;
      const cappedByHub = Math.min(shortage, hubRemaining[t3]);
      const terminalFree = satellite.terminal!.store.getFreeCapacity();
      const amount = Math.min(cappedByHub, terminalFree);

      if (amount <= 0) continue;

      const reason = `hub:export:${t3}`;
      const result = createResourceTransferTask(cfg.hubRoomName, satellite.name, t3, amount, reason);

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
      targetAmount: (hubInventory[nextStep.product] || 0) + nextStep.targetAmount,
      batchSize: Math.min(3000, Math.max(5, Math.ceil(nextStep.targetAmount / 5) * 5)),
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
): number {
  const reservePerRoom = cfg.reservePerRoom ?? DEFAULT_RESERVE_PER_ROOM;
  const taskStore = ensureResourceTransferTaskStore();
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
      let pendingIncoming = 0;
      for (const task of Object.values(taskStore)) {
        if (
          task.status === "pending" &&
          task.toRoomName === satellite.name &&
          task.resource === t3 &&
          task.reason?.startsWith("hub:export:")
        ) {
          pendingIncoming += task.remainingAmount;
        }
      }

      const effectiveTotal = current + pendingIncoming;
      const deficit = Math.max(0, reservePerRoom - effectiveTotal);
      totalDeficit += deficit;
    }
  }
  return totalDeficit;
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
  const incomingResources: Record<string, number> = {};
  for (const res of allRelevantResources) {
    const amount = getIncomingResourceTransferAmount(cfg.hubRoomName, res);
    if (amount > 0) {
      incomingResources[res] = amount;
    }
  }

  const hubReservePerCompound = cfg.hubReservePerCompound ?? 20000;
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : DEFAULT_TARGET_COMPOUNDS;
  const satelliteDeficit = computeTotalSatelliteDeficit(cfg, targetCompounds);
  const chainTarget = hubReservePerCompound + satelliteDeficit;

  const result = planHubChains(hubInventory, incomingResources, chainTarget, targetCompounds);

  const importActions = planHubImports(cfg);

  rt.needsPlan = false;
  rt.updatedAt = Game.time;
  rt.missingResources = result.missingResources.slice(0, HUB_RUNTIME_ARRAY_CAP);

  if (result.blocked) {
    rt.status = "blocked";
    rt.activeProduct = "";
    rt.activeStep = 0;
    rt.lastPlanActions = [];
    clearHubSynthesisReactions(cfg.hubRoomName);
  } else if (result.steps.length === 0) {
    rt.status = "distributing";
    rt.activeProduct = "";
    rt.activeStep = 0;
    rt.lastPlanActions = [];
  } else {
    rt.status = "importing";
    rt.activeProduct = result.steps[0].product;
    rt.activeStep = 0;
    rt.lastPlanActions = result.steps.map((s) => s.product).slice(0, HUB_RUNTIME_ARRAY_CAP);
  }

  if (!result.blocked) {
    writeSynthesisConfig(cfg.hubRoomName, result.steps, hubInventory);
  }

  if (room.storage && room.terminal) {
    planHubDistribution(cfg);
  }
}
