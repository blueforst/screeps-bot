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

interface TravelState {
  targetRoom: string;
  lastPosKey?: string;
  stuckTicks: number;
}

interface DynamicRouteCacheEntry {
  nextRoom: string | null;
  expiresAt: number;
}

const DYNAMIC_ROUTE_CACHE_TTL = 25;
const DYNAMIC_ROUTE_CACHE_MAX = 200;
const dynamicNextRoomCache: Record<string, DynamicRouteCacheEntry> = {};

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

function getPosKey(pos: RoomPosition): string {
  return `${pos.roomName}:${pos.x}:${pos.y}`;
}

function getTravelState(creep: Creep, targetRoom: string): TravelState {
  const memoryState = creep.memory.travelState as TravelState | undefined;
  if (!memoryState || memoryState.targetRoom !== targetRoom) {
    return {
      targetRoom,
      stuckTicks: 0,
    };
  }

  return memoryState;
}

function updateTravelState(creep: Creep, state: TravelState): void {
  creep.memory.travelState = state;
}

function getDangerousRoomsForTarget(targetRoom: string): string[] {
  const dangerousRooms = Memory.data?.colonization?.[targetRoom]?.dangerousRooms;
  if (!dangerousRooms || dangerousRooms.length === 0) {
    return [];
  }

  return dangerousRooms.filter((roomName) => roomName !== targetRoom);
}

function buildDynamicRouteCacheKey(
  currentRoom: string,
  targetRoom: string,
  preferredRooms: string[],
  avoidRooms: string[],
): string {
  const preferredPart = preferredRooms.join(">");
  const avoidPart = [...new Set(avoidRooms)].sort().join(">");
  return `${currentRoom}->${targetRoom}|p:${preferredPart}|a:${avoidPart}`;
}

function setDynamicRouteCache(cacheKey: string, nextRoom: string | null): void {
  dynamicNextRoomCache[cacheKey] = {
    nextRoom,
    expiresAt: Game.time + DYNAMIC_ROUTE_CACHE_TTL,
  };

  const keys = Object.keys(dynamicNextRoomCache);
  if (keys.length <= DYNAMIC_ROUTE_CACHE_MAX) {
    return;
  }

  for (const key of keys) {
    if (dynamicNextRoomCache[key].expiresAt <= Game.time) {
      delete dynamicNextRoomCache[key];
    }
  }

  const remainingKeys = Object.keys(dynamicNextRoomCache);
  if (remainingKeys.length <= DYNAMIC_ROUTE_CACHE_MAX) {
    return;
  }

  const removeCount = remainingKeys.length - DYNAMIC_ROUTE_CACHE_MAX;
  remainingKeys
    .sort((a, b) => dynamicNextRoomCache[a].expiresAt - dynamicNextRoomCache[b].expiresAt)
    .slice(0, removeCount)
    .forEach((key) => {
      delete dynamicNextRoomCache[key];
    });
}

function isVisibleRoomDangerous(roomName: string): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }

  if (room.find(FIND_HOSTILE_CREEPS).length > 0) {
    return true;
  }

  if (room.controller?.owner && !room.controller.my) {
    return true;
  }

  return false;
}

function findDynamicNextRoom(
  currentRoom: string,
  targetRoom: string,
  preferredRooms: string[],
  avoidRooms: string[],
): string | null {
  const cacheKey = buildDynamicRouteCacheKey(currentRoom, targetRoom, preferredRooms, avoidRooms);
  const cached = dynamicNextRoomCache[cacheKey];
  if (cached && cached.expiresAt > Game.time) {
    return cached.nextRoom;
  }

  const preferredSet = new Set(preferredRooms);
  const avoidSet = new Set(avoidRooms);
  const route = Game.map.findRoute(currentRoom, targetRoom, {
    routeCallback: (roomName) => {
      if (roomName === currentRoom || roomName === targetRoom) {
        return 1;
      }

      if (avoidSet.has(roomName)) {
        return Infinity;
      }

      if (Game.map.getRoomStatus(roomName).status !== "normal") {
        return Infinity;
      }

      if (isVisibleRoomDangerous(roomName)) {
        return Infinity;
      }

      if (preferredSet.has(roomName)) {
        return 1;
      }

      return 3;
    },
  });

  if (route === ERR_NO_PATH || route.length === 0) {
    setDynamicRouteCache(cacheKey, null);
    return null;
  }

  const nextRoom = route[0].room;
  setDynamicRouteCache(cacheKey, nextRoom);
  return nextRoom;
}

function getNearestRouteRoom(currentRoom: string, routeRooms: string[], targetRoom: string): string {
  const nonTargetRooms = routeRooms.filter((roomName) => roomName !== targetRoom);
  const candidates = nonTargetRooms.length > 0 ? nonTargetRooms : routeRooms;

  let bestRoom = candidates[0];
  let bestDistance = Game.map.getRoomLinearDistance(currentRoom, bestRoom);
  let bestIndex = routeRooms.indexOf(bestRoom);
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const distance = Game.map.getRoomLinearDistance(currentRoom, candidate);
    const candidateIndex = routeRooms.indexOf(candidate);
    if (distance < bestDistance || (distance === bestDistance && candidateIndex > bestIndex)) {
      bestDistance = distance;
      bestRoom = candidate;
      bestIndex = candidateIndex;
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
    delete creep.memory.travelState;
    return OK;
  }

  const routeRooms = parseEncodedRouteRooms(encodedRouteRooms);
  const dangerousRooms = getDangerousRoomsForTarget(targetRoom);
  const travelState = getTravelState(creep, targetRoom);
  const currentPosKey = getPosKey(creep.pos);
  if (travelState.lastPosKey === currentPosKey && creep.fatigue === 0) {
    travelState.stuckTicks += 1;
  } else {
    travelState.stuckTicks = 0;
  }
  travelState.lastPosKey = currentPosKey;

  let nextRoom = getNextRouteRoom(creep.room.name, routeRooms, targetRoom);
  if (travelState.stuckTicks >= 2) {
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    if (dynamicNextRoom && dynamicNextRoom !== creep.room.name) {
      nextRoom = dynamicNextRoom;
    }
  }

  const moveRange = options.travelRange ?? 1;
  const moveOptions: MoveToTargetOptions = {
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    reusePath: travelState.stuckTicks >= 2 ? 0 : options.reusePath ?? 10,
    maxRooms: options.maxRooms ?? Math.max(routeRooms.length + 1, 16),
  };

  let result: ScreepsReturnCode;
  if (nextRoom !== creep.room.name) {
    const exitDirection = creep.room.findExitTo(nextRoom);
    if (typeof exitDirection === "number" && exitDirection >= 1 && exitDirection <= 8) {
      let exitPos = creep.pos.findClosestByPath(exitDirection as ExitConstant);
      if (!exitPos) {
        const exitTiles = creep.room.find(exitDirection as ExitConstant);
        exitPos = creep.pos.findClosestByRange(exitTiles);
      }
      if (exitPos) {
        result = moveToTarget(creep, exitPos, 0, moveOptions);
        updateTravelState(creep, travelState);
        return result;
      }
    }
  }

  result = moveToTarget(creep, new RoomPosition(25, 25, nextRoom), moveRange, moveOptions);
  updateTravelState(creep, travelState);
  return result;
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
