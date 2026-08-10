import {
  claimCarrierTaskStepAmount,
  cleanupCarrierTaskBoard,
  clearCarrierTaskBoardForTest,
  findCarrierTaskByRef,
  getCarrierTasksByRoom,
  getMutableCarrierTaskByRefForTest,
  getMutableCarrierTasksByRoomForTest,
  listCarrierDispatchEntriesByRoom,
  listCarrierTasksByRoom,
  listCarrierTasksForProducer,
  peekCarrierTaskBoard,
  peekCarrierTasksByRoom,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTask,
  type CarrierTaskDraft,
  type CarrierTaskStep,
  type MutableCarrierTaskForTest,
} from "@/runtime/carrierTaskBoard";
import {
  createCarrierDispatchRef,
  type CarrierDispatchRef,
} from "@/runtime/dispatchOwnership/ref";
import {
  createSingleStepDraft,
  resolveTerminalStorageTarget,
} from "@/runtime/carrierTaskHelpers";

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
  __carrierTaskClaims?: unknown;
};

const carrierTaskRuntimeGlobal = global as CarrierTaskRuntimeGlobal;

function globalPropertyNames(): string[] {
  return Object.getOwnPropertyNames(global).sort();
}

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

describe("carrierTaskBoard owner-scoped storage", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 1000;
    Game.creeps = {};
  });

  it("keeps the private global name and materializes an empty room on an empty first replace", () => {
    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskBoard"))
      .toBe(false);

    replaceCarrierTasksForProducerRoom("missing-producer", "W9N9", []);

    const board = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    expect(board).toBeInstanceOf(Map);
    expect(board?.has("W9N9")).toBe(true);
    expect(board?.get("W9N9")?.byOwner).toBeInstanceOf(Map);
    expect(board?.get("W9N9")?.byOwner.size).toBe(0);
  });

  it("coexists and performs exact lookup for equal local ids from different producers", () => {
    const localId = "same:local->id";
    replaceCarrierTasksForProducerRoom(
      "producer:a",
      "W1N1",
      [makeDraft({ id: localId, priority: 10 })],
    );
    replaceCarrierTasksForProducerRoom(
      "producer:b",
      "W1N1",
      [makeDraft({ id: localId, priority: 20 })],
    );

    const entries = listCarrierDispatchEntriesByRoom("W1N1");
    expect(entries.map((entry) => [
      entry.ref.namespace,
      entry.ref.scope.roomName,
      entry.ref.localId,
    ])).toEqual([
      ["producer:b", "W1N1", localId],
      ["producer:a", "W1N1", localId],
    ]);
    expect(findCarrierTaskByRef(taskRef("producer:a", "W1N1", localId))?.priority)
      .toBe(10);
    expect(findCarrierTaskByRef(taskRef("producer:b", "W1N1", localId))?.priority)
      .toBe(20);
    expect(findCarrierTaskByRef(taskRef("producer:a", "W2N2", localId)))
      .toBeUndefined();
  });

  it("clones exact lookup refs through own descriptors without invoking property getters", () => {
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [
      makeDraft({ id: "descriptor-safe" }),
    ]);
    const sourceRef = taskRef("producer", "W1N1", "descriptor-safe");
    let getterReads = 0;
    const proxyRef = new Proxy(sourceRef, {
      get(): never {
        getterReads += 1;
        throw new Error("exact lookup must not use property getters");
      },
    });

    expect(findCarrierTaskByRef(proxyRef)).toBe(
      exactTask("producer", "W1N1", "descriptor-safe"),
    );
    expect(getterReads).toBe(0);

    const accessorRef = { ...sourceRef } as Record<string, unknown>;
    Object.defineProperty(accessorRef, "scope", {
      enumerable: true,
      configurable: true,
      get(): never {
        getterReads += 1;
        throw new Error("exact lookup must reject accessor refs");
      },
    });
    expect(findCarrierTaskByRef(accessorRef as unknown as CarrierDispatchRef))
      .toBeUndefined();
    expect(getterReads).toBe(0);
  });

  it("treats prototype property strings as ordinary producer and local-id keys", () => {
    const fixtures = [
      ["__proto__", "constructor"],
      ["constructor", "toString"],
      ["toString", "__proto__"],
    ] as const;
    for (const [producer, localId] of fixtures) {
      replaceCarrierTasksForProducerRoom(
        producer,
        "W1N1",
        [makeDraft({ id: localId })],
      );
    }

    expect(listCarrierDispatchEntriesByRoom("W1N1").map((entry) => [
      entry.ref.namespace,
      entry.ref.localId,
    ])).toEqual(fixtures);
    for (const [producer, localId] of fixtures) {
      expect(findCarrierTaskByRef(taskRef(producer, "W1N1", localId)))
        .toBeDefined();
    }
  });

  it("reconciles only one producer snapshot and leaves another owner untouched", () => {
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "shared", priority: 10 }),
      makeDraft({ id: "only-a" }),
    ]);
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [
      makeDraft({ id: "shared", priority: 20 }),
      makeDraft({ id: "only-b" }),
    ]);

    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "shared", priority: 30 }),
    ]);

    expect(findCarrierTaskByRef(taskRef("prodA", "W1N1", "only-a")))
      .toBeUndefined();
    expect(findCarrierTaskByRef(taskRef("prodA", "W1N1", "shared"))?.priority)
      .toBe(30);
    expect(findCarrierTaskByRef(taskRef("prodB", "W1N1", "shared"))?.priority)
      .toBe(20);
    expect(findCarrierTaskByRef(taskRef("prodB", "W1N1", "only-b")))
      .toBeDefined();
    expect(listCarrierTasksForProducer("prodB")).toHaveLength(2);
  });

  it("prunes invalid producer rooms without touching another owner", () => {
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [makeDraft({ id: "valid" })]);
    replaceCarrierTasksForProducerRoom("prodA", "W2N2", [makeDraft({ id: "invalid" })]);
    replaceCarrierTasksForProducerRoom("prodB", "W2N2", [makeDraft({ id: "retained" })]);

    expect(pruneCarrierTasksForProducer("prodA", new Set(["W1N1"]))).toBe(1);
    expect(findCarrierTaskByRef(taskRef("prodA", "W1N1", "valid")))
      .toBeDefined();
    expect(findCarrierTaskByRef(taskRef("prodA", "W2N2", "invalid")))
      .toBeUndefined();
    expect(findCarrierTaskByRef(taskRef("prodB", "W2N2", "retained")))
      .toBeDefined();
  });

  it("keeps the TTL boundary and removes stale, lost-room, and room-mismatched records", () => {
    Game.time = 899;
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [makeDraft({ id: "stale" })]);
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

  it("owns a deep copy of publish drafts and nested steps", () => {
    const draft = makeDraft({
      id: "alias-test",
      priority: 100,
      steps: [makeStep({ id: "owned-step", amount: 400 })],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);

    const mutableDraft = draft as unknown as {
      priority: number;
      steps: MutableCarrierTaskForTest["steps"];
    };
    mutableDraft.priority = 1;
    mutableDraft.steps[0].amount = 1;
    mutableDraft.steps.push({
      ...makeStep({ id: "injected" }),
    });

    const task = exactTask("producer", "W1N1", "alias-test");
    expect(task.priority).toBe(100);
    expect(task.steps).toEqual([expect.objectContaining({
      id: "owned-step",
      amount: 400,
    })]);
    expect(task.steps).not.toBe(draft.steps);
    expect(task.steps[0]).not.toBe(draft.steps[0]);
  });

  it("preserves createdAt and publish rank on refresh, then assigns a new rank after deletion", () => {
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "a", priority: 10 }),
    ]);
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id))
      .toEqual(["a", "b"]);

    Game.time = 1001;
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "a", priority: 10 }),
    ]);
    expect(exactTask("prodA", "W1N1", "a")).toMatchObject({
      createdAt: 1000,
      updatedAt: 1001,
    });
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id))
      .toEqual(["a", "b"]);

    replaceCarrierTasksForProducerRoom("prodA", "W1N1", []);
    Game.time = 1000;
    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "a", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id))
      .toEqual(["b", "a"]);
  });

  it("sorts by priority, createdAt, and private publish order", () => {
    replaceCarrierTasksForProducerRoom("older-high", "W1N1", [
      makeDraft({ id: "older-high", priority: 10 }),
    ]);
    Game.time += 1;
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

  it("exposes deep-readonly live production views and an explicit mutable test helper", () => {
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [
      makeDraft({ id: "live", steps: [makeStep({ amount: 321 })] }),
    ]);
    const first = listCarrierDispatchEntriesByRoom("W1N1")[0];
    expect(findCarrierTaskByRef(first.ref)).toBe(first.task);
    expect(getMutableCarrierTaskByRefForTest(first.ref)).toBe(first.task);
    expect(getMutableCarrierTasksByRoomForTest("W1N1").live).toBe(first.task);
    expect(getCarrierTasksByRoom("W1N1").live).toBe(first.task);

    if (false) {
      // @ts-expect-error production task identity is readonly
      first.task.producer = "mutated";
      // @ts-expect-error nested production steps are readonly
      first.task.steps[0].amount = 1;
      // @ts-expect-error the production steps array is readonly
      first.task.steps.push(makeStep());
    }

    replaceCarrierTasksForProducerRoom("other", "W1N1", [
      makeDraft({ id: "live" }),
    ]);
    expect(() => getMutableCarrierTasksByRoomForTest("W1N1"))
      .toThrow("Ambiguous Carrier localId live");
  });

  it("peeks without ensure and deeply isolates full refs, tasks, and steps", () => {
    const propertiesBefore = globalPropertyNames();
    expect(peekCarrierTaskBoard()).toEqual({});
    expect(peekCarrierTasksByRoom("W9N9")).toEqual([]);
    expect(globalPropertyNames()).toEqual(propertiesBefore);
    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskBoard"))
      .toBe(false);

    replaceCarrierTasksForProducerRoom("prodA", "W1N1", [
      makeDraft({ id: "same", steps: [makeStep({ amount: 111 })] }),
    ]);
    replaceCarrierTasksForProducerRoom("prodB", "W1N1", [
      makeDraft({ id: "same", steps: [makeStep({ amount: 222 })] }),
    ]);
    const boardBefore = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const snapshot = peekCarrierTaskBoard();
    const roomSnapshot = peekCarrierTasksByRoom("W1N1");

    expect(snapshot.W1N1.map((entry) => entry.ref.namespace))
      .toEqual(["prodA", "prodB"]);
    expect(roomSnapshot).toEqual(snapshot.W1N1);
    expect(snapshot.W1N1[0].task).not.toBe(
      exactTask("prodA", "W1N1", "same"),
    );
    expect(snapshot.W1N1[0].task.steps[0]).not.toBe(
      exactTask("prodA", "W1N1", "same").steps[0],
    );
    const mutableSnapshot = snapshot as unknown as Record<string, Array<{
      ref: { namespace: string; scope: { roomName: string } };
      task: MutableCarrierTaskForTest;
    }>>;
    mutableSnapshot.W1N1[0].ref.namespace = "mutated";
    mutableSnapshot.W1N1[0].ref.scope.roomName = "W9N9";
    mutableSnapshot.W1N1[0].task.steps[0].amount = 1;
    mutableSnapshot.W1N1.splice(1, 1);

    expect(exactTask("prodA", "W1N1", "same").steps[0].amount).toBe(111);
    expect(listCarrierDispatchEntriesByRoom("W1N1")).toHaveLength(2);
    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(boardBefore);
  });

  it("fails closed for illegal outer rooms and never executes malformed record accessors", () => {
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [
      makeDraft({ id: "valid" }),
    ]);
    const board = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const room = board?.get("W1N1");
    if (!board || !room) throw new Error("missing raw board fixture");
    const owner = room.byOwner.get("producer");
    if (!owner) throw new Error("missing raw owner fixture");

    let getterReads = 0;
    const accessorRecord = { publishOrder: 1000 } as RawCarrierRecord;
    Object.defineProperty(accessorRecord, "task", {
      enumerable: true,
      configurable: true,
      get(): never {
        getterReads += 1;
        throw new Error("read selector must not execute accessors");
      },
    });
    owner.set("accessor", accessorRecord);
    board.set("__proto__", room);
    board.set("constructor", room);
    board.set("toString", room);

    const snapshot = peekCarrierTaskBoard();
    expect(getterReads).toBe(0);
    expect(Object.keys(snapshot)).toEqual(["W1N1"]);
    expect(snapshot.W1N1.find((entry) => entry.ref.localId === "valid")?.task)
      .toEqual(exactTask("producer", "W1N1", "valid"));
    expect(snapshot.W1N1.find((entry) => entry.ref.localId === "accessor")?.task)
      .toBeUndefined();
  });

  it("isolates Proxy(Map), throwing iterable, and hostile Map properties without blocking valid owners", () => {
    replaceCarrierTasksForProducerRoom("valid-a", "W1N1", [
      makeDraft({ id: "task-a", priority: 20 }),
    ]);
    replaceCarrierTasksForProducerRoom("valid-b", "W1N1", [
      makeDraft({ id: "task-b", priority: 10 }),
    ]);
    const board = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    const room = board?.get("W1N1");
    if (!board || !room) throw new Error("missing raw board fixture");

    let getterReads = 0;
    const proxyOwner = new Proxy(new Map<string, RawCarrierRecord>(), {});
    const throwingIterable = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(throwingIterable, Symbol.iterator, {
      configurable: true,
      get(): never {
        getterReads += 1;
        throw new Error("malformed owner iterator must not be read");
      },
    });
    room.byOwner.set(
      "proxy-owner",
      proxyOwner as unknown as Map<string, RawCarrierRecord>,
    );
    room.byOwner.set(
      "throwing-owner",
      throwingIterable as unknown as Map<string, RawCarrierRecord>,
    );

    const validOwner = room.byOwner.get("valid-a");
    if (!validOwner) throw new Error("missing valid owner fixture");
    for (const key of ["get", "set", "delete", "values", "entries"] as const) {
      Object.defineProperty(validOwner, key, {
        configurable: true,
        get(): never {
          getterReads += 1;
          throw new Error(`private Map ${key} getter must not be read`);
        },
      });
    }
    Object.defineProperty(validOwner, Symbol.iterator, {
      configurable: true,
      get(): never {
        getterReads += 1;
        throw new Error("private Map iterator getter must not be read");
      },
    });

    expect(() => peekCarrierTaskBoard()).not.toThrow();
    expect(peekCarrierTaskBoard().W1N1.map((entry) => entry.ref.namespace))
      .toEqual(["valid-a", "valid-b"]);
    expect(listCarrierDispatchEntriesByRoom("W1N1").map(
      (entry) => entry.ref.namespace,
    )).toEqual(["valid-a", "valid-b"]);
    expect(findCarrierTaskByRef(taskRef("valid-a", "W1N1", "task-a")))
      .toBeDefined();
    expect(() => cleanupCarrierTaskBoard(new Set(["W1N1"]), 100))
      .not.toThrow();
    expect(getterReads).toBe(0);
  });

  it("fails closed on a proxied outer board without ensuring or invoking proxy getters", () => {
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [
      makeDraft({ id: "task" }),
    ]);
    const sourceBoard = carrierTaskRuntimeGlobal.__carrierTaskBoard;
    if (!sourceBoard) throw new Error("missing raw board fixture");
    let getterReads = 0;
    const proxiedBoard = new Proxy(sourceBoard, {
      get(): never {
        getterReads += 1;
        throw new Error("proxied Map properties must not be read");
      },
    });
    carrierTaskRuntimeGlobal.__carrierTaskBoard = proxiedBoard;

    expect(peekCarrierTaskBoard()).toEqual({});
    expect(peekCarrierTasksByRoom("W1N1")).toEqual([]);
    expect(findCarrierTaskByRef(taskRef("producer", "W1N1", "task")))
      .toBeUndefined();
    expect(carrierTaskRuntimeGlobal.__carrierTaskBoard).toBe(proxiedBoard);
    expect(getterReads).toBe(0);
  });

  it("preserves and clears optional dispatchClass through owner refresh", () => {
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [makeDraft({
      id: "capacity",
      dispatchClass: "capacity_relief",
    })]);
    expect(exactTask("producer", "W1N1", "capacity").dispatchClass)
      .toBe("capacity_relief");

    Game.time += 1;
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [makeDraft({
      id: "capacity",
      priority: 101,
    })]);
    expect(exactTask("producer", "W1N1", "capacity")).toEqual(
      expect.not.objectContaining({ dispatchClass: expect.anything() }),
    );
  });
});

describe("carrierTaskBoard amount compatibility gateway", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 2000;
    Game.creeps = {};
  });

  it("isolates equal task and step ids by full producer ref", () => {
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
  });

  it("keeps uncommitted and committed slices across exact refresh", () => {
    const draft = makeDraft({
      id: "refresh",
      steps: [makeStep({ amount: 1_000 })],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    let task = exactTask("producer", "W1N1", "refresh");
    const first = claimCarrierTaskStepAmount(task, task.steps[0], "carrier-a", 600);
    expect(first?.amount).toBe(600);

    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    task = exactTask("producer", "W1N1", "refresh");
    const uncommittedRemainder = claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-b",
      1_000,
    );
    expect(uncommittedRemainder?.amount).toBe(400);
    uncommittedRemainder?.release();

    first?.commit();
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    task = exactTask("producer", "W1N1", "refresh");
    expect(claimCarrierTaskStepAmount(
      task,
      task.steps[0],
      "carrier-c",
      1_000,
    )?.amount).toBe(400);
  });

  it("releases only uncommitted slices on exact deletion and retains committed slices", () => {
    const draft = makeDraft({
      id: "cleanup",
      steps: [makeStep({ id: "a", amount: 600 }), makeStep({ id: "b", amount: 400 })],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    let task = exactTask("producer", "W1N1", "cleanup");
    const uncommitted = claimCarrierTaskStepAmount(task, task.steps[0], "carrier-a", 600);
    const committed = claimCarrierTaskStepAmount(task, task.steps[1], "carrier-b", 400);
    committed?.commit();

    replaceCarrierTasksForProducerRoom("producer", "W1N1", []);
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    task = exactTask("producer", "W1N1", "cleanup");
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "carrier-c", 600)?.amount)
      .toBe(600);
    expect(claimCarrierTaskStepAmount(task, task.steps[1], "carrier-d", 400))
      .toBeNull();
    uncommitted?.commit();
    uncommitted?.release();
  });

  it("releases failed and thrown work, commits accepted work, and ignores stale handles", () => {
    const draft = makeDraft({ id: "outcome", steps: [makeStep({ amount: 1_000 })] });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    const task = exactTask("producer", "W1N1", "outcome");
    const failed = claimCarrierTaskStepAmount(task, task.steps[0], "carrier", 1_000);
    failed?.release();
    const current = claimCarrierTaskStepAmount(task, task.steps[0], "carrier", 700);
    failed?.commit();
    failed?.release();
    current?.commit();
    current?.release();
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "other", 1_000)?.amount)
      .toBe(300);
  });

  it("caps both whole-task and per-step budgets", () => {
    const draft = makeDraft({
      id: "caps",
      steps: [
        makeStep({ id: "storage", amount: 600 }),
        makeStep({ id: "terminal", fromId: "term789", amount: 400 }),
      ],
    });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    const task = exactTask("producer", "W1N1", "caps");
    const first = claimCarrierTaskStepAmount(task, task.steps[0], "a", 800);
    expect(first?.amount).toBe(600);
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "b", 800))
      .toBeNull();
    expect(claimCarrierTaskStepAmount(task, task.steps[1], "c", 800)?.amount)
      .toBe(400);
  });

  it("reclaims dead live claimants and resets on tick, Game identity, and global reset", () => {
    const draft = makeDraft({ id: "runtime", steps: [makeStep({ amount: 1_000 })] });
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    let task = exactTask("producer", "W1N1", "runtime");
    Game.creeps.live = { name: "live" } as Creep;
    const dead = claimCarrierTaskStepAmount(task, task.steps[0], "live", 1_000);
    dead?.commit();
    delete Game.creeps.live;
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "replacement", 1_000)?.amount)
      .toBe(1_000);

    Game.time += 1;
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "next-tick", 1_000)?.amount)
      .toBe(1_000);
    const originalGame = Game;
    try {
      (global as typeof global & { Game: Game }).Game = {
        ...originalGame,
        time: originalGame.time,
        creeps: {},
      } as Game;
      expect(claimCarrierTaskStepAmount(task, task.steps[0], "next-game", 1_000)?.amount)
        .toBe(1_000);
    } finally {
      (global as typeof global & { Game: Game }).Game = originalGame;
    }

    clearCarrierTaskBoardForTest();
    replaceCarrierTasksForProducerRoom("producer", "W1N1", [draft]);
    task = exactTask("producer", "W1N1", "runtime");
    expect(claimCarrierTaskStepAmount(task, task.steps[0], "post-reset", 1_000)?.amount)
      .toBe(1_000);
  });
});

describe("carrierTaskHelpers", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 1000;
  });

  it("createSingleStepDraft produces a draft accepted by the board", () => {
    const draft = createSingleStepDraft({
      taskId: "factoryControl:factory_supply:W1N1:battery",
      type: "factory_supply",
      priority: 110,
      producer: "factoryControl",
      roomName: "W1N1",
      resource: RESOURCE_BATTERY as ResourceConstant,
      fromKind: "storage",
      toKind: "factory",
      fromId: "storage-1",
      toId: "factory-1",
      amount: 500,
    });
    replaceCarrierTasksForProducerRoom("factoryControl", "W1N1", [draft]);

    const task = exactTask(
      "factoryControl",
      "W1N1",
      "factoryControl:factory_supply:W1N1:battery",
    );
    expect(task.steps[0].id).toBe(
      "factoryControl:W1N1:battery:storage-1->factory-1",
    );
  });

  it("resolveTerminalStorageTarget prefers terminal when it has capacity", () => {
    const terminal = {
      id: "term-1",
      structureType: STRUCTURE_TERMINAL,
      store: { getFreeCapacity: () => 5000 },
    } as unknown as StructureTerminal;
    const storage = {
      id: "stor-1",
      structureType: STRUCTURE_STORAGE,
      store: { getFreeCapacity: () => 5000 },
    } as unknown as StructureStorage;
    const room = { terminal, storage } as Room;

    expect(resolveTerminalStorageTarget(room, RESOURCE_ENERGY, "terminal"))
      .toBe(terminal);
  });
});
