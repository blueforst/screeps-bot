import powerCreepActionAdapter from "@/runtime/taskSystem/adapters/powerCreepAction";

function task(
  id: string,
  priority: number,
  createdAt: number,
): Record<string, unknown> {
  return {
    id,
    type: id,
    priority,
    createdAt,
    targetId: `${id}-target`,
  };
}

describe("powerCreepActionAdapter", () => {
  test("projects actor-scoped queue work with stable namespace and authorities", () => {
    const alphaQueue = [
      task("renew", 1_000, 20),
      task("enable_room", 950, 10),
    ];
    const source = {
      "operator:z": {
        homeRoom: "W9N9",
        tasks: [task("generate_ops", 300, 30)],
      },
      "operator:a": {
        homeRoom: "W1N1",
        lastControlTick: 42,
        tasks: alphaQueue,
      },
    };
    const before = JSON.parse(JSON.stringify(source));

    const result = powerCreepActionAdapter.snapshot({
      powerCreepMemory: source,
      actorNames: ["operator:z", "operator:a"],
    });

    expect(result.invalidCount).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => [
      entry.ref.scope,
      entry.ref.localId,
      entry.activity,
      entry.sourceState,
      entry.createdAt,
    ])).toEqual([
      [{ kind: "actor", actorId: "operator:a" }, "enable_room", "available", "queued", 10],
      [{ kind: "actor", actorId: "operator:a" }, "renew", "available", "queued", 20],
      [{ kind: "actor", actorId: "operator:z" }, "generate_ops", "available", "queued", 30],
    ]);
    expect(result.entries[0].ref.namespace).toBe("powerCreepControl");
    expect(result.entries[0].authorities).toEqual([
      { role: "queue_owner", id: "operator:a" },
      { role: "executor", id: "operator:a" },
    ]);
    expect(source).toEqual(before);
    expect(alphaQueue.map((entry) => entry.id)).toEqual(["renew", "enable_room"]);
  });

  test("reads the real Memory.powerCreeps shape and leaves missing legacy queues absent", () => {
    const source = Object.freeze({
      absentQueue: Object.freeze({ homeRoom: "W1N1" }),
      emptyQueue: Object.freeze({ tasks: Object.freeze([]) }),
    });

    expect(powerCreepActionAdapter.snapshot({
      powerCreepMemory: undefined,
      actorNames: ["currentWithoutMemory"],
    })).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(powerCreepActionAdapter.snapshot({
      powerCreepMemory: source,
      actorNames: ["emptyQueue", "absentQueue"],
    })).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(Object.prototype.hasOwnProperty.call(source.absentQueue, "tasks")).toBe(false);
  });

  test("projects only current Game actor names and reports stale Memory actors", () => {
    const result = powerCreepActionAdapter.snapshot({
      powerCreepMemory: {
        renamedActor: { tasks: [task("renew", 1_000, 10)] },
        currentActor: { tasks: [task("generate_ops", 300, 20)] },
      },
      actorNames: ["currentActor", "currentWithoutMemory"],
    });

    expect(result.entries).toHaveLength(2);
    const currentEntry = result.entries.find((entry) =>
      entry.ref.scope.kind === "actor" && entry.ref.scope.actorId === "currentActor");
    const staleEntry = result.entries.find((entry) =>
      entry.ref.scope.kind === "actor" && entry.ref.scope.actorId === "renamedActor");
    expect(currentEntry).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        scope: { kind: "actor", actorId: "currentActor" },
      }),
      authorities: [
        { role: "queue_owner", id: "currentActor" },
        { role: "executor", id: "currentActor" },
      ],
    }));
    expect(staleEntry).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        scope: { kind: "actor", actorId: "renamedActor" },
        localId: "renew",
      }),
      activity: "unknown",
      sourceState: "stale_actor",
      authorities: [],
      issues: [expect.objectContaining({
        code: "power-creep-memory-actor-stale",
        message: expect.stringContaining("Game.powerCreeps"),
        field: "renamedActor",
      })],
    }));
    expect(result.invalidCount).toBe(0);
    expect(result.issues).toEqual([]);
  });

  test("keeps only system diagnostics when stale task identity cannot be proven", () => {
    const result = powerCreepActionAdapter.snapshot({
      powerCreepMemory: {
        staleWithoutQueue: {},
        staleEmptyQueue: { tasks: [] },
        staleMissingId: {
          tasks: [{ type: "renew", priority: 1_000, createdAt: 3 }],
        },
        staleMalformedTask: { tasks: [null] },
        staleMalformedMemory: 1,
      },
      actorNames: [],
    });

    expect(result.entries).toEqual([]);
    expect(result.invalidCount).toBe(5);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "power-creep-memory-actor-stale",
      "power-creep-task-id-invalid",
      "power-creep-task-malformed",
      "power-creep-memory-record-malformed",
    ]));
    expect(result.issues.filter(
      (issue) => issue.code === "power-creep-memory-actor-stale",
    )).toHaveLength(2);
  });

  test("retains stale actor state when duplicate task ids are merged", () => {
    const result = powerCreepActionAdapter.snapshot({
      powerCreepMemory: {
        staleActor: {
          tasks: [
            task("renew", 1_000, 20),
            { ...task("renew", 900, 10), targetId: "" },
          ],
        },
      },
      actorNames: [],
    });

    expect(result.entries).toEqual([expect.objectContaining({
      activity: "unknown",
      sourceState: "stale_actor",
      authorities: [],
      issues: [
        expect.objectContaining({ code: "power-creep-memory-actor-stale" }),
        expect.objectContaining({ code: "power-creep-task-id-duplicate" }),
        expect.objectContaining({ code: "power-creep-task-target-required" }),
      ],
    })]);
    expect(result.entries[0].createdAt).toBeUndefined();
    expect(result.invalidCount).toBe(1);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "power-creep-task-id-duplicate" }),
    ]);
  });

  test("fails closed for malformed actor identity context", () => {
    const powerCreepMemory = {
      operator: { tasks: [task("renew", 1_000, 20)] },
    };

    expect(powerCreepActionAdapter.snapshot(undefined as any)).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({
        code: "power-creep-adapter-context-malformed",
      })],
    });
    expect(powerCreepActionAdapter.snapshot({ powerCreepMemory } as any)).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({
        code: "power-creep-actor-names-malformed",
      })],
    });
    expect(powerCreepActionAdapter.snapshot({
      powerCreepMemory,
      actorNames: "operator",
    } as any)).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({
        code: "power-creep-actor-names-malformed",
      })],
    });
    expect(powerCreepActionAdapter.snapshot({
      powerCreepMemory,
      actorNames: ["operator", "", "operator"],
    })).toEqual({
      entries: [],
      invalidCount: 2,
      issues: [
        expect.objectContaining({ code: "power-creep-actor-name-duplicate" }),
        expect.objectContaining({ code: "power-creep-actor-name-invalid" }),
      ],
    });
  });

  test("bounds stale Memory diagnostics deterministically", () => {
    const staleActorNames = Array.from(
      { length: 25 },
      (_, index) => `stale:${String(index).padStart(2, "0")}`,
    );
    const forwardSource = Object.fromEntries(staleActorNames.map((actorId) => [actorId, {}]));
    const reverseSource = Object.fromEntries(
      [...staleActorNames].reverse().map((actorId) => [actorId, {}]),
    );

    const forward = powerCreepActionAdapter.snapshot({
      powerCreepMemory: forwardSource,
      actorNames: [],
    });
    const reversed = powerCreepActionAdapter.snapshot({
      powerCreepMemory: reverseSource,
      actorNames: [],
    });

    expect(reversed).toEqual(forward);
    expect(forward.entries).toEqual([]);
    expect(forward.invalidCount).toBe(25);
    expect(forward.issues).toHaveLength(20);
    expect(forward.issues.map((issue) => issue.field)).toEqual(staleActorNames.slice(0, 20));
  });

  test("never reads an engine actor prototype memory getter", () => {
    const getter = jest.fn(() => ({ tasks: [task("renew", 1_000, 20)] }));
    const engineActor = Object.create({
      get memory() {
        return getter();
      },
    }) as Record<string, unknown>;

    const result = powerCreepActionAdapter.snapshot({
      // This deliberately passes an actor-shaped negative sample as a memory
      // record. The adapter must neither discover its prototype getter nor
      // pretend that Game.powerCreeps is a valid Memory.powerCreeps source.
      powerCreepMemory: { operator: engineActor },
      actorNames: ["operator"],
    });

    expect(result).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "power-creep-engine-actor-source",
        message: expect.stringContaining("Memory.powerCreeps"),
        field: "operator",
      }],
    });
    expect(getter).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(engineActor, "tasks")).toBe(false);
  });

  test("fails closed for legacy and malformed tasks while preserving provable refs", () => {
    const result = powerCreepActionAdapter.snapshot({
      powerCreepMemory: {
        operator: {
          tasks: [
            { id: "renew", type: "renew" },
            { id: "future", type: "future", priority: 1, createdAt: 2 },
            { type: "renew", priority: 1_000, createdAt: 3 },
            null,
          ],
        },
        brokenQueue: { tasks: "legacy" },
        brokenMemory: 1,
      },
      actorNames: ["brokenMemory", "operator", "brokenQueue"],
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => [entry.ref.localId, entry.activity])).toEqual([
      ["future", "unknown"],
      ["renew", "unknown"],
    ]);
    expect(result.entries.find((entry) => entry.ref.localId === "renew")?.issues.map(
      (issue) => issue.code,
    )).toEqual([
      "power-creep-task-priority-invalid",
      "power-creep-task-created-at-invalid",
      "power-creep-task-target-required",
    ]);
    expect(result.entries.find((entry) => entry.ref.localId === "future")?.issues.map(
      (issue) => issue.code,
    )).toContain("power-creep-task-type-invalid");
    expect(result.invalidCount).toBe(4);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "power-creep-task-id-invalid",
      "power-creep-task-malformed",
      "power-creep-queue-malformed",
      "power-creep-memory-record-malformed",
    ]));
  });

  test("returns deeply isolated projection objects", () => {
    const sourceTask = task("renew", 1_000, 20);
    const source = { operator: { tasks: [sourceTask] } };
    const first = powerCreepActionAdapter.snapshot({
      powerCreepMemory: source,
      actorNames: ["operator"],
    });

    const mutableEntry = first.entries[0] as any;
    mutableEntry.ref.scope.actorId = "changed";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.issues.push({ code: "changed", message: "changed" });

    expect(sourceTask).toEqual(task("renew", 1_000, 20));
    expect(powerCreepActionAdapter.snapshot({
      powerCreepMemory: source,
      actorNames: ["operator"],
    }).entries[0]).toEqual(
      expect.objectContaining({
        ref: expect.objectContaining({
          scope: { kind: "actor", actorId: "operator" },
        }),
        authorities: [
          { role: "queue_owner", id: "operator" },
          { role: "executor", id: "operator" },
        ],
        issues: [],
      }),
    );
  });

  test("merges duplicate ids per actor into one deterministic conflict entry", () => {
    const firstDuplicate = task("renew", 1_000, 20);
    const secondDuplicate = {
      ...task("renew", 900, 10),
      targetId: "",
    };
    const sibling = task("enable_room", 950, 5);
    const siblingDuplicate = task("enable_room", 900, 6);
    const generateOps = task("generate_ops", 300, 30);
    delete generateOps.targetId;

    const forward = powerCreepActionAdapter.snapshot({
      powerCreepMemory: {
        operator: {
          tasks: [firstDuplicate, sibling, secondDuplicate, generateOps, siblingDuplicate],
        },
      },
      actorNames: ["operator"],
    });
    const reversed = powerCreepActionAdapter.snapshot({
      powerCreepMemory: {
        operator: {
          tasks: [siblingDuplicate, generateOps, secondDuplicate, sibling, firstDuplicate],
        },
      },
      actorNames: ["operator"],
    });

    expect(forward).toEqual(reversed);
    expect(forward.entries.map((entry) => entry.ref.localId)).toEqual([
      "enable_room",
      "generate_ops",
      "renew",
    ]);
    expect(forward.entries.find((entry) => entry.ref.localId === "generate_ops")).toEqual(
      expect.objectContaining({ activity: "available", sourceState: "queued" }),
    );
    expect(forward.entries.find((entry) => entry.ref.localId === "renew")).toEqual(
      expect.objectContaining({
        activity: "unknown",
        sourceState: "duplicate",
        issues: [
          expect.objectContaining({ code: "power-creep-task-id-duplicate" }),
          expect.objectContaining({ code: "power-creep-task-target-required" }),
        ],
      }),
    );
    expect(forward.entries.find((entry) => entry.ref.localId === "renew")?.createdAt).toBeUndefined();
    expect(forward.entries.find((entry) => entry.ref.localId === "enable_room")).toEqual(
      expect.objectContaining({ activity: "unknown", sourceState: "duplicate" }),
    );
    expect(forward.invalidCount).toBe(2);
    expect(forward.issues).toEqual([
      expect.objectContaining({ code: "power-creep-task-id-duplicate" }),
      expect.objectContaining({ code: "power-creep-task-id-duplicate" }),
    ]);
  });

  test.each([
    "enable_room",
    "renew",
    "deposit_ops",
    "operate_storage",
    "regen_source",
    "operate_extension",
  ])("requires targetId for %s", (type) => {
    const rawTask = task(type, 100, 10);
    delete rawTask.targetId;

    const result = powerCreepActionAdapter.snapshot({
      powerCreepMemory: { operator: { tasks: [rawTask] } },
      actorNames: ["operator"],
    });

    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "unknown",
      sourceState: "queued",
      issues: [expect.objectContaining({
        code: "power-creep-task-target-required",
        field: "targetId",
      })],
    }));
  });
});
