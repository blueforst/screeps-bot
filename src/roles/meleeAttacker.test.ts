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

import { findWarObjectiveTarget, meleeAttackerRole } from "@/roles/meleeAttacker";
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

function hostileCreep(name: string, hits: number, parts: Partial<Record<BodyPartConstant, number>> = {}): Creep {
  return {
    id: name as Id<Creep>,
    name,
    owner: { username: "TooAngel" },
    hits,
    pos: { x: 26, y: 25, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => parts[part] ?? 0),
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

function setupCounterstrikeScenario(overrides: {
  hostileX?: number;
  hostileY?: number;
  protectedByRampart?: boolean;
  approachOccupantRole?: "worker";
  approachObstacle?: "powerCreep" | "source";
} = {}) {
  const hostileX = overrides.hostileX ?? 27;
  const hostileY = overrides.hostileY ?? 27;
  const hostile = hostileCreep("counterstrike-hostile", 4_800, { [RANGED_ATTACK]: 8, [HEAL]: 8 });
  hostile.pos = new MockPos(hostileX, hostileY, TARGET_ROOM) as unknown as RoomPosition;
  const wall = hostileStructure(STRUCTURE_WALL, "tracked-counterstrike-wall", 24, 25, 400_000) as StructureWall;
  const protectingRampart = overrides.protectedByRampart
    ? hostileStructure(STRUCTURE_RAMPART, "counterstrike-cover", hostileX, hostileY, 200_000) as StructureRampart
    : null;
  const attacker = createMockPowerBankCreep("meleeAttacker", {
    name: "attacker",
    roomName: TARGET_ROOM,
    x: 25,
    y: 25,
    memory: {
      role: "meleeAttacker",
      configName: ATTACKER_CONFIG,
      _warBreachTargetId: wall.id,
    },
  });
  const healer = createMockPowerBankCreep("healer", {
    name: "healer",
    roomName: TARGET_ROOM,
    x: 26,
    y: 25,
    memory: { role: "healer", configName: HEALER_CONFIG },
  });
  const occupant = overrides.approachOccupantRole
    ? createMockPowerBankCreep(overrides.approachOccupantRole, {
        name: "approach-occupant",
        roomName: TARGET_ROOM,
        x: 26,
        y: 26,
        memory: { role: overrides.approachOccupantRole },
      })
    : null;
  const structures = [wall, ...(protectingRampart ? [protectingRampart] : [])];
  const myCreeps = [attacker, healer, ...(occupant ? [occupant] : [])];
  const powerCreep = overrides.approachObstacle === "powerCreep"
    ? ({ name: "approach-power-creep", pos: new MockPos(26, 26, TARGET_ROOM) } as unknown as PowerCreep)
    : null;
  const source = overrides.approachObstacle === "source"
    ? ({ id: "approach-source", pos: new MockPos(26, 26, TARGET_ROOM) } as unknown as Source)
    : null;
  attacker.room.find = jest.fn((type: FindConstant) => {
    if (type === FIND_HOSTILE_CREEPS) return [hostile];
    if (type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) return structures;
    if (type === FIND_MY_CREEPS) return myCreeps;
    if (type === FIND_CREEPS) return [...myCreeps, hostile];
    if (type === FIND_POWER_CREEPS) return powerCreep ? [powerCreep] : [];
    if (type === FIND_SOURCES) return source ? [source] : [];
    return [];
  }) as Room["find"];
  attacker.room.getTerrain = jest.fn(() => ({ get: jest.fn(() => 0) }) as unknown as RoomTerrain);
  attacker.pos.findInRange = jest.fn((type: FindConstant) => {
    if (type === FIND_HOSTILE_CREEPS) return attacker.pos.getRangeTo(hostile.pos) <= 1 ? [hostile] : [];
    if (type === FIND_STRUCTURES) {
      return structures.filter((structure) => attacker.pos.getRangeTo(structure.pos) <= 1);
    }
    return [];
  }) as unknown as RoomPosition["findInRange"];
  Game.getObjectById = jest.fn((id: string) => {
    if (id === wall.id) return wall;
    if (id === hostile.id) return hostile;
    return null;
  }) as typeof Game.getObjectById;
  Game.creeps = { attacker, healer, ...(occupant ? { [occupant.name]: occupant } : {}) };

  return { attacker, healer, hostile, wall, protectingRampart, occupant };
}

describe("meleeAttackerRole war duo staging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moveToTarget.mockReturnValue(OK);
    moveToTargetRoom.mockReturnValue(OK);
    Game.creeps = {};
    Object.assign(global, {
      PathFinder: {
        CostMatrix: class {
          private readonly values = new Map<string, number>();

          public set(x: number, y: number, value: number): void {
            this.values.set(`${x}:${y}`, value);
          }

          public get(x: number, y: number): number {
            return this.values.get(`${x}:${y}`) ?? 0;
          }
        },
        search: jest.fn(),
      },
    });
  });

  it("attacks adjacent hostile creeps while traveling and still moves toward target room", () => {
    const hostile = hostileCreep("hostile-carry", 1200);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 26,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    attacker.pos.findInRange = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_CREEPS ? [hostile] : [])) as unknown as RoomPosition["findInRange"];
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(hostile);
    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("ignores an adjacent defender protected by a hostile rampart and continues breaching", () => {
    const defender = hostileCreep("protected-ranged-defender", 4800, { [RANGED_ATTACK]: 8, [HEAL]: 8 });
    defender.pos = {
      x: 26,
      y: 25,
      roomName: TARGET_ROOM,
      getRangeTo: jest.fn(() => 1),
    } as unknown as RoomPosition;
    const rampart = hostileStructure(STRUCTURE_RAMPART, "defender-rampart", 26, 25, 680_000);
    const wall = hostileStructure(STRUCTURE_WALL, "safe-breach-wall", 24, 25, 1_100_000);
    const storage = hostileStructure(STRUCTURE_STORAGE, "storage-behind-defense", 20, 20, 10_000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 25,
      y: 25,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [defender];
      if (type === FIND_HOSTILE_STRUCTURES) return [storage, rampart, wall];
      if (type === FIND_STRUCTURES) return [storage, rampart, wall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [defender];
      if (type === FIND_STRUCTURES) return [rampart, wall];
      return [];
    }) as unknown as RoomPosition["findInRange"];
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [{ x: wall.pos.x, y: wall.pos.y, roomName: TARGET_ROOM }],
      incomplete: false,
      cost: 100,
      ops: 20,
    });
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 25,
        y: 24,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalledWith(defender);
    expect(attacker.attack).toHaveBeenCalledWith(wall);
    expect(attacker.memory._warBreachTargetId).toBe(wall.id);
  });

  it("focuses hostile spawn before non-adjacent creeps and towers for war objectives", () => {
    const hostile = hostileCreep("hostile-defender", 800, { [ATTACK]: 5 });
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-war-objective", 20, 20, 5000);
    const tower = hostileStructure(STRUCTURE_TOWER, "tower-war-objective", 10, 10, 3000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_HOSTILE_STRUCTURES) return [tower, spawn];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === spawn ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 2, y: 1, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(attacker.attack).not.toHaveBeenCalledWith(hostile);
    expect(attacker.attack).not.toHaveBeenCalledWith(tower);
    expect(moveToTarget).toHaveBeenCalledWith(
      attacker,
      spawn,
      1,
      expect.objectContaining({
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
        ignoreCreeps: false,
        reusePath: 0,
      }),
    );
    expect((attacker.memory as CreepMemory & { _warMoveIntentAt?: number })._warMoveIntentAt).toBe(Game.time);
  });

  it("keeps working on a tracked residual breach instead of chasing a distant hostile builder", () => {
    const builder = hostileCreep("hostile-builder-intercept", 1200, { [WORK]: 8, [CARRY]: 4, [MOVE]: 4 });
    builder.pos = { x: 30, y: 30, roomName: TARGET_ROOM } as RoomPosition;
    const trackedWall = hostileStructure(
      STRUCTURE_WALL,
      "obsolete-builder-wall",
      2,
      16,
      1_000_000,
    ) as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 3,
      y: 17,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: trackedWall.id,
      },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [builder];
      if (type === FIND_HOSTILE_STRUCTURES) return [trackedWall];
      if (type === FIND_STRUCTURES) return [trackedWall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) =>
      target === builder ? ERR_NOT_IN_RANGE : OK
    ) as Creep["attack"];
    Game.getObjectById = jest.fn((id: string) => (id === trackedWall.id ? trackedWall : null)) as typeof Game.getObjectById;
    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], incomplete: false, cost: 0, ops: 1 });
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 4,
        y: 17,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(trackedWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(builder);
    expect(attacker.memory._warBreachTargetId).toBe(trackedWall.id);
  });

  it("keeps working on hostile structures instead of chasing exposed dangerous creeps", () => {
    const exposed = hostileCreep("exposed-attacker", 800, { [ATTACK]: 5 });
    exposed.pos = { x: 10, y: 10, roomName: TARGET_ROOM } as RoomPosition;
    const protectedRanged = hostileCreep("protected-ranged", 800, { [RANGED_ATTACK]: 5 });
    protectedRanged.pos = { x: 20, y: 20, roomName: TARGET_ROOM } as RoomPosition;
    const rampart = hostileStructure(STRUCTURE_RAMPART, "guard-rampart", 20, 20, 100_000);
    const lab = hostileStructure(STRUCTURE_LAB, "unguarded-lab", 25, 25, 500);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM });
    let creeps = [protectedRanged, exposed];
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return creeps;
      if (type === FIND_HOSTILE_STRUCTURES) return [rampart, lab];
      return [];
    }) as Room["find"];

    expect(findWarObjectiveTarget(attacker)).toBe(lab);
    creeps = [protectedRanged];
    expect(findWarObjectiveTarget(attacker)).toBe(lab);
  });

  it("keeps non-war melee targeting hostile creeps before structures", () => {
    const hostile = hostileCreep("home-hostile", 800, { [ATTACK]: 5 });
    const spawn = hostileStructure(STRUCTURE_SPAWN, "home-hostile-spawn", 20, 20, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker" },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_HOSTILE_STRUCTURES) return [spawn];
      return [];
    }) as Room["find"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === hostile ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker };

    meleeAttackerRole().target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(hostile);
    expect(attacker.attack).not.toHaveBeenCalledWith(spawn);
  });
});
