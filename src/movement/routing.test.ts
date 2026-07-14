import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { moveToTargetRoom } from "@/movement/routing";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | number, y?: number): number {
    const targetX = typeof target === "number" ? target : target.x;
    const targetY = typeof target === "number" ? y ?? this.y : target.y;
    return Math.max(Math.abs(this.x - targetX), Math.abs(this.y - targetY));
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

  public isEqualTo(target: RoomPosition): boolean {
    return this.x === target.x && this.y === target.y && this.roomName === target.roomName;
  }

  public findClosestByPath(): RoomPosition | null {
    return this as unknown as RoomPosition;
  }
}

class RealCostMatrix {
  private data = new Uint8Array(2500);
  public set(x: number, y: number, value: number): void {
    this.data[y * 50 + x] = value;
  }
  public get(x: number, y: number): number {
    return this.data[y * 50 + x];
  }
  public clone(): RealCostMatrix {
    const copy = new RealCostMatrix();
    copy.data.set(this.data);
    return copy;
  }
}

describe("moveToTargetRoom", () => {
  beforeEach(() => {
    clearCreepMovementStateForTest();
    Game.time += 1;
    Memory.data = undefined;

    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });

    Object.assign(Game, {
      map: {
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
        findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
        describeExits: jest.fn((roomName: string) => {
          if (roomName === "W1N1") {
            return { [RIGHT]: "W1N2" };
          }
          if (roomName === "W1N2") {
            return { [LEFT]: "W1N1", [RIGHT]: "W1N3" };
          }
          if (roomName === "W1N3") {
            return { [LEFT]: "W1N2" };
          }
          return null;
        }),
      },
    });

    Object.assign(global, {
      PathFinder: {
        search: jest.fn(() => ({ path: [], incomplete: true, ops: 0, cost: 0 })),
        CostMatrix: RealCostMatrix as unknown as typeof PathFinder.CostMatrix,
      },
      Room: {
        serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
      },
    });
  });

  it("uses a multi-room path search instead of locking onto the closest current-room exit", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn(() => [new MockRoomPosition(49, 25, "W1N1")]),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "scout-global-path",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [new MockRoomPosition(10, 11, "W1N1")],
      incomplete: false,
      ops: 10,
      cost: 1,
    });

    const result = moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(PathFinder.search).toHaveBeenCalledWith(
      creep.pos,
      { pos: new MockRoomPosition(25, 25, "W1N3"), range: 1 },
      expect.objectContaining({ maxOps: 10000, maxRooms: 16, plainCost: 2, swampCost: 10 }),
    );
    expect(findClosestByPath).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledWith(BOTTOM);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("follows a cached colonization travel path without recomputing the multi-room path", () => {
    Memory.data = {
      colonization: {
        W1N3: {
          targetRoom: "W1N3",
          sourceRoom: "W1N1",
          status: "claiming",
          flagName: "CL",
          planReady: false,
          claimCompleted: false,
          scoutSafe: true,
          scoutRouteRooms: ["W1N1", "W1N2", "W1N3"],
          dangerousRooms: [],
          cachedTravelPath: {
            key: "W1N1->W1N3|r:W1N1>W1N2>W1N3|d:",
            sourceRoom: "W1N1",
            targetRoom: "W1N3",
            routeRooms: ["W1N1", "W1N2", "W1N3"],
            positions: [
              { x: 11, y: 10, roomName: "W1N1" },
              { x: 12, y: 10, roomName: "W1N1" },
              { x: 49, y: 10, roomName: "W1N1" },
              { x: 0, y: 10, roomName: "W1N2" },
            ],
            generatedAt: Game.time,
          },
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    };
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn(() => [new MockRoomPosition(49, 25, "W1N1")]),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "claimer-cached-path",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    const result = moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(move).toHaveBeenCalledWith(RIGHT);
    expect(PathFinder.search).not.toHaveBeenCalled();
    expect(findClosestByPath).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("moves outward when already standing on the selected exit tile", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn(() => [new MockRoomPosition(49, 25, "W1N1")]),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const creep = {
      name: "scout1",
      fatigue: 0,
      room,
      pos: new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition,
      move,
      moveTo,
    } as unknown as Creep;

    const result = moveToTargetRoom(creep, "W1N2", "W1N1|W1N2", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(move).toHaveBeenCalledWith(RIGHT);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("treats edge-to-edge border shuffling as stuck travel", () => {
    const room = {
      name: "W1N2",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === RIGHT) {
          return [new MockRoomPosition(49, 25, "W1N2")];
        }
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const creep = {
      name: "scout-edge-shuffle",
      fatigue: 0,
      room,
      pos: new MockRoomPosition(0, 25, "W1N2") as unknown as RoomPosition,
      move,
      moveTo,
    } as unknown as Creep;

    ensureCreepMovementState(creep.name).travelState = {
      targetRoom: "W1N3",
      stuckTicks: 1,
      lastPosKey: "W1N1:49:25",
      lastWasExit: true,
    };

    const result = moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(getCreepMovementState(creep.name)?.travelState?.stuckTicks).toBe(2);
  });

  it("moves off a wrong room edge before heading to the next route exit", () => {
    const room = {
      name: "W1N2",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === RIGHT) {
          return [new MockRoomPosition(49, 25, "W1N2")];
        }
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const creep = {
      name: "scout-wrong-edge",
      fatigue: 0,
      room,
      pos: new MockRoomPosition(39, 0, "W1N2") as unknown as RoomPosition,
      move,
      moveTo,
    } as unknown as Creep;

    const result = moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(move).toHaveBeenCalledWith(BOTTOM);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("applies high cost to source container positions in multi-room travel matrix", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-avoid-container",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([{ x: 15, y: 15 }]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N1") as CostMatrix;
    expect(matrix).toBeDefined();
    expect((matrix as unknown as RealCostMatrix).get(15, 15)).toBe(0xfe);
    expect((matrix as unknown as RealCostMatrix).get(20, 20)).toBe(0);

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("applies high cost to controller work zone tiles in owned rooms", () => {
    const room = {
      name: "W1N1",
      controller: { pos: new MockRoomPosition(26, 20, "W1N1"), my: true } as unknown as StructureController,
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-avoid-controller",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N1") as CostMatrix;
    // Tiles within range 3 of controller at (26,20) should be high cost
    expect((matrix as unknown as RealCostMatrix).get(26, 20)).toBe(0xfe);
    expect((matrix as unknown as RealCostMatrix).get(27, 19)).toBe(0xfe);
    expect((matrix as unknown as RealCostMatrix).get(24, 23)).toBe(0xfe);
    // Tile well outside the zone should be 0
    expect((matrix as unknown as RealCostMatrix).get(10, 10)).toBe(0);
  });

  it("does not apply controller work zone cost when room is not owned", () => {
    const room = {
      name: "W1N1",
      controller: { pos: new MockRoomPosition(26, 20, "W1N1"), my: false } as unknown as StructureController,
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-unowned-room",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    const matrix = capturedCallback!("W1N1") as CostMatrix;
    // No high cost applied near controller in unowned room
    expect((matrix as unknown as RealCostMatrix).get(26, 20)).toBe(0);
  });

  it("keeps ignoreCreeps default on normal first path (creeps NOT high-cost)", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_MY_CREEPS) {
          return [{ name: "other-creep", pos: new MockRoomPosition(27, 18, "W1N1") }];
        }
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-normal-path",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N1") as CostMatrix;
    expect((matrix as unknown as RealCostMatrix).get(27, 18)).toBe(0);
  });

  it("marks own creep positions as high-cost during stuck repath", () => {
    const room = {
      name: "W1N1",
      controller: { pos: new MockRoomPosition(26, 20, "W1N1"), my: true } as unknown as StructureController,
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_MY_CREEPS) {
          return [{ name: "blocking-creep", pos: new MockRoomPosition(27, 18, "W1N1") }];
        }
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-stuck-repath",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(15, 18, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    ensureCreepMovementState(creep.name).travelState = {
      targetRoom: "W1N3",
      stuckTicks: 2,
      lastPosKey: "W1N1:15:18",
      lastWasExit: false,
    };

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(15, 19, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N1") as CostMatrix;
    expect((matrix as unknown as RealCostMatrix).get(27, 18)).toBe(0xfe);
    expect((matrix as unknown as RealCostMatrix).get(15, 18)).toBe(0);
    expect((matrix as unknown as RealCostMatrix).get(26, 20)).toBe(0xfe);
  });

  it("does not overwrite blocked tiles with controller zone cost", () => {
    Game.time += 100;
    const room = {
      name: "W1N1",
      controller: { pos: new MockRoomPosition(26, 20, "W1N1"), my: true } as unknown as StructureController,
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) {
          return [{ structureType: STRUCTURE_SPAWN, pos: new MockRoomPosition(27, 20, "W1N1"), my: true }];
        }
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-blocked-check",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    const matrix = capturedCallback!("W1N1") as CostMatrix;
    expect((matrix as unknown as RealCostMatrix).get(27, 20)).toBe(0xff);
    expect((matrix as unknown as RealCostMatrix).get(26, 19)).toBe(0xfe);
  });

  it("prefers road structures over plain terrain in multi-room travel matrix", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) {
          return [{ structureType: STRUCTURE_ROAD, pos: new MockRoomPosition(20, 20, "W1N1") }];
        }
        if (findConstant === FIND_CONSTRUCTION_SITES) return [];
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-road-pref",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N1") as CostMatrix;
    // Road tile should be cost 1
    expect((matrix as unknown as RealCostMatrix).get(20, 20)).toBe(1);
    // Plain tile (no road) should be cost 0 (PathFinder applies plainCost=2)
    expect((matrix as unknown as RealCostMatrix).get(21, 21)).toBe(0);
  });

  it("prefers road construction sites as low-cost tiles in multi-room travel matrix", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) {
          return [{ structureType: STRUCTURE_ROAD, pos: new MockRoomPosition(20, 20, "W1N1"), my: true }];
        }
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N1")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-road-site-pref",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N1"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N1"] = room;

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N1")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N1") as CostMatrix;
    // Road construction site should be cost 1 (same as built road)
    expect((matrix as unknown as RealCostMatrix).get(20, 20)).toBe(1);
  });

  it("still blocks non-walkable construction sites in multi-room travel matrix", () => {
    Game.time += 1;
    const room = {
      name: "W1N2",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === FIND_STRUCTURES) return [];
        if (findConstant === FIND_CONSTRUCTION_SITES) {
          return [{ structureType: STRUCTURE_EXTENSION, pos: new MockRoomPosition(30, 30, "W1N2"), my: true }];
        }
        if (findConstant === FIND_EXIT) return [new MockRoomPosition(49, 25, "W1N2")];
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const findClosestByPath = jest.fn(() => new MockRoomPosition(49, 25, "W1N2") as unknown as RoomPosition);
    const findPathTo = jest.fn(() => [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }]);
    const creep = {
      name: "carrier-blocked-site",
      fatigue: 0,
      room,
      pos: Object.assign(new MockRoomPosition(10, 10, "W1N2"), { findClosestByPath, findPathTo }) as unknown as RoomPosition,
      memory: {},
      move,
      moveTo,
    } as unknown as Creep;

    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
    Game.rooms["W1N2"] = room;
    (Game.map.getRoomStatus as jest.Mock) = jest.fn(() => ({ status: "normal" }));

    let capturedCallback: ((roomName: string) => boolean | CostMatrix) | undefined;
    (PathFinder.search as jest.Mock).mockImplementation(
      (_origin: any, _goal: any, opts: { roomCallback?: (roomName: string) => boolean | CostMatrix }) => {
        capturedCallback = opts.roomCallback;
        return { path: [new MockRoomPosition(10, 11, "W1N2")], incomplete: false, ops: 10, cost: 1 };
      },
    );

    moveToTargetRoom(creep, "W1N3", "W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(capturedCallback).toBeDefined();
    const matrix = capturedCallback!("W1N2") as CostMatrix;
    // Non-walkable construction site should be impassable
    expect((matrix as unknown as RealCostMatrix).get(30, 30)).toBe(0xff);
  });
});
