import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "preparing_boosts",
  "spawning",
  "renewing",
  "boosting",
]);

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

function findPairedHealer(creep: Creep): Creep | null {
  const taskId = (creep.memory as any).taskId as string | undefined;
  if (!taskId) return null;
  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "powerBankHealer") continue;
    if ((candidate.memory as any).taskId !== taskId) continue;
    return candidate;
  }
  return null;
}

export const powerBankAttackerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;

    if (task?.status === "travelling") {
      const healer = findPairedHealer(creep);
      if (!healer) return false;

      if (healer.room.name !== creep.room.name) {
        moveToTargetRoom(creep, healer.room.name, "", { plainCost: 2, swampCost: 8 });
        return false;
      }

      if (creep.pos.getRangeTo(healer.pos) > 1) {
        moveToTarget(creep, healer, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        return false;
      }
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 8 });
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;

    if (task?.status === "travelling") {
      const healer = findPairedHealer(creep);
      if (!healer) return false;

      if (healer.room.name !== creep.room.name) {
        moveToTargetRoom(creep, healer.room.name, "", { plainCost: 2, swampCost: 8 });
        return false;
      }

      if (creep.pos.getRangeTo(healer.pos) > 1) {
        moveToTarget(creep, healer, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        return false;
      }
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 8 });
      return false;
    }

    if (!task) return false;

    const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);

    if (!bank) {
      signalAbort(creep);
      return false;
    }

    if (isTOUGHLayerBroken(creep)) {
      signalAbort(creep);
      if (creep.pos.getRangeTo(bank.pos) <= 2) {
        const dir = bank.pos.getDirectionTo(creep.pos);
        if (dir) {
          measureCreepIntent(() => creep.move(dir));
        }
      }
      return false;
    }

    const code = measureCreepIntent(() => creep.attack(bank));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, bank, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
    }

    return false;
  },
});
