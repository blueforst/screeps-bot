import { measureCreepIntent, measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { clearCreepMovementState, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { recordMovementMetric } from "@/movement/metrics";
import { getTickContextService } from "@/runtime/runtimeServices";
import { isPositionAllowedForCreep, shouldRestrictToSafeZone } from "@/runtime/safeZoneHelpers";
import { getPosKey, getTargetPos, isExitTile, isWalkableConstructionSite, isWalkableStructure } from "@/movement/common";
import { findMyCreepAt, moveOffExit, pushBlockingCreep } from "@/movement/traffic";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import type { MovePathState, MoveToTargetOptions, RoomCostMatrixCacheEntry, WorkAnchor } from "@/movement/types";

const MOVE_PATH_CACHE_TTL = 20;
const roomBaseCostMatrixCache = new Map<string, RoomCostMatrixCacheEntry>();
const ROOM_BASE_COST_MATRIX_CACHE_TTL = 5;
const ROOM_BASE_COST_MATRIX_CACHE_MAX = 100;

export function clearMovementState(creep: Creep): void {
  recordMovementMetric("stateClears", creep.room.name);
  clearCreepMovementState(creep.name);
  delete creep.memory._move;
}

export function moveToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range: 0 | 1 | 3 = 1,
  options: MoveToTargetOptions = {},
): ScreepsReturnCode {
  recordMovementMetric("pathRequests", creep.room.name);

  const movementState = ensureCreepMovementState(creep.name);

  if (movementState.movementPushedAt === Game.time) {
    return OK;
  }

  const targetPos = getTargetPos(target);
  if (creep.pos.getRangeTo(targetPos) <= range) {
    delete movementState.movePathState;
    return OK;
  }

  if (shouldRestrictToSafeZone(creep) && !isPositionAllowedForCreep(creep, targetPos)) {
    delete movementState.movePathState;
    return ERR_NO_PATH;
  }

  if (sameRoomNonEdgeMoveNeedsExitRecovery(creep, targetPos)) {
    recordMovementMetric("exitRecoveries", creep.room.name);
    const exitRecoveryCode = moveOffExit(creep);
    if (exitRecoveryCode === OK || exitRecoveryCode === ERR_TIRED) {
      return exitRecoveryCode;
    }
  }

  const reusePath = options.reusePath ?? 5;
  const ignoreCreeps = options.ignoreCreeps ?? true;
  const sameRoomTarget = creep.room.name === targetPos.roomName;
  const movePathKey = `${creep.room.name}:${targetPos.roomName}:${targetPos.x}:${targetPos.y}:r${range}:i${
    ignoreCreeps ? 1 : 0
  }:s${options.swampCost ?? "d"}:p${options.plainCost ?? "d"}:m${options.maxRooms ?? "d"}`;

  if (sameRoomTarget) {
    const currentPosKey = getPosKey(creep.pos);
    const movePathState = movementState.movePathState;
    const isMatchingState =
      movePathState &&
      movePathState.key === movePathKey &&
      movePathState.targetRoom === targetPos.roomName &&
      movePathState.targetX === targetPos.x &&
      movePathState.targetY === targetPos.y &&
      movePathState.range === range &&
      movePathState.expiresAt > Game.time;

    if (isMatchingState && movePathState.path) {
      if (movePathState.lastPosKey === currentPosKey && creep.fatigue === 0) {
        movePathState.stuckTicks += 1;
      } else {
        movePathState.stuckTicks = 0;
      }
      movePathState.lastPosKey = currentPosKey;

      const cachedMoveCode = followStoredRoomPath(creep, movePathState, targetPos, range);
      if (cachedMoveCode === OK || cachedMoveCode === ERR_TIRED || cachedMoveCode === ERR_BUSY) {
        recordMovementMetric("pathCacheHits", creep.room.name);
        return cachedMoveCode;
      }

      delete movementState.movePathState;
    }

    recordMovementMetric("pathRepaths", creep.room.name);

    const path = measureCreepPathing(() =>
      creep.pos.findPathTo(targetPos, {
        range,
        swampCost: options.swampCost,
        plainCost: options.plainCost,
        ignoreCreeps,
        maxRooms: options.maxRooms,
        costCallback: (roomName, matrix) => buildRoomCostMatrix(creep, roomName, matrix, options),
      }),
    );

    if (path.length > 0) {
      const serializedPath = Room.serializePath(path);
      const steps = path.map((step) => ({ x: step.x, y: step.y }));
      movementState.movePathState = {
        key: movePathKey,
        path: serializedPath,
        steps,
        targetRoom: targetPos.roomName,
        targetX: targetPos.x,
        targetY: targetPos.y,
        range,
        lastPosKey: currentPosKey,
        stuckTicks: 0,
        expiresAt: reusePath === 0 ? Game.time : Game.time + Math.max(MOVE_PATH_CACHE_TTL, reusePath),
      };

      const followPathCode = followStoredRoomPath(creep, movementState.movePathState, targetPos, range);
      if (followPathCode === OK || followPathCode === ERR_TIRED || followPathCode === ERR_BUSY) {
        return followPathCode;
      }

      delete movementState.movePathState;
    }
  } else {
    delete movementState.movePathState;
  }

  return measureCreepIntent(() =>
    creep.moveTo(targetPos, {
      range,
      swampCost: options.swampCost,
      plainCost: options.plainCost,
      reusePath,
      maxRooms: options.maxRooms,
      ignoreCreeps,
      visualizePathStyle: { stroke: "#ffaa00" },
    }),
  );
}

export function moveToRemoteWorkTarget(creep: Creep, target: RoomPosition | { pos: RoomPosition }): ScreepsReturnCode {
  const targetPos = getTargetPos(target);
  const movementState = ensureCreepMovementState(creep.name);
  if (creep.pos.getRangeTo(targetPos) <= 3) {
    movementState.workAnchor = { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName, range: 3 } satisfies WorkAnchor;
    return OK;
  }

  delete movementState.workAnchor;
  return moveToTarget(creep, targetPos, 3, {
    swampCost: 8,
    reusePath: 5,
    ignoreCreeps: true,
  });
}

function sameRoomNonEdgeMoveNeedsExitRecovery(creep: Creep, targetPos: RoomPosition): boolean {
  return creep.room.name === targetPos.roomName && isExitTile(creep.pos) && !isExitTile(targetPos);
}

function buildRoomCostMatrix(
  creep: Creep,
  roomName: string,
  matrix: CostMatrix,
  options: MoveToTargetOptions,
): CostMatrix {
  if (roomName !== creep.room.name) {
    return matrix;
  }

  const roomContext = getTickContextService().getRoomContext(creep.room);
  if (!roomContext) {
    return matrix;
  }

  const roomMatrix = getCachedRoomBaseCostMatrix(creep.room, roomContext, matrix, options);

  if (options.ignoreCreeps ?? true) {
    return roomMatrix;
  }

  for (const otherCreep of roomContext.getMyCreeps()) {
    if (otherCreep.name === creep.name) {
      continue;
    }
    roomMatrix.set(otherCreep.pos.x, otherCreep.pos.y, 0xfe);
  }

  return roomMatrix;
}

function getCachedRoomBaseCostMatrix(
  room: Room,
  roomContext: ReturnType<ReturnType<typeof getTickContextService>["getRoomContext"]>,
  fallbackMatrix: CostMatrix,
  options: MoveToTargetOptions,
): CostMatrix {
  const plainCost = options.plainCost ?? 1;
  const swampCost = options.swampCost ?? 5;
  const cacheKey = `${room.name}:p${plainCost}:s${swampCost}`;
  const cached = roomBaseCostMatrixCache.get(cacheKey);
  if (cached?.tick === Game.time) {
    return cached.matrix.clone();
  }

  pruneRoomBaseCostMatrixCache();

  const baseMatrix = fallbackMatrix.clone();
  for (const structure of roomContext.getStructures()) {
    if (structure.structureType === STRUCTURE_ROAD) {
      if (baseMatrix.get(structure.pos.x, structure.pos.y) < 0xfe) {
        baseMatrix.set(structure.pos.x, structure.pos.y, 1);
      }
      continue;
    }

    if (!isWalkableStructure(structure)) {
      baseMatrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (site.my && !isWalkableConstructionSite(site)) {
      baseMatrix.set(site.pos.x, site.pos.y, 0xff);
    }
  }

  for (const pos of getSourceContainerPositionsForRoom(room.name)) {
    if (baseMatrix.get(pos.x, pos.y) < 0xfe) {
      baseMatrix.set(pos.x, pos.y, 0xfe);
    }
  }

  roomBaseCostMatrixCache.set(cacheKey, {
    tick: Game.time,
    matrix: baseMatrix,
  });
  pruneRoomBaseCostMatrixCache();
  return baseMatrix.clone();
}

function followStoredRoomPath(
  creep: Creep,
  movePathState: MovePathState,
  targetPos: RoomPosition,
  range: 0 | 1 | 3,
): ScreepsReturnCode {
  if (creep.pos.getRangeTo(targetPos) <= range) {
    return OK;
  }

  const nextPos = getNextStoredPathStep(creep, movePathState.steps);
  if (!nextPos) {
    delete ensureCreepMovementState(creep.name).movePathState;
    return ERR_NO_PATH;
  }

  const blockingCreep = findMyCreepAt(nextPos, creep.name);
  if (blockingCreep) {
    const blockerState = getCreepMovementState(blockingCreep.name);
    const blockerPathState = blockerState?.movePathState;
    const blockerIsStationaryWorker = !!blockerState?.workAnchor;
    const blockerWillMoveNaturally = !blockerIsStationaryWorker && !!blockerPathState && blockerPathState.expiresAt > Game.time;

    if (blockerWillMoveNaturally) {
      // Blocker is actively moving — submit our move and let the engine resolve it naturally.
      return moveToAdjacentPosition(creep, nextPos);
    }

    // Blocker is stationary — push it to a nearby free tile.
    if (pushBlockingCreep(creep, blockingCreep)) {
      return moveToAdjacentPosition(creep, nextPos);
    }

    delete ensureCreepMovementState(creep.name).movePathState;
    return ERR_BUSY;
  }

  return moveToAdjacentPosition(creep, nextPos);
}

function getNextStoredPathStep(creep: Creep, steps: MovePathState["steps"]): RoomPosition | null {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const exactIndex = steps.findIndex((step) => creep.pos.x === step.x && creep.pos.y === step.y);
  if (exactIndex >= 0) {
    const nextStep = steps[exactIndex + 1];
    return nextStep ? new RoomPosition(nextStep.x, nextStep.y, creep.room.name) : null;
  }

  let bestIndex = -1;
  let bestRange = Infinity;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const range = creep.pos.getRangeTo(step.x, step.y);
    if (range >= bestRange) {
      continue;
    }
    bestRange = range;
    bestIndex = index;
  }

  if (bestIndex < 0) {
    return null;
  }

  const candidate = steps[bestIndex];
  if (bestRange <= 1) {
    return new RoomPosition(candidate.x, candidate.y, creep.room.name);
  }

  const nextStep = steps[bestIndex + 1];
  if (!nextStep) {
    return new RoomPosition(candidate.x, candidate.y, creep.room.name);
  }

  return new RoomPosition(nextStep.x, nextStep.y, creep.room.name);
}

function moveToAdjacentPosition(creep: Creep, nextPos: RoomPosition): ScreepsReturnCode {
  if (creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  const direction = creep.pos.getDirectionTo(nextPos);
  return measureCreepIntent(() => creep.move(direction));
}

function pruneRoomBaseCostMatrixCache(): void {
  if (roomBaseCostMatrixCache.size === 0) {
    return;
  }

  for (const [key, entry] of roomBaseCostMatrixCache.entries()) {
    if (Game.time - entry.tick > ROOM_BASE_COST_MATRIX_CACHE_TTL) {
      roomBaseCostMatrixCache.delete(key);
    }
  }

  if (roomBaseCostMatrixCache.size <= ROOM_BASE_COST_MATRIX_CACHE_MAX) {
    return;
  }

  const oldestEntries = [...roomBaseCostMatrixCache.entries()].sort((left, right) => left[1].tick - right[1].tick);
  const overflow = roomBaseCostMatrixCache.size - ROOM_BASE_COST_MATRIX_CACHE_MAX;
  for (const [key] of oldestEntries.slice(0, overflow)) {
    roomBaseCostMatrixCache.delete(key);
  }
}

export function getRoomBaseCostMatrixCacheSizeForTest(): number {
  return roomBaseCostMatrixCache.size;
}

export function clearRoomBaseCostMatrixCacheForTest(): void {
  roomBaseCostMatrixCache.clear();
}
