import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const SYSTEM = "flag-hauling-workflow" as const;
const NAMESPACE = "flagHauling";
const MAX_SYSTEM_ISSUES = 20;
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;
type UnknownRecord = Record<string, unknown>;
export type FlagHaulingWorkflowAdapterContext = unknown;

export interface FlagHaulingWorkflowStatusView extends WorkStatusView {
  readonly sourceRoom: string;
  readonly targetRoom: string;
  readonly flagName?: string;
  readonly targetX?: number;
  readonly targetY?: number;
}

export interface FlagHaulingWorkflowAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly FlagHaulingWorkflowStatusView[];
}

export interface FlagHaulingWorkflowTaskSystemAdapter extends TaskSystemAdapter<FlagHaulingWorkflowAdapterContext> {
  readonly system: "flag-hauling-workflow";
  snapshot(context: FlagHaulingWorkflowAdapterContext): FlagHaulingWorkflowAdapterResult;
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

function isRoomCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 49;
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
  const store = Object.prototype.hasOwnProperty.call(data, "flagHauling")
    ? data.flagHauling
    : undefined;
  if (store === undefined) return {};
  if (!isRecord(store)) {
    return {
      failure: issue(
        "invalid-workflow-store",
        "Memory.data.flagHauling is not an object record",
        "Memory.data.flagHauling",
      ),
    };
  }
  return { store };
}

function projectEntry(storeKey: string, value: unknown): FlagHaulingWorkflowStatusView | null {
  if (!isRecord(value)) return null;
  const sourceRoom = value.sourceRoom;
  const targetRoom = value.targetRoom;
  const flagName = typeof value.flagName === "string" && value.flagName.length > 0
    ? value.flagName
    : undefined;
  if (!isRoomName(sourceRoom) || !isRoomName(targetRoom) || storeKey.length === 0) return null;

  const issues: WorkProjectionIssue[] = [];
  let activity: WorkStatusView["activity"] = "running";
  if (!flagName) {
    issues.push(issue("invalid-flag-name", "flagName must be a non-empty string", "flagName"));
    activity = "unknown";
  } else if (storeKey !== flagName) {
    issues.push(issue("workflow-key-mismatch", "Store key does not match flagName", "flagName"));
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
  for (const field of ["targetX", "targetY"] as const) {
    if (!isRoomCoordinate(value[field])) {
      issues.push(issue("invalid-room-coordinate", `${field} must be an integer from 0 through 49`, field));
      activity = "unknown";
    }
  }

  const authorities: WorkAuthorityRef[] = [];
  if (flagName) authorities.push({ role: "producer", id: flagName, component: "flag" });
  authorities.push({ role: "workflow_owner", id: sourceRoom, component: "source-room" });
  return {
    ref: {
      system: SYSTEM,
      namespace: NAMESPACE,
      scope: { kind: "cross_room", fromRoomName: sourceRoom, toRoomName: targetRoom },
      localId: storeKey,
    },
    activity,
    sourceState: "present",
    authorities,
    createdAt: isFiniteTick(value.createdAt) ? value.createdAt : undefined,
    updatedAt: isFiniteTick(value.updatedAt) ? value.updatedAt : undefined,
    issues,
    sourceRoom,
    targetRoom,
    flagName,
    targetX: isRoomCoordinate(value.targetX) ? value.targetX : undefined,
    targetY: isRoomCoordinate(value.targetY) ? value.targetY : undefined,
  };
}

export const flagHaulingWorkflowAdapter: FlagHaulingWorkflowTaskSystemAdapter = {
  system: SYSTEM,
  snapshot(_context: FlagHaulingWorkflowAdapterContext): FlagHaulingWorkflowAdapterResult {
    const source = readStore();
    if (source.failure) return { entries: [], invalidCount: 1, issues: [source.failure] };
    if (!source.store) return { entries: [], invalidCount: 0, issues: [] };

    const entries: FlagHaulingWorkflowStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;
    for (const [storeKey, value] of Object.entries(source.store)) {
      const entry = projectEntry(storeKey, value);
      if (entry) entries.push(entry);
      else {
        invalidCount += 1;
        appendSystemIssue(issues, issue(
          "invalid-workflow-record",
          `FlagHauling record ${JSON.stringify(storeKey)} lacks a provable flag and cross-room identity`,
          storeKey,
        ));
      }
    }
    return {
      entries: sortWorkStatusViews(entries) as FlagHaulingWorkflowStatusView[],
      invalidCount,
      issues,
    };
  },
};

export default flagHaulingWorkflowAdapter;
