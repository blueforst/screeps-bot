import type { CreepAssignmentStateStoreSnapshot } from "@/runtime/creepAssignmentState";
import { TASK_SYSTEM_CATALOG } from "@/runtime/taskSystem/catalog";
import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";
import type { WorkerTaskBoardSnapshot } from "@/runtime/workerTaskPool";

export interface WorkerWorkAdapterContext {
  readonly board: WorkerTaskBoardSnapshot;
  readonly assignments: CreepAssignmentStateStoreSnapshot;
}

interface WorkerTaskCandidate {
  readonly roomName: string;
  readonly localId: string;
  readonly value: unknown;
}

interface AssignmentIndex {
  readonly taskToCreeps: ReadonlyMap<string, readonly string[]>;
  readonly valid: boolean;
  readonly invalidCount: number;
  readonly issues: readonly WorkProjectionIssue[];
}

const NAMESPACE = TASK_SYSTEM_CATALOG["worker-work"].domainOwner;
const MAX_ENTRY_ISSUES = 20;
const MAX_SYSTEM_ISSUES = 20;
const WORKER_TASK_TYPES: ReadonlySet<string> = new Set([
  "build",
  "upgrade",
  "repair",
  "dismantle",
]);
const WORKER_TASK_STATUSES: ReadonlySet<string> = new Set(["active", "done"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, field)
    ? record[field]
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeTick(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareIssues(
  left: WorkProjectionIssue,
  right: WorkProjectionIssue,
): number {
  return compareText(left.code, right.code)
    || compareText(left.field || "", right.field || "")
    || compareText(left.message, right.message);
}

function appendIssue(
  issues: WorkProjectionIssue[],
  issue: WorkProjectionIssue,
  limit: number,
): void {
  if (issues.length < limit) {
    issues.push({ ...issue });
  }
}

function appendSystemIssue(
  issues: WorkProjectionIssue[],
  issue: WorkProjectionIssue,
): void {
  appendIssue(issues, issue, MAX_SYSTEM_ISSUES);
}

function appendEntryIssue(
  issues: WorkProjectionIssue[],
  issue: WorkProjectionIssue,
): void {
  appendIssue(issues, issue, MAX_ENTRY_ISSUES);
}

function collectTaskCandidates(
  board: unknown,
): {
  readonly candidates: readonly WorkerTaskCandidate[];
  readonly taskIdCounts: ReadonlyMap<string, number>;
  readonly invalidCount: number;
  readonly issues: readonly WorkProjectionIssue[];
} | null {
  if (!isRecord(board)) {
    return null;
  }

  const candidates: WorkerTaskCandidate[] = [];
  const taskIdCounts = new Map<string, number>();
  const issues: WorkProjectionIssue[] = [];
  let invalidCount = 0;

  for (const roomName of Object.keys(board).sort(compareText)) {
    if (!isNonEmptyString(roomName)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-room-name-invalid",
        message: "Worker task board contains an empty room scope.",
        field: "board",
      });
      continue;
    }

    const roomStore = ownValue(board, roomName);
    if (!isRecord(roomStore)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-room-store-malformed",
        message: `Worker task room ${roomName} is not a record keyed by task id.`,
        field: roomName,
      });
      continue;
    }

    for (const localId of Object.keys(roomStore).sort(compareText)) {
      if (!isNonEmptyString(localId)) {
        invalidCount += 1;
        appendSystemIssue(issues, {
          code: "worker-task-store-id-invalid",
          message: `Worker task room ${roomName} contains an empty task id.`,
          field: roomName,
        });
        continue;
      }

      candidates.push({ roomName, localId, value: ownValue(roomStore, localId) });
      taskIdCounts.set(localId, (taskIdCounts.get(localId) || 0) + 1);
    }
  }

  return { candidates, taskIdCounts, invalidCount, issues };
}

function indexAssignments(assignments: unknown): AssignmentIndex {
  if (!isRecord(assignments)) {
    return {
      taskToCreeps: new Map(),
      valid: false,
      invalidCount: 1,
      issues: [{
        code: "worker-assignments-malformed",
        message: "Worker assignment snapshot must be a record keyed by creep name.",
        field: "assignments",
      }],
    };
  }

  const mutableIndex = new Map<string, string[]>();
  const issues: WorkProjectionIssue[] = [];
  let invalidCount = 0;

  for (const creepName of Object.keys(assignments).sort(compareText)) {
    if (!isNonEmptyString(creepName)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-assignment-creep-id-invalid",
        message: "Worker assignment snapshot contains an empty creep name.",
        field: "assignments",
      });
      continue;
    }

    const state = ownValue(assignments, creepName);
    if (!isRecord(state)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-assignment-record-malformed",
        message: `Worker assignment for ${creepName} is not an object.`,
        field: creepName,
      });
      continue;
    }

    const taskId = ownValue(state, "taskId");
    if (taskId === undefined) {
      continue;
    }
    if (!isNonEmptyString(taskId)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-assignment-task-id-invalid",
        message: `Worker assignment for ${creepName} has an invalid task id.`,
        field: "taskId",
      });
      continue;
    }

    const creeps = mutableIndex.get(taskId) || [];
    creeps.push(creepName);
    mutableIndex.set(taskId, creeps);
  }

  const taskToCreeps = new Map<string, readonly string[]>();
  for (const [taskId, creepNames] of mutableIndex) {
    taskToCreeps.set(taskId, [...creepNames].sort());
  }

  return { taskToCreeps, valid: invalidCount === 0, invalidCount, issues };
}

function validateRequiredTaskFields(
  task: Record<string, unknown>,
  candidate: WorkerTaskCandidate,
  issues: WorkProjectionIssue[],
): boolean {
  let valid = true;
  const invalidate = (issue: WorkProjectionIssue): void => {
    appendEntryIssue(issues, issue);
    valid = false;
  };
  const sourceId = ownValue(task, "id");
  if (!isNonEmptyString(sourceId)) {
    invalidate({
      code: "worker-task-id-invalid",
      message: "Worker task is missing its source id; the store key is used only for observation.",
      field: "id",
    });
  } else if (sourceId !== candidate.localId) {
    invalidate({
      code: "worker-task-id-mismatch",
      message: "Worker task source id does not match its room-store key.",
      field: "id",
    });
  }

  const sourceRoomName = ownValue(task, "roomName");
  if (!isNonEmptyString(sourceRoomName)) {
    invalidate({
      code: "worker-task-room-invalid",
      message: "Worker task is missing its source room name.",
      field: "roomName",
    });
  } else if (sourceRoomName !== candidate.roomName) {
    invalidate({
      code: "worker-task-room-mismatch",
      message: "Worker task source room does not match its board room scope.",
      field: "roomName",
    });
  }

  const type = ownValue(task, "type");
  if (!isNonEmptyString(type) || !WORKER_TASK_TYPES.has(type)) {
    invalidate({
      code: "worker-task-type-invalid",
      message: "Worker task has an unknown or missing task type.",
      field: "type",
    });
  }

  if (!isNonEmptyString(ownValue(task, "targetId"))) {
    invalidate({
      code: "worker-task-target-invalid",
      message: "Worker task has a missing or invalid target id.",
      field: "targetId",
    });
  }

  if (!isFiniteNonNegativeNumber(ownValue(task, "priority"))) {
    invalidate({
      code: "worker-task-priority-invalid",
      message: "Worker task has a missing or invalid priority.",
      field: "priority",
    });
  }

  const maxAssignees = ownValue(task, "maxAssignees");
  if (!Number.isInteger(maxAssignees) || (maxAssignees as number) < 1) {
    invalidate({
      code: "worker-task-capacity-invalid",
      message: "Worker task has a missing or invalid assignee capacity.",
      field: "maxAssignees",
    });
  }

  const updatedAt = ownValue(task, "updatedAt");
  if (!isNonNegativeTick(updatedAt)) {
    invalidate({
      code: "worker-task-updated-at-invalid",
      message: "Worker task has a missing or invalid update tick.",
      field: "updatedAt",
    });
  }

  const requiredWork = ownValue(task, "requiredWork");
  if (requiredWork !== undefined && !isFiniteNonNegativeNumber(requiredWork)) {
    invalidate({
      code: "worker-task-required-work-invalid",
      message: "Worker task has an invalid required work amount.",
      field: "requiredWork",
    });
  }

  const repairTargetHits = ownValue(task, "repairTargetHits");
  if (repairTargetHits !== undefined && !isFiniteNonNegativeNumber(repairTargetHits)) {
    invalidate({
      code: "worker-task-repair-target-hits-invalid",
      message: "Worker task has an invalid repair target hit amount.",
      field: "repairTargetHits",
    });
  }

  const repairMode = ownValue(task, "repairMode");
  if (repairMode !== undefined && repairMode !== "normal" && repairMode !== "emergency") {
    invalidate({
      code: "worker-task-repair-mode-invalid",
      message: "Worker task has an unknown repair mode.",
      field: "repairMode",
    });
  }

  const status = ownValue(task, "status");
  if (!isNonEmptyString(status) || !WORKER_TASK_STATUSES.has(status)) {
    invalidate({
      code: "worker-task-status-invalid",
      message: "Worker task has an unknown or missing source status.",
      field: "status",
    });
  }

  return valid;
}

function readListedAssignees(
  task: Record<string, unknown>,
  issues: WorkProjectionIssue[],
): { readonly names: ReadonlySet<string>; readonly valid: boolean } {
  const rawAssignees = ownValue(task, "assignedCreeps");
  if (!Array.isArray(rawAssignees)) {
    appendEntryIssue(issues, {
      code: "worker-task-assignees-invalid",
      message: "Worker task assignedCreeps must be an array of creep names.",
      field: "assignedCreeps",
    });
    return { names: new Set(), valid: false };
  }

  const names = new Set<string>();
  let valid = true;
  for (const assignee of rawAssignees) {
    if (!isNonEmptyString(assignee)) {
      appendEntryIssue(issues, {
        code: "worker-task-assignee-invalid",
        message: "Worker task assignedCreeps contains an invalid creep name.",
        field: "assignedCreeps",
      });
      valid = false;
      continue;
    }
    if (names.has(assignee)) {
      appendEntryIssue(issues, {
        code: "worker-task-assignee-duplicate",
        message: `Worker task lists assignee ${assignee} more than once.`,
        field: "assignedCreeps",
      });
      valid = false;
      continue;
    }
    names.add(assignee);
  }

  const maxAssignees = ownValue(task, "maxAssignees");
  if (Number.isInteger(maxAssignees) && (maxAssignees as number) >= 1 && names.size > (maxAssignees as number)) {
    appendEntryIssue(issues, {
      code: "worker-task-assignee-capacity-conflict",
      message: "Worker task has more listed assignees than its slot capacity.",
      field: "assignedCreeps",
    });
    valid = false;
  }

  return { names, valid };
}

function projectCandidate(
  candidate: WorkerTaskCandidate,
  assignmentIndex: AssignmentIndex,
  taskIdCount: number,
): WorkStatusView {
  const issues: WorkProjectionIssue[] = [];
  const producerAuthority = { role: "producer" as const, id: NAMESPACE };

  if (!isRecord(candidate.value)) {
    appendEntryIssue(issues, {
      code: "worker-task-record-malformed",
      message: `Worker task ${candidate.localId} is not an object.`,
      field: candidate.localId,
    });
    return {
      ref: {
        system: "worker-work",
        namespace: NAMESPACE,
        scope: { kind: "room", roomName: candidate.roomName },
        localId: candidate.localId,
      },
      activity: "unknown",
      sourceState: "unknown",
      authorities: [producerAuthority],
      issues: issues.sort(compareIssues).map((issue) => ({ ...issue })),
    };
  }

  const task = candidate.value;
  const taskFieldsValid = validateRequiredTaskFields(task, candidate, issues);
  const listed = readListedAssignees(task, issues);
  const reverseNames = new Set(assignmentIndex.taskToCreeps.get(candidate.localId) || []);
  const confirmedAssignees: string[] = [];
  let claimEvidenceComplete = assignmentIndex.valid;

  if (!assignmentIndex.valid) {
    appendEntryIssue(issues, {
      code: "worker-assignment-evidence-malformed",
      message: "Worker assignment snapshot contains malformed records, so claim closure cannot be proven.",
      field: "assignments",
    });
  } else if (taskIdCount > 1 && (listed.names.size > 0 || reverseNames.size > 0)) {
    appendEntryIssue(issues, {
      code: "worker-assignment-identity-ambiguous",
      message: "Worker assignment task id matches more than one room-scoped task.",
      field: "taskId",
    });
    claimEvidenceComplete = false;
  } else {
    const candidateAssignees = new Set([...listed.names, ...reverseNames]);
    for (const creepName of [...candidateAssignees].sort()) {
      if (listed.names.has(creepName) && reverseNames.has(creepName)) {
        confirmedAssignees.push(creepName);
        continue;
      }

      appendEntryIssue(issues, {
        code: "worker-assignment-drift",
        message: listed.names.has(creepName)
          ? `Worker task lists ${creepName}, but its reverse assignment does not reference this task.`
          : `Worker assignment for ${creepName} references this task, but the task does not list that creep.`,
        field: "assignedCreeps",
      });
      claimEvidenceComplete = false;
    }
  }

  const status = ownValue(task, "status");
  const sourceState = isNonEmptyString(status) ? status : "unknown";
  const projectionValid = taskFieldsValid && listed.valid;
  const claimProjectionValid = projectionValid && claimEvidenceComplete;
  let activity: WorkActivity = "unknown";
  if (projectionValid && status === "done") {
    activity = "terminal";
  } else if (claimProjectionValid && status === "active") {
    activity = confirmedAssignees.length > 0 ? "claimed" : "available";
  }

  const authorities = [
    producerAuthority,
    ...(claimProjectionValid
      ? confirmedAssignees.map((id) => ({ role: "assignee" as const, id }))
      : []),
  ];
  const updatedAt = ownValue(task, "updatedAt");

  return {
    ref: {
      system: "worker-work",
      namespace: NAMESPACE,
      scope: { kind: "room", roomName: candidate.roomName },
      localId: candidate.localId,
    },
    activity,
    sourceState,
    authorities,
    ...(isNonNegativeTick(updatedAt) ? { updatedAt } : {}),
    issues: issues.sort(compareIssues).map((issue) => ({ ...issue })),
  };
}

const workerWorkAdapter: TaskSystemAdapter<WorkerWorkAdapterContext> = {
  system: "worker-work",

  snapshot(context): TaskSystemAdapterResult {
    const rawContext: unknown = context;
    if (
      !isRecord(rawContext)
      || !Object.prototype.hasOwnProperty.call(rawContext, "board")
      || !Object.prototype.hasOwnProperty.call(rawContext, "assignments")
    ) {
      return {
        entries: [],
        invalidCount: 1,
        issues: [{
          code: "worker-context-malformed",
          message: "Worker adapter context must explicitly inject board and assignment snapshots.",
          field: "context",
        }],
      };
    }

    const collected = collectTaskCandidates(ownValue(rawContext, "board"));
    if (!collected) {
      return {
        entries: [],
        invalidCount: 1,
        issues: [{
          code: "worker-board-malformed",
          message: "Worker task board must be a record keyed by room name.",
          field: "board",
        }],
      };
    }

    const assignmentIndex = indexAssignments(ownValue(rawContext, "assignments"));
    const entries = collected.candidates.map((candidate) => projectCandidate(
      candidate,
      assignmentIndex,
      collected.taskIdCounts.get(candidate.localId) || 0,
    ));
    const issues: WorkProjectionIssue[] = [];
    for (const issue of collected.issues) appendSystemIssue(issues, issue);
    for (const issue of assignmentIndex.issues) appendSystemIssue(issues, issue);

    for (const taskId of [...assignmentIndex.taskToCreeps.keys()].sort(compareText)) {
      if (collected.taskIdCounts.has(taskId)) {
        continue;
      }
      for (const creepName of assignmentIndex.taskToCreeps.get(taskId) || []) {
        appendSystemIssue(issues, {
          code: "worker-assignment-orphan",
          message: `Worker assignment for ${creepName} references missing task ${taskId}.`,
          field: "taskId",
        });
      }
    }

    return {
      entries: sortWorkStatusViews(entries),
      invalidCount: collected.invalidCount + assignmentIndex.invalidCount,
      issues: issues.sort(compareIssues).map((issue) => ({ ...issue })),
    };
  },
};

export default workerWorkAdapter;
