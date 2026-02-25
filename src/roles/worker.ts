import type { RoleFactory } from "@/types/system";
import { getPreferredEnergyPickupTarget, isDroppedResourceTarget, moveToRemoteWorkTarget, moveToTarget } from "@/roles/shared";
import { assignWorkerTask, completeWorkerTaskIfDone, getWorkerTaskTarget, releaseWorkerTask } from "@/runtime/workerTaskPool";

export const workerRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const sourceTarget = getPreferredEnergyPickupTarget(creep);
    if (!sourceTarget) {
      return false;
    }

    if (isDroppedResourceTarget(sourceTarget)) {
      const pickupCode = creep.pickup(sourceTarget);
      if (pickupCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, sourceTarget);
      }
    } else {
      const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
      if (withdrawCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, sourceTarget);
      }
    }

    return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
  },
  target: (creep): boolean => {
    const task = assignWorkerTask(creep);
    if (!task) {
      return true;
    }

    const target = getWorkerTaskTarget(task);
    if (!target) {
      releaseWorkerTask(creep);
      return true;
    }

    if (task.type === "build") {
      const buildCode = creep.build(target as ConstructionSite);
      if (buildCode === ERR_NOT_IN_RANGE) {
        moveToRemoteWorkTarget(creep, target);
      }

      if (buildCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
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

      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    releaseWorkerTask(creep);
    return true;
  },
});
