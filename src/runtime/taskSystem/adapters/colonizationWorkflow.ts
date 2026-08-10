import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const SYSTEM = "colonization-workflow" as const;
const NAMESPACE = "colonization";
const MAX_SYSTEM_ISSUES = 20;
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;
const STATUS_ACTIVITY = {
  claiming: "running",
  clearing: "running",
  waiting_plan: "blocked",
  bootstrapping: "running",
  managed: "running",
} as const satisfies Record<string, WorkActivity>;

type ColonizationStatus = keyof typeof STATUS_ACTIVITY;
type UnknownRecord = Record<string, unknown>;
export type ColonizationWorkflowAdapterContext = unknown;

export interface ColonizationWorkflowStatusView extends WorkStatusView {
  readonly sourceRoom: string;
  readonly targetRoom?: string;
  readonly flagName?: string;
  readonly mode?: "normal" | "npcStronghold";
  readonly planReady?: boolean;
  readonly claimCompleted?: boolean;
  readonly scoutSafe?: boolean;
  readonly scoutRouteRooms?: readonly string[];
  readonly dangerousRooms?: readonly string[];
  readonly temporaryDangerousRooms?: Readonly<Record<string, number>>;
  readonly permanentDangerousRooms?: readonly string[];
  readonly scoutedAt?: number;
  readonly planRetryAt?: number;
  readonly safeRouteRetryAt?: number;
  readonly safeRouteRetryKey?: string;
}

export interface ColonizationWorkflowAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly ColonizationWorkflowStatusView[];
}

export interface ColonizationWorkflowTaskSystemAdapter extends TaskSystemAdapter<ColonizationWorkflowAdapterContext> {
  readonly system: "colonization-workflow";
  snapshot(context: ColonizationWorkflowAdapterContext): ColonizationWorkflowAdapterResult;
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

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0));
}

function isOptionalTickRecord(value: unknown): value is Record<string, number> | undefined {
  return value === undefined
    || (isRecord(value) && Object.entries(value).every(
      ([roomName, tick]) => roomName.length > 0 && isFiniteTick(tick),
    ));
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
  const store = Object.prototype.hasOwnProperty.call(data, "colonization")
    ? data.colonization
    : undefined;
  if (store === undefined) return {};
  if (!isRecord(store)) {
    return {
      failure: issue(
        "invalid-workflow-store",
        "Memory.data.colonization is not an object record",
        "Memory.data.colonization",
      ),
    };
  }
  return { store };
}

function statusActivity(value: unknown): WorkActivity | undefined {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(STATUS_ACTIVITY, value)) {
    return undefined;
  }
  return STATUS_ACTIVITY[value as ColonizationStatus];
}

function projectEntry(storeKey: string, value: unknown): ColonizationWorkflowStatusView | null {
  if (!isRecord(value)) return null;
  const sourceRoom = value.sourceRoom;
  const targetRoom = isRoomName(value.targetRoom) ? value.targetRoom : undefined;
  const scopeTargetRoom = isRoomName(storeKey) ? storeKey : targetRoom;
  const flagName = typeof value.flagName === "string" && value.flagName.length > 0
    ? value.flagName
    : undefined;
  if (!isRoomName(sourceRoom) || !scopeTargetRoom || storeKey.length === 0) return null;

  const issues: WorkProjectionIssue[] = [];
  let activity = statusActivity(value.status);
  if (!activity) {
    issues.push(issue("unknown-domain-status", "Colonization status is unknown", "status"));
    activity = "unknown";
  }
  if (!targetRoom) {
    issues.push(issue("invalid-target-room", "targetRoom must be a Screeps room name", "targetRoom"));
    activity = "unknown";
  } else if (storeKey !== targetRoom) {
    issues.push(issue("workflow-key-mismatch", "Store key does not match targetRoom", "targetRoom"));
    activity = "unknown";
  }
  if (!flagName) {
    issues.push(issue("invalid-flag-name", "flagName must be a non-empty string", "flagName"));
    activity = "unknown";
  }
  if (typeof value.planReady !== "boolean") {
    issues.push(issue("invalid-domain-fact", "planReady must be boolean", "planReady"));
    activity = "unknown";
  }
  if (typeof value.claimCompleted !== "boolean") {
    issues.push(issue("invalid-domain-fact", "claimCompleted must be boolean", "claimCompleted"));
    activity = "unknown";
  }
  if (value.scoutSafe !== undefined && typeof value.scoutSafe !== "boolean") {
    issues.push(issue("invalid-domain-fact", "scoutSafe must be boolean when present", "scoutSafe"));
    activity = "unknown";
  }
  if (!isFiniteTick(value.createdAt)) {
    issues.push(issue("invalid-timestamp", "createdAt must be a finite non-negative number", "createdAt"));
    activity = "unknown";
  }
  if (!isFiniteTick(value.updatedAt)) {
    issues.push(issue("invalid-timestamp", "updatedAt must be a finite non-negative number", "updatedAt"));
    activity = "unknown";
  }
  for (const field of ["scoutedAt", "planRetryAt", "safeRouteRetryAt"] as const) {
    if (!isOptionalFiniteTick(value[field])) {
      issues.push(issue("invalid-timestamp", `${field} must be a finite non-negative number`, field));
      activity = "unknown";
    }
  }
  for (const field of ["scoutRouteRooms", "dangerousRooms", "permanentDangerousRooms"] as const) {
    if (!isOptionalStringArray(value[field])) {
      issues.push(issue("invalid-domain-array", `${field} must be an array of non-empty strings`, field));
      activity = "unknown";
    }
  }
  if (!isOptionalTickRecord(value.temporaryDangerousRooms)) {
    issues.push(issue(
      "invalid-domain-record",
      "temporaryDangerousRooms must map room names to finite non-negative ticks",
      "temporaryDangerousRooms",
    ));
    activity = "unknown";
  }
  if (value.safeRouteRetryKey !== undefined && typeof value.safeRouteRetryKey !== "string") {
    issues.push(issue(
      "invalid-domain-fact",
      "safeRouteRetryKey must be a string when present",
      "safeRouteRetryKey",
    ));
    activity = "unknown";
  }
  if (
    value.mode !== undefined
    && value.mode !== "normal"
    && value.mode !== "npcStronghold"
  ) {
    issues.push(issue("invalid-domain-mode", "mode must be normal or npcStronghold", "mode"));
    activity = "unknown";
  }
  if (
    isFiniteTick(value.createdAt)
    && isFiniteTick(value.updatedAt)
    && value.updatedAt < value.createdAt
  ) {
    issues.push(issue("timestamp-conflict", "updatedAt precedes createdAt", "updatedAt"));
    activity = "unknown";
  }

  const planRetryAt = isFiniteTick(value.planRetryAt) ? value.planRetryAt : undefined;
  const safeRouteRetryAt = isFiniteTick(value.safeRouteRetryAt) ? value.safeRouteRetryAt : undefined;
  let retryAt: number | undefined;
  if (planRetryAt !== undefined && safeRouteRetryAt !== undefined) {
    issues.push(issue(
      "multiple-domain-retries",
      `workflow retains independent planRetryAt=${planRetryAt} and safeRouteRetryAt=${safeRouteRetryAt}; no single retryAt is inferred`,
      "retryAt",
    ));
  } else {
    retryAt = planRetryAt ?? safeRouteRetryAt;
  }

  const authorities: WorkAuthorityRef[] = [];
  if (flagName) authorities.push({ role: "producer", id: flagName, component: "flag" });
  authorities.push({ role: "workflow_owner", id: sourceRoom, component: "source-room" });
  const sourceState = typeof value.status === "string" ? value.status : "unknown";
  if (
    sourceState === "waiting_plan"
    && (value.claimCompleted !== true || value.planReady !== false)
  ) {
    issues.push(issue(
      "colonization-state-fact-conflict",
      "waiting_plan workflow requires claimCompleted=true and planReady=false",
      "status",
    ));
    activity = "unknown";
  }
  if (
    sourceState === "bootstrapping"
    && (value.claimCompleted !== true || value.planReady !== true)
  ) {
    issues.push(issue(
      "colonization-state-fact-conflict",
      "bootstrapping workflow requires claimCompleted=true and planReady=true",
      "status",
    ));
    activity = "unknown";
  }
  // managed writer 只更新 status；既有/已建成房间可能保留任意合法布尔组合，
  // 因此这里刻意不把 planReady/claimCompleted 的值推断成 managed 前置条件。

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
    createdAt: isFiniteTick(value.createdAt) ? value.createdAt : undefined,
    updatedAt: isFiniteTick(value.updatedAt) ? value.updatedAt : undefined,
    lastProgressAt: isFiniteTick(value.scoutedAt) ? value.scoutedAt : undefined,
    blocker: sourceState === "waiting_plan" ? "waiting_plan" : undefined,
    retryAt,
    issues,
    sourceRoom,
    targetRoom,
    flagName,
    mode: value.mode === "normal" || value.mode === "npcStronghold" ? value.mode : undefined,
    planReady: typeof value.planReady === "boolean" ? value.planReady : undefined,
    claimCompleted: typeof value.claimCompleted === "boolean" ? value.claimCompleted : undefined,
    scoutSafe: typeof value.scoutSafe === "boolean" ? value.scoutSafe : undefined,
    scoutRouteRooms: isOptionalStringArray(value.scoutRouteRooms) && value.scoutRouteRooms
      ? [...value.scoutRouteRooms]
      : undefined,
    dangerousRooms: isOptionalStringArray(value.dangerousRooms) && value.dangerousRooms
      ? [...value.dangerousRooms]
      : undefined,
    temporaryDangerousRooms: isOptionalTickRecord(value.temporaryDangerousRooms)
      && value.temporaryDangerousRooms
      ? { ...value.temporaryDangerousRooms }
      : undefined,
    permanentDangerousRooms: isOptionalStringArray(value.permanentDangerousRooms)
      && value.permanentDangerousRooms
      ? [...value.permanentDangerousRooms]
      : undefined,
    scoutedAt: isFiniteTick(value.scoutedAt) ? value.scoutedAt : undefined,
    planRetryAt,
    safeRouteRetryAt,
    safeRouteRetryKey: typeof value.safeRouteRetryKey === "string" ? value.safeRouteRetryKey : undefined,
  };
}

export const colonizationWorkflowAdapter: ColonizationWorkflowTaskSystemAdapter = {
  system: SYSTEM,
  snapshot(_context: ColonizationWorkflowAdapterContext): ColonizationWorkflowAdapterResult {
    const source = readStore();
    if (source.failure) return { entries: [], invalidCount: 1, issues: [source.failure] };
    if (!source.store) return { entries: [], invalidCount: 0, issues: [] };

    const entries: ColonizationWorkflowStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    for (const [storeKey, value] of Object.entries(source.store)) {
      const entry = projectEntry(storeKey, value);
      if (entry) entries.push(entry);
      else {
        invalidCount += 1;
        appendSystemIssue(issues, issue(
          "invalid-workflow-record",
          `Colonization record ${JSON.stringify(storeKey)} lacks a provable flag and cross-room identity`,
          storeKey,
        ));
      }
    }
    return {
      entries: sortWorkStatusViews(entries) as ColonizationWorkflowStatusView[],
      invalidCount,
      issues,
    };
  },
};

export default colonizationWorkflowAdapter;
