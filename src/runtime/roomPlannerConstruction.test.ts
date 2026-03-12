import { runRoomPlannerConstruction } from "@/runtime/roomPlannerConstruction";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  RoomPosition: typeof MockRoomPosition;
};

type PlannedPos = { x: number; y: number };

type MockSite = ConstructionSite & {
  pos: { x: number; y: number; roomName: string };
};

type MockStructure = Structure<StructureConstant> & {
  pos: { x: number; y: number; roomName: string };
};

type MockRoom = Room & {
  __structures: MockStructure[];
  __sites: MockSite[];
  __siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }>;
};

class MockRoomPosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}

  public lookFor(type: LookConstant): Array<Structure<StructureConstant> | ConstructionSite> {
    const room = Game.rooms[this.roomName] as MockRoom | undefined;
    if (!room) {
      return [];
    }

    if (type === LOOK_STRUCTURES) {
      return room.__structures.filter((structure) => structure.pos.x === this.x && structure.pos.y === this.y);
    }

    if (type === LOOK_CONSTRUCTION_SITES) {
      return room.__sites.filter((site) => site.pos.x === this.x && site.pos.y === this.y);
    }

    return [];
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStructure(
  room: Room,
  structureType: StructureConstant,
  x: number,
  y: number,
): MockStructure {
  return {
    structureType,
    my: true,
    pos: { x, y, roomName: room.name },
    room,
  } as unknown as MockStructure;
}

function createRoom(options: {
  name?: string;
  level?: number;
  structures?: MockStructure[];
} = {}): MockRoom {
  const name = options.name ?? "W1N1";
  const structures = [...(options.structures ?? [])];
  const sites: MockSite[] = [];
  const siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }> = [];

  const room = {
    name,
    controller: {
      my: true,
      level: options.level ?? 6,
    } as StructureController,
    __structures: structures,
    __sites: sites,
    __siteAttempts: siteAttempts,
    find(type: FindConstant, opts?: { filter?: (value: any) => boolean }) {
      let results: unknown[] = [];

      if (type === FIND_STRUCTURES) {
        results = this.__structures;
      } else if (type === FIND_CONSTRUCTION_SITES) {
        results = this.__sites;
      } else if (type === FIND_SOURCES || type === FIND_MINERALS) {
        results = [];
      }

      if (opts?.filter) {
        return results.filter((value) => opts.filter?.(value));
      }

      return results;
    },
    createConstructionSite(x: number, y: number, structureType: BuildableStructureConstant) {
      this.__siteAttempts.push({ x, y, structureType });

      const site = {
        id: `${structureType}:${x}:${y}:${this.__sites.length}`,
        my: true,
        structureType,
        pos: { x, y, roomName: this.name },
        room: this,
      } as MockSite;

      this.__sites.push(site);
      (Game.constructionSites as Record<string, ConstructionSite>)[site.id] = site;
      return OK;
    },
  } as MockRoom;

  room.__structures = structures;
  room.__sites = sites;
  room.__siteAttempts = siteAttempts;
  return room;
}

function setLabLayout(roomName: string, labPositions: PlannedPos[]): void {
  Memory.data = {
    roomPlanner: {
      [roomName]: {
        layout: {
          [STRUCTURE_LAB]: labPositions.map((pos) => ({ ...pos })),
        },
        timestamp: "2026-03-12T00:00:00.000Z",
        savedAt: Game.time,
      },
    },
  } as Memory["data"];
}

describe("runRoomPlannerConstruction lab ordering", () => {
  beforeAll(() => {
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
  });

  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 100;
    Game.constructionSites = {} as Game["constructionSites"];
    Memory.cfg = {
      roomPlannerBuild: {
        enabled: true,
      },
    };
  });

  it("queues the planner's reagent labs before other labs", () => {
    const room = createRoom();
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    Game.rooms[room.name] = room;

    const labPositions = Array.from({ length: 10 }, (_, index) => ({ x: 20 + index, y: 20 }));
    setLabLayout(room.name, labPositions);

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([
      { x: labPositions[8].x, y: labPositions[8].y, structureType: STRUCTURE_LAB },
      { x: labPositions[9].x, y: labPositions[9].y, structureType: STRUCTURE_LAB },
    ]);
  });

  it("queues the first product lab next without mutating planner layout order", () => {
    const room = createRoom();
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    Game.rooms[room.name] = room;

    const labPositions = Array.from({ length: 10 }, (_, index) => ({ x: 15 + index, y: 18 }));
    setLabLayout(room.name, labPositions);
    const storedOrderBefore = Memory.data?.roomPlanner?.[room.name]?.layout[STRUCTURE_LAB].map((pos) => ({ ...pos }));

    runRoomPlannerConstruction();
    Game.time = 200;
    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([
      { x: labPositions[8].x, y: labPositions[8].y, structureType: STRUCTURE_LAB },
      { x: labPositions[9].x, y: labPositions[9].y, structureType: STRUCTURE_LAB },
      { x: labPositions[0].x, y: labPositions[0].y, structureType: STRUCTURE_LAB },
    ]);
    expect(Memory.data?.roomPlanner?.[room.name]?.layout[STRUCTURE_LAB]).toEqual(storedOrderBefore);
  });

  it("preserves original order when fewer than three labs are planned", () => {
    const room = createRoom({ name: "W1N2" });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 9, 9));
    Game.rooms[room.name] = room;

    const labPositions = [
      { x: 12, y: 12 },
      { x: 13, y: 12 },
    ];
    setLabLayout(room.name, labPositions);

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([
      { x: labPositions[0].x, y: labPositions[0].y, structureType: STRUCTURE_LAB },
      { x: labPositions[1].x, y: labPositions[1].y, structureType: STRUCTURE_LAB },
    ]);
  });
});
