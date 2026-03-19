jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
  getCurrentColonizationRoute: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

import { claimerRole } from "@/roles/claimer";
import { moveToTarget } from "@/roles/shared";

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
    expect(moveToTarget).toHaveBeenCalledWith(creep, room.controller);
  });
});
