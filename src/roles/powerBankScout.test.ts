jest.mock("@/roles/shared", () => ({
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/powerBankDiscovery", () => ({
  recordPowerBankDiscovery: jest.fn(),
}));

import { powerBankScoutRole } from "@/roles/powerBankScout";
import { POWER_BANK_PATROL_ROOMS } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";

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

function createMockCreep(roomName: string, memory: any = {}): Creep {
  return {
    room: {
      name: roomName,
      find: jest.fn((constant: number) => {
        if (constant === FIND_STRUCTURES) return [];
        return [];
      }),
    },
    memory: { ...memory },
    pos: new MockRoomPosition(25, 25, roomName) as unknown as RoomPosition,
  } as unknown as Creep;
}

describe("powerBankScoutRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
  });

  it("patrol room list is exactly E0N60 through E9N60", () => {
    expect(POWER_BANK_PATROL_ROOMS).toEqual([
      "E0N60", "E1N60", "E2N60", "E3N60", "E4N60",
      "E5N60", "E6N60", "E7N60", "E8N60", "E9N60",
    ]);
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

  it("advances patrol index when reaching target room", () => {
    const creep = createMockCreep("E0N60");

    powerBankScoutRole().source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      "E1N60",
      undefined,
      expect.objectContaining({ plainCost: 1, swampCost: 1 }),
    );

    expect((creep.memory as any)._patrol.patrolIndex).toBe(1);
  });

  it("loops back to E0N60 after visiting E9N60", () => {
    const creep = createMockCreep("E9N60", { _patrol: { patrolIndex: 9 } });

    powerBankScoutRole().source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      "E0N60",
      undefined,
      expect.anything(),
    );

    expect((creep.memory as any)._patrol.patrolIndex).toBe(0);
  });

  it("scans room for power banks and records discoveries", () => {
    const mockBank = { id: "pb-1", structureType: STRUCTURE_POWER_BANK, pos: { x: 25, y: 25, roomName: "E3N60" } };
    const creep = {
      room: {
        name: "E3N60",
        find: jest.fn((constant: number) => {
          if (constant === FIND_STRUCTURES) return [mockBank];
          return [];
        }),
      },
      memory: { _patrol: { patrolIndex: 3 } },
      pos: new MockRoomPosition(25, 25, "E3N60") as unknown as RoomPosition,
    } as unknown as Creep;

    powerBankScoutRole().source?.(creep);

    expect(recordPowerBankDiscovery).toHaveBeenCalledWith(mockBank);
  });

  it("never returns true (never suicides)", () => {
    const creep = createMockCreep("E0N60");

    const result = powerBankScoutRole().source?.(creep);

    expect(result).toBe(false);
  });

  it("target always returns false", () => {
    const result = powerBankScoutRole().target({} as Creep);
    expect(result).toBe(false);
  });

  it("continues toward current target when not yet arrived", () => {
    const creep = createMockCreep("E5N55", { _patrol: { patrolIndex: 2 } });

    powerBankScoutRole().source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      "E2N60",
      undefined,
      expect.objectContaining({ plainCost: 1, swampCost: 1 }),
    );

    expect((creep.memory as any)._patrol.patrolIndex).toBe(2);
  });
});
