import {
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} from "@/runtime/energyPickupReservation";
import { isReceiverLink } from "@/runtime/linkControl";

function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  return target instanceof RoomPosition ? target : target.pos;
}

interface MoveToTargetOptions {
  swampCost?: number;
  plainCost?: number;
}

export type EnergyPickupTarget = Resource | AnyStoreStructure | Tombstone;

export function isDroppedResourceTarget(target: EnergyPickupTarget): target is Resource {
  return (target as Resource).amount !== undefined;
}

export function moveToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range: 1 | 3 = 1,
  options: MoveToTargetOptions = {},
): ScreepsReturnCode {
  const targetPos = getTargetPos(target);
  return creep.moveTo(targetPos, {
    range,
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    visualizePathStyle: { stroke: "#ffaa00" },
  });
}

export function moveToRemoteWorkTarget(creep: Creep, target: RoomPosition | { pos: RoomPosition }): ScreepsReturnCode {
  const targetPos = getTargetPos(target);
  if (creep.pos.getRangeTo(targetPos) <= 3) {
    return OK;
  }

  const path = creep.pos.findPathTo(targetPos, {
    range: 3,
    ignoreCreeps: false,
    swampCost: 8,
  });

  if (path.length === 0) {
    return ERR_NO_PATH;
  }

  return creep.moveByPath(path);
}

interface EnergyStoreTargetOptions {
  excludeIds?: string[];
}

export function getEnergyStoreTarget(creep: Creep, options: EnergyStoreTargetOptions = {}): AnyStoreStructure | null {
  const excludeSet = new Set(options.excludeIds || []);

  const spawnAndExtensionTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id)) {
        return false;
      }

      if (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) {
        return (structure as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
      return false;
    },
  });

  if (spawnAndExtensionTargets.length > 0) {
    return creep.pos.findClosestByRange(spawnAndExtensionTargets) as AnyStoreStructure;
  }

  const towerTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (excludeSet.has(structure.id) || structure.structureType !== STRUCTURE_TOWER) {
        return false;
      }

      const tower = structure as StructureTower;
      const used = tower.store.getUsedCapacity(RESOURCE_ENERGY);
      const capacity = tower.store.getCapacity(RESOURCE_ENERGY);
      return capacity > 0 && tower.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && used <= capacity * 0.6;
    },
  });

  if (towerTargets.length > 0) {
    return creep.pos.findClosestByRange(towerTargets) as AnyStoreStructure;
  }

  if (creep.room.storage && !excludeSet.has(creep.room.storage.id)) {
    return creep.room.storage;
  }

  return null;
}

function getTargetEnergyAmount(target: EnergyPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function getPreferredEnergyPickupCandidates(creep: Creep): EnergyPickupTarget[] {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const structureCandidates = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      (structure.structureType === STRUCTURE_CONTAINER ||
        structure.structureType === STRUCTURE_STORAGE ||
        (structure.structureType === STRUCTURE_LINK && isReceiverLink(structure as StructureLink))) &&
      (structure as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as AnyStoreStructure[];
  const tombstones = creep.room.find(FIND_TOMBSTONES, {
    filter: (tombstone) => tombstone.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const candidates: EnergyPickupTarget[] = [...dropped, ...structureCandidates, ...tombstones];
  if (candidates.length === 0) {
    return [];
  }

  const threshold = creep.store.getCapacity(RESOURCE_ENERGY) ?? 0;
  const richCandidates = candidates.filter((target) => getTargetEnergyAmount(target) >= threshold);
  const preferred = richCandidates.length > 0 ? richCandidates : candidates;

  return preferred.sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos));
}

export function getPreferredEnergyPickupTarget(creep: Creep): EnergyPickupTarget | null {
  const candidates = getPreferredEnergyPickupCandidates(creep);
  return candidates.length > 0 ? candidates[0] : null;
}

interface PickupResult {
  picked: boolean;
  outOfRange: boolean;
}

export function pickupEnergyFromPreferredTarget(creep: Creep, moveOptions: MoveToTargetOptions = {}): PickupResult {
  const desiredAmount = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

  let sourceTarget = getReservedPickupTarget(creep) as EnergyPickupTarget | null;
  if (sourceTarget && !reservePickupTarget(creep, sourceTarget, desiredAmount)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (!sourceTarget) {
    const candidates = getPreferredEnergyPickupCandidates(creep);
    for (const candidate of candidates) {
      if (reservePickupTarget(creep, candidate, desiredAmount)) {
        sourceTarget = candidate;
        break;
      }
    }
  }

  if (!sourceTarget) {
    return { picked: false, outOfRange: false };
  }

  if (isDroppedResourceTarget(sourceTarget)) {
    const pickupCode = creep.pickup(sourceTarget);
    if (pickupCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget, 1, moveOptions);
      return { picked: false, outOfRange: true };
    }

    if (pickupCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    if (pickupCode === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      releasePickupReservation(creep, sourceTarget.id);
    }

    return { picked: pickupCode === OK, outOfRange: false };
  }

  const withdrawCode = creep.withdraw(sourceTarget, RESOURCE_ENERGY);
  if (withdrawCode === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, sourceTarget, 1, moveOptions);
    return { picked: false, outOfRange: true };
  }

  if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
    releasePickupReservation(creep, sourceTarget.id);
    return { picked: false, outOfRange: false };
  }

  if (withdrawCode === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    releasePickupReservation(creep, sourceTarget.id);
  }

  return { picked: withdrawCode === OK, outOfRange: false };
}
