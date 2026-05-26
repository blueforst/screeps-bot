import type { RoleFactory } from "@/types/system";
import { POWER_BANK_PATROL_ROOMS, isPowerBankPatrolRoom } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { moveToTargetRoom } from "@/roles/shared";

interface PatrolMemory {
  patrolIndex?: number;
}

function ensurePatrolMemory(creep: Creep): PatrolMemory {
  if (!creep.memory._patrol) {
    creep.memory._patrol = {};
  }
  return creep.memory._patrol as PatrolMemory;
}

function getCurrentPatrolTarget(patrol: PatrolMemory): string {
  const index = patrol.patrolIndex ?? 0;
  return POWER_BANK_PATROL_ROOMS[index % POWER_BANK_PATROL_ROOMS.length];
}

function advancePatrol(patrol: PatrolMemory): void {
  const current = patrol.patrolIndex ?? 0;
  patrol.patrolIndex = (current + 1) % POWER_BANK_PATROL_ROOMS.length;
}

function scanRoomForPowerBanks(creep: Creep): void {
  if (!isPowerBankPatrolRoom(creep.room.name)) {
    return;
  }

  const banks = creep.room.find(FIND_STRUCTURES).filter(
    (s): s is StructurePowerBank => s.structureType === STRUCTURE_POWER_BANK,
  );

  for (const bank of banks) {
    recordPowerBankDiscovery(bank);
  }
}

export const powerBankScoutRole: RoleFactory = () => ({
  source: (creep: Creep): boolean => {
    const patrol = ensurePatrolMemory(creep);
    const targetRoom = getCurrentPatrolTarget(patrol);

    scanRoomForPowerBanks(creep);

    if (creep.room.name === targetRoom) {
      advancePatrol(patrol);
      const nextTarget = getCurrentPatrolTarget(patrol);
      moveToTargetRoom(creep, nextTarget, undefined, { plainCost: 1, swampCost: 1, reusePath: 5 });
      return false;
    }

    moveToTargetRoom(creep, targetRoom, undefined, { plainCost: 1, swampCost: 1, reusePath: 5 });
    return false;
  },
  target: (): boolean => false,
});
