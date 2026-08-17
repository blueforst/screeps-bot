import {
  claimCarrierTaskStepAmount,
  cleanupCarrierTaskBoard,
  clearCarrierTaskBoardForTest,
  findCarrierTaskByRef,
  getMutableCarrierTaskByRefForTest,
  listCarrierDispatchEntriesByRoom,
  listCarrierTasksByRoom,
  listCarrierTasksForProducer,
  peekCarrierTaskBoard,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTask,
  type CarrierTaskDraft,
  type CarrierTaskStep,
} from "@/runtime/carrierTaskBoard";
import {
  createCarrierDispatchRef,
  type CarrierDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

interface RawCarrierRecord {
  task: unknown;
  publishOrder: number;
}

interface RawCarrierRoomStore {
  byOwner: Map<string, Map<string, RawCarrierRecord>>;
  nextPublishOrder: number;
}

type CarrierTaskRuntimeGlobal = typeof global & {
  __carrierTaskBoard?: Map<string, RawCarrierRoomStore>;
};

const carrierTaskRuntimeGlobal = global as CarrierTaskRuntimeGlobal;

function makeStep(overrides: Partial<CarrierTaskStep> = {}): CarrierTaskStep {
  return {
    id: "step1",
    resource: "U" as ResourceConstant,
    fromKind: "terminal",
    toKind: "lab",
    fromId: "term123",
    toId: "lab456",
    amount: 500,
    ...overrides,
  };
}

function makeDraft(
  overrides: Partial<CarrierTaskDraft> & { id: string },
): CarrierTaskDraft {
  return {
    type: "lab_supply",
    priority: 100,
    steps: [makeStep()],
    ...overrides,
  };
}

function taskRef(
  producer: string,
  roomName: string,
  localId: string,
): CarrierDispatchRef {
  const ref = createCarrierDispatchRef(producer, roomName, localId);
  if (!ref) throw new Error("test fixture must use a valid CarrierDispatchRef");
  return ref;
}

function exactTask(
  producer: string,
  roomName: string,
  localId: string,
): CarrierTask {
  const task = findCarrierTaskByRef(taskRef(producer, roomName, localId));
  if (!task) throw new Error(`missing Carrier task ${producer}/${roomName}/${localId}`);
  return task;
}

describe("carrierTaskBoard owner and capacity contracts", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 1000;
    Game.creeps = {};
  });

  it("isolates equal local ids by full producer ref and treats prototype strings as data keys", () => {
    const localId = "same:local->id";
    replaceCarrierTasksForProducerRoom("producer:a", "W1N1", [
      makeDraft({ id: localId, priority: 10 }),
    ]);
    replaceCarrierTasksForProducerRoom("producer:b", "W1N1", [
      makeDraft({ id: localId, priority: 20 }),
    ]);
    for (const [producer, prototypeLocalId] of [
      ["__proto__", "constructor"],
      ["constructor", "toString"],
      ["toString", "__proto__"],
    ] as const) {
      replaceCarrierTasksForProducerRoom(producer, "W1N1", [
        makeDraft({ id: prototypeLocalId }),
      ]);
      expect(findCarrierTaskByRef(taskRef(producer, "W1N1", prototypeLocalId)))
        .toBeDefined();
    }

    expect(findCarrierTaskByRef(taskRef("producer:a", "W1N1", localId))?.priority)
      .toBe(10);
    expect(findCarrierTaskByRef(taskRef("producer:b", "W1N1", localId))?.priority)
      .toBe(20);
    expect(findCarrierTaskByRef(taskRef("producer:a", "W2N2", localId)))
      .toBeUndefined();

    const sourceRef = taskRef("producer:a", "W1N1", localId);
    let getterReads = 0;
    const proxyRef = new Proxy(sourceRef, {
      get(): never {
        getterReads += 1;
        throw new Error("exact lookup must not use property getters");
      },
    });
    expect(findCarrierTaskByRef(proxyRef)).toBe(exactTask("producer:a", "W1N1", localId));
    expect(getterReads).toBe(0);
  });

  it("reconciles producer scope and keeps deterministic publish ordering", () => {
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "shared", priority: 10 }),
      makeDraft({ id: "only-a" }),
    ]);
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [
      makeDraft({ id: "shared", priority: 20 }),
      makeDraft({ id: "only-b" }),
    ]);
    replaceCarrierTasksForProducerRoom("prodA", "W2N2", [makeDraft({ id: "invalid" })]);
    replaceCarrierTasksForProducerRoom("prodB", "W2N2", [makeDraft({ id: "retained" })]);

    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "shared", priority: 30 }),
    ]);
    expect(pruneCarrierTasksForProducer("prodA", new Set(["W1N1"]))).toBe(1);

    expect(findCarrierTaskByRef(taskRef("prodA", "W1N1", "only-a")))
      .toBeUndefined();
    expect(findCarrierTaskByRef(taskRef("prodA", "W1N1", "shared"))?.priority)
      .toBe(30);
    expect(findCarrierTaskByRef(taskRef("prodA", "W2N2", "invalid")))
      .toBeUndefined();
    expect(findCarrierTaskByRef(taskRef("prodB", "W1N1", "shared"))?.priority)
      .toBe(20);
    expect(findCarrierTaskByRef(taskRef("prodB", "W2N2", "retained")))
      .toBeDefined();
    expect(listCarrierTasksForProducer("prodB")).toHaveLength(3);

    clearCarrierTaskBoardForTest();
    Game.time = 1000;
    replaceCarrierTasksForProducerRoom("rank-a", "W1N1", [
      makeDraft({ id: "a", priority: 10 }),
    ]);
    replaceCarrierTasksForProducerRoom("rank-b", "W1N1", [
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id))
      .toEqual(["a", "b"]);

    Game.time = 1001;
    replaceCarrierTasksForProducerRoom("rank-a", "W1N1", [
      makeDraft({ id: "a", priority: 10 }),
    ]);
    expect(exactTask("rank-a", "W1N1", "a")).toMatchObject({
      createdAt: 1000,
      updatedAt: 1001,
    });
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id))
      .toEqual(["a", "b"]);

    replaceCarrierTasksForProducerRoom("rank-a", "W1N1", []);
    Game.time = 1000;
    replaceCarrierTasksForProducerRoom("rank-a", "W1N1", [
      makeDraft({ id: "a", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id))
      .toEqual(["b", "a"]);

    clearCarrierTaskBoardForTest();
    Game.time = 1000;
    replaceCarrierTasksForProducerRoom("older-high", "W1N1", [
      makeDraft({ id: "older-high", priority: 10 }),
    ]);
    Game.time = 1001;
    replaceCarrierTasksForProducerRoom("newer-high", "W1N1", [
      makeDraft({ id: "newer-high", priority: 10 }),
    ]);
    replaceCarrierTasksForProducerRoom("low", "W1N1", [
      makeDraft({ id: "low", priority: 0 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual([
      "older-high",
      "newer-high",
      "low",
    ]);
  });

  it("keeps the TTL boundary and removes stale, lost-room, and room-mismatched records", () => {
    Game.time = 900;
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "stale" }),
      makeDraft({ id: "boundary" }),
    ]);
    const stale = getMutableCarrierTaskByRefForTest(taskRef("prod", "W1N1", "stale"));
    if (!stale) throw new Error("missing stale fixture");
    stale.updatedAt = 899;

    Game.time = 1000;
    replaceCarrierTasksForProducerRoom("other", "W1N1", [makeDraft({ id: "mismatch" })]);
    replaceCarrierTasksForProducerRoom("prod", "W2N2", [makeDraft({ id: "lost" })]);
    const mismatch = getMutableCarrierTaskByRefForTest(
      taskRef("other", "W1N1", "mismatch"),
    );
    if (!mismatch) throw new Error("missing mismatch fixture");
    mismatch.roomName = "W9N9";

    expect(cleanupCarrierTaskBoard(new Set(["W1N1"]), 100)).toBe(3);
    expect(findCarrierTaskByRef(taskRef("prod", "W1N1", "boundary")))
      .toBeDefined();
    expect(findCarrierTaskByRef(taskRef("prod", "W1N1", "stale")))
      .toBeUndefined();
    expect(findCarrierTaskByRef(taskRef("other", "W1N1", "mismatch")))
      .toBeUndefined();
    expect(peekCarrierTaskBoard().W2N2).toBeUndefined();
  });

  it("owns publish data and snapshots while malformed accessors fail closed", () => {
    const draft = makeDraft({
      id: "owned",
      priority: 100,
      steps: [makeStep({ id: "owned-step", amount: 400 })],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    (draft as { priority: number }).priority = 1;
    (draft.steps[0] as { amount: number }).amount = 1;

    const snapshot = peekCarrierTaskBoard();
    (snapshot.W1N1[0].ref as { namespace: string }).namespace = "snapshot-only";
    (snapshot.W1N1[0].task.steps[0] as { amount: number }).amount = 2;
    expect(exactTask("producer", "W1N1", "owned")).toMatchObject({
      priority: 100,
      steps: [expect.objectContaining({ id: "owned-step", amount: 400 })],
    });

    const board = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const room = board?.get("W1N1");
    const owner = room?.byOwner.get("producer");
    if (!board || !room || !owner) throw new Error("missing raw board fixture");
    let getterReads = 0;
    const accessorRecord = { publishOrder: 1000 } as RawCarrierRecord;
    Object.defineProperty(accessorRecord, "task", {
      enumerable: true,
      configurable: true,
      get(): never {
        getterReads += 1;
        throw new Error("selectors must not execute malformed accessors");
      },
    });
    owner.set("accessor", accessorRecord);
    board.set("__proto__", room);
    board.set("constructor", room);

    const malformedSnapshot = peekCarrierTaskBoard().W1N1;
    expect(malformedSnapshot.map((entry) => entry.ref.localId))
      .toEqual(["owned", "accessor"]);
    expect(malformedSnapshot.find((entry) => entry.ref.localId === "accessor")?.task)
      .toBeUndefined();
    expect(listCarrierDispatchEntriesByRoom("W1N1")).toHaveLength(2);
    expect(getterReads).toBe(0);
  });

  it("isolates claim capacity by composite ref and caps both task and step budgets", () => {
    for (const producer of ["producer:a\u0000segment", "producer:a"] as const) {
      replaceCarrierTasksForProducerRoom(producer, "W1N1", [makeDraft({
        id: producer === "producer:a" ? "segment\u0000same" : "same",
        steps: [makeStep({ id: "step:\u0000->", amount: 500 })],
      })]);
    }
    const first = exactTask("producer:a\u0000segment", "W1N1", "same");
    const second = exactTask("producer:a", "W1N1", "segment\u0000same");
    expect(claimCarrierTaskStepAmount(first, first.steps[0], "carrier-a", 500)?.amount)
      .toBe(500);
    expect(claimCarrierTaskStepAmount(second, second.steps[0], "carrier-b", 500)?.amount)
      .toBe(500);

    replaceCarrierTasksForProducerRoom("capacity", "W1N1", [makeDraft({
      id: "caps",
      steps: [
        makeStep({ id: "storage", amount: 600 }),
        makeStep({ id: "terminal", fromId: "term789", amount: 400 }),
      ],
    })]);
    const task = exactTask("capacity", "W1N1", "caps");
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "a", 800)?.amount)
      .toBe(600);
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "b", 800)).toBeNull();
    expect(claimCarrierTaskStepAmount(task, task.steps[1], "c", 800)?.amount)
      .toBe(400);
  });

  it("preserves exact claims across refresh and reclaims only releasable or dead ownership", () => {
    const refreshDraft = makeDraft({
      id: "refresh",
      steps: [makeStep({ amount: 1_000 })],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [refreshDraft]);
    let task = exactTask("producer", "W1N1", "refresh");
    const first = claimCarrierTaskStepAmount(task, task.steps[0], "carrier-a", 600);
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [refreshDraft]);
    task = exactTask("producer", "W1N1", "refresh");
    const remainder = claimCarrierTaskStepAmount(task, task.steps[0], "carrier-b", 1_000);
    expect(remainder?.amount).toBe(400);
    remainder?.release();
    first?.commit();
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [refreshDraft]);
    task = exactTask("producer", "W1N1", "refresh");
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "carrier-c", 1_000)?.amount)
      .toBe(400);

    clearCarrierTaskBoardForTest();
    const cleanupDraft = makeDraft({
      id: "cleanup",
      steps: [makeStep({ id: "a", amount: 600 }), makeStep({ id: "b", amount: 400 })],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [cleanupDraft]);
    task = exactTask("producer", "W1N1", "cleanup");
    claimCarrierTaskStepAmount(task, task.steps[0], "uncommitted", 600);
    claimCarrierTaskStepAmount(task, task.steps[1], "committed", 400)?.commit();
    replaceCarrierTasksForProducerRoom("producer", "W1N1", []);
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [cleanupDraft]);
    task = exactTask("producer", "W1N1", "cleanup");
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "replacement", 600)?.amount)
      .toBe(600);
    expect(claimCarrierTaskStepAmount(task, task.steps[1], "blocked", 400)).toBeNull();

    clearCarrierTaskBoardForTest();
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [refreshDraft]);
    task = exactTask("producer", "W1N1", "refresh");
    Game.creeps.live = { name: "live" } as Creep;
    claimCarrierTaskStepAmount(task, task.steps[0], "live", 1_000)?.commit();
    delete Game.creeps.live;
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "after-death", 1_000)?.amount)
      .toBe(1_000);
  });
});
