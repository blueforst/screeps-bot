jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
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
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";

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

function setupCounterstrikeSwapScenario(overrides: {
  createdAt?: number;
  targetX?: number;
  targetY?: number;
  protectedByRampart?: boolean;
  healerSwap?: boolean;
} = {}) {
  const targetX = overrides.targetX ?? 27;
  const targetY = overrides.targetY ?? 27;
  const hostile = hostileCreep("counterstrike-swap-hostile", 4_800);
  hostile.pos = new MockPos(targetX, targetY, TARGET_ROOM) as unknown as RoomPosition;
  const rampart = overrides.protectedByRampart
    ? hostileStructure(STRUCTURE_RAMPART, "counterstrike-swap-cover", targetX, targetY, 200_000)
    : null;
  const healerSwap = overrides.healerSwap !== false;
  const attacker = createMockPowerBankCreep("meleeAttacker", {
    name: "attacker",
    roomName: TARGET_ROOM,
    x: 25,
    y: 25,
    memory: {
      role: "meleeAttacker",
      configName: ATTACKER_CONFIG,
      _warCounterstrike: {
        targetId: hostile.id,
        targetX,
        targetY,
        createdAt: overrides.createdAt ?? Game.time - 1,
        originX: 25,
        originY: 25,
        approachX: 26,
        approachY: 26,
        healerCoordinated: true,
        healerSwap: healerSwap || undefined,
      },
      _warCounterstrikeSuppressedTargetIds: [hostile.id],
    },
  });
  const healer = createMockPowerBankCreep("healer", {
    name: "healer",
    roomName: TARGET_ROOM,
    x: 26,
    y: healerSwap ? 26 : 25,
    memory: { role: "healer", configName: HEALER_CONFIG },
  });
  const structures = rampart ? [rampart] : [];
  const room = attacker.room;
  healer.room = room;
  room.getTerrain = jest.fn(() => ({ get: jest.fn(() => 0) })) as unknown as Room["getTerrain"];
  room.find = jest.fn((type: FindConstant) => {
    if (type === FIND_HOSTILE_CREEPS) return [hostile];
    if (type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) return structures;
    if (type === FIND_MY_CREEPS) return [attacker, healer];
    if (type === FIND_CREEPS) return [attacker, healer, hostile];
    return [];
  }) as Room["find"];
  attacker.pos.findInRange = jest.fn((type: FindConstant) => {
    if (type === FIND_HOSTILE_CREEPS) return attacker.pos.getRangeTo(hostile.pos) <= 1 ? [hostile] : [];
    if (type === FIND_STRUCTURES) return [];
    return [];
  }) as unknown as RoomPosition["findInRange"];
  Game.getObjectById = jest.fn((id: string) => id === hostile.id ? hostile : null) as typeof Game.getObjectById;
  Game.creeps = { attacker, healer };

  return { attacker, healer, hostile, rampart };
}

describe("healerRole war duo staging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCreepMovementStateForTest();
    Game.creeps = {};
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
  });

  it("steps into the attacker's previous tile when the paired attacker moves this tick", () => {
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-following-move", 23, 20, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) =>
      type === FIND_HOSTILE_STRUCTURES ? [spawn] : []
    ) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 19,
      y: 19,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };
    (attacker.memory as CreepMemory & { _warMoveIntentAt?: number })._warMoveIntentAt = Game.time;

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.move).toHaveBeenCalledWith(healer.pos.getDirectionTo(attacker.pos));
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("holds adjacent at the attacker's selected breach until the attacker moves", () => {
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

    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("acknowledges then yields on the coordinated counterstrike tick when healer runs first", () => {
    Game.time = 101;
    const { attacker, healer } = setupCounterstrikeSwapScenario({ createdAt: 100 });

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warCounterstrike?.healerReadyAt).toBe(101);

    Game.time = 102;
    jest.clearAllMocks();
    healerRole(TARGET_ROOM).target(healer);
    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(healer.move).toHaveBeenCalledWith(TOP_LEFT);
    expect(attacker.move).toHaveBeenCalledWith(BOTTOM_RIGHT);
  });

  it("cancels when the target moves but remains beside the planned approach", () => {
    Game.time = 101;
    const { attacker, healer, hostile } = setupCounterstrikeSwapScenario({ createdAt: 100 });
    hostile.pos = new MockPos(27, 26, TARGET_ROOM) as unknown as RoomPosition;

    healerRole(TARGET_ROOM).target(healer);

    expect(attacker.memory._warCounterstrike).toBeUndefined();
  });

  it("does not yield after the counterstrike target enters a hostile rampart", () => {
    Game.time = 101;
    const { healer } = setupCounterstrikeSwapScenario({ createdAt: 100, protectedByRampart: true });

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.move).not.toHaveBeenCalled();
    expect(Game.creeps.attacker.memory._warCounterstrike?.healerReadyAt).toBeUndefined();
  });

  it("does not acknowledge a pending counterstrike when another hostile is already adjacent", () => {
    Game.time = 101;
    const { attacker, healer, hostile } = setupCounterstrikeSwapScenario({ createdAt: 100 });
    const adjacent = hostileCreep("adjacent-counterstrike-hostile", 800);
    adjacent.pos = new MockPos(26, 25, TARGET_ROOM) as unknown as RoomPosition;
    const originalFind = attacker.room.find as jest.Mock;
    attacker.room.find = jest.fn((type: FindConstant) => {
      const base = originalFind(type) as unknown[];
      if (type === FIND_HOSTILE_CREEPS) return [hostile, adjacent];
      if (type === FIND_CREEPS) return [...base, adjacent];
      return base;
    }) as Room["find"];

    healerRole(TARGET_ROOM).target(healer);

    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warCounterstrike?.healerReadyAt).toBeUndefined();
  });
});
