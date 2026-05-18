import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

// ---------------------------------------------------------------------------
// Task lookup
// ---------------------------------------------------------------------------

function getTaskForCreep(creep: Creep): PowerBankHarvestTask | null {
  const mem = creep.memory as PowerBankHaulerMemory;
  if (!mem.taskId) return null;
  return Memory.data?.powerBankHarvest?.[mem.taskId] ?? null;
}

function getSourceRoomName(creep: Creep): string {
  const task = getTaskForCreep(creep);
  if (task) return task.sourceRoom;
  return creep.memory.configName?.split(":")[0] || creep.room.name;
}

function getTargetRoomName(creep: Creep, targetRoom?: string): string | undefined {
  if (targetRoom) return targetRoom;

  const parts = creep.memory.configName?.split(":") || [];
  if (parts[1] === "powerbank" && parts[2]) {
    return parts[2];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Terminal state helpers
// ---------------------------------------------------------------------------

function isTerminalStatus(status: PowerBankHarvestStatus): boolean {
  return (
    status === POWER_BANK_STATUS.COMPLETE ||
    status === POWER_BANK_STATUS.FAILED ||
    status === POWER_BANK_STATUS.ABORTED
  );
}

// ---------------------------------------------------------------------------
// Power pickup in target room
// ---------------------------------------------------------------------------

function findDroppedPower(room: Room, bankPos: { x: number; y: number }): Resource | null {
  const resources = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });
  if (resources.length === 0) return null;

  // Sort by proximity to bank position
  resources.sort((a, b) => {
    const da = Math.abs(a.pos.x - bankPos.x) + Math.abs(a.pos.y - bankPos.y);
    const db = Math.abs(b.pos.x - bankPos.x) + Math.abs(b.pos.y - bankPos.y);
    return da - db;
  });

  return resources[0];
}

function findAnyDroppedPower(room: Room): Resource | null {
  if (typeof room.find !== "function") {
    return null;
  }

  const resources = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });
  if (resources.length === 0) return null;

  resources.sort((a, b) => b.amount - a.amount);
  return resources[0];
}

function findPowerBank(room: Room): StructurePowerBank | null {
  if (typeof room.find !== "function") {
    return null;
  }

  const banks = room.find(FIND_STRUCTURES, {
    filter: (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
  });

  return banks[0] || null;
}

function waitAwayFromBank(creep: Creep, bankPos: { x: number; y: number }): void {
  const range = Math.max(
    Math.abs(creep.pos.x - bankPos.x),
    Math.abs(creep.pos.y - bankPos.y),
  );
  if (range >= 5) {
    return;
  }

  const dx = creep.pos.x - bankPos.x;
  const dy = creep.pos.y - bankPos.y;
  let dir: DirectionConstant | null = null;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx === 0 && ady === 0) {
    dir = BOTTOM as DirectionConstant;
  } else if (adx >= 2 * ady) {
    dir = dx > 0 ? (RIGHT as DirectionConstant) : (LEFT as DirectionConstant);
  } else if (ady >= 2 * adx) {
    dir = dy > 0 ? (BOTTOM as DirectionConstant) : (TOP as DirectionConstant);
  } else if (dx > 0 && dy > 0) {
    dir = BOTTOM_RIGHT as DirectionConstant;
  } else if (dx > 0 && dy < 0) {
    dir = TOP_RIGHT as DirectionConstant;
  } else if (dx < 0 && dy > 0) {
    dir = BOTTOM_LEFT as DirectionConstant;
  } else {
    dir = TOP_LEFT as DirectionConstant;
  }

  measureCreepIntent(() => creep.move(dir));
}

function isExitCoordinate(x: number, y: number): boolean {
  return x <= 0 || x >= 49 || y <= 0 || y >= 49;
}

function getRangeToPosition(left: RoomPosition, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function findBankStagingPosition(creep: Creep, bankPos: RoomPosition): RoomPosition {
  const terrain = Game.map.getRoomTerrain(bankPos.roomName);
  let best: RoomPosition | null = null;
  let bestScore = Infinity;

  for (let x = Math.max(1, bankPos.x - 6); x <= Math.min(48, bankPos.x + 6); x += 1) {
    for (let y = Math.max(1, bankPos.y - 6); y <= Math.min(48, bankPos.y + 6); y += 1) {
      const range = Math.max(Math.abs(x - bankPos.x), Math.abs(y - bankPos.y));
      if (range < 5 || range > 6) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      const score = Math.abs(creep.pos.x - x) + Math.abs(creep.pos.y - y) + (range - 5) * 20;
      if (score >= bestScore) continue;

      bestScore = score;
      best = new RoomPosition(x, y, bankPos.roomName);
    }
  }

  return best ?? new RoomPosition(
    Math.min(48, Math.max(1, bankPos.x)),
    Math.min(48, Math.max(1, bankPos.y + 5)),
    bankPos.roomName,
  );
}

function moveToBankVicinity(creep: Creep, bankPos: RoomPosition | { x: number; y: number; roomName?: string }): void {
  const roomName = bankPos.roomName || creep.room.name;
  const targetPos = bankPos.roomName ? bankPos as RoomPosition : new RoomPosition(bankPos.x, bankPos.y, roomName);
  const range = getRangeToPosition(creep.pos, targetPos);

  if (creep.room.name === targetPos.roomName && range < 5) {
    waitAwayFromBank(creep, targetPos);
    return;
  }
  if (creep.room.name === targetPos.roomName && range <= 6 && !isExitCoordinate(creep.pos.x, creep.pos.y)) {
    return;
  }

  const stagingPos = findBankStagingPosition(creep, targetPos);

  measureCreepIntent(() => creep.moveTo(stagingPos, {
    range: 0,
    reusePath: 10,
    ignoreCreeps: true,
    visualizePathStyle: { stroke: "#ffaa00" },
  }));
}

// ---------------------------------------------------------------------------
// Delivery to source room storage/terminal
// ---------------------------------------------------------------------------

function deliverPower(creep: Creep): boolean {
  const sourceRoom = getSourceRoomName(creep);

  if (creep.room.name !== sourceRoom) {
    moveToTargetRoom(creep, sourceRoom, undefined, { travelRange: 3, reusePath: 10 });
    return false;
  }

  const resource = RESOURCE_POWER as ResourceConstant;

  // Prefer terminal (power is more useful there for factory/processing)
  if (creep.room.terminal && creep.room.terminal.store.getFreeCapacity(resource) > 0) {
    const code = measureCreepIntent(() => creep.transfer(creep.room.terminal!, resource));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, creep.room.terminal);
    }
    return code === OK && creep.store.getUsedCapacity() === 0;
  }

  // Fallback to storage
  if (creep.room.storage && creep.room.storage.store.getFreeCapacity(resource) > 0) {
    const code = measureCreepIntent(() => creep.transfer(creep.room.storage!, resource));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, creep.room.storage);
    }
    return code === OK && creep.store.getUsedCapacity() === 0;
  }

  return false;
}

function retireIfEmpty(creep: Creep): boolean {
  if (creep.store.getUsedCapacity() > 0) return false;
  creep.suicide();
  return true;
}

function salvagePower(creep: Creep, targetRoom?: string): boolean {
  const resolvedTargetRoom = getTargetRoomName(creep, targetRoom);
  if (!resolvedTargetRoom) {
    return true;
  }

  if (creep.store.getUsedCapacity() > 0) {
    return deliverPower(creep);
  }

  if (creep.room.name !== resolvedTargetRoom) {
    moveToTargetRoom(creep, resolvedTargetRoom, undefined, { travelRange: 3, reusePath: 10 });
    return false;
  }

  const dropped = findAnyDroppedPower(creep.room);
  if (dropped) {
    const code = measureCreepIntent(() => creep.pickup(dropped));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, dropped);
    }
    return creep.store.getFreeCapacity() <= 0;
  }

  const bank = findPowerBank(creep.room);
  if (bank) {
    moveToBankVicinity(creep, bank.pos);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Role lifecycle
// ---------------------------------------------------------------------------

export const powerBankHaulerRole: RoleFactory = (targetRoom?: string, _encodedRouteRooms?: string) => ({
  prepare: (creep): boolean => {
    // Haulers are task-bound — skip generic energy assignments
    const task = getTaskForCreep(creep);
    if (!task) {
      return salvagePower(creep, targetRoom);
    }

    // If terminal status and holding power, go deliver
    if (isTerminalStatus(task.status) && creep.store.getUsedCapacity() > 0) {
      return true;
    }

    if (isTerminalStatus(task.status)) {
      return retireIfEmpty(creep);
    }

    return true;
  },

  source: (creep): boolean => {
    const task = getTaskForCreep(creep);

    // No task — salvage dropped power for aborted/replaced squads.
    if (!task) {
      const done = salvagePower(creep, targetRoom);
      if (done) retireIfEmpty(creep);
      return done;
    }

    // Terminal status — deliver held power, then done
    if (isTerminalStatus(task.status)) {
      if (creep.store.getUsedCapacity() > 0) {
        return deliverPower(creep);
      }
      return retireIfEmpty(creep);
    }

    // Travel to target room
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    // In target room before pickup — stage near the bank at a safe range.
    if (task.status !== POWER_BANK_STATUS.HAULING) {
      const bankPos = task.bankPos;
      moveToBankVicinity(creep, { ...bankPos, roomName: task.targetRoom });
      return false;
    }

    // Hauling phase — bank destroyed, pick up dropped power
    if (task.status === POWER_BANK_STATUS.HAULING) {
      // Already full — go deliver
      if (creep.store.getFreeCapacity() <= 0) {
        return true;
      }

      const dropped = findDroppedPower(creep.room, task.bankPos);
      if (!dropped) {
        // No more power on ground
        if (creep.store.getUsedCapacity() > 0) {
          return true;
        }
        return false;
      }

      const code = measureCreepIntent(() => creep.pickup(dropped));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, dropped);
      }

      // Done sourcing when full
      return creep.store.getFreeCapacity() <= 0;
    }

    return false;
  },

  target: (creep): boolean => {
    // Deliver held power to source room
    if (creep.store.getUsedCapacity() > 0) {
      return deliverPower(creep);
    }

    // Nothing to deliver — check if we should go back for more
    const task = getTaskForCreep(creep);

    if (!task || isTerminalStatus(task.status)) {
      return retireIfEmpty(creep);
    }

    // Still in hauling phase — go back for more power
    if (task.status === POWER_BANK_STATUS.HAULING && targetRoom) {
      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
        return false;
      }
      // Switch back to source phase
      return false;
    }

    return true;
  },
});
