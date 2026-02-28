import {
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} from "@/runtime/energyPickupReservation";
import { isReceiverLink } from "@/runtime/linkControl";

function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  return target instanceof RoomPosition ? target : target.pos;
}

interface MoveToTargetOptions {
  swampCost?: number;
  plainCost?: number;
  reusePath?: number;
  maxRooms?: number;
}

interface MoveToRoomOptions extends MoveToTargetOptions {
  travelRange?: 1 | 3;
}

export type EnergyPickupTarget = Resource | AnyStoreStructure | Tombstone;

export function isDroppedResourceTarget(target: EnergyPickupTarget): target is Resource {
  return (target as Resource).amount !== undefined;
}

export function moveToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range: 0 | 1 | 3 = 1,
  options: MoveToTargetOptions = {},
): ScreepsReturnCode {
  const targetPos = getTargetPos(target);
  return creep.moveTo(targetPos, {
    range,
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    reusePath: options.reusePath,
    maxRooms: options.maxRooms,
    visualizePathStyle: { stroke: "#ffaa00" },
  });
}

function parseEncodedRouteRooms(encodedRouteRooms?: string): string[] {
  if (!encodedRouteRooms) {
    return [];
  }

  return encodedRouteRooms
    .split("|")
    .map((roomName) => roomName.trim())
    .filter((roomName) => roomName.length > 0);
}

function getNearestRouteRoom(currentRoom: string, routeRooms: string[], targetRoom: string): string {
  const nonTargetRooms = routeRooms.filter((roomName) => roomName !== targetRoom);
  const candidates = nonTargetRooms.length > 0 ? nonTargetRooms : routeRooms;

  let bestRoom = candidates[0];
  let bestDistance = Game.map.getRoomLinearDistance(currentRoom, bestRoom);
  for (let i = 1; i < candidates.length; i++) {
    const distance = Game.map.getRoomLinearDistance(currentRoom, candidates[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRoom = candidates[i];
    }
  }

  return bestRoom;
}

function getNextRouteRoom(currentRoom: string, routeRooms: string[], fallbackRoom: string): string {
  if (routeRooms.length === 0) {
    return fallbackRoom;
  }

  const currentIndex = routeRooms.indexOf(currentRoom);
  if (currentIndex >= 0) {
    for (let i = currentIndex + 1; i < routeRooms.length; i++) {
      if (routeRooms[i] !== currentRoom) {
        return routeRooms[i];
      }
    }
  }

  return getNearestRouteRoom(currentRoom, routeRooms, fallbackRoom);
}

export function moveToTargetRoom(
  creep: Creep,
  targetRoom: string,
  encodedRouteRooms?: string,
  options: MoveToRoomOptions = {},
): ScreepsReturnCode {
  if (creep.room.name === targetRoom) {
    return OK;
  }

  const routeRooms = parseEncodedRouteRooms(encodedRouteRooms);
  const nextRoom = getNextRouteRoom(creep.room.name, routeRooms, targetRoom);
  const moveRange = options.travelRange ?? 1;
  const moveOptions: MoveToTargetOptions = {
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    reusePath: options.reusePath ?? 10,
    maxRooms: options.maxRooms ?? Math.max(routeRooms.length + 1, 16),
  };

  if (nextRoom !== creep.room.name) {
    const exitDirection = creep.room.findExitTo(nextRoom);
    if (typeof exitDirection === "number" && exitDirection >= 1 && exitDirection <= 8) {
      const exitPos = creep.pos.findClosestByPath(exitDirection as ExitConstant);
      if (exitPos) {
        return moveToTarget(creep, exitPos, 0, moveOptions);
      }
    }
  }

  return moveToTarget(creep, new RoomPosition(25, 25, nextRoom), moveRange, moveOptions);
}

export function moveToRemoteWorkTarget(creep: Creep, target: RoomPosition | { pos: RoomPosition }): ScreepsReturnCode {
  const targetPos = getTargetPos(target);
  if (creep.pos.getRangeTo(targetPos) <= 3) {
    return OK;
  }

  const path = creep.pos.findPathTo(targetPos, {
    range: 3,
    ignoreCreeps: false,
    swampCost: 8,
  });

  if (path.length === 0) {
    return ERR_NO_PATH;
  }

  return creep.moveByPath(path);
}

interface EnergyStoreTargetOptions {
  excludeIds?: string[];
}

export function getEnergyStoreTarget(creep: Creep, options: EnergyStoreTargetOptions = {}): AnyStoreStructure | null {
  const excludeSet = new Set(options.excludeIds || []);

  const spawnAndExtensionTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id)) {
        return false;
      }

      if (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) {
        return (structure as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
      return false;
    },
  });

  if (spawnAndExtensionTargets.length > 0) {
    return creep.pos.findClosestByRange(spawnAndExtensionTargets) as AnyStoreStructure;
  }

  const towerTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id) || structure.structureType !== STRUCTURE_TOWER) {
        return false;
      }

      const tower = structure as StructureTower;
      const used = tower.store.getUsedCapacity(RESOURCE_ENERGY);
      const capacity = tower.store.getCapacity(RESOURCE_ENERGY);
      return capacity > 0 && tower.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && used <= capacity * 0.6;
    },
  });

  if (towerTargets.length > 0) {
    return creep.pos.findClosestByRange(towerTargets) as AnyStoreStructure;
  }

  if (creep.room.storage && !excludeSet.has(creep.room.storage.id)) {
    return creep.room.storage;
  }

  return null;
}

function getTargetEnergyAmount(target: EnergyPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function getPreferredEnergyPickupCandidates(creep: Creep): EnergyPickupTarget[] {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const structureCandidates = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      (structure.structureType === STRUCTURE_CONTAINER ||
        structure.structureType === STRUCTURE_STORAGE ||
        (structure.structureType === STRUCTURE_LINK && isReceiverLink(structure as StructureLink))) &&
      (structure as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as AnyStoreStructure[];
  const tombstones = creep.room.find(FIND_TOMBSTONES, {
    filter: (tombstone) => tombstone.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const candidates: EnergyPickupTarget[] = [...dropped, ...structureCandidates, ...tombstones];
  if (candidates.length === 0) {
    return [];
  }

  const threshold = creep.store.getCapacity(RESOURCE_ENERGY) ?? 0;
  const richCandidates = candidates.filter((target) => getTargetEnergyAmount(target) >= threshold);
  const preferred = richCandidates.length > 0 ? richCandidates : candidates;

  return preferred.sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos));
}

export function getPreferredEnergyPickupTarget(creep: Creep): EnergyPickupTarget | null {
  const candidates = getPreferredEnergyPickupCandidates(creep);
  return candidates.length > 0 ? candidates[0] : null;
}

interface PickupResult {
  picked: boolean;
  outOfRange: boolean;
}

export function pickupEnergyFromPreferredTarget(creep: Creep, moveOptions: MoveToTargetOptions = {}): PickupResult {
  const desiredAmount = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

  let sourceTarget = getReservedPickupTarget(creep) as EnergyPickupTarget | null;
  if (sourceTarget && !reservePickupTarget(creep, sourceTarget, desiredAmount)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (!sourceTarget) {
    const candidates = getPreferredEnergyPickupCandidates(creep);
    for (const candidate of candidates) {
      if (reservePickupTarget(creep, candidate, desiredAmount)) {
        sourceTarget = candidate;
        break;
      }
    }
  }

  if (!sourceTarget) {
    return { picked: false, outOfRange: false };
  }

  if (isDroppedResourceTarget(sourceTarget)) {
    const pickupCode = creep.pickup(sourceTarget);
    if (pickupCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget, 1, moveOptions);
      return { picked: false, outOfRange: true };
    }

    if (pickupCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    if (pickupCode === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      releasePickupReservation(creep, sourceTarget.id);
    }

    return { picked: pickupCode === OK, outOfRange: false };
  }

  const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
  if (withdrawCode === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, sourceTarget, 1, moveOptions);
    return { picked: false, outOfRange: true };
  }

  if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
    releasePickupReservation(creep, sourceTarget.id);
    return { picked: false, outOfRange: false };
  }

  if (withdrawCode === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    releasePickupReservation(creep, sourceTarget.id);
  }

  return { picked: withdrawCode === OK, outOfRange: false };
}
