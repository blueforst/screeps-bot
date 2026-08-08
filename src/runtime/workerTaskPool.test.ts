jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import {
  assignWorkerTask,
  clearWorkerTaskBoardForTest,
  completeWorkerTaskIfDone,
  getWorkerTasksByRoom,
  getWorkerTaskTarget,
  refreshWorkerTasks,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import type { WorkerTask } from "@/types/system";

type RuntimeGlobal = typeof global & {
  RoomPosition?: typeof MockRoomPosition;
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
}

function createPos(roomName: string, x = 25, y = 25): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: () => 1,
  } as unknown as RoomPosition;
}

function createControllerTarget(
  id: string,
  level: number,
  roomName = "W1N1",
  x = 25,
  y = 25,
): StructureController {
  return {
    id: id as Id<StructureController>,
    my: true,
    level,
    pos: createPos(roomName, x, y),
    room: { name: roomName } as Room,
  } as StructureController;
}

function createSource(id: string, x: number, y: number, roomName = "W1N1"): Source {
  return {
    id: id as Id<Source>,
    pos: createPos(roomName, x, y),
    room: { name: roomName } as Room,
  } as Source;
}

function createCreep(name: string, roomName: string, configName?: string): Creep {
  return {
    name,
    room: { name: roomName } as Room,
    memory: {
      configName,
    } as CreepMemory,
    pos: {
      getRangeTo: () => 1,
    } as unknown as RoomPosition,
  } as Creep;
}

function createRoomForRefresh(
  structures: Structure<StructureConstant>[],
  myStructures: Structure<StructureConstant>[] = [],
  sources: Source[] = [],
  constructionSites: ConstructionSite[] = [],
  controllerLevel = 3,
  ticksToDowngrade = 20_000,
): Room {
  return {
    name: "W1N1",
    controller: {
      id: "controller1" as Id<StructureController>,
      my: true,
      level: controllerLevel,
      ticksToDowngrade,
      pos: createPos("W1N1"),
    } as StructureController,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES) {
        return myStructures;
      }
      if (type === FIND_STRUCTURES) {
        return structures;
      }
      if (type === FIND_SOURCES) {
        return sources;
      }
      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }
      if (type === FIND_MY_CREEPS) {
        return [];
      }
      return [];
    }),
  } as unknown as Room;
}

function createStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  overrides: Record<string, unknown> = {},
): Structure<StructureConstant> {
  const room = { name: "W1N1" } as Room;
  return {
    id: id as Id<Structure<StructureConstant>>,
    structureType,
    room,
    pos: { x, y, roomName: "W1N1", getRangeTo: () => 1 } as unknown as RoomPosition,
    hits: 5000,
    hitsMax: 5000,
    destroy: jest.fn(() => OK),
    ...overrides,
  } as unknown as Structure<StructureConstant>;
}

function createTask(overrides: Partial<WorkerTask> & Pick<WorkerTask, "id" | "type" | "targetId" | "roomName">): WorkerTask {
  return {
    id: overrides.id,
    type: overrides.type,
    targetId: overrides.targetId,
    roomName: overrides.roomName,
    priority: overrides.priority ?? 300,
    assignedCreeps: overrides.assignedCreeps ?? [],
    maxAssignees: overrides.maxAssignees ?? 1,
    status: overrides.status ?? "active",
    updatedAt: overrides.updatedAt ?? Game.time,
    requiredWork: overrides.requiredWork,
    repairTargetHits: overrides.repairTargetHits,
    repairMode: overrides.repairMode,
  };
}

describe("workerTaskPool", () => {
  let objects: Record<string, { pos: RoomPosition }>;

  beforeEach(() => {
    clearCreepAssignmentStateForTest();
    clearWorkerTaskBoardForTest();
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set());
    objects = {};
    const getObjectById = jest.fn((id: string) => objects[id] || null) as unknown as Game["getObjectById"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = getObjectById;
  });

  function getIllegalStructureCleanupMemory(): { rooms?: Record<string, { completedAt: number; layoutSavedAt: number }> } | undefined {
    return (Memory.runtime as { illegalStructureCleanup?: { rooms?: Record<string, { completedAt: number; layoutSavedAt: number }> } } | undefined)
      ?.illegalStructureCleanup;
  }

  it.each([1, 2, 3, 4, 5, 6, 7])("keeps the generic upgrade task at RCL%i", (controllerLevel) => {
    Game.time = controllerLevel * 3;
    const room = createRoomForRefresh([], [], [], [], controllerLevel);
    Game.rooms.W1N1 = room;

    refreshWorkerTasks();

    expect(getWorkerTasksByRoom(room.name)["upgrade:controller1"]).toMatchObject({
      type: "upgrade",
      targetId: "controller1",
      priority: 300,
      status: "active",
    });
  });

  it.each([
    { label: "healthy", ticksToDowngrade: 200_000, tick: 24 },
    { label: "maintenance recovery", ticksToDowngrade: 175_000, tick: 27 },
  ])("omits the generic upgrade task for a $label RCL8 controller", ({ ticksToDowngrade, tick }) => {
    Game.time = tick;
    const room = createRoomForRefresh([], [], [], [], 8, ticksToDowngrade);
    Game.rooms.W1N1 = room;

    refreshWorkerTasks();

    expect(getWorkerTasksByRoom(room.name)["upgrade:controller1"]).toBeUndefined();
  });

  it("keeps RCL8 build and normal repair task generation while omitting upgrade", () => {
    Game.time = 30;
    const constructionSites: ConstructionSite[] = [];
    const rampart = createStructure("rampart1", STRUCTURE_RAMPART, 20, 20, {
      my: true,
      hits: 7_000,
      hitsMax: 10_000,
    }) as StructureRampart;
    const room = createRoomForRefresh([rampart], [rampart], [], constructionSites, 8, 175_000);
    const site = {
      id: "site1" as Id<ConstructionSite>,
      room,
      pos: createPos(room.name, 21, 20),
      structureType: STRUCTURE_EXTENSION,
      progress: 0,
      progressTotal: 3_000,
    } as ConstructionSite;
    constructionSites.push(site);
    Game.rooms.W1N1 = room;

    refreshWorkerTasks();

    const tasks = getWorkerTasksByRoom(room.name);
    expect(tasks["build:site1"]).toMatchObject({ type: "build", targetId: "site1", priority: 850 });
    expect(tasks["repair:rampart1"]).toMatchObject({
      type: "repair",
      targetId: "rampart1",
      priority: 320,
      repairMode: "normal",
    });
    expect(tasks["upgrade:controller1"]).toBeUndefined();
  });

  it("keeps build, repair, and dismantle tasks assignable in an RCL8 room", () => {
    const controller = createControllerTarget("controller1", 8);
    Game.rooms.W1N1 = { name: "W1N1", controller } as Room;
    objects.controller1 = controller;
    objects.site1 = { pos: createPos("W1N1", 10, 10) };
    objects.rampart1 = { pos: createPos("W1N1", 11, 10) };
    objects.wall1 = { pos: createPos("W1N1", 12, 10) };

    const tasks = getWorkerTasksByRoom("W1N1");
    tasks["upgrade:controller1"] = createTask({
      id: "upgrade:controller1",
      type: "upgrade",
      targetId: "controller1",
      roomName: "W1N1",
      priority: 1_000,
    });
    tasks["build:site1"] = createTask({
      id: "build:site1",
      type: "build",
      targetId: "site1",
      roomName: "W1N1",
      priority: 900,
    });
    tasks["dismantle:wall1"] = createTask({
      id: "dismantle:wall1",
      type: "dismantle",
      targetId: "wall1",
      roomName: "W1N1",
      priority: 500,
    });
    tasks["repair:rampart1"] = createTask({
      id: "repair:rampart1",
      type: "repair",
      targetId: "rampart1",
      roomName: "W1N1",
      priority: 320,
      repairMode: "normal",
    });

    const workers = ["Worker1", "Worker2", "Worker3"].map((name) => createCreep(name, "W1N1"));
    for (const creep of workers) {
      Game.creeps[creep.name] = creep;
    }

    expect(workers.map((creep) => assignWorkerTask(creep)?.id)).toEqual([
      "build:site1",
      "dismantle:wall1",
      "repair:rampart1",
    ]);
    expect(tasks["upgrade:controller1"].assignedCreeps).toEqual([]);
  });

  it("fails closed immediately when an assigned upgrade controller reaches RCL8, then removes the stale task on refresh", () => {
    Game.time = 33;
    const room = createRoomForRefresh([], [], [], [], 7);
    Game.rooms.W1N1 = room;
    const controller = room.controller!;
    objects.controller1 = controller;

    refreshWorkerTasks();

    const task = getWorkerTasksByRoom(room.name)["upgrade:controller1"];
    const creep = createCreep("Worker1", room.name);
    Game.creeps[creep.name] = creep;
    task.assignedCreeps = [creep.name];
    ensureCreepAssignmentState(creep.name).taskId = task.id;
    expect(getWorkerTaskTarget(task)).toBe(controller);
    expect(completeWorkerTaskIfDone(task)).toBe(false);

    (controller as StructureController & { level: number }).level = 8;

    expect(getWorkerTaskTarget(task)).toBeNull();
    expect(completeWorkerTaskIfDone(task)).toBe(true);
    expect(assignWorkerTask(creep)).toBeNull();
    expect(getCreepAssignmentState(creep.name)?.taskId).toBeUndefined();
    expect(task.assignedCreeps).toEqual([]);

    Game.time = 36;
    refreshWorkerTasks();

    expect(getWorkerTasksByRoom(room.name)[task.id]).toBeUndefined();
  });

  it("releases the previous task from its actual task store even after the creep changes rooms", () => {
    const repairTask = createTask({
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: "W1N1",
      assignedCreeps: ["Worker1"],
      repairMode: "normal",
      priority: 320,
    });
    getWorkerTasksByRoom("W1N1")[repairTask.id] = repairTask;
    getWorkerTasksByRoom("W1N2");

    const creep = createCreep("Worker1", "W1N2");
    ensureCreepAssignmentState(creep.name).taskId = repairTask.id;
    Game.creeps[creep.name] = creep;

    releaseWorkerTask(creep);

    expect(repairTask.assignedCreeps).toEqual([]);
    expect(getCreepAssignmentState(creep.name)?.taskId).toBeUndefined();
  });

  it("drops stale repair assignees whose current task is upgrade", () => {
    const repairTask = createTask({
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: "W1N1",
      assignedCreeps: ["Worker1"],
      repairMode: "normal",
      priority: 320,
    });
    const upgradeTask = createTask({
      id: "upgrade:u1",
      type: "upgrade",
      targetId: "u1",
      roomName: "W1N1",
      assignedCreeps: [],
      maxAssignees: 2,
      priority: 300,
    });
    const tasks = getWorkerTasksByRoom("W1N1");
    tasks[repairTask.id] = repairTask;
    tasks[upgradeTask.id] = upgradeTask;

    const staleRepairAssignee = createCreep("Worker1", "W1N1");
    ensureCreepAssignmentState(staleRepairAssignee.name).taskId = upgradeTask.id;
    const availableWorker = createCreep("Worker2", "W1N1");
    Game.creeps[staleRepairAssignee.name] = staleRepairAssignee;
    Game.creeps[availableWorker.name] = availableWorker;

    objects.r1 = { pos: createPos("W1N1") };
    objects.u1 = createControllerTarget("u1", 3);

    const assignedTask = assignWorkerTask(availableWorker);

    expect(assignedTask?.id).toBe(repairTask.id);
    expect(repairTask.assignedCreeps).toEqual(["Worker2"]);
    expect(upgradeTask.assignedCreeps).toEqual([]);
  });

  it("keeps valid repair assignees so another worker falls back to upgrade", () => {
    const repairTask = createTask({
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: "W1N1",
      assignedCreeps: ["Worker1"],
      repairMode: "normal",
      priority: 320,
    });
    const upgradeTask = createTask({
      id: "upgrade:u1",
      type: "upgrade",
      targetId: "u1",
      roomName: "W1N1",
      assignedCreeps: [],
      maxAssignees: 2,
      priority: 300,
    });
    const tasks = getWorkerTasksByRoom("W1N1");
    tasks[repairTask.id] = repairTask;
    tasks[upgradeTask.id] = upgradeTask;

    const activeRepairAssignee = createCreep("Worker1", "W1N1");
    ensureCreepAssignmentState(activeRepairAssignee.name).taskId = repairTask.id;
    const availableWorker = createCreep("Worker2", "W1N1");
    Game.creeps[activeRepairAssignee.name] = activeRepairAssignee;
    Game.creeps[availableWorker.name] = availableWorker;

    objects.r1 = { pos: createPos("W1N1") };
    objects.u1 = createControllerTarget("u1", 3);

    const assignedTask = assignWorkerTask(availableWorker);

    expect(assignedTask?.id).toBe(upgradeTask.id);
    expect(repairTask.assignedCreeps).toEqual(["Worker1"]);
    expect(upgradeTask.assignedCreeps).toEqual(["Worker2"]);
  });

  it("assigns tasks from the config-assigned room instead of the physical room", () => {
    const homeRepairTask = createTask({
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: "W1N1",
      repairMode: "normal",
      priority: 320,
    });
    const foreignUpgradeTask = createTask({
      id: "upgrade:u2",
      type: "upgrade",
      targetId: "u2",
      roomName: "W1N2",
      maxAssignees: 2,
      priority: 300,
    });
    getWorkerTasksByRoom("W1N1")[homeRepairTask.id] = homeRepairTask;
    getWorkerTasksByRoom("W1N2")[foreignUpgradeTask.id] = foreignUpgradeTask;

    const configName = "W1N1:worker:0";
    getCreepConfigService().upsert(configName, "worker", [], "W1N1");

    const creep = createCreep("Worker1", "W1N2", configName);
    Game.creeps[creep.name] = creep;

    objects.r1 = { pos: createPos("W1N1") };
    objects.u2 = createControllerTarget("u2", 3, "W1N2");

    const assignedTask = assignWorkerTask(creep);

    expect(assignedTask?.id).toBe(homeRepairTask.id);
    expect(homeRepairTask.assignedCreeps).toEqual(["Worker1"]);
    expect(foreignUpgradeTask.assignedCreeps).toEqual([]);
  });

  it("assigns colonizer workers to tasks in their current room instead of the source spawn room", () => {
    const sourceRepairTask = createTask({
      id: "repair:source",
      type: "repair",
      targetId: "source-target",
      roomName: "W1N1",
      repairMode: "normal",
      priority: 320,
    });
    const targetUpgradeTask = createTask({
      id: "upgrade:target",
      type: "upgrade",
      targetId: "target-controller",
      roomName: "W1N2",
      maxAssignees: 2,
      priority: 300,
    });
    getWorkerTasksByRoom("W1N1")[sourceRepairTask.id] = sourceRepairTask;
    getWorkerTasksByRoom("W1N2")[targetUpgradeTask.id] = targetUpgradeTask;

    const configName = "W1N1:colonize:W1N2:worker:0";
    getCreepConfigService().upsert(configName, "colonizerWorker", ["W1N2", "W1N1|W1N2"], "W1N1");

    const creep = createCreep("ColonizerWorker1", "W1N2", configName);
    Game.creeps[creep.name] = creep;

    objects["source-target"] = { pos: createPos("W1N1") };
    objects["target-controller"] = createControllerTarget("target-controller", 3, "W1N2");

    const assignedTask = assignWorkerTask(creep);

    expect(assignedTask?.id).toBe(targetUpgradeTask.id);
    expect(sourceRepairTask.assignedCreeps).toEqual([]);
    expect(targetUpgradeTask.assignedCreeps).toEqual(["ColonizerWorker1"]);
  });

  it("skips tasks outside the safe zone while the assigned room is in defense mode", () => {
    const safeTask = createTask({
      id: "repair:safe",
      type: "repair",
      targetId: "safe-target",
      roomName: "W1N1",
      repairMode: "normal",
      priority: 320,
    });
    const unsafeTask = createTask({
      id: "upgrade:unsafe",
      type: "upgrade",
      targetId: "unsafe-target",
      roomName: "W1N1",
      maxAssignees: 2,
      priority: 500,
    });
    const tasks = getWorkerTasksByRoom("W1N1");
    tasks[safeTask.id] = safeTask;
    tasks[unsafeTask.id] = unsafeTask;

    const configName = "W1N1:worker:0";
    getCreepConfigService().upsert(configName, "worker", [], "W1N1");
    const creep = createCreep("Worker1", "W1N1", configName);
    Game.creeps[creep.name] = creep;

    objects["safe-target"] = { pos: { x: 10, y: 10, roomName: "W1N1", getRangeTo: () => 1 } as unknown as RoomPosition };
    objects["unsafe-target"] = createControllerTarget("unsafe-target", 3, "W1N1", 40, 40);
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));

    const assignedTask = assignWorkerTask(creep);

    expect(assignedTask?.id).toBe(safeTask.id);
    expect(unsafeTask.assignedCreeps).toEqual([]);
  });

  it("destroys a non-owned structure outside the saved room plan after tower is built", () => {
    Game.time = 3;
    const tower = createStructure("tower1", STRUCTURE_TOWER, 20, 20, { my: true }) as StructureTower;
    const plannedExtension = createStructure("plannedExt", STRUCTURE_EXTENSION, 10, 10, { my: false }) as StructureExtension & {
      destroy: jest.Mock;
    };
    const illegalExtension = createStructure("illegalExt", STRUCTURE_EXTENSION, 11, 10, { my: false }) as StructureExtension & {
      destroy: jest.Mock;
    };
    const room = createRoomForRefresh([tower, plannedExtension, illegalExtension], [tower]);
    Game.rooms.W1N1 = room;
    Memory.data = {
      roomPlanner: {
        W1N1: {
          layout: {
            [STRUCTURE_EXTENSION]: [{ x: 10, y: 10 }],
            [STRUCTURE_TOWER]: [{ x: 20, y: 20 }],
          },
          timestamp: "2026-04-24T00:00:00.000Z",
          savedAt: 42,
        },
      },
    };

    refreshWorkerTasks();

    expect(illegalExtension.destroy).toHaveBeenCalledTimes(1);
    expect(plannedExtension.destroy).not.toHaveBeenCalled();
    expect(getIllegalStructureCleanupMemory()?.rooms?.W1N1).toMatchObject({
      completedAt: 3,
      layoutSavedAt: 42,
    });
  });

  it("marks a planned room as illegal-structure cleaned after tower is built and no dismantle targets remain", () => {
    Game.time = 6;
    const tower = createStructure("tower1", STRUCTURE_TOWER, 20, 20, { my: true }) as StructureTower;
    const room = createRoomForRefresh([tower], [tower]);
    Game.rooms.W1N1 = room;
    Memory.data = {
      roomPlanner: {
        W1N1: {
          layout: {
            [STRUCTURE_TOWER]: [{ x: 20, y: 20 }],
          },
          timestamp: "2026-04-24T00:00:00.000Z",
          savedAt: 42,
        },
      },
    };

    refreshWorkerTasks();

    expect(getIllegalStructureCleanupMemory()?.rooms?.W1N1).toMatchObject({
      completedAt: 6,
      layoutSavedAt: 42,
    });
  });

  it("does not destroy owned structures even when they are outside the saved room plan", () => {
    Game.time = 9;
    const tower = createStructure("tower1", STRUCTURE_TOWER, 20, 20, { my: true, owner: { username: "me" } }) as StructureTower;
    const ownedOffPlanExtension = createStructure("ownedExt", STRUCTURE_EXTENSION, 11, 10, {
      my: true,
      owner: { username: "me" },
    }) as StructureExtension & { destroy: jest.Mock };
    const room = createRoomForRefresh([tower, ownedOffPlanExtension], [tower]);
    Game.rooms.W1N1 = room;
    Memory.data = {
      roomPlanner: {
        W1N1: {
          layout: {
            [STRUCTURE_TOWER]: [{ x: 20, y: 20 }],
          },
          timestamp: "2026-04-24T00:00:00.000Z",
          savedAt: 42,
        },
      },
    };

    refreshWorkerTasks();

    expect(ownedOffPlanExtension.destroy).not.toHaveBeenCalled();
    expect(getIllegalStructureCleanupMemory()?.rooms?.W1N1).toMatchObject({
      completedAt: 9,
      layoutSavedAt: 42,
    });
  });

  it("destroys a neutral road with the wrong type on a planned position", () => {
    Game.time = 12;
    const tower = createStructure("tower1", STRUCTURE_TOWER, 20, 20, { my: true, owner: { username: "me" } }) as StructureTower;
    const legacyRoad = createStructure("legacyRoad", STRUCTURE_ROAD, 10, 10, { my: false }) as StructureRoad & {
      destroy: jest.Mock;
    };
    const room = createRoomForRefresh([tower, legacyRoad], [tower]);
    Game.rooms.W1N1 = room;
    Memory.data = {
      roomPlanner: {
        W1N1: {
          layout: {
            [STRUCTURE_EXTENSION]: [{ x: 10, y: 10 }],
            [STRUCTURE_TOWER]: [{ x: 20, y: 20 }],
          },
          timestamp: "2026-04-24T00:00:00.000Z",
          savedAt: 42,
        },
      },
    };

    refreshWorkerTasks();

    expect(legacyRoad.destroy).toHaveBeenCalledTimes(1);
    expect(getIllegalStructureCleanupMemory()?.rooms?.W1N1).toMatchObject({
      completedAt: 12,
      layoutSavedAt: 42,
    });
  });

  it("does not destroy protected source, storage, or controller proto containers", () => {
    Game.time = 15;
    const tower = createStructure("tower1", STRUCTURE_TOWER, 20, 20, { my: true, owner: { username: "me" } }) as StructureTower;
    const source = createSource("source1", 10, 10);
    const sourceContainer = createStructure("sourceContainer", STRUCTURE_CONTAINER, 9, 10, { my: false }) as StructureContainer & {
      destroy: jest.Mock;
    };
    const storageContainer = createStructure("storageContainer", STRUCTURE_CONTAINER, 23, 23, { my: false }) as StructureContainer & {
      destroy: jest.Mock;
    };
    const controllerContainer = createStructure("controllerContainer", STRUCTURE_CONTAINER, 25, 22, { my: false }) as StructureContainer & {
      destroy: jest.Mock;
    };
    const room = createRoomForRefresh(
      [tower, sourceContainer, storageContainer, controllerContainer],
      [tower],
      [source],
    );
    Game.rooms.W1N1 = room;
    room.controller = {
      ...room.controller,
      pos: createPos("W1N1", 25, 25),
    } as StructureController;
    Memory.data = {
      roomPlanner: {
        W1N1: {
          layout: {
            [STRUCTURE_TOWER]: [{ x: 20, y: 20 }],
            [STRUCTURE_STORAGE]: [{ x: 23, y: 23 }],
            [STRUCTURE_LINK]: [{ x: 8, y: 10 }, { x: 25, y: 22 }],
            work_pos: [{ x: 9, y: 10 }],
          },
          timestamp: "2026-04-24T00:00:00.000Z",
          savedAt: 42,
        },
      },
    };

    refreshWorkerTasks();

    expect(sourceContainer.destroy).not.toHaveBeenCalled();
    expect(storageContainer.destroy).not.toHaveBeenCalled();
    expect(controllerContainer.destroy).not.toHaveBeenCalled();
    expect(getIllegalStructureCleanupMemory()?.rooms?.W1N1).toMatchObject({
      completedAt: 15,
      layoutSavedAt: 42,
    });
  });
});
