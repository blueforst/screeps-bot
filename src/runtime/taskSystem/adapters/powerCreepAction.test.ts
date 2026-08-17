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

});
