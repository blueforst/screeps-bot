jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set<number>()),
}));

import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  getCreepAssignmentState,
  pruneDeadCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getDesiredWorkerCount } from "@/runtime/roomWorkforce";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import {
  assignWorkerTask,
  cleanupWorkerTaskBoard,
  clearWorkerTaskBoardForTest,
  getAssignedWorkerTaskId,
  getWorkerTasksByRoom,
  isWorkerTaskSafeForCreep,
  peekWorkerTaskBoard,
  refreshWorkerTasks,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import type { RoleName, WorkerTask } from "@/types/system";

type RuntimeGlobal = typeof global & {
  RoomPosition?: typeof MockRoomPosition;
  __runtimeServices?: unknown;
  __workerTaskBoard?: Record<string, Record<string, WorkerTask>>;
};

class MockRoomPosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}

  public getRangeTo(target: { x: number; y: number }): number {
    return Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y));
  }

  public findInRange(): never[] {
    return [];
  }
}

function createPos(roomName: string, x: number, y: number): RoomPosition {
  return new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
}

function createCreep(
  name: string,
  roomName: string,
  x = 25,
  y = 25,
  configName?: string,
): Creep {
  const room = (Game.rooms[roomName] || { name: roomName }) as Room;
  return {
    name,
    room,
    pos: createPos(roomName, x, y),
    memory: {
      configName,
      role: "worker",
    } as CreepMemory,
  } as Creep;
}

function createTask(
  id: string,
  roomName: string,
  targetId: string,
  overrides: Partial<WorkerTask> = {},
): WorkerTask {
  return {
    id,
    type: "build",
    targetId,
    roomName,
    priority: 300,
    assignedCreeps: [],
    maxAssignees: 1,
    status: "active",
    updatedAt: Game.time,
    ...overrides,
  };
}

function createTarget(id: string, roomName: string, x: number, y: number): RoomObject {
  return {
    id,
    pos: createPos(roomName, x, y),
    room: (Game.rooms[roomName] || { name: roomName }) as Room,
  } as unknown as RoomObject;
}

function publishTask(task: WorkerTask): WorkerTask {
  getWorkerTasksByRoom(task.roomName)[task.id] = task;
  return task;
}

function createOwnedRoom(
  name: string,
  options: {
    level?: number;
    structures?: Structure<StructureConstant>[];
    myStructures?: Structure<StructureConstant>[];
    constructionSites?: ConstructionSite[];
    storage?: StructureStorage;
  } = {},
): Room {
  const roomMemory = {} as RoomMemory;
  Memory.rooms[name] = roomMemory;
  const structures = options.structures || [];
  const myStructures = options.myStructures || [];
  const constructionSites = options.constructionSites || [];
  const controller = {
    id: `controller:${name}` as Id<StructureController>,
    my: true,
    level: options.level ?? 5,
    ticksToDowngrade: 20_000,
    pos: createPos(name, 25, 25),
  } as StructureController;

  const room = {
    name,
    memory: roomMemory,
    controller,
    storage: options.storage,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_STRUCTURES) return structures;
      if (type === FIND_MY_STRUCTURES) return myStructures;
      if (type === FIND_CONSTRUCTION_SITES) return constructionSites;
      if (type === FIND_MY_CREEPS) {
        return Object.values(Game.creeps).filter((creep) => creep.room.name === name);
      }
      return [];
    }),
  } as unknown as Room;

  (controller as StructureController & { room: Room }).room = room;
  Game.rooms[name] = room;
  return room;
}

function createConstructionSite(
  id: string,
  room: Room,
  x: number,
  y: number,
  overrides: Partial<ConstructionSite> = {},
): ConstructionSite {
  return {
    id: id as Id<ConstructionSite>,
    room,
    pos: createPos(room.name, x, y),
    structureType: STRUCTURE_EXTENSION,
    progress: 0,
    progressTotal: 3_000,
    ...overrides,
  } as ConstructionSite;
}

function createRampart(
  id: string,
  roomName: string,
  x: number,
  y: number,
  hits: number,
  hitsMax: number,
): StructureRampart {
  return {
    id: id as Id<StructureRampart>,
    structureType: STRUCTURE_RAMPART,
    my: true,
    hits,
    hitsMax,
    pos: createPos(roomName, x, y),
    room: (Game.rooms[roomName] || { name: roomName }) as Room,
  } as StructureRampart;
}

function createStructure(
  id: string,
  roomName: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  overrides: Record<string, unknown> = {},
): Structure<StructureConstant> {
  return {
    id: id as Id<Structure<StructureConstant>>,
    structureType,
    pos: createPos(roomName, x, y),
    room: (Game.rooms[roomName] || { name: roomName }) as Room,
    hits: 1_000,
    hitsMax: 1_000,
    destroy: jest.fn(() => OK),
    ...overrides,
  } as unknown as Structure<StructureConstant>;
}

describe("workerTaskPool legacy dispatch characterization", () => {
  let objects: Record<string, RoomObject>;

  beforeEach(() => {
    delete (global as RuntimeGlobal).__runtimeServices;
    clearCreepAssignmentStateForTest();
    clearWorkerTaskBoardForTest();
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set<number>());
    objects = {};
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => objects[id] || null,
    ) as unknown as Game["getObjectById"];
  });

  function configure(configName: string, role: RoleName, roomName: string): void {
    getCreepConfigService().upsert(configName, role, [], roomName);
  }

  function addCandidate(
    roomName: string,
    id: string,
    targetId: string,
    x: number,
    y: number,
    overrides: Partial<WorkerTask> = {},
  ): WorkerTask {
    objects[targetId] = createTarget(targetId, roomName, x, y);
    return publishTask(createTask(id, roomName, targetId, overrides));
  }

  it("routes ordinary workers to config home, colonizers to their physical room, and missing configs to the physical room", () => {
    configure("ordinary-config", "worker", "W1N1");
    configure("colonizer-config", "colonizerWorker", "W1N1");
    configure("cross-shard-config", "crossShardColonizerWorker", "W1N1");

    const homeTask = addCandidate("W1N1", "build:home", "home-target", 20, 20);
    const colonizerTask = addCandidate("W2N2", "build:colonizer", "colonizer-target", 20, 20);
    const crossShardTask = addCandidate("W3N3", "build:cross-shard", "cross-shard-target", 20, 20);
    const fallbackTask = addCandidate("W4N4", "build:fallback", "fallback-target", 20, 20);

    const ordinary = createCreep("Ordinary", "W9N9", 25, 25, "ordinary-config");
    const colonizer = createCreep("Colonizer", "W2N2", 25, 25, "colonizer-config");
    const crossShard = createCreep("CrossShard", "W3N3", 25, 25, "cross-shard-config");
    const fallback = createCreep("Fallback", "W4N4", 25, 25, "missing-config");
    Game.creeps = {
      [ordinary.name]: ordinary,
      [colonizer.name]: colonizer,
      [crossShard.name]: crossShard,
      [fallback.name]: fallback,
    };

    expect(assignWorkerTask(ordinary)).toBe(homeTask);
    expect(assignWorkerTask(colonizer)).toBe(colonizerTask);
    expect(assignWorkerTask(crossShard)).toBe(crossShardTask);
    expect(assignWorkerTask(fallback)).toBe(fallbackTask);
    expect(getAssignedWorkerTaskId(ordinary.name)).toBe(homeTask.id);
    expect(getAssignedWorkerTaskId(colonizer.name)).toBe(colonizerTask.id);
    expect(getAssignedWorkerTaskId(crossShard.name)).toBe(crossShardTask.id);
    expect(getAssignedWorkerTaskId(fallback.name)).toBe(fallbackTask.id);
  });

  it("lets priority dominate distance in the legacy score", () => {
    const creep = createCreep("Worker", "W1N1", 25, 25);
    Game.creeps[creep.name] = creep;
    const fartherHighPriority = addCandidate(
      "W1N1",
      "build:high",
      "far-target",
      45,
      45,
      { priority: 301 },
    );
    addCandidate("W1N1", "build:low", "near-target", 25, 26, { priority: 300 });

    expect(assignWorkerTask(creep)).toBe(fartherHighPriority);
  });

  it("uses distance when priorities match", () => {
    const creep = createCreep("Worker", "W1N1", 25, 25);
    Game.creeps[creep.name] = creep;
    addCandidate("W1N1", "build:far", "far-target", 35, 35);
    const nearer = addCandidate("W1N1", "build:near", "near-target", 25, 27);

    expect(assignWorkerTask(creep)).toBe(nearer);
  });

  it("applies the 120-point assigned penalty before choosing a slightly farther free task", () => {
    const existing = createCreep("Existing", "W1N1", 20, 20);
    const candidate = createCreep("Candidate", "W1N1", 25, 25);
    Game.creeps = { [existing.name]: existing, [candidate.name]: candidate };
    ensureCreepAssignmentState(existing.name).taskId = "build:occupied";

    const occupied = addCandidate(
      "W1N1",
      "build:occupied",
      "occupied-target",
      25,
      26,
      { assignedCreeps: [existing.name], maxAssignees: 2 },
    );
    const free = addCandidate("W1N1", "build:free", "free-target", 25, 33);

    expect(assignWorkerTask(candidate)).toBe(free);
    expect(occupied.assignedCreeps).toEqual([existing.name]);
  });

  it("keeps insertion order as the deterministic winner when scores tie", () => {
    const creep = createCreep("Worker", "W1N1", 25, 25);
    Game.creeps[creep.name] = creep;
    const first = addCandidate("W1N1", "build:first", "first-target", 24, 25);
    addCandidate("W1N1", "build:second", "second-target", 26, 25);

    expect(assignWorkerTask(creep)).toBe(first);
  });

  it("keeps an active sticky assignment, heals its inverse assignee list, and allows legacy sticky over-capacity", () => {
    const sticky = createCreep("Sticky", "W1N1", 25, 25);
    const existing = createCreep("Existing", "W1N1", 25, 25);
    const newcomer = createCreep("Newcomer", "W1N1", 25, 25);
    Game.creeps = {
      [sticky.name]: sticky,
      [existing.name]: existing,
      [newcomer.name]: newcomer,
    };
    ensureCreepAssignmentState(sticky.name).taskId = "build:sticky";
    ensureCreepAssignmentState(existing.name).taskId = "build:sticky";

    const stickyTask = addCandidate(
      "W1N1",
      "build:sticky",
      "sticky-target",
      30,
      30,
      { priority: 1, maxAssignees: 1, assignedCreeps: [existing.name] },
    );
    addCandidate("W1N1", "build:better", "better-target", 25, 26, { priority: 900 });

    expect(assignWorkerTask(sticky)).toBe(stickyTask);
    expect(stickyTask.assignedCreeps).toEqual([existing.name, sticky.name]);

    releaseWorkerTask(existing);
    releaseWorkerTask(sticky);
    delete getWorkerTasksByRoom("W1N1")["build:better"];
    ensureCreepAssignmentState(existing.name).taskId = stickyTask.id;
    stickyTask.assignedCreeps = [existing.name];

    expect(assignWorkerTask(newcomer)).toBeNull();
    expect(getAssignedWorkerTaskId(newcomer.name)).toBeUndefined();
  });

  it("releases an unsafe sticky task during defense and selects only an in-zone task", () => {
    const creep = createCreep("Worker", "W1N1", 25, 25);
    Game.creeps[creep.name] = creep;
    const outside = addCandidate(
      "W1N1",
      "build:outside",
      "outside-target",
      10,
      10,
      { priority: 900, assignedCreeps: [creep.name] },
    );
    const inside = addCandidate("W1N1", "build:inside", "inside-target", 20, 20, { priority: 100 });
    ensureCreepAssignmentState(creep.name).taskId = outside.id;
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    (getSafeZone as jest.Mock).mockReturnValue(new Set([20 * 50 + 20]));

    expect(isWorkerTaskSafeForCreep(creep, outside)).toBe(false);
    expect(isWorkerTaskSafeForCreep(creep, inside)).toBe(true);
    expect(assignWorkerTask(creep)).toBe(inside);
    expect(outside.assignedCreeps).toEqual([]);
    expect(inside.assignedCreeps).toEqual([creep.name]);
    expect(getAssignedWorkerTaskId(creep.name)).toBe(inside.id);
  });
});

describe("workerTaskPool legacy refresh and cleanup characterization", () => {
  let objects: Record<string, RoomObject>;

  beforeEach(() => {
    delete (global as RuntimeGlobal).__runtimeServices;
    clearCreepAssignmentStateForTest();
    clearWorkerTaskBoardForTest();
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set<number>());
    objects = {};
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => objects[id] || null,
    ) as unknown as Game["getObjectById"];
  });

  function registerRoomTargets(room: Room): void {
    if (room.controller) {
      objects[room.controller.id] = room.controller;
    }
    for (const structure of room.find(FIND_STRUCTURES)) {
      objects[structure.id] = structure;
    }
    for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
      objects[site.id] = site;
    }
  }

  it("refreshes only every third tick and leaves a reset board empty until the next refresh tick", () => {
    Game.time = 3;
    const sites: ConstructionSite[] = [];
    const room = createOwnedRoom("W1N1", { level: 5, constructionSites: sites });
    const site = createConstructionSite("site", room, 20, 20);
    sites.push(site);
    registerRoomTargets(room);

    refreshWorkerTasks();
    expect(getWorkerTasksByRoom(room.name)["build:site"]).toBeDefined();

    clearWorkerTaskBoardForTest();
    Game.time = 4;
    refreshWorkerTasks();
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();
    expect(peekWorkerTaskBoard()).toEqual({});

    Game.time = 6;
    refreshWorkerTasks();
    expect(getWorkerTasksByRoom(room.name)["build:site"]).toMatchObject({
      id: "build:site",
      updatedAt: 6,
    });
  });

  it("stable-upserts the same task object and preserves a live slot while refreshing mutable fields", () => {
    Game.time = 3;
    const sites: ConstructionSite[] = [];
    const room = createOwnedRoom("W1N1", { level: 5, constructionSites: sites });
    const site = createConstructionSite("site", room, 20, 20, {
      progress: 500,
      progressTotal: 3_000,
    });
    sites.push(site);
    registerRoomTargets(room);

    refreshWorkerTasks();
    const original = getWorkerTasksByRoom(room.name)["build:site"];
    const creep = createCreep("Worker", room.name);
    Game.creeps[creep.name] = creep;
    ensureCreepAssignmentState(creep.name).taskId = original.id;
    original.assignedCreeps = [creep.name];

    (site as ConstructionSite & { progress: number }).progress = 1_500;
    Game.time = 6;
    refreshWorkerTasks();

    const refreshed = getWorkerTasksByRoom(room.name)[original.id];
    expect(refreshed).toBe(original);
    expect(refreshed).toMatchObject({ requiredWork: 1_500, updatedAt: 6 });
    expect(refreshed.assignedCreeps).toEqual([creep.name]);
    expect(getAssignedWorkerTaskId(creep.name)).toBe(original.id);
  });

  it("keeps the assigned normal rampart target sticky even after another candidate becomes weaker", () => {
    Game.time = 3;
    const structures: Structure<StructureConstant>[] = [];
    const myStructures: Structure<StructureConstant>[] = [];
    const room = createOwnedRoom("W1N1", { level: 5, structures, myStructures });
    const rampartA = createRampart("rampart-a", room.name, 20, 20, 7_000, 10_000);
    const rampartB = createRampart("rampart-b", room.name, 21, 20, 8_000, 10_000);
    (rampartA as StructureRampart & { room: Room }).room = room;
    (rampartB as StructureRampart & { room: Room }).room = room;
    structures.push(rampartA, rampartB);
    myStructures.push(rampartA, rampartB);
    registerRoomTargets(room);

    refreshWorkerTasks();
    const original = getWorkerTasksByRoom(room.name)["repair:rampart-a"];
    const creep = createCreep("Worker", room.name);
    Game.creeps[creep.name] = creep;
    ensureCreepAssignmentState(creep.name).taskId = original.id;
    original.assignedCreeps = [creep.name];

    (rampartA as StructureRampart & { hits: number }).hits = 9_000;
    (rampartB as StructureRampart & { hits: number }).hits = 6_500;
    Game.time = 6;
    refreshWorkerTasks();

    const tasks = getWorkerTasksByRoom(room.name);
    expect(tasks[original.id]).toBe(original);
    expect(tasks[original.id]).toMatchObject({
      targetId: rampartA.id,
      requiredWork: 1_000,
      repairMode: "normal",
    });
    expect(tasks[`repair:${rampartB.id}`]).toBeUndefined();
    expect(tasks[original.id].assignedCreeps).toEqual([creep.name]);
  });

  it("separately removes non-owned room stores, dead inverse assignees, and dead actor sidecars", () => {
    Game.time = 3;
    const sites: ConstructionSite[] = [];
    const room = createOwnedRoom("W1N1", { constructionSites: sites });
    const site = createConstructionSite("site", room, 20, 20);
    sites.push(site);
    registerRoomTargets(room);
    refreshWorkerTasks();

    const task = getWorkerTasksByRoom(room.name)["build:site"];
    task.assignedCreeps = ["DeadWorker"];
    ensureCreepAssignmentState("DeadWorker").taskId = task.id;
    getWorkerTasksByRoom("W9N9")["build:abandoned"] = createTask(
      "build:abandoned",
      "W9N9",
      "missing-target",
    );

    Game.time = 6;
    refreshWorkerTasks();

    expect(task.assignedCreeps).toEqual([]);
    expect(getCreepAssignmentState("DeadWorker")?.taskId).toBe(task.id);
    expect(cleanupWorkerTaskBoard(new Set([room.name]))).toBe(1);
    expect(peekWorkerTaskBoard()).toEqual({
      [room.name]: expect.objectContaining({ [task.id]: task }),
    });
    expect(pruneDeadCreepAssignmentState()).toBe(1);
    expect(getCreepAssignmentState("DeadWorker")).toBeUndefined();
  });

  it("keeps normal repair workforce +1 and illegal-structure cleanup as refresh side effects", () => {
    Game.time = 3;
    const structures: Structure<StructureConstant>[] = [];
    const myStructures: Structure<StructureConstant>[] = [];
    const storage = createStructure("storage", "W1N1", STRUCTURE_STORAGE, 25, 24, {
      my: true,
      store: {},
    }) as StructureStorage;
    const room = createOwnedRoom("W1N1", {
      level: 5,
      structures,
      myStructures,
      storage,
    });
    (storage as StructureStorage & { room: Room }).room = room;
    const tower = createStructure("tower", room.name, STRUCTURE_TOWER, 25, 25, { my: true }) as StructureTower;
    const rampart = createRampart("rampart", room.name, 20, 20, 7_000, 10_000);
    const plannedRoad = createStructure("planned-road", room.name, STRUCTURE_ROAD, 11, 11);
    const illegalRoad = createStructure("illegal-road", room.name, STRUCTURE_ROAD, 12, 12);
    for (const structure of [tower, rampart, plannedRoad, illegalRoad]) {
      (structure as Structure<StructureConstant> & { room: Room }).room = room;
    }
    structures.push(tower, rampart, plannedRoad, illegalRoad);
    myStructures.push(tower, rampart);
    Memory.data = {
      roomPlanner: {
        [room.name]: {
          savedAt: 101,
          timestamp: "characterization",
          layout: {
            [STRUCTURE_ROAD]: [{ x: 11, y: 11 }],
            [STRUCTURE_TOWER]: [{ x: 25, y: 25 }],
            [STRUCTURE_RAMPART]: [{ x: 20, y: 20 }],
          },
        },
      },
    } as Memory["data"];
    registerRoomTargets(room);

    refreshWorkerTasks();

    expect(getWorkerTasksByRoom(room.name)[`repair:${rampart.id}`]).toMatchObject({
      repairMode: "normal",
      priority: 320,
      status: "active",
    });
    expect(getDesiredWorkerCount(room)).toBe(2);
    expect(plannedRoad.destroy).not.toHaveBeenCalled();
    expect(illegalRoad.destroy).toHaveBeenCalledTimes(1);
    expect(Memory.runtime?.illegalStructureCleanup?.rooms?.[room.name]).toEqual({
      completedAt: 3,
      layoutSavedAt: 101,
    });

    Game.time = 6;
    refreshWorkerTasks();
    expect(illegalRoad.destroy).toHaveBeenCalledTimes(1);
  });
});
