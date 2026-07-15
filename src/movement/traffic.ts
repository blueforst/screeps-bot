import { ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { recordMovementMetric } from "@/movement/metrics";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getPositionAtDirection, isExitTile, isWalkableConstructionSite, isWalkableStructure } from "@/movement/common";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";

const ALL_DIRECTIONS: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function findMyCreepAt(pos: RoomPosition, excludeName?: string): Creep | null {
  const roomContext = getTickContextService().getRoomContext(pos.roomName);
  const myCreeps = roomContext?.getMyCreeps() || [];
  return myCreeps.find((c) => c.name !== excludeName && c.pos.x === pos.x && c.pos.y === pos.y) || null;
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export function isBlockerActivelyMoving(blocker: Creep): boolean {
  const state = getCreepMovementState(blocker.name);
  if (!state) {
    return false;
  }
  // A creep with an active path/travel state is still on its own route even if
  // it has not executed yet this tick. Do not let earlier creeps in iteration
  // order push it away and create yield loops; idle roles must clear movement
  // state when they intentionally stop.
  if (state.pathingRequestedAt === Game.time) {
    return true;
  }
  if (state.movePathState && state.movePathState.expiresAt > Game.time) {
    return true;
  }
  if (state.travelState && state.travelState.targetRoom !== blocker.room.name) {
    return true;
  }
  return false;
}

/**
 * Pushes a stationary blocker to a nearby free tile.
 * Returns true if the blocker was successfully moved.
 */
export function pushBlockingCreep(pusher: Creep, blocker: Creep): boolean {
  for (const candidate of getYieldCandidatePositions(pusher, blocker)) {
    const occupant = findMyCreepAt(candidate, blocker.name);
    if (occupant && occupant.name !== pusher.name) {
      continue;
    }
    if (moveBlockerToYieldPosition(pusher, blocker, candidate)) {
      return true;
    }
  }
  return false;
}

export function moveToAdjacentPosition(creep: Creep, nextPos: RoomPosition): ScreepsReturnCode {
  if (creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  const direction = creep.pos.getDirectionTo(nextPos);
  const blockingCreep = findMyCreepAt(nextPos, creep.name);
  if (!blockingCreep) {
    return measureCreepIntent(() => creep.move(direction));
  }

  if (isHeadOnWarDuoSwap(creep, blockingCreep)) {
    if (pushBlockingCreep(creep, blockingCreep)) {
      return measureCreepIntent(() => creep.move(direction));
    }
    return ERR_BUSY;
  }

  if (isBlockerActivelyMoving(blockingCreep)) {
    return measureCreepIntent(() => creep.move(direction));
  }

  if (pushBlockingCreep(creep, blockingCreep)) {
    return measureCreepIntent(() => creep.move(direction));
  }

  return ERR_BUSY;
}

function isHeadOnWarDuoSwap(attacker: Creep, healer: Creep): boolean {
  if (attacker.memory.role !== "meleeAttacker" || healer.memory.role !== "healer") return false;

  const attackerConfig = attacker.memory.configName;
  if (!attackerConfig?.includes(":war:") || !attackerConfig.includes(":meleeAttacker:")) return false;
  if (healer.memory.configName !== attackerConfig.replace(":meleeAttacker:", ":healer:")) return false;

  const nextStep = getPlannedNextStep(healer);
  return nextStep?.x === attacker.pos.x && nextStep.y === attacker.pos.y;
}

function getPlannedNextStep(creep: Creep): { x: number; y: number } | null {
  const steps = getCreepMovementState(creep.name)?.movePathState?.steps;
  if (!steps || steps.length === 0) return null;

  const exactIndex = steps.findIndex((step) => step.x === creep.pos.x && step.y === creep.pos.y);
  if (exactIndex >= 0) return steps[exactIndex + 1] ?? null;

  let closest: { x: number; y: number } | null = null;
  let closestRange = Infinity;
  for (const step of steps) {
    const range = Math.max(Math.abs(creep.pos.x - step.x), Math.abs(creep.pos.y - step.y));
    if (range >= closestRange) continue;
    closest = step;
    closestRange = range;
  }

  return closestRange <= 1 ? closest : null;
}

function moveBlockerToYieldPosition(pusher: Creep, blocker: Creep, yieldPos: RoomPosition): boolean {
  const moveCode = measureCreepIntent(() => blocker.move(blocker.pos.getDirectionTo(yieldPos)));
  if (moveCode !== OK) {
    return false;
  }

  const blockerState = ensureCreepMovementState(blocker.name);
  delete blockerState.movePathState;
  blockerState.movementPushedAt = Game.time;
  recordMovementMetric("yieldPushes", pusher.room.name);
  return true;
}

// ─── Yield position selection ─────────────────────────────────────────────────

function getYieldCandidatePositions(pusher: Creep, blocker: Creep): RoomPosition[] {
  const candidates: Array<{ pos: RoomPosition; score: number }> = [];
  const haulerPair = isPowerBankHauler(pusher) && isPowerBankHauler(blocker);

  for (const direction of ALL_DIRECTIONS) {
    const pos = getPositionAtDirection(blocker.pos, direction);
    if (!pos || !isYieldTileWalkable(pos, blocker)) {
      continue;
    }
    if (haulerPair && pos.x === pusher.pos.x && pos.y === pusher.pos.y) {
      continue;
    }
    let score = scoreYieldPosition(pos, blocker, pusher);
    const occupant = findMyCreepAt(pos, blocker.name);
    if (occupant && occupant.name !== pusher.name) {
      score -= 15;
    }
    candidates.push({ pos, score });
  }

  return candidates.sort((a, b) => b.score - a.score).map((e) => e.pos);
}

function isPowerBankHauler(creep: Creep): boolean {
  return creep.memory.role === "powerBankHauler";
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
  score += terrain === TERRAIN_MASK_SWAMP ? -2 : 1;

  // Stationary creeps with a work anchor should stay close to it.
  const workAnchor = getCreepMovementState(blocker.name)?.workAnchor;
  if (workAnchor && workAnchor.roomName === pos.roomName) {
    const anchorPos = new RoomPosition(workAnchor.x, workAnchor.y, workAnchor.roomName);
    const dist = pos.getRangeTo(anchorPos);
    if (dist <= workAnchor.range) {
      // Strongly prefer staying within work range — this dominates swap and terrain bonuses.
      score += 30;
    } else {
      score -= dist;
    }
  }

  return score;
}

function isYieldTileWalkable(pos: RoomPosition, blocker: Creep): boolean {
  if (pos.roomName !== blocker.room.name) {
    return false;
  }
  if (Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
    return false;
  }

  const roomContext = getTickContextService().getRoomContext(blocker.room);
  if (!roomContext) {
    return false;
  }

  for (const structure of roomContext.getStructures()) {
    if (structure.pos.x === pos.x && structure.pos.y === pos.y && !isWalkableStructure(structure)) {
      return false;
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (site.pos.x === pos.x && site.pos.y === pos.y && site.my && !isWalkableConstructionSite(site)) {
      return false;
    }
  }

  return true;
}

// ─── Exit recovery ────────────────────────────────────────────────────────────

export function moveOffExit(creep: Creep, avoidSwamp = true): ScreepsReturnCode {
  let swampDirection: DirectionConstant | undefined;

  for (const direction of [TOP, RIGHT, BOTTOM, LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT, TOP_LEFT] as DirectionConstant[]) {
    const pos = getPositionAtDirection(creep.pos, direction);
    if (!pos || isExitTile(pos) || !isYieldTileWalkable(pos, creep)) {
      continue;
    }
    if (findMyCreepAt(pos, creep.name)) {
      continue;
    }

    const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
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
