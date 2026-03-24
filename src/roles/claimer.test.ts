jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
  getCurrentColonizationRoute: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

import { claimerRole } from "@/roles/claimer";
import { getCurrentColonizationRoute, moveToTarget, moveToTargetRoom } from "@/roles/shared";

function createRoom(): Room {
  return {
    name: "W9N9",
    controller: {
      my: false,
      reservation: {
        username: "Invader",
      },
    } as StructureController,
  } as Room;
}

function createCreep(room: Room): Creep {
  return {
    room,
    claimController: jest.fn(),
    attackController: jest.fn(),
  } as unknown as Creep;
}

describe("claimerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("attacks a hostile reservation when claimController returns invalid target", () => {
    const room = createRoom();
    const creep = createCreep(room);
    creep.claimController = jest.fn(() => ERR_INVALID_TARGET);
    creep.attackController = jest.fn(() => ERR_NOT_IN_RANGE);

    const role = claimerRole(room.name);
    role.target(creep);

    expect(creep.claimController).toHaveBeenCalledWith(room.controller);
    expect(creep.attackController).toHaveBeenCalledWith(room.controller);
    expect(moveToTarget).toHaveBeenCalledWith(creep, room.controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
  });

  it("uses single-room controller pathing when claim is out of range", () => {
    const room = createRoom();
    const creep = createCreep(room);
    creep.claimController = jest.fn(() => ERR_NOT_IN_RANGE);

    const role = claimerRole(room.name);
    role.target(creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, room.controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
  });

  it("uses colonization route travel while outside the target room", () => {
    const room = { name: "W8N9" } as Room;
    const creep = createCreep(room);
    (getCurrentColonizationRoute as jest.Mock).mockReturnValue("W8N9|W9N9");

    const role = claimerRole("W9N9", "W8N9|W9N9");
    const result = role.source(creep);

    expect(result).toBe(false);
    expect(getCurrentColonizationRoute).toHaveBeenCalledWith("W9N9", "W8N9|W9N9");
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W9N9", "W8N9|W9N9", { plainCost: 2, swampCost: 10 });
  });
});
