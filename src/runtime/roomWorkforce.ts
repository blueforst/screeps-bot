import { hasSourceAdjacentLink } from "@/runtime/sourceLink";
import { isRoomInReserveMode } from "@/runtime/roomReserve";

const DEFAULT_WORKER_MAX = 8;
const DEFAULT_WORKER_BASE = 1;

type SourceWorkerRole = "harvester" | "miner";

function isMineralEligibleForHarvest(mineral: Mineral): boolean {
  if (mineral.mineralAmount <= 0) {
    return false;
  }

  const structures = mineral.pos.findInRange(FIND_STRUCTURES, 1);
  const hasExtractor = structures.some((structure) => structure.structureType === STRUCTURE_EXTRACTOR);
  const hasContainer = structures.some((structure) => structure.structureType === STRUCTURE_CONTAINER);
  return hasExtractor && hasContainer;
}

export function getEligibleMineralIds(room: Room): string[] {
  return room
    .find(FIND_MINERALS)
    .filter((mineral) => isMineralEligibleForHarvest(mineral))
    .map((mineral) => mineral.id);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function hasNormalRepairTask(room: Room): boolean {
  const tasks = room.memory.tasks;
  if (!tasks) {
    return false;
  }

  return Object.values(tasks).some((task) => task.type === "repair" && task.repairMode === "normal" && task.status === "active");
}

function getConstructionBonusWithHysteresis(room: Room, constructionCount: number): number {
  let tier = room.memory.workerConstructionTier;
  if (tier === undefined) {
    if (constructionCount >= 15) {
      tier = 3;
    } else if (constructionCount >= 6) {
      tier = 2;
    } else if (constructionCount >= 1) {
      tier = 1;
    } else {
      tier = 0;
    }
  }

  if (tier < 1 && constructionCount >= 1) {
    tier = 1;
  }
  if (tier >= 1 && constructionCount <= 0) {
    tier = 0;
  }

  if (tier < 2 && constructionCount >= 6) {
    tier = 2;
  }
  if (tier >= 2 && constructionCount <= 4) {
    tier = 1;
  }

  if (tier < 3 && constructionCount >= 15) {
    tier = 3;
  }
  if (tier >= 3 && constructionCount <= 12) {
    tier = 2;
  }

  room.memory.workerConstructionTier = tier;
  return tier;
}

export function getWorkerCap(): number {
  const configured = Memory.cfg?.worker?.maxPerRoom;
  const cap = typeof configured === "number" ? configured : DEFAULT_WORKER_MAX;
  return clamp(cap, 1, 10);
}

export function getDesiredWorkerCount(room: Room): number {
  const cap = getWorkerCap();
  const rcl = room.controller?.level ?? 1;
  let desired = rcl < 4 ? 6 - rcl : DEFAULT_WORKER_BASE;

  const constructionCount = room.find(FIND_CONSTRUCTION_SITES).length;
  desired += getConstructionBonusWithHysteresis(room, constructionCount);

  if (hasNormalRepairTask(room)) {
    desired += 1;
  }

  return clamp(desired, 1, cap);
}

export function getExpectedManagedConfigNames(room: Room): string[] {
  const names: string[] = [];

  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    const role: SourceWorkerRole = hasSourceAdjacentLink(source) ? "miner" : "harvester";
    names.push(`${room.name}:${role}:${source.id}`);
  }

  const mineralIds = getEligibleMineralIds(room);
  for (const mineralId of mineralIds) {
    names.push(`${room.name}:mineralHarvester:${mineralId}`);
  }

  const carrierCount = (room.controller?.level ?? 0) <= 2 ? 2 : 1;
  for (let i = 0; i < carrierCount; i++) {
    names.push(`${room.name}:carrier:${i}`);
  }

  if (!isRoomInReserveMode(room.name)) {
    const workerCount = getDesiredWorkerCount(room);
    for (let i = 0; i < workerCount; i++) {
      names.push(`${room.name}:worker:${i}`);
    }
  }

  return names;
}
