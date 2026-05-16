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

// ---------------------------------------------------------------------------
// Role lifecycle
// ---------------------------------------------------------------------------

export const powerBankHaulerRole: RoleFactory = (targetRoom?: string, _encodedRouteRooms?: string) => ({
  prepare: (creep): boolean => {
    // Haulers are task-bound — skip generic energy assignments
    const task = getTaskForCreep(creep);
    if (!task) {
      // No task — deliver anything held, then signal done
      if (creep.store.getUsedCapacity() > 0) {
        return true;
      }
      return true;
    }

    // If terminal status and holding power, go deliver
    if (isTerminalStatus(task.status) && creep.store.getUsedCapacity() > 0) {
      return true;
    }

    return true;
  },

  source: (creep): boolean => {
    const task = getTaskForCreep(creep);

    // No task — deliver any held resources then mark done
    if (!task) {
      if (creep.store.getUsedCapacity() > 0) {
        return deliverPower(creep);
      }
      return true;
    }

    // Terminal status — deliver held power, then done
    if (isTerminalStatus(task.status)) {
      if (creep.store.getUsedCapacity() > 0) {
        return deliverPower(creep);
      }
      return true;
    }

    // Travel to target room
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    // In target room — wait at safe range while bank is being attacked
    if (task.status === POWER_BANK_STATUS.ATTACKING) {
      const bankPos = task.bankPos;
      const range = Math.max(
        Math.abs(creep.pos.x - bankPos.x),
        Math.abs(creep.pos.y - bankPos.y),
      );
      if (range < 5) {
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
        if (dir) {
          measureCreepIntent(() => creep.move(dir));
        }
      }
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
      return true;
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
