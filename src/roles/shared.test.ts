import {
  clearMovementAnalyticsForTest,
  clearRoomBaseCostMatrixCacheForTest,
  clearMovementState,
  getMovementAnalyticsForTest,
  getRoomBaseCostMatrixCacheSizeForTest,
  moveToTargetRoom,
  moveToTarget,
} from "@/roles/shared";
import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  Room?: {
    serializePath(path: Array<{ direction: DirectionConstant }>): string;
  };
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  getRangeTo(target: RoomPosition | { x: number; y: number } | number, y?: number): number {
    if (typeof target === "number") {
      return Math.max(Math.abs(this.x - target), Math.abs(this.y - (y ?? this.y)));
    }

    return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y));
  }

  getDirectionTo(target: RoomPosition | { x: number; y: number }): DirectionConstant {
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

  findPathTo(): PathStep[] {
    return [];
  }
}

class MockCostMatrix {
  private readonly values = new Map<string, number>();

  set(x: number, y: number, value: number): void {
    this.values.set(`${x}:${y}`, value);
  }

  get(x: number, y: number): number {
    return this.values.get(`${x}:${y}`) ?? 0;
  }

  clone(): MockCostMatrix {
    const clone = new MockCostMatrix();
    for (const [key, value] of this.values.entries()) {
      clone.values.set(key, value);
    }
    return clone;
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name = "W1N1", creeps: Creep[] = []): Room {
  const structures: Structure<StructureConstant>[] = [];
  const constructionSites: ConstructionSite[] = [];

  const room = {
    name,
    controller: { my: true } as StructureController,
    find: jest.fn((findConstant: number) => {
      switch (findConstant) {
        case FIND_STRUCTURES:
          return structures;
        case FIND_MY_STRUCTURES:
          return structures;
        case FIND_MY_CREEPS:
          return creeps;
        case FIND_CONSTRUCTION_SITES:
          return constructionSites;
        default:
          return [];
      }
    }),
  } as unknown as Room;

  Game.rooms[name] = room;
  return room;
}

function setDefaultMapMocks(): void {
  Game.map = {
    getRoomTerrain: () => ({
      get: () => 0,
    }),
    describeExits: jest.fn(() => null),
    findRoute: jest.fn(() => ERR_NO_PATH),
    getRoomLinearDistance: jest.fn(() => 1),
    getRoomStatus: jest.fn(() => ({ status: "normal" })),
  } as unknown as GameMap;
}

function createCreep(name: string, role: CreepMemory["role"], x: number, y: number, room: Room): Creep {
  const pos = new MockRoomPosition(x, y, room.name) as unknown as RoomPosition;
  return {
    name,
    room,
    pos,
    fatigue: 0,
    memory: { role },
    move: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
    findClosestByPath: jest.fn(),
    findClosestByRange: jest.fn(),
  } as unknown as Creep;
}

describe("moveToTarget yielding", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    setDefaultMapMocks();
    (global as RuntimeGlobal).Room = {
      serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
    };
    Object.assign(global, {
      PathFinder: {
        search: jest.fn(() => ({ path: [], incomplete: true, ops: 0, cost: 0 })),
        CostMatrix: MockCostMatrix,
      },
    });
    (global as typeof global & { RoomPosition: typeof MockRoomPosition }).RoomPosition = MockRoomPosition;
  });

  it("pushes a lower-priority blocker aside and moves into the freed tile", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const pusher = createCreep("worker-1", "worker", 10, 10, room);
    const blocker = createCreep("scout-1", "scout", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;

    const result = moveToTarget(pusher, { pos: target });

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalled();
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(blocker.name)?.movementPushedAt).toBe(Game.time);
  });

  it("does not push a blocker with an unexpired movePathState", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5A", creeps);
    const pusher = createCreep("worker-stale-push", "worker", 10, 10, room);
    const blocker = createCreep("carrier-stale-block", "carrier", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    ensureCreepMovementState(blocker.name).movePathState = {
      key: `${room.name}:${room.name}:13:10:r1:i1:sd:pd:md:e0:sc0:c`,
      path: "33",
      steps: [
        { x: 11, y: 10 },
        { x: 12, y: 10 },
        { x: 13, y: 10 },
      ],
      targetRoom: room.name,
      targetX: 13,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 5,
    };

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(blocker.move).not.toHaveBeenCalled();
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(blocker.name)?.movementPushedAt).toBeUndefined();
  });

  it("does not push a blocker that already requested pathing this tick", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5B", creeps);
    const pusher = createCreep("worker-active-push", "worker", 10, 10, room);
    const blocker = createCreep("carrier-active-block", "carrier", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;
    ensureCreepMovementState(blocker.name).pathingRequestedAt = Game.time;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(blocker.move).not.toHaveBeenCalled();
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
  });

  it("preserves blocker movePathState when push fails with ERR_TIRED", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5C", creeps);
    const pusher = createCreep("worker-tired-push", "worker", 10, 10, room);
    const blocker = createCreep("carrier-tired-block", "carrier", 11, 10, room);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    ensureCreepMovementState(blocker.name).movePathState = {
      key: `${room.name}:${room.name}:13:10:r1:i1:sd:pd:md:e0:sc0:c`,
      path: "2",
      steps: [
        { x: 11, y: 10 },
        { x: 12, y: 10 },
      ],
      targetRoom: room.name,
      targetX: 13,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time - 1,
    };

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
    expect(getCreepMovementState(blocker.name)?.movePathState).toBeDefined();
    expect(getCreepMovementState(blocker.name)?.movementPushedAt).toBeUndefined();
  });

  it("returns ERR_BUSY when a stationary blocker returns ERR_TIRED on push", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5D", creeps);
    const pusher = createCreep("worker-tired-push2", "worker", 10, 10, room);
    const blocker = createCreep("carrier-tired-block2", "carrier", 11, 10, room);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
    expect(getCreepMovementState(blocker.name)?.movementPushedAt).toBeUndefined();
  });

  it("continues forward on a cached path instead of stepping back to the previous tile", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N2C", creeps);
    const creep = createCreep("worker-forward", "worker", 11, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    ensureCreepMovementState(creep.name).movePathState = {
      key: `${room.name}:${room.name}:13:10:r1:i1:sd:pd:md:e0:sc0:c`,
      path: "333",
      steps: [
        { x: 11, y: 10 },
        { x: 12, y: 10 },
        { x: 13, y: 10 },
      ],
      targetRoom: room.name,
      targetX: 13,
      targetY: 10,
      range: 1,
      lastPosKey: `${room.name}:10:10`,
      stuckTicks: 0,
      expiresAt: Game.time + 5,
    };

    const result = moveToTarget(creep, { pos: new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
  });

  it("drops a legacy cached path state without steps and repaths safely", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N2A", creeps);
    const creep = createCreep("worker-legacy", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    ensureCreepMovementState(creep.name).movePathState = {
      key: `${room.name}:${room.name}:12:10:r1:i0:sd:pd:md`,
      path: "33",
      targetRoom: room.name,
      targetX: 12,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 5,
    } as unknown as import("@/movement/types").MovePathState;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(creep, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect((getCreepMovementState(creep.name)?.movePathState?.steps || [])[0]).toEqual({ x: 11, y: 10 });
  });

  it("does not move again on the same tick after being pushed", () => {
    const room = createRoom("W1N3");
    const creep = createCreep("carrier-2", "carrier", 10, 10, room);
    ensureCreepMovementState(creep.name).movementPushedAt = Game.time;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;
    const result = moveToTarget(creep, { pos: target });

    expect(result).toBe(OK);
    expect(creep.move).not.toHaveBeenCalled();
    expect((creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo).not.toHaveBeenCalled();
  });

  it("with ignoreCreeps enabled, paths through a blocker and resolves the conflict via yield", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5D", creeps);
    const pusher = createCreep("worker-ignore-1", "worker", 10, 10, room);
    const blocker = createCreep("scout-ignore-1", "scout", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    let blockerTileCost = -1;
    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((_target, opts: { costCallback?: Function }) => {
      const matrix = opts.costCallback?.(room.name, new MockCostMatrix() as unknown as CostMatrix) as unknown as MockCostMatrix;
      blockerTileCost = matrix.get(11, 10);
      return [
        { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
        { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
      ];
    });

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition }, 1, {
      ignoreCreeps: true,
    });

    expect(result).toBe(OK);
    expect(blockerTileCost).toBe(0);
    expect(blocker.move).toHaveBeenCalled();
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
  });

  it("reuses cached static room matrices without leaking creep overlays", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N4", creeps);
    const pusher = createCreep("worker-4", "worker", 10, 10, room);
    const blocker = createCreep("scout-4", "scout", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    let callbackCount = 0;
    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((_target, opts: { costCallback?: Function }) => {
      callbackCount += 1;
      const matrix = opts.costCallback?.(room.name, new MockCostMatrix() as unknown as CostMatrix) as unknown as MockCostMatrix;
      expect(matrix).toBeDefined();
      if (callbackCount === 1) {
        expect(matrix.get(11, 10)).toBe(0xfe);
      } else {
        expect(matrix.get(11, 10)).toBe(0);
      }
      return [];
    });

    const targetA = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;
    const targetB = new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition;

    moveToTarget(pusher, { pos: targetA }, 1, { ignoreCreeps: false });
    moveToTarget(pusher, { pos: targetB }, 1, { ignoreCreeps: true });

    expect(callbackCount).toBe(2);
  });

  it("prunes stale room matrix cache entries when writing a new one", () => {
    const oldRoom = createRoom("W2N1");
    const oldCreep = createCreep("worker-old", "worker", 10, 10, oldRoom);
    Game.creeps[oldCreep.name] = oldCreep;
    (oldCreep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((_target, opts: { costCallback?: Function }) => {
      opts.costCallback?.(oldRoom.name, new MockCostMatrix() as unknown as CostMatrix);
      return [];
    });
    moveToTarget(oldCreep, { pos: new MockRoomPosition(12, 10, oldRoom.name) as unknown as RoomPosition }, 1, {
      ignoreCreeps: true,
    });

    const sizeAfterOldEntry = getRoomBaseCostMatrixCacheSizeForTest();
    expect(sizeAfterOldEntry).toBe(1);

    Game.time += 10;

    const freshRoom = createRoom("W2N2");
    const freshCreep = createCreep("worker-fresh", "worker", 10, 10, freshRoom);
    Game.creeps[freshCreep.name] = freshCreep;
    (freshCreep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((_target, opts: { costCallback?: Function }) => {
      opts.costCallback?.(freshRoom.name, new MockCostMatrix() as unknown as CostMatrix);
      return [];
    });

    moveToTarget(freshCreep, { pos: new MockRoomPosition(12, 10, freshRoom.name) as unknown as RoomPosition }, 1, {
      ignoreCreeps: true,
    });

    expect(getRoomBaseCostMatrixCacheSizeForTest()).toBe(1);
  });

  it("caps room matrix cache size by evicting the oldest entries", () => {
    for (let index = 0; index < 105; index += 1) {
      const room = createRoom(`W3N${index}`);
      const creep = createCreep(`worker-${index}`, "worker", 10, 10, room);
      Game.creeps[creep.name] = creep;
      (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((_target, opts: { costCallback?: Function }) => {
        opts.costCallback?.(room.name, new MockCostMatrix() as unknown as CostMatrix);
        return [];
      });

      moveToTarget(creep, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition }, 1, {
        ignoreCreeps: true,
        plainCost: 1 + (index % 2),
      });
      Game.time += 1;
    }

    expect(getRoomBaseCostMatrixCacheSizeForTest()).toBeLessThanOrEqual(100);
  });

  it("does not reuse cached room paths when reusePath is zero", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W4N1", creeps);
    const creep = createCreep("worker-no-reuse", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;

    const findPathTo = jest
      .fn()
      .mockReturnValueOnce([{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }])
      .mockReturnValueOnce([{ x: 10, y: 11, dx: 0, dy: 1, direction: BOTTOM }]);
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = findPathTo;

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;

    const firstResult = moveToTarget(creep, { pos: target }, 1, { reusePath: 0 });

    expect(firstResult).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);

    Game.time += 1;
    (creep.pos as unknown as RoomPosition).x = 10;
    (creep.pos as unknown as RoomPosition).y = 10;

    const secondResult = moveToTarget(creep, { pos: target }, 1, { reusePath: 0 });

    expect(secondResult).toBe(OK);
    expect(findPathTo).toHaveBeenCalledTimes(2);
    expect(creep.move).toHaveBeenLastCalledWith(BOTTOM);
  });

  it("blocks non-target exit tiles when requested", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W4N2", creeps);
    const creep = createCreep("scout-avoid-exits", "scout", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    let topExitCost = -1;
    let targetExitCost = -1;

    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((_target, opts: { costCallback?: Function }) => {
      const matrix = opts.costCallback?.(room.name, new MockCostMatrix() as unknown as CostMatrix) as unknown as MockCostMatrix;
      topExitCost = matrix.get(20, 0);
      targetExitCost = matrix.get(0, 16);
      return [{ x: 9, y: 10, dx: -1, dy: 0, direction: LEFT }];
    });

    moveToTarget(creep, new MockRoomPosition(0, 16, room.name) as unknown as RoomPosition, 0, {
      avoidExitTiles: true,
    });

    expect(topExitCost).toBe(0xff);
    expect(targetExitCost).toBe(0);
  });

  it("hauler pair: blocker yields laterally instead of swapping onto pusher tile", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N6A", creeps);
    const pusher = createCreep("hauler-a", "powerBankHauler", 10, 10, room);
    const blocker = createCreep("hauler-b", "powerBankHauler", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;
    const result = moveToTarget(pusher, { pos: target });

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalled();
    const moveDir = (blocker.move as jest.Mock).mock.calls[0][0] as DirectionConstant;
    expect(moveDir).not.toBe(LEFT);
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
  });

  it("hauler pair: no swap when only pusher tile is available", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N6B", creeps);
    const pusher = createCreep("hauler-c", "powerBankHauler", 25, 25, room);
    const blocker = createCreep("hauler-d", "powerBankHauler", 26, 25, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    // All 8 tiles around blocker (26,25) are walls EXCEPT pusher tile (25,25)
    const wallCoords = new Set([
      "26:24", "27:24", "27:25", "27:26", "26:26", "25:26", "25:24",
    ]);
    const originalGetRoomTerrain = Game.map.getRoomTerrain;
    Game.map.getRoomTerrain = (_roomName: string) => ({
      get: (x: number, y: number) => {
        if (wallCoords.has(`${x}:${y}`)) return TERRAIN_MASK_WALL;
        return 0;
      },
    });

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 26, y: 25, dx: 1, dy: 0, direction: RIGHT },
      { x: 27, y: 25, dx: 1, dy: 0, direction: RIGHT },
    ]);

    try {
      const target = new MockRoomPosition(27, 25, room.name) as unknown as RoomPosition;
      const result = moveToTarget(pusher, { pos: target });

      expect(blocker.move).not.toHaveBeenCalled();
      expect(pusher.move).not.toHaveBeenCalled();
      expect(result).toBe(ERR_BUSY);
    } finally {
      Game.map.getRoomTerrain = originalGetRoomTerrain;
    }
  });

  it("non-hauler pusher still swaps with hauler blocker normally", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N6C", creeps);
    const pusher = createCreep("worker-push", "worker", 10, 10, room);
    const blocker = createCreep("hauler-block", "powerBankHauler", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;
    const result = moveToTarget(pusher, { pos: target });

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalledWith(LEFT);
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
  });
});

describe("moveToTargetRoom", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    setDefaultMapMocks();
    (global as RuntimeGlobal).Room = {
      serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
    };
    Object.assign(global, {
      PathFinder: {
        search: jest.fn(() => ({ path: [], incomplete: true, ops: 0, cost: 0 })),
        CostMatrix: MockCostMatrix,
      },
    });
    (global as typeof global & { RoomPosition: typeof MockRoomPosition }).RoomPosition = MockRoomPosition;
  });

  it("returns ok immediately when already in the target room", () => {
    const room = createRoom("W9N9");
    const creep = createCreep("scout-same", "scout", 10, 10, room);
    ensureCreepMovementState(creep.name).travelState = { targetRoom: "W8N8", stuckTicks: 3 };

    const result = moveToTargetRoom(creep, room.name);

    expect(result).toBe(OK);
    expect(getCreepMovementState(creep.name)?.travelState).toBeUndefined();
  });

  it("follows the next ordered room from a fixed route", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("scout-route", "scout", 10, 10, room);
    creeps.push(creep);
    room.findExitTo = jest.fn((nextRoom: string) => (nextRoom === "W2N1" ? TOP : RIGHT) as ExitConstant);
    room.find = jest.fn((findConstant: number) => {
      if (findConstant === RIGHT) {
        return [new MockRoomPosition(49, 10, room.name)];
      }
      if (findConstant === FIND_MY_CREEPS) {
        return creeps;
      }
      return [];
    });
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);
    (creep.pos as unknown as { findClosestByPath: jest.Mock }).findClosestByPath = jest.fn(
      () => new MockRoomPosition(49, 10, room.name),
    );
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => {
      if (roomName === "W1N1") {
        return { [RIGHT]: "W1N2" };
      }
      return null;
    });

    const result = moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { reusePath: 4 });

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(creep.name)?.travelState?.targetRoom).toBe("W1N3");
  });

  it("falls back to dynamic routing when fixed-route progression fails", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W2N1", creeps);
    const creep = createCreep("claimer-fallback", "claimer", 10, 10, room);
    creeps.push(creep);
    room.findExitTo = jest.fn(() => RIGHT as ExitConstant);
    room.find = jest.fn((findConstant: number) => {
      if (findConstant === RIGHT) {
        return [new MockRoomPosition(49, 10, room.name)];
      }
      if (findConstant === FIND_MY_CREEPS) {
        return creeps;
      }
      return [];
    });
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);
    (creep.pos as unknown as { findClosestByPath: jest.Mock }).findClosestByPath = jest.fn(
      () => new MockRoomPosition(49, 10, room.name),
    );
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => {
      if (roomName === "W2N1") {
        return { [RIGHT]: "W2N2" };
      }
      return null;
    });
    (Game.map.findRoute as jest.Mock).mockImplementation((fromRoom: string, toRoom: string) => {
      if (fromRoom === "W2N1" && toRoom === "W2N3") {
        return [{ exit: RIGHT, room: "W2N2" }];
      }
      return ERR_NO_PATH;
    });

    const result = moveToTargetRoom(creep, "W2N3", "W9N9|W9N8|W9N7");

    expect(result).toBe(OK);
    expect(Game.map.findRoute).toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
  });

  it("replans dynamically after travel gets stuck", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W3N1", creeps);
    const creep = createCreep("worker-stuck", "worker", 10, 10, room);
    creeps.push(creep);
    room.findExitTo = jest.fn(() => RIGHT as ExitConstant);
    room.find = jest.fn((findConstant: number) => {
      if (findConstant === RIGHT) {
        return [new MockRoomPosition(49, 10, room.name)];
      }
      if (findConstant === FIND_MY_CREEPS) {
        return creeps;
      }
      return [];
    });
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 10, y: 9, dx: 0, dy: -1, direction: TOP },
    ]);
    (creep.pos as unknown as { findClosestByPath: jest.Mock }).findClosestByPath = jest.fn(
      () => new MockRoomPosition(49, 10, room.name),
    );
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => {
      if (roomName === "W3N1") {
        return { [RIGHT]: "W3N2", [TOP]: "W2N1" };
      }
      return null;
    });
    (Game.map.findRoute as jest.Mock).mockImplementation((fromRoom: string, toRoom: string) => {
      if (fromRoom === "W3N1" && toRoom === "W3N3") {
        return [{ exit: TOP, room: "W2N1" }];
      }
      return ERR_NO_PATH;
    });

    ensureCreepMovementState(creep.name).travelState = {
      targetRoom: "W3N3",
      stuckTicks: 1,
      lastPosKey: "W3N1:10:10",
    };

    const result = moveToTargetRoom(creep, "W3N3", "W3N1|W3N2|W3N3");

    expect(result).toBe(OK);
    expect(Game.map.findRoute).toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(TOP);
    expect(getCreepMovementState(creep.name)?.travelState?.stuckTicks).toBe(2);
  });
});

describe("clearMovementState", () => {
  beforeEach(() => {
    clearMovementAnalyticsForTest();
  });

  it("clears cached path, travel, and pushed flags together", () => {
    const room = createRoom("W8N8");
    const creep = createCreep("carrier-clear", "carrier", 10, 10, room);
      ensureCreepMovementState(creep.name).movePathState = {
      key: "path",
      path: "3",
      steps: [{ x: 11, y: 10 }],
      targetRoom: room.name,
      targetX: 11,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 1,
    };
    ensureCreepMovementState(creep.name).travelState = { targetRoom: "W8N9", stuckTicks: 1 };
    ensureCreepMovementState(creep.name).movementPushedAt = Game.time;
    creep.memory._move = { dest: { x: 12, y: 10, room: room.name }, path: "33", time: Game.time };

    clearMovementState(creep);

    expect(getCreepMovementState(creep.name)?.movePathState).toBeUndefined();
    expect(getCreepMovementState(creep.name)?.travelState).toBeUndefined();
    expect(getCreepMovementState(creep.name)?.movementPushedAt).toBeUndefined();
    expect(creep.memory._move).toBeUndefined();
  });

  it("records state clear metrics", () => {
    const room = createRoom("W8N9");
    const creep = createCreep("carrier-clear-metric", "carrier", 10, 10, room);

    clearMovementState(creep);

    const movement = getMovementAnalyticsForTest();
    expect(movement.totals.stateClears).toBe(1);
    expect(movement.rooms[room.name]?.stateClears).toBe(1);
  });
});

describe("movement analytics", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    setDefaultMapMocks();
    (global as RuntimeGlobal).Room = {
      serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
    };
    (global as typeof global & { RoomPosition: typeof MockRoomPosition }).RoomPosition = MockRoomPosition;
  });

  it("records same-room pathing and yield metrics", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W7N7", creeps);
    const pusher = createCreep("worker-metric", "worker", 10, 10, room);
    const blocker = createCreep("scout-metric", "scout", 11, 10, room);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;
    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    const movement = getMovementAnalyticsForTest();
    expect(movement.totals.pathRequests).toBe(1);
    expect(movement.totals.pathRepaths).toBe(1);
    expect(movement.totals.yieldPushes).toBe(1);
    expect(movement.rooms[room.name]?.yieldPushes).toBe(1);
  });

  it("records travel fallback and travel repath metrics", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W6N1", creeps);
    const creep = createCreep("travel-metric", "worker", 10, 10, room);
    creeps.push(creep);
    room.findExitTo = jest.fn((nextRoom: string) => (nextRoom === "W5N1" ? TOP : RIGHT) as ExitConstant);
    room.find = jest.fn((findConstant: number) => {
      if (findConstant === RIGHT) {
        return [new MockRoomPosition(49, 10, room.name)];
      }
      if (findConstant === TOP) {
        return [new MockRoomPosition(10, 0, room.name)];
      }
      if (findConstant === FIND_MY_CREEPS) {
        return creeps;
      }
      return [];
    });
    (creep.pos as unknown as { findClosestByPath: jest.Mock }).findClosestByPath = jest.fn((dir: number) =>
      dir === TOP ? new MockRoomPosition(10, 0, room.name) : new MockRoomPosition(49, 10, room.name),
    );
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn((target: RoomPosition) => {
      if (target.x === 10 && target.y === 0) {
        return [{ x: 10, y: 9, dx: 0, dy: -1, direction: TOP }];
      }
      return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
    });
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => {
      if (roomName === room.name) {
        return { [RIGHT]: "W6N2", [TOP]: "W5N1" };
      }
      return null;
    });
    (Game.map.findRoute as jest.Mock)
      .mockImplementationOnce(() => ERR_NO_PATH)
      .mockImplementation((fromRoom: string, toRoom: string) => {
        if (fromRoom === room.name && toRoom === "W6N3") {
          return [{ exit: TOP, room: "W5N1" }];
        }
        return ERR_NO_PATH;
      });
    ensureCreepMovementState(creep.name).travelState = {
      targetRoom: "W6N3",
      stuckTicks: 1,
      lastPosKey: `${room.name}:10:10`,
    };

    moveToTargetRoom(creep, "W6N3", "W9N9|W9N8|W9N7");

    const movement = getMovementAnalyticsForTest();
    expect(movement.totals.travelRequests).toBe(1);
    expect(movement.totals.travelFallbacks).toBe(1);
    expect(movement.totals.travelRepaths).toBe(1);
  });
});
