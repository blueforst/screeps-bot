interface MoveToTargetOptions {
  squareSize?: 3 | 7;
}

function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  return target instanceof RoomPosition ? target : target.pos;
}

function getMoveRange(squareSize: 3 | 7): 1 | 3 {
  return squareSize === 7 ? 3 : 1;
}

function getWalkablePositions(roomName: string, targetPos: RoomPosition, range: number): RoomPosition[] {
  const terrain = Game.map.getRoomTerrain(roomName);
  const positions: RoomPosition[] = [];

  const minX = Math.max(0, targetPos.x - range);
  const maxX = Math.min(49, targetPos.x + range);
  const minY = Math.max(0, targetPos.y - range);
  const maxY = Math.min(49, targetPos.y + range);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
        positions.push(new RoomPosition(x, y, roomName));
      }
    }
  }

  return positions;
}

export function moveToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  options: MoveToTargetOptions = {},
): void {
  const targetPos = getTargetPos(target);
  const squareSize = options.squareSize ?? 3;
  const moveRange = getMoveRange(squareSize);

  if (creep.room.name !== targetPos.roomName) {
    creep.moveTo(targetPos, { range: moveRange, visualizePathStyle: { stroke: "#ffaa00" } });
    return;
  }

  const candidatePositions = getWalkablePositions(targetPos.roomName, targetPos, moveRange);
  const approachPos = creep.pos.findClosestByRange(candidatePositions);

  creep.moveTo(approachPos || targetPos, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
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
