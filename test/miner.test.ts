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
  test("already on workPos: harvests without moving", () => {
    workPos.setLookFor(LOOK_CREEPS, []);

    const creep = makeCreep(11, 10, ROOM);
    creep.harvest.mockReturnValue(OK);

    const role = minerRole(SOURCE_ID);

    expect(role.source(creep as unknown as Creep)).toBe(false);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.harvest).toHaveBeenCalledWith(source);
  });

  test("occupied workPos: creep in harvest range does not call moveToTarget with workPos", () => {
    workPos.setLookFor(LOOK_CREEPS, [{ my: true }]);

    const creep = makeCreep(10, 11, ROOM);
    creep.harvest.mockReturnValue(OK);

    const role = minerRole(SOURCE_ID);
    role.source(creep as unknown as Creep);

    expect(moveToTarget).not.toHaveBeenCalledWith(creep, workPos, 0, expect.anything());
    expect(creep.harvest).toHaveBeenCalledWith(source);
  });

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

    expect(moveToTarget).toHaveBeenCalledWith(creep, workPos, 0, { reusePath: 5 });
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  test("after old miner dies, new miner claims workPos", () => {
    workPos.setLookFor(LOOK_CREEPS, [{ my: true }]);
    const creep = makeCreep(10, 11, ROOM);
    creep.harvest.mockReturnValue(OK);

    const role = minerRole(SOURCE_ID);
    role.source(creep as unknown as Creep);
    expect(moveToTarget).not.toHaveBeenCalledWith(creep, workPos, 0, expect.anything());

    jest.clearAllMocks();

    workPos.setLookFor(LOOK_CREEPS, []);
    creep.pos = new MockPos(10, 11, ROOM);

    role.source(creep as unknown as Creep);
    expect(moveToTarget).toHaveBeenCalledWith(creep, workPos, 0, { reusePath: 5 });
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

  test("full on workPos: source phase returns true for target switch", () => {
    workPos.setLookFor(LOOK_CREEPS, []);

    const creep = makeCreep(11, 10, ROOM, 0, 50);
    creep.harvest.mockReturnValue(OK);

    const role = minerRole(SOURCE_ID);

    expect(role.source(creep as unknown as Creep)).toBe(true);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.harvest).toHaveBeenCalledWith(source);
  });
});

describe("minerRole – target phase preserves link transfer behavior", () => {
  test("transfers to adjacent link when full", () => {
    const link = makeLink("link-a", 12, 10, ROOM);
    (getSourceAdjacentLink as jest.Mock).mockReturnValue(link);

    const creep = makeCreep(11, 10, ROOM, 0, 50);
    creep.transfer.mockReturnValue(OK);

    const role = minerRole(SOURCE_ID);

    expect(role.target(creep as unknown as Creep)).toBe(true);
    expect(creep.transfer).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
  });

  test("moves toward link when transfer is out of range", () => {
    const link = makeLink("link-b", 12, 10, ROOM);
    (getSourceAdjacentLink as jest.Mock).mockReturnValue(link);

    const creep = makeCreep(11, 10, ROOM, 0, 50);
    creep.transfer.mockReturnValue(ERR_NOT_IN_RANGE);

    const role = minerRole(SOURCE_ID);

    expect(role.target(creep as unknown as Creep)).toBe(false);
    expect(moveToTarget).toHaveBeenCalledWith(creep, link);
  });

  test("switches back to source when the link disappears while carrying energy", () => {
    (getSourceAdjacentLink as jest.Mock).mockReturnValue(null);

    const creep = makeCreep(11, 10, ROOM, 0, 50);
    const role = minerRole(SOURCE_ID);

    expect(role.target(creep as unknown as Creep)).toBe(true);
    expect(creep.transfer).not.toHaveBeenCalled();
  });
});
