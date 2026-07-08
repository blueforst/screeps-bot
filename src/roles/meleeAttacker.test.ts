jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { createMockPowerBankCreep } from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
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

    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
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
      expect.objectContaining({ plainCost: 2, swampCost: 8, maxRooms: 1 }),
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
