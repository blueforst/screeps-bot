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
  peekWorkerTasksByRoom,
  refreshWorkerTasks,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import type { WorkerTask } from "@/types/system";

type RuntimeGlobal = typeof global & {
  RoomPosition?: typeof MockRoomPosition;
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

  it("peeks an absent room without creating the heap task board", () => {
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();

    expect(peekWorkerTasksByRoom("W9N9")).toEqual({});
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();

    const writableTasks = getWorkerTasksByRoom("W9N9");
    expect(peekWorkerTasksByRoom("W9N9")).toBe(writableTasks);
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
});
