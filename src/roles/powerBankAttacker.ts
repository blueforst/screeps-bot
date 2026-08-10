import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import {
  getPowerBankAvoidRooms,
  getPowerBankEncodedRouteBetween,
  getPowerBankTaskForCreep,
  pairReadyForCombat,
  pairReadyForTravel,
  resolvePowerBankPair,
  type PowerBankPairContext,
} from "@/roles/powerBankCombatPair";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { ensureCreepMovementState } from "@/movement/creepState";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
  "failed",
  "aborted",
]);

function retireIfOrphanedPowerBankCreep(creep: Creep): boolean {
  if (!creep.memory.configName?.includes(":powerbank:")) return false;
  creep.suicide();
  return true;
}

function isExitTile(pos: RoomPosition): boolean {
  return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function moveOffRoomExit(creep: Creep): boolean {
  let horizontal: DirectionConstant | null = null;
  let vertical: DirectionConstant | null = null;

  if (creep.pos.x <= 0) horizontal = RIGHT;
  else if (creep.pos.x >= 49) horizontal = LEFT;

  if (creep.pos.y <= 0) vertical = BOTTOM;
  else if (creep.pos.y >= 49) vertical = TOP;

  let direction: DirectionConstant | null = null;
  if (horizontal && vertical) {
    if (horizontal === RIGHT && vertical === BOTTOM) direction = BOTTOM_RIGHT;
    else if (horizontal === RIGHT && vertical === TOP) direction = TOP_RIGHT;
    else if (horizontal === LEFT && vertical === BOTTOM) direction = BOTTOM_LEFT;
    else direction = TOP_LEFT;
  } else {
    direction = horizontal ?? vertical;
  }

  if (!direction) return false;
  // Tactical directional move — not destination pathfinding.
  clearMovementState(creep);
  const code = measureCreepIntent(() => creep.move(direction));
  if (code === OK || code === ERR_TIRED) {
    ensureCreepMovementState(creep).pathingRequestedAt = Game.time;
  }
  return true;
}

function moveToPowerBank(creep: Creep, bank: StructurePowerBank): void {
  const dynamicCode = moveToTarget(creep, bank, 1, {
    plainCost: 2,
    swampCost: 8,
    ignoreCreeps: false,
    reusePath: 0,
    maxRooms: 1,
  });
  if (dynamicCode !== ERR_NO_PATH) return;
  moveToTarget(creep, bank, 1, {
    plainCost: 2,
    swampCost: 8,
    ignoreCreeps: true,
    reusePath: 0,
    maxRooms: 1,
  });
}

/** Leader movement is lockstep: it advances only while its healer is adjacent. */
function travelWithHealer(
  creep: Creep,
  pair: PowerBankPairContext,
  targetRoom: string,
  fallbackEncodedRoute?: string,
): void {
  if (!pairReadyForTravel(pair)) return;

  const healer = pair.healer;
  if (healer.room.name !== creep.room.name || !creep.pos.isNearTo(healer.pos)) {
    // After crossing, leave the edge so the follower can complete the same
    // transition. On ordinary tiles the leader simply waits.
    if (isExitTile(creep.pos)) moveOffRoomExit(creep);
    else clearMovementState(creep);
    return;
  }

  if (creep.room.name === targetRoom) {
    clearMovementState(creep);
    return;
  }
  moveToTargetRoom(
    creep,
    targetRoom,
    getPowerBankEncodedRouteBetween(pair.task, creep.room.name, targetRoom, fallbackEncodedRoute),
    { ...TRAVEL_OPTIONS, avoidRooms: getPowerBankAvoidRooms(pair.task) },
  );
}

export const powerBankAttackerRole: RoleFactory = (targetRoomArg?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) return false;

    const targetRoom = task.targetRoom || targetRoomArg;
    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== targetRoom)) {
      travelWithHealer(creep, pair, targetRoom, encodedRouteRooms);
      return false;
    }

    return pair.stage === "attacking";
  },

  target: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) return false;

    const targetRoom = task.targetRoom || targetRoomArg;
    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== targetRoom)) {
      travelWithHealer(creep, pair, targetRoom, encodedRouteRooms);
      return false;
    }
    if (pair.stage !== "attacking") return false;

    const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);
    // The manager owns all task transitions. A missing bank is merely an
    // observation here; the role must not turn it into hauling or suicide.
    if (!bank) {
      clearMovementState(creep);
      return false;
    }
    if (!pairReadyForCombat(pair)) {
      clearMovementState(creep);
      return false;
    }

    const code = measureCreepIntent(() => creep.attack(bank));
    if (code === ERR_NOT_IN_RANGE) {
      moveToPowerBank(creep, bank);
    } else {
      clearMovementState(creep);
    }

    return false;
  },
});
