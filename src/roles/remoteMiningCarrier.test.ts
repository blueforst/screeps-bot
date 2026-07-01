import { remoteMiningCarrierRole } from "@/roles/remoteMiningCarrier";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  Game.rooms = {};
  Game.time = 100;
  (Game as Game & { map: GameMap }).map = {
    getRoomLinearDistance: jest.fn(() => 1),
    findRoute: jest.fn(() => [{ room: "W5N5", exit: FIND_EXIT_LEFT }] as ReturnType<GameMap["findRoute"]>),
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

function makeRoom(name: string, opts: { structures?: any[]; droppedResources?: any[]; constructionSites?: any[]; lookData?: Record<string, { creeps?: any[]; structures?: any[]; sites?: any[] }> } = {}): Room {
  const structures = opts.structures || [];
  const droppedResources = opts.droppedResources || [];
  const constructionSites = opts.constructionSites || [];
  const lookData = opts.lookData || {};
  return {
    name,
    find: jest.fn((type: FindConstant, opts?: { filter?: (s: any) => boolean }) => {
      let raw: any[];
      if (type === FIND_STRUCTURES) raw = structures;
      else if (type === FIND_DROPPED_RESOURCES) raw = droppedResources;
      else if (type === FIND_CONSTRUCTION_SITES) raw = constructionSites;
      else raw = [];
      if (opts?.filter) return raw.filter(opts.filter);
      return raw;
    }),
    getTerrain: jest.fn(() => ({
      get: jest.fn(() => 0),
    })),
    lookForAt: jest.fn((type: LookConstant, xOrPos: any, y?: number) => {
      const px = typeof xOrPos === "number" ? xOrPos : xOrPos.x;
      const py = typeof xOrPos === "number" ? y! : xOrPos.y;
      const key = `${px},${py}`;
      const entry = lookData[key];
      if (!entry) return [];
      if (type === LOOK_CREEPS) return entry.creeps || [];
      if (type === LOOK_STRUCTURES) return entry.structures || [];
      if (type === LOOK_CONSTRUCTION_SITES) return entry.sites || [];
      return [];
    }),
  } as unknown as Room;
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

function makeSourceContainer(energy: number, pos: RoomPosition): StructureContainer {
  return {
    id: "container-1" as Id<StructureContainer>,
    structureType: STRUCTURE_CONTAINER,
    pos,
    store: createStore({ [RESOURCE_ENERGY]: energy }),
    hits: 200000,
    hitsMax: 250000,
  } as unknown as StructureContainer;
}

function makeCreep(opts: {
  room: Room;
  energy: number;
  capacity?: number;
  memory?: any;
  pos?: RoomPosition;
  name?: string;
}): Creep {
  const capacity = opts.capacity ?? 800;
  const energy = opts.energy;
  return {
    name: opts.name || "rmc-1",
    room: opts.room,
    pos: opts.pos || makePos(25, 25, opts.room.name),
    memory: opts.memory || { configName: "W1N1:remoteMine:W5N5:carrier:src1" },
    store: createStore({ [RESOURCE_ENERGY]: energy }, capacity),
    withdraw: jest.fn(() => OK),
    pickup: jest.fn(() => OK),
    transfer: jest.fn(() => OK),
    repair: jest.fn(() => OK),
    build: jest.fn(() => OK),
    move: jest.fn(() => OK),
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === WORK ? 1 : 0),
  } as unknown as Creep;
}

describe("remoteMiningCarrierRole - source phase", () => {
  it("travels to target room when not there yet", () => {
    const room = makeRoom("W1N1");
    const creep = makeCreep({ room, energy: 0 });

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W5N5", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
  });

  it("returns true when full", () => {
    const room = makeRoom("W5N5");
    const creep = makeCreep({ room, energy: 800 });

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(true);
  });

  it("withdraws from source container when in range", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(1500, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });
    let carried = 0;
    const creep = makeCreep({ room, energy: 0 });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn(() => carried);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.withdraw = jest.fn(() => { carried = 800; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(result).toBe(true);
  });

  it("picks up dropped energy near source when no container", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const dropPos = makePos(27, 26, "W5N5");
    const dropped = {
      id: "drop-1",
      resourceType: RESOURCE_ENERGY,
      amount: 200,
      pos: dropPos,
    } as unknown as Resource;
    const room = makeRoom("W5N5", { droppedResources: [dropped] });
    let carried = 0;
    const creep = makeCreep({ room, energy: 0 });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn(() => carried);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.pickup = jest.fn(() => { carried = 800; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.pickup).toHaveBeenCalledWith(dropped);
    expect(result).toBe(true);
  });
});

describe("partial withdrawal and maintenance", () => {
  it("explicit-source carrier withdraws partial from low-energy container and returns for delivery", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(50, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    let carried = 0;
    const creep = makeCreep({ room, energy: 0 });
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === undefined ? carried : (r === RESOURCE_ENERGY ? carried : 0));
    creep.withdraw = jest.fn(() => { carried = 50; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result1 = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result1).toBe(true);
    expect(creep.withdraw).toHaveBeenCalled();
  });

  it("runs maintenance with surplus energy after withdraw", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(50, containerPos);
    const road = {
      id: "road-1",
      structureType: STRUCTURE_ROAD,
      pos: makePos(25, 26, "W5N5"),
      hits: 1000,
      hitsMax: 5000,
    } as unknown as StructureRoad;
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container, road] });

    const creep = makeCreep({ room, energy: 200 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.repair).toHaveBeenCalledWith(road);
  });

  it("does not repair when carrying at or below reserve", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(50, containerPos);
    const road = {
      id: "road-1",
      structureType: STRUCTURE_ROAD,
      pos: makePos(25, 26, "W5N5"),
      hits: 1000,
      hitsMax: 5000,
    } as unknown as StructureRoad;
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container, road] });

    const creep = makeCreep({ room, energy: 100 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.repair).not.toHaveBeenCalled();
  });

  it("explicit-source carrier withdraws from partial-energy container and returns for delivery", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(10, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    const creep = makeCreep({ room, energy: 50, memory: {
      configName: "W1N1:remoteMine:W5N5:carrier:src1",
    } });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(true);
  });

  it("explicit-source carrier at range 1 withdraws from partial container and returns for delivery", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(10, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    const creepPos = makePos(25, 25, "W5N5");
    const creep = makeCreep({ room, energy: 0, pos: creepPos });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(true);
  });

  it("explicit-source carrier with enough energy still withdraws and returns for delivery", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(800, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });
    let carried = 0;
    const creep = makeCreep({ room, energy: 0, pos: makePos(25, 25, "W5N5") });
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === undefined ? carried : (r === RESOURCE_ENERGY ? carried : 0));
    creep.withdraw = jest.fn(() => { carried = 800; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(result).toBe(true);
  });

  it("explicit-source carrier with energy returns for delivery when container is empty", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(0, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    const creepPos = makePos(30, 25, "W5N5");
    const creep = makeCreep({
      room,
      energy: 50,
      pos: creepPos,
      memory: {
        configName: "W1N1:remoteMine:W5N5:carrier:src1",
      },
    });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(true);
    const containerCalls = (moveToTarget as jest.Mock).mock.calls.filter(
      (call: any[]) => call[1] === container,
    );
    expect(containerCalls).toHaveLength(0);
  });

  it("explicit-source carrier idles near empty container when carrying no energy", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(0, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    const creepPos = makePos(25, 25, "W5N5");
    const creep = makeCreep({
      room,
      energy: 0,
      pos: creepPos,
      memory: {
        configName: "W1N1:remoteMine:W5N5:carrier:src1",
      },
    });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(false);
  });

  it("dynamic-source carrier approaches partial container to withdraw when out of range", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(10, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const source1 = { id: "src1", pos: sourcePos } as unknown as Source;
    const room = makeRoom("W5N5", { structures: [container] });

    const creepPos = makePos(30, 25, "W5N5");
    const creep = makeCreep({
      room,
      energy: 0,
      pos: creepPos,
      memory: {
        configName: "W1N1:remoteMine:W5N5:carrier:0",
        _rmcSelectedSource: "src1",
      },
    });
    creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return source1;
      return null;
    });

    Memory.data = {
      remoteMining: {
        W5N5: {
          sourceRoom: "W1N1",
          targetRoom: "W5N5",
          status: "active",
          sourceIds: ["src1"],
          assignedAt: 50,
          updatedAt: 50,
        },
      },
    };

    const result = remoteMiningCarrierRole("W5N5").source?.(creep);

    expect(result).toBe(false);
    expect(moveToTarget).toHaveBeenCalledWith(creep, container, 1);
  });

  it("dynamic-source carrier withdraws partial and returns for delivery", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(10, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const source1 = { id: "src1", pos: sourcePos } as unknown as Source;
    const room = makeRoom("W5N5", { structures: [container] });

    const creep = makeCreep({ room, energy: 50, memory: {
      configName: "W1N1:remoteMine:W5N5:carrier:0",
      _rmcSelectedSource: "src1",
    } });

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return source1;
      return null;
    });

    Memory.data = {
      remoteMining: {
        W5N5: {
          sourceRoom: "W1N1",
          targetRoom: "W5N5",
          status: "active",
          sourceIds: ["src1"],
          assignedAt: 50,
          updatedAt: 50,
        },
      },
    };

    const result = remoteMiningCarrierRole("W5N5").source?.(creep);

    expect(result).toBe(true);
  });

  it("builds nearby road construction site after withdraw", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(50, containerPos);
    container.hits = container.hitsMax;
    const sourcePos = makePos(27, 25, "W5N5");
    const site = {
      id: "site-1",
      structureType: STRUCTURE_ROAD,
      my: true,
      pos: makePos(25, 26, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { structures: [container], constructionSites: [site] });

    const creep = makeCreep({ room, energy: 200 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.build).toHaveBeenCalledWith(site);
  });
});

describe("container approach behavior", () => {
  it("assigned-source carrier does not approach an empty container when carrying no energy", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(0, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    const creepPos = makePos(29, 25, "W5N5");
    const creep = makeCreep({ room, energy: 0, pos: creepPos });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(false);
    const containerCalls = (moveToTarget as jest.Mock).mock.calls.filter(
      (call: any[]) => call[1] === container,
    );
    expect(containerCalls).toHaveLength(0);
    expect(creep.move).not.toHaveBeenCalled();
  });

  it("assigned-source carrier still approaches a usable container when out of withdraw range", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(800, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });

    const creepPos = makePos(29, 25, "W5N5");
    const creep = makeCreep({ room, energy: 0, pos: creepPos });
    creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(false);
    expect(moveToTarget).toHaveBeenCalledWith(creep, container, 1);
  });
});

describe("source container construction site build", () => {
  it("builds container construction site near assigned source when no built container exists", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { constructionSites: [containerSite] });

    const creep = makeCreep({ room, energy: 200 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.build).toHaveBeenCalledWith(containerSite);
  });

  it("prioritizes build over pickup when carrier has surplus energy and both dropped energy and container site exist", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as ConstructionSite;
    const dropped = {
      id: "drop-1",
      resourceType: RESOURCE_ENERGY,
      amount: 200,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as Resource;
    const room = makeRoom("W5N5", { constructionSites: [containerSite], droppedResources: [dropped] });

    const creep = makeCreep({ room, energy: 200, pos: makePos(26, 25, "W5N5") });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.build).toHaveBeenCalledWith(containerSite);
    expect(creep.pickup).not.toHaveBeenCalled();
  });

  it("picks up dropped energy instead of building when at or below reserve energy", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as ConstructionSite;
    const dropped = {
      id: "drop-1",
      resourceType: RESOURCE_ENERGY,
      amount: 200,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as Resource;
    const room = makeRoom("W5N5", { constructionSites: [containerSite], droppedResources: [dropped] });

    let carried = 100;
    const creep = makeCreep({ room, energy: 100, pos: makePos(26, 25, "W5N5") });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === RESOURCE_ENERGY ? carried : 0);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.pickup = jest.fn(() => { carried = 300; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.pickup).toHaveBeenCalledWith(dropped);
  });

  it("moves toward container construction site when far from source with no container", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { constructionSites: [containerSite] });

    const creepPos = makePos(35, 25, "W5N5");
    const creep = makeCreep({ room, energy: 0, pos: creepPos });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, containerSite.pos, 2);
  });

  it("does not build container construction site when at or below reserve energy", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { constructionSites: [containerSite] });

    const creep = makeCreep({ room, energy: 100 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.build).not.toHaveBeenCalled();
  });

  it("does not build container construction site for unassigned source sites", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const otherSourcePos = makePos(10, 10, "W5N5");
    const otherContainerSite = {
      id: "csite-other",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(9, 10, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { constructionSites: [otherContainerSite] });

    const creep = makeCreep({ room, energy: 200 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.build).not.toHaveBeenCalled();
  });

  it("normal hauling not broken: returns true when full even with container site present", () => {
    const sourcePos = makePos(27, 25, "W5N5");
    const containerSite = {
      id: "csite-1",
      structureType: STRUCTURE_CONTAINER,
      my: true,
      pos: makePos(26, 25, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { constructionSites: [containerSite] });

    const creep = makeCreep({ room, energy: 800 });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(result).toBe(true);
    expect(creep.build).not.toHaveBeenCalled();
  });
});

describe("return maintenance", () => {
  it("repairs road while returning home with surplus energy", () => {
    const road = {
      id: "road-1",
      structureType: STRUCTURE_ROAD,
      pos: makePos(25, 26, "W5N5"),
      hits: 1000,
      hitsMax: 5000,
    } as unknown as StructureRoad;
    const room = makeRoom("W5N5", { structures: [road] });
    const creep = makeCreep({ room, energy: 500 });

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(creep.repair).toHaveBeenCalledWith(road);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
  });

  it("does not repair non-road/non-container structures", () => {
    const wall = {
      id: "wall-1",
      structureType: STRUCTURE_WALL,
      pos: makePos(25, 26, "W5N5"),
      hits: 1000,
      hitsMax: 5000,
    } as unknown as StructureWall;
    const room = makeRoom("W5N5", { structures: [wall] });
    const creep = makeCreep({ room, energy: 500 });

    remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(creep.repair).not.toHaveBeenCalled();
  });

  it("only issues one maintenance intent per tick", () => {
    const road = {
      id: "road-1",
      structureType: STRUCTURE_ROAD,
      pos: makePos(25, 26, "W5N5"),
      hits: 1000,
      hitsMax: 5000,
    } as unknown as StructureRoad;
    const site = {
      id: "site-1",
      structureType: STRUCTURE_ROAD,
      my: true,
      pos: makePos(25, 27, "W5N5"),
    } as unknown as ConstructionSite;
    const room = makeRoom("W5N5", { structures: [road], constructionSites: [site] });
    const creep = makeCreep({ room, energy: 500 });

    remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    const totalIntents = (creep.repair as jest.Mock).mock.calls.length + (creep.build as jest.Mock).mock.calls.length;
    expect(totalIntents).toBeLessThanOrEqual(1);
  });

  it("switches to source when empty", () => {
    const room = makeRoom("W1N1");
    const creep = makeCreep({ room, energy: 0 });

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(result).toBe(true);
  });
});

describe("terminal-before-storage delivery", () => {
  function makeHomeRoom(name: string): Room {
    const terminal = {
      id: "terminal-1",
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, name),
      store: createStore({}, 300000),
    } as unknown as StructureTerminal;

    const storage = {
      id: "storage-1",
      structureType: STRUCTURE_STORAGE,
      pos: makePos(15, 15, name),
      store: createStore({}, 1000000),
    } as unknown as StructureStorage;

    const room = {
      name,
      terminal,
      storage,
      find: jest.fn((_type: FindConstant) => []),
    } as unknown as Room;

    Game.rooms[name] = room;
    return room;
  }

  it("delivers to terminal first when available", () => {
    const homeRoom = makeHomeRoom("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 500 });
    const creepPos = makePos(20, 21, "W1N1");
    creep.pos = creepPos;

    remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(homeRoom.terminal, RESOURCE_ENERGY);
  });

  it("falls back to storage when terminal is full", () => {
    const homeRoom = makeHomeRoom("W1N1");
    (homeRoom.terminal!.store.getFreeCapacity as jest.Mock) = jest.fn(() => 0);
    const creep = makeCreep({ room: homeRoom, energy: 500 });
    const creepPos = makePos(15, 16, "W1N1");
    creep.pos = creepPos;

    remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(homeRoom.storage, RESOURCE_ENERGY);
  });

  it("travels home when not in home room", () => {
    const room = makeRoom("W5N5");
    const creep = makeCreep({ room, energy: 500 });

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
  });
});

describe("retreats when suspended", () => {
  beforeEach(() => {
    Memory.data = {};
  });

  it("source phase retreats toward home room when remote task is suspended", () => {
    const remoteRoom = makeRoom("W5N5");
    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "suspended",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 100,
        suspendReason: "hostile_creeps",
        suspendedAt: 100,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.repair).not.toHaveBeenCalled();
    expect(creep.build).not.toHaveBeenCalled();
  });

  it("source phase retreats when target room is visibly dangerous even if not suspended", () => {
    const dangerousRoom = makeRoom("W5N5");
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    (dangerousRoom.find as jest.Mock).mockImplementation((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      return [];
    });
    Game.rooms["W5N5"] = dangerousRoom;
    const creep = makeCreep({ room: dangerousRoom, energy: 0 });

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it("target phase does not switch to source when empty if remote is suspended (at home)", () => {
    const homeRoom = makeRoom("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 0 });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "suspended",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 100,
        suspendReason: "hostile_creeps",
        suspendedAt: 100,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(result).toBe(false);
  });

  it("target phase empty carrier in remote room retreats home when suspended", () => {
    const remoteRoom = makeRoom("W5N5");
    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "suspended",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 100,
        suspendReason: "hostile_creeps",
        suspendedAt: 100,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
  });

  it("target phase carrying carrier at home transfers to terminal when suspended", () => {
    const terminal = {
      id: "terminal-1" as Id<StructureTerminal>,
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, "W1N1"),
      store: createStore({}, 300000),
    } as unknown as StructureTerminal;
    const homeRoom = {
      name: "W1N1",
      terminal,
      storage: null,
      find: jest.fn(() => []),
    } as unknown as Room;
    Game.rooms["W1N1"] = homeRoom;

    const creep = makeCreep({ room: homeRoom, energy: 500, pos: makePos(20, 21, "W1N1") });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "suspended",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 100,
        suspendReason: "hostile_creeps",
        suspendedAt: 100,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(creep.repair).not.toHaveBeenCalled();
    expect(creep.build).not.toHaveBeenCalled();
  });

  it("target phase retreats toward home when carrying energy and remote is suspended", () => {
    const remoteRoom = makeRoom("W5N5");
    const creep = makeCreep({ room: remoteRoom, energy: 500 });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "suspended",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 100,
        suspendReason: "hostile_creeps",
        suspendedAt: 100,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
    expect(result).toBe(false);
    expect(creep.repair).not.toHaveBeenCalled();
    expect(creep.build).not.toHaveBeenCalled();
  });

  it("source phase does not retreat when target room has WORK-only hostile", () => {
    const remoteRoom = makeRoom("W5N5");
    const workHostile = {
      id: "hc-work",
      getActiveBodyparts: (part: BodyPartConstant) => part === WORK ? 3 : 0,
    } as unknown as Creep;
    (remoteRoom.find as jest.Mock).mockImplementation((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [workHostile];
      return [];
    });
    Game.rooms["W5N5"] = remoteRoom;
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(1500, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    (remoteRoom.find as jest.Mock).mockImplementation((type: number, opts?: any) => {
      if (type === FIND_HOSTILE_CREEPS) return [workHostile];
      if (type === FIND_STRUCTURES) {
        const all = [container];
        return opts?.filter ? all.filter(opts.filter) : all;
      }
      return [];
    });
    let carried = 0;
    const creep = makeCreep({ room: remoteRoom, energy: 0 });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn(() => carried);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.withdraw = jest.fn(() => { carried = 800; return OK; });
    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(creep.withdraw).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("source phase does not retreat when remote is active and safe", () => {
    const remoteRoom = makeRoom("W5N5");
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(1500, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    (remoteRoom.find as jest.Mock).mockImplementation((type: number) => {
      if (type === FIND_STRUCTURES) return [container];
      return [];
    });
    let carried = 0;
    const creep = makeCreep({ room: remoteRoom, energy: 0 });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn(() => carried);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.withdraw = jest.fn(() => { carried = 800; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(creep.withdraw).toHaveBeenCalled();
  });
});

describe("dynamic source selection (no sourceId)", () => {
  beforeEach(() => {
    Memory.data = {};
  });

  it("selects source with most energy when no sourceId provided", () => {
    const container1Pos = makePos(10, 10, "W5N5");
    const container1 = makeSourceContainer(1500, container1Pos);
    const source1 = { id: "src1", pos: makePos(10, 10, "W5N5") } as unknown as Source;
    const container2Pos = makePos(30, 30, "W5N5");
    const container2 = makeSourceContainer(200, container2Pos);
    const source2 = { id: "src2", pos: makePos(30, 30, "W5N5") } as unknown as Source;

    const room = makeRoom("W5N5", { structures: [container1, container2] });
    let carried = 0;
    const creep = makeCreep({ room, energy: 0 });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn(() => carried);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.withdraw = jest.fn(() => { carried = 800; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return source1;
      if (id === "src2") return source2;
      return null;
    });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1", "src2"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    const result = remoteMiningCarrierRole("W5N5").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container1, RESOURCE_ENERGY);
    expect(result).toBe(true);
  });

  it("updates _rmcSelectedSource when dynamic selected source changes", () => {
    const container1Pos = makePos(10, 10, "W5N5");
    const container1 = makeSourceContainer(1500, container1Pos);
    const source1 = { id: "src1", pos: makePos(10, 10, "W5N5") } as unknown as Source;
    const source2 = { id: "src2", pos: makePos(30, 30, "W5N5") } as unknown as Source;

    const room = makeRoom("W5N5", { structures: [container1] });
    const creep = makeCreep({
      room,
      energy: 0,
      memory: {
        configName: "W1N1:remoteMine:W5N5:carrier:0",
        _rmcSelectedSource: "src2",
      },
    });

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return source1;
      if (id === "src2") return source2;
      return null;
    });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1", "src2"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    remoteMiningCarrierRole("W5N5").source?.(creep);

    expect(creep.memory._rmcSelectedSource).toBe("src1");
  });

  it("clears _rmcSelectedSource when creep becomes full", () => {
    const source1 = { id: "src1", pos: makePos(10, 10, "W5N5") } as unknown as Source;
    const room = makeRoom("W5N5");
    const creep = makeCreep({
      room,
      energy: 800,
      memory: {
        configName: "W1N1:remoteMine:W5N5:carrier:0",
        _rmcSelectedSource: "src1",
      },
    });

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    const result = remoteMiningCarrierRole("W5N5").source?.(creep);

    expect(result).toBe(true);
    expect(creep.memory._rmcSelectedSource).toBeUndefined();
  });

  it("old [targetRoom, sourceId] args still work with explicit sourceId", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(1500, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const room = makeRoom("W5N5", { structures: [container] });
    let carried = 0;
    const creep = makeCreep({ room, energy: 0 });
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn(() => carried);
    (creep.store.getFreeCapacity as jest.Mock) = jest.fn(() => 800 - carried);
    creep.withdraw = jest.fn(() => { carried = 800; return OK; });

    (Game.getObjectById as jest.Mock) = jest.fn(() => ({ pos: sourcePos, id: "src-1" }));

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    const result = remoteMiningCarrierRole("W5N5", "src-1").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(result).toBe(true);
  });

  it("falls back to creep position when no sources are visible", () => {
    const room = makeRoom("W5N5");
    const creep = makeCreep({
      room,
      energy: 0,
      memory: {
        configName: "W1N1:remoteMine:W5N5:carrier:0",
      },
    });

    (Game.getObjectById as jest.Mock) = jest.fn(() => null);

    Memory.data!.remoteMining = {
      W5N5: {
        sourceRoom: "W1N1",
        targetRoom: "W5N5",
        status: "active",
        sourceIds: ["src1", "src2"],
        assignedAt: 50,
        updatedAt: 50,
      },
    };

    const result = remoteMiningCarrierRole("W5N5").source?.(creep);

    expect(result).toBe(false);
  });
});

describe("post-delivery suicide when TTL < 150", () => {
  function makeHomeRoomWithTerminal(name: string): Room {
    const terminal = {
      id: "terminal-1" as Id<StructureTerminal>,
      structureType: STRUCTURE_TERMINAL,
      pos: makePos(20, 20, name),
      store: createStore({}, 300000),
    } as unknown as StructureTerminal;

    const room = {
      name,
      terminal,
      storage: null,
      find: jest.fn(() => []),
    } as unknown as Room;

    Game.rooms[name] = room;
    return room;
  }

  it("suicides after successful delivery when TTL 149", () => {
    const homeRoom = makeHomeRoomWithTerminal("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 500, pos: makePos(20, 21, "W1N1") });
    let carried = 500;
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === RESOURCE_ENERGY ? carried : 0);
    creep.transfer = jest.fn(() => { carried = 0; return OK; });
    (creep as any).ticksToLive = 149;
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(homeRoom.terminal, RESOURCE_ENERGY);
    expect((creep as any).suicide).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("does NOT suicide when TTL 150", () => {
    const homeRoom = makeHomeRoomWithTerminal("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 500, pos: makePos(20, 21, "W1N1") });
    let carried = 500;
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === RESOURCE_ENERGY ? carried : 0);
    creep.transfer = jest.fn(() => { carried = 0; return OK; });
    (creep as any).ticksToLive = 150;
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("does NOT suicide when transfer leaves creep with energy", () => {
    const homeRoom = makeHomeRoomWithTerminal("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 500, pos: makePos(20, 21, "W1N1") });
    let carried = 500;
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === RESOURCE_ENERGY ? carried : 0);
    creep.transfer = jest.fn(() => ERR_NOT_ENOUGH_RESOURCES);
    (creep as any).ticksToLive = 100;
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("does NOT suicide when ticksToLive is undefined", () => {
    const homeRoom = makeHomeRoomWithTerminal("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 500, pos: makePos(20, 21, "W1N1") });
    let carried = 500;
    (creep.store.getUsedCapacity as jest.Mock) = jest.fn((r?: any) => r === RESOURCE_ENERGY ? carried : 0);
    creep.transfer = jest.fn(() => { carried = 0; return OK; });
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("does NOT suicide when not in range (moving to target)", () => {
    const homeRoom = makeHomeRoomWithTerminal("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 500, pos: makePos(25, 25, "W1N1") });
    creep.transfer = jest.fn(() => ERR_NOT_IN_RANGE);
    (creep as any).ticksToLive = 100;
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("suicides when entering target phase already empty at home with TTL 149", () => {
    const homeRoom = makeHomeRoomWithTerminal("W1N1");
    const creep = makeCreep({ room: homeRoom, energy: 0, pos: makePos(20, 21, "W1N1") });
    (creep as any).ticksToLive = 149;
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect((creep as any).suicide).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("does NOT suicide when entering target phase empty outside home room with low TTL", () => {
    const remoteRoom = makeRoom("W5N5");
    const creep = makeCreep({ room: remoteRoom, energy: 0 });
    (creep as any).ticksToLive = 100;
    (creep as any).suicide = jest.fn();

    const result = remoteMiningCarrierRole("W5N5", "src-1").target?.(creep);

    expect((creep as any).suicide).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
