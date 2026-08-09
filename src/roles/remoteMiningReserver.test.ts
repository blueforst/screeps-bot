jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

jest.mock("@/runtime/remoteMining", () => ({
  getMyUsername: jest.fn(() => "Player1"),
}));

import { remoteMiningReserverRole } from "@/roles/remoteMiningReserver";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { getMyUsername } from "@/runtime/remoteMining";

function makeController(overrides: Partial<StructureController> = {}): StructureController {
  return {
    my: false,
    owner: undefined,
    reservation: undefined,
    ...overrides,
  } as unknown as StructureController;
}

function makeCreep(room: Room, extras: Partial<Creep> = {}): Creep {
  return {
    room,
    reserveController: jest.fn(() => OK),
    claimController: jest.fn(),
    attackController: jest.fn(),
    ...extras,
  } as unknown as Creep;
}

function makeRoom(name: string, controller: StructureController | null): Room {
  return {
    name,
    controller,
  } as unknown as Room;
}

describe("remoteMiningReserverRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("target phase – reservation", () => {
    it("reserves an unreserved neutral controller", () => {
      const controller = makeController();
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(creep.reserveController).toHaveBeenCalledWith(controller);
      expect(result).toBe(false);
    });

    it("moves toward controller when not in range", () => {
      const controller = makeController();
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room, {
        reserveController: jest.fn(() => ERR_NOT_IN_RANGE),
      });

      remoteMiningReserverRole("W5N5").target(creep);

      expect(creep.reserveController).toHaveBeenCalledWith(controller);
      expect(moveToTarget).toHaveBeenCalledWith(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
    });
  });

  describe("target phase – safety guards", () => {

    it("does nothing on a hostile-reserved controller", () => {
      const controller = makeController({
        reservation: { username: "Invader", ticksToEnd: 4000 },
      });
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(result).toBe(false);
      expect(creep.reserveController).not.toHaveBeenCalled();
      expect(creep.claimController).not.toHaveBeenCalled();
      expect(creep.attackController).not.toHaveBeenCalled();
    });
  });
});
