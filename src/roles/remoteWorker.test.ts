import { remoteWorkerRole } from "@/roles/remoteWorker";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";

jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

const HOME_ROOM = "W1N1";
const TARGET_ROOM = "W2N1";
const TRAVEL_OPTS = { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 };

beforeEach(() => {
  jest.clearAllMocks();
  Game.rooms = {};
  Game.time = 100;
  Game.getObjectById = jest.fn(() => null) as any;
  (Game as Game & { map: GameMap }).map = {
    getRoomLinearDistance: jest.fn(() => 1),
    findRoute: jest.fn(() => [{ room: "W1N2", exit: FIND_EXIT_RIGHT }] as ReturnType<GameMap["findRoute"]>),
  } as unknown as GameMap;
  (global as typeof global & { RoomPosition: typeof RoomPosition }).RoomPosition = class RoomPositionMock {
    public x: number;
    public y: number;
    public roomName: string;
    public constructor(x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    }
    public getRangeTo(target: any): number {
      const tx = target.x !== undefined ? target.x : (target.pos?.x ?? 0);
      const ty = target.y !== undefined ? target.y : (target.pos?.y ?? 0);
      return Math.max(Math.abs(this.x - tx), Math.abs(this.y - ty));
    }
  } as unknown as typeof RoomPosition;
  Memory.data = {
    remoteMining: {
      [TARGET_ROOM]: {
        sourceRoom: HOME_ROOM,
        targetRoom: TARGET_ROOM,
        status: "active",
        sourceIds: ["src-1"],
        assignedAt: 50,
        updatedAt: 50,
      },
    },
  };
});

function createStore(resources: Partial<Record<ResourceConstant, number>>, capacity = 2000): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: (resource?: ResourceConstant) => {
      if (resource === undefined) {
        return Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
      }
      return resources[resource] || 0;
    },
    getFreeCapacity: (resource?: ResourceConstant) => {
      if (resource === undefined) {
        return capacity - Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
      }
      return capacity - (resources[resource] || 0);
    },
  } as unknown as StoreDefinition;
}

function makePos(x: number, y: number, roomName: string): RoomPosition {
  return {
    x, y, roomName,
    getRangeTo: jest.fn((target: any) => {
      if (!target) return 0;
      const tx = target.x !== undefined ? target.x : (target.pos?.x ?? 0);
      const ty = target.y !== undefined ? target.y : (target.pos?.y ?? 0);
      return Math.max(Math.abs(x - tx), Math.abs(y - ty));
    }),
  } as unknown as RoomPosition;
}

function makeRoom(
  name: string,
  opts: {
    structures?: any[];
    constructionSites?: any[];
    storage?: any;
    terminal?: any;
  } = {},
): Room {
  const structures = opts.structures || [];
  const constructionSites = opts.constructionSites || [];
  return {
    name,
    controller: { level: 7 } as any,
    energyCapacityAvailable: 5600,
    storage: opts.storage || null,
    terminal: opts.terminal || null,
    find: jest.fn((type: FindConstant, opts2?: { filter?: (s: any) => boolean }) => {
      let raw: any[];
      if (type === FIND_STRUCTURES) raw = structures;
      else if (type === FIND_CONSTRUCTION_SITES) raw = constructionSites;
      else raw = [];
      if (opts2?.filter) return raw.filter(opts2.filter);
      return raw;
    }),
    getTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
  } as unknown as Room;
}

function makeCreep(opts: {
  room: Room;
  energy: number;
  capacity?: number;
  pos?: RoomPosition;
  memory?: any;
  name?: string;
  ticksToLive?: number;
}): Creep {
  const capacity = opts.capacity ?? 600;
  return {
    name: opts.name || "rw-1",
    room: opts.room,
    pos: opts.pos || makePos(25, 25, opts.room.name),
    memory: opts.memory || { configName: `${HOME_ROOM}:remoteMine:${TARGET_ROOM}:worker:0` },
    store: createStore({ [RESOURCE_ENERGY]: opts.energy }, capacity),
    withdraw: jest.fn(() => OK),
    pickup: jest.fn(() => OK),
    transfer: jest.fn(() => OK),
    repair: jest.fn(() => OK),
    build: jest.fn(() => OK),
    move: jest.fn(() => OK),
    suicide: jest.fn(() => OK),
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === WORK ? 5 : part === CARRY ? 5 : 5),
    ticksToLive: opts.ticksToLive,
  } as unknown as Creep;
}

// ─── SOURCE PHASE ────────────────────────────────────────────────────

describe("remoteWorkerRole - source phase", () => {
  it("travels empty from home to remote room instead of filling from home storage", () => {
    const storage = {
      id: "storage-1",
      structureType: STRUCTURE_STORAGE,
      pos: makePos(15, 15, HOME_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 50000 }),
    } as unknown as StructureStorage;
    const homeRoom = makeRoom(HOME_ROOM, { storage });
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 0 });

    const result = remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, TARGET_ROOM, undefined, TRAVEL_OPTS);
    expect(result).toBe(false);
  });

  it("does not use terminal or storage in home room", () => {
    const storage = {
      id: "storage-1",
      structureType: STRUCTURE_STORAGE,
      pos: makePos(15, 15, HOME_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 50000 }),
    } as unknown as StructureStorage;
    const terminal = {
      id: "terminal-1",
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, HOME_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 20000 }),
    } as unknown as StructureTerminal;
    const homeRoom = makeRoom(HOME_ROOM, { storage, terminal });
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 0 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, TARGET_ROOM, undefined, TRAVEL_OPTS);
  });

  it("ignores home terminal surplus and travels empty to remote room", () => {
    const terminal = {
      id: "terminal-1",
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, HOME_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 15000 }),
    } as unknown as StructureTerminal;
    const homeRoom = makeRoom(HOME_ROOM, { terminal });
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 0 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 600);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, TARGET_ROOM, undefined, TRAVEL_OPTS);
  });

  it("does not cap home terminal withdrawal because it never withdraws from home terminal", () => {
    const terminal = {
      id: "terminal-1",
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, HOME_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 10050 }),
    } as unknown as StructureTerminal;
    const homeRoom = makeRoom(HOME_ROOM, { terminal });
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 0, capacity: 600 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 50);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, TARGET_ROOM, undefined, TRAVEL_OPTS);
  });

  it("does not use terminal when terminal energy is at or below 10000", () => {
    const terminal = {
      id: "terminal-1",
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, HOME_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 10000 }),
    } as unknown as StructureTerminal;
    const homeRoom = makeRoom(HOME_ROOM, { terminal });
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 0 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it("returns true (switch to target) when full", () => {
    const homeRoom = makeRoom(HOME_ROOM);
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 600 });

    const result = remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(result).toBe(true);
  });

  it("switches to target after carrying any remote-room energy instead of filling to capacity", () => {
    const remoteRoom = makeRoom(TARGET_ROOM);
    Game.rooms[TARGET_ROOM] = remoteRoom;
    const creep = makeCreep({ room: remoteRoom, energy: 130, capacity: 600 });

    const result = remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(result).toBe(true);
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.pickup).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("withdraws from remote source containers", () => {
    const containerPos = makePos(26, 25, TARGET_ROOM);
    const container = {
      id: "container-1",
      structureType: STRUCTURE_CONTAINER,
      pos: containerPos,
      store: createStore({ [RESOURCE_ENERGY]: 1500 }),
      hits: 200000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const remoteRoom = makeRoom(TARGET_ROOM, { structures: [container] });
    Game.rooms[TARGET_ROOM] = remoteRoom;
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: makePos(27, 25, TARGET_ROOM), id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
  });

  it("picks up dropped energy near remote sources", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const dropped = {
      id: "drop-1",
      resourceType: RESOURCE_ENERGY,
      amount: 300,
      pos: makePos(26, 25, TARGET_ROOM),
    } as unknown as Resource;
    const remoteRoom = {
      ...makeRoom(TARGET_ROOM),
      find: jest.fn((type: FindConstant, opts2?: { filter?: (s: any) => boolean }) => {
        const raw = type === FIND_DROPPED_RESOURCES ? [dropped] : [];
        if (opts2?.filter) return raw.filter(opts2.filter);
        return raw;
      }),
    } as unknown as Room;
    Game.rooms[TARGET_ROOM] = remoteRoom;
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.pickup).toHaveBeenCalledWith(dropped);
  });

  it("prefers a large dropped energy pile over a nearly empty source container", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const container = {
      id: "container-1",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(26, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 130 }),
      hits: 200000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const dropped = {
      id: "drop-1",
      resourceType: RESOURCE_ENERGY,
      amount: 2460,
      pos: makePos(26, 25, TARGET_ROOM),
    } as unknown as Resource;
    const remoteRoom = {
      ...makeRoom(TARGET_ROOM, { structures: [container] }),
      find: jest.fn((type: FindConstant, opts2?: { filter?: (s: any) => boolean }) => {
        const raw = type === FIND_STRUCTURES
          ? [container]
          : type === FIND_DROPPED_RESOURCES
            ? [dropped]
            : [];
        if (opts2?.filter) return raw.filter(opts2.filter);
        return raw;
      }),
    } as unknown as Room;
    Game.rooms[TARGET_ROOM] = remoteRoom;
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(creep.pickup).toHaveBeenCalledWith(dropped);
    expect(creep.withdraw).not.toHaveBeenCalledWith(container, RESOURCE_ENERGY);
  });

  it("clears stale movement state when no remote energy is available", () => {
    const remoteRoom = makeRoom(TARGET_ROOM);
    Game.rooms[TARGET_ROOM] = remoteRoom;
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: makePos(27, 25, TARGET_ROOM), id: "src-1" };
      return null;
    });
    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    const result = remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(result).toBe(false);
    expect(clearMovementState).toHaveBeenCalledWith(creep);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.pickup).not.toHaveBeenCalled();
  });
});

// ─── TARGET PHASE: TRAVEL ────────────────────────────────────────────

describe("remoteWorkerRole - target phase travel", () => {
  it("travels to target room when not there", () => {
    const homeRoom = makeRoom(HOME_ROOM);
    Game.rooms[HOME_ROOM] = homeRoom;
    const creep = makeCreep({ room: homeRoom, energy: 600 });

    const result = remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, TARGET_ROOM, undefined, TRAVEL_OPTS);
    expect(result).toBe(false);
  });
});

// ─── TARGET PHASE: BUILD SOURCE CONTAINER SITES ──────────────────────

describe("remoteWorkerRole - builds source container site only", () => {
  it("builds source container construction site near remote source", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, TARGET_ROOM),
    } as unknown as ConstructionSite;
    const remoteRoom = makeRoom(TARGET_ROOM, { constructionSites: [containerSite] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    const result = remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.build).toHaveBeenCalledWith(containerSite);
    expect(result).toBe(false);
  });

  it("builds planned road construction sites but ignores unplanned road sites", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const plannedRoadSite = {
      id: "road-site-planned",
      structureType: STRUCTURE_ROAD,
      my: true,
      pos: makePos(24, 25, TARGET_ROOM),
    } as unknown as ConstructionSite;
    const unplannedRoadSite = {
      id: "road-site-unplanned",
      structureType: STRUCTURE_ROAD,
      my: true,
      pos: makePos(25, 25, TARGET_ROOM),
    } as unknown as ConstructionSite;
    const remoteRoom = makeRoom(TARGET_ROOM, { constructionSites: [plannedRoadSite, unplannedRoadSite] });
    Game.rooms[TARGET_ROOM] = remoteRoom;
    Memory.data!.remoteMining![TARGET_ROOM].roadPlan = {
      positions: [{ x: 24, y: 25, roomName: TARGET_ROOM }],
      generatedAt: Game.time,
    };

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.build).toHaveBeenCalledWith(plannedRoadSite);
    expect(creep.build).not.toHaveBeenCalledWith(unplannedRoadSite);
  });

  it("moves toward source container site when out of range", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, TARGET_ROOM),
    } as unknown as ConstructionSite;
    const remoteRoom = makeRoom(TARGET_ROOM, { constructionSites: [containerSite] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creepPos = makePos(35, 35, TARGET_ROOM);
    const creep = makeCreep({ room: remoteRoom, energy: 600, pos: creepPos });

    remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, containerSite, 3);
  });
});

// ─── TARGET PHASE: REPAIR SOURCE CONTAINERS ──────────────────────────

describe("remoteWorkerRole - repairs damaged source container", () => {
  it("repairs critically damaged source containers before planned roads", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const criticalContainer = {
      id: "container-critical",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(26, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 70000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const plannedRoadSite = {
      id: "road-site-planned",
      structureType: STRUCTURE_ROAD,
      my: true,
      pos: makePos(25, 25, TARGET_ROOM),
    } as unknown as ConstructionSite;
    const remoteRoom = makeRoom(TARGET_ROOM, {
      structures: [criticalContainer],
      constructionSites: [plannedRoadSite],
    });
    Game.rooms[TARGET_ROOM] = remoteRoom;
    Memory.data!.remoteMining![TARGET_ROOM].roadPlan = {
      positions: [{ x: 25, y: 25, roomName: TARGET_ROOM }],
      generatedAt: Game.time,
    };
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.repair).toHaveBeenCalledWith(criticalContainer);
    expect(creep.build).not.toHaveBeenCalledWith(plannedRoadSite);
  });

  it("repairs damaged source container", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const container = {
      id: "container-1",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(26, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 70000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const remoteRoom = makeRoom(TARGET_ROOM, { structures: [container] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    const result = remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.repair).toHaveBeenCalledWith(container);
    expect(result).toBe(false);
  });

  it("prioritizes lowest hit ratio container for repair", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const worseContainer = {
      id: "container-worse",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(26, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 50000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const betterContainer = {
      id: "container-better",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(28, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 150000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const remoteRoom = makeRoom(TARGET_ROOM, { structures: [worseContainer, betterContainer] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.repair).toHaveBeenCalledWith(worseContainer);
    expect(creep.repair).not.toHaveBeenCalledWith(betterContainer);
  });

  it("does NOT repair road structures", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const road = {
      id: "road-1",
      structureType: STRUCTURE_ROAD,
      pos: makePos(25, 25, TARGET_ROOM),
      hits: 100,
      hitsMax: 5000,
    } as unknown as StructureRoad;
    const container = {
      id: "container-1",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(26, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 70000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const remoteRoom = makeRoom(TARGET_ROOM, { structures: [road, container] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.repair).toHaveBeenCalledWith(container);
    expect(creep.repair).not.toHaveBeenCalledWith(road);
  });
});

// ─── TARGET PHASE: RETIREMENT ────────────────────────────────────────

describe("remoteWorkerRole - retirement", () => {
  it("returns home when no work in remote room and has energy", () => {
    const remoteRoom = makeRoom(TARGET_ROOM);
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn(() => null);

    const creep = makeCreep({ room: remoteRoom, energy: 300 });

    const result = remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, HOME_ROOM, undefined, TRAVEL_OPTS);
    expect(result).toBe(false);
  });

  it("travels to remote room when empty in home room", () => {
    const homeRoom = makeRoom(HOME_ROOM);
    Game.rooms[HOME_ROOM] = homeRoom;

    const creep = makeCreep({ room: homeRoom, energy: 0 });
    (creep as any).suicide = jest.fn();

    const result = remoteWorkerRole(TARGET_ROOM).target(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, TARGET_ROOM, undefined, TRAVEL_OPTS);
    expect(result).toBe(false);
  });

  it("returns true to switch to source when empty in remote room", () => {
    const remoteRoom = makeRoom(TARGET_ROOM);
    Game.rooms[TARGET_ROOM] = remoteRoom;

    const creep = makeCreep({ room: remoteRoom, energy: 0 });
    (creep as any).suicide = jest.fn();

    const result = remoteWorkerRole(TARGET_ROOM).target(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

// ─── SCOPE VERIFICATION ──────────────────────────────────────────────

describe("remoteWorkerRole - scope verification", () => {
  it("ignores unplanned roads - no repair, no build", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const road = {
      id: "road-1",
      structureType: STRUCTURE_ROAD,
      pos: makePos(25, 25, TARGET_ROOM),
      hits: 50,
      hitsMax: 5000,
    } as unknown as StructureRoad;
    const roadSite = {
      id: "road-site-1",
      structureType: STRUCTURE_ROAD,
      my: true,
      pos: makePos(24, 25, TARGET_ROOM),
    } as unknown as ConstructionSite;
    const remoteRoom = makeRoom(TARGET_ROOM, { structures: [road], constructionSites: [roadSite] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });

    remoteWorkerRole(TARGET_ROOM).target(creep);

    expect(creep.repair).not.toHaveBeenCalledWith(road);
    expect(creep.build).not.toHaveBeenCalledWith(roadSite);
  });
});
