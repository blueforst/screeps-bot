import type { RoleFactory } from "@/types/system";
import { moveToRemoteWorkTarget, pickupEnergyFromPreferredTarget } from "@/roles/shared";
import { assignWorkerTask, completeWorkerTaskIfDone, getWorkerTaskTarget, releaseWorkerTask } from "@/runtime/workerTaskPool";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";

export const workerRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const result = pickupEnergyFromPreferredTarget(creep);
    const shouldSwitchToTarget = result.picked || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
    if (shouldSwitchToTarget) {
      releasePickupReservation(creep);
    }

    if (!result.picked && !result.outOfRange) {
      return shouldSwitchToTarget;
    }

    return shouldSwitchToTarget;
  },
  target: (creep): boolean => {
    const task = assignWorkerTask(creep);
    if (!task) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const target = getWorkerTaskTarget(task);
    if (!target) {
      releaseWorkerTask(creep);
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    if (task.type === "build") {
      const buildCode = creep.build(target as ConstructionSite);
      if (buildCode === ERR_NOT_IN_RANGE) {
        moveToRemoteWorkTarget(creep, target);
      }

      if (buildCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      const shouldSwitchToSource = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      if (shouldSwitchToSource) {
        releaseWorkerTask(creep);
      }

      return shouldSwitchToSource;
    }

    if (task.type === "upgrade") {
      const upgradeCode = creep.upgradeController(target as StructureController);
      if (upgradeCode === ERR_NOT_IN_RANGE) {
        moveToRemoteWorkTarget(creep, target);
        return false;
      }

      if (upgradeCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      const shouldSwitchToSource = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      if (shouldSwitchToSource) {
        releaseWorkerTask(creep);
      }

      return shouldSwitchToSource;
    }

    if (task.type === "repair") {
      const repairCode = creep.repair(target as StructureRampart);
      if (repairCode === ERR_NOT_IN_RANGE) {
        const moveCode = moveToRemoteWorkTarget(creep, target);
        if (moveCode === ERR_NO_PATH) {
          releaseWorkerTask(creep);
        }
        return false;
      }

      if (repairCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      const shouldSwitchToSource = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      if (shouldSwitchToSource) {
        releaseWorkerTask(creep);
      }

      return shouldSwitchToSource;
    }

    releaseWorkerTask(creep);
    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
