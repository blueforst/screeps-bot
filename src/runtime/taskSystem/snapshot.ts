import type { TaskSystemId } from "@/runtime/taskSystem/catalog";
import {
  compareWorkRefs,
  sortWorkStatusViews,
  type TaskSystemAdapterResult,
  type TaskSystemSnapshot,
  type TaskSystemSummary,
  type WorkActivity,
  type WorkActivityCounts,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";
import {
  TASK_SYSTEM_ADAPTER_REGISTRY,
  type TaskSystemCollectionContext,
} from "@/runtime/taskSystem/registry";

const WORK_ACTIVITIES = [
  "desired",
  "available",
  "claimed",
  "running",
  "blocked",
  "terminal",
  "unknown",
] as const satisfies readonly WorkActivity[];

const WORK_ACTIVITY_SET: ReadonlySet<unknown> = new Set(WORK_ACTIVITIES);
const WORK_AUTHORITY_ROLES: ReadonlySet<unknown> = new Set([
  "producer",
  "workflow_owner",
  "executor",
  "assignee",
  "lease_owner",
  "queue_owner",
]);

const MAX_SYSTEM_DIAGNOSTICS = 20;
const MAX_FAILURE_MESSAGE_LENGTH = 240;

export interface TaskSystemDiagnostic extends WorkProjectionIssue {
  readonly system: TaskSystemId;
}

export interface CollectedTaskSystemSnapshot extends Omit<TaskSystemSnapshot, "issues"> {
  readonly issues: readonly TaskSystemDiagnostic[];
}

interface CollectedSystemResult {
  readonly entries: readonly WorkStatusView[];
  readonly summary: TaskSystemSummary;
  readonly diagnostics: readonly TaskSystemDiagnostic[];
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProjectionIssue(value: unknown): value is WorkProjectionIssue {
  return isRecord(value)
    && isNonEmptyString(value.code)
    && isNonEmptyString(value.message)
    && (value.field === undefined || isNonEmptyString(value.field));
}

function isOptionalFiniteNonNegative(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isWorkScope(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "room":
      return isNonEmptyString(value.roomName);
    case "actor":
      return isNonEmptyString(value.actorId);
    case "cross_room":
      return isNonEmptyString(value.fromRoomName) && isNonEmptyString(value.toRoomName);
    case "shard_room":
      return isNonEmptyString(value.shardName) && isNonEmptyString(value.roomName);
    case "object":
      return isNonEmptyString(value.objectId);
    case "global":
      return true;
    default:
      return false;
  }
}

function isWorkAuthority(value: unknown): boolean {
  return isRecord(value)
    && WORK_AUTHORITY_ROLES.has(value.role)
    && isNonEmptyString(value.id)
    && (value.generation === undefined
      || (Number.isSafeInteger(value.generation) && (value.generation as number) >= 0))
    && (value.component === undefined || isNonEmptyString(value.component));
}

function isCountableEntry(system: TaskSystemId, value: unknown): value is WorkStatusView {
  if (!isRecord(value) || !isRecord(value.ref)) return false;
  return value.ref.system === system
    && isNonEmptyString(value.ref.namespace)
    && isWorkScope(value.ref.scope)
    && isNonEmptyString(value.ref.localId)
    && WORK_ACTIVITY_SET.has(value.activity)
    && isNonEmptyString(value.sourceState)
    && Array.isArray(value.authorities)
    && value.authorities.every(isWorkAuthority)
    && Array.isArray(value.issues)
    && value.issues.every(isProjectionIssue)
    && isOptionalFiniteNonNegative(value.createdAt)
    && isOptionalFiniteNonNegative(value.updatedAt)
    && isOptionalFiniteNonNegative(value.lastProgressAt)
    && isOptionalFiniteNonNegative(value.retryAt)
    && isOptionalFiniteNonNegative(value.deadlineAt)
    && (value.blocker === undefined || isNonEmptyString(value.blocker));
}

function validateAdapterResult(
  system: TaskSystemId,
  value: unknown,
): TaskSystemAdapterResult {
  if (!isRecord(value)) {
    throw new Error(`Adapter ${system} returned a non-object result`);
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.issues)) {
    throw new Error(`Adapter ${system} returned invalid entries or issues`);
  }
  if (
    typeof value.invalidCount !== "number"
    || !Number.isFinite(value.invalidCount)
    || !Number.isInteger(value.invalidCount)
    || value.invalidCount < 0
  ) {
    throw new Error(`Adapter ${system} returned an invalid invalidCount`);
  }
  if (!value.issues.every(isProjectionIssue)) {
    throw new Error(`Adapter ${system} returned a malformed system issue`);
  }
  if (!value.entries.every((entry) => isCountableEntry(system, entry))) {
    throw new Error(`Adapter ${system} returned an invalid or cross-system entry`);
  }
  return value as unknown as TaskSystemAdapterResult;
}

function assertNoDuplicateWorkRefs(
  system: TaskSystemId,
  entries: readonly WorkStatusView[],
): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (compareWorkRefs(entries[index - 1].ref, entries[index].ref) === 0) {
      throw new Error(`Adapter ${system} returned duplicate WorkRef identities`);
    }
  }
}

const ORDERED_SYSTEMS = Object.freeze(
  (Object.keys(TASK_SYSTEM_ADAPTER_REGISTRY) as TaskSystemId[])
    .sort(compareCanonicalText),
);

function cloneDetached<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(source, result);
    for (const item of value) result.push(cloneDetached(item, seen));
    return result as T;
  }

  const result: Record<string, unknown> = {};
  seen.set(source, result);
  for (const key of Object.keys(source)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneDetached((source as Record<string, unknown>)[key], seen),
    });
  }
  return result as T;
}

function emptyActivityCounts(): Record<WorkActivity, number> {
  const result = {} as Record<WorkActivity, number>;
  for (const activity of WORK_ACTIVITIES) result[activity] = 0;
  return result;
}

function sourceStateCounts(entries: readonly WorkStatusView[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.sourceState, (counts.get(entry.sourceState) || 0) + 1);
  }

  const result: Record<string, number> = {};
  for (const sourceState of Array.from(counts.keys()).sort(compareCanonicalText)) {
    Object.defineProperty(result, sourceState, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: counts.get(sourceState),
    });
  }
  return result;
}

function buildSummary(
  system: TaskSystemId,
  result: TaskSystemAdapterResult,
  entries: readonly WorkStatusView[],
): TaskSystemSummary {
  const activityCounts = emptyActivityCounts();
  let entryIssueCount = 0;
  for (const entry of entries) {
    activityCounts[entry.activity] += 1;
    entryIssueCount += entry.issues.length;
  }

  return {
    system,
    count: entries.length,
    invalidCount: result.invalidCount,
    issueCount: entryIssueCount + result.issues.length,
    activityCounts: activityCounts as WorkActivityCounts,
    sourceStateCounts: sourceStateCounts(entries),
  };
}

function adapterDiagnostics(
  system: TaskSystemId,
  issues: readonly WorkProjectionIssue[],
): TaskSystemDiagnostic[] {
  return issues
    .map((issue) => ({ ...cloneDetached(issue), system }))
    .sort((left, right) => compareCanonicalText(left.code, right.code)
      || compareCanonicalText(left.field ?? "", right.field ?? "")
      || compareCanonicalText(left.message, right.message))
    .slice(0, MAX_SYSTEM_DIAGNOSTICS);
}

function failureMessage(error: unknown): string {
  let message = "unknown adapter failure";
  try {
    if (typeof error === "string") {
      message = error;
    } else if (
      typeof error === "object"
      && error !== null
      && typeof (error as { readonly message?: unknown }).message === "string"
    ) {
      message = (error as { readonly message: string }).message;
    }
  } catch {
    message = "unreadable adapter failure";
  }
  return message.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function failureResult(system: TaskSystemId, error: unknown): CollectedSystemResult {
  const diagnostic: TaskSystemDiagnostic = {
    system,
    code: "task-system-adapter-failure",
    message: `Adapter ${system} failed: ${failureMessage(error)}`
      .slice(0, MAX_FAILURE_MESSAGE_LENGTH),
    field: system,
  };
  const result: TaskSystemAdapterResult = {
    entries: [],
    invalidCount: 0,
    issues: [diagnostic],
  };
  return {
    entries: [],
    summary: buildSummary(system, result, []),
    diagnostics: [diagnostic],
  };
}

function collectSystem(
  system: TaskSystemId,
  context: TaskSystemCollectionContext,
): CollectedSystemResult {
  try {
    const sourceResult = TASK_SYSTEM_ADAPTER_REGISTRY[system].snapshot(context);
    const result = validateAdapterResult(system, cloneDetached(sourceResult));
    const entries = sortWorkStatusViews(result.entries);
    assertNoDuplicateWorkRefs(system, entries);
    return {
      entries,
      summary: buildSummary(system, result, entries),
      diagnostics: adapterDiagnostics(system, result.issues),
    };
  } catch (error) {
    return failureResult(system, error);
  }
}

export function collectTaskSystemSnapshot(
  context: TaskSystemCollectionContext,
): CollectedTaskSystemSnapshot {
  const entries: WorkStatusView[] = [];
  const summaries: TaskSystemSummary[] = [];
  const diagnostics: TaskSystemDiagnostic[] = [];

  for (const system of ORDERED_SYSTEMS) {
    const collected = collectSystem(system, context);
    entries.push(...collected.entries);
    summaries.push(collected.summary);
    diagnostics.push(...collected.diagnostics);
  }

  return {
    observedAt: context.observedAt,
    shard: context.shard,
    entries: sortWorkStatusViews(entries),
    summaries,
    issues: diagnostics,
  };
}
