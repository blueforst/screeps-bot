import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";
import { isBlockerActivelyMoving, moveToAdjacentPosition } from "@/movement/traffic";

jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
}));

import { getTickContextService } from "@/runtime/runtimeServices";

function setupRoomContext(creeps: Creep[] = []) {
  (getTickContextService as jest.Mock).mockReturnValue({
    getRoomContext: jest.fn(() => ({
      getMyCreeps: jest.fn(() => creeps),
      getStructures: jest.fn(() => []),
      getConstructionSites: jest.fn(() => []),
    })),
  });
}

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => any) => fn(),
}));

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | { pos: RoomPosition }): number {
    const pos = "pos" in target ? target.pos : target;
    return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }

  public getDirectionTo(target: RoomPosition): DirectionConstant {
    const dx = Math.sign(target.x - this.x);
    const dy = Math.sign(target.y - this.y);
    if (dx === 0 && dy === -1) return TOP;
    if (dx === 1 && dy === -1) return TOP_RIGHT;
    if (dx === 1 && dy === 0) return RIGHT;
    if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
    if (dx === 0 && dy === 1) return BOTTOM;
    if (dx === -1 && dy === 1) return BOTTOM_LEFT;
    if (dx === -1 && dy === 0) return LEFT;
    return TOP_LEFT;
  }
}

function makeCreep(name: string, x: number, y: number, roomName = "W1N1") {
  const pos = new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
  return {
    name,
    pos,
    room: { name: roomName } as Room,
    move: jest.fn(() => OK),
    memory: {},
  } as unknown as Creep;
}

describe("isBlockerActivelyMoving", () => {
  beforeEach(() => {
    clearCreepMovementStateForTest();
    Object.assign(Game, {
      map: {
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
      },
    });
  });

  it("returns false when the creep has no movement state", () => {
    const blocker = makeCreep("blocker", 10, 10);
    expect(isBlockerActivelyMoving(blocker)).toBe(false);
  });

  it("returns true when pathingRequestedAt is this tick", () => {
    const blocker = makeCreep("blocker", 10, 10);
    const state = ensureCreepMovementState(blocker.name);
    state.pathingRequestedAt = Game.time;
    expect(isBlockerActivelyMoving(blocker)).toBe(true);
  });

  it("returns false when only non-expired movePathState exists (stale cached path, no current pathing request)", () => {
    const blocker = makeCreep("blocker", 10, 10);
    const state = ensureCreepMovementState(blocker.name);
    state.movePathState = {
      key: "test",
      path: "1",
      steps: [{ x: 10, y: 10 }],
      targetRoom: "W1N1",
      targetX: 15,
      targetY: 15,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 10,
    };
    expect(isBlockerActivelyMoving(blocker)).toBe(false);
  });

  it("returns false when movePathState has expired", () => {
    const blocker = makeCreep("blocker", 10, 10);
    const state = ensureCreepMovementState(blocker.name);
    state.movePathState = {
      key: "test",
      path: "1",
      steps: [{ x: 10, y: 10 }],
      targetRoom: "W1N1",
      targetX: 15,
      targetY: 15,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time - 1,
    };
    expect(isBlockerActivelyMoving(blocker)).toBe(false);
  });

  it("returns true when travelState exists (inter-room traveller)", () => {
    const blocker = makeCreep("blocker", 10, 10);
    const state = ensureCreepMovementState(blocker.name);
    state.travelState = {
      targetRoom: "W1N2",
      stuckTicks: 0,
    };
    expect(isBlockerActivelyMoving(blocker)).toBe(true);
  });

  it("returns false when only stale pathingRequestedAt exists", () => {
    const blocker = makeCreep("blocker", 10, 10);
    const state = ensureCreepMovementState(blocker.name);
    state.pathingRequestedAt = Game.time - 1;
    expect(isBlockerActivelyMoving(blocker)).toBe(false);
  });
});

describe("moveToAdjacentPosition", () => {
  beforeEach(() => {
    clearCreepMovementStateForTest();
    Object.assign(global, { RoomPosition: MockRoomPosition });
    Object.assign(Game, {
      map: {
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
      },
    });
  });

  it("pushes a blocker with stale movePathState when pathingRequestedAt is not current", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const state = ensureCreepMovementState(blocker.name);
    state.movePathState = {
      key: "test",
      path: "2",
      steps: [{ x: 12, y: 10 }],
      targetRoom: "W1N1",
      targetX: 20,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 10,
    };

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalled();
    expect(state.movePathState).toBeUndefined();
  });

  it("does not push a blocker with current-tick pathingRequestedAt", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const state = ensureCreepMovementState(blocker.name);
    state.pathingRequestedAt = Game.time;

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(OK);
    expect(blocker.move).not.toHaveBeenCalled();
  });

  it("does not push a blocker with active travelState", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const state = ensureCreepMovementState(blocker.name);
    state.travelState = {
      targetRoom: "W2N1",
      stuckTicks: 0,
    };

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(OK);
    expect(blocker.move).not.toHaveBeenCalled();
  });

  it("pushes a stationary blocker without movement state", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalled();
  });

  it("preserves blocker movePathState when push fails with ERR_TIRED", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const blockerState = ensureCreepMovementState(blocker.name);
    blockerState.movePathState = {
      key: "test",
      path: "2",
      steps: [{ x: 12, y: 10 }],
      targetRoom: "W1N1",
      targetX: 20,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 10,
    };

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
    expect(blockerState.movePathState).toBeDefined();
  });

  it("returns ERR_BUSY when stationary blocker returns ERR_TIRED on push attempt", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
  });
});
