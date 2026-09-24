jest.mock("@/roles/shared", () => ({
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/powerBankDiscovery", () => ({
  recordPowerBankDiscovery: jest.fn(),
}));

import { powerBankScoutRole, getActiveTransitDangerRooms } from "@/roles/powerBankScout";

const { moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTargetRoom: jest.Mock;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

function createMockCreep(roomName: string, memory: any = {}, hits = 1000, hitsMax = 1000): Creep {
  return {
    room: {
      name: roomName,
      find: jest.fn((constant: number) => {
        if (constant === FIND_STRUCTURES) return [];
        if (constant === FIND_HOSTILE_CREEPS) return [];
        if (constant === FIND_HOSTILE_POWER_CREEPS) return [];
        return [];
      }),
      controller: undefined,
    },
    memory: { ...memory },
    pos: new MockRoomPosition(25, 25, roomName) as unknown as RoomPosition,
    hits,
    hitsMax,
  } as unknown as Creep;
}

describe("powerBankScoutRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
  });

  it("moves to the first dynamically assigned gap room", () => {
    const creep = createMockCreep("E5N55");

    powerBankScoutRole("E10N60|E11N60").source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      "E10N60",
      undefined,
      expect.objectContaining({ plainCost: 1, swampCost: 1 }),
    );
  });

  it("reuses the main-loop room scan instead of rescanning the same visible room", () => {
    const creep = createMockCreep("E5N55");
    Memory.runtime = { powerBankObserver: { lastVisibleAt: { E5N55: Game.time } } } as any;

    powerBankScoutRole("E10N60").source?.(creep);

    expect(creep.room.find).not.toHaveBeenCalledWith(FIND_STRUCTURES);
  });

  describe("getActiveTransitDangerRooms", () => {

    it("retains permanent danger and keeps expired warnings as unknown-risk evidence", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = { E2N54: Game.time - 1 };
      (Memory.runtime as any).powerBankPermanentDangerRooms = { E3N57: true };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toEqual(["E3N57"]);
      expect(Memory.runtime!.transitDangerRooms!["E2N54"]).toBe(Game.time - 1);
      expect((Memory.runtime as any).powerBankPermanentDangerRooms?.E3N57).toBe(true);
    });
  });
});
