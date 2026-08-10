import { TASK_SYSTEM_CATALOG } from "@/runtime/taskSystem/catalog";
import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

export const RESOURCE_TRANSFER_NAMESPACE = TASK_SYSTEM_CATALOG["resource-transfer"].domainOwner;

const RESOURCE_TRANSFER_EXECUTOR = "resourceControl";
const RESOURCE_TRANSFER_V2_SCHEMA_VERSION = 2;

const RESOURCE_TRANSFER_STATUSES = new Set(["pending", "done", "cancelled", "failed"]);
const RESOURCE_TRANSFER_ORIGINS = new Set(["manual", "automatic"]);
const RESOURCE_TRANSFER_BLOCKERS = new Set([
  "receiver_capacity",
  "source_depleted",
  "insufficient_terminal_resource_or_fee",
]);

type ResourceTransferStatus = "pending" | "done" | "cancelled" | "failed";
type ResourceTransferOrigin = "manual" | "automatic";

interface UnknownRecord {
  readonly [key: string]: unknown;
}

export interface ResourceTransferWorkStatusView extends WorkStatusView {
  readonly resource?: string;
  readonly amount?: number;
  readonly remainingAmount?: number;
  readonly origin?: ResourceTransferOrigin;
  readonly blockedSince?: number;
  readonly reason?: string;
  readonly lastError?: string;
}

export interface ResourceTransferAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly ResourceTransferWorkStatusView[];
}

export type ResourceTransferAdapterContext = unknown;

export interface ResourceTransferTaskSystemAdapter extends TaskSystemAdapter<ResourceTransferAdapterContext> {
  readonly system: "resource-transfer";
  snapshot(context: ResourceTransferAdapterContext): ResourceTransferAdapterResult;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(source: UnknownRecord, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, field) ? source[field] : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createIssue(code: string, message: string, field?: string): WorkProjectionIssue {
  return field === undefined ? { code, message } : { code, message, field };
}

function isResourceTransferStatus(value: unknown): value is ResourceTransferStatus {
  return typeof value === "string" && RESOURCE_TRANSFER_STATUSES.has(value);
}

function isResourceTransferOrigin(value: unknown): value is ResourceTransferOrigin {
  return typeof value === "string" && RESOURCE_TRANSFER_ORIGINS.has(value);
}

function activityForStatus(status: ResourceTransferStatus, blocker: string | undefined): WorkActivity {
  if (status === "pending") {
    return blocker === undefined ? "available" : "blocked";
  }
  return "terminal";
}

function copyOptionalString(
  source: UnknownRecord,
  field: "reason" | "lastError",
  issues: WorkProjectionIssue[],
): string | undefined {
  const value = ownValue(source, field);
  if (value === undefined) return undefined;
  if (isNonEmptyString(value)) return value;
  issues.push(createIssue(
    "resource-transfer-invalid-field",
    `${field} must be a string when present`,
    field,
  ));
  return undefined;
}

function projectTask(
  storeKey: string,
  source: UnknownRecord,
  schemaMode: "v2" | "legacy" | "unknown",
): ResourceTransferWorkStatusView | null {
  if (!isNonEmptyString(storeKey)) return null;

  const fromRoomName = ownValue(source, "fromRoomName");
  const toRoomName = ownValue(source, "toRoomName");
  if (!isNonEmptyString(fromRoomName) || !isNonEmptyString(toRoomName)) {
    return null;
  }

  const issues: WorkProjectionIssue[] = [];
  let malformed = false;
  const addMalformedIssue = (code: string, message: string, field?: string): void => {
    issues.push(createIssue(code, message, field));
    malformed = true;
  };

  if (schemaMode === "legacy") {
    issues.push(createIssue(
      "resource-transfer-legacy-schema",
      "task was read without applying the ResourceTransfer v2 migration",
    ));
  } else if (schemaMode === "unknown") {
    addMalformedIssue(
      "resource-transfer-unknown-schema",
      "task schema version is not supported by the v2 adapter",
    );
  }

  if (ownValue(source, "id") !== storeKey) {
    addMalformedIssue(
      "resource-transfer-identity-conflict",
      "task id does not match its store key",
      "id",
    );
  }

  if (fromRoomName === toRoomName) {
    addMalformedIssue(
      "resource-transfer-invalid-scope",
      "cross-room transfer endpoints must be different",
      "toRoomName",
    );
  }

  const rawStatus = ownValue(source, "status");
  const status = isResourceTransferStatus(rawStatus) ? rawStatus : undefined;
  if (status === undefined) {
    addMalformedIssue(
      "resource-transfer-unknown-status",
      "task status is missing or unknown",
      "status",
    );
  }

  const rawResource = ownValue(source, "resource");
  const resource = isNonEmptyString(rawResource) ? rawResource : undefined;
  if (resource === undefined) {
    addMalformedIssue(
      "resource-transfer-invalid-field",
      "resource must be a non-empty string",
      "resource",
    );
  } else if (!RESOURCES_ALL.includes(resource as ResourceConstant)) {
    addMalformedIssue(
      "resource-transfer-unknown-resource",
      "resource is not a member of RESOURCES_ALL",
      "resource",
    );
  }

  const amount = asFiniteNumber(ownValue(source, "amount"));
  if (amount === undefined || amount <= 0) {
    addMalformedIssue(
      "resource-transfer-invalid-field",
      "amount must be a finite positive number",
      "amount",
    );
  }

  const remainingAmount = asFiniteNumber(ownValue(source, "remainingAmount"));
  if (remainingAmount === undefined || remainingAmount < 0) {
    addMalformedIssue(
      "resource-transfer-invalid-field",
      "remainingAmount must be a finite non-negative number",
      "remainingAmount",
    );
  } else if (amount !== undefined && remainingAmount > amount) {
    addMalformedIssue(
      "resource-transfer-quantity-conflict",
      "remainingAmount exceeds amount",
      "remainingAmount",
    );
  }
  if (status === "done" && remainingAmount !== undefined && remainingAmount !== 0) {
    addMalformedIssue(
      "resource-transfer-quantity-conflict",
      "done task retains a non-zero remainingAmount",
      "remainingAmount",
    );
  }
  if (status === "pending" && remainingAmount === 0) {
    addMalformedIssue(
      "resource-transfer-quantity-conflict",
      "pending task has no remaining amount",
      "remainingAmount",
    );
  }

  const createdAtValue = asFiniteNumber(ownValue(source, "createdAt"));
  const createdAt = createdAtValue !== undefined && createdAtValue >= 0 ? createdAtValue : undefined;
  if (createdAt === undefined) {
    addMalformedIssue(
      "resource-transfer-invalid-field",
      "createdAt must be a finite number",
      "createdAt",
    );
  }

  const rawUpdatedAt = ownValue(source, "updatedAt");
  const updatedAtValue = asFiniteNumber(rawUpdatedAt);
  const updatedAt = updatedAtValue !== undefined && updatedAtValue >= 0 ? updatedAtValue : undefined;
  if (updatedAt === undefined) {
    if (schemaMode === "legacy" && rawUpdatedAt === undefined) {
      issues.push(createIssue(
        "resource-transfer-legacy-field-missing",
        "legacy task has no updatedAt; no fallback was written or inferred",
        "updatedAt",
      ));
    } else {
      addMalformedIssue(
        "resource-transfer-invalid-field",
        "updatedAt must be a finite number",
        "updatedAt",
      );
    }
  }

  const rawLastProgressAt = ownValue(source, "lastProgressAt");
  const lastProgressAtValue = asFiniteNumber(rawLastProgressAt);
  const lastProgressAt = lastProgressAtValue !== undefined && lastProgressAtValue >= 0
    ? lastProgressAtValue
    : undefined;
  if (lastProgressAt === undefined) {
    if (schemaMode === "legacy" && rawLastProgressAt === undefined) {
      issues.push(createIssue(
        "resource-transfer-legacy-field-missing",
        "legacy task has no lastProgressAt; no fallback was written or inferred",
        "lastProgressAt",
      ));
    } else {
      addMalformedIssue(
        "resource-transfer-invalid-field",
        "lastProgressAt must be a finite number",
        "lastProgressAt",
      );
    }
  }

  if (createdAt !== undefined && updatedAt !== undefined && updatedAt < createdAt) {
    addMalformedIssue(
      "resource-transfer-timestamp-conflict",
      "updatedAt precedes createdAt",
      "updatedAt",
    );
  }
  if (
    createdAt !== undefined
    && lastProgressAt !== undefined
    && lastProgressAt < createdAt
  ) {
    addMalformedIssue(
      "resource-transfer-timestamp-conflict",
      "lastProgressAt precedes createdAt",
      "lastProgressAt",
    );
  }
  if (
    updatedAt !== undefined
    && lastProgressAt !== undefined
    && lastProgressAt > updatedAt
  ) {
    addMalformedIssue(
      "resource-transfer-timestamp-conflict",
      "lastProgressAt follows updatedAt",
      "lastProgressAt",
    );
  }

  const authorities: WorkAuthorityRef[] = [];
  const rawOrigin = ownValue(source, "origin");
  const origin = isResourceTransferOrigin(rawOrigin) ? rawOrigin : undefined;
  if (origin !== undefined) {
    authorities.push({ role: "producer", id: origin });
  } else if (schemaMode === "legacy" && rawOrigin === undefined) {
    issues.push(createIssue(
      "resource-transfer-legacy-field-missing",
      "legacy task has no origin; producer authority was not inferred from reason",
      "origin",
    ));
  } else {
    addMalformedIssue(
      "resource-transfer-unknown-origin",
      "task origin is missing or unknown",
      "origin",
    );
  }
  authorities.push({ role: "executor", id: RESOURCE_TRANSFER_EXECUTOR });

  let blocker: string | undefined;
  const rawBlockedReason = ownValue(source, "blockedReason");
  if (rawBlockedReason !== undefined) {
    if (typeof rawBlockedReason === "string" && RESOURCE_TRANSFER_BLOCKERS.has(rawBlockedReason)) {
      blocker = rawBlockedReason;
      if (status === "done" || status === "cancelled" || status === "failed") {
        issues.push(createIssue(
          "resource-transfer-historical-retained-blocker",
          "terminal task retains historical blocker fields; it is not an active blocked task",
          "blockedReason",
        ));
      } else if (status !== "pending") {
        addMalformedIssue(
          "resource-transfer-blocker-state-conflict",
          "blocker cannot be interpreted without a known pending or terminal status",
          "blockedReason",
        );
      }
    } else {
      addMalformedIssue(
        "resource-transfer-unknown-blocker",
        "blockedReason is not recognized by the v2 adapter",
        "blockedReason",
      );
    }
  }

  const rawBlockedSince = ownValue(source, "blockedSince");
  const blockedSinceValue = asFiniteNumber(rawBlockedSince);
  const blockedSince = blockedSinceValue !== undefined && blockedSinceValue >= 0
    ? blockedSinceValue
    : undefined;
  if (blocker !== undefined && blockedSince === undefined) {
    addMalformedIssue(
      "resource-transfer-invalid-field",
      "blocked tasks must have a finite blockedSince",
      "blockedSince",
    );
  } else if (blocker === undefined && rawBlockedSince !== undefined) {
    addMalformedIssue(
      "resource-transfer-blocker-state-conflict",
      "blockedSince is present without blockedReason",
      "blockedSince",
    );
  }

  if (
    blocker !== undefined
    && blockedSince !== undefined
    && createdAt !== undefined
    && blockedSince < createdAt
  ) {
    addMalformedIssue(
      "resource-transfer-timestamp-conflict",
      "blockedSince precedes createdAt",
      "blockedSince",
    );
  }
  if (
    blocker !== undefined
    && blockedSince !== undefined
    && updatedAt !== undefined
    && blockedSince > updatedAt
  ) {
    addMalformedIssue(
      "resource-transfer-timestamp-conflict",
      "blockedSince follows updatedAt",
      "blockedSince",
    );
  }

  const issueCountBeforeOptionalStrings = issues.length;
  const reason = copyOptionalString(source, "reason", issues);
  const lastError = copyOptionalString(source, "lastError", issues);
  if (issues.length > issueCountBeforeOptionalStrings) malformed = true;

  const sourceState = typeof rawStatus === "string" && rawStatus.length > 0
    ? rawStatus
    : "unknown";
  const activity = malformed || status === undefined
    ? "unknown"
    : activityForStatus(status, blocker);

  return {
    ref: {
      system: "resource-transfer",
      namespace: RESOURCE_TRANSFER_NAMESPACE,
      scope: { kind: "cross_room", fromRoomName, toRoomName },
      localId: storeKey,
    },
    activity,
    sourceState,
    authorities,
    createdAt,
    updatedAt,
    lastProgressAt,
    blocker,
    issues,
    resource,
    amount,
    remainingAmount,
    origin,
    blockedSince,
    reason,
    lastError,
  };
}

function readResourceTransferStore(): {
  readonly tasks?: unknown;
  readonly schemaVersion?: unknown;
  readonly resourceControlMalformed: boolean;
} {
  const data = (Memory as unknown as { readonly data?: unknown }).data;
  if (data === undefined) return { resourceControlMalformed: false };
  if (!isRecord(data)) return { resourceControlMalformed: true };

  const resourceControl = ownValue(data, "resourceControl");
  if (resourceControl === undefined) {
    return { resourceControlMalformed: false };
  }
  if (!isRecord(resourceControl)) return { resourceControlMalformed: true };

  return {
    tasks: ownValue(resourceControl, "tasks"),
    schemaVersion: ownValue(resourceControl, "taskSchemaVersion"),
    resourceControlMalformed: false,
  };
}

function resolveSchemaMode(schemaVersion: unknown): "v2" | "legacy" | "unknown" {
  if (schemaVersion === RESOURCE_TRANSFER_V2_SCHEMA_VERSION) return "v2";
  if (schemaVersion === undefined) return "legacy";
  if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion < 2) {
    return "legacy";
  }
  return "unknown";
}

export const resourceTransferAdapter: ResourceTransferTaskSystemAdapter = {
  system: "resource-transfer",
  snapshot(_context: ResourceTransferAdapterContext): ResourceTransferAdapterResult {
    const source = readResourceTransferStore();
    if (source.resourceControlMalformed) {
      return {
        entries: [],
        invalidCount: 1,
        issues: [createIssue(
          "resource-transfer-store-shape",
          "Memory.data.resourceControl must be an object when present",
          "Memory.data.resourceControl",
        )],
      };
    }

    if (source.tasks === undefined) {
      return { entries: [], invalidCount: 0, issues: [] };
    }
    if (!isRecord(source.tasks)) {
      return {
        entries: [],
        invalidCount: 1,
        issues: [createIssue(
          "resource-transfer-store-shape",
          "Memory.data.resourceControl.tasks must be an object when present",
          "Memory.data.resourceControl.tasks",
        )],
      };
    }

    const entries: ResourceTransferWorkStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    const schemaMode = resolveSchemaMode(source.schemaVersion);
    if (schemaMode === "unknown") {
      issues.push(createIssue(
        "resource-transfer-unknown-schema",
        "Memory.data.resourceControl.taskSchemaVersion is not supported by the v2 adapter",
        "Memory.data.resourceControl.taskSchemaVersion",
      ));
    }

    for (const storeKey of Object.keys(source.tasks)) {
      const rawTask = source.tasks[storeKey];
      if (!isRecord(rawTask)) {
        invalidCount += 1;
        continue;
      }

      const projected = projectTask(storeKey, rawTask, schemaMode);
      if (projected === null) {
        invalidCount += 1;
        continue;
      }
      entries.push(projected);
    }

    const sortedEntries = sortWorkStatusViews(entries)
      .map((entry) => entry as ResourceTransferWorkStatusView);
    return { entries: sortedEntries, invalidCount, issues };
  },
};

export default resourceTransferAdapter;
