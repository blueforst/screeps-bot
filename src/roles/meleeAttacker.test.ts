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
