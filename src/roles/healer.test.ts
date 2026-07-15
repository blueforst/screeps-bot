jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/movement/traffic", () => ({
  moveOffExit: jest.fn(() => OK),
}));

import { healerRole } from "@/roles/healer";
import { createMockPowerBankCreep } from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};
const { moveOffExit } = jest.requireMock("@/movement/traffic") as {
  moveOffExit: jest.Mock;
};

const TARGET_ROOM = "E3N57";
const ATTACKER_CONFIG = "E1N57:war:E3N57:meleeAttacker:0";
const HEALER_CONFIG = "E1N57:war:E3N57:healer:0";

function hostileCreep(name: string, hits = 1000): Creep {
  return {
    id: name as Id<Creep>,
    name,
    owner: { username: "TooAngel" },
    hits,
    pos: { x: 23, y: 20, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
  } as unknown as Creep;
}

function hostileStructure(type: StructureConstant, id: string, x: number, y: number, hits = 3000): Structure {
  return {
    id: id as Id<Structure>,
    structureType: type,
    hits,
    hitsMax: hits,
    pos: { x, y, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
  } as Structure;
}

describe("healerRole war duo staging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.creeps = {};
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
  });

  it("waits while paired attacker does not exist", () => {
    const healer = createMockPowerBankCreep("healer", {
      roomName: "E2N57",
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("moves to paired attacker room instead of racing to target room", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E1N57",
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      "E2N57",
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("crosses directly when following attacker from the matching exit tile", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E1N57",
      x: 49,
      y: 23,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    healer.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(healer.move).toHaveBeenCalledWith(RIGHT);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("clears the target-room landing tile when attacker is poised to cross in", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 49,
      y: 30,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 0,
      y: 30,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.move).toHaveBeenCalledWith(RIGHT);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("retreats from target room when attacker is not poised to cross in", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 48,
      y: 30,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 0,
      y: 30,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      "E2N57",
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("closes to adjacent range before entering target room", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1, avoidExitTiles: true }),
    );
    expect(moveToTargetRoom).not.toHaveBeenCalledWith(healer, TARGET_ROOM, expect.anything(), expect.anything());
  });

  it("moves with paired attacker when already adjacent outside target room", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 21,
      y: 20,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM, "E2N57").source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      "E2N57",
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("holds on an intermediate exit until attacker is also poised to cross", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E1N57",
      x: 48,
      y: 24,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E1N57",
      x: 49,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    healer.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
  });

  it("crosses an intermediate exit when attacker is poised on the same side", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E1N57",
      x: 49,
      y: 24,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E1N57",
      x: 49,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    healer.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("still advances toward an intermediate exit when not poised yet", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E1N57",
      x: 46,
      y: 24,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E1N57",
      x: 47,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    healer.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("moves toward the paired attacker's combat target at range 2 inside target room", () => {
    const hostile = hostileCreep("hostile-attacker");
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_CREEPS ? [hostile] : [])) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 20,
      y: 21,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      hostile,
      2,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
    expect(moveToTarget).not.toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
  });

  it("moves toward the paired attacker's war core objective at range 2", () => {
    const hostile = hostileCreep("hostile-attacker");
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-healer-objective", 23, 20, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_HOSTILE_STRUCTURES) return [spawn];
      return [];
    }) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 20,
      y: 21,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      spawn,
      2,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
    expect(moveToTarget).not.toHaveBeenCalledWith(
      healer,
      hostile,
      2,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
  });

  it("follows the attacker's selected breach instead of independently pathing to the core", () => {
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-behind-breach", 29, 37, 5_000);
    const wall = hostileStructure(STRUCTURE_WALL, "shared-breach-wall", 33, 47, 3_180_000) as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 38,
      y: 48,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: wall.id,
      },
    });
    attacker.room.find = jest.fn((type: FindConstant) =>
      type === FIND_HOSTILE_STRUCTURES ? [spawn, wall] : []
    ) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 37,
      y: 48,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.getObjectById = jest.fn((id: Id<_HasId>) => (id === wall.id ? wall : null)) as typeof Game.getObjectById;
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      wall,
      2,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
    expect(moveToTarget).not.toHaveBeenCalledWith(healer, spawn, 2, expect.anything());
  });

  it("holds adjacent in target room when the attacker has no combat target", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn(() => []) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 20,
      y: 21,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("steps off the target-room exit after crossing with the attacker", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 46,
      y: 48,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn(() => []) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 45,
      y: 49,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(moveOffExit).toHaveBeenCalledWith(healer);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("heals itself while maintaining formation when the attacker is already full", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn(() => []) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 20,
      y: 21,
      hits: 2_800,
      hitsMax: 3_800,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.heal).toHaveBeenCalledWith(healer);
  });

  it("heals itself when split tower fire leaves it proportionally weaker than the attacker", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      hits: 4_000,
      hitsMax: 5_000,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn(() => []) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 20,
      y: 21,
      hits: 2_800,
      hitsMax: 3_800,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.heal).toHaveBeenCalledWith(healer);
  });
});
