export function moveToTarget(creep: Creep, target: RoomPosition | { pos: RoomPosition }): void {
  creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
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

export function getEnergySourceTarget(creep: Creep): AnyStoreStructure | Source | null {
  if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    return creep.room.storage;
  }

  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (structure) =>
      (structure.structureType === STRUCTURE_CONTAINER || structure.structureType === STRUCTURE_LINK) &&
      (structure as StructureContainer | StructureLink).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  if (containers.length > 0) {
    return containers[0] as AnyStoreStructure;
  }

  const sources = creep.room.find(FIND_SOURCES_ACTIVE);
  if (sources.length > 0) {
    return creep.pos.findClosestByRange(sources);
  }

  return null;
}
