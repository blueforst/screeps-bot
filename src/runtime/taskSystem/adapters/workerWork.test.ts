import workerWorkAdapter, {
  type WorkerWorkAdapterContext,
} from "@/runtime/taskSystem/adapters/workerWork";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  peekCreepAssignmentStates,
  type CreepAssignmentStateStoreSnapshot,
} from "@/runtime/creepAssignmentState";
import type { WorkerTaskBoardSnapshot } from "@/runtime/workerTaskPool";

type MutableRecord = Record<string, unknown>;

function task(overrides: MutableRecord = {}): MutableRecord {
  return {
    id: "build:site-1",
    type: "build",
    targetId: "site-1",
    roomName: "W1N1",
    priority: 850,
    requiredWork: 2_000,
    assignedCreeps: [],
    maxAssignees: 2,
    status: "active",
    updatedAt: 123,
    ...overrides,
  };
}

function workerAssignment(
  roomName: string,
  localId: string,
  overrides: MutableRecord = {},
): MutableRecord {
  return {
    taskId: localId,
    dispatchBindings: {
      worker: {
        system: "worker-work",
        namespace: "workerTaskPool",
        scope: { kind: "room", roomName },
        localId,
      },
    },
    ...overrides,
  };
}

function context(
  board: unknown,
  assignments: unknown = {},
): WorkerWorkAdapterContext {
  return {
    board: board as WorkerTaskBoardSnapshot,
    assignments: assignments as CreepAssignmentStateStoreSnapshot,
  };
}

describe("workerWorkAdapter", () => {
  afterEach(() => {
    clearCreepAssignmentStateForTest();
  });

  test("projects room-scoped active work and only closed slot claims as claimed", () => {
    const board = {
      W2N2: {
        "upgrade:controller-2": task({
          id: "upgrade:controller-2",
          type: "upgrade",
          targetId: "controller-2",
          roomName: "W2N2",
          priority: 300,
          requiredWork: undefined,
          updatedAt: 125,
        }),
      },
      W1N1: {
        "build:site-1": task({ assignedCreeps: ["Worker1"] }),
      },
    };
    const assignments = {
      Worker1: workerAssignment("W1N1", "build:site-1"),
    };

    const result = workerWorkAdapter.snapshot(context(board, assignments));

    expect(workerWorkAdapter.system).toBe("worker-work");
    expect(result.invalidCount).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => [
      entry.ref.scope,
      entry.ref.localId,
      entry.activity,
      entry.sourceState,
      entry.updatedAt,
    ])).toEqual([
      [{ kind: "room", roomName: "W1N1" }, "build:site-1", "claimed", "active", 123],
      [{ kind: "room", roomName: "W2N2" }, "upgrade:controller-2", "available", "active", 125],
    ]);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      ref: {
        system: "worker-work",
        namespace: "workerTaskPool",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "build:site-1",
      },
      authorities: [
        { role: "producer", id: "workerTaskPool" },
        { role: "assignee", id: "Worker1" },
      ],
      issues: [],
    }));
  });

  test("fails closed on either assignment drift direction without repairing or partially claiming", () => {
    const sourceTask = task({
      assignedCreeps: ["Closed", "MissingReverse", "WrongReverse"],
      maxAssignees: 4,
    });
    const board = { W1N1: { "build:site-1": sourceTask } };
    const assignments = {
      Closed: workerAssignment("W1N1", "build:site-1"),
      WrongReverse: workerAssignment("W1N1", "upgrade:other"),
      ReverseOnly: workerAssignment("W1N1", "build:site-1"),
    };
    const boardBefore = JSON.stringify(board);
    const assignmentsBefore = JSON.stringify(assignments);

    const result = workerWorkAdapter.snapshot(context(board, assignments));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].sourceState).toBe("active");
    expect(result.entries[0].authorities).toEqual([
      { role: "producer", id: "workerTaskPool" },
    ]);
    expect(result.entries[0].issues.filter((issue) => issue.code === "worker-assignment-drift"))
      .toHaveLength(3);
    expect(result.entries[0].issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("MissingReverse"),
      expect.stringContaining("WrongReverse"),
      expect.stringContaining("ReverseOnly"),
    ]));
    expect(JSON.stringify(board)).toBe(boardBefore);
    expect(JSON.stringify(assignments)).toBe(assignmentsBefore);
  });

  test("keeps terminal source state and fails closed on unknown or malformed tasks", () => {
    const result = workerWorkAdapter.snapshot(context({
      W1N1: {
        done: task({ id: "done", status: "done" }),
        unknown: task({ id: "unknown", status: "paused" }),
        malformed: task({
          id: "different-id",
          roomName: "W9N9",
          type: "future",
          targetId: "",
          priority: Number.NaN,
          requiredWork: -1,
          repairTargetHits: "many",
          assignedCreeps: "Worker1",
          maxAssignees: 0,
          updatedAt: "now",
        }),
        nonObject: 42,
      },
      brokenRoom: [],
      "": { hidden: task({ id: "hidden", roomName: "" }) },
    }));

    expect(result.entries.map((entry) => [entry.ref.localId, entry.activity, entry.sourceState]))
      .toEqual([
        ["done", "terminal", "done"],
        ["malformed", "unknown", "active"],
        ["nonObject", "unknown", "unknown"],
        ["unknown", "unknown", "paused"],
      ]);
    expect(result.entries.find((entry) => entry.ref.localId === "unknown")?.issues)
      .toContainEqual(expect.objectContaining({ code: "worker-task-status-invalid" }));
    expect(result.entries.find((entry) => entry.ref.localId === "malformed")?.issues.map(
      (issue) => issue.code,
    )).toEqual(expect.arrayContaining([
      "worker-task-id-mismatch",
      "worker-task-room-mismatch",
      "worker-task-type-invalid",
      "worker-task-target-invalid",
      "worker-task-priority-invalid",
      "worker-task-required-work-invalid",
      "worker-task-repair-target-hits-invalid",
      "worker-task-assignees-invalid",
      "worker-task-capacity-invalid",
      "worker-task-updated-at-invalid",
    ]));
    expect(result.entries.find((entry) => entry.ref.localId === "nonObject")?.issues)
      .toEqual([expect.objectContaining({ code: "worker-task-record-malformed" })]);
    expect(result.invalidCount).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "worker-room-name-invalid",
      "worker-room-store-malformed",
    ]);
  });

  test("fails closed for malformed roots and assignment records", () => {
    expect(workerWorkAdapter.snapshot({} as WorkerWorkAdapterContext)).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "worker-context-malformed",
        message: expect.any(String),
        field: "context",
      }],
    });
    expect(workerWorkAdapter.snapshot(context([], {}))).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "worker-board-malformed",
        message: expect.any(String),
        field: "board",
      }],
    });

    const result = workerWorkAdapter.snapshot(context(
      { W1N1: { "build:site-1": task({ assignedCreeps: ["Broken"] }) } },
      { Broken: 1, EmptyTask: { taskId: "" } },
    ));

    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].authorities).toEqual([
      { role: "producer", id: "workerTaskPool" },
    ]);
    expect(result.entries[0].issues).toContainEqual(expect.objectContaining({
      code: "worker-assignment-evidence-malformed",
    }));
    expect(result.invalidCount).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "worker-assignment-record-malformed",
      "worker-assignment-task-id-invalid",
    ]);

    const malformedAssignments = workerWorkAdapter.snapshot(context(
      { W1N1: { "build:site-1": task() } },
      [],
    ));
    expect(malformedAssignments.entries[0].activity).toBe("unknown");
    expect(malformedAssignments.invalidCount).toBe(1);
    expect(malformedAssignments.issues).toEqual([
      expect.objectContaining({ code: "worker-assignments-malformed" }),
    ]);
  });

  test("counts malformed assignment state preserved by the safe selector without dropping valid work", () => {
    const validState = ensureCreepAssignmentState("Worker1");
    validState.taskId = "build:site-1";
    const runtimeGlobal = global as typeof global & {
      __creepAssignmentState?: Record<string, unknown>;
    };
    const sourceStore = runtimeGlobal.__creepAssignmentState;
    if (!sourceStore) throw new Error("assignment store was not created");
    sourceStore.Broken = 42;

    const result = workerWorkAdapter.snapshot(context(
      { W1N1: { "build:site-1": task({ assignedCreeps: ["Worker1"] }) } },
      peekCreepAssignmentStates(),
    ));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].sourceState).toBe("active");
    expect(result.entries[0].authorities).toEqual([
      { role: "producer", id: "workerTaskPool" },
    ]);
    expect(result.invalidCount).toBe(1);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "worker-assignment-record-malformed",
      field: "Broken",
    }));
    expect(runtimeGlobal.__creepAssignmentState).toBe(sourceStore);
    expect(sourceStore.Broken).toBe(42);
    expect(ensureCreepAssignmentState("Worker1")).toBe(validState);
  });

  test("treats reset and empty injected snapshots as empty without reading private globals", () => {
    const privateKeysBefore = Object.getOwnPropertyNames(global)
      .filter((key) => key.startsWith("__"))
      .sort();

    expect(workerWorkAdapter.snapshot(context(Object.freeze({}), Object.freeze({}))))
      .toEqual({ entries: [], invalidCount: 0, issues: [] });
    expect(Object.getOwnPropertyNames(global).filter((key) => key.startsWith("__")).sort())
      .toEqual(privateKeysBefore);
  });

  test("fails closed on ambiguous room-local claim identity and keeps output deterministic", () => {
    const first = workerWorkAdapter.snapshot(context({
      W2N2: {
        shared: task({
          id: "shared",
          roomName: "W2N2",
          assignedCreeps: ["Worker1"],
        }),
      },
      W1N1: {
        shared: task({ id: "shared", assignedCreeps: ["Worker1"] }),
      },
      broken: [],
      "": {},
    }, {
      Worker1: { taskId: "shared" },
    }));
    const second = workerWorkAdapter.snapshot(context({
      "": {},
      broken: [],
      W1N1: {
        shared: task({ id: "shared", assignedCreeps: ["Worker1"] }),
      },
      W2N2: {
        shared: task({
          id: "shared",
          roomName: "W2N2",
          assignedCreeps: ["Worker1"],
        }),
      },
    }, {
      Worker1: { taskId: "shared" },
    }));

    expect(first).toEqual(second);
    expect(first.entries).toHaveLength(2);
    expect(first.entries.every((entry) => entry.activity === "unknown")).toBe(true);
    expect(first.entries.every((entry) => entry.sourceState === "active")).toBe(true);
    expect(first.entries.every((entry) => entry.authorities.length === 1)).toBe(true);
    expect(first.entries.every((entry) => entry.issues.some(
      (issue) => issue.code === "worker-assignment-identity-ambiguous",
    ))).toBe(true);
  });

  test("closes equal local ids independently with canonical room-scoped bindings", () => {
    const result = workerWorkAdapter.snapshot(context({
      W2N2: {
        shared: task({
          id: "shared",
          roomName: "W2N2",
          assignedCreeps: ["Worker2"],
        }),
      },
      W1N1: {
        shared: task({ id: "shared", assignedCreeps: ["Worker1"] }),
      },
    }, {
      Worker1: workerAssignment("W1N1", "shared"),
      Worker2: workerAssignment("W2N2", "shared"),
    }));

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => [
      entry.ref.scope,
      entry.activity,
      entry.authorities,
    ])).toEqual([
      [
        { kind: "room", roomName: "W1N1" },
        "claimed",
        [
          { role: "producer", id: "workerTaskPool" },
          { role: "assignee", id: "Worker1" },
        ],
      ],
      [
        { kind: "room", roomName: "W2N2" },
        "claimed",
        [
          { role: "producer", id: "workerTaskPool" },
          { role: "assignee", id: "Worker2" },
        ],
      ],
    ]);
    expect(result.entries.every((entry) => entry.issues.length === 0)).toBe(true);
  });

  test("keeps fully closed sticky claims claimed after slot capacity shrinks", () => {
    const result = workerWorkAdapter.snapshot(context({
      W1N1: {
        shared: task({
          id: "shared",
          assignedCreeps: ["WorkerA", "WorkerB"],
          maxAssignees: 1,
        }),
      },
    }, {
      WorkerA: workerAssignment("W1N1", "shared"),
      WorkerB: workerAssignment("W1N1", "shared"),
    }));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "claimed",
      authorities: [
        { role: "producer", id: "workerTaskPool" },
        { role: "assignee", id: "WorkerA" },
        { role: "assignee", id: "WorkerB" },
      ],
    }));
    expect(result.entries[0].issues).toContainEqual(expect.objectContaining({
      code: "worker-task-assignee-capacity-conflict",
    }));
  });

  test("summarizes cross-room legacy ambiguity once per candidate without actor expansion", () => {
    const roomCount = 12;
    const actorCount = 30;
    const board: MutableRecord = {};
    for (let index = roomCount - 1; index >= 0; index -= 1) {
      const roomName = `W${index}N${index}`;
      board[roomName] = {
        shared: task({
          id: "shared",
          roomName,
          assignedCreeps: [],
        }),
      };
    }
    board.W99N99 = {
      unique: task({
        id: "unique",
        roomName: "W99N99",
        assignedCreeps: [],
      }),
    };
    const assignments: MutableRecord = {};
    for (let index = actorCount - 1; index >= 0; index -= 1) {
      assignments[`LegacyActor${index.toString().padStart(2, "0")}`] = {
        taskId: "shared",
      };
    }

    const originalAdd = Set.prototype.add;
    let legacyActorCandidateAdds = 0;
    Set.prototype.add = (function countingSetAdd(
      this: Set<unknown>,
      value: unknown,
    ): Set<unknown> {
      if (typeof value === "string" && value.startsWith("LegacyActor")) {
        legacyActorCandidateAdds += 1;
      }
      return Reflect.apply(originalAdd, this, [value]) as Set<unknown>;
    }) as typeof Set.prototype.add;

    let first: ReturnType<typeof workerWorkAdapter.snapshot>;
    try {
      first = workerWorkAdapter.snapshot(context(board, assignments));
    } finally {
      Set.prototype.add = originalAdd;
    }
    const second = workerWorkAdapter.snapshot(context(
      Object.fromEntries(Object.entries(board).reverse()),
      Object.fromEntries(Object.entries(assignments).reverse()),
    ));

    expect(first).toEqual(second);
    expect(first.entries).toHaveLength(roomCount + 1);
    const ambiguousEntries = first.entries.filter((entry) => entry.ref.localId === "shared");
    expect(ambiguousEntries).toHaveLength(roomCount);
    expect(ambiguousEntries.every((entry) => entry.activity === "unknown")).toBe(true);
    expect(ambiguousEntries.every((entry) => entry.authorities.length === 1)).toBe(true);
    expect(ambiguousEntries.every((entry) => entry.issues.filter(
      (issue) => issue.code === "worker-assignment-identity-ambiguous",
    ).length === 1)).toBe(true);
    expect(ambiguousEntries[0].issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining(`${actorCount} legacy Worker assignment(s)`),
    }));
    expect(first.entries.find((entry) => entry.ref.localId === "unique")).toEqual(
      expect.objectContaining({ activity: "available", issues: [] }),
    );
    expect(legacyActorCandidateAdds).toBe(0);
  });

  test("fails closed for legacy-only, mirror drift, and canonical scope or namespace conflicts", () => {
    const result = workerWorkAdapter.snapshot(context({
      W1N1: {
        legacy: task({ id: "legacy", assignedCreeps: ["Legacy"] }),
        mirror: task({ id: "mirror", assignedCreeps: ["Mirror"] }),
        scope: task({ id: "scope", assignedCreeps: ["Scope"] }),
        namespace: task({ id: "namespace", assignedCreeps: ["Namespace"] }),
      },
    }, {
      Legacy: { taskId: "legacy" },
      Mirror: workerAssignment("W1N1", "mirror", { taskId: "other" }),
      Scope: workerAssignment("W2N2", "scope"),
      Namespace: workerAssignment("W1N1", "namespace", {
        dispatchBindings: {
          worker: {
            system: "worker-work",
            namespace: "other",
            scope: { kind: "room", roomName: "W1N1" },
            localId: "namespace",
          },
        },
      }),
    }));

    expect(result.entries).toHaveLength(4);
    expect(result.entries.every((entry) => entry.activity === "unknown")).toBe(true);
    expect(result.entries.every((entry) => entry.authorities.length === 1)).toBe(true);
    expect(result.entries.every((entry) => entry.issues.length > 0)).toBe(true);
  });

  test("does not execute assignment accessors while failing canonical closure closed", () => {
    const getter = jest.fn(() => workerAssignment("W1N1", "build:site-1").dispatchBindings);
    const assignment: MutableRecord = { taskId: "build:site-1" };
    Object.defineProperty(assignment, "dispatchBindings", {
      get: getter,
      enumerable: true,
      configurable: true,
    });

    const result = workerWorkAdapter.snapshot(context({
      W1N1: {
        "build:site-1": task({ assignedCreeps: ["Worker"] }),
      },
    }, { Worker: assignment }));

    expect(getter).not.toHaveBeenCalled();
    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "unknown",
      authorities: [{ role: "producer", id: "workerTaskPool" }],
    }));
    expect(result.entries[0].issues).toContainEqual(expect.objectContaining({
      code: "worker-assignment-canonical-missing",
    }));
  });

  test("returns deeply isolated projection objects", () => {
    const sourceTask = task({ assignedCreeps: ["Worker1", "Drift"] });
    const board = { W1N1: { "build:site-1": sourceTask } };
    const assignments = { Worker1: { taskId: "build:site-1" } };
    const beforeBoard = JSON.stringify(board);
    const beforeAssignments = JSON.stringify(assignments);
    const first = workerWorkAdapter.snapshot(context(board, assignments));

    const mutableEntry = first.entries[0] as unknown as {
      ref: { namespace: string; scope: { roomName: string } };
      authorities: Array<{ id: string }>;
      issues: Array<{ code: string; message: string }>;
    };
    mutableEntry.ref.namespace = "changed";
    mutableEntry.ref.scope.roomName = "W9N9";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.issues[0].code = "changed";
    (first.issues as Array<{ code: string; message: string }>).push({
      code: "changed",
      message: "changed",
    });

    expect(JSON.stringify(board)).toBe(beforeBoard);
    expect(JSON.stringify(assignments)).toBe(beforeAssignments);
    const second = workerWorkAdapter.snapshot(context(board, assignments));
    expect(second.entries[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        namespace: "workerTaskPool",
        scope: { kind: "room", roomName: "W1N1" },
      }),
      authorities: [
        { role: "producer", id: "workerTaskPool" },
      ],
    }));
    expect(second.entries[0].issues).toContainEqual(expect.objectContaining({
      code: "worker-assignment-drift",
    }));
    expect(second.issues).toEqual([]);
  });
});
