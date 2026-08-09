jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));
jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedSourceContainerPos: jest.fn(),
}));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));
jest.mock("@/runtime/sourceLink", () => ({
  getSourceAdjacentLink: jest.fn(),
}));

import { minerRole } from "@/roles/miner";
import { moveToTarget } from "@/roles/shared";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";
import { getSourceAdjacentLink } from "@/runtime/sourceLink";

class MockPos {
  x: number;
  y: number;
  roomName: string;
  private _lookFor: Record<string, unknown[]> = {};
  private _inRange: unknown[] = [];

  constructor(x: number, y: number, roomName: string) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }

  isEqualTo(other: MockPos): boolean {
    return this.x === other.x && this.y === other.y;
  }

  inRangeTo(target: MockPos, range: number): boolean {
    return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y)) <= range;
  }

  lookFor(type: string): unknown[] {
    return this._lookFor[type] ?? [];
  }

  setLookFor(type: string, items: unknown[]): void {
    this._lookFor[type] = items;
  }

  findInRange(_find: number, _range: number, _opts?: unknown): unknown[] {
    return this._inRange;
  }

  setInRange(items: unknown[]): void {
    this._inRange = items;
  }
}

function makeSource(id: string, x: number, y: number, roomName: string) {
  return { id: id as Id<Source>, pos: new MockPos(x, y, roomName), room: { name: roomName } } as unknown as Source;
}

function makeLink(id: string, x: number, y: number, roomName: string, freeCapacity = 800) {
  return {
    id: id as Id<StructureLink>,
    pos: new MockPos(x, y, roomName),
    store: {
      getFreeCapacity: jest.fn(() => freeCapacity),
    },
  } as unknown as StructureLink;
}

function makeCreep(x: number, y: number, roomName: string, freeCapacity = 50, usedCapacity = 0) {
  return {
    pos: new MockPos(x, y, roomName),
    my: true,
    memory: { role: "miner" },
    store: {
      getFreeCapacity: jest.fn((_resource?: ResourceConstant) => freeCapacity),
      getUsedCapacity: jest.fn((_resource?: ResourceConstant) => usedCapacity),
      getCapacity: jest.fn((_resource?: ResourceConstant) => freeCapacity + usedCapacity),
    },
    harvest: jest.fn() as jest.Mock<number, [Source]>,
    transfer: jest.fn() as jest.Mock<number, [StructureLink, ResourceConstant]>,
  };
}

const ROOM = "W5N5";
const SOURCE_ID = "srcId";

let source: Source;
let workPos: MockPos;

beforeEach(() => {
  jest.clearAllMocks();
  source = makeSource(SOURCE_ID, 10, 10, ROOM);
  workPos = new MockPos(11, 10, ROOM);
  (Game as unknown as { getObjectById: jest.Mock }).getObjectById = jest.fn().mockReturnValue(source);
  (getPlannedSourceContainerPos as jest.Mock).mockReturnValue(workPos);
  Object.assign(global, { RoomPosition: MockPos });
});

describe("minerRole – work position alignment with harvester", () => {

  test("occupied workPos: creep out of harvest range moves toward workPos (range 1)", () => {
    workPos.setLookFor(LOOK_CREEPS, [{ my: true }]);

    const creep = makeCreep(5, 5, ROOM);
    creep.harvest.mockReturnValue(ERR_NOT_IN_RANGE);

    const role = minerRole(SOURCE_ID);
    role.source(creep as unknown as Creep);

    // Moves toward workPos with range 1 instead of toward source
    expect(moveToTarget).toHaveBeenCalledWith(creep, workPos, 1, { reusePath: 5 });
    expect(moveToTarget).not.toHaveBeenCalledWith(creep, source);
  });

  test("unoccupied workPos: creep moves to workPos as normal", () => {
    workPos.setLookFor(LOOK_CREEPS, []);

    const creep = makeCreep(5, 5, ROOM);

    const role = minerRole(SOURCE_ID);
    role.source(creep as unknown as Creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, workPos, 0, { reusePath: 5, allowSourceContainerTarget: true });
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  test("no workPos in layout: miner moves directly to source", () => {
    (getPlannedSourceContainerPos as jest.Mock).mockReturnValue(null);
    (source.pos as unknown as MockPos).setInRange([]);

    const creep = makeCreep(5, 5, ROOM);
    creep.harvest.mockReturnValue(ERR_NOT_IN_RANGE);

    const role = minerRole(SOURCE_ID);
    role.source(creep as unknown as Creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, source);
  });
});
