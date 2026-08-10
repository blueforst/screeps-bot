import type { CarrierTaskBoardSnapshot } from "@/runtime/carrierTaskBoard";
import carrierLogisticsAdapter from "@/runtime/taskSystem/adapters/carrierLogistics";
import colonizationWorkflowAdapter from "@/runtime/taskSystem/adapters/colonizationWorkflow";
import crossShardColonizationWorkflowAdapter from "@/runtime/taskSystem/adapters/crossShardColonizationWorkflow";
import factoryCommandAdapter from "@/runtime/taskSystem/adapters/factoryCommand";
import flagHaulingWorkflowAdapter from "@/runtime/taskSystem/adapters/flagHaulingWorkflow";
import powerBankWorkflowAdapter from "@/runtime/taskSystem/adapters/powerBankWorkflow";
import powerCreepActionAdapter from "@/runtime/taskSystem/adapters/powerCreepAction";
import remoteMiningWorkflowAdapter from "@/runtime/taskSystem/adapters/remoteMiningWorkflow";
import rescueWorkflowAdapter from "@/runtime/taskSystem/adapters/rescueWorkflow";
import resourceTransferAdapter from "@/runtime/taskSystem/adapters/resourceTransfer";
import { spawnProductionAdapter } from "@/runtime/taskSystem/adapters/spawnProduction";
import warWorkflowAdapter from "@/runtime/taskSystem/adapters/warWorkflow";
import workerWorkAdapter from "@/runtime/taskSystem/adapters/workerWork";
import { TASK_SYSTEM_CATALOG, type TaskSystemId } from "@/runtime/taskSystem/catalog";
import type {
  TaskSystemAdapter,
  TaskSystemAdapterResult,
  WorkActivity,
  WorkProjectionIssue,
  WorkScope,
  WorkStatusView,
} from "@/runtime/taskSystem/model";
import type { TaskSystemCollectionContext } from "@/runtime/taskSystem/registry";
import { collectTaskSystemSnapshot } from "@/runtime/taskSystem/snapshot";

const ADAPTERS_BY_SYSTEM = {
  "worker-work": workerWorkAdapter,
  "carrier-logistics": carrierLogisticsAdapter,
  "power-creep-action": powerCreepActionAdapter,
  "resource-transfer": resourceTransferAdapter,
  "factory-command": factoryCommandAdapter,
  "remote-mining-workflow": remoteMiningWorkflowAdapter,
  "colonization-workflow": colonizationWorkflowAdapter,
  "rescue-workflow": rescueWorkflowAdapter,
  "flag-hauling-workflow": flagHaulingWorkflowAdapter,
  "cross-shard-colonization-workflow": crossShardColonizationWorkflowAdapter,
  "war-workflow": warWorkflowAdapter,
  "power-bank-workflow": powerBankWorkflowAdapter,
  "spawn-production": spawnProductionAdapter,
} as const satisfies Record<TaskSystemId, TaskSystemAdapter<any>>;

const EMPTY_RESULT: TaskSystemAdapterResult = {
  entries: [],
  invalidCount: 0,
  issues: [],
};

type AdapterImplementation = (...args: any[]) => TaskSystemAdapterResult;

function createContext(
  carrierBoard: CarrierTaskBoardSnapshot = {} as CarrierTaskBoardSnapshot,
): TaskSystemCollectionContext {
  return {
    observedAt: 72901508,
    shard: "shard:1->snapshot",
    sources: {
      "worker-work": { board: {}, assignments: {} },
      "carrier-logistics": { board: carrierBoard },
      "power-creep-action": { powerCreepMemory: {}, actorNames: [] },
      "factory-command": { tasks: {} },
    },
  };
}

function createEntry(input: {
  readonly system: TaskSystemId;
  readonly namespace?: string;
  readonly localId?: string;
  readonly scope?: WorkScope;
  readonly activity?: WorkActivity;
  readonly sourceState?: string;
  readonly issues?: readonly WorkProjectionIssue[];
}): WorkStatusView {
  return {
    ref: {
      system: input.system,
      namespace: input.namespace ?? "namespace",
      scope: input.scope ?? { kind: "global" },
      localId: input.localId ?? "same:local->id",
    },
    activity: input.activity ?? "available",
    sourceState: input.sourceState ?? "active",
    authorities: [],
    issues: input.issues ?? [],
  };
}

function mockAdapters(
  implementations: Partial<Record<TaskSystemId, AdapterImplementation>> = {},
): Record<TaskSystemId, jest.SpyInstance> {
  return Object.fromEntries(
    (Object.keys(ADAPTERS_BY_SYSTEM) as TaskSystemId[]).map((system) => {
      const implementation = implementations[system] ?? (() => EMPTY_RESULT);
      return [
        system,
        jest.spyOn(ADAPTERS_BY_SYSTEM[system] as any, "snapshot")
          .mockImplementation(implementation),
      ];
    }),
  ) as Record<TaskSystemId, jest.SpyInstance>;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("collectTaskSystemSnapshot", () => {
  test("emits a zero summary for every system and calls each adapter exactly once", () => {
    const spies = mockAdapters();
    const snapshot = collectTaskSystemSnapshot(createContext());
    const orderedSystems = Object.keys(TASK_SYSTEM_CATALOG).sort();

    expect(snapshot.observedAt).toBe(72901508);
    expect(snapshot.shard).toBe("shard:1->snapshot");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.summaries.map((summary) => summary.system)).toEqual(orderedSystems);
    expect(snapshot.summaries).toHaveLength(13);
    for (const summary of snapshot.summaries) {
      expect(summary).toEqual({
        system: summary.system,
        count: 0,
        invalidCount: 0,
        issueCount: 0,
        activityCounts: {
          desired: 0,
          available: 0,
          claimed: 0,
          running: 0,
          blocked: 0,
          terminal: 0,
          unknown: 0,
        },
        sourceStateCounts: {},
      });
      expect(spies[summary.system]).toHaveBeenCalledTimes(1);
    }
  });

  test("sorts structured identities deterministically without merging colliding local IDs", () => {
    let reversed = false;
    const workerEntries = [
      createEntry({
        system: "worker-work",
        namespace: "producer:beta",
        scope: { kind: "room", roomName: "W1N1:source" },
        localId: "same:local->id",
        sourceState: "z-state",
        issues: [{ code: "worker-entry", message: "entry issue" }],
      }),
      createEntry({
        system: "worker-work",
        namespace: "producer->alpha",
        scope: { kind: "room", roomName: "W1N1->target" },
        localId: "same:local->id",
        activity: "claimed",
        sourceState: "active",
      }),
    ];
    const carrierEntries = [
      createEntry({
        system: "carrier-logistics",
        namespace: "producer:two",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "same:local->id",
      }),
      createEntry({
        system: "carrier-logistics",
        namespace: "producer->one",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "same:local->id",
      }),
    ];
    const factoryEntry = createEntry({
      system: "factory-command",
      namespace: "factory:producer->owner",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "same:local->id",
      activity: "running",
      sourceState: "producing",
    });

    mockAdapters({
      "worker-work": () => ({
        entries: reversed ? [...workerEntries].reverse() : workerEntries,
        invalidCount: 2,
        issues: (reversed ? [
          { code: "worker-system-a", message: "first" },
          { code: "worker-system-b", message: "second" },
        ] : [
          { code: "worker-system-b", message: "second" },
          { code: "worker-system-a", message: "first" },
        ]),
      }),
      "carrier-logistics": () => ({
        entries: reversed ? carrierEntries : [...carrierEntries].reverse(),
        invalidCount: 0,
        issues: [],
      }),
      "factory-command": () => ({ entries: [factoryEntry], invalidCount: 0, issues: [] }),
    });

    const first = collectTaskSystemSnapshot(createContext());
    reversed = true;
    const second = collectTaskSystemSnapshot(createContext());

    expect(second.entries).toEqual(first.entries);
    expect(second.summaries).toEqual(first.summaries);
    expect(second.issues).toEqual(first.issues);
    expect(first.entries).toHaveLength(5);
    expect(first.entries.map((entry) => [
      entry.ref.system,
      entry.ref.namespace,
      entry.ref.localId,
    ])).toEqual([
      ["carrier-logistics", "producer->one", "same:local->id"],
      ["carrier-logistics", "producer:two", "same:local->id"],
      ["factory-command", "factory:producer->owner", "same:local->id"],
      ["worker-work", "producer->alpha", "same:local->id"],
      ["worker-work", "producer:beta", "same:local->id"],
    ]);

    const workerSummary = first.summaries.find((summary) => summary.system === "worker-work");
    expect(workerSummary).toMatchObject({
      count: 2,
      invalidCount: 2,
      issueCount: 3,
      activityCounts: { available: 1, claimed: 1 },
      sourceStateCounts: { active: 1, "z-state": 1 },
    });
  });

  test("isolates adapter failures, discards partial entries, and bounds identifiable diagnostics", () => {
    const partial = createEntry({ system: "worker-work", localId: "must-not-leak" });
    const poisoned = {
      ref: {
        system: "worker-work",
        namespace: "poison",
        scope: { kind: "global" },
        localId: "poison",
      },
      sourceState: "active",
      authorities: [],
      issues: [],
    } as unknown as WorkStatusView;
    Object.defineProperty(poisoned, "activity", {
      enumerable: true,
      get() {
        throw new Error("x".repeat(600));
      },
    });

    const spies = mockAdapters({
      "worker-work": () => ({
        entries: [partial, poisoned],
        invalidCount: 7,
        issues: [{ code: "partial", message: "must not leak" }],
      }),
      "carrier-logistics": () => ({
        entries: [createEntry({ system: "carrier-logistics", localId: "survives" })],
        invalidCount: 0,
        issues: [],
      }),
    });

    const snapshot = collectTaskSystemSnapshot(createContext());
    const workerSummary = snapshot.summaries.find((summary) => summary.system === "worker-work");

    expect(snapshot.entries.map((entry) => entry.ref.localId)).toEqual(["survives"]);
    expect(workerSummary).toMatchObject({ count: 0, invalidCount: 0, issueCount: 1 });
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        system: "worker-work",
        code: "task-system-adapter-failure",
        field: "worker-work",
      }),
    ]);
    expect(snapshot.issues[0].message.length).toBeLessThanOrEqual(240);
    for (const system of Object.keys(ADAPTERS_BY_SYSTEM) as TaskSystemId[]) {
      expect(spies[system]).toHaveBeenCalledTimes(1);
    }
  });

  test("rejects a cross-system ref without contaminating the target system", () => {
    mockAdapters({
      "worker-work": () => ({
        entries: [createEntry({
          system: "carrier-logistics",
          namespace: "forged-worker-source",
          localId: "must-not-cross",
        })],
        invalidCount: 0,
        issues: [],
      }),
      "carrier-logistics": () => ({
        entries: [createEntry({
          system: "carrier-logistics",
          namespace: "real-carrier-source",
          localId: "real-carrier-entry",
        })],
        invalidCount: 0,
        issues: [],
      }),
    });

    const snapshot = collectTaskSystemSnapshot(createContext());
    const workerSummary = snapshot.summaries.find((summary) => summary.system === "worker-work");
    const carrierSummary = snapshot.summaries.find(
      (summary) => summary.system === "carrier-logistics",
    );

    expect(snapshot.entries.map((entry) => entry.ref.localId)).toEqual(["real-carrier-entry"]);
    expect(workerSummary).toMatchObject({ count: 0, issueCount: 1 });
    expect(carrierSummary).toMatchObject({ count: 1, issueCount: 0 });
    expect(snapshot.issues).toContainEqual(expect.objectContaining({
      system: "worker-work",
      code: "task-system-adapter-failure",
    }));
  });

  test("rejects invalid activity and malformed adapter result shapes per system", () => {
    const invalidActivityEntry = {
      ...createEntry({ system: "worker-work", localId: "invalid-activity" }),
      activity: "pending",
    } as unknown as WorkStatusView;
    mockAdapters({
      "worker-work": () => ({
        entries: [invalidActivityEntry],
        invalidCount: 0,
        issues: [],
      }),
      "factory-command": () => ({
        entries: [],
        invalidCount: Number.NaN,
        issues: [],
      }),
      "carrier-logistics": () => ({
        entries: [createEntry({ system: "carrier-logistics", localId: "still-valid" })],
        invalidCount: 0,
        issues: [],
      }),
    });

    const snapshot = collectTaskSystemSnapshot(createContext());

    expect(snapshot.entries.map((entry) => entry.ref.localId)).toEqual(["still-valid"]);
    expect(snapshot.issues.map((issue) => issue.system)).toEqual([
      "factory-command",
      "worker-work",
    ]);
    expect(snapshot.summaries.find((summary) => summary.system === "worker-work"))
      .toMatchObject({ count: 0, invalidCount: 0, issueCount: 1 });
    expect(snapshot.summaries.find((summary) => summary.system === "factory-command"))
      .toMatchObject({ count: 0, invalidCount: 0, issueCount: 1 });
  });

  test("rejects duplicate WorkRefs identically for [A, B] and [B, A]", () => {
    let reversed = false;
    const available = createEntry({
      system: "worker-work",
      namespace: "duplicate:namespace->owner",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "duplicate:local->id",
      activity: "available",
      sourceState: "active",
    });
    const running = createEntry({
      system: "worker-work",
      namespace: "duplicate:namespace->owner",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "duplicate:local->id",
      activity: "running",
      sourceState: "running",
    });
    mockAdapters({
      "worker-work": () => ({
        entries: reversed ? [running, available] : [available, running],
        invalidCount: 0,
        issues: [],
      }),
    });

    const first = collectTaskSystemSnapshot(createContext());
    reversed = true;
    const second = collectTaskSystemSnapshot(createContext());

    expect(second).toEqual(first);
    expect(first.entries).toEqual([]);
    expect(first.summaries.find((summary) => summary.system === "worker-work"))
      .toMatchObject({ count: 0, invalidCount: 0, issueCount: 1 });
    expect(first.issues).toContainEqual(expect.objectContaining({
      system: "worker-work",
      code: "task-system-adapter-failure",
      message: expect.stringContaining("duplicate WorkRef identities"),
    }));
  });

  test("rejects duplicate explicit Carrier refs from either owner-aware DTO order", () => {
    const originalCarrierSnapshot = carrierLogisticsAdapter.snapshot.bind(
      carrierLogisticsAdapter,
    );
    const task = (priority: number) => ({
      id: "duplicate:local->id",
      producer: "producer:duplicate->owner",
      roomName: "W1N1",
      type: "terminal_feed",
      priority,
      steps: [{
        id: "step",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "terminal",
        fromId: "storage-id",
        toId: "terminal-id",
        amount: 100,
      }],
      createdAt: 10,
      updatedAt: 20,
    });
    const ref = {
      system: "carrier-logistics",
      namespace: "producer:duplicate->owner",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "duplicate:local->id",
    };
    const firstEntry = { ref, task: task(100) };
    const secondEntry = {
      ref: { ...ref, scope: { ...ref.scope } },
      task: task(200),
    };
    const board = (entries: readonly unknown[]) => ({
      W1N1: entries,
    }) as unknown as CarrierTaskBoardSnapshot;

    mockAdapters({
      "carrier-logistics": (source) => originalCarrierSnapshot(source),
    });

    const first = collectTaskSystemSnapshot(createContext(board([
      firstEntry,
      secondEntry,
    ])));
    const second = collectTaskSystemSnapshot(createContext(board([
      secondEntry,
      firstEntry,
    ])));

    expect(second).toEqual(first);
    expect(first.entries).toEqual([]);
    expect(first.summaries.find((summary) => summary.system === "carrier-logistics"))
      .toMatchObject({ count: 0, invalidCount: 0, issueCount: 1 });
    expect(first.issues).toContainEqual(expect.objectContaining({
      system: "carrier-logistics",
      code: "task-system-adapter-failure",
      message: expect.stringContaining("duplicate WorkRef identities"),
    }));
  });

  test("rejects malformed optional fields, authority metadata, and issue text", () => {
    const invalidEntry = (
      system: TaskSystemId,
      overrides: Record<string, unknown>,
    ): WorkStatusView => ({
      ...createEntry({ system, localId: `invalid-${system}` }),
      ...overrides,
    } as unknown as WorkStatusView);

    mockAdapters({
      "worker-work": () => ({
        entries: [invalidEntry("worker-work", { createdAt: Number.NaN })],
        invalidCount: 0,
        issues: [],
      }),
      "carrier-logistics": () => ({
        entries: [invalidEntry("carrier-logistics", { updatedAt: Number.POSITIVE_INFINITY })],
        invalidCount: 0,
        issues: [],
      }),
      "power-creep-action": () => ({
        entries: [invalidEntry("power-creep-action", { lastProgressAt: -1 })],
        invalidCount: 0,
        issues: [],
      }),
      "resource-transfer": () => ({
        entries: [invalidEntry("resource-transfer", { retryAt: Number.NaN })],
        invalidCount: 0,
        issues: [],
      }),
      "factory-command": () => ({
        entries: [invalidEntry("factory-command", { deadlineAt: Number.NEGATIVE_INFINITY })],
        invalidCount: 0,
        issues: [],
      }),
      "remote-mining-workflow": () => ({
        entries: [invalidEntry("remote-mining-workflow", { blocker: { reason: "object" } })],
        invalidCount: 0,
        issues: [],
      }),
      "colonization-workflow": () => ({
        entries: [invalidEntry("colonization-workflow", {
          authorities: [{ role: "workflow_owner", id: "owner", generation: -1 }],
        })],
        invalidCount: 0,
        issues: [],
      }),
      "rescue-workflow": () => ({
        entries: [invalidEntry("rescue-workflow", {
          authorities: [{ role: "workflow_owner", id: "owner", component: "" }],
        })],
        invalidCount: 0,
        issues: [],
      }),
      "flag-hauling-workflow": () => ({
        entries: [invalidEntry("flag-hauling-workflow", {
          issues: [{ code: "", message: "message" }],
        })],
        invalidCount: 0,
        issues: [],
      }),
      "cross-shard-colonization-workflow": () => ({
        entries: [],
        invalidCount: 0,
        issues: [{ code: "issue", message: "" }],
      }),
      "power-bank-workflow": () => ({
        entries: [invalidEntry("power-bank-workflow", {
          issues: [{ code: "issue", message: "message", field: "" }],
        })],
        invalidCount: 0,
        issues: [],
      }),
      "war-workflow": () => ({
        entries: [invalidEntry("war-workflow", {
          authorities: [{
            role: "workflow_owner",
            id: "owner",
            generation: Number.MAX_SAFE_INTEGER + 1,
          }],
        })],
        invalidCount: 0,
        issues: [],
      }),
    });

    const snapshot = collectTaskSystemSnapshot(createContext());
    const expectedFailures = Object.keys(TASK_SYSTEM_CATALOG)
      .filter((system) => system !== "spawn-production")
      .sort();

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.issues.map((issue) => issue.system)).toEqual(expectedFailures);
    for (const system of expectedFailures as TaskSystemId[]) {
      expect(snapshot.summaries.find((summary) => summary.system === system))
        .toMatchObject({ count: 0, invalidCount: 0, issueCount: 1 });
    }
  });

  test("counts all issues while bounding system diagnostics per adapter", () => {
    const issues = Array.from({ length: 50 }, (_, index) => ({
      code: `issue-${index}`,
      message: `diagnostic ${index}`,
    }));
    mockAdapters({
      "worker-work": () => ({ entries: [], invalidCount: 3, issues }),
    });

    const snapshot = collectTaskSystemSnapshot(createContext());
    const summary = snapshot.summaries.find((item) => item.system === "worker-work");

    expect(summary).toMatchObject({ count: 0, invalidCount: 3, issueCount: 50 });
    expect(snapshot.issues.filter((item) => item.system === "worker-work")).toHaveLength(20);
  });

  test("deeply detaches entries, authorities, issues, extension facts, and summaries", () => {
    const sourceEntry = {
      ...createEntry({
        system: "worker-work",
        namespace: "source-namespace",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "source-id",
        activity: "claimed",
        issues: [{ code: "entry-source", message: "entry source issue" }],
      }),
      authorities: [{ role: "assignee" as const, id: "worker-1" }],
      facts: [{ kind: "extension", nested: { value: "source" } }],
    };
    const sourceResult = {
      entries: [sourceEntry],
      invalidCount: 1,
      issues: [{ code: "system-source", message: "system source issue" }],
    } satisfies TaskSystemAdapterResult;
    mockAdapters({
      "worker-work": () => sourceResult,
    });

    const first = collectTaskSystemSnapshot(createContext());
    const firstEntry = first.entries[0] as any;
    const firstSummary = first.summaries.find((summary) => summary.system === "worker-work") as any;
    const firstDiagnostic = first.issues[0] as any;

    firstEntry.ref.namespace = "caller-mutated";
    firstEntry.ref.scope.roomName = "W9N9";
    firstEntry.authorities[0].id = "caller-mutated";
    firstEntry.issues[0].message = "caller-mutated";
    firstEntry.facts[0].nested.value = "caller-mutated";
    firstSummary.count = 999;
    firstSummary.activityCounts.claimed = 999;
    firstDiagnostic.message = "caller-mutated";

    expect(sourceEntry.ref.namespace).toBe("source-namespace");
    expect((sourceEntry.ref.scope as { roomName: string }).roomName).toBe("W1N1");
    expect(sourceEntry.authorities[0].id).toBe("worker-1");
    expect(sourceEntry.issues[0].message).toBe("entry source issue");
    expect(sourceEntry.facts[0].nested.value).toBe("source");
    expect(sourceResult.issues[0].message).toBe("system source issue");

    const second = collectTaskSystemSnapshot(createContext());
    const secondEntry = second.entries[0] as any;
    const secondSummary = second.summaries.find((summary) => summary.system === "worker-work");

    expect(secondEntry.ref.namespace).toBe("source-namespace");
    expect(secondEntry.ref.scope.roomName).toBe("W1N1");
    expect(secondEntry.authorities[0].id).toBe("worker-1");
    expect(secondEntry.issues[0].message).toBe("entry source issue");
    expect(secondEntry.facts[0].nested.value).toBe("source");
    expect(secondSummary).toMatchObject({
      count: 1,
      invalidCount: 1,
      issueCount: 2,
      activityCounts: { claimed: 1 },
    });
    expect(second.issues[0]).toMatchObject({
      system: "worker-work",
      code: "system-source",
      message: "system source issue",
    });
  });
});
