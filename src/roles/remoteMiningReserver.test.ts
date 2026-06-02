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

  describe("source phase – travel", () => {
    it("travels to target room when not there yet", () => {
      const room = makeRoom("W1N1", null);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").source(creep);

      expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W5N5", undefined, { plainCost: 2, swampCost: 10 });
      expect(result).toBe(false);
    });

    it("passes encoded route to moveToTargetRoom", () => {
      const room = makeRoom("W2N5", null);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5", "W3N5|W4N5").source(creep);

      expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W5N5", "W3N5|W4N5", { plainCost: 2, swampCost: 10 });
      expect(result).toBe(false);
    });

    it("returns true when already in target room", () => {
      const controller = makeController();
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").source(creep);

      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
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

    it("reserves a self-reserved controller", () => {
      const controller = makeController({
        reservation: { username: "Player1", ticksToEnd: 3000 },
      });
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

    it("returns false when room has no controller", () => {
      const room = makeRoom("W5N5", null);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(result).toBe(false);
      expect(creep.reserveController).not.toHaveBeenCalled();
    });
  });

  describe("target phase – safety guards", () => {
    it("does nothing on a controller owned by me", () => {
      const controller = makeController({ my: true });
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(result).toBe(false);
      expect(creep.reserveController).not.toHaveBeenCalled();
      expect(creep.claimController).not.toHaveBeenCalled();
      expect(creep.attackController).not.toHaveBeenCalled();
    });

    it("does nothing on a controller owned by another player", () => {
      const controller = makeController({
        my: false,
        owner: { username: "Enemy" },
      });
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(result).toBe(false);
      expect(creep.reserveController).not.toHaveBeenCalled();
      expect(creep.claimController).not.toHaveBeenCalled();
      expect(creep.attackController).not.toHaveBeenCalled();
    });

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

    it("does nothing when another player has reserved and getMyUsername returns different name", () => {
      (getMyUsername as jest.Mock).mockReturnValueOnce("OtherPlayer");

      const controller = makeController({
        reservation: { username: "Player1", ticksToEnd: 3000 },
      });
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(result).toBe(false);
      expect(creep.reserveController).not.toHaveBeenCalled();
    });
  });
});
