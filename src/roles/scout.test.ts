jest.mock("@/roles/shared", () => ({
  getCurrentScoutRoute: jest.fn(() => undefined),
  moveToTargetRoom: jest.fn(() => OK),
}));

import { scoutRole } from "@/roles/scout";

const {
  getCurrentScoutRoute,
  moveToTargetRoom,
} = jest.requireMock("@/roles/shared") as {
  getCurrentScoutRoute: jest.Mock;
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

  it("uses shared room travel even when no fixed route is available", () => {
    const creep = {
      room: { name: "W1N1" },
      memory: {},
      pos: {},
      suicide: jest.fn(),
    } as unknown as Creep;

    const result = scoutRole("W1N2").source?.(creep);

    expect(getCurrentScoutRoute).toHaveBeenCalledWith("W1N2", undefined);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N2", undefined, {
      plainCost: 2,
      swampCost: 10,
      reusePath: 5,
      travelRange: 3,
    });
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
      travelRange: 3,
    });
  });

  it("does not suicide yet when it reaches the target room on an edge tile", () => {
    const creep = {
      room: { name: "W1N2" },
      memory: {},
      pos: { x: 0, y: 25, roomName: "W1N2" },
      suicide: jest.fn(),
    } as unknown as Creep;
    getCurrentScoutRoute.mockReturnValue("W1N1|W1N2");

    const result = scoutRole("W1N2").source?.(creep);

    expect(creep.suicide).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N2", "W1N1|W1N2", {
      plainCost: 2,
      swampCost: 10,
      reusePath: 5,
      travelRange: 3,
    });
    expect(result).toBe(false);
  });
});
