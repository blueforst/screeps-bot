import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const SYSTEM = "remote-mining-workflow" as const;
const NAMESPACE = "remoteMining";
const MAX_SYSTEM_ISSUES = 20;
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;
const STATUS_ACTIVITY = {
  scouting: "running",
  active: "running",
  suspended: "blocked",
  defending: "running",
  abandoned: "terminal",
} as const satisfies Record<string, WorkActivity>;
const DEFENSE_REASONS = new Set(["npc_invader", "npc_invader_core", "player_aggression"]);

type RemoteMiningStatus = keyof typeof STATUS_ACTIVITY;
type UnknownRecord = Record<string, unknown>;
export type RemoteMiningWorkflowAdapterContext = unknown;

export interface RemoteMiningWorkflowStatusView extends WorkStatusView {
  readonly sourceRoom: string;
  readonly targetRoom?: string;
  readonly sourceIds?: readonly string[];
  readonly assignedAt?: number;
  readonly lastVerifiedAt?: number;
  readonly suspendReason?: string;
  readonly suspendedAt?: number;
  readonly lastThreatAt?: number;
  readonly safeSince?: number;
  readonly abandonedReason?: string;
  /**
   * 原领域当前会写入、但不会消费的事实。它不能被解释为统一层重试计划。
   */
  readonly nextRetryAt?: number;
  readonly defendingSince?: number;
  readonly lastDefenseThreatAt?: number;
  readonly defenseReason?: string;
  readonly lastDefenseSafeAt?: number;
}

export interface RemoteMiningWorkflowAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly RemoteMiningWorkflowStatusView[];
}

export interface RemoteMiningWorkflowTaskSystemAdapter extends TaskSystemAdapter<RemoteMiningWorkflowAdapterContext> {
  readonly system: "remote-mining-workflow";
  snapshot(context: RemoteMiningWorkflowAdapterContext): RemoteMiningWorkflowAdapterResult;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME_PATTERN.test(value);
}

function isFiniteTick(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalFiniteTick(value: unknown): value is number | undefined {
  return value === undefined || isFiniteTick(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function issue(code: string, message: string, field?: string): WorkProjectionIssue {
  return field ? { code, message, field } : { code, message };
}

function appendSystemIssue(issues: WorkProjectionIssue[], next: WorkProjectionIssue): void {
  if (issues.length < MAX_SYSTEM_ISSUES) issues.push(next);
}

function readStore(): { readonly store?: UnknownRecord; readonly failure?: WorkProjectionIssue } {
  const data = (Memory as unknown as { data?: unknown }).data;
  if (data === undefined) return {};
  if (!isRecord(data)) {
    return { failure: issue("invalid-memory-data", "Memory.data is not an object", "Memory.data") };
  }
  const store = Object.prototype.hasOwnProperty.call(data, "remoteMining")
    ? data.remoteMining
    : undefined;
  if (store === undefined) return {};
  if (!isRecord(store)) {
    return {
      failure: issue(
        "invalid-workflow-store",
        "Memory.data.remoteMining is not an object record",
        "Memory.data.remoteMining",
      ),
    };
  }
  return { store };
}

function statusActivity(value: unknown): WorkActivity | undefined {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(STATUS_ACTIVITY, value)) {
    return undefined;
  }
  return STATUS_ACTIVITY[value as RemoteMiningStatus];
}

function projectEntry(storeKey: string, value: unknown): RemoteMiningWorkflowStatusView | null {
  if (!isRecord(value)) return null;

  const sourceRoom = value.sourceRoom;
  const targetRoom = isRoomName(value.targetRoom) ? value.targetRoom : undefined;
  const scopeTargetRoom = isRoomName(storeKey) ? storeKey : targetRoom;
  if (!isRoomName(sourceRoom) || !scopeTargetRoom || storeKey.length === 0) return null;

  const issues: WorkProjectionIssue[] = [];
  let activity = statusActivity(value.status);
  if (!activity) {
    issues.push(issue("unknown-domain-status", "RemoteMining status is unknown", "status"));
    activity = "unknown";
  }
  if (!targetRoom) {
    issues.push(issue("invalid-target-room", "targetRoom must be a Screeps room name", "targetRoom"));
    activity = "unknown";
  } else if (storeKey !== targetRoom) {
    issues.push(issue("workflow-key-mismatch", "Store key does not match targetRoom", "targetRoom"));
    activity = "unknown";
  }

  if (
    !Array.isArray(value.sourceIds)
    || !value.sourceIds.every((sourceId) => typeof sourceId === "string" && sourceId.length > 0)
  ) {
    issues.push(issue("invalid-source-ids", "sourceIds must be an array of non-empty strings", "sourceIds"));
    activity = "unknown";
  }

  if (!isFiniteTick(value.assignedAt)) {
    issues.push(issue("invalid-timestamp", "assignedAt must be a finite non-negative number", "assignedAt"));
    activity = "unknown";
  }
  if (!isFiniteTick(value.updatedAt)) {
    issues.push(issue("invalid-timestamp", "updatedAt must be a finite non-negative number", "updatedAt"));
    activity = "unknown";
  }
  if (
    isFiniteTick(value.assignedAt)
    && isFiniteTick(value.updatedAt)
    && value.updatedAt < value.assignedAt
  ) {
    issues.push(issue("timestamp-conflict", "updatedAt precedes assignedAt", "updatedAt"));
    activity = "unknown";
  }

  for (const field of [
    "lastVerifiedAt",
    "suspendedAt",
    "lastThreatAt",
    "safeSince",
    "nextRetryAt",
    "defendingSince",
    "lastDefenseThreatAt",
    "lastDefenseSafeAt",
  ] as const) {
    if (!isOptionalFiniteTick(value[field])) {
      issues.push(issue("invalid-timestamp", `${field} must be a finite non-negative number`, field));
      activity = "unknown";
    }
  }

  for (const field of ["suspendReason", "abandonedReason", "defenseReason"] as const) {
    if (!isOptionalString(value[field])) {
      issues.push(issue("invalid-domain-reason", `${field} must be a string`, field));
      activity = "unknown";
    }
  }
  if (
    typeof value.defenseReason === "string"
    && !DEFENSE_REASONS.has(value.defenseReason)
  ) {
    issues.push(issue(
      "invalid-domain-reason",
      "defenseReason is not recognized by the RemoteMining writer",
      "defenseReason",
    ));
    activity = "unknown";
  }

  const sourceState = typeof value.status === "string" ? value.status : "unknown";
  if (sourceState === "suspended") {
    for (const [field, valid] of [
      ["suspendReason", typeof value.suspendReason === "string" && value.suspendReason.length > 0],
      ["suspendedAt", isFiniteTick(value.suspendedAt)],
      ["lastThreatAt", isFiniteTick(value.lastThreatAt)],
    ] as const) {
      if (!valid) {
        issues.push(issue(
          "remote-mining-state-fact-conflict",
          `suspended workflow requires ${field}`,
          field,
        ));
        activity = "unknown";
      }
    }
    if (
      isFiniteTick(value.suspendedAt)
      && isFiniteTick(value.lastThreatAt)
      && value.lastThreatAt < value.suspendedAt
    ) {
      issues.push(issue(
        "remote-mining-state-fact-conflict",
        "lastThreatAt precedes suspendedAt",
        "lastThreatAt",
      ));
      activity = "unknown";
    }
  }
  if (sourceState === "defending") {
    for (const [field, valid] of [
      ["defendingSince", isFiniteTick(value.defendingSince)],
      ["lastDefenseThreatAt", isFiniteTick(value.lastDefenseThreatAt)],
      ["defenseReason", typeof value.defenseReason === "string" && value.defenseReason.length > 0],
    ] as const) {
      if (!valid) {
        issues.push(issue(
          "remote-mining-state-fact-conflict",
          `defending workflow requires ${field}`,
          field,
        ));
        activity = "unknown";
      }
    }
    if (
      isFiniteTick(value.defendingSince)
      && isFiniteTick(value.lastDefenseThreatAt)
      && value.lastDefenseThreatAt < value.defendingSince
    ) {
      issues.push(issue(
        "remote-mining-state-fact-conflict",
        "lastDefenseThreatAt precedes defendingSince",
        "lastDefenseThreatAt",
      ));
      activity = "unknown";
    }
  }
  const nextRetryAt = isFiniteTick(value.nextRetryAt) ? value.nextRetryAt : undefined;
  if (sourceState === "abandoned" && nextRetryAt !== undefined) {
    issues.push(issue(
      "remote-mining-inert-retry",
      `abandoned workflow retains nextRetryAt=${nextRetryAt}; the current domain lifecycle does not consume it`,
      "nextRetryAt",
    ));
  } else if (sourceState !== "abandoned" && nextRetryAt !== undefined) {
    issues.push(issue(
      "unexpected-retry-fact",
      "nextRetryAt is present outside the abandoned domain state",
      "nextRetryAt",
    ));
    activity = "unknown";
  }

  const authorities: WorkAuthorityRef[] = [
    { role: "producer", id: NAMESPACE },
    { role: "workflow_owner", id: sourceRoom, component: "source-room" },
  ];
  const blocker = sourceState === "suspended" && typeof value.suspendReason === "string"
    ? value.suspendReason
    : sourceState === "abandoned" && typeof value.abandonedReason === "string"
      ? value.abandonedReason
      : undefined;

  return {
    ref: {
      system: SYSTEM,
      namespace: NAMESPACE,
      scope: { kind: "cross_room", fromRoomName: sourceRoom, toRoomName: scopeTargetRoom },
      localId: storeKey,
    },
    activity,
    sourceState,
    authorities,
    createdAt: isFiniteTick(value.assignedAt) ? value.assignedAt : undefined,
    updatedAt: isFiniteTick(value.updatedAt) ? value.updatedAt : undefined,
    lastProgressAt: isFiniteTick(value.lastVerifiedAt) ? value.lastVerifiedAt : undefined,
    blocker,
    issues,
    sourceRoom,
    targetRoom,
    sourceIds: Array.isArray(value.sourceIds) && value.sourceIds.every(
      (sourceId) => typeof sourceId === "string" && sourceId.length > 0,
    )
      ? [...value.sourceIds]
      : undefined,
    assignedAt: isFiniteTick(value.assignedAt) ? value.assignedAt : undefined,
    lastVerifiedAt: isFiniteTick(value.lastVerifiedAt) ? value.lastVerifiedAt : undefined,
    suspendReason: typeof value.suspendReason === "string" ? value.suspendReason : undefined,
    suspendedAt: isFiniteTick(value.suspendedAt) ? value.suspendedAt : undefined,
    lastThreatAt: isFiniteTick(value.lastThreatAt) ? value.lastThreatAt : undefined,
    safeSince: isFiniteTick(value.safeSince) ? value.safeSince : undefined,
    abandonedReason: typeof value.abandonedReason === "string" ? value.abandonedReason : undefined,
    nextRetryAt,
    defendingSince: isFiniteTick(value.defendingSince) ? value.defendingSince : undefined,
    lastDefenseThreatAt: isFiniteTick(value.lastDefenseThreatAt) ? value.lastDefenseThreatAt : undefined,
    defenseReason: typeof value.defenseReason === "string" ? value.defenseReason : undefined,
    lastDefenseSafeAt: isFiniteTick(value.lastDefenseSafeAt) ? value.lastDefenseSafeAt : undefined,
  };
}

export const remoteMiningWorkflowAdapter: RemoteMiningWorkflowTaskSystemAdapter = {
  system: SYSTEM,
  snapshot(_context: RemoteMiningWorkflowAdapterContext): RemoteMiningWorkflowAdapterResult {
    const source = readStore();
    if (source.failure) {
      return { entries: [], invalidCount: 1, issues: [source.failure] };
    }
    if (!source.store) {
      return { entries: [], invalidCount: 0, issues: [] };
    }

    const entries: RemoteMiningWorkflowStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    for (const [storeKey, value] of Object.entries(source.store)) {
      const entry = projectEntry(storeKey, value);
      if (entry) {
        entries.push(entry);
      } else {
        invalidCount += 1;
        appendSystemIssue(issues, issue(
          "invalid-workflow-record",
          `RemoteMining record ${JSON.stringify(storeKey)} lacks a provable cross-room identity`,
          storeKey,
        ));
      }
    }

    return {
      entries: sortWorkStatusViews(entries) as RemoteMiningWorkflowStatusView[],
      invalidCount,
      issues,
    };
  },
};

export default remoteMiningWorkflowAdapter;
