import { getProductionSignal } from "@/runtime/productionMonitor";

const DEFAULT_WORKER_MAX = 4;
const DEFAULT_WORKER_BASE = 1;
const DEFAULT_DYNAMIC_MAX_BONUS = 2;

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

export function getWorkerCap(room: Room): number {
  const configured = Memory.cfg?.worker?.maxPerRoom;
  const cap = typeof configured === "number" ? configured : DEFAULT_WORKER_MAX;
  return clamp(cap, 1, 10);
}

function getLooseEnergy(room: Room): number {
  const dropped = room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const droppedEnergy = dropped.reduce((sum, resource) => sum + resource.amount, 0);

  const containers = room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_CONTAINER &&
      (structure as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as StructureContainer[];
  const containerEnergy = containers.reduce((sum, container) => sum + container.store.getUsedCapacity(RESOURCE_ENERGY), 0);

  return droppedEnergy + containerEnergy;
}

function getDynamicMaxBonus(): number {
  const configured = Memory.cfg?.worker?.dynamicMaxBonus;
  if (typeof configured !== "number") {
    return DEFAULT_DYNAMIC_MAX_BONUS;
  }

  return clamp(Math.floor(configured), 0, 5);
}

function getDynamicBonusBeforeRcl4(room: Room): number {
  if (Memory.cfg?.worker?.dynamicBeforeRcl4 === false) {
    return 0;
  }

  const looseEnergy = getLooseEnergy(room);
  const roomName = room.name;

  Memory.runtime = Memory.runtime || {};
  Memory.runtime.workerDynamic = Memory.runtime.workerDynamic || {};
  const previous = Memory.runtime.workerDynamic[roomName];

  const delta = previous ? looseEnergy - previous.lastLooseEnergy : 0;
  const trend = previous ? previous.trend * 0.7 + delta * 0.3 : delta;
  Memory.runtime.workerDynamic[roomName] = {
    lastLooseEnergy: looseEnergy,
    trend,
    lastTick: Game.time,
  };

  let bonus = 0;
  if (looseEnergy >= 400) {
    bonus += 1;
  }
  if (looseEnergy >= 1000) {
    bonus += 1;
  }
  if (trend >= 80) {
    bonus += 1;
  }

  const energyRatio = room.energyCapacityAvailable > 0 ? room.energyAvailable / room.energyCapacityAvailable : 0;
  if (energyRatio < 0.25 && looseEnergy < 200) {
    bonus -= 1;
  }
  if (trend <= -80) {
    bonus -= 1;
  }

  const maxBonus = getDynamicMaxBonus();
  const monitorSignal = getProductionSignal(room.name);
  if (monitorSignal) {
    if (monitorSignal.looseEnergyTrend >= 8) {
      bonus += 1;
    }
    if (monitorSignal.sourceEnergyTrend >= 6) {
      bonus += 1;
    }
    if (monitorSignal.upgradeRate <= 1 && monitorSignal.looseEnergyTrend > 0) {
      bonus += 1;
    }
    if (monitorSignal.spawnBusy >= 0.95 && monitorSignal.looseEnergyTrend <= 0) {
      bonus -= 1;
    }
  }

  return clamp(bonus, -1, maxBonus);
}

export function getDesiredWorkerCount(room: Room): number {
  const cap = getWorkerCap(room);
  const rcl = room.controller?.level ?? 1;
  let desired = rcl < 4 ? 5 - rcl : DEFAULT_WORKER_BASE;

  if (rcl < 4) {
    desired += getDynamicBonusBeforeRcl4(room);
  }

  const constructionCount = room.find(FIND_CONSTRUCTION_SITES).length;
  if (constructionCount >= 1) {
    desired += 1;
  }
  if (constructionCount >= 6) {
    desired += 1;
  }
  if (constructionCount >= 15) {
    desired += 1;
  }

  return clamp(desired, 1, cap);
}

export function getExpectedManagedConfigNames(room: Room): string[] {
  const names: string[] = [];

  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    names.push(`${room.name}:harvester:${source.id}`);
  }

  names.push(`${room.name}:carrier:0`);

  const workerCount = getDesiredWorkerCount(room);
  for (let i = 0; i < workerCount; i++) {
    names.push(`${room.name}:worker:${i}`);
  }

  return names;
}
