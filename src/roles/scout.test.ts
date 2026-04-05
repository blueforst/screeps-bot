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

describe("scoutRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCurrentScoutRoute.mockReturnValue(undefined);
  });

  it("still uses dynamic room travel when no fixed route is available", () => {
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
    });
    expect(result).toBe(false);
  });
});
