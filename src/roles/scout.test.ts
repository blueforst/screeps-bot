jest.mock("@/roles/shared", () => ({
  getCurrentScoutRoute: jest.fn(() => undefined),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

import { scoutRole } from "@/roles/scout";

const {
  getCurrentScoutRoute,
  moveToTarget,
  moveToTargetRoom,
} = jest.requireMock("@/roles/shared") as {
  getCurrentScoutRoute: jest.Mock;
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

describe("scoutRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCurrentScoutRoute.mockReturnValue(undefined);
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
  });

  it("uses direct cross-room travel when no fixed route is available", () => {
    const creep = {
      room: { name: "W1N1" },
      memory: {},
      pos: {},
      suicide: jest.fn(),
    } as unknown as Creep;

    const result = scoutRole("W1N2").source?.(creep);

    expect(getCurrentScoutRoute).toHaveBeenCalledWith("W1N2", undefined);
    expect(moveToTarget).toHaveBeenCalledWith(creep, expect.objectContaining({ x: 25, y: 25, roomName: "W1N2" }), 3, {
      plainCost: 2,
      swampCost: 10,
      reusePath: 5,
      maxRooms: 32,
    });
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("keeps using fixed room routing when a scout route is available", () => {
    const creep = {
      room: { name: "W1N1" },
      memory: {},
      pos: {},
      suicide: jest.fn(),
    } as unknown as Creep;
    getCurrentScoutRoute.mockReturnValue("W1N1|W1N2");

    scoutRole("W1N2").source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N2", "W1N1|W1N2", {
      plainCost: 2,
      swampCost: 10,
      reusePath: 5,
    });
    expect(moveToTarget).not.toHaveBeenCalled();
  });
});
