jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => any) => fn(),
  measureCreepDecision: (fn: () => any) => fn(),
}));

import { powerBankHaulerRole } from "@/roles/powerBankHauler";
import { createMockPowerBankCreep, createMockDroppedPower, createMockStore, MockPos } from "@mock/powerBank";
import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const SOURCE_ROOM = "W1N1";
const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_POS = { x: 25, y: 25 };

function setupTask(
  status: PowerBankHarvestStatus = "hauling",
  overrides: Partial<PowerBankHarvestTask> = {},
): PowerBankHarvestTask {
  const task: PowerBankHarvestTask = {
    id: TASK_ID,
    status,
    sourceRoom: SOURCE_ROOM,
    targetRoom: TARGET_ROOM,
    bankId: "pb-0",
    bankPos: BANK_POS,
    hits: 2_000_000,
    power: 5000,
    ticksToDecay: 5000,
    freeTiles: 8,
    discoveredTick: 100,
    lastSeenTick: 100,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
    ...overrides,
  };
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.powerBankHarvest) Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvest![TASK_ID] = task;
  return task;
}

function createHauler(overrides: {
  roomName?: string;
  x?: number;
  y?: number;
  store?: Record<string, number>;
  carryCapacity?: number;
}): Creep {
  return createMockPowerBankCreep("powerBankHauler", {
    roomName: overrides.roomName ?? TARGET_ROOM,
    x: overrides.x ?? 20,
    y: overrides.y ?? 20,
    store: overrides.store ?? {},
    carryCapacity: overrides.carryCapacity ?? 1600,
    memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0` } as Partial<CreepMemory>,
  });
}

describe("powerBankHaulerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Memory as any).data = {};
    Game.creeps = {} as Record<string, Creep>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Game.map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) } as unknown as RoomTerrain)),
    } as unknown as GameMap;
    (global as typeof global & { RoomPosition: typeof MockPos }).RoomPosition = MockPos;
    delete (global as any).__runtimeServices;
    clearCreepMovementStateForTest();
  });

  describe("wait at safe range while bank alive", () => {

    it("moves to power bank vicinity before attacking starts", () => {
      setupTask("travelling");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 10, y: 10 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(moveToTarget).toHaveBeenCalledWith(
        hauler,
        expect.objectContaining({ roomName: TARGET_ROOM }),
        0,
        expect.objectContaining({ reusePath: 10, ignoreCreeps: true, avoidExitTiles: true }),
      );
      expect(result).toBe(false);
    });
  });

  describe("ignore generic energy assignments", () => {
    it("prepare returns true immediately — does not participate in energy assignments", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.prepare!(hauler);

      expect(result).toBe(true);
    });
  });

  describe("goes back for more power", () => {

    it("target phase returns false when in target room with hauling active", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.target(hauler);

      expect(result).toBe(false);
    });
  });

  describe("no task", () => {

    it("retires instead of salvaging toward a non-patrol target room", () => {
      const outsideTarget = "W0N55";
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: SOURCE_ROOM,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", configName: `${SOURCE_ROOM}:powerbank:${outsideTarget}:hauler:0` } as Partial<CreepMemory>,
      });

      const role = powerBankHaulerRole(outsideTarget);
      const result = role.source(hauler);

      expect(result).toBe(true);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(hauler.suicide).toHaveBeenCalled();
    });
  });

  describe("flee traffic awareness (Task 3)", () => {
    /**
     * Helper to register creeps in Game.creeps and set up room.find(FIND_MY_CREEPS)
     * so the tick context service / findMyCreepAt can discover them.
     */
    function registerCreepsInRoom(creeps: Creep[], roomName: string): void {
      for (const c of creeps) {
        Game.creeps[c.name] = c;
      }
      if (!Game.rooms[roomName]) {
        (Game.rooms as Record<string, Room>)[roomName] = creeps[0].room;
      }
      const room = Game.rooms[roomName];
      (room as any).find = jest.fn((constant: number) => {
        if (constant === FIND_MY_CREEPS) return creeps;
        if (constant === FIND_STRUCTURES) return [];
        if (constant === FIND_DROPPED_RESOURCES) return [];
        return [];
      });
    }

    it("side-steps when intended flee tile is occupied by another hauler", () => {
      setupTask("attacking");
      // Hauler at (26, 25), bank at (25, 25). Radial flee direction = RIGHT (x increases).
      // Intended flee tile: (27, 25). Block it with another hauler.
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 26, y: 25 });
      const blocker = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-blocker",
        roomName: TARGET_ROOM,
        x: 27,
        y: 25,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:1` } as Partial<CreepMemory>,
      });

      registerCreepsInRoom([hauler, blocker], TARGET_ROOM);

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      // Should have moved but NOT in the RIGHT direction (6) since (27,25) is blocked
      expect(hauler.move).toHaveBeenCalled();
      const moveDir = (hauler.move as jest.Mock).mock.calls[0][0] as DirectionConstant;
      expect(moveDir).not.toBe(RIGHT as DirectionConstant);
    });

    it("does not move when flee tile occupied and no safe side direction", () => {
      setupTask("attacking");
      // Hauler at (26, 25), bank at (25, 25). Flee direction = RIGHT → (27, 25).
      // Place haulers on (27,25), (27,24), (27,26) — the intended tile + two side tiles.
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 26, y: 25 });
      const blockerCenter = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-center",
        roomName: TARGET_ROOM,
        x: 27,
        y: 25,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:1` } as Partial<CreepMemory>,
      });
      const blockerTop = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-top",
        roomName: TARGET_ROOM,
        x: 27,
        y: 24,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:2` } as Partial<CreepMemory>,
      });
      const blockerBottom = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-bottom",
        roomName: TARGET_ROOM,
        x: 27,
        y: 26,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:3` } as Partial<CreepMemory>,
      });

      registerCreepsInRoom([hauler, blockerCenter, blockerTop, blockerBottom], TARGET_ROOM);

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      expect(hauler.move).not.toHaveBeenCalled();
    });
  });
});
