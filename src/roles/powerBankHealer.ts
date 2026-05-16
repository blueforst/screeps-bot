import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "preparing_boosts",
  "spawning",
  "renewing",
  "boosting",
]);

function getTaskForCreep(creep: Creep): PowerBankHarvestTask | null {
  const taskId = (creep.memory as any).taskId as string | undefined;
  if (!taskId) return null;
  return Memory.data?.powerBankHarvest?.[taskId] ?? null;
}

function findPairedAttacker(creep: Creep): Creep | null {
  const task = getTaskForCreep(creep);
  if (!task) return null;

  if (task.attackerId) {
    const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
    if (attacker) return attacker;
  }

  const taskId = (creep.memory as any).taskId as string;
  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "powerBankAttacker") continue;
    if ((candidate.memory as any).taskId !== taskId) continue;
    return candidate;
  }

  return null;
}

export const powerBankHealerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;

    if (task?.status === "travelling") {
      const attacker = findPairedAttacker(creep);
      if (!attacker) return false;

      if (attacker.room.name === creep.room.name && creep.pos.getRangeTo(attacker.pos) > 1) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
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

    const attacker = findPairedAttacker(creep);

    if (task?.status === "travelling") {
      if (!attacker) return false;

      const sameRoom = attacker.room.name === creep.room.name;
      if (sameRoom && creep.pos.getRangeTo(attacker.pos) > 1) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        return false;
      }
      if (!sameRoom) {
        moveToTargetRoom(creep, attacker.room.name, undefined, { plainCost: 2, swampCost: 8 });
        return false;
      }
    }

    if (!attacker) {
      if (creep.hits < creep.hitsMax) {
        measureCreepIntent(() => creep.heal(creep));
      }
      return false;
    }

    const sameRoom = attacker.room.name === creep.room.name;
    const attackerDamaged = attacker.hits < attacker.hitsMax;
    const range = sameRoom ? creep.pos.getRangeTo(attacker.pos) : Infinity;

    if (sameRoom && attackerDamaged) {
      if (range <= 1) {
        measureCreepIntent(() => creep.heal(attacker));
      } else if (range <= 3) {
        measureCreepIntent(() => creep.rangedHeal(attacker));
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      } else {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      }
    } else if (sameRoom && !attackerDamaged) {
      if (!creep.pos.isNearTo(attacker.pos)) {
        moveToTarget(creep, attacker, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      }
    } else {
      moveToTargetRoom(creep, attacker.room.name, undefined, { plainCost: 2, swampCost: 8 });
    }

    if (creep.hits < creep.hitsMax && (!attackerDamaged || range > 1)) {
      measureCreepIntent(() => creep.heal(creep));
    }

    return false;
  },
});
