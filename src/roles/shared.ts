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
  ignoreCreeps?: boolean;
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

export type EnergyPickupTarget = Resource | AnyStoreStructure | Tombstone | Ruin;

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
  const reusePath = options.reusePath ?? 5;
  return creep.moveTo(targetPos, {
    range,
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    reusePath,
    maxRooms: options.maxRooms,
    ignoreCreeps: options.ignoreCreeps,
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

export function getCurrentColonizationRoute(targetRoom: string, fallbackEncodedRoute?: string): string | undefined {
  const task = Memory.data?.colonization?.[targetRoom];
  if (!task) {
    return fallbackEncodedRoute;
  }

  if (!task.scoutSafe) {
    return undefined;
  }

  const routeRooms = task.scoutRouteRooms;
  if (!routeRooms || routeRooms.length === 0) {
    return undefined;
  }

  return routeRooms.join("|");
}

export function getCurrentScoutRoute(targetRoom: string, fallbackEncodedRoute?: string): string | undefined {
  const task = Memory.data?.colonization?.[targetRoom];
  if (!task) {
    return fallbackEncodedRoute;
  }

  const routeRooms = task.scoutRouteRooms;
  if (!routeRooms || routeRooms.length === 0) {
    return fallbackEncodedRoute;
  }

  return routeRooms.join("|");
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

function hasHostileCombatPresence(room: Room): boolean {
  const hostileCombatCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) =>
      creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0,
  });
  if (hostileCombatCreeps.length > 0) {
    return true;
  }

  const hostilePowerCreeps = room.find(FIND_HOSTILE_POWER_CREEPS);
  if (hostilePowerCreeps.length > 0) {
    return true;
  }

  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });

  return hostileStructures.length > 0;
}

function isVisibleRoomDangerous(roomName: string): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }

  if (hasHostileCombatPresence(room)) {
    return true;
  }

  if (room.controller?.owner && !room.controller.my) {
    return true;
  }

  if (room.controller?.reservation && !room.controller.my) {
    const myUser = Object.values(Game.spawns)[0]?.owner.username || Object.values(Game.creeps)[0]?.owner.username;
    if (!myUser || room.controller.reservation.username !== myUser) {
      return true;
    }
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

function findStrictRouteNextRoom(
  currentRoom: string,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
): string | null {
  if (routeRooms.length === 0) {
    return null;
  }

  const allowedRooms = new Set(routeRooms);
  const dangerousSet = new Set(dangerousRooms);
  allowedRooms.add(currentRoom);
  allowedRooms.add(targetRoom);

  const route = Game.map.findRoute(currentRoom, targetRoom, {
    routeCallback: (roomName) => {
      if (!allowedRooms.has(roomName)) {
        return Infinity;
      }

      if (roomName !== currentRoom && roomName !== targetRoom && dangerousSet.has(roomName)) {
        return Infinity;
      }

      return 1;
    },
  });

  if (route === ERR_NO_PATH || route.length === 0) {
    return null;
  }

  return route[0].room;
}

function findOrderedRouteNextRoom(
  currentRoom: string,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
): string | null {
  if (routeRooms.length === 0) {
    return null;
  }

  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  if (currentIndex < 0) {
    return null;
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex >= routeRooms.length) {
    return null;
  }

  const nextRoom = routeRooms[nextIndex];
  if (!isAdjacentRoom(currentRoom, nextRoom)) {
    return null;
  }

  if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
    return null;
  }

  return nextRoom;
}

function getForwardPreferredRooms(currentRoom: string, routeRooms: string[], targetRoom: string): string[] {
  if (routeRooms.length === 0) {
    return [targetRoom];
  }

  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  if (currentIndex < 0) {
    return routeRooms;
  }

  const forward = routeRooms.slice(currentIndex + 1);
  if (forward.length === 0) {
    return [targetRoom];
  }

  return forward;
}

function isAdjacentRoom(fromRoom: string, toRoom: string): boolean {
  const exits = Game.map.describeExits(fromRoom);
  if (!exits) {
    return false;
  }

  return Object.values(exits).some((roomName) => roomName === toRoom);
}

function findAdjacentAllowedRoom(
  currentRoom: string,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
): string | null {
  const exits = Game.map.describeExits(currentRoom);
  if (!exits) {
    return null;
  }

  const allowed = new Set(routeRooms);
  const dangerousSet = new Set(dangerousRooms);
  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  allowed.add(targetRoom);

  const candidates = Object.values(exits).filter(
    (roomName): roomName is string => {
      if (!roomName || !allowed.has(roomName)) {
        return false;
      }

      if (roomName !== targetRoom && dangerousSet.has(roomName)) {
        return false;
      }

      if (currentIndex >= 0 && roomName !== targetRoom) {
        const candidateIndex = routeRooms.lastIndexOf(roomName);
        if (candidateIndex >= 0 && candidateIndex <= currentIndex) {
          return false;
        }
      }

      return true;
    },
  );
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => Game.map.getRoomLinearDistance(a, targetRoom) - Game.map.getRoomLinearDistance(b, targetRoom));
  return candidates[0];
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
  const hasFixedRoute = routeRooms.length > 0;
  const travelState = getTravelState(creep, targetRoom);
  const currentPosKey = getPosKey(creep.pos);
  if (travelState.lastPosKey === currentPosKey && creep.fatigue === 0) {
    travelState.stuckTicks += 1;
  } else {
    travelState.stuckTicks = 0;
  }
  travelState.lastPosKey = currentPosKey;

  let nextRoom: string;
  if (hasFixedRoute) {
    const forwardPreferredRooms = getForwardPreferredRooms(creep.room.name, routeRooms, targetRoom);
    const orderedNextRoom = findOrderedRouteNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    const strictNextRoom = findStrictRouteNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    nextRoom =
      orderedNextRoom ??
      strictNextRoom ??
      findAdjacentAllowedRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms) ??
      creep.room.name;
    if (nextRoom === creep.room.name) {
      const recoveredNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, forwardPreferredRooms, dangerousRooms);
      nextRoom = recoveredNextRoom ?? creep.room.name;
      if (nextRoom === creep.room.name) {
        updateTravelState(creep, travelState);
        return ERR_NO_PATH;
      }
    }

    if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
  } else {
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    nextRoom = dynamicNextRoom ?? creep.room.name;
    if (nextRoom === creep.room.name) {
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
  }

  if (travelState.stuckTicks >= 2) {
    const preferredRooms = hasFixedRoute
      ? getForwardPreferredRooms(creep.room.name, routeRooms, targetRoom)
      : routeRooms;
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, preferredRooms, dangerousRooms);
    if (dynamicNextRoom && dynamicNextRoom !== creep.room.name) {
      nextRoom = dynamicNextRoom;
    }
  }

  if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
    updateTravelState(creep, travelState);
    return ERR_NO_PATH;
  }

  const moveRange = options.travelRange ?? 1;
  const moveOptions: MoveToTargetOptions = {
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    reusePath: travelState.stuckTicks >= 2 ? 0 : options.reusePath ?? 5,
    maxRooms: options.maxRooms ?? Math.max(routeRooms.length + 1, 16),
  };

  let result: ScreepsReturnCode;
  if (nextRoom !== creep.room.name && (!hasFixedRoute || isAdjacentRoom(creep.room.name, nextRoom))) {
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

  return moveToTarget(creep, targetPos, 3, {
    swampCost: 8,
    reusePath: 5,
    ignoreCreeps: false,
  });
}

interface EnergyStoreTargetOptions {
  excludeIds?: string[];
  includeTerminal?: boolean;
  includeStorage?: boolean;
}

function getRoomTerminalEnergyReserve(room: Room): number {
  const configured = Memory.cfg?.resourceControl?.rooms?.[room.name]?.terminalEnergyReserve;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return 20_000;
}

export function getEnergyStoreTarget(creep: Creep, options: EnergyStoreTargetOptions = {}): AnyStoreStructure | null {
  const excludeSet = new Set(options.excludeIds || []);
  const includeTerminal = options.includeTerminal ?? true;
  const includeStorage = options.includeStorage ?? true;

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

  const powerSpawnTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id) || structure.structureType !== STRUCTURE_POWER_SPAWN) {
        return false;
      }

      const powerSpawn = structure as StructurePowerSpawn;
      return powerSpawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    },
  });

  if (powerSpawnTargets.length > 0) {
    return creep.pos.findClosestByRange(powerSpawnTargets) as AnyStoreStructure;
  }

  const factoryTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id) || structure.structureType !== STRUCTURE_FACTORY) {
        return false;
      }

      const factory = structure as StructureFactory;
      return factory.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    },
  });

  if (factoryTargets.length > 0) {
    return creep.pos.findClosestByRange(factoryTargets) as AnyStoreStructure;
  }

  const labTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id) || structure.structureType !== STRUCTURE_LAB) {
        return false;
      }

      const lab = structure as StructureLab;
      return lab.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    },
  });

  if (labTargets.length > 0) {
    return creep.pos.findClosestByRange(labTargets) as AnyStoreStructure;
  }

  if (includeTerminal && creep.room.terminal && !excludeSet.has(creep.room.terminal.id)) {
    const terminalReserve = getRoomTerminalEnergyReserve(creep.room);
    const terminalEnergy = creep.room.terminal.store.getUsedCapacity(RESOURCE_ENERGY);
    if (creep.room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && terminalEnergy < terminalReserve) {
      return creep.room.terminal;
    }
  }

  if (includeStorage && creep.room.storage && !excludeSet.has(creep.room.storage.id)) {
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
  const ruins = creep.room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const candidates: EnergyPickupTarget[] = [...dropped, ...structureCandidates, ...tombstones, ...ruins];
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
