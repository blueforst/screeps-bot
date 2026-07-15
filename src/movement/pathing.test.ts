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

  it("returns OK when within the requested range", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-range", "worker", 10, 10, room);

    const result = moveToTarget(creep, new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition, 3);

    expect(result).toBe(OK);
  });

  it("does not move again on the same tick after movementPushedAt is set", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-pushed", "worker", 10, 10, room);
    ensureCreepMovementState(creep.name).movementPushedAt = Game.time;

    const result = moveToTarget(creep, new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition, 1);

    expect(result).toBe(OK);
    expect(creep.move).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it("returns ERR_INVALID_TARGET for cross-room targets", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-cross", "worker", 10, 10, room);

    const target = new MockRoomPosition(25, 25, "W1N2") as unknown as RoomPosition;
    const result = moveToTarget(creep, target, 1);

    expect(result).toBe(ERR_INVALID_TARGET);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it("deletes movePathState when target is in a different room", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-del-state", "worker", 10, 10, room);
    ensureCreepMovementState(creep.name).movePathState = {
      key: "W1N1:W1N1:20:10:r1:i1:sd:pd:md:e0:sc0:c",
      path: "333",
      steps: [{ x: 11, y: 10 }, { x: 12, y: 10 }],
      targetRoom: "W1N1",
      targetX: 20,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 20,
    };

    moveToTarget(creep, new MockRoomPosition(25, 25, "W1N2") as unknown as RoomPosition, 1);

    expect(getCreepMovementState(creep.name)?.movePathState).toBeUndefined();
  });

  it("computes and follows a new path for same-room targets", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-new-path", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(creep, new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition, 1);

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(creep.moveTo).not.toHaveBeenCalled();
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

  it("reuses a cached path on subsequent calls in the same room", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-cache", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    const findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 13, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = findPathTo;

    const result1 = moveToTarget(creep, new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition, 1);
    expect(result1).toBe(OK);
    expect(findPathTo).toHaveBeenCalledTimes(1);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);

    advanceTick();
    (creep.pos as unknown as RoomPosition).x = 11;

    const result2 = moveToTarget(creep, new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition, 1);
    expect(result2).toBe(OK);
    expect(findPathTo).toHaveBeenCalledTimes(1);
    expect(creep.move).toHaveBeenLastCalledWith(RIGHT);

    const state = getCreepMovementState(creep.name);
    expect(state?.movePathState).toBeDefined();
    expect(state?.movePathState?.stuckTicks).toBe(0);
  });

  it("increments stuckTicks when creep stays at the same position", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-stuck", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    const findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = findPathTo;

    moveToTarget(creep, new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition, 1);

    advanceTick();

    moveToTarget(creep, new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition, 1);

    const state = getCreepMovementState(creep.name);
    expect(state?.movePathState?.stuckTicks).toBe(1);
  });

  it("repaths when cached path expires", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-expire", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    const findPathTo = jest
      .fn()
      .mockReturnValueOnce([
        { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
      ])
      .mockReturnValueOnce([
        { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
      ]);
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = findPathTo;

    moveToTarget(creep, new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition, 1);

    // Advance well past MOVE_PATH_CACHE_TTL (20 ticks)
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();
    advanceTick();

    moveToTarget(creep, new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition, 1);

    expect(findPathTo).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached path when reusePath is zero", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-no-reuse", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    const findPathTo = jest
      .fn()
      .mockReturnValueOnce([{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }])
      .mockReturnValueOnce([{ x: 10, y: 11, dx: 0, dy: 1, direction: BOTTOM }]);
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = findPathTo;

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;

    const result1 = moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(result1).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);

    advanceTick();
    (creep.pos as unknown as RoomPosition).x = 10;
    (creep.pos as unknown as RoomPosition).y = 10;

    const result2 = moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(result2).toBe(OK);
    expect(findPathTo).toHaveBeenCalledTimes(2);
    expect(creep.move).toHaveBeenLastCalledWith(BOTTOM);
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

  it("applies exit tile avoidance when avoidExitTiles is true", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-avoid-exit", "worker", 25, 25, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let capturedCost = -1;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        const matrix = opts.costCallback?.(room.name, new MockCostMatrix() as unknown as CostMatrix) as unknown as MockCostMatrix;
        capturedCost = matrix.get(49, 25);
        return [{ x: 26, y: 25, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    moveToTarget(creep, new MockRoomPosition(30, 25, room.name) as unknown as RoomPosition, 1, { avoidExitTiles: true });

    expect(capturedCost).toBe(0xff);
  });

  it("does not block the target position when it is an exit tile and avoidExitTiles is true", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-target-exit", "worker", 25, 25, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let targetExitCost = -1;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        const matrix = opts.costCallback?.(room.name, new MockCostMatrix() as unknown as CostMatrix) as unknown as MockCostMatrix;
        targetExitCost = matrix.get(49, 25);
        return [{ x: 26, y: 25, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    moveToTarget(creep, new MockRoomPosition(49, 25, room.name) as unknown as RoomPosition, 1, { avoidExitTiles: true });

    expect(targetExitCost).toBe(0);
  });
});

describe("moveToRemoteWorkTarget", () => {
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

  it("returns OK and sets workAnchor when within range 3", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-anchor", "worker", 10, 10, room);
    Game.creeps[creep.name] = creep;

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;
    const result = moveToRemoteWorkTarget(creep, target);

    expect(result).toBe(OK);
    const state = getCreepMovementState(creep.name);
    expect(state?.workAnchor).toEqual({ x: 12, y: 10, roomName: room.name, range: 3 });
  });

  it("deletes workAnchor and delegates to moveToTarget when out of range", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-far", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    ensureCreepMovementState(creep.name).workAnchor = { x: 5, y: 5, roomName: room.name, range: 3 };

    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(25, 10, room.name) as unknown as RoomPosition;
    const result = moveToRemoteWorkTarget(creep, target);

    expect(result).toBe(OK);
    const state = getCreepMovementState(creep.name);
    expect(state?.workAnchor).toBeUndefined();
    expect(creep.move).toHaveBeenCalled();
  });

  it("uses range 3 for pathing to remote work targets", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-range3", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    const findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = findPathTo;

    const target = new MockRoomPosition(25, 10, room.name) as unknown as RoomPosition;
    moveToRemoteWorkTarget(creep, target);

    expect(findPathTo).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ range: 3 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Baseline: room cost matrix cache behavior
// ---------------------------------------------------------------------------

describe("room base cost matrix cache", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    setupGlobals(RealCostMatrix as unknown as new () => CostMatrix);
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("caches room base cost matrix on first call and reuses it", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-cache-1", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let callbackCount = 0;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        callbackCount += 1;
        opts.costCallback?.(room.name, new RealCostMatrix() as unknown as CostMatrix);
        return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    moveToTarget(creep, new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition, 1, { ignoreCreeps: true });
    expect(getRoomBaseCostMatrixCacheSizeForTest()).toBe(1);

    advanceTick();
    moveToTarget(creep, new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition, 1, { ignoreCreeps: true });
    expect(getRoomBaseCostMatrixCacheSizeForTest()).toBe(1);
  });

  it("prunes stale cache entries after TTL expires", () => {
    const room = createRoom("W2N1");
    const creep = createCreep("worker-prune", "worker", 10, 10, room);
    Game.creeps[creep.name] = creep;

    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        opts.costCallback?.(room.name, new RealCostMatrix() as unknown as CostMatrix);
        return [];
      },
    );

    moveToTarget(creep, new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition, 1, { ignoreCreeps: true });
    expect(getRoomBaseCostMatrixCacheSizeForTest()).toBe(1);

    Game.time += 6;

    const room2 = createRoom("W2N2");
    const creep2 = createCreep("worker-prune-2", "worker", 10, 10, room2);
    Game.creeps[creep2.name] = creep2;

    (creep2.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        opts.costCallback?.(room2.name, new RealCostMatrix() as unknown as CostMatrix);
        return [];
      },
    );

    moveToTarget(creep2, new MockRoomPosition(15, 10, room2.name) as unknown as RoomPosition, 1, { ignoreCreeps: true });
    expect(getRoomBaseCostMatrixCacheSizeForTest()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Baseline: stored path following
// ---------------------------------------------------------------------------

describe("stored path following", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    setupGlobals();
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("follows cached path steps in sequence", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-follow", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    ensureCreepMovementState(creep.name).movePathState = {
      key: `W1N1:W1N1:13:10:r1:i1:sd:pd:md:e0:sc0:c`,
      path: "333",
      steps: [{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }],
      targetRoom: "W1N1",
      targetX: 13,
      targetY: 10,
      range: 1,
      lastPosKey: "W1N1:10:10",
      stuckTicks: 0,
      expiresAt: Game.time + 20,
    };

    const result = moveToTarget(creep, new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition, 1);

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
  });

  it("clears movePathState when following returns ERR_NO_PATH", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-no-path", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    ensureCreepMovementState(creep.name).movePathState = {
      key: `W1N1:W1N1:20:20:r1:i1:sd:pd:md:e0:sc0:c`,
      path: "3",
      steps: [{ x: 30, y: 30 }],
      targetRoom: "W1N1",
      targetX: 20,
      targetY: 20,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 20,
    };

    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    moveToTarget(creep, new MockRoomPosition(20, 20, room.name) as unknown as RoomPosition, 1);

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

  it("applies a caller-supplied costCallback overlay on top of the base matrix", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-overlay", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let capturedMatrix: RealCostMatrix | null = null;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        const baseMatrix = new RealCostMatrix() as unknown as CostMatrix;
        capturedMatrix = opts.costCallback?.(room.name, baseMatrix) as unknown as RealCostMatrix;
        return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    const callerCallback = (_roomName: string, matrix: CostMatrix): CostMatrix => {
      matrix.set(20, 20, 0xfe);
      return matrix;
    };

    moveToTarget(creep, new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition, 1, {
      costCallback: callerCallback,
    });

    expect(capturedMatrix).not.toBeNull();
    expect(capturedMatrix!.get(20, 20)).toBe(0xfe);
  });

  it("blocks source container work positions for normal creeps", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-source-avoid", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([
      new MockRoomPosition(20, 20, room.name) as unknown as RoomPosition,
    ]);

    let capturedMatrix: RealCostMatrix | null = null;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        capturedMatrix = opts.costCallback?.(room.name, new RealCostMatrix() as unknown as CostMatrix) as unknown as RealCostMatrix;
        return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    moveToTarget(creep, new MockRoomPosition(20, 20, room.name) as unknown as RoomPosition, 0);

    expect(capturedMatrix).not.toBeNull();
    expect(capturedMatrix!.get(20, 20)).toBe(0xfe);
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

  it("does not reuse cached path when costCallback is provided without cacheKey", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-cb-no-cache", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let findPathCallCount = 0;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => {
      findPathCallCount += 1;
      return [
        { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 13, y: 10, dx: 1, dy: 0, direction: RIGHT },
      ];
    });

    const noopCallback = (_roomName: string, matrix: CostMatrix): CostMatrix => matrix;
    const target = new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition;

    moveToTarget(creep, target, 1, { costCallback: noopCallback });

    advanceTick();
    (creep.pos as unknown as RoomPosition).x = 11;

    moveToTarget(creep, target, 1, { costCallback: noopCallback });

    // Task 3: costCallback without cacheKey must disable path caching, forcing repath each call.
    // Currently costCallback is ignored so the cached path is reused → count is 1.
    expect(findPathCallCount).toBe(2);
  });
});

describe("moveToTarget target-behavior: cacheKey isolation", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    setupGlobals();
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("isolates cached paths by cacheKey when provided", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-isolate", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let findPathCallCount = 0;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => {
      findPathCallCount += 1;
      return [
        { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 13, y: 10, dx: 1, dy: 0, direction: RIGHT },
      ];
    });

    const target = new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition;

    moveToTarget(creep, target, 1, { cacheKey: "A" });

    advanceTick();
    (creep.pos as unknown as RoomPosition).x = 11;

    moveToTarget(creep, target, 1, { cacheKey: "B" });

    // Task 3 must make different cacheKeys use separate path caches, forcing a repath.
    // Currently cacheKey is ignored so the cached path from "A" is reused → count is 1.
    expect(findPathCallCount).toBe(2);
  });

  it("reuses cached path when same cacheKey is used", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("worker-same-key", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    let findPathCallCount = 0;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => {
      findPathCallCount += 1;
      return [
        { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 13, y: 10, dx: 1, dy: 0, direction: RIGHT },
      ];
    });

    const target = new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition;

    moveToTarget(creep, target, 1, { cacheKey: "safeZone:W1N1" });

    advanceTick();
    (creep.pos as unknown as RoomPosition).x = 11;

    moveToTarget(creep, target, 1, { cacheKey: "safeZone:W1N1" });

    expect(findPathCallCount).toBe(1);
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

  it("returns ERR_INVALID_TARGET when target is in a different room", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-cross-guard", "worker", 10, 10, room);

    const target = new MockRoomPosition(25, 25, "W1N2") as unknown as RoomPosition;

    // Task 3: cross-room targets should be rejected; callers must use moveToTargetRoom
    const result = moveToTarget(creep, target, 1);

    // Currently falls through to creep.moveTo; Task 3 should return ERR_INVALID_TARGET
    expect(result).toBe(ERR_INVALID_TARGET);
  });

  it("does not call raw creep.moveTo when cross-room target is supplied", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("worker-no-raw-move", "worker", 10, 10, room);

    const target = new MockRoomPosition(25, 25, "W1N2") as unknown as RoomPosition;

    moveToTarget(creep, target, 1);

    // Task 3 should prevent raw creep.moveTo for cross-room targets
    expect(creep.moveTo).not.toHaveBeenCalled();
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
