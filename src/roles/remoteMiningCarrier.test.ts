import { clearRemoteSafetyCacheForTest, remoteMiningCarrierRole } from "@/roles/remoteMiningCarrier";
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

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRuntimeServices();
  clearRemoteSafetyCacheForTest();
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

describe("partial withdrawal and maintenance", () => {

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

  it("explicit-source carrier uses its planned container position instead of a neighboring source container", () => {
    const source1Pos = makePos(5, 31, "W5N5");
    const source2Pos = makePos(6, 32, "W5N5");
    const source1 = { id: "src1", pos: source1Pos } as unknown as Source;
    const source2 = { id: "src2", pos: source2Pos } as unknown as Source;
    const source1Container = makeSourceContainer(1500, makePos(4, 32, "W5N5"));
    const source2Drop = {
      id: "drop-src2",
      resourceType: RESOURCE_ENERGY,
      amount: 1200,
      pos: makePos(5, 33, "W5N5"),
    } as unknown as Resource;
    const room = makeRoom("W5N5", { structures: [source1Container], droppedResources: [source2Drop] });
    const creep = makeCreep({ room, energy: 0, pos: makePos(5, 34, "W5N5") });

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return source1;
      if (id === "src2") return source2;
      return null;
    });
    Memory.data = {
      remoteMining: {
        W5N5: {
          sourceRoom: "W1N1",
          targetRoom: "W5N5",
          status: "active",
          sourceIds: ["src1", "src2"],
          containerPositions: {
            src1: { x: 4, y: 32, roomName: "W5N5" },
            src2: { x: 5, y: 33, roomName: "W5N5" },
          },
          assignedAt: 50,
          updatedAt: 50,
        },
      },
    } as Memory["data"];

    const result = remoteMiningCarrierRole("W5N5", "src2").source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(source1Container, RESOURCE_ENERGY);
    expect(creep.pickup).toHaveBeenCalledWith(source2Drop);
    expect(result).toBe(true);
  });
});

describe("container approach behavior", () => {
  it("assigned-source carrier idles near an empty container and clears stale pathing state", () => {
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
    expect(clearMovementState).toHaveBeenCalledWith(creep);
    expect(creep.move).not.toHaveBeenCalled();
  });
});

describe("source container construction site build", () => {

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
});

describe("retreats when suspended", () => {
  beforeEach(() => {
    Memory.data = {};
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
});

describe("per-tick scan deduplication across carriers", () => {
  beforeEach(() => {
    Memory.data = {};
  });

  it("does not repeat safety room.find scans when two carriers check the same visible remote room in one tick", () => {
    const containerPos = makePos(26, 25, "W5N5");
    const container = makeSourceContainer(1500, containerPos);
    const sourcePos = makePos(27, 25, "W5N5");
    const remoteRoom = makeRoom("W5N5", { structures: [container] });
    Game.rooms["W5N5"] = remoteRoom;

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

    const creep1 = makeCreep({ room: remoteRoom, energy: 0, name: "c1" });
    const creep2 = makeCreep({ room: remoteRoom, energy: 0, name: "c2" });

    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep1);
    remoteMiningCarrierRole("W5N5", "src-1").source?.(creep2);

    const findCalls = (remoteRoom.find as jest.Mock).mock.calls;
    const countType = (type: number) => findCalls.filter((c) => c[0] === type).length;

    expect(countType(FIND_HOSTILE_CREEPS)).toBeLessThanOrEqual(1);
    expect(countType(FIND_HOSTILE_STRUCTURES)).toBeLessThanOrEqual(1);
    expect(countType(FIND_STRUCTURES)).toBeLessThanOrEqual(1);
    expect(countType(FIND_CONSTRUCTION_SITES)).toBeLessThanOrEqual(1);
    expect(countType(FIND_DROPPED_RESOURCES)).toBeLessThanOrEqual(1);
  });
});
