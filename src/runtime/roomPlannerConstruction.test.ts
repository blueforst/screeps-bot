import {
  getPlannedSourceContainerPos,
  getSourceContainerPositionsForRoom,
  runRoomPlannerConstruction,
} from "@/runtime/roomPlannerConstruction";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  RoomPosition: typeof MockRoomPosition;
};

type PlannedPos = { x: number; y: number };

type MockSite = ConstructionSite & {
  pos: { x: number; y: number; roomName: string };
};

type MockStructure = Structure<StructureConstant> & {
  my: boolean;
  pos: { x: number; y: number; roomName: string };
};

type MockRoom = Room & {
  __structures: MockStructure[];
  __sites: MockSite[];
  __sources: Source[];
  __minerals: Mineral[];
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

  public getRangeTo(target: { x: number; y: number }): number {
    return Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y));
  }

  public findClosestByRange<T extends { pos: { x: number; y: number } }>(targets: T[]): T | null {
    let best: T | null = null;
    let bestRange = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const range = this.getRangeTo(target.pos);
      if (range < bestRange) {
        best = target;
        bestRange = range;
      }
    }

    return best;
  }

  public findPathTo(target: { x: number; y: number }): Array<{ x: number; y: number }> {
    const steps = Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y));
    return Array.from({ length: steps }, (_, index) => ({
      x: this.x + Math.sign(target.x - this.x) * (index + 1),
      y: this.y + Math.sign(target.y - this.y) * (index + 1),
    }));
  }

  public findInRange(
    type: FindConstant,
    range: number,
    opts?: { filter?: (value: any) => boolean },
  ): Array<Source | Mineral | Structure<StructureConstant> | ConstructionSite> {
    const room = Game.rooms[this.roomName] as MockRoom | undefined;
    if (!room) {
      return [];
    }

    const isWithinRange = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - this.x), Math.abs(y - this.y)) <= range;

    if (type === FIND_SOURCES) {
      const results = room.find(FIND_SOURCES).filter((source) => isWithinRange(source.pos.x, source.pos.y));
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    if (type === FIND_MINERALS) {
      const results = room.find(FIND_MINERALS).filter((mineral) => isWithinRange(mineral.pos.x, mineral.pos.y));
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    if (type === FIND_MY_STRUCTURES) {
      const results = room.__structures.filter(
        (structure) => structure.my && isWithinRange(structure.pos.x, structure.pos.y),
      );
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    if (type === FIND_CONSTRUCTION_SITES) {
      const results = room.__sites.filter((site) => isWithinRange(site.pos.x, site.pos.y));
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
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
    destroy: jest.fn(() => OK),
    structureType,
    my: true,
    pos: new MockRoomPosition(x, y, room.name),
    room,
  } as unknown as MockStructure;
}

function createSource(room: Room, x: number, y: number): Source {
  return {
    id: `source:${room.name}:${x}:${y}`,
    room,
    pos: new MockRoomPosition(x, y, room.name) as RoomPosition,
  } as Source;
}

function createMineral(room: Room, x: number, y: number): Mineral {
  return {
    id: `mineral:${room.name}:${x}:${y}`,
    room,
    pos: new MockRoomPosition(x, y, room.name) as RoomPosition,
  } as Mineral;
}

function createPlannedSite(
  room: Room,
  structureType: BuildableStructureConstant,
  x: number,
  y: number,
): MockSite {
  return {
    id: `existing:${structureType}:${x}:${y}`,
    my: true,
    remove: jest.fn(() => OK),
    structureType,
    pos: new MockRoomPosition(x, y, room.name),
    room,
  } as unknown as MockSite;
}

function createRoom(options: {
  name?: string;
  level?: number;
  structures?: MockStructure[];
  sources?: Source[];
  minerals?: Mineral[];
} = {}): MockRoom {
  const name = options.name ?? "W1N1";
  const structures = [...(options.structures ?? [])];
  const sources = [...(options.sources ?? [])];
  const minerals = [...(options.minerals ?? [])];
  const sites: MockSite[] = [];
  const siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }> = [];

  const room = {
    name,
    controller: {
      my: true,
      level: options.level ?? 6,
      pos: new MockRoomPosition(25, 25, name),
    } as StructureController,
    __structures: structures,
    __sites: sites,
    __sources: sources,
    __minerals: minerals,
    __siteAttempts: siteAttempts,
    find(type: FindConstant, opts?: { filter?: (value: any) => boolean }) {
      let results: unknown[] = [];

      if (type === FIND_STRUCTURES) {
        results = this.__structures;
      } else if (type === FIND_CONSTRUCTION_SITES) {
        results = this.__sites;
      } else if (type === FIND_SOURCES) {
        results = this.__sources;
      } else if (type === FIND_MINERALS) {
        results = this.__minerals;
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
        remove: jest.fn(() => OK),
        structureType,
        pos: new MockRoomPosition(x, y, this.name),
        room: this,
      } as unknown as MockSite;

      this.__sites.push(site);
      (Game.constructionSites as Record<string, ConstructionSite>)[site.id] = site;
      return OK;
    },
  } as MockRoom;

  room.__structures = structures;
  room.__sites = sites;
  room.__sources = sources;
  room.__minerals = minerals;
  room.__siteAttempts = siteAttempts;
  return room;
}

function setRoomPlannerLayout(roomName: string, layout: Partial<Record<string, PlannedPos[]>>): void {
  const clonedLayout = Object.fromEntries(
    Object.entries(layout).map(([structureType, positions]) => [
      structureType,
      (positions ?? []).map((pos) => ({ ...pos })),
    ]),
  );

  Memory.data = {
    ...Memory.data,
    roomPlanner: {
      ...(Memory.data?.roomPlanner ?? {}),
      [roomName]: {
        layout: clonedLayout,
        timestamp: "2026-03-12T00:00:00.000Z",
        savedAt: Game.time,
      },
    },
  } as Memory["data"];
}

function createRemoteMiningTask(
  sourceRoom: string,
  targetRoom: string,
  containerPositions: Record<string, { x: number; y: number; roomName: string }>,
): import("@/runtime/remoteMining").RemoteMiningTask {
  return {
    sourceRoom,
    targetRoom,
    status: "active",
    sourceIds: Object.keys(containerPositions),
    assignedAt: Game.time,
    updatedAt: Game.time,
    containerPositions,
  };
}

describe("getSourceContainerPositionsForRoom", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 100;
    Game.rooms = {} as Game["rooms"];
    Memory.data = {} as Memory["data"];
  });

  it("includes remote mining source container positions without a room planner layout", () => {
    const room = createRoom({ name: "W2N1" });
    room.controller.my = false;
    Game.rooms[room.name] = room;
    Memory.data = {
      remoteMining: {
        [room.name]: createRemoteMiningTask("W1N1", room.name, {
          source1: { x: 12, y: 14, roomName: room.name },
          source2: { x: 35, y: 37, roomName: room.name },
        }),
      },
    } as Memory["data"];

    expect(getSourceContainerPositionsForRoom(room.name)).toEqual([
      { x: 12, y: 14 },
      { x: 35, y: 37 },
    ]);
  });

  it("deduplicates remote mining container positions with planned source container positions", () => {
    const room = createRoom({ name: "W2N2" });
    room.controller.my = false;
    const source = createSource(room, 11, 10);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, { [STRUCTURE_CONTAINER]: [{ x: 12, y: 10 }] });
    Memory.data = {
      ...Memory.data,
      remoteMining: {
        [room.name]: createRemoteMiningTask("W1N1", room.name, {
          source1: { x: 12, y: 10, roomName: room.name },
          source2: { x: 20, y: 20, roomName: room.name },
        }),
      },
    } as Memory["data"];

    expect(getSourceContainerPositionsForRoom(room.name)).toEqual([
      { x: 12, y: 10 },
      { x: 20, y: 20 },
    ]);
  });

  it("ignores a remote mining container plan after the target room is owned before lifecycle cleanup", () => {
    const room = createRoom({ name: "W2N5" });
    Game.rooms[room.name] = room;
    const task = createRemoteMiningTask("W1N5", room.name, {
      source1: { x: 12, y: 14, roomName: room.name },
    });
    Memory.data = {
      remoteMining: { [room.name]: task },
    } as Memory["data"];

    expect(getSourceContainerPositionsForRoom(room.name)).toEqual([]);
  });

  it("ignores an abandoned remote mining container plan", () => {
    const room = createRoom({ name: "W2N6" });
    room.controller.my = false;
    Game.rooms[room.name] = room;
    const task = createRemoteMiningTask("W1N6", room.name, {
      source1: { x: 12, y: 14, roomName: room.name },
    });
    task.status = "abandoned";
    task.abandonedReason = "owned_room";
    Memory.data = {
      remoteMining: { [room.name]: task },
    } as Memory["data"];

    expect(getSourceContainerPositionsForRoom(room.name)).toEqual([]);
  });

  it("caches repeated same-tick calls and refreshes on the next tick", () => {
    const room = createRoom({ name: "W2N3" });
    const source = createSource(room, 11, 10);
    room.__sources.push(source);
    room.__minerals.push(createMineral(room, 40, 40));
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, { [STRUCTURE_CONTAINER]: [{ x: 12, y: 10 }] });

    const findSpy = jest.spyOn(room, "find");

    const first = getSourceContainerPositionsForRoom(room.name);
    const callsAfterFirst = findSpy.mock.calls.length;

    expect(first).toEqual([{ x: 12, y: 10 }, { x: 40, y: 40 }]);

    const second = getSourceContainerPositionsForRoom(room.name);
    expect(second).toEqual(first);
    expect(findSpy.mock.calls.length).toBe(callsAfterFirst);

    findSpy.mockClear();
    Game.time = 101;
    const third = getSourceContainerPositionsForRoom(room.name);
    expect(third).toEqual(first);
    expect(findSpy.mock.calls.length).toBeGreaterThan(0);

    findSpy.mockRestore();
  });

  it("returns defensive copies so callers cannot mutate the cached array", () => {
    const room = createRoom({ name: "W2N4" });
    const source = createSource(room, 11, 10);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, { [STRUCTURE_CONTAINER]: [{ x: 12, y: 10 }] });

    const first = getSourceContainerPositionsForRoom(room.name);
    first.pop();
    first.push({ x: 99, y: 99 });

    const second = getSourceContainerPositionsForRoom(room.name);
    expect(second).toEqual([{ x: 12, y: 10 }]);
  });
});

describe("getPlannedSourceContainerPos", () => {
  beforeAll(() => {
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
  });

  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 100;
    Game.rooms = {} as Game["rooms"];
    Memory.data = {} as Memory["data"];
  });

  it("uses remote mining container position keyed by source id before the container exists", () => {
    const room = createRoom({ name: "E1N56" });
    room.controller.my = false;
    const source = createSource(room, 6, 32);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    Memory.data = {
      remoteMining: {
        [room.name]: createRemoteMiningTask("E1N57", room.name, {
          [source.id]: { x: 5, y: 33, roomName: room.name },
        }),
      },
    } as Memory["data"];

    expect(getPlannedSourceContainerPos(source)).toEqual(new MockRoomPosition(5, 33, room.name));
  });

  it("ignores remote mining container positions for other rooms", () => {
    const room = createRoom({ name: "E1N56" });
    const source = createSource(room, 6, 32);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    Memory.data = {
      remoteMining: {
        [room.name]: createRemoteMiningTask("E1N57", room.name, {
          [source.id]: { x: 5, y: 33, roomName: "E1N55" },
        }),
      },
    } as Memory["data"];

    expect(getPlannedSourceContainerPos(source)).toBeNull();
  });

  it("ignores a remote mining source container plan after the target room is owned before lifecycle cleanup", () => {
    const room = createRoom({ name: "E1N55" });
    const source = createSource(room, 6, 32);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    const task = createRemoteMiningTask("E1N57", room.name, {
      [source.id]: { x: 5, y: 33, roomName: room.name },
    });
    Memory.data = {
      remoteMining: { [room.name]: task },
    } as Memory["data"];

    expect(getPlannedSourceContainerPos(source)).toBeNull();
  });
});

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
    setRoomPlannerLayout(room.name, { [STRUCTURE_LAB]: labPositions });

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
    setRoomPlannerLayout(room.name, { [STRUCTURE_LAB]: labPositions });
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
    setRoomPlannerLayout(room.name, { [STRUCTURE_LAB]: labPositions });

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([
      { x: labPositions[0].x, y: labPositions[0].y, structureType: STRUCTURE_LAB },
      { x: labPositions[1].x, y: labPositions[1].y, structureType: STRUCTURE_LAB },
    ]);
  });

  it("lets planned links win over conflicting container positions", () => {
    const room = createRoom({ name: "W1N5" });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 9, 9));
    Game.rooms[room.name] = room;

    setRoomPlannerLayout(room.name, {
      [STRUCTURE_LINK]: [{ x: 12, y: 12 }],
      [STRUCTURE_CONTAINER]: [{ x: 12, y: 12 }],
    });

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([{ x: 12, y: 12, structureType: STRUCTURE_LINK }]);
  });

  it("tracks the 100-tick construction cadence independently per room", () => {
    const earlyRoom = createRoom({ name: "W1N6" });
    earlyRoom.__structures.push(createStructure(earlyRoom, STRUCTURE_SPAWN, 9, 9));
    const dueRoom = createRoom({ name: "W1N7" });
    dueRoom.__structures.push(createStructure(dueRoom, STRUCTURE_SPAWN, 9, 9));
    Game.rooms[earlyRoom.name] = earlyRoom;
    Game.rooms[dueRoom.name] = dueRoom;

    setRoomPlannerLayout(earlyRoom.name, { [STRUCTURE_EXTENSION]: [{ x: 12, y: 12 }] });
    setRoomPlannerLayout(dueRoom.name, { [STRUCTURE_EXTENSION]: [{ x: 13, y: 13 }] });
    Memory.runtime = {
      roomPlannerBuild: {
        rooms: {
          [earlyRoom.name]: { lastRunAt: 50 },
          [dueRoom.name]: { lastRunAt: 0 },
        },
      },
    };

    runRoomPlannerConstruction();

    expect(earlyRoom.__siteAttempts).toEqual([]);
    expect(dueRoom.__siteAttempts).toEqual([{ x: 13, y: 13, structureType: STRUCTURE_EXTENSION }]);
    expect(Memory.runtime.roomPlannerBuild?.rooms[earlyRoom.name]?.lastRunAt).toBe(50);
    expect(Memory.runtime.roomPlannerBuild?.rooms[dueRoom.name]?.lastRunAt).toBe(100);

    Game.time = 150;
    runRoomPlannerConstruction();

    expect(earlyRoom.__siteAttempts).toEqual([{ x: 12, y: 12, structureType: STRUCTURE_EXTENSION }]);
    expect(dueRoom.__siteAttempts).toEqual([{ x: 13, y: 13, structureType: STRUCTURE_EXTENSION }]);
    expect(Memory.runtime.roomPlannerBuild?.rooms[earlyRoom.name]?.lastRunAt).toBe(150);
    expect(Memory.runtime.roomPlannerBuild?.rooms[dueRoom.name]?.lastRunAt).toBe(100);
  });
});

describe("runRoomPlannerConstruction extractor auto-placement", () => {
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

  it("queues an extractor from live mineral position when planner layout has none", () => {
    const room = createRoom();
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    room.__minerals.push(createMineral(room, 20, 21));
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, {});

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([{ x: 20, y: 21, structureType: STRUCTURE_EXTRACTOR }]);
  });

  it("dedupes merged extractor positions and skips coordinates with an existing extractor site", () => {
    const room = createRoom({ name: "W1N3" });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    room.__minerals.push(createMineral(room, 24, 24));
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, { [STRUCTURE_EXTRACTOR]: [{ x: 24, y: 24 }, { x: 24, y: 24 }] });

    const existingSite = createPlannedSite(room, STRUCTURE_EXTRACTOR, 24, 24);
    room.__sites.push(existingSite);
    (Game.constructionSites as Record<string, ConstructionSite>)[existingSite.id] = existingSite;

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([]);
  });

  it("does not mutate saved extractor layout while merging runtime mineral candidates", () => {
    const room = createRoom({ name: "W1N4" });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    room.__minerals.push(createMineral(room, 30, 31));
    Game.rooms[room.name] = room;

    const plannedExtractorPositions = [{ x: 29, y: 29 }];
    setRoomPlannerLayout(room.name, { [STRUCTURE_EXTRACTOR]: plannedExtractorPositions });
    const savedBefore = Memory.data?.roomPlanner?.[room.name]?.layout[STRUCTURE_EXTRACTOR].map((pos) => ({ ...pos }));

    runRoomPlannerConstruction();

    expect(Memory.data?.roomPlanner?.[room.name]?.layout[STRUCTURE_EXTRACTOR]).toEqual(savedBefore);
  });
});

describe("runRoomPlannerConstruction proto container transitions", () => {
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

  it("does not treat a proto controller container as an existing link on the same tile", () => {
    const room = createRoom({ name: "W2N1", level: 3 });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    const controllerContainer = createStructure(room, STRUCTURE_CONTAINER, 25, 22) as MockStructure & {
      destroy: jest.Mock;
    };
    room.__structures.push(controllerContainer);
    Game.rooms[room.name] = room;

    setRoomPlannerLayout(room.name, {
      [STRUCTURE_STORAGE]: [{ x: 10, y: 10 }],
      [STRUCTURE_LINK]: [{ x: 25, y: 22 }],
    });

    runRoomPlannerConstruction();

    expect(controllerContainer.destroy).not.toHaveBeenCalled();
  });

  it("keeps proto source containers until a source link actually exists", () => {
    const room = createRoom({ name: "W2N2", level: 5 });
    room.__sources.push(createSource(room, 20, 20));
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    room.__structures.push(createStructure(room, STRUCTURE_TOWER, 11, 10));
    const sourceContainer = createStructure(room, STRUCTURE_CONTAINER, 19, 20) as MockStructure & {
      destroy: jest.Mock;
    };
    room.__structures.push(sourceContainer);
    Game.rooms[room.name] = room;

    setRoomPlannerLayout(room.name, {
      [STRUCTURE_LINK]: [{ x: 18, y: 20 }],
      work_pos: [{ x: 19, y: 20 }],
    });

    runRoomPlannerConstruction();

    expect(sourceContainer.destroy).not.toHaveBeenCalled();
  });

  it("places a proto controller container after rcl2 extensions even when storage is nearby", () => {
    const room = createRoom({ name: "W2N3", level: 2 });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    room.__structures.push(createStructure(room, STRUCTURE_EXTENSION, 11, 10));
    room.__structures.push(createStructure(room, STRUCTURE_EXTENSION, 12, 10));
    room.__structures.push(createStructure(room, STRUCTURE_EXTENSION, 13, 10));
    room.__structures.push(createStructure(room, STRUCTURE_EXTENSION, 14, 10));
    room.__structures.push(createStructure(room, STRUCTURE_EXTENSION, 15, 10));
    Game.rooms[room.name] = room;

    setRoomPlannerLayout(room.name, {
      [STRUCTURE_STORAGE]: [{ x: 23, y: 23 }],
      [STRUCTURE_LINK]: [{ x: 25, y: 22 }],
      [STRUCTURE_EXTENSION]: [
        { x: 11, y: 10 },
        { x: 12, y: 10 },
        { x: 13, y: 10 },
        { x: 14, y: 10 },
        { x: 15, y: 10 },
      ],
    });

    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual(expect.arrayContaining([
      { x: 23, y: 23, structureType: STRUCTURE_CONTAINER },
      { x: 25, y: 22, structureType: STRUCTURE_CONTAINER },
    ]));
  });
});

describe("runRoomPlannerConstruction link ordering", () => {
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

  it("keeps overlapping storage and controller links in their intended roles", () => {
    const room = createRoom({ name: "W3N1", level: 8 });
    room.__structures.push(createStructure(room, STRUCTURE_SPAWN, 10, 10));
    room.storage = createStructure(room, STRUCTURE_STORAGE, 20, 20) as unknown as StructureStorage;
    room.__structures.push(room.storage as unknown as MockStructure);
    room.controller.pos = new MockRoomPosition(20, 23, room.name) as RoomPosition;

    const farSource = createSource(room, 30, 30);
    const nearSource = createSource(room, 24, 20);
    room.__sources.push(farSource, nearSource);
    Game.rooms[room.name] = room;

    const storageLink = { x: 18, y: 20 };
    const controllerLink = { x: 22, y: 21 };
    const nearSourceLink = { x: 24, y: 19 };
    const farSourceLink = { x: 29, y: 30 };

    setRoomPlannerLayout(room.name, {
      [STRUCTURE_STORAGE]: [{ x: 20, y: 20 }],
      [STRUCTURE_LINK]: [storageLink, controllerLink, nearSourceLink, farSourceLink],
    });

    runRoomPlannerConstruction();
    Game.time = 200;
    runRoomPlannerConstruction();

    expect(room.__siteAttempts).toEqual([
      { ...storageLink, structureType: STRUCTURE_LINK },
      { ...farSourceLink, structureType: STRUCTURE_LINK },
      { ...nearSourceLink, structureType: STRUCTURE_LINK },
      { ...controllerLink, structureType: STRUCTURE_LINK },
    ]);
  });
});
