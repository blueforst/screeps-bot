import type { TaskSystemId } from "@/runtime/taskSystem/catalog";

export type WorkScope =
  | { readonly kind: "room"; readonly roomName: string }
  | { readonly kind: "actor"; readonly actorId: string }
  | {
      readonly kind: "cross_room";
      readonly fromRoomName: string;
      readonly toRoomName: string;
    }
  | {
      readonly kind: "shard_room";
      readonly shardName: string;
      readonly roomName: string;
    }
  | { readonly kind: "object"; readonly objectId: string }
  | { readonly kind: "global" };

export interface WorkRef {
  readonly system: TaskSystemId;
  readonly namespace: string;
  readonly scope: WorkScope;
  readonly localId: string;
}

export type WorkAuthorityRole =
  | "producer"
  | "workflow_owner"
  | "executor"
  | "assignee"
  | "lease_owner"
  | "queue_owner";

export interface WorkAuthorityRef {
  readonly role: WorkAuthorityRole;
  readonly id: string;
  readonly generation?: number;
  readonly component?: string;
}

export type WorkActivity =
  | "desired"
  | "available"
  | "claimed"
  | "running"
  | "blocked"
  | "terminal"
  | "unknown";

export interface WorkProjectionIssue {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

export interface WorkStatusView {
  readonly ref: WorkRef;
  readonly activity: WorkActivity;
  readonly sourceState: string;
  readonly authorities: readonly WorkAuthorityRef[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly lastProgressAt?: number;
  readonly blocker?: string;
  readonly retryAt?: number;
  readonly deadlineAt?: number;
  readonly issues: readonly WorkProjectionIssue[];
}

export interface TaskSystemAdapterResult {
  readonly entries: readonly WorkStatusView[];
  readonly invalidCount: number;
  readonly issues: readonly WorkProjectionIssue[];
}

export interface TaskSystemAdapter<TContext = unknown> {
  readonly system: TaskSystemId;
  snapshot(context: TContext): TaskSystemAdapterResult;
}

export type WorkActivityCounts = Readonly<Record<WorkActivity, number>>;

export interface TaskSystemSummary {
  readonly system: TaskSystemId;
  readonly count: number;
  readonly invalidCount: number;
  readonly issueCount: number;
  readonly activityCounts: WorkActivityCounts;
  readonly sourceStateCounts: Readonly<Record<string, number>>;
}

export interface TaskSystemSnapshot {
  readonly observedAt: number;
  readonly shard: string;
  readonly entries: readonly WorkStatusView[];
  readonly summaries: readonly TaskSystemSummary[];
  readonly issues: readonly WorkProjectionIssue[];
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareWorkNamespaces(left: string, right: string): number {
  return compareCanonicalText(left, right);
}

const WORK_SCOPE_KIND_ORDER: Readonly<Record<WorkScope["kind"], number>> = {
  room: 0,
  actor: 1,
  cross_room: 2,
  shard_room: 3,
  object: 4,
  global: 5,
};

function scopeIdentityParts(scope: WorkScope): readonly string[] {
  switch (scope.kind) {
    case "room":
      return [scope.roomName];
    case "actor":
      return [scope.actorId];
    case "cross_room":
      return [scope.fromRoomName, scope.toRoomName];
    case "shard_room":
      return [scope.shardName, scope.roomName];
    case "object":
      return [scope.objectId];
    case "global":
      return [];
  }
}

function compareCanonicalParts(
  left: readonly string[],
  right: readonly string[],
): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compareCanonicalText(left[index], right[index]);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function compareWorkScopes(left: WorkScope, right: WorkScope): number {
  const kindDifference = WORK_SCOPE_KIND_ORDER[left.kind] - WORK_SCOPE_KIND_ORDER[right.kind];
  if (kindDifference !== 0) return kindDifference;
  return compareCanonicalParts(scopeIdentityParts(left), scopeIdentityParts(right));
}

export function compareWorkRefs(left: WorkRef, right: WorkRef): number {
  return compareCanonicalText(left.system, right.system)
    || compareWorkNamespaces(left.namespace, right.namespace)
    || compareWorkScopes(left.scope, right.scope)
    || compareCanonicalText(left.localId, right.localId);
}

function stableSort<T>(
  values: readonly T[],
  comparator: (left: T, right: T) => number,
): T[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => comparator(left.value, right.value) || left.index - right.index)
    .map(({ value }) => value);
}

export function sortWorkRefs(refs: readonly WorkRef[]): WorkRef[] {
  return stableSort(refs, compareWorkRefs);
}

export function sortWorkStatusViews(views: readonly WorkStatusView[]): WorkStatusView[] {
  return stableSort(views, (left, right) => compareWorkRefs(left.ref, right.ref));
}
