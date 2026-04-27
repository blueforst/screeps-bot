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
