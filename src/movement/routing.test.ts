import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { moveToTargetRoom } from "@/movement/routing";

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
        CostMatrix: class {},
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
      expect.objectContaining({ maxRooms: 16, plainCost: 2, swampCost: 10 }),
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
});
