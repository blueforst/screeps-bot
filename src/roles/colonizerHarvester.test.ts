jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((action: () => ScreepsReturnCode) => action()),
}));
jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedSourceContainerPos: jest.fn(),
}));

import { colonizerHarvesterRole } from "@/roles/colonizerHarvester";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";

const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;
const mockedMoveToTargetRoom = moveToTargetRoom as jest.MockedFunction<typeof moveToTargetRoom>;
const mockedGetPlannedSourceContainerPos = getPlannedSourceContainerPos as jest.MockedFunction<typeof getPlannedSourceContainerPos>;

function createContainer(freeCapacity: number): StructureContainer {
  return {
    structureType: STRUCTURE_CONTAINER,
    store: {
      getFreeCapacity: jest.fn(() => freeCapacity),
    },
  } as unknown as StructureContainer;
}

function createPosition(
  x: number,
  y: number,
  structures: Structure[] = [],
  creeps: Creep[] = [],
): RoomPosition {
  return {
    x,
    y,
    roomName: "W1N0",
    lookFor: jest.fn((lookType: LookConstant) => {
      if (lookType === LOOK_STRUCTURES) return structures;
      if (lookType === LOOK_CREEPS) return creeps;
      return [];
    }),
    isEqualTo: jest.fn((target: RoomPosition) => target.x === x && target.y === y),
    inRangeTo: jest.fn((target: RoomPosition, range: number) =>
      Math.max(Math.abs(target.x - x), Math.abs(target.y - y)) <= range
    ),
  } as unknown as RoomPosition;
}

function createSource(workPos: RoomPosition): Source {
  return {
    id: "source-a" as Id<Source>,
    pos: {
      findInRange: jest.fn(() => []),
    },
    room: { name: workPos.roomName },
  } as unknown as Source;
}

function createCreep(roomName: string, pos: RoomPosition, carry = false): Creep {
  return {
    room: { name: roomName },
    pos,
    body: [
      { type: WORK, hits: 100 },
      ...(carry ? [{ type: CARRY, hits: 100 }] : []),
    ],
    harvest: jest.fn(() => OK),
  } as unknown as Creep;
}

function bindSource(workPos: RoomPosition): Source {
  const source = createSource(workPos);
  Game.getObjectById = jest.fn(() => source) as typeof Game.getObjectById;
  mockedGetPlannedSourceContainerPos.mockReturnValue(workPos);
  return source;
}

describe("colonizerHarvesterRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
  });

  it("stops the invalid harvest intent while standing on its full work container", () => {
    const workPos = createPosition(10, 10, [createContainer(0)]);
    const creep = createCreep("W1N0", workPos);
    bindSource(workPos);

    expect(colonizerHarvesterRole("W1N0", "source-a").source?.(creep)).toBe(false);

    expect(creep.harvest).not.toHaveBeenCalled();
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
  });

  it("resumes harvesting as soon as its work container has free capacity", () => {
    const workPos = createPosition(10, 10, [createContainer(1)]);
    const creep = createCreep("W1N0", workPos);
    const source = bindSource(workPos);

    expect(colonizerHarvesterRole("W1N0", "source-a").source?.(creep)).toBe(false);

    expect(creep.harvest).toHaveBeenCalledWith(source);
  });

  it("moves toward the assigned work position instead of stalling on an unrelated full container", () => {
    const unrelatedPos = createPosition(20, 20, [createContainer(0)]);
    const workPos = createPosition(10, 10);
    const creep = createCreep("W1N0", unrelatedPos);
    bindSource(workPos);

    expect(colonizerHarvesterRole("W1N0", "source-a").source?.(creep)).toBe(false);

    expect(mockedMoveToTarget).toHaveBeenCalledWith(
      creep,
      workPos,
      0,
      { reusePath: 5, allowSourceContainerTarget: true },
    );
    expect(unrelatedPos.lookFor).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it("does not suppress harvesting for an explicitly configured body with active CARRY", () => {
    const workPos = createPosition(10, 10, [createContainer(0)]);
    const creep = createCreep("W1N0", workPos, true);
    const source = bindSource(workPos);

    expect(colonizerHarvesterRole("W1N0", "source-a").source?.(creep)).toBe(false);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(workPos.lookFor).not.toHaveBeenCalledWith(LOOK_STRUCTURES);
  });

  it("travels to the target room before resolving source or container state", () => {
    const creep = createCreep("W1N1", createPosition(10, 10));

    expect(colonizerHarvesterRole("W1N0", "source-a", "W1N1|W1N0").source?.(creep)).toBe(false);

    expect(mockedMoveToTargetRoom).toHaveBeenCalledWith(
      creep,
      "W1N0",
      "W1N1|W1N0",
      { plainCost: 2, swampCost: 10 },
    );
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.pos.lookFor).not.toHaveBeenCalled();
  });
});
