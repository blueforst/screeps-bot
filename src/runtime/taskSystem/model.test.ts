import {
  compareWorkNamespaces,
  compareWorkScopes,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type TaskSystemSnapshot,
  type TaskSystemSummary,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkRef,
  type WorkScope,
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




describe("task system core model", () => {

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
});
