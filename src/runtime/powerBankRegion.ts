import { POWER_BANK_BOOST_REQUIREMENTS } from "@/runtime/powerBankConstants";
import { selectBodyTier } from "@/runtime/powerBankViability";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

const MAX_ROUTE_ROOMS = 8;
const MAX_GRAPH_ROOMS_PER_BASE = 256;
const MAX_REGION_TARGETS = 128;
const MAX_ROUTES_PER_TARGET = 8;
const REGION_REFRESH_TICKS = 100;

export interface PowerBankRegionRoute {
  sourceRoom: string;
  distance: number;
  rooms: string[];
  confidence: "known-risk" | "terrain-only" | "observed";
}

export interface PowerBankRegionTarget {
  roomName: string;
  bases: PowerBankRegionRoute[];
}

export interface PowerBankRegionMemory {
  updatedAt: number;
  signature: string;
  targets: PowerBankRegionTarget[];
  plannedRooms: number;
  truncated: boolean;
}

function getRegionMemory(): PowerBankRegionMemory | undefined {
  const runtime = getMemoryService().ensureRuntime() as NonNullable<Memory["runtime"]> & {
    powerBankRegion?: PowerBankRegionMemory;
  };
  return runtime.powerBankRegion;
}

function setRegionMemory(state: PowerBankRegionMemory): void {
  const runtime = getMemoryService().ensureRuntime() as NonNullable<Memory["runtime"]> & {
    powerBankRegion?: PowerBankRegionMemory;
  };
  runtime.powerBankRegion = state;
}

function getCoordinate(direction: "E" | "W" | "N" | "S", value: number): number {
  return direction === "E" || direction === "N" ? value : -value - 1;
}

export function isPowerBankHighwayRoom(roomName: string): boolean {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return false;
  const x = getCoordinate(match[1] as "E" | "W", Number(match[2]));
  const y = getCoordinate(match[3] as "N" | "S", Number(match[4]));
  return x % 10 === 0 || y % 10 === 0;
}

function isOwnedBaseRoom(roomName: string): boolean {
  return !!Game.rooms[roomName]?.controller?.my;
}

function getRiskStatus(roomName: string): "blocked" | "stale" | "clear" {
  const runtime = Memory.runtime;
  if (runtime?.powerBankPermanentDangerRooms?.[roomName]) return "blocked";
  const expiry = runtime?.transitDangerRooms?.[roomName];
  if (expiry === undefined) return "clear";
  return expiry > Game.time ? "blocked" : "stale";
}

function getRoomStatus(roomName: string): string | null {
  if (!Game.map || typeof Game.map.getRoomStatus !== "function") return null;
  try {
    return Game.map.getRoomStatus(roomName)?.status ?? null;
  } catch {
    return null;
  }
}

function isRoomPassableForPlanning(roomName: string): boolean {
  return getRoomStatus(roomName) === "normal" && getRiskStatus(roomName) !== "blocked";
}

function getPotentialBases(): Room[] {
  const tickContext = getTickContextService();
  return getTickContextService().getMyRooms()
    .filter((room) => {
      if ((room.controller?.level ?? 0) < 6 || isDefenseMode(room.name)) return false;
      const selectedTier = selectBodyTier(room.energyCapacityAvailable);
      if (!selectedTier || (!room.storage && !room.terminal)) return false;
      const tier = selectedTier.attackerTier === "rcl8" ? 8 : selectedTier.attackerTier === "rcl7" ? 7 : 6;
      const requiredLabs = Object.keys(POWER_BANK_BOOST_REQUIREMENTS[tier] ?? {}).reduce((count, role) =>
        count + POWER_BANK_BOOST_REQUIREMENTS[tier][role as "attacker" | "healer"].length,
      0);
      const structures = tickContext.getRoomContext(room)?.getMyStructures() ?? room.find(FIND_MY_STRUCTURES);
      if (structures.filter((structure) => structure.structureType === STRUCTURE_LAB).length < requiredLabs) return false;
      return getTickContextService().getSpawnsByRoom(room.name).some((spawn) =>
        typeof spawn.isActive !== "function" || spawn.isActive(),
      );
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function makeSignature(bases: Room[]): string {
  const basePart = bases.map((room) => {
    const spawns = getTickContextService().getSpawnsByRoom(room.name)
      .map((spawn) => `${spawn.id}:${typeof spawn.isActive !== "function" || spawn.isActive() ? 1 : 0}`)
      .sort()
      .join(",");
    return `${room.name}:${room.controller?.level ?? 0}:${room.energyCapacityAvailable}:${spawns}`;
  }).join("|");
  const dangerRevision = (Memory.runtime as (ScreepsMemoryRuntime & { powerBankDangerRevision?: number }) | undefined)
    ?.powerBankDangerRevision ?? 0;
  return `${basePart}#${dangerRevision}`;
}

function buildRegion(bases: Room[], signature: string): PowerBankRegionMemory {
  const byTarget = new Map<string, PowerBankRegionRoute[]>();
  const ownedRooms = new Set(bases.map((room) => room.name));
  const knownRoomStatuses = new Map<string, boolean>();
  const plannedRooms = new Set<string>();
  let truncated = false;

  const passable = (roomName: string): boolean => {
    const cached = knownRoomStatuses.get(roomName);
    if (cached !== undefined) return cached;
    const allowed = isRoomPassableForPlanning(roomName);
    knownRoomStatuses.set(roomName, allowed);
    return allowed;
  };

  for (const base of bases) {
    const queue: Array<{ roomName: string; rooms: string[] }> = [{ roomName: base.name, rooms: [base.name] }];
    const bestDepth = new Map<string, number>([[base.name, 0]]);
    let cursor = 0;

    while (cursor < queue.length) {
      const current = queue[cursor++];
      const distance = current.rooms.length - 1;
      if (distance >= MAX_ROUTE_ROOMS) continue;
      if (queue.length >= MAX_GRAPH_ROOMS_PER_BASE) {
        truncated = true;
        break;
      }

      const exits = Game.map?.describeExits?.(current.roomName);
      if (!exits) continue;
      for (const nextRoom of Object.values(exits)) {
        if (!nextRoom || bestDepth.has(nextRoom) || !passable(nextRoom)) continue;
        const nextRooms = [...current.rooms, nextRoom];
        const nextDistance = nextRooms.length - 1;
        bestDepth.set(nextRoom, nextDistance);
        plannedRooms.add(nextRoom);

        if (!ownedRooms.has(nextRoom) && isPowerBankHighwayRoom(nextRoom)) {
          const routes = byTarget.get(nextRoom) ?? [];
          const riskInRoute = nextRooms.some((roomName) => getRiskStatus(roomName) === "stale");
          const routeHasUnknownVision = nextRooms.some((roomName) => !Game.rooms[roomName]);
          routes.push({
            sourceRoom: base.name,
            distance: nextDistance,
            rooms: nextRooms,
            confidence: riskInRoute ? "known-risk" : routeHasUnknownVision ? "terrain-only" : "observed",
          });
          byTarget.set(nextRoom, routes);
        }

        queue.push({ roomName: nextRoom, rooms: nextRooms });
      }
    }
  }

  const targets = [...byTarget.entries()]
    .map(([roomName, routes]) => ({
      roomName,
      bases: routes
        .sort((left, right) => left.distance - right.distance || left.sourceRoom.localeCompare(right.sourceRoom))
        .filter((route, index, values) => values.findIndex((candidate) => candidate.sourceRoom === route.sourceRoom) === index)
        .slice(0, MAX_ROUTES_PER_TARGET),
    }))
    .sort((left, right) => {
      const leftDistance = left.bases[0]?.distance ?? Infinity;
      const rightDistance = right.bases[0]?.distance ?? Infinity;
      return leftDistance - rightDistance || left.roomName.localeCompare(right.roomName);
    });

  if (targets.length > MAX_REGION_TARGETS) {
    targets.length = MAX_REGION_TARGETS;
    truncated = true;
  }

  return {
    updatedAt: Game.time,
    signature,
    targets,
    plannedRooms: plannedRooms.size,
    truncated,
  };
}

export function getPowerBankRegion(): PowerBankRegionMemory {
  const bases = getPotentialBases();
  const signature = makeSignature(bases);
  const current = getRegionMemory();
  if (
    current &&
    current.signature === signature &&
    Game.time - current.updatedAt < REGION_REFRESH_TICKS
  ) {
    return current;
  }
  const next = buildRegion(bases, signature);
  setRegionMemory(next);
  return next;
}

export function getPowerBankRegionRoute(
  roomName: string,
  sourceRoom: string,
): PowerBankRegionRoute | undefined {
  return getPowerBankRegion().targets
    .find((target) => target.roomName === roomName)
    ?.bases.find((route) => route.sourceRoom === sourceRoom);
}

export function getUnconfirmedPowerBankRouteRooms(routeRooms: readonly string[]): string[] {
  return [...new Set(routeRooms)].filter((roomName) =>
    !Game.rooms[roomName] || getRiskStatus(roomName) === "stale",
  );
}

export function invalidatePowerBankRegion(): void {
  const runtime = getMemoryService().ensureRuntime() as NonNullable<Memory["runtime"]> & {
    powerBankDangerRevision?: number;
  };
  runtime.powerBankDangerRevision = (runtime.powerBankDangerRevision ?? 0) + 1;
}
