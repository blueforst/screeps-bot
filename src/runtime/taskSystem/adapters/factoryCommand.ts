import { TASK_SYSTEM_CATALOG } from "@/runtime/taskSystem/catalog";
import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

export interface FactoryCommandAdapterContext {
  readonly tasks?: unknown;
}

const NAMESPACE = TASK_SYSTEM_CATALOG["factory-command"].domainOwner;
const MAX_SYSTEM_ISSUES = 20;
const FACTORY_TASK_TYPE = "decompress_battery";

function mapFactoryActivity(status: string): WorkActivity | undefined {
  switch (status) {
    case "pending":
      return "available";
    case "loading":
    case "producing":
    case "unloading":
      return "running";
    case "done":
    case "cancelled":
    case "failed":
      return "terminal";
    default:
      return undefined;
  }
}

function isActiveFactoryStatus(status: unknown): boolean {
  return status === "pending"
    || status === "loading"
    || status === "producing"
    || status === "unloading";
}

function isTerminalFactoryStatus(status: unknown): boolean {
  return status === "done" || status === "cancelled" || status === "failed";
}

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

function addInvalidNumberIssue(
  issues: WorkProjectionIssue[],
  field: string,
): void {
  issues.push({
    code: "factory-command-number-invalid",
    message: `Factory command has a missing or invalid ${field} value.`,
    field,
  });
}

function projectTask(
  storeId: string,
  rawTask: Record<string, unknown>,
): WorkStatusView | null {
  const roomName = ownValue(rawTask, "roomName");
  if (!isNonEmptyString(roomName)) {
    return null;
  }

  const issues: WorkProjectionIssue[] = [];
  let invalidProjection = false;
  const addInvalidIssue = (issue: WorkProjectionIssue): void => {
    issues.push({ ...issue });
    invalidProjection = true;
  };

  const sourceId = ownValue(rawTask, "id");
  if (!isNonEmptyString(sourceId)) {
    addInvalidIssue({
      code: "factory-command-id-invalid",
      message: "Factory command is missing its source id; the store key is used only for observation.",
      field: "id",
    });
  } else if (sourceId !== storeId) {
    addInvalidIssue({
      code: "factory-command-id-mismatch",
      message: "Factory command source id does not match its store key.",
      field: "id",
    });
  }

  const type = ownValue(rawTask, "type");
  if (type !== FACTORY_TASK_TYPE) {
    addInvalidIssue({
      code: "factory-command-type-invalid",
      message: "Factory command has an unknown or missing command type.",
      field: "type",
    });
  }

  const status = ownValue(rawTask, "status");
  const sourceState = typeof status === "string" ? status : "unknown";
  const mappedActivity = typeof status === "string"
    ? mapFactoryActivity(status)
    : undefined;
  if (!mappedActivity) {
    addInvalidIssue({
      code: "factory-command-status-invalid",
      message: "Factory command has an unknown or missing source status.",
      field: "status",
    });
  }

  const requested = ownValue(rawTask, "requestedBatteryAmount");
  const remaining = ownValue(rawTask, "remainingBatteryAmount");
  const produced = ownValue(rawTask, "producedEnergyAmount");
  const createdAt = ownValue(rawTask, "createdAt");
  const updatedAt = ownValue(rawTask, "updatedAt");
  const completedAt = ownValue(rawTask, "completedAt");

  for (const [field, value] of [
    ["requestedBatteryAmount", requested],
    ["remainingBatteryAmount", remaining],
    ["producedEnergyAmount", produced],
    ["createdAt", createdAt],
    ["updatedAt", updatedAt],
  ] as const) {
    if (!isFiniteNonNegativeNumber(value)) {
      addInvalidNumberIssue(issues, field);
      invalidProjection = true;
    }
  }

  if (completedAt !== undefined && !isFiniteNonNegativeNumber(completedAt)) {
    addInvalidNumberIssue(issues, "completedAt");
    invalidProjection = true;
  }

  if (isActiveFactoryStatus(status) && completedAt !== undefined) {
    addInvalidIssue({
      code: "factory-command-active-completed-at-conflict",
      message: "Active Factory command unexpectedly carries a completion tick.",
      field: "completedAt",
    });
  }

  if (isTerminalFactoryStatus(status) && completedAt === undefined) {
    addInvalidIssue({
      code: "factory-command-completed-at-required",
      message: "Terminal Factory command is missing its completion tick.",
      field: "completedAt",
    });
  }

  if (
    status === "done"
    && isFiniteNonNegativeNumber(remaining)
    && remaining !== 0
  ) {
    addInvalidIssue({
      code: "factory-command-done-remaining-conflict",
      message: "Completed Factory command still has remaining battery work.",
      field: "remainingBatteryAmount",
    });
  }

  if (
    isFiniteNonNegativeNumber(requested)
    && isFiniteNonNegativeNumber(remaining)
    && remaining > requested
  ) {
    addInvalidIssue({
      code: "factory-command-amount-conflict",
      message: "Factory command remaining battery exceeds its requested battery amount.",
      field: "remainingBatteryAmount",
    });
  }

  if (
    isFiniteNonNegativeNumber(createdAt)
    && isFiniteNonNegativeNumber(updatedAt)
    && updatedAt < createdAt
  ) {
    addInvalidIssue({
      code: "factory-command-timestamp-conflict",
      message: "Factory command update tick precedes its creation tick.",
      field: "updatedAt",
    });
  }

  if (
    isFiniteNonNegativeNumber(createdAt)
    && isFiniteNonNegativeNumber(completedAt)
    && completedAt < createdAt
  ) {
    addInvalidIssue({
      code: "factory-command-timestamp-conflict",
      message: "Factory command completion tick precedes its creation tick.",
      field: "completedAt",
    });
  }

  if (
    isFiniteNonNegativeNumber(updatedAt)
    && isFiniteNonNegativeNumber(completedAt)
    && completedAt > updatedAt
  ) {
    addInvalidIssue({
      code: "factory-command-timestamp-conflict",
      message: "Factory command completion tick follows its latest update tick.",
      field: "completedAt",
    });
  }

  const lastError = ownValue(rawTask, "lastError");
  if (lastError !== undefined && !isNonEmptyString(lastError)) {
    addInvalidIssue({
      code: "factory-command-last-error-invalid",
      message: "Factory command has an invalid lastError value.",
      field: "lastError",
    });
  }

  if (isActiveFactoryStatus(status) && isNonEmptyString(lastError)) {
    issues.push({
      code: "factory-active-last-error-ambiguous",
      message: "Factory task lastError can survive a later active transition; runtime room state is required to prove a current blocker.",
      field: "lastError",
    });
  }

  if (status === "failed") {
    issues.push({
      code: "factory-failed-protection-ambiguous",
      message: "Factory execution treats failed as terminal while market-sale protection still retains its remaining battery demand.",
      field: "status",
    });
  }

  return {
    ref: {
      system: "factory-command",
      namespace: NAMESPACE,
      scope: { kind: "room", roomName },
      localId: storeId,
    },
    activity: invalidProjection ? "unknown" : mappedActivity!,
    sourceState,
    authorities: [
      { role: "workflow_owner", id: NAMESPACE },
      { role: "executor", id: NAMESPACE },
    ],
    ...(isFiniteNonNegativeNumber(createdAt) ? { createdAt } : {}),
    ...(isFiniteNonNegativeNumber(updatedAt) ? { updatedAt } : {}),
    ...(isTerminalFactoryStatus(status) && isNonEmptyString(lastError)
      ? { blocker: lastError }
      : {}),
    issues: issues.map((issue) => ({ ...issue })),
  };
}

const factoryCommandAdapter: TaskSystemAdapter<FactoryCommandAdapterContext> = {
  system: "factory-command",

  snapshot(context): TaskSystemAdapterResult {
    const source = context.tasks;
    if (source === undefined || source === null) {
      return { entries: [], invalidCount: 0, issues: [] };
    }
    if (!isRecord(source)) {
      return {
        entries: [],
        invalidCount: 1,
        issues: [{
          code: "factory-command-source-malformed",
          message: "Factory command source must be a record keyed by command id.",
          field: "tasks",
        }],
      };
    }

    const entries: WorkStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;

    for (const storeId of Object.keys(source)) {
      if (!isNonEmptyString(storeId)) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "factory-command-store-id-invalid",
          message: "Factory command store contains an empty command id.",
          field: "tasks",
        });
        continue;
      }

      const rawTask = ownValue(source, storeId);
      if (!isRecord(rawTask)) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "factory-command-record-malformed",
          message: `Factory command ${storeId} is not an object.`,
          field: storeId,
        });
        continue;
      }

      const entry = projectTask(storeId, rawTask);
      if (!entry) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "factory-command-room-invalid",
          message: `Factory command ${storeId} has no stable room scope.`,
          field: "roomName",
        });
        continue;
      }
      entries.push(entry);
    }

    return {
      entries: sortWorkStatusViews(entries),
      invalidCount,
      issues: issues.map((issue) => ({ ...issue })),
    };
  },
};

export default factoryCommandAdapter;
