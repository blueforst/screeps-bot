function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  return target instanceof RoomPosition ? target : target.pos;
}

export type EnergyPickupTarget = Resource | AnyStoreStructure;

export function isDroppedResourceTarget(target: EnergyPickupTarget): target is Resource {
  return (target as Resource).amount !== undefined;
}

export function moveToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range: 1 | 3 = 1,
): void {
  const targetPos = getTargetPos(target);
  creep.moveTo(targetPos, { range, visualizePathStyle: { stroke: "#ffaa00" } });
}

export function moveToRemoteWorkTarget(creep: Creep, target: RoomPosition | { pos: RoomPosition }): void {
  moveToTarget(creep, target, 3);
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
    filter: (structure) =>
      !excludeSet.has(structure.id) &&
      structure.structureType === STRUCTURE_TOWER &&
      (structure as StructureTower).store.getFreeCapacity(RESOURCE_ENERGY) > 0,
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
  if (isDroppedResourceTarget(target)) {
    return target.amount;
  }

  return target.store.getUsedCapacity(RESOURCE_ENERGY);
}

export function getPreferredEnergyPickupTarget(creep: Creep): EnergyPickupTarget | null {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_CONTAINER &&
      (structure as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }) as AnyStoreStructure[];

  const candidates: EnergyPickupTarget[] = [...dropped, ...containers];
  if (candidates.length === 0) {
    return null;
  }

  const configuredMin = Memory.energyPickup?.preferredMin;
  const preferredMin = typeof configuredMin === "number" && configuredMin > 0 ? configuredMin : 800;
  const threshold = Math.min(creep.store.getCapacity(RESOURCE_ENERGY) ?? 0, preferredMin);
  const richCandidates = candidates.filter((target) => getTargetEnergyAmount(target) >= threshold);
  const preferred = richCandidates.length > 0 ? richCandidates : candidates;

  return creep.pos.findClosestByRange(preferred);
}
