import { measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getPosKey, parseEncodedRouteRooms } from "@/movement/common";
import { recordMovementMetric } from "@/movement/metrics";
import { moveToTarget } from "@/movement/pathing";
import type { DynamicRouteCacheEntry, MoveToRoomOptions, MoveToTargetOptions, TravelState } from "@/movement/types";

const DYNAMIC_ROUTE_CACHE_TTL = 25;
const DYNAMIC_ROUTE_CACHE_MAX = 200;
const dynamicNextRoomCache: Record<string, DynamicRouteCacheEntry> = {};

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

export function moveToTargetRoom(
  creep: Creep,
  targetRoom: string,
  encodedRouteRooms?: string,
  options: MoveToRoomOptions = {},
): ScreepsReturnCode {
  recordMovementMetric("travelRequests", creep.room.name);

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
      recordMovementMetric("travelFallbacks", creep.room.name);
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
    recordMovementMetric("travelRepaths", creep.room.name);
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
      let exitPos = measureCreepPathing(() => creep.pos.findClosestByPath(exitDirection as ExitConstant));
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

function getTravelState(creep: Creep, targetRoom: string): TravelState {
  const memoryState = creep.memory.travelState as TravelState | undefined;
  if (!memoryState || memoryState.targetRoom !== targetRoom) {
    return { targetRoom, stuckTicks: 0 };
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
  dynamicNextRoomCache[cacheKey] = { nextRoom, expiresAt: Game.time + DYNAMIC_ROUTE_CACHE_TTL };
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
  const roomContext = getTickContextService().getRoomContext(room);
  const hostileCombatCreeps = (roomContext?.getHostileCreeps() || []).filter(
    (creep) =>
      creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0,
  );
  if (hostileCombatCreeps.length > 0) {
    return true;
  }
  if ((roomContext?.getHostilePowerCreeps() || []).length > 0) {
    return true;
  }
  const hostileStructures = (roomContext?.getHostileStructures() || []).filter(
    (structure) => structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  );
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
  const route = measureCreepPathing(() =>
    Game.map.findRoute(currentRoom, targetRoom, {
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
    }),
  );

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
  return forward.length === 0 ? [targetRoom] : forward;
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
