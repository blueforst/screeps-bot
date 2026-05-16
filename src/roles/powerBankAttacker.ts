import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

function isTOUGHLayerBroken(creep: Creep): boolean {
  return creep.body.every((p) => p.type !== TOUGH || p.hits <= 0);
}

function getTaskForCreep(creep: Creep): PowerBankHarvestTask | null {
  const taskId = (creep.memory as any).taskId as string | undefined;
  if (!taskId) return null;
  return Memory.data?.powerBankHarvest?.[taskId] ?? null;
}

function signalAbort(creep: Creep): void {
  const taskId = (creep.memory as any).taskId as string | undefined;
  if (!taskId) return;
  const task = Memory.data?.powerBankHarvest?.[taskId];
  if (task) {
    task.status = "aborted";
  }
}

export const powerBankAttackerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getTaskForCreep(creep);
    if (task?.status === "boosting") return true;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 8 });
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    // Travel to target room if not there yet
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 8 });
      return false;
    }

    const task = getTaskForCreep(creep);
    if (!task) return false;

    // Find the power bank by ID
    const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);

    // Bank no longer exists — signal abort
    if (!bank) {
      signalAbort(creep);
      return false;
    }

    // Check if TOUGH layer is broken — stop attacking, move away, signal abort
    if (isTOUGHLayerBroken(creep)) {
      signalAbort(creep);
      // Move away from the bank
      if (creep.pos.getRangeTo(bank.pos) <= 2) {
        const dir = bank.pos.getDirectionTo(creep.pos);
        if (dir) {
          measureCreepIntent(() => creep.move(dir));
        }
      }
      return false;
    }

    // Attack the power bank
    const code = measureCreepIntent(() => creep.attack(bank));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, bank, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
    }

    return false;
  },
});
