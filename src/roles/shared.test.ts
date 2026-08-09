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
