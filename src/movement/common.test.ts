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
});

describe("isExitTile", () => {

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

  it("returns null for BOTTOM_RIGHT from corner (49, 49)", () => {
    const origin = new MockRoomPosition(49, 49, "W1N1") as unknown as RoomPosition;
    expect(getPositionAtDirection(origin, BOTTOM_RIGHT)).toBeNull();
  });
});

describe("parseEncodedRouteRooms", () => {

  it("parses pipe-delimited room names", () => {
    expect(parseEncodedRouteRooms("W1N1|W1N2|W1N3")).toEqual(["W1N1", "W1N2", "W1N3"]);
  });
});

describe("isWalkableStructure", () => {

  it("returns false for hostile private rampart", () => {
    const s = { structureType: STRUCTURE_RAMPART, my: false, isPublic: false } as unknown as Structure<StructureConstant>;
    expect(isWalkableStructure(s)).toBe(false);
  });
});

describe("isWalkableConstructionSite", () => {

  it("returns false for extension site", () => {
    const site = { structureType: STRUCTURE_EXTENSION } as ConstructionSite;
    expect(isWalkableConstructionSite(site)).toBe(false);
  });
});
