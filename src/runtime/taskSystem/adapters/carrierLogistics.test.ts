import {
  clearCarrierTaskBoardForTest,
  peekCarrierTaskBoard,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskBoardSnapshot,
} from "@/runtime/carrierTaskBoard";
import carrierLogisticsAdapter from "@/runtime/taskSystem/adapters/carrierLogistics";

type CarrierTaskRuntimeGlobal = typeof global & {
  __carrierTaskBoard?: Record<string, Record<string, unknown>>;
};

const carrierTaskRuntimeGlobal = global as CarrierTaskRuntimeGlobal;

function step(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    resource: RESOURCE_ENERGY,
    fromKind: "storage",
    toKind: "terminal",
    fromId: `${id}:from`,
    toId: `${id}:to`,
    amount: 100,
    ...overrides,
  };
}

function task(
  id: string,
  producer: string,
  roomName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    producer,
    roomName,
    type: "terminal_feed",
    priority: 100,
    steps: [step(`${id}:step`)],
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function asBoard(value: unknown): CarrierTaskBoardSnapshot {
  return value as CarrierTaskBoardSnapshot;
}

describe("carrierLogisticsAdapter", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 100;
  });

  test("projects producer-namespaced room work with parallel transport facts", () => {
    const board = asBoard({
      W1N1: {
        "shared:id": task("shared:id", "producer:z", "W1N1", {
          dispatchClass: "capacity_relief",
          steps: [
            step("step:z", { resource: RESOURCE_HYDROGEN, amount: 25 }),
            step("step:a", { amount: 50 }),
          ],
        }),
        "other:id": task("other:id", "producer:a", "W1N1"),
      },
    });

    const result = carrierLogisticsAdapter.snapshot({ board });

    expect(result.invalidCount).toBe(0);
    expect(result.issues).toEqual([expect.objectContaining({
      code: "carrier-task-id-collision-risk",
      field: "W1N1",
    })]);
    expect(result.entries.map((entry) => [
      entry.ref.namespace,
      entry.ref.localId,
    ])).toEqual([
      ["producer:a", "other:id"],
      ["producer:z", "shared:id"],
    ]);

    const projected = result.entries[1];
    expect(projected).toEqual(expect.objectContaining({
      ref: {
        system: "carrier-logistics",
        namespace: "producer:z",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "shared:id",
      },
      activity: "available",
      sourceState: "published",
      authorities: [{ role: "producer", id: "producer:z" }],
      createdAt: 10,
      updatedAt: 20,
      taskType: "terminal_feed",
      priority: 100,
      dispatchClass: "capacity_relief",
      issues: [],
    }));
    expect(projected.facts).toEqual([
      expect.objectContaining({ kind: "transport", stepId: "step:a", amount: 50 }),
      expect.objectContaining({ kind: "transport", stepId: "step:z", amount: 25 }),
    ]);
    expect(projected).not.toHaveProperty("progress");
    expect(projected).not.toHaveProperty("completedAt");
    expect(projected).not.toHaveProperty("deadlineAt");
  });

  test("treats step order as parallel facts and never infers running or terminal", () => {
    const firstTask = task("parallel", "producer", "W1N1", {
      steps: [step("b"), step("a")],
    });
    const secondTask = task("parallel", "producer", "W1N1", {
      steps: [step("a"), step("b")],
    });

    const first = carrierLogisticsAdapter.snapshot({
      board: asBoard({ W1N1: { parallel: firstTask } }),
    }).entries[0];
    const second = carrierLogisticsAdapter.snapshot({
      board: asBoard({ W1N1: { parallel: secondTask } }),
    }).entries[0];

    expect(first.facts).toEqual(second.facts);
    expect(first.facts.map((fact) => fact.stepId)).toEqual(["a", "b"]);
    expect(first.activity).toBe("available");
    expect(first.sourceState).toBe("published");
    expect(first.authorities).toEqual([{ role: "producer", id: "producer" }]);
  });

  test("fails closed for resources outside RESOURCES_ALL without losing legal facts or tasks", () => {
    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: {
          mixed: task("mixed", "producer", "W1N1", {
            steps: [
              step("unknown-resource", {
                resource: "definitely-not-a-screeps-resource",
              }),
              step("legal-step", { resource: RESOURCE_HYDROGEN }),
            ],
          }),
          legal: task("legal", "producer", "W1N1", {
            steps: [step("legal-sibling", { resource: RESOURCE_ENERGY })],
          }),
        },
      }),
    });

    expect(result.invalidCount).toBe(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((entry) => entry.ref.localId === "legal"))
      .toEqual(expect.objectContaining({
        activity: "available",
        facts: [expect.objectContaining({
          stepId: "legal-sibling",
          resource: RESOURCE_ENERGY,
        })],
        issues: [],
      }));
    expect(result.entries.find((entry) => entry.ref.localId === "mixed"))
      .toEqual(expect.objectContaining({
        activity: "unknown",
        facts: [expect.objectContaining({
          stepId: "legal-step",
          resource: RESOURCE_HYDROGEN,
        })],
        issues: [expect.objectContaining({
          code: "carrier-transport-step-resource-invalid",
          field: "steps.resource",
        })],
      }));
    expect(result.entries.find((entry) => entry.ref.localId === "mixed")?.facts)
      .not.toContainEqual(expect.objectContaining({ stepId: "unknown-resource" }));
  });

  test("reports the board collision risk without fabricating an overwritten producer", () => {
    replaceCarrierTasksForProducerRoom("producer:a", "W1N1", [{
      id: "same-local-id",
      type: "terminal_feed",
      priority: 10,
      steps: [step("a") as any],
    }]);
    replaceCarrierTasksForProducerRoom("producer:b", "W1N1", [{
      id: "same-local-id",
      type: "terminal_feed",
      priority: 20,
      steps: [step("b") as any],
    }]);

    const result = carrierLogisticsAdapter.snapshot({
      board: peekCarrierTaskBoard(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].ref).toEqual({
      system: "carrier-logistics",
      namespace: "producer:b",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "same-local-id",
    });
    expect(result.entries.some((entry) => entry.ref.namespace === "producer:a")).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "carrier-task-id-collision-risk",
    }));
  });

  test("fails closed for malformed sources and records while keeping provable refs", () => {
    expect(carrierLogisticsAdapter.snapshot({
      board: [] as unknown as CarrierTaskBoardSnapshot,
    })).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({ code: "carrier-board-source-malformed" })],
    });

    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: {
          known: task("different", "producer", "W2N2", {
            type: "future_type",
            priority: Number.NaN,
            createdAt: 30,
            updatedAt: 20,
            steps: [step("valid"), step("invalid", { amount: 0 }), null],
          }),
          "missing-producer": task("missing-producer", "", "W1N1"),
          nonObject: 1,
        },
        W2N2: [],
      }),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        namespace: "producer",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "known",
      }),
      activity: "unknown",
      sourceState: "published",
      facts: [expect.objectContaining({ stepId: "valid" })],
    }));
    expect(result.entries[0].issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "carrier-task-id-mismatch",
        "carrier-task-room-mismatch",
        "carrier-task-field-invalid",
        "carrier-task-timestamp-conflict",
        "carrier-transport-step-malformed",
      ]),
    );
    expect(result.invalidCount).toBe(3);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "carrier-task-id-collision-risk",
      "carrier-task-producer-invalid",
      "carrier-task-record-malformed",
      "carrier-board-room-malformed",
    ]));
  });

  test("receives malformed heap entries through the selector without losing valid siblings", () => {
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [{
      id: "valid",
      type: "terminal_feed",
      priority: 100,
      steps: [step("valid-step") as any],
    }]);
    const room = carrierTaskRuntimeGlobal.__carrierTaskBoard!.W1N1;
    room.nonObject = 7;
    room.nonArraySteps = task("nonArraySteps", "producer", "W1N1", {
      steps: { legacy: true },
    });
    room.malformedStep = task("malformedStep", "producer", "W1N1", {
      steps: [null, step("usable-step")],
    });
    let getterReads = 0;
    const accessorTask = task("accessorTask", "producer", "W1N1");
    Object.defineProperty(accessorTask, "producer", {
      enumerable: true,
      configurable: true,
      get(): string {
        getterReads += 1;
        throw new Error("selector must not evaluate task accessors");
      },
    });
    room.accessorTask = accessorTask;
    room.customTask = Object.assign(
      Object.create({ sourcePrototype: true }) as Record<string, unknown>,
      task("customTask", "producer", "W1N1"),
    );
    room.mapTask = new Map<string, unknown>([["producer", "map-producer"]]);
    room.functionTask = Object.assign(
      function malformedCarrierTask(): undefined {
        return undefined;
      },
      task("functionTask", "producer", "W1N1"),
    );

    const boardBefore = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const roomBefore = room;
    const result = carrierLogisticsAdapter.snapshot({
      board: peekCarrierTaskBoard(),
    });

    expect(result.entries.map((entry) => [entry.ref.localId, entry.activity]))
      .toEqual([
        ["malformedStep", "unknown"],
        ["nonArraySteps", "unknown"],
        ["valid", "available"],
      ]);
    expect(result.entries.find((entry) => entry.ref.localId === "malformedStep")?.facts)
      .toEqual([expect.objectContaining({ stepId: "usable-step" })]);
    expect(result.invalidCount).toBe(5);
    for (const field of ["nonObject", "customTask", "mapTask", "functionTask"]) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "carrier-task-record-malformed",
        field,
      }));
    }
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "carrier-task-producer-invalid",
      field: "producer",
    }));
    expect(getterReads).toBe(0);
    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(boardBefore);
    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard!.W1N1).toBe(roomBefore);
  });

  test("returns empty output for an injected reset snapshot and deeply isolates output", () => {
    expect(carrierLogisticsAdapter.snapshot({ board: asBoard({}) })).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });

    const sourceStep = step("isolated");
    const sourceTask = task("isolated", "producer", "W1N1", {
      steps: [sourceStep],
    });
    const board = asBoard({ W1N1: { isolated: sourceTask } });
    const before = JSON.parse(JSON.stringify(board));
    const first = carrierLogisticsAdapter.snapshot({ board });

    const mutableEntry = first.entries[0] as any;
    mutableEntry.ref.scope.roomName = "changed";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.facts[0].amount = 1;
    mutableEntry.issues.push({ code: "changed", message: "changed" });
    (first.issues as any[])[0].message = "changed";

    expect(board).toEqual(before);
    expect(sourceTask).toEqual(before.W1N1.isolated);
    expect(sourceStep).toEqual(before.W1N1.isolated.steps[0]);

    const second = carrierLogisticsAdapter.snapshot({ board });
    expect(second.entries[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        scope: { kind: "room", roomName: "W1N1" },
      }),
      authorities: [{ role: "producer", id: "producer" }],
      facts: [expect.objectContaining({ amount: 100 })],
      issues: [],
    }));
    expect(second.issues[0].message).not.toBe("changed");
  });
});
