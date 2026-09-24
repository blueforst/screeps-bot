import { buildStaticRoomCostMatrix, collectStaticRoomMatrixSources } from "@/movement/staticRoomMatrix";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getUnconfirmedPowerBankRouteRooms } from "@/runtime/powerBankRegion";
import type { PowerBankTierProfile } from "@/runtime/powerBankViability";

export const POWER_BANK_PATH_MAX_OPS = 6000;
const POWER_BANK_PATH_MAX_ROOMS = 16;

export type PowerBankPathFailure = "unreachable" | "incomplete" | "ops_exhausted" | "invalid_origin";

export interface StoredBankPathPosition {
  x: number;
  y: number;
  roomName: string;
}

export interface PowerBankTravelPlan {
  status: "complete" | PowerBankPathFailure;
  receiverHeadroom: number;
  combatTravelTicks: number;
  haulerOutboundTravelTicks: number;
  haulerReturnTravelTicks: number;
  routeRooms: string[];
  combatPath: StoredBankPathPosition[];
  haulPath: StoredBankPathPosition[];
  unknownRouteRooms: string[];
  confidence: "observed" | "terrain-only";
  ops: number;
  failure?: PowerBankPathFailure;
}

type MovementKind = "road" | "plain" | "swamp";
type PathPosition = Pick<RoomPosition, "x" | "y" | "roomName">;

interface MobilityProfile {
  ticks: Record<MovementKind, number>;
}

function makeMobilityProfile(body: readonly BodyPartConstant[], loadedCarry: boolean): MobilityProfile {
  const moves = body.filter((part) => part === MOVE).length;
  const weight = body.filter((part) => part !== MOVE && (loadedCarry || part !== CARRY)).length;
  if (moves <= 0) {
    return { ticks: { road: Infinity, plain: Infinity, swamp: Infinity } };
  }
  const perTile = (fatiguePerWeight: number): number =>
    Math.max(1, Math.ceil((weight * fatiguePerWeight) / (moves * 2)));
  return { ticks: { road: perTile(1), plain: perTile(2), swamp: perTile(10) } };
}

function combineMobilityProfiles(...profiles: MobilityProfile[]): MobilityProfile {
  return {
    ticks: {
      road: Math.max(...profiles.map((profile) => profile.ticks.road)),
      plain: Math.max(...profiles.map((profile) => profile.ticks.plain)),
      swamp: Math.max(...profiles.map((profile) => profile.ticks.swamp)),
    },
  };
}

function getHaulerBody(energyCapacity: number): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairs = Math.max(1, Math.min(25, Math.floor(energyCapacity / pairCost)));
  const parts: BodyPartConstant[] = [];
  for (let index = 0; index < pairs; index += 1) parts.push(CARRY, MOVE);
  return parts.slice(0, Math.min(50, parts.length));
}

function getAllowedRooms(routeRooms: readonly string[]): Set<string> {
  return new Set(routeRooms);
}

function isRoomNormal(roomName: string): boolean {
  if (typeof Game.map.getRoomStatus !== "function") return true;
  try {
    return Game.map.getRoomStatus(roomName)?.status === "normal";
  } catch {
    return false;
  }
}

function isDangerous(roomName: string): boolean {
  const runtime = Memory.runtime;
  return !!runtime?.powerBankPermanentDangerRooms?.[roomName] ||
    (runtime?.transitDangerRooms?.[roomName] ?? 0) > Game.time;
}

function runPathSearch(
  origin: PathPosition,
  goal: { pos: RoomPosition; range: number },
  routeRooms: readonly string[],
  mobility: MobilityProfile,
): { path: PathPosition[]; ops: number; failure?: PowerBankPathFailure } {
  const allowedRooms = getAllowedRooms(routeRooms);
  const matrices = new Map<string, CostMatrix>();
  const search = PathFinder.search(origin as RoomPosition, goal, {
    plainCost: mobility.ticks.plain,
    swampCost: mobility.ticks.swamp,
    maxOps: POWER_BANK_PATH_MAX_OPS,
    maxRooms: Math.min(POWER_BANK_PATH_MAX_ROOMS, Math.max(1, allowedRooms.size)),
    roomCallback: (roomName) => {
      if (!allowedRooms.has(roomName) || !isRoomNormal(roomName) || isDangerous(roomName)) return false;
      const existing = matrices.get(roomName);
      if (existing) return existing;
      const room = Game.rooms[roomName];
      if (!room) return true;
      const context = getTickContextService().getRoomContext(room);
      const matrix = buildStaticRoomCostMatrix(roomName, collectStaticRoomMatrixSources(room, context));
      matrices.set(roomName, matrix);
      return matrix;
    },
  });

  const path = search.path ?? [];
  const ops = Number.isFinite(search.ops) ? search.ops : POWER_BANK_PATH_MAX_OPS;
  if (search.incomplete) {
    return { path, ops, failure: ops >= POWER_BANK_PATH_MAX_OPS ? "ops_exhausted" : "incomplete" };
  }
  if (path.length === 0) return { path, ops, failure: "unreachable" };
  return { path, ops };
}

function getRoadKeysByRoom(routeRooms: readonly string[]): Map<string, Set<string>> {
  const roadKeys = new Map<string, Set<string>>();
  for (const roomName of routeRooms) {
    const room = Game.rooms[roomName];
    if (!room) continue;
    const roads = new Set<string>();
    const context = getTickContextService().getRoomContext(room);
    const structures = context?.getStructures() ?? room.find(FIND_STRUCTURES);
    for (const structure of structures) {
      if (structure.structureType === STRUCTURE_ROAD) roads.add(`${structure.pos.x}:${structure.pos.y}`);
    }
    roadKeys.set(roomName, roads);
  }
  return roadKeys;
}

function getMovementKind(position: PathPosition, roads: Map<string, Set<string>>): MovementKind {
  if (roads.get(position.roomName)?.has(`${position.x}:${position.y}`)) return "road";
  const terrain = Game.map.getRoomTerrain(position.roomName).get(position.x, position.y);
  return terrain & TERRAIN_MASK_SWAMP ? "swamp" : "plain";
}

export function estimatePathTravelTicks(
  path: readonly PathPosition[],
  body: readonly BodyPartConstant[],
  loadedCarry: boolean,
  roads: Map<string, Set<string>> = new Map(),
): number {
  const mobility = makeMobilityProfile(body, loadedCarry);
  return path.reduce((ticks, position) => ticks + mobility.ticks[getMovementKind(position, roads)], 0);
}

function storePath(path: readonly PathPosition[]): StoredBankPathPosition[] {
  return path.map(({ x, y, roomName }) => ({ x, y, roomName }));
}

function createRoomPosition(x: number, y: number, roomName: string): RoomPosition {
  const Constructor = (globalThis as typeof globalThis & {
    RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition;
  }).RoomPosition;
  return Constructor
    ? new Constructor(x, y, roomName)
    : { x, y, roomName } as RoomPosition;
}

function getPathRooms(originRoom: string, path: readonly PathPosition[]): string[] {
  const rooms = [originRoom];
  for (const position of path) {
    if (rooms[rooms.length - 1] !== position.roomName) rooms.push(position.roomName);
  }
  return rooms;
}

function findDropoff(room: Room): StructureStorage | StructureTerminal | undefined {
  if (room.terminal && (room.terminal.store.getFreeCapacity(RESOURCE_POWER) ?? 0) > 0) return room.terminal;
  if (room.storage && (room.storage.store.getFreeCapacity(RESOURCE_POWER) ?? 0) > 0) return room.storage;
  return undefined;
}

function getIncompletePlan(
  failure: PowerBankPathFailure,
  routeRooms: string[],
  ops: number,
  unknownRouteRooms: string[],
): PowerBankTravelPlan {
  return {
    status: failure,
    failure,
    receiverHeadroom: 0,
    combatTravelTicks: Infinity,
    haulerOutboundTravelTicks: Infinity,
    haulerReturnTravelTicks: Infinity,
    routeRooms,
    combatPath: [],
    haulPath: [],
    unknownRouteRooms,
    confidence: unknownRouteRooms.length > 0 ? "terrain-only" : "observed",
    ops,
  };
}

export function planPowerBankTravel(params: {
  sourceRoom: Room;
  targetRoom: string;
  bankPos: { x: number; y: number };
  routeRooms: string[];
  profile: PowerBankTierProfile;
  energyCapacity: number;
}): PowerBankTravelPlan {
  const { sourceRoom, targetRoom, bankPos, routeRooms, profile, energyCapacity } = params;
  const route = [...new Set([sourceRoom.name, ...routeRooms, targetRoom])];
  const unknownRouteRooms = getUnconfirmedPowerBankRouteRooms(route);
  const spawns = getTickContextService().getSpawnsByRoom(sourceRoom.name)
    .filter((spawn) => typeof spawn.isActive !== "function" || spawn.isActive());
  const dropoff = findDropoff(sourceRoom);
  if (spawns.length === 0 || !dropoff) {
    return getIncompletePlan("invalid_origin", route, 0, unknownRouteRooms);
  }

  const bankPosition = createRoomPosition(bankPos.x, bankPos.y, targetRoom);
  const combatMobility = combineMobilityProfiles(
    makeMobilityProfile(profile.attacker.body, false),
    makeMobilityProfile(profile.healer.body, false),
  );
  const haulerBody = getHaulerBody(energyCapacity);
  const outboundMobility = makeMobilityProfile(haulerBody, false);
  const returnMobility = makeMobilityProfile(haulerBody, true);
  const combat = runPathSearch(
    spawns[0].pos,
    { pos: bankPosition, range: 1 },
    route,
    combatMobility,
  );
  if (combat.failure) return getIncompletePlan(combat.failure, route, combat.ops, unknownRouteRooms);

  const haulerOutbound = runPathSearch(
    spawns[0].pos,
    { pos: bankPosition, range: 1 },
    route,
    outboundMobility,
  );
  if (haulerOutbound.failure) {
    return getIncompletePlan(haulerOutbound.failure, route, combat.ops + haulerOutbound.ops, unknownRouteRooms);
  }

  const haulerStart = haulerOutbound.path[haulerOutbound.path.length - 1];
  if (!haulerStart) return getIncompletePlan("unreachable", route, combat.ops + haulerOutbound.ops, unknownRouteRooms);
  const returnPath = runPathSearch(
    haulerStart,
    { pos: dropoff.pos, range: 1 },
    route,
    returnMobility,
  );
  if (returnPath.failure) {
    return getIncompletePlan(returnPath.failure, route, combat.ops + haulerOutbound.ops + returnPath.ops, unknownRouteRooms);
  }

  const roadKeys = getRoadKeysByRoom(route);
  const combatTravelTicks = estimatePathTravelTicks(combat.path, profile.attacker.body, false, roadKeys);
  const combatHealerTicks = estimatePathTravelTicks(combat.path, profile.healer.body, false, roadKeys);
  const haulerOutboundTravelTicks = estimatePathTravelTicks(haulerOutbound.path, haulerBody, false, roadKeys);
  const haulerReturnTravelTicks = estimatePathTravelTicks(returnPath.path, haulerBody, true, roadKeys);
  const combinedOps = combat.ops + haulerOutbound.ops + returnPath.ops;
  const roomsInPath = [...new Set([
    ...getPathRooms(sourceRoom.name, combat.path),
    ...getPathRooms(sourceRoom.name, haulerOutbound.path),
    ...getPathRooms(targetRoom, returnPath.path),
  ])];
  const routeUnknown = [...new Set([
    ...unknownRouteRooms,
    ...roomsInPath.filter((roomName) => !Game.rooms[roomName]),
  ])];

  return {
    status: "complete",
    receiverHeadroom: dropoff.store.getFreeCapacity(RESOURCE_POWER) ?? 0,
    combatTravelTicks: Math.max(combatTravelTicks, combatHealerTicks),
    haulerOutboundTravelTicks,
    haulerReturnTravelTicks,
    routeRooms: getPathRooms(sourceRoom.name, combat.path),
    combatPath: storePath(combat.path),
    haulPath: storePath([...haulerOutbound.path, ...returnPath.path]),
    unknownRouteRooms: routeUnknown,
    confidence: routeUnknown.length > 0 ? "terrain-only" : "observed",
    ops: combinedOps,
  };
}
