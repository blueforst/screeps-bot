import { recordMovementMetric } from "@/movement/metrics";
import { isTileReserved, reserveNextTile } from "@/movement/reservations";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getPosKey, getPositionAtDirection, isExitTile } from "@/movement/common";
import type { MovePathState } from "@/movement/types";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";

const MOVE_PRIORITY_BY_ROLE = {
  miner: 1,
  harvester: 2,
  mineralHarvester: 2,
  carrier: 4,
  worker: 5,
  claimer: 3,
  colonizerHarvester: 4,
  colonizerWorker: 5,
  crossShardClaimer: 3,
  crossShardColonizerHarvester: 4,
  crossShardColonizerWorker: 5,
  meleeAttacker: 3,
  healer: 3,
  scout: 8,
} as const;

const DEFAULT_MOVE_PRIORITY = 10;
const ALL_DIRECTIONS: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
const MAX_CHAIN_YIELD_DEPTH = 3;

function isWalkableStructure(structure: Structure<StructureConstant>): boolean {
  switch (structure.structureType) {
    case STRUCTURE_ROAD:
    case STRUCTURE_CONTAINER:
    case STRUCTURE_PORTAL:
      return true;
    case STRUCTURE_RAMPART: {
      const rampart = structure as StructureRampart;
      return rampart.my || rampart.isPublic;
    }
    default:
      return false;
  }
}

function isWalkableConstructionSite(site: ConstructionSite): boolean {
  return (
    site.structureType === STRUCTURE_ROAD ||
    site.structureType === STRUCTURE_CONTAINER ||
    site.structureType === STRUCTURE_RAMPART
  );
}

export function findMyCreepAt(pos: RoomPosition, excludeName?: string): Creep | null {
  const roomContext = getTickContextService().getRoomContext(pos.roomName);
  const myCreeps = roomContext?.getMyCreeps() || [];
  return myCreeps.find((creep) => creep.name !== excludeName && creep.pos.x === pos.x && creep.pos.y === pos.y) || null;
}

function getMovePriority(creep: Creep): number {
  const role = creep.memory.role;
  if (!role) {
    return DEFAULT_MOVE_PRIORITY;
  }

  return MOVE_PRIORITY_BY_ROLE[role] ?? DEFAULT_MOVE_PRIORITY;
}

export function shouldYieldToPusher(pusher: Creep, blocker: Creep): boolean {
  const pusherPriority = getMovePriority(pusher);
  const blockerPriority = getMovePriority(blocker);

  if (pusherPriority < blockerPriority) {
    return true;
  }

  const blockerPathState = blocker.memory.movePathState as MovePathState | undefined;
  return !blockerPathState || blockerPathState.expiresAt <= Game.time;
}

export function pushBlockingCreep(pusher: Creep, blocker: Creep): boolean {
  return pushBlockingCreepChain(pusher, blocker, new Set([pusher.name]), 0);
}

function pushBlockingCreepChain(
  pusher: Creep,
  blocker: Creep,
  visited: Set<string>,
  depth: number,
): boolean {
  if (depth >= MAX_CHAIN_YIELD_DEPTH || visited.has(blocker.name)) {
    return false;
  }

  visited.add(blocker.name);
  const candidates = getYieldCandidatePositions(pusher, blocker);
  for (const candidate of candidates) {
    if (isTileReserved(candidate, blocker.name)) {
      continue;
    }

    const occupyingCreep = findMyCreepAt(candidate, blocker.name);
    if (occupyingCreep) {
      if (!shouldYieldToPusher(blocker, occupyingCreep)) {
        continue;
      }
      if (!pushBlockingCreepChain(blocker, occupyingCreep, visited, depth + 1)) {
        continue;
      }
    }

    if (moveBlockerToYieldPosition(pusher, blocker, candidate)) {
      return true;
    }
  }

  return false;
}

function moveBlockerToYieldPosition(pusher: Creep, blocker: Creep, yieldPos: RoomPosition): boolean {
  const previousPos = new RoomPosition(blocker.pos.x, blocker.pos.y, blocker.pos.roomName);
  if (!reserveNextTile(blocker, yieldPos)) {
    return false;
  }

  const direction = blocker.pos.getDirectionTo(yieldPos);
  const moveCode = measureCreepIntent(() => blocker.move(direction));
  if (moveCode !== OK && moveCode !== ERR_TIRED) {
    return false;
  }

  const blockerMovePathState = blocker.memory.movePathState as MovePathState | undefined;
  if (
    blockerMovePathState?.expiresAt &&
    blockerMovePathState.expiresAt > Game.time &&
    Array.isArray(blockerMovePathState.steps)
  ) {
    blockerMovePathState.steps = [{ x: previousPos.x, y: previousPos.y }, ...blockerMovePathState.steps];
    blockerMovePathState.lastPosKey = getPosKey(yieldPos);
  } else {
    delete blocker.memory.movePathState;
  }

  blocker.memory.movementPushedAt = Game.time;
  recordMovementMetric("yieldPushes", pusher.room.name);
  return true;
}

function getYieldCandidatePositions(pusher: Creep, blocker: Creep): RoomPosition[] {
  const candidates: Array<{ pos: RoomPosition; score: number }> = [];

  for (const direction of ALL_DIRECTIONS) {
    const pos = getPositionAtDirection(blocker.pos, direction);
    if (!pos || !isStaticYieldTileWalkable(pos, blocker)) {
      continue;
    }

    let score = scoreYieldPosition(pos, blocker, pusher);
    if (findMyCreepAt(pos, blocker.name)) {
      score -= 15;
    }
    if (isTileReserved(pos, blocker.name)) {
      score -= 25;
    }
    candidates.push({ pos, score });
  }

  return candidates.sort((left, right) => right.score - left.score).map((entry) => entry.pos);
}

export function isYieldTileWalkable(pos: RoomPosition, blocker: Creep, pusher: Creep): boolean {
  if (!isStaticYieldTileWalkable(pos, blocker)) {
    return false;
  }

  if (isTileReserved(pos, blocker.name)) {
    return false;
  }

  const roomContext = getTickContextService().getRoomContext(blocker.room);
  if (!roomContext) {
    return false;
  }

  for (const structure of roomContext.getStructures()) {
    if (structure.pos.x !== pos.x || structure.pos.y !== pos.y) {
      continue;
    }
    if (!isWalkableStructure(structure)) {
      return false;
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (site.pos.x !== pos.x || site.pos.y !== pos.y) {
      continue;
    }
    if (site.my && !isWalkableConstructionSite(site)) {
      return false;
    }
  }

  for (const otherCreep of roomContext.getMyCreeps()) {
    if (otherCreep.name === blocker.name) {
      continue;
    }
    if (otherCreep.name === pusher.name && otherCreep.pos.x === pos.x && otherCreep.pos.y === pos.y) {
      continue;
    }
    if (otherCreep.pos.x === pos.x && otherCreep.pos.y === pos.y) {
      return false;
    }
  }

  return true;
}

function isStaticYieldTileWalkable(pos: RoomPosition, blocker: Creep): boolean {
  if (pos.roomName !== blocker.room.name) {
    return false;
  }

  const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
  if (terrain === TERRAIN_MASK_WALL) {
    return false;
  }

  const roomContext = getTickContextService().getRoomContext(blocker.room);
  if (!roomContext) {
    return false;
  }

  for (const structure of roomContext.getStructures()) {
    if (structure.pos.x !== pos.x || structure.pos.y !== pos.y) {
      continue;
    }
    if (!isWalkableStructure(structure)) {
      return false;
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (site.pos.x !== pos.x || site.pos.y !== pos.y) {
      continue;
    }
    if (site.my && !isWalkableConstructionSite(site)) {
      return false;
    }
  }

  return true;
}

function scoreYieldPosition(pos: RoomPosition, blocker: Creep, pusher: Creep): number {
  let score = 0;

  if (pos.x === pusher.pos.x && pos.y === pusher.pos.y) {
    score += 20;
  }

  if (!isExitTile(pos)) {
    score += 4;
  }

  const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
  if (terrain === TERRAIN_MASK_SWAMP) {
    score -= 2;
  } else {
    score += 1;
  }

  const blockerMovePathState = blocker.memory.movePathState as MovePathState | undefined;
  if (blockerMovePathState && blockerMovePathState.targetRoom === pos.roomName) {
    const blockerTarget = new RoomPosition(
      blockerMovePathState.targetX,
      blockerMovePathState.targetY,
      blockerMovePathState.targetRoom,
    );
    const blockerRange = blockerMovePathState.range;
    if (pos.getRangeTo(blockerTarget) <= blockerRange) {
      score += 10;
    }
    score -= pos.getRangeTo(blockerTarget);
  }

  return score;
}

export function moveOffExit(creep: Creep, avoidSwamp = true): ScreepsReturnCode {
  let swampDirection: DirectionConstant | undefined;
  for (const direction of [TOP, RIGHT, BOTTOM, LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT, TOP_LEFT] as DirectionConstant[]) {
    const position = getPositionAtDirection(creep.pos, direction);
    if (!position || isExitTile(position) || !isYieldTileWalkable(position, creep, creep)) {
      continue;
    }

    const terrain = Game.map.getRoomTerrain(position.roomName).get(position.x, position.y);
    if (avoidSwamp && terrain === TERRAIN_MASK_SWAMP) {
      swampDirection = direction;
      continue;
    }

    return measureCreepIntent(() => creep.move(direction));
  }

  if (swampDirection) {
    return measureCreepIntent(() => creep.move(swampDirection));
  }

  return ERR_NO_PATH;
}
