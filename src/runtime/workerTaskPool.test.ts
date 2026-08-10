jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  getCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import {
  assignWorkerTask,
  clearWorkerTaskBoardForTest,
  completeWorkerTaskIfDone,
  getAssignedWorkerTaskRef,
  getWorkerTasksByRoom,
  getWorkerTaskTarget,
  peekWorkerTaskBoard,
  peekWorkerTaskRoomSnapshot,
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

function globalPropertyNames(): string[] {
  return Object.getOwnPropertyNames(global).sort();
}

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

  it("peeks an absent board and room without creating the heap task board", () => {
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();
    const propertiesBefore = globalPropertyNames();

    expect(peekWorkerTaskBoard()).toEqual({});
    expect(peekWorkerTaskRoomSnapshot("W9N9")).toEqual({});
    expect(peekWorkerTasksByRoom("W9N9")).toEqual({});
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();
    expect(globalPropertyNames()).toEqual(propertiesBefore);
  });

  it("does not materialize an empty room store while selecting Worker work", () => {
    const creep = createCreep("Worker1", "W9N9");
    Game.creeps[creep.name] = creep;
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();

    expect(assignWorkerTask(creep)).toBeNull();

    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();
    expect(getCreepAssignmentState(creep.name)).toBeUndefined();
  });

  it("keeps the legacy room peek ABI while safe selectors return isolated snapshots", () => {
    const task = createTask({
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: "W1N1",
      assignedCreeps: ["Worker1"],
      repairMode: "normal",
      priority: 320,
    });
    const writableTasks = getWorkerTasksByRoom(task.roomName);
    writableTasks[task.id] = task;

    expect(getWorkerTasksByRoom(task.roomName)).toBe(writableTasks);

    const legacyRoomView = peekWorkerTasksByRoom(task.roomName);
    const roomSnapshot = peekWorkerTaskRoomSnapshot(task.roomName);
    const boardSnapshot = peekWorkerTaskBoard();

    expect(legacyRoomView).toBe(writableTasks);
    expect(legacyRoomView[task.id]).toBe(task);
    expect(legacyRoomView[task.id].assignedCreeps).toBe(task.assignedCreeps);
    expect(roomSnapshot).toEqual(writableTasks);
    expect(roomSnapshot).not.toBe(writableTasks);
    expect(roomSnapshot[task.id]).not.toBe(task);
    expect(roomSnapshot[task.id].assignedCreeps).not.toBe(task.assignedCreeps);
    expect(boardSnapshot).toEqual({ [task.roomName]: writableTasks });
    expect(boardSnapshot[task.roomName]).not.toBe(writableTasks);
    expect(boardSnapshot[task.roomName][task.id]).not.toBe(task);
    expect(boardSnapshot[task.roomName][task.id].assignedCreeps).not.toBe(task.assignedCreeps);

    const mutableRoomSnapshot = roomSnapshot as unknown as Record<string, WorkerTask>;
    mutableRoomSnapshot[task.id].priority = -1;
    mutableRoomSnapshot[task.id].assignedCreeps.push("SnapshotOnly");
    delete mutableRoomSnapshot[task.id];

    const mutableBoardSnapshot = boardSnapshot as unknown as Record<string, Record<string, WorkerTask>>;
    mutableBoardSnapshot[task.roomName][task.id].targetId = "snapshot-target";
    mutableBoardSnapshot.W9N9 = {};

    expect(writableTasks[task.id]).toBe(task);
    expect(task.priority).toBe(320);
    expect(task.targetId).toBe("r1");
    expect(task.assignedCreeps).toEqual(["Worker1"]);
    expect((global as RuntimeGlobal).__workerTaskBoard).toEqual({
      [task.roomName]: { [task.id]: task },
    });
    expect(peekWorkerTasksByRoom(task.roomName)).toBe(writableTasks);
    expect(peekWorkerTaskRoomSnapshot(task.roomName)).toEqual({ [task.id]: task });
    expect(peekWorkerTaskBoard()).toEqual({
      [task.roomName]: { [task.id]: task },
    });
  });

  it("does not create an absent room or replace source references while peeking an existing board", () => {
    const writableTasks = getWorkerTasksByRoom("W1N1");
    const board = (global as RuntimeGlobal).__workerTaskBoard;

    const missingRoomView = peekWorkerTasksByRoom("W9N9");
    expect(missingRoomView).toEqual({});
    expect(peekWorkerTasksByRoom("W9N9")).toBe(missingRoomView);
    expect(peekWorkerTaskRoomSnapshot("W9N9")).toEqual({});
    expect(peekWorkerTaskBoard()).toEqual({ W1N1: writableTasks });
    expect((global as RuntimeGlobal).__workerTaskBoard).toBe(board);
    expect((global as RuntimeGlobal).__workerTaskBoard).toEqual({ W1N1: {} });
  });

  it("isolates malformed task shapes without blocking valid siblings or replacing global references", () => {
    const writableTasks = getWorkerTasksByRoom("W1N1");
    const validTask = createTask({
      id: "build:valid",
      type: "build",
      targetId: "valid",
      roomName: "W1N1",
    });
    const malformedAssignees = { nested: ["source"] };
    const malformedTask = {
      ...createTask({
        id: "build:malformed",
        type: "build",
        targetId: "malformed",
        roomName: "W1N1",
      }),
      assignedCreeps: malformedAssignees,
    };
    writableTasks[validTask.id] = validTask;
    writableTasks[malformedTask.id] = malformedTask as unknown as WorkerTask;
    writableTasks["malformed:primitive"] = 42 as unknown as WorkerTask;
    const board = (global as RuntimeGlobal).__workerTaskBoard;

    const boardSnapshot = peekWorkerTaskBoard() as unknown as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const roomSnapshot = peekWorkerTaskRoomSnapshot("W1N1") as unknown as Record<
      string,
      Record<string, unknown>
    >;

    expect(boardSnapshot.W1N1[validTask.id]).toEqual(validTask);
    expect(boardSnapshot.W1N1[validTask.id]).not.toBe(validTask);
    expect(boardSnapshot.W1N1[malformedTask.id]).toEqual(malformedTask);
    expect(boardSnapshot.W1N1[malformedTask.id]).not.toBe(malformedTask);
    expect(boardSnapshot.W1N1[malformedTask.id].assignedCreeps).not.toBe(malformedAssignees);
    expect(boardSnapshot.W1N1["malformed:primitive"] as unknown).toBe(42);
    expect(roomSnapshot[validTask.id]).toEqual(validTask);
    expect(roomSnapshot[malformedTask.id]).toEqual(malformedTask);
    expect(roomSnapshot["malformed:primitive"] as unknown).toBe(42);

    const copiedMalformedAssignees = boardSnapshot.W1N1[malformedTask.id]
      .assignedCreeps as { nested: string[] };
    copiedMalformedAssignees.nested.push("snapshot-only");

    expect(malformedAssignees).toEqual({ nested: ["source"] });
    expect((global as RuntimeGlobal).__workerTaskBoard).toBe(board);
    expect((global as RuntimeGlobal).__workerTaskBoard?.W1N1).toBe(writableTasks);
    expect(writableTasks[validTask.id]).toBe(validTask);
    expect(writableTasks[malformedTask.id]).toBe(malformedTask);
    expect(writableTasks["malformed:primitive"] as unknown).toBe(42);
    expect(peekWorkerTasksByRoom("W1N1")).toBe(writableTasks);
  });

  it("keeps assign and release mutations on the writable source while snapshots stay observational", () => {
    const task = createTask({
      id: "upgrade:u1",
      type: "upgrade",
      targetId: "u1",
      roomName: "W1N1",
      maxAssignees: 2,
    });
    const writableTasks = getWorkerTasksByRoom(task.roomName);
    writableTasks[task.id] = task;
    objects.u1 = createControllerTarget("u1", 3);
    const creep = createCreep("Worker1", task.roomName);
    Game.creeps[creep.name] = creep;

    expect(assignWorkerTask(creep)).toBe(task);
    expect(task.assignedCreeps).toEqual([creep.name]);
    expect(getCreepAssignmentState(creep.name)?.taskId).toBe(task.id);
    expect((getCreepAssignmentState(creep.name) as unknown as {
      dispatchBindings?: { worker?: unknown };
    })?.dispatchBindings?.worker).toEqual({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: task.roomName },
      localId: task.id,
    });
    expect(getAssignedWorkerTaskRef(creep.name)).toEqual({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: task.roomName },
      localId: task.id,
    });
    expect(peekWorkerTasksByRoom(task.roomName)[task.id]).toBe(task);
    expect(peekWorkerTaskRoomSnapshot(task.roomName)[task.id]).toEqual(task);
    expect(peekWorkerTaskRoomSnapshot(task.roomName)[task.id]).not.toBe(task);

    releaseWorkerTask(creep);

    expect(writableTasks[task.id]).toBe(task);
    expect(task.assignedCreeps).toEqual([]);
    expect(getCreepAssignmentState(creep.name)?.taskId).toBeUndefined();
    expect((getCreepAssignmentState(creep.name) as unknown as {
      dispatchBindings?: { worker?: unknown };
    })?.dispatchBindings?.worker).toBeUndefined();
    expect(getAssignedWorkerTaskRef(creep.name)).toBeUndefined();
  });

  it("treats prototype-looking actor and task ids as exact own data keys", () => {
    const localId = "__proto__";
    const actorName = "constructor";
    const sourceTask = createTask({
      id: localId,
      type: "build",
      targetId: "prototype-target",
      roomName: "W1N1",
      maxAssignees: 1,
    });
    const roomTasks = getWorkerTasksByRoom("W1N1");
    Object.defineProperty(roomTasks, localId, {
      value: sourceTask,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    objects["prototype-target"] = { pos: createPos("W1N1") };
    const creep = createCreep(actorName, "W1N1");
    Object.defineProperty(Game.creeps, actorName, {
      value: creep,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(assignWorkerTask(creep)).toBe(sourceTask);
    expect(sourceTask.assignedCreeps).toEqual([actorName]);
    expect(getAssignedWorkerTaskRef(actorName)).toEqual({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: "W1N1" },
      localId,
    });

    releaseWorkerTask(creep);

    expect(sourceTask.assignedCreeps).toEqual([]);
    expect(getAssignedWorkerTaskRef(actorName)).toBeUndefined();
  });

  it("releases by one exact room and task descriptor without enumerating the board", () => {
    const sourceTask = createTask({
      id: "build:exact",
      type: "build",
      targetId: "exact-target",
      roomName: "W1N1",
    });
    getWorkerTasksByRoom("W1N1")[sourceTask.id] = sourceTask;
    objects["exact-target"] = { pos: createPos("W1N1") };
    const creep = createCreep("Worker", "W1N1");
    Game.creeps[creep.name] = creep;
    expect(assignWorkerTask(creep)).toBe(sourceTask);

    const runtimeGlobal = global as RuntimeGlobal;
    const board = runtimeGlobal.__workerTaskBoard;
    if (!board) throw new Error("expected Worker task board");
    let boardEnumerations = 0;
    let roomDescriptorReads = 0;
    let taskDescriptorReads = 0;
    board.W1N1 = new Proxy(board.W1N1, {
      getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
        if (property === sourceTask.id) taskDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    runtimeGlobal.__workerTaskBoard = new Proxy(board, {
      ownKeys(target): ArrayLike<string | symbol> {
        boardEnumerations += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
        if (property === "W1N1") roomDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    releaseWorkerTask(creep);

    expect(boardEnumerations).toBe(0);
    expect(roomDescriptorReads).toBe(1);
    expect(taskDescriptorReads).toBe(1);
    expect(sourceTask.assignedCreeps).toEqual([]);
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
