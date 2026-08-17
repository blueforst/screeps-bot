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
import { type TaskSystemId } from "@/runtime/taskSystem/catalog";
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
