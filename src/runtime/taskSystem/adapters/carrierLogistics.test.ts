import {
  clearCarrierTaskBoardForTest,
  peekCarrierTaskBoard,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskBoardSnapshot,
} from "@/runtime/carrierTaskBoard";
import carrierLogisticsAdapter from "@/runtime/taskSystem/adapters/carrierLogistics";

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

function ref(
  namespace: string,
  localId: string,
  roomName = "W1N1",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    system: "carrier-logistics",
    namespace,
    scope: { kind: "room", roomName },
    localId,
    ...overrides,
  };
}

function readEntry(
  namespace: string,
  localId: string,
  roomName = "W1N1",
  taskOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: ref(namespace, localId, roomName),
    task: task(localId, namespace, roomName, taskOverrides),
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

  test("uses explicit refs and canonically projects equal localIds across producers", () => {
    const board = asBoard({
      W1N1: [
        readEntry("producer:z->owner", "shared:id", "W1N1", {
          dispatchClass: "capacity_relief",
          steps: [
            step("step:z", { resource: RESOURCE_HYDROGEN, amount: 25 }),
            step("step:a", { amount: 50 }),
          ],
        }),
        readEntry("producer:a:owner", "shared:id"),
      ],
    });

    const result = carrierLogisticsAdapter.snapshot({ board });

    expect(result.invalidCount).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => [
      entry.ref.namespace,
      entry.ref.localId,
    ])).toEqual([
      ["producer:a:owner", "shared:id"],
      ["producer:z->owner", "shared:id"],
    ]);

    const projected = result.entries[1];
    expect(projected).toEqual(expect.objectContaining({
      ref: {
        system: "carrier-logistics",
        namespace: "producer:z->owner",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "shared:id",
      },
      activity: "available",
      sourceState: "published",
      authorities: [{ role: "producer", id: "producer:z->owner" }],
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

  test("ignores owner membership and step insertion order for canonical output", () => {
    const entries = [
      readEntry("producer:b", "parallel", "W1N1", {
        steps: [step("b"), step("a")],
      }),
      readEntry("producer:a", "parallel", "W1N1", {
        steps: [step("z"), step("y")],
      }),
    ];
    const first = carrierLogisticsAdapter.snapshot({
      board: asBoard({ W1N1: entries }),
    });
    const second = carrierLogisticsAdapter.snapshot({
      board: asBoard({ W1N1: [
        readEntry("producer:a", "parallel", "W1N1", {
          steps: [step("y"), step("z")],
        }),
        readEntry("producer:b", "parallel", "W1N1", {
          steps: [step("a"), step("b")],
        }),
      ] }),
    });

    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.ref.namespace)).toEqual([
      "producer:a",
      "producer:b",
    ]);
    expect(first.entries.map((entry) => entry.facts.map((fact) => fact.stepId)))
      .toEqual([["y", "z"], ["a", "b"]]);
    expect(first.entries.every((entry) => entry.activity === "available")).toBe(true);
    expect(first.entries.every((entry) => entry.sourceState === "published")).toBe(true);
  });

  test("fails closed for unknown resources without losing legal facts or siblings", () => {
    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: [
          readEntry("producer", "mixed", "W1N1", {
            steps: [
              step("unknown-resource", {
                resource: "definitely-not-a-screeps-resource",
              }),
              step("legal-step", { resource: RESOURCE_HYDROGEN }),
            ],
          }),
          readEntry("producer", "legal", "W1N1", {
            steps: [step("legal-sibling", { resource: RESOURCE_ENERGY })],
          }),
        ],
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
  });

  test("reads the owner-aware board DTO and keeps equal localIds from both producers", () => {
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

    const result = carrierLogisticsAdapter.snapshot({ board: peekCarrierTaskBoard() });

    expect(result.entries.map((entry) => entry.ref.namespace)).toEqual([
      "producer:a",
      "producer:b",
    ]);
    expect(result.entries.every((entry) => entry.ref.localId === "same-local-id"))
      .toBe(true);
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: "carrier-task-id-collision-risk",
    }));
  });

  test("isolates malformed wrappers, refs, rooms, and tasks while retaining valid refs", () => {
    expect(carrierLogisticsAdapter.snapshot({
      board: [] as unknown as CarrierTaskBoardSnapshot,
    })).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({ code: "carrier-board-source-malformed" })],
    });

    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: [
          {
            ref: ref("producer", "known"),
            task: task("different", "other-producer", "W2N2", {
              type: "future_type",
              priority: Number.NaN,
              createdAt: 30,
              updatedAt: 20,
              steps: [step("valid"), step("invalid", { amount: 0 }), null],
            }),
          },
          { ref: ref("producer", "bad-system", "W1N1", { system: "worker-work" }), task: {} },
          { ref: ref("producer", "bad-task"), task: 1 },
          7,
        ],
        W2N2: {},
        constructor: [readEntry("forged", "outer-room")],
      }),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      ref: {
        system: "carrier-logistics",
        namespace: "producer",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "known",
      },
      activity: "unknown",
      sourceState: "published",
      facts: [expect.objectContaining({ stepId: "valid" })],
    }));
    expect(result.entries[0].issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "carrier-task-producer-mismatch",
        "carrier-task-id-mismatch",
        "carrier-task-room-mismatch",
        "carrier-task-field-invalid",
        "carrier-task-timestamp-conflict",
        "carrier-transport-step-malformed",
      ]),
    );
    expect(result.invalidCount).toBe(5);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "carrier-read-ref-invalid",
      "carrier-task-record-malformed",
      "carrier-read-entry-malformed",
      "carrier-board-room-malformed",
      "carrier-board-room-id-invalid",
    ]));
  });

  test("never executes accessors and keeps legal siblings around malformed entries", () => {
    let getterReads = 0;
    const taskWithAccessor = task("accessor-task", "producer", "W1N1");
    Object.defineProperty(taskWithAccessor, "producer", {
      enumerable: true,
      configurable: true,
      get(): string {
        getterReads += 1;
        throw new Error("adapter must not evaluate task accessors");
      },
    });

    const accessorRefEntry: Record<string, unknown> = {
      task: task("accessor-ref", "producer", "W1N1"),
    };
    Object.defineProperty(accessorRefEntry, "ref", {
      enumerable: true,
      configurable: true,
      get(): Record<string, unknown> {
        getterReads += 1;
        throw new Error("adapter must not evaluate entry accessors");
      },
    });

    const accessorTaskEntry: Record<string, unknown> = {
      ref: ref("producer", "accessor-wrapper-task"),
    };
    Object.defineProperty(accessorTaskEntry, "task", {
      enumerable: true,
      configurable: true,
      get(): Record<string, unknown> {
        getterReads += 1;
        throw new Error("adapter must not evaluate entry accessors");
      },
    });

    const stepsWithAccessor: unknown[] = [step("safe-step"), undefined];
    Object.defineProperty(stepsWithAccessor, "1", {
      enumerable: true,
      configurable: true,
      get(): Record<string, unknown> {
        getterReads += 1;
        throw new Error("adapter must not evaluate step accessors");
      },
    });

    const customEntry = Object.assign(
      Object.create({ sourcePrototype: true }) as Record<string, unknown>,
      readEntry("producer", "custom-entry"),
    );
    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: [
          readEntry("producer", "valid"),
          readEntry("producer", "non-array-steps", "W1N1", {
            steps: { legacy: true },
          }),
          readEntry("producer", "malformed-step", "W1N1", {
            steps: [null, step("usable-step")],
          }),
          readEntry("producer", "accessor-step", "W1N1", {
            steps: stepsWithAccessor,
          }),
          { ref: ref("producer", "accessor-task"), task: taskWithAccessor },
          accessorRefEntry,
          accessorTaskEntry,
          customEntry,
          { ref: ref("producer", "map-task"), task: new Map() },
        ],
      }),
    });

    expect(result.entries.map((entry) => [entry.ref.localId, entry.activity]))
      .toEqual([
        ["accessor-step", "unknown"],
        ["accessor-task", "unknown"],
        ["malformed-step", "unknown"],
        ["non-array-steps", "unknown"],
        ["valid", "available"],
      ]);
    expect(result.entries.find((entry) => entry.ref.localId === "malformed-step")?.facts)
      .toEqual([expect.objectContaining({ stepId: "usable-step" })]);
    expect(result.entries.find((entry) => entry.ref.localId === "accessor-step")?.facts)
      .toEqual([expect.objectContaining({ stepId: "safe-step" })]);
    expect(result.invalidCount).toBe(4);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "carrier-read-ref-invalid" }),
      expect.objectContaining({ code: "carrier-task-record-malformed" }),
      expect.objectContaining({ code: "carrier-read-entry-malformed" }),
    ]));
    expect(getterReads).toBe(0);
  });

  test("preserves duplicate explicit refs for snapshot-level fail-closed handling", () => {
    const duplicate = ref("producer", "duplicate");
    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: [
          { ref: duplicate, task: task("duplicate", "producer", "W1N1") },
          { ref: { ...duplicate }, task: task("duplicate", "producer", "W1N1") },
        ],
      }),
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].ref).toEqual(result.entries[1].ref);
  });

  test("returns empty output for reset DTOs and deeply isolates every output layer", () => {
    expect(carrierLogisticsAdapter.snapshot({ board: asBoard({}) })).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });

    const sourceStep = step("isolated");
    const sourceTask = task("isolated", "producer", "W1N1", {
      steps: [sourceStep],
    });
    const sourceRef = ref("producer", "isolated");
    const board = asBoard({ W1N1: [
      { ref: sourceRef, task: sourceTask },
      7,
    ] });
    const before = JSON.parse(JSON.stringify(board));
    const first = carrierLogisticsAdapter.snapshot({ board });

    const mutableEntry = first.entries[0] as any;
    mutableEntry.ref.scope.roomName = "changed";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.facts[0].amount = 1;
    mutableEntry.issues.push({ code: "changed", message: "changed" });
    (first.issues as any[])[0].message = "changed";

    expect(board).toEqual(before);
    expect(sourceRef).toEqual(before.W1N1[0].ref);
    expect(sourceTask).toEqual(before.W1N1[0].task);
    expect(sourceStep).toEqual(before.W1N1[0].task.steps[0]);

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
