export function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  return target instanceof RoomPosition ? target : target.pos;
}

export function getPosKey(pos: RoomPosition): string {
  return `${pos.roomName}:${pos.x}:${pos.y}`;
}

export function isExitTile(pos: RoomPosition): boolean {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

export function getPositionAtDirection(pos: RoomPosition, direction: DirectionConstant): RoomPosition | null {
  const offsets = {
    [TOP]: { x: 0, y: -1 },
    [TOP_RIGHT]: { x: 1, y: -1 },
    [RIGHT]: { x: 1, y: 0 },
    [BOTTOM_RIGHT]: { x: 1, y: 1 },
    [BOTTOM]: { x: 0, y: 1 },
    [BOTTOM_LEFT]: { x: -1, y: 1 },
    [LEFT]: { x: -1, y: 0 },
    [TOP_LEFT]: { x: -1, y: -1 },
  };

  const offset = offsets[direction];
  const x = pos.x + offset.x;
  const y = pos.y + offset.y;
  if (x < 0 || x > 49 || y < 0 || y > 49) {
    return null;
  }

  return new RoomPosition(x, y, pos.roomName);
}

export function parseEncodedRouteRooms(encodedRouteRooms?: string): string[] {
  if (!encodedRouteRooms) {
    return [];
  }

  return encodedRouteRooms
    .split("|")
    .map((roomName) => roomName.trim())
    .filter((roomName) => roomName.length > 0);
}

export function isWalkableStructure(structure: Structure<StructureConstant>): boolean {
  switch (structure.structureType) {
    case STRUCTURE_ROAD:
    case STRUCTURE_CONTAINER:
    case STRUCTURE_PORTAL:
      return true;
    case STRUCTURE_RAMPART: {
      const rampart = structure as StructureRampart;
      return rampart.my || rampart.isPublic;
    }
    default:
      return false;
  }
}

export function isWalkableConstructionSite(site: ConstructionSite): boolean {
  return (
    site.structureType === STRUCTURE_ROAD ||
    site.structureType === STRUCTURE_CONTAINER ||
    site.structureType === STRUCTURE_RAMPART
  );
}
