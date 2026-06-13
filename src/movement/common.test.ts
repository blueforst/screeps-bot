import {
  getTargetPos,
  getPosKey,
  isExitTile,
  getPositionAtDirection,
  parseEncodedRouteRooms,
  isWalkableStructure,
  isWalkableConstructionSite,
} from "@/movement/common";
import { MockRoomPosition, setupRoomPositionGlobal } from "@mock/movement";

describe("getTargetPos", () => {
  beforeEach(() => {
    setupRoomPositionGlobal();
  });

  it("returns the position directly when target is a RoomPosition", () => {
    const pos = new MockRoomPosition(10, 20, "W1N1") as unknown as RoomPosition;
    expect(getTargetPos(pos)).toBe(pos);
  });

  it("extracts pos from an object with a pos property", () => {
    const pos = new MockRoomPosition(5, 15, "W2N3") as unknown as RoomPosition;
    const target = { pos } as unknown as { pos: RoomPosition };
    expect(getTargetPos(target)).toBe(pos);
  });
});

describe("getPosKey", () => {
  it("produces roomName:x:y format", () => {
    const pos = new MockRoomPosition(10, 20, "W1N1") as unknown as RoomPosition;
    expect(getPosKey(pos)).toBe("W1N1:10:20");
  });

  it("handles edge coordinates", () => {
    const pos = new MockRoomPosition(0, 49, "E5N5") as unknown as RoomPosition;
    expect(getPosKey(pos)).toBe("E5N5:0:49");
  });
});

describe("isExitTile", () => {
  it("returns true for x = 0", () => {
    const pos = new MockRoomPosition(0, 25, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(true);
  });

  it("returns true for x = 49", () => {
    const pos = new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(true);
  });

  it("returns true for y = 0", () => {
    const pos = new MockRoomPosition(25, 0, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(true);
  });

  it("returns true for y = 49", () => {
    const pos = new MockRoomPosition(25, 49, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(true);
  });

  it("returns true for corner (0, 0)", () => {
    const pos = new MockRoomPosition(0, 0, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(true);
  });

  it("returns true for corner (49, 49)", () => {
    const pos = new MockRoomPosition(49, 49, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(true);
  });

  it("returns false for interior positions", () => {
    const pos = new MockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(false);
  });

  it("returns false for position one tile away from edge", () => {
    const pos = new MockRoomPosition(1, 48, "W1N1") as unknown as RoomPosition;
    expect(isExitTile(pos)).toBe(false);
  });
});

describe("getPositionAtDirection", () => {
  beforeEach(() => {
    setupRoomPositionGlobal();
  });

  const cases: Array<[string, DirectionConstant, number, number]> = [
    ["TOP", TOP, 0, -1],
    ["TOP_RIGHT", TOP_RIGHT, 1, -1],
    ["RIGHT", RIGHT, 1, 0],
    ["BOTTOM_RIGHT", BOTTOM_RIGHT, 1, 1],
    ["BOTTOM", BOTTOM, 0, 1],
    ["BOTTOM_LEFT", BOTTOM_LEFT, -1, 1],
    ["LEFT", LEFT, -1, 0],
    ["TOP_LEFT", TOP_LEFT, -1, -1],
  ];

  test.each(cases)("direction %s applies offset (%d, %d)", (_name, dir, dx, dy) => {
    const origin = new MockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition;
    const result = getPositionAtDirection(origin, dir);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(25 + dx);
    expect(result!.y).toBe(25 + dy);
    expect(result!.roomName).toBe("W1N1");
  });

  it("returns null when moving TOP from y=0", () => {
    const origin = new MockRoomPosition(25, 0, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, TOP)).toBeNull();
  });

  it("returns null when moving LEFT from x=0", () => {
    const origin = new MockRoomPosition(0, 25, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, LEFT)).toBeNull();
  });

  it("returns null when moving BOTTOM from y=49", () => {
    const origin = new MockRoomPosition(25, 49, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, BOTTOM)).toBeNull();
  });

  it("returns null when moving RIGHT from x=49", () => {
    const origin = new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, RIGHT)).toBeNull();
  });

  it("returns null for TOP_LEFT from corner (0, 0)", () => {
    const origin = new MockRoomPosition(0, 0, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, TOP_LEFT)).toBeNull();
  });

  it("returns null for BOTTOM_RIGHT from corner (49, 49)", () => {
    const origin = new MockRoomPosition(49, 49, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, BOTTOM_RIGHT)).toBeNull();
  });

  it("returns a valid position at the boundary edge", () => {
    const origin = new MockRoomPosition(48, 48, "W1N1") as unknown as RoomPosition;
    const result = getPositionAtDirection(origin, BOTTOM_RIGHT);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(49);
    expect(result!.y).toBe(49);
  });
});

describe("parseEncodedRouteRooms", () => {
  it("returns empty array for undefined input", () => {
    expect(parseEncodedRouteRooms(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseEncodedRouteRooms("")).toEqual([]);
  });

  it("parses a single room name", () => {
    expect(parseEncodedRouteRooms("W1N1")).toEqual(["W1N1"]);
  });

  it("parses pipe-delimited room names", () => {
    expect(parseEncodedRouteRooms("W1N1|W1N2|W1N3")).toEqual(["W1N1", "W1N2", "W1N3"]);
  });

  it("trims whitespace around room names", () => {
    expect(parseEncodedRouteRooms(" W1N1 | W1N2 ")).toEqual(["W1N1", "W1N2"]);
  });

  it("filters out empty segments from trailing/leading pipes", () => {
    expect(parseEncodedRouteRooms("|W1N1||W1N2|")).toEqual(["W1N1", "W1N2"]);
  });
});

describe("isWalkableStructure", () => {
  it("returns true for road", () => {
    const s = { structureType: STRUCTURE_ROAD } as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(true);
  });

  it("returns true for container", () => {
    const s = { structureType: STRUCTURE_CONTAINER } as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(true);
  });

  it("returns true for portal", () => {
    const s = { structureType: STRUCTURE_PORTAL } as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(true);
  });

  it("returns true for own rampart", () => {
    const s = { structureType: STRUCTURE_RAMPART, my: true } as unknown as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(true);
  });

  it("returns true for public rampart", () => {
    const s = { structureType: STRUCTURE_RAMPART, my: false, isPublic: true } as unknown as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(true);
  });

  it("returns false for hostile private rampart", () => {
    const s = { structureType: STRUCTURE_RAMPART, my: false, isPublic: false } as unknown as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(false);
  });

  it("returns false for wall", () => {
    const s = { structureType: STRUCTURE_WALL } as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(false);
  });

  it("returns false for spawn", () => {
    const s = { structureType: STRUCTURE_SPAWN } as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(false);
  });

  it("returns false for extension", () => {
    const s = { structureType: STRUCTURE_EXTENSION } as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(false);
  });
});

describe("isWalkableConstructionSite", () => {
  it("returns true for road site", () => {
    const site = { structureType: STRUCTURE_ROAD } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(true);
  });

  it("returns true for container site", () => {
    const site = { structureType: STRUCTURE_CONTAINER } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(true);
  });

  it("returns true for rampart site", () => {
    const site = { structureType: STRUCTURE_RAMPART } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(true);
  });

  it("returns false for extension site", () => {
    const site = { structureType: STRUCTURE_EXTENSION } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(false);
  });

  it("returns false for spawn site", () => {
    const site = { structureType: STRUCTURE_SPAWN } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(false);
  });

  it("returns false for tower site", () => {
    const site = { structureType: STRUCTURE_TOWER } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(false);
  });
});
