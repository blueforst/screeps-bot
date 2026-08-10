import { TASK_SYSTEM_CATALOG } from "@/runtime/taskSystem/catalog";
import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

export interface PowerCreepActionAdapterContext {
  /** Direct readonly view of Memory.powerCreeps, never Game.powerCreeps. */
  readonly powerCreepMemory?: unknown;
  /**
   * Snapshot of own keys from Game.powerCreeps. The caller supplies actor
   * identity separately so stale/renamed Memory records cannot regain
   * executor authority merely by remaining persisted.
   */
  readonly actorNames: readonly string[];
}

const NAMESPACE = TASK_SYSTEM_CATALOG["power-creep-action"].domainOwner;
const MAX_SYSTEM_ISSUES = 20;
const POWER_CREEP_TASK_TYPES: ReadonlySet<string> = new Set([
  "enable_room",
  "renew",
  "deposit_ops",
  "operate_storage",
  "regen_source",
  "operate_extension",
  "generate_ops",
]);
const POWER_CREEP_TARGET_REQUIRED_TYPES: ReadonlySet<string> = new Set([
  "enable_room",
  "renew",
  "deposit_ops",
  "operate_storage",
  "regen_source",
  "operate_extension",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, field)
    ? record[field]
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function appendSystemIssue(
  issues: WorkProjectionIssue[],
  issue: WorkProjectionIssue,
): void {
  if (issues.length < MAX_SYSTEM_ISSUES) {
    issues.push({ ...issue });
  }
}

function malformedSourceResult(issue: WorkProjectionIssue): TaskSystemAdapterResult {
  return {
    entries: [],
    invalidCount: 1,
    issues: [{ ...issue }],
  };
}

function validateActorNames(value: unknown):
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly result: TaskSystemAdapterResult } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      result: malformedSourceResult({
        code: "power-creep-actor-names-malformed",
        message: "Power Creep actor names must be an array of unique non-empty strings.",
        field: "actorNames",
      }),
    };
  }

  const names = new Set<string>();
  const issues: WorkProjectionIssue[] = [];
  let invalidCount = 0;

  for (const valueEntry of value) {
    if (!isNonEmptyString(valueEntry)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "power-creep-actor-name-invalid",
        message: "Power Creep actor names contain a value that is not a non-empty string.",
        field: "actorNames",
      });
      continue;
    }
    if (names.has(valueEntry)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "power-creep-actor-name-duplicate",
        message: `Power Creep actor names repeat actor ${valueEntry}.`,
        field: "actorNames",
      });
      continue;
    }
    names.add(valueEntry);
  }

  if (invalidCount > 0) {
    return {
      ok: false,
      result: {
        entries: [],
        invalidCount,
        issues: sortIssues(issues),
      },
    };
  }

  return {
    ok: true,
    names: [...names].sort(compareText),
  };
}

function compareText(leftText: string, rightText: string): number {
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function compareIssues(left: WorkProjectionIssue, right: WorkProjectionIssue): number {
  return compareText(left.code, right.code)
    || compareText(left.field || "", right.field || "")
    || compareText(left.message, right.message);
}

function canonicalIssues(
  values: readonly WorkProjectionIssue[],
): WorkProjectionIssue[] {
  const unique: WorkProjectionIssue[] = [];
  for (const value of values) {
    if (unique.some((candidate) =>
      candidate.code === value.code
      && candidate.field === value.field
      && candidate.message === value.message)) {
      continue;
    }
    unique.push({ ...value });
  }
  return [...unique].sort(compareIssues);
}

function sortIssues(values: readonly WorkProjectionIssue[]): WorkProjectionIssue[] {
  return values.map((value) => ({ ...value })).sort(compareIssues);
}

function mergeDuplicateTaskViews(
  existing: WorkStatusView,
  duplicate: WorkStatusView,
): WorkStatusView {
  const duplicateIssue: WorkProjectionIssue = {
    code: "power-creep-task-id-duplicate",
    message: "Power Creep actor queue contains duplicate task ids.",
    field: "id",
  };

  return {
    ref: {
      ...existing.ref,
      scope: { ...existing.ref.scope },
    },
    activity: "unknown",
    sourceState: existing.sourceState === "stale_actor"
      || duplicate.sourceState === "stale_actor"
      ? "stale_actor"
      : "duplicate",
    authorities: existing.authorities.map((authority) => ({ ...authority })),
    // A duplicate queue id makes both order and timestamps ambiguous. Do not
    // choose either record as canonical progress based on insertion order.
    issues: canonicalIssues([
      ...existing.issues,
      ...duplicate.issues,
      duplicateIssue,
    ]),
  };
}

function staleActorIssue(actorId: string): WorkProjectionIssue {
  return {
    code: "power-creep-memory-actor-stale",
    message: `Power Creep memory for actor ${actorId} has no current Game.powerCreeps actor.`,
    field: actorId,
  };
}

function projectStaleActorEntry(
  actorId: string,
  entry: WorkStatusView,
): WorkStatusView {
  return {
    ...entry,
    ref: {
      ...entry.ref,
      scope: { ...entry.ref.scope },
    },
    activity: "unknown",
    sourceState: "stale_actor",
    // A persisted Memory record cannot prove that the removed/renamed actor
    // still owns or can execute its queue. Keep the WorkRef for diagnostics,
    // but publish no runtime authority for it.
    authorities: [],
    issues: canonicalIssues([
      ...entry.issues,
      staleActorIssue(actorId),
    ]),
  };
}

function projectTask(
  actorId: string,
  rawTask: Record<string, unknown>,
): WorkStatusView | null {
  const id = ownValue(rawTask, "id");
  if (!isNonEmptyString(id)) {
    return null;
  }

  const issues: WorkProjectionIssue[] = [];
  const type = ownValue(rawTask, "type");
  const knownType = isNonEmptyString(type) && POWER_CREEP_TASK_TYPES.has(type);
  if (!knownType) {
    issues.push({
      code: "power-creep-task-type-invalid",
      message: "Power Creep queue task has an unknown or missing type.",
      field: "type",
    });
  } else if (id !== type) {
    issues.push({
      code: "power-creep-task-id-type-mismatch",
      message: "Power Creep queue task id does not match its domain task type.",
      field: "id",
    });
  }

  const priority = ownValue(rawTask, "priority");
  if (!isFiniteNonNegativeNumber(priority)) {
    issues.push({
      code: "power-creep-task-priority-invalid",
      message: "Power Creep queue task has a missing or invalid priority.",
      field: "priority",
    });
  }

  const createdAt = ownValue(rawTask, "createdAt");
  if (!isFiniteNonNegativeNumber(createdAt)) {
    issues.push({
      code: "power-creep-task-created-at-invalid",
      message: "Power Creep queue task has a missing or invalid creation tick.",
      field: "createdAt",
    });
  }

  const targetId = ownValue(rawTask, "targetId");
  if (knownType && POWER_CREEP_TARGET_REQUIRED_TYPES.has(type) && !isNonEmptyString(targetId)) {
    issues.push({
      code: "power-creep-task-target-required",
      message: "Power Creep queue task type requires a non-empty target id.",
      field: "targetId",
    });
  } else if (targetId !== undefined && !isNonEmptyString(targetId)) {
    issues.push({
      code: "power-creep-task-target-invalid",
      message: "Power Creep queue task has an invalid target id.",
      field: "targetId",
    });
  }

  return {
    ref: {
      system: "power-creep-action",
      namespace: NAMESPACE,
      scope: { kind: "actor", actorId },
      localId: id,
    },
    activity: issues.length === 0 ? "available" : "unknown",
    sourceState: "queued",
    authorities: [
      { role: "queue_owner", id: actorId },
      { role: "executor", id: actorId },
    ],
    ...(isFiniteNonNegativeNumber(createdAt) ? { createdAt } : {}),
    issues: issues.map((issue) => ({ ...issue })),
  };
}

const powerCreepActionAdapter: TaskSystemAdapter<PowerCreepActionAdapterContext> = {
  system: "power-creep-action",

  snapshot(context): TaskSystemAdapterResult {
    if (!isRecord(context)) {
      return malformedSourceResult({
        code: "power-creep-adapter-context-malformed",
        message: "Power Creep adapter context must be an object.",
        field: "context",
      });
    }

    const actorNamesValidation = validateActorNames(ownValue(context, "actorNames"));
    if (actorNamesValidation.ok === false) {
      return actorNamesValidation.result;
    }

    const source = context.powerCreepMemory;
    if (source === undefined || source === null) {
      return { entries: [], invalidCount: 0, issues: [] };
    }
    if (!isRecord(source)) {
      return malformedSourceResult({
        code: "power-creep-memory-source-malformed",
        message: "Power Creep memory source must be a record keyed by actor id.",
        field: "powerCreepMemory",
      });
    }

    const entriesByActor = new Map<string, Map<string, WorkStatusView>>();
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    const actorNames = actorNamesValidation.names;
    const actorNameSet = new Set(actorNames);

    for (const actorId of Object.keys(source).sort(compareText)) {
      if (!isNonEmptyString(actorId)) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "power-creep-actor-id-invalid",
          message: "Power Creep memory source contains an empty actor id.",
          field: "powerCreepMemory",
        });
        continue;
      }

      const staleActor = !actorNameSet.has(actorId);

      const memory = ownValue(source, actorId);
      if (!isRecord(memory)) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "power-creep-memory-record-malformed",
          message: `Power Creep memory for actor ${actorId} is not an object.`,
          field: actorId,
        });
        continue;
      }

      // A prototype `memory` property identifies an engine PowerCreep-shaped
      // source. `in` observes the shape without evaluating its getter, so a
      // registry wiring mistake is reported instead of becoming a silent
      // empty queue or triggering engine-backed Memory initialization.
      if ("memory" in memory) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "power-creep-engine-actor-source",
          message: `Power Creep actor ${actorId} was supplied instead of its Memory.powerCreeps record.`,
          field: actorId,
        });
        continue;
      }

      // Each source entry already is PowerCreepMemory. Reading only the own
      // tasks field avoids the engine PowerCreep.memory prototype getter and
      // therefore cannot materialize or migrate actor memory on observation.
      const queue = ownValue(memory, "tasks");
      if (queue === undefined) {
        if (staleActor) {
          invalidCount += 1;
          appendSystemIssue(issues, staleActorIssue(actorId));
        }
        continue;
      }
      if (!Array.isArray(queue)) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "power-creep-queue-malformed",
          message: `Power Creep actor ${actorId} task queue is not an array.`,
          field: actorId,
        });
        continue;
      }
      if (staleActor && queue.length === 0) {
        invalidCount += 1;
        appendSystemIssue(issues, staleActorIssue(actorId));
        continue;
      }

      const actorEntries = new Map<string, WorkStatusView>();
      entriesByActor.set(actorId, actorEntries);

      for (const rawTask of queue) {
        if (!isRecord(rawTask)) {
          invalidCount += 1;
          appendSystemIssue(issues, {
            code: "power-creep-task-malformed",
            message: `Power Creep actor ${actorId} queue contains a non-object task.`,
            field: actorId,
          });
          continue;
        }

        const projectedEntry = projectTask(actorId, rawTask);
        if (!projectedEntry) {
          invalidCount += 1;
          appendSystemIssue(issues, {
            code: "power-creep-task-id-invalid",
            message: `Power Creep actor ${actorId} queue contains a task without a stable id.`,
            field: "id",
          });
          continue;
        }
        const entry = staleActor
          ? projectStaleActorEntry(actorId, projectedEntry)
          : projectedEntry;
        const existing = actorEntries.get(entry.ref.localId);
        if (!existing) {
          actorEntries.set(entry.ref.localId, entry);
          continue;
        }

        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "power-creep-task-id-duplicate",
          message: `Power Creep actor ${actorId} queue repeats task id ${entry.ref.localId}.`,
          field: "id",
        });
        actorEntries.set(
          entry.ref.localId,
          mergeDuplicateTaskViews(existing, entry),
        );
      }
    }

    const entries: WorkStatusView[] = [];
    for (const actorEntries of entriesByActor.values()) {
      entries.push(...actorEntries.values());
    }

    return {
      entries: sortWorkStatusViews(entries),
      invalidCount,
      issues: sortIssues(issues),
    };
  },
};

export default powerCreepActionAdapter;
