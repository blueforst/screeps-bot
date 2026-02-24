function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  return target instanceof RoomPosition ? target : target.pos;
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

export function getEnergyStoreTarget(creep: Creep): AnyStoreStructure | null {
  const priority = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) {
        return (structure as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
      if (structure.structureType === STRUCTURE_TOWER) {
        return (structure as StructureTower).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
      return false;
    },
  });

  if (priority.length > 0) {
    return priority[0] as AnyStoreStructure;
  }

  if (creep.room.storage) {
    return creep.room.storage;
  }

  return null;
}

export function getDroppedEnergyTarget(creep: Creep): Resource | null {
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
  });

  if (dropped.length === 0) {
    return null;
  }

  return creep.pos.findClosestByRange(dropped);
}

export function getWithdrawEnergyTarget(creep: Creep): AnyStoreStructure | null {
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_CONTAINER &&
      (structure as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  if (containers.length > 0) {
    return creep.pos.findClosestByRange(containers) as AnyStoreStructure;
  }

  return null;
}
