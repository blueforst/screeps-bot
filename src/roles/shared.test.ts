import {
  clearMovementAnalyticsForTest,
  clearRoomBaseCostMatrixCacheForTest,
  clearMovementState,
  clearTileReservationsForTest,
  getMovementAnalyticsForTest,
  getRoomBaseCostMatrixCacheSizeForTest,
  moveToTargetRoom,
  moveToTarget,
} from "@/roles/shared";

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
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    clearTileReservationsForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    setDefaultMapMocks();
    (global as RuntimeGlobal).Room = {
      serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
    };
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
    expect(blocker.memory.movementPushedAt).toBe(Game.time);
  });

  it("prepends the blocker's previous tile so it can resume its path after yielding", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N2", creeps);
    const pusher = createCreep("worker-2", "worker", 10, 10, room);
    const blocker = createCreep("scout-2", "scout", 11, 10, room);
    blocker.memory.movePathState = {
      key: "k",
      path: "33",
      steps: [
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
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;

    moveToTarget(pusher, { pos: target });

    expect(blocker.memory.movePathState?.steps[0]).toEqual({ x: 11, y: 10 });
    expect(blocker.memory.movePathState?.steps[1]).toEqual({ x: 12, y: 10 });
  });

  it("drops a legacy cached path state without steps and repaths safely", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N2A", creeps);
    const creep = createCreep("worker-legacy", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    creep.memory.movePathState = {
      key: `${room.name}:${room.name}:12:10:r1:i0:sd:pd:md`,
      path: "33",
      targetRoom: room.name,
      targetX: 12,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 5,
    } as CreepMemory["movePathState"];
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(creep, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect((creep.memory.movePathState?.steps || [])[0]).toEqual({ x: 11, y: 10 });
  });

  it("drops a legacy blocker path state without steps when yielding", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N2B", creeps);
    const pusher = createCreep("worker-legacy-push", "worker", 10, 10, room);
    const blocker = createCreep("scout-legacy-push", "scout", 11, 10, room);
    blocker.memory.movePathState = {
      key: "legacy",
      path: "3",
      targetRoom: room.name,
      targetX: 12,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 5,
    } as CreepMemory["movePathState"];
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;
    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalled();
    expect(blocker.memory.movePathState).toBeUndefined();
  });

  it("does not move again on the same tick after being pushed", () => {
    const room = createRoom("W1N3");
    const creep = createCreep("carrier-2", "carrier", 10, 10, room);
    creep.memory.movementPushedAt = Game.time;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const target = new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition;
    const result = moveToTarget(creep, { pos: target });

    expect(result).toBe(OK);
    expect(creep.move).not.toHaveBeenCalled();
    expect((creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo).not.toHaveBeenCalled();
  });

  it("blocks movement into a tile already reserved this tick", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5", creeps);
    const first = createCreep("worker-reserve-1", "worker", 10, 10, room);
    const second = createCreep("worker-reserve-2", "worker", 10, 11, room);
    creeps.push(first, second);
    Game.creeps[first.name] = first;
    Game.creeps[second.name] = second;

    (first.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);
    (second.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: -1, direction: TOP_RIGHT },
    ]);

    const firstResult = moveToTarget(first, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });
    const secondResult = moveToTarget(second, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(firstResult).toBe(OK);
    expect(secondResult).toBe(ERR_BUSY);
    expect(second.move).not.toHaveBeenCalled();
  });

  it("pushes a chain of blockers to open a corridor", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N6", creeps);
    const structures = [
      [10, 9],
      [11, 9],
      [12, 9],
      [13, 9],
      [10, 11],
      [11, 11],
      [12, 11],
      [13, 11],
    ].map(
      ([x, y]) =>
        ({
          structureType: STRUCTURE_EXTENSION,
          pos: new MockRoomPosition(x, y, room.name),
        }) as unknown as Structure<StructureConstant>,
    );
    const pusher = createCreep("worker-chain", "worker", 10, 10, room);
    const blockerA = createCreep("scout-chain-a", "scout", 11, 10, room);
    const blockerB = createCreep("scout-chain-b", "scout", 12, 10, room);
    creeps.push(pusher, blockerA, blockerB);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blockerA.name] = blockerA;
    Game.creeps[blockerB.name] = blockerB;
    room.find = jest.fn((findConstant: number) => {
      switch (findConstant) {
        case FIND_STRUCTURES:
        case FIND_MY_STRUCTURES:
          return structures;
        case FIND_MY_CREEPS:
          return creeps;
        case FIND_CONSTRUCTION_SITES:
          return [];
        default:
          return [];
      }
    });

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 13, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(13, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(blockerB.move).toHaveBeenCalledWith(RIGHT);
    expect(blockerA.move).toHaveBeenCalledWith(RIGHT);
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
});

describe("moveToTargetRoom", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    clearTileReservationsForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    setDefaultMapMocks();
    (global as RuntimeGlobal).Room = {
      serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
    };
    (global as typeof global & { RoomPosition: typeof MockRoomPosition }).RoomPosition = MockRoomPosition;
  });

  it("returns ok immediately when already in the target room", () => {
    const room = createRoom("W9N9");
    const creep = createCreep("scout-same", "scout", 10, 10, room);
    creep.memory.travelState = { targetRoom: "W8N8", stuckTicks: 3 };

    const result = moveToTargetRoom(creep, room.name);

    expect(result).toBe(OK);
    expect(creep.memory.travelState).toBeUndefined();
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
    expect(creep.memory.travelState?.targetRoom).toBe("W1N3");
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

    creep.memory.travelState = {
      targetRoom: "W3N3",
      stuckTicks: 1,
      lastPosKey: "W3N1:10:10",
    };

    const result = moveToTargetRoom(creep, "W3N3", "W3N1|W3N2|W3N3");

    expect(result).toBe(OK);
    expect(Game.map.findRoute).toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(TOP);
    expect(creep.memory.travelState?.stuckTicks).toBe(2);
  });
});

describe("clearMovementState", () => {
  it("clears cached path, travel, and pushed flags together", () => {
    const room = createRoom("W8N8");
    const creep = createCreep("carrier-clear", "carrier", 10, 10, room);
    creep.memory.movePathState = {
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
    creep.memory.travelState = { targetRoom: "W8N9", stuckTicks: 1 };
    creep.memory.movementPushedAt = Game.time;

    clearMovementState(creep);

    expect(creep.memory.movePathState).toBeUndefined();
    expect(creep.memory.travelState).toBeUndefined();
    expect(creep.memory.movementPushedAt).toBeUndefined();
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
    clearTileReservationsForTest();
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
    creep.memory.travelState = {
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
