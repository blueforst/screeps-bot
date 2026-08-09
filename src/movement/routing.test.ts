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
});
