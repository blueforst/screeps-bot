import type { CarrierTaskBoardSnapshot } from "@/runtime/carrierTaskBoard";
import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

export interface CarrierLogisticsAdapterContext {
  /** A detached snapshot obtained from the CarrierTaskBoard read selector. */
  readonly board: CarrierTaskBoardSnapshot;
}

export interface CarrierTransportFact {
  readonly kind: "transport";
  readonly stepId: string;
  readonly resource: ResourceConstant;
  readonly fromKind: string;
  readonly toKind: string;
  readonly fromId: string;
  readonly toId: string;
  readonly amount: number;
}

export interface CarrierLogisticsStatusView extends WorkStatusView {
  readonly taskType?: string;
  readonly priority?: number;
  readonly dispatchClass?: string;
  /** Parallel transport facts. Their order is canonical, not executable. */
  readonly facts: readonly CarrierTransportFact[];
}

export interface CarrierLogisticsAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly CarrierLogisticsStatusView[];
}

export interface CarrierLogisticsTaskSystemAdapter
  extends TaskSystemAdapter<CarrierLogisticsAdapterContext> {
  readonly system: "carrier-logistics";
  snapshot(context: CarrierLogisticsAdapterContext): CarrierLogisticsAdapterResult;
}

const MAX_SYSTEM_ISSUES = 20;
const MAX_ENTRY_ISSUES = 20;
const ROOM_NAME_PATTERN = /^(?:sim|[WE]\d+[NS]\d+)$/;

const TASK_TYPES: ReadonlySet<string> = new Set([
  "lab_supply",
  "lab_cleanup",
  "lab_product_unload",
  "mineral_haul",
  "terminal_feed",
  "terminal_offload",
  "factory_supply",
  "factory_unload",
  "power_spawn_supply",
  "nuker_supply",
]);

const STRUCTURE_KINDS: ReadonlySet<string> = new Set([
  "lab",
  "terminal",
  "storage",
  "container",
  "factory",
  "power_spawn",
  "nuker",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function ownValue(record: Record<string, unknown>, field: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownKeys(record: Record<string, unknown>): string[] | null {
  try {
    return Object.keys(record);
  } catch {
    return null;
  }
}

function readArrayLength(array: unknown[]): number | null {
  const length = ownValue(
    array as unknown as Record<string, unknown>,
    "length",
  );
  return Number.isSafeInteger(length) && (length as number) >= 0
    ? length as number
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME_PATTERN.test(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isResourceConstant(value: unknown): value is ResourceConstant {
  return typeof value === "string"
    && RESOURCES_ALL.includes(value as ResourceConstant);
}

function isNonNegativeTick(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFacts(
  left: CarrierTransportFact,
  right: CarrierTransportFact,
): number {
  return compareText(left.stepId, right.stepId)
    || compareText(left.resource, right.resource)
    || compareText(left.fromKind, right.fromKind)
    || compareText(left.fromId, right.fromId)
    || compareText(left.toKind, right.toKind)
    || compareText(left.toId, right.toId)
    || left.amount - right.amount;
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

function addInvalidFieldIssue(
  issues: WorkProjectionIssue[],
  field: string,
): void {
  appendIssue(issues, {
    code: "carrier-task-field-invalid",
    message: `Carrier task field ${field} is missing or invalid.`,
    field,
  }, MAX_ENTRY_ISSUES);
}

function projectStep(
  rawStep: unknown,
  issues: WorkProjectionIssue[],
): CarrierTransportFact | null {
  if (!isPlainRecord(rawStep)) {
    appendIssue(issues, {
      code: "carrier-transport-step-malformed",
      message: "Carrier task contains a transport step that is not a plain record.",
      field: "steps",
    }, MAX_ENTRY_ISSUES);
    return null;
  }

  const stepId = ownValue(rawStep, "id");
  const resource = ownValue(rawStep, "resource");
  const fromKind = ownValue(rawStep, "fromKind");
  const toKind = ownValue(rawStep, "toKind");
  const fromId = ownValue(rawStep, "fromId");
  const toId = ownValue(rawStep, "toId");
  const amount = ownValue(rawStep, "amount");

  const invalidFields: string[] = [];
  if (!isNonEmptyString(stepId)) invalidFields.push("steps.id");
  if (!isNonEmptyString(resource)) {
    invalidFields.push("steps.resource");
  } else if (!isResourceConstant(resource)) {
    appendIssue(issues, {
      code: "carrier-transport-step-resource-invalid",
      message: "Carrier transport step resource is not a member of RESOURCES_ALL.",
      field: "steps.resource",
    }, MAX_ENTRY_ISSUES);
  }
  if (!isNonEmptyString(fromKind) || !STRUCTURE_KINDS.has(fromKind)) {
    invalidFields.push("steps.fromKind");
  }
  if (!isNonEmptyString(toKind) || !STRUCTURE_KINDS.has(toKind)) {
    invalidFields.push("steps.toKind");
  }
  if (!isNonEmptyString(fromId)) invalidFields.push("steps.fromId");
  if (!isNonEmptyString(toId)) invalidFields.push("steps.toId");
  if (!isFinitePositiveNumber(amount)) invalidFields.push("steps.amount");

  if (invalidFields.length > 0) {
    for (const field of invalidFields) {
      addInvalidFieldIssue(issues, field);
    }
  }
  if (invalidFields.length > 0 || !isResourceConstant(resource)) {
    return null;
  }

  return {
    kind: "transport",
    stepId: stepId as string,
    resource,
    fromKind: fromKind as string,
    toKind: toKind as string,
    fromId: fromId as string,
    toId: toId as string,
    amount: amount as number,
  };
}

type CarrierLogisticsWorkRef = WorkRef & {
  readonly system: "carrier-logistics";
  readonly scope: { readonly kind: "room"; readonly roomName: string };
};

function projectRef(
  roomName: string,
  rawRef: unknown,
): CarrierLogisticsWorkRef | null {
  if (!isPlainRecord(rawRef)) return null;

  const system = ownValue(rawRef, "system");
  const namespace = ownValue(rawRef, "namespace");
  const scope = ownValue(rawRef, "scope");
  const localId = ownValue(rawRef, "localId");
  if (
    system !== "carrier-logistics"
    || !isNonEmptyString(namespace)
    || !isNonEmptyString(localId)
    || !isPlainRecord(scope)
    || ownValue(scope, "kind") !== "room"
  ) {
    return null;
  }

  const scopeRoomName = ownValue(scope, "roomName");
  if (!isRoomName(scopeRoomName) || scopeRoomName !== roomName) {
    return null;
  }

  return {
    system: "carrier-logistics",
    namespace,
    scope: { kind: "room", roomName: scopeRoomName },
    localId,
  };
}

function projectTask(
  ref: CarrierLogisticsWorkRef,
  rawTask: Record<string, unknown>,
): CarrierLogisticsStatusView {
  const roomName = ref.scope.roomName;
  const storeTaskId = ref.localId;
  const producer = ownValue(rawTask, "producer");
  const issues: WorkProjectionIssue[] = [];
  if (!isNonEmptyString(producer) || producer !== ref.namespace) {
    appendIssue(issues, {
      code: "carrier-task-producer-mismatch",
      message: "Carrier task producer is missing or does not match its explicit read ref.",
      field: "producer",
    }, MAX_ENTRY_ISSUES);
  }

  const sourceId = ownValue(rawTask, "id");
  if (!isNonEmptyString(sourceId) || sourceId !== storeTaskId) {
    appendIssue(issues, {
      code: "carrier-task-id-mismatch",
      message: "Carrier task source id is missing or does not match its explicit read ref.",
      field: "id",
    }, MAX_ENTRY_ISSUES);
  }

  const sourceRoomName = ownValue(rawTask, "roomName");
  if (!isNonEmptyString(sourceRoomName) || sourceRoomName !== roomName) {
    appendIssue(issues, {
      code: "carrier-task-room-mismatch",
      message: "Carrier task source room is missing or does not match its explicit read ref.",
      field: "roomName",
    }, MAX_ENTRY_ISSUES);
  }

  const type = ownValue(rawTask, "type");
  if (!isNonEmptyString(type) || !TASK_TYPES.has(type)) {
    addInvalidFieldIssue(issues, "type");
  }

  const priority = ownValue(rawTask, "priority");
  if (!isFiniteNonNegativeNumber(priority)) {
    addInvalidFieldIssue(issues, "priority");
  }

  const dispatchClass = ownValue(rawTask, "dispatchClass");
  if (dispatchClass !== undefined && dispatchClass !== "capacity_relief") {
    addInvalidFieldIssue(issues, "dispatchClass");
  }

  const createdAt = ownValue(rawTask, "createdAt");
  const updatedAt = ownValue(rawTask, "updatedAt");
  if (!isNonNegativeTick(createdAt)) {
    addInvalidFieldIssue(issues, "createdAt");
  }
  if (!isNonNegativeTick(updatedAt)) {
    addInvalidFieldIssue(issues, "updatedAt");
  }
  if (
    isNonNegativeTick(createdAt)
    && isNonNegativeTick(updatedAt)
    && updatedAt < createdAt
  ) {
    appendIssue(issues, {
      code: "carrier-task-timestamp-conflict",
      message: "Carrier task update tick precedes its creation tick.",
      field: "updatedAt",
    }, MAX_ENTRY_ISSUES);
  }

  const facts: CarrierTransportFact[] = [];
  const steps = ownValue(rawTask, "steps");
  const stepCount = isArray(steps) ? readArrayLength(steps) : null;
  if (stepCount === null || stepCount === 0) {
    appendIssue(issues, {
      code: "carrier-task-steps-invalid",
      message: "Carrier task steps must be a non-empty array of parallel transport facts.",
      field: "steps",
    }, MAX_ENTRY_ISSUES);
  } else {
    const rawSteps = steps as unknown as Record<string, unknown>;
    for (let index = 0; index < stepCount; index += 1) {
      const rawStep = ownValue(rawSteps, String(index));
      const fact = projectStep(rawStep, issues);
      if (fact) facts.push(fact);
    }

    const seenStepIds = new Set<string>();
    for (const fact of facts) {
      if (seenStepIds.has(fact.stepId)) {
        appendIssue(issues, {
          code: "carrier-transport-step-id-duplicate",
          message: "Carrier task contains duplicate parallel transport step ids.",
          field: "steps.id",
        }, MAX_ENTRY_ISSUES);
      }
      seenStepIds.add(fact.stepId);
    }
  }

  const isolatedFacts = facts.sort(compareFacts).map((fact) => ({ ...fact }));
  const isolatedIssues = issues.sort(compareIssues).map((issue) => ({ ...issue }));

  return {
    ref: {
      system: "carrier-logistics",
      namespace: ref.namespace,
      scope: { kind: "room", roomName },
      localId: storeTaskId,
    },
    activity: isolatedIssues.length === 0 ? "available" : "unknown",
    sourceState: "published",
    authorities: [{ role: "producer", id: ref.namespace }],
    ...(isNonNegativeTick(createdAt) ? { createdAt } : {}),
    ...(isNonNegativeTick(updatedAt) ? { updatedAt } : {}),
    ...(isNonEmptyString(type) && TASK_TYPES.has(type) ? { taskType: type } : {}),
    ...(isFiniteNonNegativeNumber(priority) ? { priority } : {}),
    ...(dispatchClass === "capacity_relief" ? { dispatchClass } : {}),
    issues: isolatedIssues,
    facts: isolatedFacts,
  };
}

function malformedSourceResult(): CarrierLogisticsAdapterResult {
  return {
    entries: [],
    invalidCount: 1,
    issues: [{
      code: "carrier-board-source-malformed",
      message: "Carrier adapter context must contain a plain owner-aware read snapshot.",
      field: "board",
    }],
  };
}

const carrierLogisticsAdapter: CarrierLogisticsTaskSystemAdapter = {
  system: "carrier-logistics",

  snapshot(context): CarrierLogisticsAdapterResult {
    if (!isPlainRecord(context) || !isPlainRecord(ownValue(context, "board"))) {
      return malformedSourceResult();
    }
    const board = ownValue(context, "board") as Record<string, unknown>;
    const roomNames = ownKeys(board);
    if (!roomNames) return malformedSourceResult();

    const entries: CarrierLogisticsStatusView[] = [];
    const issues: WorkProjectionIssue[] = [];
    let invalidCount = 0;

    for (const roomName of roomNames.sort(compareText)) {
      if (!isRoomName(roomName)) {
        invalidCount += 1;
        appendIssue(issues, {
          code: "carrier-board-room-id-invalid",
          message: "Carrier owner-aware snapshot contains an invalid room key.",
          field: "board",
        }, MAX_SYSTEM_ISSUES);
        continue;
      }

      const rawRoom = ownValue(board, roomName);
      const entryCount = isArray(rawRoom) ? readArrayLength(rawRoom) : null;
      if (entryCount === null) {
        invalidCount += 1;
        appendIssue(issues, {
          code: "carrier-board-room-malformed",
          message: `Carrier room ${roomName} is not an owner-aware entry array.`,
          field: roomName,
        }, MAX_SYSTEM_ISSUES);
        continue;
      }

      const rawRoomRecord = rawRoom as unknown as Record<string, unknown>;
      for (let index = 0; index < entryCount; index += 1) {
        const field = `${roomName}[${index}]`;
        const rawReadEntry = ownValue(rawRoomRecord, String(index));
        if (!isPlainRecord(rawReadEntry)) {
          invalidCount += 1;
          appendIssue(issues, {
            code: "carrier-read-entry-malformed",
            message: `Carrier read entry ${field} is not a plain record.`,
            field,
          }, MAX_SYSTEM_ISSUES);
          continue;
        }

        const ref = projectRef(roomName, ownValue(rawReadEntry, "ref"));
        if (!ref) {
          invalidCount += 1;
          appendIssue(issues, {
            code: "carrier-read-ref-invalid",
            message: `Carrier read entry ${field} has no valid room-scoped Carrier ref.`,
            field: `${field}.ref`,
          }, MAX_SYSTEM_ISSUES);
          continue;
        }

        const rawTask = ownValue(rawReadEntry, "task");
        if (!isPlainRecord(rawTask)) {
          invalidCount += 1;
          appendIssue(issues, {
            code: "carrier-task-record-malformed",
            message: `Carrier read entry ${field} has no plain task record.`,
            field: `${field}.task`,
          }, MAX_SYSTEM_ISSUES);
          continue;
        }

        entries.push(projectTask(ref, rawTask));
      }
    }

    return {
      entries: sortWorkStatusViews(entries) as CarrierLogisticsStatusView[],
      invalidCount,
      issues: issues.sort(compareIssues).map((issue) => ({ ...issue })),
    };
  },
};

export default carrierLogisticsAdapter;
