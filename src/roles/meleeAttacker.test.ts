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

import { findWarObjectiveTarget, meleeAttackerRole } from "@/roles/meleeAttacker";
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

  it("waits outside target room until paired healer exists", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      roomName: "E2N57",
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    Game.creeps = { attacker };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("continues toward the target without its fixed healer after being detached", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      roomName: "E2N57",
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warDetached: true,
      },
    });
    Game.creeps = { attacker };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("waits outside target room until paired healer is adjacent", () => {
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

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("enters target room once paired healer is adjacent", () => {
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

    meleeAttackerRole(TARGET_ROOM, "E2N57").source?.(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      "E2N57",
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("does not cross an exit alone when healer is adjacent but not also on the exit", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 49,
      y: 25,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 48,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("crosses when healer is adjacent and also on the same exit edge", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 49,
      y: 25,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.findExitTo = jest.fn(() => RIGHT) as Room["findExitTo"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 49,
      y: 24,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("retreats from target room when healer has not entered", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 10,
      y: 10,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      "E2N57",
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("holds inside the target room while the healer is poised to cross in", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 49,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 20,
      y: 0,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    healer.room.findExitTo = jest.fn(() => TOP) as Room["findExitTo"];
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveOffExit).toHaveBeenCalledWith(attacker);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("waits as leader and steps off the exit when healer is still in the previous room", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 0,
      y: 25,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E1N57",
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(moveOffExit).toHaveBeenCalledWith(attacker);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("steps off an intermediate landing while waiting for the healer to close formation", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E3N55",
      x: 0,
      y: 35,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E3N55",
      x: 2,
      y: 33,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    meleeAttackerRole("E2N54", "E1N56|E2N56|E2N55|E3N55|E3N54").source?.(attacker);

    expect(moveOffExit).toHaveBeenCalledWith(attacker);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("crosses into target room when healer is already inside and attacker is poised on the exit", () => {
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

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("continues forward when the healer has already crossed into the next fixed-route room", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N55",
      x: 49,
      y: 36,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.findExitTo = jest.fn((roomName: string) => (roomName === "E3N55" ? RIGHT : ERR_NO_PATH)) as Room["findExitTo"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E3N55",
      x: 1,
      y: 35,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };

    meleeAttackerRole("E2N54", "E1N56|E2N56|E2N55|E3N55|E3N54").source?.(attacker);

    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(attacker.move).not.toHaveBeenCalledWith(LEFT);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("attacks the weakest adjacent wall while formation-blocked inside target room", () => {
    const weakWall = {
      id: "weak-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 1000,
      pos: { x: 11, y: 10, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 8) } as unknown as RoomPosition,
    } as StructureWall;
    const strongRampart = {
      id: "strong-rampart" as Id<StructureRampart>,
      structureType: STRUCTURE_RAMPART,
      hits: 9000,
      pos: { x: 10, y: 11, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 2) } as unknown as RoomPosition,
    } as StructureRampart;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 10,
      y: 10,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    attacker.pos.findInRange = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_STRUCTURES) return [strongRampart, weakWall];
      return [];
    }) as unknown as RoomPosition["findInRange"];
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(weakWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(strongRampart);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("does not attack adjacent walls outside target room while formation-blocked", () => {
    const wall = {
      id: "route-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 1000,
      pos: { x: 26, y: 25, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    } as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.pos.findInRange = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_STRUCTURES) return [wall];
      return [];
    }) as unknown as RoomPosition["findInRange"];
    Game.creeps = { attacker };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("holds position while attacking an adjacent route wall with its healer", () => {
    const wall = {
      id: "route-blocking-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 460_000,
      pos: { x: 25, y: 26, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    } as StructureWall;
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
      x: 24,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    attacker.room.controller = { my: false } as StructureController;
    attacker.pos.findInRange = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_STRUCTURES) return [wall];
      return [];
    }) as unknown as RoomPosition["findInRange"];
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(wall);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(attacker.memory._warBreachTargetId).toBe(wall.id);
  });

  it("keeps attacking the tracked route wall instead of switching to a weaker adjacent wall", () => {
    const trackedWall = {
      id: "tracked-route-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 460_000,
      pos: { x: 25, y: 26, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    } as StructureWall;
    const weakerWall = {
      id: "weaker-route-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 10_000,
      pos: { x: 24, y: 25, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    } as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: trackedWall.id,
      },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 26,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    attacker.room.controller = { my: false } as StructureController;
    attacker.pos.findInRange = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_STRUCTURES) return [weakerWall, trackedWall];
      return [];
    }) as unknown as RoomPosition["findInRange"];
    Game.getObjectById = jest.fn((id: Id<_HasId>) => (id === trackedWall.id ? trackedWall : null)) as typeof Game.getObjectById;
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(trackedWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(weakerWall);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("moves through a fresh breach instead of locking onto the next wall", () => {
    const nextWall = {
      id: "next-route-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 460_000,
      pos: { x: 24, y: 26, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    } as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: "destroyed-route-wall" as Id<StructureWall>,
      },
    });
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: "E2N57",
      x: 26,
      y: 25,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    attacker.room.controller = { my: false } as StructureController;
    attacker.pos.findInRange = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_STRUCTURES) return [nextWall];
      return [];
    }) as unknown as RoomPosition["findInRange"];
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
    Game.time = 100;
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.attack).not.toHaveBeenCalledWith(nextWall);
    expect(moveToTargetRoom).toHaveBeenCalled();
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    expect(attacker.memory._warBreachResumeUntil).toBe(105);
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

  it("prioritizes dangerous adjacent hostile creeps while traveling", () => {
    const harmless = hostileCreep("hostile-carry", 100);
    const dangerous = hostileCreep("hostile-healer", 800, { [HEAL]: 5 });
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
    attacker.pos.findInRange = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_CREEPS ? [harmless, dangerous] : [])) as unknown as RoomPosition["findInRange"];
    Game.creeps = { attacker, healer };

    meleeAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(dangerous);
    expect(attacker.attack).not.toHaveBeenCalledWith(harmless);
  });

  it("chooses the weakest adjacent breach target when the preferred target has no path", () => {
    moveToTarget.mockReturnValue(ERR_NO_PATH);
    const tower = {
      id: "tower-weak-breach" as Id<StructureTower>,
      structureType: STRUCTURE_TOWER,
      hits: 3000,
      pos: { x: 10, y: 10, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 8) } as unknown as RoomPosition,
    } as StructureTower;
    const closerWall = {
      id: "closer-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 9000,
      pos: { x: 1, y: 30, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 2) } as unknown as RoomPosition,
    } as StructureWall;
    const weakWall = {
      id: "weak-wall" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 1000,
      pos: { x: 0, y: 31, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 7) } as unknown as RoomPosition,
    } as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 0,
      y: 30,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_STRUCTURES ? [tower] : [])) as Room["find"];
    attacker.pos.findInRange = jest.fn((type: FindConstant) => (type === FIND_STRUCTURES ? [closerWall, weakWall] : [])) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === tower ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 1, y: 30, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(tower);
    expect(attacker.attack).toHaveBeenCalledWith(weakWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(closerWall);
  });

  it("attacks an adjacent dangerous defender before pursuing a war objective", () => {
    const defender = hostileCreep("defender-on-rampart", 1600, { [RANGED_ATTACK]: 4, [HEAL]: 4 });
    const storage = hostileStructure(STRUCTURE_STORAGE, "storage-behind-defender", 22, 26, 10_000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 25,
      y: 15,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [defender];
      if (type === FIND_HOSTILE_STRUCTURES) return [storage];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn((type: FindConstant) =>
      type === FIND_HOSTILE_CREEPS ? [defender] : []
    ) as unknown as RoomPosition["findInRange"];
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 24,
        y: 14,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(defender);
    expect(attacker.attack).not.toHaveBeenCalledWith(storage);
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

  it("attacks the weakest adjacent hostile structure when extensions block the objective", () => {
    moveToTarget.mockReturnValue(ERR_NO_PATH);
    const storage = hostileStructure(STRUCTURE_STORAGE, "blocked-storage", 22, 26, 10_000);
    const extension = hostileStructure(STRUCTURE_EXTENSION, "blocking-extension", 25, 16, 1_000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 25,
      y: 15,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) =>
      type === FIND_HOSTILE_STRUCTURES ? [storage, extension] : []
    ) as Room["find"];
    attacker.pos.findInRange = jest.fn((type: FindConstant) =>
      type === FIND_STRUCTURES ? [extension] : []
    ) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === storage ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 24,
        y: 14,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(storage);
    expect(attacker.attack).toHaveBeenCalledWith(extension);
  });

  it("approaches the first wall on a complete combat path instead of looping in an entry pocket", () => {
    const spawn = hostileStructure(STRUCTURE_SPAWN, "pocket-blocked-spawn", 29, 37, 5_000);
    const wall = hostileStructure(STRUCTURE_WALL, "reachable-breach-wall", 33, 47, 3_180_000) as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 36,
      y: 47,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_STRUCTURES) return [spawn, wall];
      if (type === FIND_STRUCTURES) return [spawn, wall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE) as Creep["attack"];
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [
        { x: 36, y: 48, roomName: TARGET_ROOM },
        { x: 35, y: 48, roomName: TARGET_ROOM },
        { x: 34, y: 48, roomName: TARGET_ROOM },
        { x: 33, y: 47, roomName: TARGET_ROOM },
      ],
      incomplete: false,
      cost: 260,
      ops: 40,
    });
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 37,
        y: 47,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveToTarget).toHaveBeenCalledWith(
      attacker,
      wall,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
    expect(moveToTarget).not.toHaveBeenCalledWith(attacker, spawn, 1, expect.anything());
    expect(attacker.memory._warBreachTargetId).toBe(wall.id);
  });

  it("breaches the hostile rampart covering a core structure before attacking the structure", () => {
    const tower = hostileStructure(STRUCTURE_TOWER, "covered-core-tower", 39, 43, 3000) as StructureTower;
    const coveringRampart = hostileStructure(
      STRUCTURE_RAMPART,
      "covering-core-rampart",
      39,
      43,
      4801,
    ) as StructureRampart;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 35,
      y: 43,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) return [tower, coveringRampart];
      if (type === FIND_MY_CREEPS) return [attacker];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE) as Creep["attack"];
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [
        { x: 36, y: 43, roomName: TARGET_ROOM },
        { x: 37, y: 43, roomName: TARGET_ROOM },
        { x: 38, y: 43, roomName: TARGET_ROOM },
      ],
      incomplete: false,
      cost: 6,
      ops: 10,
    });
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 35,
        y: 42,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(coveringRampart);
    expect(attacker.attack).not.toHaveBeenCalledWith(tower);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, coveringRampart, 1, expect.anything());
    expect(attacker.memory._warBreachTargetId).toBe(coveringRampart.id);
  });

  it("keeps attacking a tracked target-room breach until that structure is gone", () => {
    const spawn = hostileStructure(STRUCTURE_SPAWN, "tracked-breach-spawn", 20, 20, 5_000);
    const trackedWall = hostileStructure(
      STRUCTURE_WALL,
      "tracked-target-wall",
      26,
      25,
      1_700_000,
    ) as StructureWall;
    const replannedWall = hostileStructure(
      STRUCTURE_WALL,
      "replanned-target-wall",
      24,
      25,
      1_600_000,
    ) as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: trackedWall.id,
      },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_HOSTILE_STRUCTURES) return [spawn, trackedWall, replannedWall];
      if (type === FIND_STRUCTURES) return [spawn, trackedWall, replannedWall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    Game.getObjectById = jest.fn((id: string) => (id === trackedWall.id ? trackedWall : null)) as typeof Game.getObjectById;
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [{ x: replannedWall.pos.x, y: replannedWall.pos.y, roomName: TARGET_ROOM }],
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

    expect(attacker.attack).toHaveBeenCalledWith(trackedWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(replannedWall);
    expect(attacker.memory._warBreachTargetId).toBe(trackedWall.id);
  });

  it("keeps an adjacent tracked breach locked when a distant defender moves", () => {
    const defender = hostileCreep("moving-ranged-defender", 4800, { [RANGED_ATTACK]: 8, [HEAL]: 8 });
    defender.pos = {
      x: 40,
      y: 40,
      roomName: TARGET_ROOM,
      getRangeTo: jest.fn(() => 10),
    } as unknown as RoomPosition;
    const trackedWall = hostileStructure(
      STRUCTURE_WALL,
      "entry-wall-in-progress",
      26,
      25,
      240_000,
    ) as StructureWall;
    const replannedWall = hostileStructure(
      STRUCTURE_WALL,
      "moving-target-alternate-wall",
      24,
      25,
      450_000,
    ) as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: trackedWall.id,
      },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [defender];
      if (type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) return [trackedWall, replannedWall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    Game.getObjectById = jest.fn((id: string) => (id === trackedWall.id ? trackedWall : null)) as typeof Game.getObjectById;
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [{ x: replannedWall.pos.x, y: replannedWall.pos.y, roomName: TARGET_ROOM }],
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

    expect(attacker.attack).toHaveBeenCalledWith(trackedWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(replannedWall);
    expect(attacker.memory._warBreachTargetId).toBe(trackedWall.id);
  });

  it("replans a distant tracked breach when an exposed defender arrives", () => {
    const defender = hostileCreep("exposed-moving-defender", 4800, { [RANGED_ATTACK]: 8, [HEAL]: 8 });
    defender.pos = {
      x: 20,
      y: 20,
      roomName: TARGET_ROOM,
      getRangeTo: jest.fn(() => 10),
    } as unknown as RoomPosition;
    const staleWall = hostileStructure(STRUCTURE_WALL, "distant-stale-wall", 40, 40, 240_000) as StructureWall;
    const routeWall = hostileStructure(STRUCTURE_WALL, "current-route-wall", 26, 25, 450_000) as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: ATTACKER_CONFIG,
        _warBreachTargetId: staleWall.id,
      },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [defender];
      if (type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) return [staleWall, routeWall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    Game.getObjectById = jest.fn((id: string) => (id === staleWall.id ? staleWall : null)) as typeof Game.getObjectById;
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [{ x: routeWall.pos.x, y: routeWall.pos.y, roomName: TARGET_ROOM }],
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

    expect(attacker.attack).toHaveBeenCalledWith(routeWall);
    expect(attacker.attack).not.toHaveBeenCalledWith(staleWall);
    expect(attacker.memory._warBreachTargetId).toBe(routeWall.id);
  });

  it("assigns a higher combat path cost to ramparts than walls", () => {
    const spawn = hostileStructure(STRUCTURE_SPAWN, "mixed-defense-spawn", 29, 37, 5_000);
    const wall = hostileStructure(STRUCTURE_WALL, "safe-wall", 33, 47, 3_182_901) as StructureWall;
    const rampart = hostileStructure(STRUCTURE_RAMPART, "guarded-rampart", 42, 47, 3_178_301) as StructureRampart;
    const unsafeWall = hostileStructure(STRUCTURE_WALL, "ranged-guarded-wall", 43, 47, 3_183_001) as StructureWall;
    const rangedGuard = hostileCreep("ranged-guard", 5_000, { [RANGED_ATTACK]: 20 });
    rangedGuard.pos = {
      x: 42,
      y: 47,
      roomName: TARGET_ROOM,
      getRangeTo: jest.fn((target: RoomPosition | { pos: RoomPosition }) => {
        const pos = "pos" in target ? target.pos : target;
        return Math.max(Math.abs(42 - pos.x), Math.abs(47 - pos.y));
      }),
    } as unknown as RoomPosition;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 36,
      y: 48,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [rangedGuard];
      if (type === FIND_HOSTILE_STRUCTURES) return [spawn, wall, rampart, unsafeWall];
      if (type === FIND_STRUCTURES) return [spawn, wall, rampart, unsafeWall];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE) as Creep["attack"];
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: RoomPosition, _goal: unknown, options: { roomCallback: (roomName: string) => CostMatrix | false }) => {
        const matrix = options.roomCallback(TARGET_ROOM) as CostMatrix;
        expect(matrix.get(wall.pos.x, wall.pos.y)).toBeLessThan(matrix.get(rampart.pos.x, rampart.pos.y));
        expect(matrix.get(wall.pos.x, wall.pos.y)).toBeLessThan(matrix.get(unsafeWall.pos.x, unsafeWall.pos.y));
        return {
          path: [{ x: wall.pos.x, y: wall.pos.y, roomName: TARGET_ROOM }],
          incomplete: false,
          cost: 100,
          ops: 20,
        };
      },
    );
    Game.creeps = {
      attacker,
      healer: createMockPowerBankCreep("healer", {
        name: "healer",
        roomName: TARGET_ROOM,
        x: 37,
        y: 48,
        memory: { role: "healer", configName: HEALER_CONFIG },
      }),
    };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveToTarget).toHaveBeenCalledWith(attacker, wall, 1, expect.anything());
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
  });

  it("targets tower before storage after hostile spawns are gone", () => {
    const tower = hostileStructure(STRUCTURE_TOWER, "tower-after-spawn", 10, 10, 3000);
    const storage = hostileStructure(STRUCTURE_STORAGE, "storage-after-spawn", 5, 5, 10000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_STRUCTURES ? [storage, tower] : [])) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === tower ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 2, y: 1, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(tower);
    expect(attacker.attack).not.toHaveBeenCalledWith(storage);
  });

  it("targets storage after spawn and tower are gone", () => {
    const storage = hostileStructure(STRUCTURE_STORAGE, "storage-objective", 5, 5, 10000);
    const terminal = hostileStructure(STRUCTURE_TERMINAL, "terminal-objective", 4, 4, 10000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_STRUCTURES ? [terminal, storage] : [])) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === storage ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 2, y: 1, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(storage);
    expect(attacker.attack).not.toHaveBeenCalledWith(terminal);
  });

  it("targets exposed utilities before harmless creeps and residual ramparts", () => {
    const harmless = hostileCreep("harmless-hauler", 800, { [CARRY]: 10 });
    const rampart = hostileStructure(STRUCTURE_RAMPART, "residual-rampart", 12, 12, 1_000_000);
    const extension = hostileStructure(STRUCTURE_EXTENSION, "exposed-extension", 15, 15, 1000);
    const lab = hostileStructure(STRUCTURE_LAB, "exposed-lab", 20, 20, 500);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [harmless];
      if (type === FIND_HOSTILE_STRUCTURES) return [rampart, extension, lab];
      return [];
    }) as Room["find"];

    expect(findWarObjectiveTarget(attacker)).toBe(lab);
  });

  it("does not chase a distant harmless creep when no hostile structures remain", () => {
    const harmless = hostileCreep("harmless-runner", 800, { [MOVE]: 10, [CARRY]: 10 });
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM });
    attacker.room.find = jest.fn((type: FindConstant) =>
      type === FIND_HOSTILE_CREEPS ? [harmless] : []
    ) as Room["find"];

    expect(findWarObjectiveTarget(attacker)).toBeNull();
  });

  it("does not chase a distant hostile builder instead of working on residual barriers", () => {
    const builder = hostileCreep("hostile-builder", 1200, { [WORK]: 8, [CARRY]: 4, [MOVE]: 4 });
    const rampart = hostileStructure(STRUCTURE_RAMPART, "residual-builder-rampart", 12, 12, 1_000_000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [builder];
      if (type === FIND_HOSTILE_STRUCTURES) return [rampart];
      return [];
    }) as Room["find"];

    expect(findWarObjectiveTarget(attacker)).toBe(rampart);
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

  it("targets an exposed dangerous creep but not one protected by a hostile rampart", () => {
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

    expect(findWarObjectiveTarget(attacker)).toBe(exposed);
    creeps = [protectedRanged];
    expect(findWarObjectiveTarget(attacker)).toBe(lab);
  });

  it("prefers a wall outside hostile ranged coverage when only barriers remain", () => {
    const ranged = hostileCreep("ranged-guard", 800, { [RANGED_ATTACK]: 5 });
    ranged.pos = {
      x: 40,
      y: 40,
      roomName: TARGET_ROOM,
      getRangeTo: jest.fn((target: RoomPosition | { pos: RoomPosition }) => {
        const pos = "pos" in target ? target.pos : target;
        return Math.max(Math.abs(40 - pos.x), Math.abs(40 - pos.y));
      }),
    } as unknown as RoomPosition;
    const safeWall = hostileStructure(STRUCTURE_WALL, "safe-wall", 10, 10, 1_000_000);
    const coveredWall = hostileStructure(STRUCTURE_WALL, "covered-wall", 42, 42, 1000);
    const rampart = hostileStructure(STRUCTURE_RAMPART, "residual-rampart-2", 40, 40, 100);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [ranged];
      if (type === FIND_HOSTILE_STRUCTURES) return [rampart, coveredWall, safeWall];
      return [];
    }) as Room["find"];

    expect(findWarObjectiveTarget(attacker)).toBe(safeWall);
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

  it("keeps moving toward the preferred target when a path exists instead of attacking adjacent walls", () => {
    const tower = {
      id: "tower-0" as Id<StructureTower>,
      structureType: STRUCTURE_TOWER,
      hits: 3000,
      pos: { x: 10, y: 10, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 8) } as unknown as RoomPosition,
    } as StructureTower;
    const wall = {
      id: "wall-0" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 1000,
      pos: { x: 1, y: 30, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 7) } as unknown as RoomPosition,
    } as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 0,
      y: 30,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_STRUCTURES ? [tower] : [])) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => [wall]) as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === tower ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 1, y: 30, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveToTarget).toHaveBeenCalledWith(
      attacker,
      tower,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
    );
    expect(attacker.attack).toHaveBeenCalledWith(tower);
    expect(attacker.attack).not.toHaveBeenCalledWith(wall);
  });

  it("attacks an adjacent wall when the preferred target has no path", () => {
    moveToTarget.mockReturnValue(ERR_NO_PATH);
    const tower = {
      id: "tower-0" as Id<StructureTower>,
      structureType: STRUCTURE_TOWER,
      hits: 3000,
      pos: { x: 10, y: 10, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 8) } as unknown as RoomPosition,
    } as StructureTower;
    const wall = {
      id: "wall-0" as Id<StructureWall>,
      structureType: STRUCTURE_WALL,
      hits: 1000,
      pos: { x: 1, y: 30, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 7) } as unknown as RoomPosition,
    } as StructureWall;
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 0,
      y: 30,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => (type === FIND_HOSTILE_STRUCTURES ? [tower] : [])) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => [wall]) as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === tower ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 1, y: 30, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(tower);
    expect(attacker.attack).toHaveBeenCalledWith(wall);
  });
});
