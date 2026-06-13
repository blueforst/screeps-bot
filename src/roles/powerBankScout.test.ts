jest.mock("@/roles/shared", () => ({
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/powerBankDiscovery", () => ({
  recordPowerBankDiscovery: jest.fn(),
}));

import { powerBankScoutRole, getActiveTransitDangerRooms } from "@/roles/powerBankScout";
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
        controller: undefined,
      },
      memory: { _patrol: { patrolIndex: 3 } },
      pos: new MockRoomPosition(25, 25, "E3N60") as unknown as RoomPosition,
      hits: 1000,
      hitsMax: 1000,
    } as unknown as Creep;

    powerBankScoutRole().source?.(creep);

    expect(recordPowerBankDiscovery).toHaveBeenCalledWith(mockBank);
  });

  it("does not record power banks while passing through non-patrol rooms", () => {
    const mockBank = { id: "pb-outside", structureType: STRUCTURE_POWER_BANK, pos: { x: 25, y: 25, roomName: "W0N55" } };
    const creep = {
      room: {
        name: "W0N55",
        find: jest.fn((constant: number) => {
          if (constant === FIND_STRUCTURES) return [mockBank];
          return [];
        }),
        controller: undefined,
      },
      memory: { _patrol: { patrolIndex: 3 } },
      pos: new MockRoomPosition(25, 25, "W0N55") as unknown as RoomPosition,
      hits: 1000,
      hitsMax: 1000,
    } as unknown as Creep;

    powerBankScoutRole().source?.(creep);

    expect(recordPowerBankDiscovery).not.toHaveBeenCalled();
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

  describe("transit danger room detection", () => {
    it("marks transit room as dangerous when creep takes damage", () => {
      const creep = createMockCreep("E2N54", { _patrol: { patrolIndex: 0 }, _lastHits: 1000 }, 800);
      (creep.room as any).controller = undefined;

      powerBankScoutRole().source?.(creep);

      expect(Memory.runtime?.transitDangerRooms?.["E2N54"]).toBeDefined();
      expect(Memory.runtime!.transitDangerRooms!["E2N54"]).toBeGreaterThan(Game.time);
    });

    it("marks transit room as dangerous when hostile combat creeps are present", () => {
      const hostileCreep = {
        owner: { username: "enemy" },
        getActiveBodyparts: jest.fn((part: string) => part === ATTACK ? 5 : 0),
      };
      const creep = createMockCreep("E2N54", { _patrol: { patrolIndex: 0 } }, 1000);
      (creep.room as any).find = jest.fn((constant: number) => {
        if (constant === FIND_HOSTILE_CREEPS) return [hostileCreep];
        if (constant === FIND_HOSTILE_POWER_CREEPS) return [];
        if (constant === FIND_STRUCTURES) return [];
        return [];
      });
      (creep.room as any).controller = undefined;

      powerBankScoutRole().source?.(creep);

      expect(Memory.runtime?.transitDangerRooms?.["E2N54"]).toBeDefined();
    });

    it("does not mark patrol target rooms as dangerous even if damaged", () => {
      const creep = createMockCreep("E0N60", { _patrol: { patrolIndex: 0 }, _lastHits: 1000 }, 800);
      (creep.room as any).controller = undefined;

      powerBankScoutRole().source?.(creep);

      expect(Memory.runtime?.transitDangerRooms?.["E0N60"]).toBeUndefined();
    });

    it("passes active transit danger rooms as avoidRooms to moveToTargetRoom", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = { E2N54: Game.time + 500 };

      const creep = createMockCreep("E5N55", { _patrol: { patrolIndex: 2 } });

      powerBankScoutRole().source?.(creep);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        creep,
        "E2N60",
        undefined,
        expect.objectContaining({ avoidRooms: ["E2N54"] }),
      );
    });

    it("updates _lastHits every tick", () => {
      const creep = createMockCreep("E5N55", { _patrol: { patrolIndex: 0 } }, 950);

      powerBankScoutRole().source?.(creep);

      expect(creep.memory._lastHits).toBe(950);
    });
  });

  describe("getActiveTransitDangerRooms", () => {
    it("returns rooms with unexpired TTL", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = {
        E2N54: Game.time + 100,
        E3N54: Game.time + 200,
      };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toContain("E2N54");
      expect(rooms).toContain("E3N54");
    });

    it("excludes expired rooms and cleans them up", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = {
        E2N54: Game.time - 1,
        E3N54: Game.time + 200,
      };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).not.toContain("E2N54");
      expect(rooms).toContain("E3N54");
      expect(Memory.runtime!.transitDangerRooms!["E2N54"]).toBeUndefined();
    });

    it("returns empty array when no transit danger rooms exist", () => {
      Memory.runtime = Memory.runtime || {} as any;
      delete Memory.runtime.transitDangerRooms;

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toEqual([]);
    });

    it("excludes and cleans patrol rooms even if present in transitDangerRooms", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = {
        E0N60: Game.time + 500,
        E5N60: Game.time + 500,
        E2N54: Game.time + 200,
      };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toEqual(["E2N54"]);
      expect(Memory.runtime!.transitDangerRooms!["E0N60"]).toBeUndefined();
      expect(Memory.runtime!.transitDangerRooms!["E5N60"]).toBeUndefined();
    });
  });
});
