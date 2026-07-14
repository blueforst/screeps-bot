import { measureCreepIntent, measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { ensureCreepMovementState } from "@/movement/creepState";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getPosKey, isExitTile, isWalkableConstructionSite, isWalkableStructure, parseEncodedRouteRooms } from "@/movement/common";
import { recordMovementMetric } from "@/movement/metrics";
import { moveToTarget } from "@/movement/pathing";
import { moveOffExit, moveToAdjacentPosition } from "@/movement/traffic";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import type {
  CachedTravelPath,
  DynamicRouteCacheEntry,
  MoveToRoomOptions,
  MoveToTargetOptions,
  StoredRoomPosition,
  TravelState,
} from "@/movement/types";

const DYNAMIC_ROUTE_CACHE_TTL = 25;
const DYNAMIC_ROUTE_CACHE_MAX = 200;
const MULTI_ROOM_TRAVEL_MAX_OPS = 10000;
const dynamicNextRoomCache: Record<string, DynamicRouteCacheEntry> = {};

export function getCurrentColonizationRoute(targetRoom: string, fallbackEncodedRoute?: string): string | undefined {
  const task = Memory.data?.colonization?.[targetRoom];
  if (!task) {
    return fallbackEncodedRoute;
  }

  if (task.scoutSafe) {
    const routeRooms = task.scoutRouteRooms;
    if (routeRooms && routeRooms.length > 0) {
      return routeRooms.join("|");
    }
  }

  return fallbackEncodedRoute;
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
    delete ensureCreepMovementState(creep.name).travelState;
    return OK;
  }

  const routeRooms = parseEncodedRouteRooms(encodedRouteRooms);
  const dangerousRooms = getDangerousRoomsForTarget(targetRoom, options.avoidRooms);
  const hasFixedRoute = routeRooms.length > 0;
  const travelState = getTravelState(creep, targetRoom);
  ensureCreepMovementState(creep.name).pathingRequestedAt = Game.time;
  const currentPosKey = getPosKey(creep.pos);
  const currentOnExit = isExitTile(creep.pos);
  const repeatedExitTransition = travelState.lastWasExit && currentOnExit && travelState.lastPosKey !== currentPosKey;
  if ((travelState.lastPosKey === currentPosKey || repeatedExitTransition) && creep.fatigue === 0) {
    travelState.stuckTicks += 1;
  } else {
    travelState.stuckTicks = 0;
  }
  travelState.lastPosKey = currentPosKey;
  travelState.lastWasExit = currentOnExit;

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
    ignoreCreeps: travelState.stuckTicks >= 2 ? false : options.ignoreCreeps,
    avoidExitTiles: true,
  };

  const cachedTravelPath = getUsableCachedTravelPath(creep, targetRoom, routeRooms, dangerousRooms, hasFixedRoute);

  let result: ScreepsReturnCode;
  if (nextRoom !== creep.room.name && (!hasFixedRoute || isAdjacentRoom(creep.room.name, nextRoom))) {
    const exitDirection = creep.room.findExitTo(nextRoom);
    if (typeof exitDirection === "number" && exitDirection >= 1 && exitDirection <= 8) {
      if (isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) {
        result = measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
        updateTravelState(creep, travelState);
        return result;
      }

      if (isExitTile(creep.pos)) {
        recordMovementMetric("exitRecoveries", creep.room.name);
        result = moveOffExit(creep);
        if (result === OK || result === ERR_TIRED) {
          updateTravelState(creep, travelState);
          return result;
        }
      }

      if (cachedTravelPath && travelState.stuckTicks < 2) {
        const cachedPathResult = followCachedTravelPath(creep, cachedTravelPath);
        if (cachedPathResult === OK || cachedPathResult === ERR_TIRED) {
          updateTravelState(creep, travelState);
          return cachedPathResult;
        }
      }

      const multiRoomResult = moveAlongMultiRoomPath(creep, targetRoom, routeRooms, dangerousRooms, hasFixedRoute, moveRange, moveOptions);
      if (multiRoomResult !== ERR_NO_PATH) {
        updateTravelState(creep, travelState);
        return multiRoomResult;
      }

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

export function getColonizationTravelPathKey(sourceRoom: string, targetRoom: string, routeRooms: string[], dangerousRooms: string[]): string {
  const routePart = routeRooms.join(">");
  const dangerPart = [...new Set(dangerousRooms)].sort().join(">");
  return `${sourceRoom}->${targetRoom}|r:${routePart}|d:${dangerPart}`;
}

function getUsableCachedTravelPath(
  creep: Creep,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
  hasFixedRoute: boolean,
): CachedTravelPath | null {
  if (!hasFixedRoute || routeRooms.length === 0) {
    return null;
  }
  const task = Memory.data?.colonization?.[targetRoom];
  const cachedPath = task?.cachedTravelPath;
  if (!cachedPath || cachedPath.positions.length === 0) {
    return null;
  }
  if (cachedPath.key !== getColonizationTravelPathKey(cachedPath.sourceRoom, targetRoom, routeRooms, dangerousRooms)) {
    return null;
  }
  if (cachedPath.sourceRoom !== routeRooms[0] || cachedPath.targetRoom !== targetRoom) {
    return null;
  }
  if (cachedPath.routeRooms.join("|") !== routeRooms.join("|")) {
    return null;
  }
  if (!routeRooms.includes(creep.room.name)) {
    return null;
  }

  return cachedPath as CachedTravelPath;
}

function followCachedTravelPath(creep: Creep, cachedPath: CachedTravelPath): ScreepsReturnCode {
  const nextStep = getNextCachedTravelPathStep(creep.pos, cachedPath.positions);
  if (!nextStep) {
    return ERR_NO_PATH;
  }

  if (nextStep.roomName !== creep.room.name) {
    const direction = getExitTransitionDirection(creep.pos, nextStep);
    if (!direction) {
      return ERR_NO_PATH;
    }
    return measureCreepIntent(() => creep.move(direction));
  }

  const nextPos = new RoomPosition(nextStep.x, nextStep.y, nextStep.roomName);
  if (creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  return moveToAdjacentPosition(creep, nextPos);
}

function getNextCachedTravelPathStep(pos: RoomPosition, positions: StoredRoomPosition[]): StoredRoomPosition | null {
  const exactIndex = positions.findIndex((step) => step.roomName === pos.roomName && step.x === pos.x && step.y === pos.y);
  if (exactIndex >= 0) {
    return positions[exactIndex + 1] ?? null;
  }

  let bestIndex = -1;
  let bestRange = Infinity;
  for (let index = 0; index < positions.length; index += 1) {
    const step = positions[index];
    if (step.roomName !== pos.roomName) {
      continue;
    }
    const range = pos.getRangeTo(step.x, step.y);
    if (range >= bestRange) {
      continue;
    }
    bestRange = range;
    bestIndex = index;
  }

  return bestRange <= 1 && bestIndex >= 0 ? positions[bestIndex] : null;
}

function getExitTransitionDirection(pos: RoomPosition, nextStep: StoredRoomPosition): DirectionConstant | null {
  if (pos.x === 49 && nextStep.x === 0) {
    return RIGHT;
  }
  if (pos.x === 0 && nextStep.x === 49) {
    return LEFT;
  }
  if (pos.y === 49 && nextStep.y === 0) {
    return BOTTOM;
  }
  if (pos.y === 0 && nextStep.y === 49) {
    return TOP;
  }

  return null;
}

function moveAlongMultiRoomPath(
  creep: Creep,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
  hasFixedRoute: boolean,
  range: 1 | 3,
  options: MoveToTargetOptions,
): ScreepsReturnCode {
  const targetPos = new RoomPosition(25, 25, targetRoom);
  const search = measureCreepPathing(() =>
    PathFinder.search(
      creep.pos,
      { pos: targetPos, range },
      {
        plainCost: options.plainCost,
        swampCost: options.swampCost,
        maxOps: MULTI_ROOM_TRAVEL_MAX_OPS,
        maxRooms: options.maxRooms ?? 16,
        roomCallback: createMultiRoomTravelCallback(creep, targetRoom, routeRooms, dangerousRooms, hasFixedRoute, options),
      },
    ),
  );

  if (search.incomplete || search.path.length === 0) {
    return ERR_NO_PATH;
  }

  const nextPos = search.path[0];
  if (nextPos.roomName !== creep.room.name || creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  return moveToAdjacentPosition(creep, nextPos);
}

function createMultiRoomTravelCallback(
  creep: Creep,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
  hasFixedRoute: boolean,
  options: MoveToTargetOptions,
): (roomName: string) => boolean | CostMatrix {
  const dangerousSet = new Set(dangerousRooms);
  const allowedRooms = hasFixedRoute && routeRooms.length > 0 ? new Set([...routeRooms, creep.room.name, targetRoom]) : null;

  return (roomName: string): boolean | CostMatrix => {
    if (allowedRooms && !allowedRooms.has(roomName)) {
      return false;
    }
    if (roomName !== targetRoom && dangerousSet.has(roomName)) {
      return false;
    }
    if (roomName !== creep.room.name && roomName !== targetRoom) {
      if (Game.map.getRoomStatus(roomName).status !== "normal") {
        return false;
      }
      if (isVisibleRoomDangerous(roomName)) {
        return false;
      }
    }

    return buildMultiRoomTravelMatrix(creep, roomName, options);
  };
}

function buildMultiRoomTravelMatrix(creep: Creep, roomName: string, options: MoveToTargetOptions): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const room = Game.rooms[roomName];
  if (!room) {
    return matrix;
  }

  const roomContext = getTickContextService().getRoomContext(room);
  const structures = roomContext?.getStructures() ?? room.find(FIND_STRUCTURES);
  for (const structure of structures) {
    if (structure.structureType === STRUCTURE_ROAD) {
      matrix.set(structure.pos.x, structure.pos.y, 1);
      continue;
    }
    if (!isWalkableStructure(structure)) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }

  const sites = roomContext?.getConstructionSites() ?? room.find(FIND_CONSTRUCTION_SITES);
  for (const site of sites) {
    if (!site.my) {
      continue;
    }
    if (!isWalkableConstructionSite(site)) {
      matrix.set(site.pos.x, site.pos.y, 0xff);
    } else if (site.structureType === STRUCTURE_ROAD) {
      matrix.set(site.pos.x, site.pos.y, 1);
    }
  }

  for (const pos of getSourceContainerPositionsForRoom(roomName)) {
    if (matrix.get(pos.x, pos.y) < 0xfe) {
      matrix.set(pos.x, pos.y, 0xfe);
    }
  }

  if (room.controller?.my) {
    const cPos = room.controller.pos;
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dy = -3; dy <= 3; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 3) continue;
        const x = cPos.x + dx;
        const y = cPos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (matrix.get(x, y) < 0xfe) {
          matrix.set(x, y, 0xfe);
        }
      }
    }
  }

  if (options.ignoreCreeps ?? true) {
    return matrix;
  }

  const creeps = roomContext?.getMyCreeps() ?? room.find(FIND_MY_CREEPS);
  for (const otherCreep of creeps) {
    if (otherCreep.name !== creep.name) {
      matrix.set(otherCreep.pos.x, otherCreep.pos.y, 0xfe);
    }
  }

  return matrix;
}

function getTravelState(creep: Creep, targetRoom: string): TravelState {
  const memoryState = ensureCreepMovementState(creep.name).travelState;
  if (!memoryState || memoryState.targetRoom !== targetRoom) {
    return { targetRoom, stuckTicks: 0 };
  }
  return memoryState;
}

function isOnExitDirection(pos: RoomPosition, direction: DirectionConstant): boolean {
  switch (direction) {
    case TOP:
      return pos.y === 0;
    case RIGHT:
      return pos.x === 49;
    case BOTTOM:
      return pos.y === 49;
    case LEFT:
      return pos.x === 0;
    default:
      return false;
  }
}

function updateTravelState(creep: Creep, state: TravelState): void {
  ensureCreepMovementState(creep.name).travelState = state;
}

function getDangerousRoomsForTarget(targetRoom: string, additionalAvoidRooms?: string[]): string[] {
  const dangerousRooms = Memory.data?.colonization?.[targetRoom]?.dangerousRooms;
  const base = dangerousRooms && dangerousRooms.length > 0
    ? dangerousRooms.filter((roomName) => roomName !== targetRoom)
    : [];
  if (!additionalAvoidRooms || additionalAvoidRooms.length === 0) {
    return base;
  }
  const seen = new Set(base);
  for (const room of additionalAvoidRooms) {
    if (room !== targetRoom && !seen.has(room)) {
      seen.add(room);
      base.push(room);
    }
  }
  return base;
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
