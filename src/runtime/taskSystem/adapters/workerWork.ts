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
  readonly records: ReadonlyMap<string, IndexedWorkerAssignment>;
  readonly refToCreeps: ReadonlyMap<string, readonly string[]>;
  readonly legacyTaskToCreeps: ReadonlyMap<string, readonly string[]>;
  readonly valid: boolean;
  readonly invalidCount: number;
  readonly issues: readonly WorkProjectionIssue[];
}

interface WorkerAssignmentRef {
  readonly roomName: string;
  readonly localId: string;
}

interface IndexedWorkerAssignment {
  readonly creepName: string;
  readonly taskId?: string;
  readonly ref?: WorkerAssignmentRef;
  readonly bindingIssue?: WorkProjectionIssue;
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
const WORKER_ROOM_NAME_PATTERN = /^(?:[WE]\d+[NS]\d+|sim)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record: Record<string, unknown>, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return undefined;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidWorkerRoomName(value: unknown): value is string {
  return typeof value === "string" && WORKER_ROOM_NAME_PATTERN.test(value);
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
    if (!isValidWorkerRoomName(roomName)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-room-name-invalid",
        message: "Worker task board contains an invalid room scope.",
        field: "board",
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

function workerRefKey(roomName: string, localId: string): string {
  return JSON.stringify([roomName, localId]);
}

function parseWorkerAssignmentRef(
  state: Record<string, unknown>,
  taskId: string | undefined,
): { readonly ref?: WorkerAssignmentRef; readonly issue?: WorkProjectionIssue } {
  const bindings = ownValue(state, "dispatchBindings");
  if (bindings === undefined) {
    return taskId === undefined
      ? {}
      : {
        issue: {
          code: "worker-assignment-canonical-missing",
          message: "Worker assignment has only the legacy taskId mirror and no canonical dispatch ref.",
          field: "dispatchBindings.worker",
        },
      };
  }
  if (!isRecord(bindings)) {
    return {
      issue: {
        code: "worker-assignment-bindings-malformed",
        message: "Worker assignment dispatchBindings must be a record.",
        field: "dispatchBindings",
      },
    };
  }

  const binding = ownValue(bindings, "worker");
  if (binding === undefined) {
    return taskId === undefined
      ? {}
      : {
        issue: {
          code: "worker-assignment-canonical-missing",
          message: "Worker assignment has only the legacy taskId mirror and no canonical Worker ref.",
          field: "dispatchBindings.worker",
        },
      };
  }
  if (!isRecord(binding)) {
    return {
      issue: {
        code: "worker-assignment-binding-malformed",
        message: "Worker canonical dispatch binding must be a record.",
        field: "dispatchBindings.worker",
      },
    };
  }

  const system = ownValue(binding, "system");
  const namespace = ownValue(binding, "namespace");
  const scope = ownValue(binding, "scope");
  const localId = ownValue(binding, "localId");
  if (
    system !== "worker-work"
    || namespace !== NAMESPACE
    || !isRecord(scope)
    || ownValue(scope, "kind") !== "room"
    || !isValidWorkerRoomName(ownValue(scope, "roomName"))
    || !isNonEmptyString(localId)
  ) {
    return {
      issue: {
        code: "worker-assignment-binding-invalid",
        message: "Worker canonical dispatch binding has an invalid system, namespace, scope, or local id.",
        field: "dispatchBindings.worker",
      },
    };
  }

  const ref = {
    roomName: ownValue(scope, "roomName") as string,
    localId,
  };
  if (taskId === undefined || taskId !== localId) {
    return {
      ref,
      issue: {
        code: "worker-assignment-mirror-drift",
        message: "Worker legacy taskId mirror does not match the canonical dispatch ref local id.",
        field: "taskId",
      },
    };
  }

  return { ref };
}

function indexAssignments(assignments: unknown): AssignmentIndex {
  if (!isRecord(assignments)) {
    return {
      records: new Map(),
      refToCreeps: new Map(),
      legacyTaskToCreeps: new Map(),
      valid: false,
      invalidCount: 1,
      issues: [{
        code: "worker-assignments-malformed",
        message: "Worker assignment snapshot must be a record keyed by creep name.",
        field: "assignments",
      }],
    };
  }

  const records = new Map<string, IndexedWorkerAssignment>();
  const mutableRefIndex = new Map<string, string[]>();
  const mutableLegacyIndex = new Map<string, string[]>();
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

    const rawTaskId = ownValue(state, "taskId");
    if (rawTaskId !== undefined && !isNonEmptyString(rawTaskId)) {
      invalidCount += 1;
      appendSystemIssue(issues, {
        code: "worker-assignment-task-id-invalid",
        message: `Worker assignment for ${creepName} has an invalid task id.`,
        field: "taskId",
      });
      continue;
    }
    const taskId = isNonEmptyString(rawTaskId) ? rawTaskId : undefined;

    const parsed = parseWorkerAssignmentRef(state, taskId);
    const record: IndexedWorkerAssignment = {
      creepName,
      ...(taskId === undefined ? {} : { taskId }),
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      ...(parsed.issue ? { bindingIssue: parsed.issue } : {}),
    };
    records.set(creepName, record);

    if (parsed.ref) {
      const key = workerRefKey(parsed.ref.roomName, parsed.ref.localId);
      const creeps = mutableRefIndex.get(key) || [];
      creeps.push(creepName);
      mutableRefIndex.set(key, creeps);
    } else if (taskId !== undefined) {
      const creeps = mutableLegacyIndex.get(taskId) || [];
      creeps.push(creepName);
      mutableLegacyIndex.set(taskId, creeps);
    }
  }

  const refToCreeps = new Map<string, readonly string[]>();
  for (const [refKey, creepNames] of mutableRefIndex) {
    refToCreeps.set(refKey, [...creepNames].sort());
  }
  const legacyTaskToCreeps = new Map<string, readonly string[]>();
  for (const [taskId, creepNames] of mutableLegacyIndex) {
    legacyTaskToCreeps.set(taskId, [...creepNames].sort());
  }

  return {
    records,
    refToCreeps,
    legacyTaskToCreeps,
    valid: invalidCount === 0,
    invalidCount,
    issues,
  };
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
  if (!isValidWorkerRoomName(sourceRoomName)) {
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
      message: "Worker task has more listed assignees than its current slot capacity; sticky claims remain valid.",
      field: "assignedCreeps",
    });
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
  const candidateRefKey = workerRefKey(candidate.roomName, candidate.localId);
  const reverseNames = new Set(assignmentIndex.refToCreeps.get(candidateRefKey) || []);
  const confirmedAssignees: string[] = [];
  let claimEvidenceComplete = assignmentIndex.valid;

  if (!assignmentIndex.valid) {
    appendEntryIssue(issues, {
      code: "worker-assignment-evidence-malformed",
      message: "Worker assignment snapshot contains malformed records, so claim closure cannot be proven.",
      field: "assignments",
    });
  } else {
    const legacyNames = assignmentIndex.legacyTaskToCreeps.get(candidate.localId) || [];
    const legacyIdentityAmbiguous = taskIdCount > 1 && legacyNames.length > 0;
    if (legacyIdentityAmbiguous) {
      appendEntryIssue(issues, {
        code: "worker-assignment-identity-ambiguous",
        message: `${legacyNames.length} legacy Worker assignment(s) match ${taskIdCount} room-scoped tasks with local id ${candidate.localId}.`,
        field: "taskId",
      });
      claimEvidenceComplete = false;
    }
    const candidateAssignees = new Set([
      ...listed.names,
      ...reverseNames,
      ...(legacyIdentityAmbiguous ? [] : legacyNames),
    ]);
    for (const creepName of [...candidateAssignees].sort()) {
      const assignment = assignmentIndex.records.get(creepName);
      const hasExactBinding = assignment?.ref?.roomName === candidate.roomName
        && assignment.ref.localId === candidate.localId;
      const bindingValid = hasExactBinding && assignment?.bindingIssue === undefined;

      if (listed.names.has(creepName) && bindingValid) {
        confirmedAssignees.push(creepName);
        continue;
      }

      if (
        legacyIdentityAmbiguous
        && assignment?.taskId === candidate.localId
        && !assignment.ref
      ) {
        continue;
      }

      if (listed.names.has(creepName) && assignment?.bindingIssue) {
        appendEntryIssue(issues, {
          ...assignment.bindingIssue,
          message: `${assignment.bindingIssue.message} Actor: ${creepName}.`,
        });
      } else {
        appendEntryIssue(issues, {
          code: "worker-assignment-drift",
          message: listed.names.has(creepName)
            ? `Worker task lists ${creepName}, but its canonical reverse assignment does not reference this exact task.`
            : `Worker canonical assignment for ${creepName} references this task, but the task does not list that creep.`,
          field: "assignedCreeps",
        });
      }
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

    const candidateRefKeys = new Set(collected.candidates.map((candidate) =>
      workerRefKey(candidate.roomName, candidate.localId),
    ));
    for (const [refKey, creepNames] of [...assignmentIndex.refToCreeps.entries()].sort(
      ([left], [right]) => compareText(left, right),
    )) {
      if (candidateRefKeys.has(refKey)) {
        continue;
      }
      for (const creepName of creepNames) {
        const assignment = assignmentIndex.records.get(creepName);
        appendSystemIssue(issues, {
          code: "worker-assignment-orphan",
          message: `Worker canonical assignment for ${creepName} references a missing exact task ${assignment?.ref?.localId || "unknown"}.`,
          field: "dispatchBindings.worker",
        });
      }
    }

    for (const [taskId, creepNames] of [...assignmentIndex.legacyTaskToCreeps.entries()].sort(
      ([left], [right]) => compareText(left, right),
    )) {
      if (collected.taskIdCounts.has(taskId)) {
        continue;
      }
      for (const creepName of creepNames) {
        appendSystemIssue(issues, {
          code: "worker-assignment-orphan",
          message: `Worker legacy assignment for ${creepName} references missing task ${taskId}.`,
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
