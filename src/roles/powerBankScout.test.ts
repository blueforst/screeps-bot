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

  it("moves to first patrol room when no memory", () => {
    const creep = createMockCreep("E5N55");

    powerBankScoutRole().source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      "E0N60",
      undefined,
      expect.objectContaining({ plainCost: 1, swampCost: 1 }),
    );
  });

  describe("getActiveTransitDangerRooms", () => {

    it("retains permanent danger while cleaning expired temporary danger", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = { E2N54: Game.time - 1 };
      (Memory.runtime as any).powerBankPermanentDangerRooms = { E3N57: true };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toEqual(["E3N57"]);
      expect(Memory.runtime!.transitDangerRooms!["E2N54"]).toBeUndefined();
      expect((Memory.runtime as any).powerBankPermanentDangerRooms?.E3N57).toBe(true);
    });
  });
});
