import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { assignWorkerTask, clearWorkerTaskBoardForTest, releaseWorkerTask } from "@/runtime/workerTaskPool";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import type { WorkerTask } from "@/types/system";

function createPos(roomName: string): RoomPosition {
  return {
    x: 25,
    y: 25,
    roomName,
    getRangeTo: () => 1,
  } as unknown as RoomPosition;
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
    objects = {};
    const getObjectById = jest.fn((id: string) => objects[id] || null) as unknown as Game["getObjectById"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = getObjectById;
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
    Memory.rooms.W1N1 = { tasks: { [repairTask.id]: repairTask } } as RoomMemory;
    Memory.rooms.W1N2 = { tasks: {} } as RoomMemory;

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
    Memory.rooms.W1N1 = {
      tasks: {
        [repairTask.id]: repairTask,
        [upgradeTask.id]: upgradeTask,
      },
    } as RoomMemory;

    const staleRepairAssignee = createCreep("Worker1", "W1N1");
    ensureCreepAssignmentState(staleRepairAssignee.name).taskId = upgradeTask.id;
    const availableWorker = createCreep("Worker2", "W1N1");
    Game.creeps[staleRepairAssignee.name] = staleRepairAssignee;
    Game.creeps[availableWorker.name] = availableWorker;

    objects.r1 = { pos: createPos("W1N1") };
    objects.u1 = { pos: createPos("W1N1") };

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
    Memory.rooms.W1N1 = {
      tasks: {
        [repairTask.id]: repairTask,
        [upgradeTask.id]: upgradeTask,
      },
    } as RoomMemory;

    const activeRepairAssignee = createCreep("Worker1", "W1N1");
    ensureCreepAssignmentState(activeRepairAssignee.name).taskId = repairTask.id;
    const availableWorker = createCreep("Worker2", "W1N1");
    Game.creeps[activeRepairAssignee.name] = activeRepairAssignee;
    Game.creeps[availableWorker.name] = availableWorker;

    objects.r1 = { pos: createPos("W1N1") };
    objects.u1 = { pos: createPos("W1N1") };

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
    Memory.rooms.W1N1 = { tasks: { [homeRepairTask.id]: homeRepairTask } } as RoomMemory;
    Memory.rooms.W1N2 = { tasks: { [foreignUpgradeTask.id]: foreignUpgradeTask } } as RoomMemory;

    const configName = "W1N1:worker:0";
    getCreepConfigService().upsert(configName, "worker", [], "W1N1");

    const creep = createCreep("Worker1", "W1N2", configName);
    Game.creeps[creep.name] = creep;

    objects.r1 = { pos: createPos("W1N1") };
    objects.u2 = { pos: createPos("W1N2") };

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
    Memory.rooms.W1N1 = { tasks: { [sourceRepairTask.id]: sourceRepairTask } } as RoomMemory;
    Memory.rooms.W1N2 = { tasks: { [targetUpgradeTask.id]: targetUpgradeTask } } as RoomMemory;

    const configName = "W1N1:colonize:W1N2:worker:0";
    getCreepConfigService().upsert(configName, "colonizerWorker", ["W1N2", "W1N1|W1N2"], "W1N1");

    const creep = createCreep("ColonizerWorker1", "W1N2", configName);
    Game.creeps[creep.name] = creep;

    objects["source-target"] = { pos: createPos("W1N1") };
    objects["target-controller"] = { pos: createPos("W1N2") };

    const assignedTask = assignWorkerTask(creep);

    expect(assignedTask?.id).toBe(targetUpgradeTask.id);
    expect(sourceRepairTask.assignedCreeps).toEqual([]);
    expect(targetUpgradeTask.assignedCreeps).toEqual(["ColonizerWorker1"]);
  });
});
