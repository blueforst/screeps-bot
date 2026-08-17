jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import {
  clearCreepAssignmentStateForTest,
} from "@/runtime/creepAssignmentState";
import {
  clearWorkerTaskBoardForTest,
  getWorkerTasksByRoom,
  peekWorkerTaskBoard,
  peekWorkerTaskRoomSnapshot,
  peekWorkerTasksByRoom,
} from "@/runtime/workerTaskPool";
import { isDefenseMode } from "@/runtime/defenseMode";
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
});
