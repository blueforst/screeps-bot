import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const SYSTEM = "rescue-workflow" as const;
const NAMESPACE = "rescue";
const MAX_SYSTEM_ISSUES = 20;
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;
const STATUS_ACTIVITY = {
  bootstrapping: "running",
  managed: "running",
} as const satisfies Record<string, WorkActivity>;

type RescueStatus = keyof typeof STATUS_ACTIVITY;
type UnknownRecord = Record<string, unknown>;
export type RescueWorkflowAdapterContext = unknown;

export interface RescueWorkflowStatusView extends WorkStatusView {
  readonly sourceRoom: string;
  readonly targetRoom?: string;
  readonly flagName?: string;
  readonly routeRooms?: readonly string[];
}

export interface RescueWorkflowAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly RescueWorkflowStatusView[];
}

export interface RescueWorkflowTaskSystemAdapter extends TaskSystemAdapter<RescueWorkflowAdapterContext> {
  readonly system: "rescue-workflow";
  snapshot(context: RescueWorkflowAdapterContext): RescueWorkflowAdapterResult;
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
  const store = Object.prototype.hasOwnProperty.call(data, "rescue")
    ? data.rescue
    : undefined;
  if (store === undefined) return {};
  if (!isRecord(store)) {
    return {
      failure: issue("invalid-workflow-store", "Memory.data.rescue is not an object record", "Memory.data.rescue"),
    };
  }
  return { store };
}

function statusActivity(value: unknown): WorkActivity | undefined {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(STATUS_ACTIVITY, value)) {
    return undefined;
  }
  return STATUS_ACTIVITY[value as RescueStatus];
}

function projectEntry(storeKey: string, value: unknown): RescueWorkflowStatusView | null {
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
    issues.push(issue("unknown-domain-status", "Rescue status is unknown", "status"));
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
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (!isFiniteTick(value[field])) {
      issues.push(issue("invalid-timestamp", `${field} must be a finite non-negative number`, field));
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
  if (
    value.routeRooms !== undefined
    && (!Array.isArray(value.routeRooms)
      || !value.routeRooms.every((roomName) => isRoomName(roomName)))
  ) {
    issues.push(issue("invalid-domain-array", "routeRooms must be an array of non-empty strings", "routeRooms"));
    activity = "unknown";
  }

  const authorities: WorkAuthorityRef[] = [];
  if (flagName) authorities.push({ role: "producer", id: flagName, component: "flag" });
  authorities.push({ role: "workflow_owner", id: sourceRoom, component: "source-room" });

  return {
    ref: {
      system: SYSTEM,
      namespace: NAMESPACE,
      scope: { kind: "cross_room", fromRoomName: sourceRoom, toRoomName: scopeTargetRoom },
      localId: storeKey,
    },
    activity,
    sourceState: typeof value.status === "string" ? value.status : "unknown",
    authorities,
    createdAt: isFiniteTick(value.createdAt) ? value.createdAt : undefined,
    updatedAt: isFiniteTick(value.updatedAt) ? value.updatedAt : undefined,
    issues,
    sourceRoom,
    targetRoom,
    flagName,
    routeRooms: Array.isArray(value.routeRooms) && value.routeRooms.every((roomName) => isRoomName(roomName))
      ? [...value.routeRooms]
      : undefined,
  };
}

export const rescueWorkflowAdapter: RescueWorkflowTaskSystemAdapter = {
  system: SYSTEM,
  snapshot(_context: RescueWorkflowAdapterContext): RescueWorkflowAdapterResult {
    const source = readStore();
    if (source.failure) return { entries: [], invalidCount: 1, issues: [source.failure] };
    if (!source.store) return { entries: [], invalidCount: 0, issues: [] };

    const entries: RescueWorkflowStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    for (const [storeKey, value] of Object.entries(source.store)) {
      const entry = projectEntry(storeKey, value);
      if (entry) entries.push(entry);
      else {
        invalidCount += 1;
        appendSystemIssue(issues, issue(
          "invalid-workflow-record",
          `Rescue record ${JSON.stringify(storeKey)} lacks a provable flag and cross-room identity`,
          storeKey,
        ));
      }
    }
    return {
      entries: sortWorkStatusViews(entries) as RescueWorkflowStatusView[],
      invalidCount,
      issues,
    };
  },
};

export default rescueWorkflowAdapter;
