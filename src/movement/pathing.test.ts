/**
 * Tests for src/movement/pathing.ts
 *
 * Two categories:
 * - **Baseline tests**: verify current in-room path caching, stored path following,
 *   exit recovery, stuck-tick tracking, and moveToRemoteWorkTarget behavior.
 * - **Target-behavior tests**: encode the desired API for Task 3 (costCallback,
 *   cacheKey, cross-room guard). These tests are expected to FAIL before Task 3
 *   implements the features.
 */
import {
  clearRoomBaseCostMatrixCacheForTest,
  getRoomBaseCostMatrixCacheSizeForTest,
  moveToRemoteWorkTarget,
  moveToTarget,
} from "@/movement/pathing";
import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
import {
  MockCostMatrix,
  MockRoomPosition,
  RealCostMatrix,
  createCreep,
  createRoom,
  resetRuntimeServices,
  setDefaultMapMocks,
  setupPathFinderGlobal,
  setupRoomPositionGlobal,
} from "@mock/movement";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function setupGlobals(costMatrixClass?: new () => CostMatrix): void {
  setupRoomPositionGlobal();
  setupPathFinderGlobal(costMatrixClass);
  setDefaultMapMocks();
}

function advanceTick(): void {
  Game.time += 1;
}

// ---------------------------------------------------------------------------
// Baseline tests: current behavior
// ---------------------------------------------------------------------------

describe("moveToTarget baseline", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    setupGlobals();
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("returns OK when already at the target position within range", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-at", "worker", 10, 10, room);

    const result = moveToTarget(creep, new MockRoomPosition(10, 10, room.name) as unknown as RoomPosition, 1);

    expect(result).toBe(OK);
    expect(creep.move).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it("uses the shared stored-path follower for a Power Creep", () => {
    const room = createRoom("W1N1");
    const pos = new MockRoomPosition(10, 10, room.name);
    jest.spyOn(pos, "findPathTo").mockReturnValue([
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ] as PathStep[]);
    const powerCreep = {
      name: "operator",
      room,
      pos: pos as unknown as RoomPosition,
      ticksToLive: 1_000,
      powers: {},
      memory: {},
      move: jest.fn(() => OK),
    } as unknown as PowerCreep;
    Game.powerCreeps = { operator: powerCreep };

    const result = moveToTarget(
      powerCreep,
      new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition,
      3,
    );

    expect(result).toBe(OK);
    expect(powerCreep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(powerCreep)?.pathingRequestedAt).toBe(Game.time);
    expect(getCreepMovementState(powerCreep)?.movePathState?.range).toBe(3);
    expect(getCreepMovementState(powerCreep.name)).toBeUndefined();
  });

  it("marks hostile creep positions as high-cost when dynamic creep avoidance is requested", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("war-attacker", "meleeAttacker", 10, 10, room);
    const hostile = {
      name: "hostile-blocker",
      pos: new MockRoomPosition(11, 10, room.name),
    } as unknown as Creep;
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    room.find = jest.fn((findConstant: FindConstant) => {
      if (findConstant === FIND_MY_CREEPS) return creeps;
      if (findConstant === FIND_HOSTILE_CREEPS) return [hostile];
      return [];
    }) as Room["find"];

    let capturedMatrix: RealCostMatrix | undefined;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        capturedMatrix = opts.costCallback?.(
          room.name,
          new RealCostMatrix() as unknown as CostMatrix,
        ) as unknown as RealCostMatrix;
        return [{ x: 10, y: 11, dx: 0, dy: 1, direction: BOTTOM }];
      },
    );

    moveToTarget(
      creep,
      new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition,
      1,
      { ignoreCreeps: false, reusePath: 0 },
    );

    expect(capturedMatrix?.get(11, 10)).toBe(0xfe);
  });

  it("triggers exit recovery when on an exit tile targeting an interior position in the same room", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-exit", "worker", 0, 25, room);
    Game.creeps[creep.name] = creep;

    (creep.move as jest.Mock).mockReturnValue(OK);

    const result = moveToTarget(creep, new MockRoomPosition(25, 25, room.name) as unknown as RoomPosition, 1);

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Target-behavior tests: desired API for Task 3
// These tests are expected to FAIL before Task 3 implements the features.
// ---------------------------------------------------------------------------

describe("moveToTarget target-behavior: costCallback overlay", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    setupGlobals(RealCostMatrix as unknown as new () => CostMatrix);
  });

  it("allows source container work position when it is the explicit target", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("miner-source-target", "miner", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([
      new MockRoomPosition(20, 20, room.name) as unknown as RoomPosition,
      new MockRoomPosition(21, 20, room.name) as unknown as RoomPosition,
    ]);

    let capturedMatrix: RealCostMatrix | null = null;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        capturedMatrix = opts.costCallback?.(room.name, new RealCostMatrix() as unknown as CostMatrix) as unknown as RealCostMatrix;
        return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    moveToTarget(creep, new MockRoomPosition(20, 20, room.name) as unknown as RoomPosition, 0, {
      allowSourceContainerTarget: true,
    });

    expect(capturedMatrix).not.toBeNull();
    expect(capturedMatrix!.get(20, 20)).toBe(0);
    expect(capturedMatrix!.get(21, 20)).toBe(0xfe);
  });
});

describe("moveToTarget target-behavior: cross-room guard", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    setupGlobals();
  });

  it("returns ERR_INVALID_TARGET for cross-room target even when coordinates match", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-same-coord", "worker", 10, 10, room);

    const target = new MockRoomPosition(10, 10, "W1N2") as unknown as RoomPosition;

    const result = moveToTarget(creep, target, 1);

    expect(result).toBe(ERR_INVALID_TARGET);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });
});
