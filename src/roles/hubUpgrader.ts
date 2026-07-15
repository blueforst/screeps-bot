import { prepareCombatBoost } from "@/roles/combatBoosts";
import { moveToTarget } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

type ControllerEnergySource = StructureLink | StructureContainer;

function getActiveController(roomName: string | undefined): StructureController | null {
  if (!roomName) return null;
  const hub = Memory.cfg?.hub;
  if (!hub?.enabled || hub.hubRoomName !== roomName) return null;
  const controller = Game.rooms[roomName]?.controller;
  if (!controller?.my || controller.level !== 7) return null;
  return controller;
}

function findControllerEnergySource(creep: Creep, controller: StructureController): ControllerEnergySource | null {
  const candidates = measureCreepDecision(() => controller.room.find(FIND_STRUCTURES, {
    filter: (structure): structure is ControllerEnergySource =>
      (structure.structureType === STRUCTURE_LINK || structure.structureType === STRUCTURE_CONTAINER) &&
      structure.pos.getRangeTo(controller.pos) <= 3 &&
      structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }));

  candidates.sort((left, right) => {
    if (left.structureType !== right.structureType) {
      return left.structureType === STRUCTURE_LINK ? -1 : 1;
    }
    return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
  });
  return candidates[0] || null;
}

export const hubUpgraderRole: RoleFactory = (
  roomName?: string,
  boostTaskId?: string,
) => ({
  prepare: (creep): boolean => getActiveController(roomName)
    ? prepareCombatBoost(
      creep,
      boostTaskId,
      RESOURCE_CATALYZED_GHODIUM_ACID,
    )
    : true,

  source: (creep): boolean => {
    const controller = getActiveController(roomName);
    if (!controller) return false;
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return true;

    const source = findControllerEnergySource(creep, controller);
    if (!source) {
      moveToTarget(creep, controller, 3);
      return false;
    }

    const code = measureCreepIntent(() => creep.withdraw(source, RESOURCE_ENERGY));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source, 1);
    }
    return false;
  },

  target: (creep): boolean => {
    const controller = getActiveController(roomName);
    if (!controller) return false;
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return true;

    const code = measureCreepIntent(() => creep.upgradeController(controller));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller, 3);
    }
    return false;
  },
});
