import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const SYSTEM = "cross-shard-colonization-workflow" as const;
const NAMESPACE = "crossShardColonization";
const MAX_SYSTEM_ISSUES = 20;
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;
const STATUS_ACTIVITY = {
  planning: "available",
  ready: "available",
  spawning: "running",
  in_transit: "running",
  claimed: "running",
  bootstrapping: "running",
  completed: "terminal",
  blocked: "blocked",
  failed: "terminal",
} as const satisfies Record<string, WorkActivity>;

type CrossShardColonizationStatus = keyof typeof STATUS_ACTIVITY;
type UnknownRecord = Record<string, unknown>;
export type CrossShardColonizationWorkflowAdapterContext = unknown;

export interface CrossShardColonizationWorkflowStatusView extends WorkStatusView {
  readonly targetShard: string;
  readonly targetRoom: string;
  readonly preferredSourceRoom?: string;
  readonly sourceRoom?: string;
  readonly flagName?: string;
  readonly reason?: string;
  readonly portalId?: string;
  readonly portalRoom?: string;
  readonly destinationRoom?: string;
  readonly claimerConfigName?: string;
  readonly claimerName?: string;
  readonly bootstrapConfigNames?: readonly string[];
  readonly bootstrapDispatchedAt?: number;
  readonly launchedAt?: number;
  readonly claimedAt?: number;
  readonly completedAt?: number;
  readonly lastObservedAt?: number;
  readonly lastReadyAt?: number;
}

export interface CrossShardColonizationWorkflowAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly CrossShardColonizationWorkflowStatusView[];
}

export interface CrossShardColonizationWorkflowTaskSystemAdapter
  extends TaskSystemAdapter<CrossShardColonizationWorkflowAdapterContext> {
  readonly system: "cross-shard-colonization-workflow";
  snapshot(context: CrossShardColonizationWorkflowAdapterContext): CrossShardColonizationWorkflowAdapterResult;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteTick(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalFiniteTick(value: unknown): value is number | undefined {
  return value === undefined || isFiniteTick(value);
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
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
  const store = Object.prototype.hasOwnProperty.call(data, "crossShardColonization")
    ? data.crossShardColonization
    : undefined;
  if (store === undefined) return {};
  if (!isRecord(store)) {
    return {
      failure: issue(
        "invalid-workflow-store",
        "Memory.data.crossShardColonization is not an object record",
        "Memory.data.crossShardColonization",
      ),
    };
  }
  return { store };
}

function statusActivity(value: unknown): WorkActivity | undefined {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(STATUS_ACTIVITY, value)) {
    return undefined;
  }
  return STATUS_ACTIVITY[value as CrossShardColonizationStatus];
}

function projectEntry(storeKey: string, value: unknown): CrossShardColonizationWorkflowStatusView | null {
  if (!isRecord(value)) return null;
  const targetShard = value.targetShard;
  const targetRoom = value.targetRoom;
  const flagName = isNonEmptyString(value.flagName) ? value.flagName : undefined;
  if (!isNonEmptyString(targetShard) || !isRoomName(targetRoom) || storeKey.length === 0) return null;

  const issues: WorkProjectionIssue[] = [];
  let activity = statusActivity(value.status);
  if (!activity) {
    issues.push(issue("unknown-domain-status", "CrossShardColonization status is unknown", "status"));
    activity = "unknown";
  }
  const expectedKey = `${targetShard}:${targetRoom}`;
  if (storeKey.length === 0 || storeKey !== expectedKey) {
    issues.push(issue("workflow-key-mismatch", "Store key does not match target shard-room identity", "targetRoom"));
    activity = "unknown";
  }
  if (!flagName) {
    issues.push(issue("invalid-flag-name", "flagName must be a non-empty string", "flagName"));
    activity = "unknown";
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (!isFiniteTick(value[field])) {
      issues.push(issue("invalid-timestamp", `${field} must be a finite non-negative number`, field));
      activity = "unknown";
    }
  }
  for (const field of [
    "bootstrapDispatchedAt",
    "launchedAt",
    "claimedAt",
    "completedAt",
    "lastObservedAt",
    "lastReadyAt",
  ] as const) {
    if (!isOptionalFiniteTick(value[field])) {
      issues.push(issue("invalid-timestamp", `${field} must be a finite non-negative number`, field));
      activity = "unknown";
    }
  }
  for (const field of [
    "preferredSourceRoom",
    "sourceRoom",
    "reason",
    "portalId",
    "portalRoom",
    "destinationRoom",
    "claimerConfigName",
    "claimerName",
  ] as const) {
    if (!isOptionalNonEmptyString(value[field])) {
      issues.push(issue("invalid-domain-fact", `${field} must be a non-empty string`, field));
      activity = "unknown";
    }
  }
  if (
    value.bootstrapConfigNames !== undefined
    && (!Array.isArray(value.bootstrapConfigNames)
      || !value.bootstrapConfigNames.every((configName) => isNonEmptyString(configName)))
  ) {
    issues.push(issue(
      "invalid-domain-array",
      "bootstrapConfigNames must be an array of non-empty strings",
      "bootstrapConfigNames",
    ));
    activity = "unknown";
  }

  const sourceRoom = isRoomName(value.sourceRoom) ? value.sourceRoom : undefined;
  if (value.sourceRoom !== undefined && sourceRoom === undefined) {
    issues.push(issue("invalid-source-room", "sourceRoom must be a Screeps room name", "sourceRoom"));
    activity = "unknown";
  }
  if (value.preferredSourceRoom !== undefined && !isRoomName(value.preferredSourceRoom)) {
    issues.push(issue(
      "invalid-preferred-source-room",
      "preferredSourceRoom must be a Screeps room name",
      "preferredSourceRoom",
    ));
    activity = "unknown";
  }
  for (const field of ["portalRoom", "destinationRoom"] as const) {
    if (value[field] !== undefined && !isRoomName(value[field])) {
      issues.push(issue(
        "invalid-domain-room",
        `${field} must be a Screeps room name`,
        field,
      ));
      activity = "unknown";
    }
  }
  if (
    isFiniteTick(value.createdAt)
    && isFiniteTick(value.updatedAt)
    && value.updatedAt < value.createdAt
  ) {
    issues.push(issue("timestamp-conflict", "updatedAt precedes createdAt", "updatedAt"));
    activity = "unknown";
  }

  const sourceState = typeof value.status === "string" ? value.status : "unknown";
  if (["ready", "spawning", "in_transit", "bootstrapping"].includes(sourceState)) {
    if (!sourceRoom) {
      issues.push(issue(
        "cross-shard-state-fact-conflict",
        `${sourceState} workflow requires sourceRoom`,
        "sourceRoom",
      ));
      activity = "unknown";
    }
    if (!isRoomName(value.portalRoom)) {
      issues.push(issue(
        "cross-shard-state-fact-conflict",
        `${sourceState} workflow requires portalRoom`,
        "portalRoom",
      ));
      activity = "unknown";
    }
  }
  if (["ready", "spawning", "in_transit"].includes(sourceState)) {
    for (const field of ["claimerConfigName", "claimerName"] as const) {
      if (!isNonEmptyString(value[field])) {
        issues.push(issue(
          "cross-shard-state-fact-conflict",
          `${sourceState} workflow requires ${field}`,
          field,
        ));
        activity = "unknown";
      }
    }
  }
  const requiredStateTimestamp =
    sourceState === "in_transit"
      ? "launchedAt"
      : sourceState === "claimed"
        ? "claimedAt"
        : sourceState === "bootstrapping"
          ? "bootstrapDispatchedAt"
          : sourceState === "completed"
            ? "completedAt"
            : undefined;
  if (requiredStateTimestamp && !isFiniteTick(value[requiredStateTimestamp])) {
    issues.push(issue(
      "state-fact-conflict",
      `${sourceState} workflow requires ${requiredStateTimestamp}`,
      requiredStateTimestamp,
    ));
    activity = "unknown";
  }
  if ((sourceState === "blocked" || sourceState === "failed") && !isNonEmptyString(value.reason)) {
    issues.push(issue(
      "state-fact-conflict",
      `${sourceState} workflow requires a non-empty reason`,
      "reason",
    ));
    activity = "unknown";
  }

  const authorities: WorkAuthorityRef[] = [];
  if (flagName) authorities.push({ role: "producer", id: flagName, component: "flag" });
  if (sourceRoom) {
    authorities.push({ role: "workflow_owner", id: sourceRoom, component: "source-room" });
  }

  const progressCandidates = [
    value.completedAt,
    value.bootstrapDispatchedAt,
    value.claimedAt,
    value.lastObservedAt,
    value.launchedAt,
    value.lastReadyAt,
  ].filter(isFiniteTick);
  const lastProgressAt = progressCandidates.length > 0
    ? Math.max(...progressCandidates)
    : undefined;

  return {
    ref: {
      system: SYSTEM,
      namespace: NAMESPACE,
      scope: { kind: "shard_room", shardName: targetShard, roomName: targetRoom },
      localId: storeKey,
    },
    activity,
    sourceState,
    authorities,
    createdAt: isFiniteTick(value.createdAt) ? value.createdAt : undefined,
    updatedAt: isFiniteTick(value.updatedAt) ? value.updatedAt : undefined,
    lastProgressAt,
    blocker: (sourceState === "blocked" || sourceState === "failed") && isNonEmptyString(value.reason)
      ? value.reason
      : undefined,
    issues,
    targetShard,
    targetRoom,
    preferredSourceRoom: isRoomName(value.preferredSourceRoom) ? value.preferredSourceRoom : undefined,
    sourceRoom,
    flagName,
    reason: isNonEmptyString(value.reason) ? value.reason : undefined,
    portalId: isNonEmptyString(value.portalId) ? value.portalId : undefined,
    portalRoom: isRoomName(value.portalRoom) ? value.portalRoom : undefined,
    destinationRoom: isRoomName(value.destinationRoom) ? value.destinationRoom : undefined,
    claimerConfigName: isNonEmptyString(value.claimerConfigName) ? value.claimerConfigName : undefined,
    claimerName: isNonEmptyString(value.claimerName) ? value.claimerName : undefined,
    bootstrapConfigNames: Array.isArray(value.bootstrapConfigNames)
      && value.bootstrapConfigNames.every((configName) => isNonEmptyString(configName))
      ? [...value.bootstrapConfigNames]
      : undefined,
    bootstrapDispatchedAt: isFiniteTick(value.bootstrapDispatchedAt) ? value.bootstrapDispatchedAt : undefined,
    launchedAt: isFiniteTick(value.launchedAt) ? value.launchedAt : undefined,
    claimedAt: isFiniteTick(value.claimedAt) ? value.claimedAt : undefined,
    completedAt: isFiniteTick(value.completedAt) ? value.completedAt : undefined,
    lastObservedAt: isFiniteTick(value.lastObservedAt) ? value.lastObservedAt : undefined,
    lastReadyAt: isFiniteTick(value.lastReadyAt) ? value.lastReadyAt : undefined,
  };
}

export const crossShardColonizationWorkflowAdapter: CrossShardColonizationWorkflowTaskSystemAdapter = {
  system: SYSTEM,
  snapshot(_context: CrossShardColonizationWorkflowAdapterContext): CrossShardColonizationWorkflowAdapterResult {
    const source = readStore();
    if (source.failure) return { entries: [], invalidCount: 1, issues: [source.failure] };
    if (!source.store) return { entries: [], invalidCount: 0, issues: [] };

    const entries: CrossShardColonizationWorkflowStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    for (const [storeKey, value] of Object.entries(source.store)) {
      const entry = projectEntry(storeKey, value);
      if (entry) entries.push(entry);
      else {
        invalidCount += 1;
        appendSystemIssue(issues, issue(
          "invalid-workflow-record",
          `CrossShardColonization record ${JSON.stringify(storeKey)} lacks a provable shard-room identity`,
          storeKey,
        ));
      }
    }
    return {
      entries: sortWorkStatusViews(entries) as CrossShardColonizationWorkflowStatusView[],
      invalidCount,
      issues,
    };
  },
};

export default crossShardColonizationWorkflowAdapter;
