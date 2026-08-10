import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const POWER_BANK_NAMESPACE = "powerBankHarvest";
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;

const POWER_BANK_STATUSES = new Set([
  "discovered",
  "preparing_boosts",
  "spawning",
  "boosting",
  "renewing",
  "travelling",
  "attacking",
  "hauling",
  "complete",
  "failed",
  "aborted",
]);

const POWER_BANK_TERMINAL_STATUSES = new Set(["complete", "failed", "aborted"]);
const POWER_BANK_SOURCE_REQUIRED_STATUSES = new Set([
  "preparing_boosts",
  "spawning",
  "boosting",
  "renewing",
  "travelling",
  "attacking",
  "hauling",
  "complete",
]);
const REINFORCEMENT_STAGES = new Set([
  "spawning",
  "renewing",
  "boosting",
  "travelling",
  "attacking",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME_PATTERN.test(value);
}

function ownValue(record: UnknownRecord, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
}

function issue(code: string, message: string, field?: string): WorkProjectionIssue {
  return field === undefined ? { code, message } : { code, message, field };
}

function optionalFiniteNumber(
  record: UnknownRecord,
  field: string,
  issues: WorkProjectionIssue[],
): { value?: number; malformed: boolean } {
  const value = ownValue(record, field);
  if (value === undefined) return { malformed: false };
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { value, malformed: false };
  }
  issues.push(issue(
    "power-bank-invalid-number",
    `${field} must be a finite non-negative number`,
    field,
  ));
  return { malformed: true };
}

function optionalGeneration(
  value: unknown,
  field: string,
  issues: WorkProjectionIssue[],
): { value?: number; malformed: boolean } {
  if (value === undefined) return { malformed: false };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { value, malformed: false };
  }
  issues.push(issue(
    "power-bank-invalid-generation",
    `${field} must be a non-negative integer`,
    field,
  ));
  return { malformed: true };
}

function optionalIndex(
  value: unknown,
  field: string,
  issues: WorkProjectionIssue[],
): { value?: number; malformed: boolean } {
  if (value === undefined) return { malformed: false };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { value, malformed: false };
  }
  issues.push(issue(
    "power-bank-invalid-index",
    `${field} must be a non-negative integer`,
    field,
  ));
  return { malformed: true };
}

function activityForStatus(status: string, blocker: string | undefined): WorkActivity {
  if (POWER_BANK_TERMINAL_STATUSES.has(status)) return "terminal";
  if (blocker) return "blocked";
  if (status === "discovered") return "available";
  if (POWER_BANK_STATUSES.has(status)) return "running";
  return "unknown";
}

interface ReinforcementProjection {
  readonly authorities: readonly WorkAuthorityRef[];
  readonly malformed: boolean;
}

function projectReinforcement(
  taskId: string,
  activeGeneration: number | undefined,
  activeIndex: number | undefined,
  value: unknown,
  issues: WorkProjectionIssue[],
): ReinforcementProjection {
  if (value === undefined) return { authorities: [], malformed: false };
  if (!isRecord(value)) {
    issues.push(issue(
      "power-bank-malformed-reinforcement",
      "reinforcement must be an object",
      "reinforcement",
    ));
    return { authorities: [], malformed: true };
  }

  let malformed = false;
  const index = ownValue(value, "index");
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    issues.push(issue(
      "power-bank-invalid-reinforcement-index",
      "reinforcement.index must be a non-negative integer",
      "reinforcement.index",
    ));
    malformed = true;
  } else if (activeIndex !== undefined && index === activeIndex) {
    issues.push(issue(
      "power-bank-reinforcement-index-conflict",
      "reinforcement.index must differ from activeIndex",
      "reinforcement.index",
    ));
    malformed = true;
  }

  const generationValue = ownValue(value, "generation");
  const generation = optionalGeneration(generationValue, "reinforcement.generation", issues);
  malformed ||= generation.malformed;
  if (generationValue === undefined) {
    issues.push(issue(
      "power-bank-legacy-reinforcement-generation-missing",
      "legacy reinforcement has no explicit generation; projection will not infer one",
      "reinforcement.generation",
    ));
  } else if (
    generation.value !== undefined
    && activeGeneration !== undefined
    && generation.value <= activeGeneration
  ) {
    issues.push(issue(
      "power-bank-reinforcement-generation-conflict",
      "reinforcement.generation must be greater than activeGeneration",
      "reinforcement.generation",
    ));
    malformed = true;
  }

  const stage = ownValue(value, "stage");
  if (typeof stage !== "string" || !REINFORCEMENT_STAGES.has(stage)) {
    issues.push(issue(
      "power-bank-unknown-reinforcement-stage",
      "reinforcement.stage is not recognized",
      "reinforcement.stage",
    ));
    malformed = true;
  }

  const boostOwnerId = ownValue(value, "boostOwnerId");
  if (boostOwnerId !== undefined && (typeof boostOwnerId !== "string" || boostOwnerId.length === 0)) {
    issues.push(issue(
      "power-bank-invalid-reinforcement-owner",
      "reinforcement.boostOwnerId must be a non-empty string",
      "reinforcement.boostOwnerId",
    ));
    malformed = true;
  }

  const authorities: WorkAuthorityRef[] = [{
    role: "workflow_owner",
    id: typeof boostOwnerId === "string" && boostOwnerId.length > 0 ? boostOwnerId : taskId,
    generation: generation.value,
    component: "reinforcement",
  }];
  if (typeof boostOwnerId === "string" && boostOwnerId.length > 0) {
    authorities.push({
      role: "lease_owner",
      id: boostOwnerId,
      generation: generation.value,
      component: "boost",
    });
  }

  for (const [field, component] of [
    ["attackerId", "attacker"],
    ["healerId", "healer"],
  ] as const) {
    const memberId = ownValue(value, field);
    if (memberId === undefined) continue;
    if (typeof memberId !== "string" || memberId.length === 0) {
      issues.push(issue(
        "power-bank-invalid-reinforcement-member",
        `reinforcement.${field} must be a non-empty string`,
        `reinforcement.${field}`,
      ));
      malformed = true;
      continue;
    }
    authorities.push({
      role: "executor",
      id: memberId,
      generation: generation.value,
      component,
    });
  }

  return { authorities, malformed };
}

interface PowerBankEntryProjection {
  readonly entry?: WorkStatusView;
  readonly invalidIssue?: WorkProjectionIssue;
}

function projectPowerBankEntry(localId: string, value: unknown): PowerBankEntryProjection {
  if (localId.length === 0) {
    return {
      invalidIssue: issue(
        "power-bank-unprojectable-identity",
        "PowerBank active workflow has an empty store key",
      ),
    };
  }
  if (!isRecord(value)) {
    return {
      invalidIssue: issue(
        "power-bank-malformed-record",
        `PowerBank active workflow ${localId} must be an object with a bankId`,
      ),
    };
  }

  const bankId = ownValue(value, "bankId");
  if (typeof bankId !== "string" || bankId.length === 0) {
    return {
      invalidIssue: issue(
        "power-bank-unprojectable-identity",
        `PowerBank active workflow ${localId} lacks a non-empty bankId object identity`,
        "bankId",
      ),
    };
  }

  const ref = {
    system: "power-bank-workflow" as const,
    namespace: POWER_BANK_NAMESPACE,
    scope: { kind: "object" as const, objectId: bankId },
    localId,
  };

  const issues: WorkProjectionIssue[] = [];
  let malformed = false;

  const taskId = ownValue(value, "id");
  if (typeof taskId !== "string" || taskId.length === 0 || taskId !== localId) {
    issues.push(issue(
      "power-bank-task-id-mismatch",
      "active store key and task id must match",
      "id",
    ));
    malformed = true;
  }

  const sourceRoom = ownValue(value, "sourceRoom");
  if (typeof sourceRoom !== "string" || (sourceRoom.length > 0 && !isRoomName(sourceRoom))) {
    issues.push(issue(
      "power-bank-invalid-source-room",
      "sourceRoom must be empty or a Screeps room name",
      "sourceRoom",
    ));
    malformed = true;
  }
  const targetRoom = ownValue(value, "targetRoom");
  if (!isRoomName(targetRoom)) {
    issues.push(issue(
      "power-bank-invalid-target-room",
      "targetRoom must be a Screeps room name",
      "targetRoom",
    ));
    malformed = true;
  }

  const status = ownValue(value, "status");
  const sourceState = typeof status === "string" ? status : "unknown";
  if (typeof status !== "string" || !POWER_BANK_STATUSES.has(status)) {
    issues.push(issue(
      "power-bank-unknown-status",
      "PowerBank status is not recognized",
      "status",
    ));
    malformed = true;
  }
  if (
    sourceRoom === ""
    && typeof status === "string"
    && POWER_BANK_SOURCE_REQUIRED_STATUSES.has(status)
  ) {
    issues.push(issue(
      "power-bank-source-room-required",
      `${status} PowerBank workflow requires a sourceRoom`,
      "sourceRoom",
    ));
    malformed = true;
  }

  const blockerValue = ownValue(value, "blocker");
  if (blockerValue !== undefined && typeof blockerValue !== "string") {
    issues.push(issue(
      "power-bank-invalid-blocker",
      "blocker must be a string",
      "blocker",
    ));
    malformed = true;
  }
  const blocker = typeof blockerValue === "string" && blockerValue.length > 0
    ? blockerValue
    : undefined;

  const failReasonValue = ownValue(value, "failReason");
  if (failReasonValue !== undefined && typeof failReasonValue !== "string") {
    issues.push(issue(
      "power-bank-invalid-fail-reason",
      "failReason must be a string",
      "failReason",
    ));
    malformed = true;
  }
  const failReason = typeof failReasonValue === "string" && failReasonValue.length > 0
    ? failReasonValue
    : undefined;
  if (
    failReason !== undefined
    && typeof status === "string"
    && POWER_BANK_STATUSES.has(status)
    && !POWER_BANK_TERMINAL_STATUSES.has(status)
  ) {
    issues.push(issue(
      "power-bank-stale-fail-reason",
      "non-terminal PowerBank workflow retains a terminal failReason",
      "failReason",
    ));
    malformed = true;
  }

  const createdAt = optionalFiniteNumber(value, "discoveredTick", issues);
  const updatedAt = optionalFiniteNumber(value, "stageEnteredAt", issues);
  const lastProgressAt = optionalFiniteNumber(value, "lastProgressAt", issues);
  const retryAt = optionalFiniteNumber(value, "nextAttemptAt", issues);
  const bankDeadline = optionalFiniteNumber(value, "bankExpiresAt", issues);
  const haulingDeadline = optionalFiniteNumber(value, "haulingDeadlineAt", issues);
  malformed ||= createdAt.malformed || updatedAt.malformed || lastProgressAt.malformed || retryAt.malformed
    || bankDeadline.malformed || haulingDeadline.malformed;

  const activeGeneration = optionalGeneration(
    ownValue(value, "activeGeneration"),
    "activeGeneration",
    issues,
  );
  malformed ||= activeGeneration.malformed;
  const activeIndex = optionalIndex(ownValue(value, "activeIndex"), "activeIndex", issues);
  malformed ||= activeIndex.malformed;

  const primaryBoostOwnerId = ownValue(value, "primaryBoostOwnerId");
  if (
    primaryBoostOwnerId !== undefined &&
    (typeof primaryBoostOwnerId !== "string" || primaryBoostOwnerId.length === 0)
  ) {
    issues.push(issue(
      "power-bank-invalid-primary-owner",
      "primaryBoostOwnerId must be a non-empty string",
      "primaryBoostOwnerId",
    ));
    malformed = true;
  }

  const authorities: WorkAuthorityRef[] = [
    { role: "producer", id: POWER_BANK_NAMESPACE },
  ];
  if (typeof sourceRoom === "string" && sourceRoom.length > 0) {
    authorities.push({ role: "workflow_owner", id: sourceRoom, component: "source-room" });
  }
  if (activeGeneration.value !== undefined) {
    authorities.push({
      role: "workflow_owner",
      id: typeof primaryBoostOwnerId === "string" && primaryBoostOwnerId.length > 0
        ? primaryBoostOwnerId
        : localId,
      generation: activeGeneration.value,
      component: "active-generation",
    });
  }
  if (typeof primaryBoostOwnerId === "string" && primaryBoostOwnerId.length > 0) {
    authorities.push({
      role: "lease_owner",
      id: primaryBoostOwnerId,
      generation: activeGeneration.value,
      component: "boost",
    });
  }

  for (const [field, component] of [
    ["attackerId", "attacker"],
    ["healerId", "healer"],
  ] as const) {
    const memberId = ownValue(value, field);
    if (memberId === undefined) continue;
    if (typeof memberId !== "string" || memberId.length === 0) {
      issues.push(issue(
        "power-bank-invalid-active-member",
        `${field} must be a non-empty string`,
        field,
      ));
      malformed = true;
      continue;
    }
    authorities.push({
      role: "executor",
      id: memberId,
      generation: activeGeneration.value,
      component,
    });
  }

  const reinforcement = projectReinforcement(
    localId,
    activeGeneration.value,
    activeIndex.value,
    ownValue(value, "reinforcement"),
    issues,
  );
  authorities.push(...reinforcement.authorities);
  malformed ||= reinforcement.malformed;

  if (typeof status === "string" && POWER_BANK_TERMINAL_STATUSES.has(status)) {
    issues.push(issue(
      "power-bank-terminal-in-active-store",
      "terminal PowerBank record remains in the active workflow store pending domain cleanup",
      "status",
    ));
  }

  const deadlineAt = status === "hauling"
    ? haulingDeadline.value ?? bankDeadline.value
    : bankDeadline.value;

  return {
    entry: {
      ref,
      activity: malformed ? "unknown" : activityForStatus(sourceState, blocker),
      sourceState,
      authorities,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      lastProgressAt: lastProgressAt.value,
      blocker: blocker ?? failReason,
      retryAt: retryAt.value,
      deadlineAt,
      issues,
    },
  };
}

export function snapshotPowerBankWorkflow(): TaskSystemAdapterResult {
  // Only the active store is a workflow source. Bounded terminal history is
  // deliberately not projected back into executable work.
  const data = (Memory as unknown as { data?: unknown }).data;
  if (data === undefined) {
    return { entries: [], invalidCount: 0, issues: [] };
  }
  if (!isRecord(data)) {
    return {
      entries: [],
      invalidCount: 1,
      issues: [issue(
        "power-bank-malformed-data",
        "Memory.data must be an object",
        "Memory.data",
      )],
    };
  }

  const store = ownValue(data, "powerBankHarvest");
  if (store === undefined) {
    return { entries: [], invalidCount: 0, issues: [] };
  }
  if (!isRecord(store)) {
    return {
      entries: [],
      invalidCount: 1,
      issues: [issue(
        "power-bank-malformed-store",
        "Memory.data.powerBankHarvest must be an object",
        "Memory.data.powerBankHarvest",
      )],
    };
  }

  const entries: WorkStatusView[] = [];
  const issues: WorkProjectionIssue[] = [];
  let invalidCount = 0;
  for (const [localId, value] of Object.entries(store)) {
    const projected = projectPowerBankEntry(localId, value);
    if (projected.entry) entries.push(projected.entry);
    if (projected.invalidIssue) {
      invalidCount += 1;
      issues.push(projected.invalidIssue);
    }
  }

  return {
    entries: sortWorkStatusViews(entries),
    invalidCount,
    issues,
  };
}

export const powerBankWorkflowAdapter: TaskSystemAdapter = {
  system: "power-bank-workflow",
  snapshot: snapshotPowerBankWorkflow,
};

export default powerBankWorkflowAdapter;
