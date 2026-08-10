import {
  compareWorkNamespaces,
  compareWorkRefs,
  compareWorkScopes,
  sortWorkRefs,
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type TaskSystemSnapshot,
  type TaskSystemSummary,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkRef,
  type WorkScope,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type ExpectedScopeKind = "room" | "actor" | "cross_room" | "shard_room" | "object" | "global";
type ExpectedActivity = "desired" | "available" | "claimed" | "running" | "blocked" | "terminal" | "unknown";
type ExpectedAuthorityRole =
  | "producer"
  | "workflow_owner"
  | "executor"
  | "assignee"
  | "lease_owner"
  | "queue_owner";
type MutationMethod =
  | "execute"
  | "assign"
  | "claim"
  | "cancel"
  | "complete"
  | "delete"
  | "transition"
  | "upsert";

const scopeKindsMatch: IsExactly<WorkScope["kind"], ExpectedScopeKind> = true;
const activitiesMatch: IsExactly<WorkActivity, ExpectedActivity> = true;
const authorityRolesMatch: IsExactly<WorkAuthorityRef["role"], ExpectedAuthorityRole> = true;
const workRefKeysMatch: IsExactly<keyof WorkRef, "system" | "namespace" | "scope" | "localId"> = true;
const adapterKeysMatch: IsExactly<keyof TaskSystemAdapter, "system" | "snapshot"> = true;
const adapterResultKeysMatch: IsExactly<
  keyof TaskSystemAdapterResult,
  "entries" | "invalidCount" | "issues"
> = true;
const adapterHasNoMutationMethod: IsExactly<Extract<keyof TaskSystemAdapter, MutationMethod>, never> = true;

void scopeKindsMatch;
void activitiesMatch;
void authorityRolesMatch;
void workRefKeysMatch;
void adapterKeysMatch;
void adapterResultKeysMatch;
void adapterHasNoMutationMethod;

const SCOPES: readonly WorkScope[] = [
  { kind: "room", roomName: "W1N1" },
  { kind: "actor", actorId: "Operator-1" },
  { kind: "cross_room", fromRoomName: "W1N1", toRoomName: "W2N2" },
  { kind: "shard_room", shardName: "shard3", roomName: "W3N3" },
  { kind: "object", objectId: "5bbcac149099fc012e632db0" },
  { kind: "global" },
];

function createRef(overrides: Partial<WorkRef> = {}): WorkRef {
  return {
    system: "worker-work",
    namespace: "workerTaskPool",
    scope: { kind: "room", roomName: "W1N1" },
    localId: "task:alpha->beta",
    ...overrides,
  };
}

function createView(ref: WorkRef, sourceState: string): WorkStatusView {
  return {
    ref,
    activity: "available",
    sourceState,
    authorities: [],
    issues: [],
  };
}

describe("task system core model", () => {
  test("represents every scope as a structured discriminated value", () => {
    expect(SCOPES.map((scope) => scope.kind)).toEqual([
      "room",
      "actor",
      "cross_room",
      "shard_room",
      "object",
      "global",
    ]);
    expect(createRef().namespace).toBe("workerTaskPool");
  });

  test("supports multiple structured authorities and projection issues", () => {
    const authorities: readonly WorkAuthorityRef[] = [
      { role: "producer", id: "resourceControl" },
      { role: "lease_owner", id: "W2N2", generation: 4, component: "terminal" },
    ];
    const issues: readonly WorkProjectionIssue[] = [
      { code: "assignment-drift", message: "assignment evidence is incomplete", field: "assignees" },
    ];
    const view: WorkStatusView = {
      ref: createRef(),
      activity: "unknown",
      sourceState: "active",
      authorities,
      issues,
    };

    expect(view.authorities).toEqual(authorities);
    expect(view.issues).toEqual(issues);
  });

  test("defines explicit adapter, summary, and snapshot result contracts", () => {
    const result: TaskSystemAdapterResult = {
      entries: [],
      invalidCount: 0,
      issues: [],
    };
    const adapter: TaskSystemAdapter<{ readonly tick: number }> = {
      system: "worker-work",
      snapshot: () => result,
    };
    const summary: TaskSystemSummary = {
      system: "worker-work",
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
    };
    const snapshot: TaskSystemSnapshot = {
      observedAt: 123,
      shard: "shard3",
      entries: [],
      summaries: [summary],
      issues: [],
    };

    expect(adapter.snapshot({ tick: 123 })).toBe(result);
    expect(snapshot.summaries).toEqual([summary]);
  });

  test("compares namespace and structured scope without parsing identity strings", () => {
    expect(compareWorkNamespaces("producer->alpha", "producer:beta")).toBeLessThan(0);
    expect(compareWorkScopes(
      { kind: "cross_room", fromRoomName: "W1N1:source", toRoomName: "W2N2->target" },
      { kind: "cross_room", fromRoomName: "W1N1:source", toRoomName: "W3N3->target" },
    )).toBeLessThan(0);
    expect(compareWorkScopes(
      { kind: "global" },
      { kind: "global" },
    )).toBe(0);
  });

  test("orders refs by system, namespace, canonical scope, and localId", () => {
    const refs = [
      createRef({ localId: "z" }),
      createRef({ namespace: "z-producer", localId: "a" }),
      createRef({ system: "carrier-logistics", namespace: "a-producer", localId: "a" }),
      createRef({ scope: { kind: "room", roomName: "W0N0" }, localId: "z" }),
      createRef({ localId: "a:part->tail" }),
    ];

    expect(sortWorkRefs(refs)).toEqual([
      refs[2],
      refs[3],
      refs[4],
      refs[0],
      refs[1],
    ]);
    expect(refs[0].localId).toBe("z");
    expect(compareWorkRefs(refs[4], refs[0])).toBeLessThan(0);
  });

  test("sorts status views stably without mutating the caller array", () => {
    const sameRef = createRef({ localId: "same" });
    const first = createView(sameRef, "first");
    const second = createView({ ...sameRef }, "second");
    const earlier = createView(createRef({ localId: "earlier" }), "earlier");
    const input = [first, second, earlier];
    const sorted = sortWorkStatusViews(input);

    expect(sorted).toEqual([earlier, first, second]);
    expect(sorted).not.toBe(input);
    expect(input).toEqual([first, second, earlier]);
  });
});
