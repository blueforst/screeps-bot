import {
  getTargetPos,
  parseEncodedRouteRooms,
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

describe("parseEncodedRouteRooms", () => {

  it("parses pipe-delimited room names", () => {
    expect(parseEncodedRouteRooms("W1N1|W1N2|W1N3")).toEqual(["W1N1", "W1N2", "W1N3"]);
  });
});
