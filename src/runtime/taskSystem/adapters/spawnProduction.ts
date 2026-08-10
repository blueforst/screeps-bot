import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";
import { isRoleName } from "@/types/roleCatalog";

const SPAWN_PRODUCTION_NAMESPACE = "spawnPlanner";
const MAX_SYSTEM_ISSUES = 100;
const MAX_PROJECTION_ISSUES = 50;
const VALID_BODY_PARTS: Readonly<Record<string, true>> = Object.freeze({
  move: true,
  work: true,
  carry: true,
  attack: true,
  ranged_attack: true,
  tough: true,
  heal: true,
  claim: true,
});

// Must stay byte-for-byte equivalent to mountSpawn's transient lifecycle gate:
// these configs are removed immediately after spawnCreep accepts the request,
// while native spawning/live Creep references legitimately remain observable.
function isTransientConfigName(configName: string): boolean {
  return configName.includes(":manual:") || configName.includes(":emergency:");
}

export type SpawnProductionFact =
  | {
      readonly kind: "desired";
      readonly roomName?: string;
      readonly role?: string;
      readonly spawnOnceQueuedAt?: number;
    }
  | {
      readonly kind: "queued";
      readonly spawnName: string;
      readonly roomName: string;
      readonly queueIndex: number;
    }
  | {
      readonly kind: "spawning";
      readonly spawnName: string;
      readonly roomName: string;
      readonly creepName: string;
    }
  | {
      readonly kind: "materialized";
      readonly creepName: string;
      readonly roomName: string;
    };

export interface SpawnProductionStatusView extends WorkStatusView {
  readonly facts: readonly SpawnProductionFact[];
}

export interface SpawnProductionAdapterResult extends TaskSystemAdapterResult {
  readonly entries: readonly SpawnProductionStatusView[];
}

interface MutableProjection {
  readonly localId: string;
  readonly facts: SpawnProductionFact[];
  readonly authorities: WorkAuthorityRef[];
  readonly issues: WorkProjectionIssue[];
  configSeen: boolean;
  configValid: boolean;
  configuredRoomName?: string;
  spawnOnceQueuedAt?: number;
}

interface ProjectionAccumulator {
  readonly projections: Map<string, MutableProjection>;
  readonly issues: WorkProjectionIssue[];
  readonly creepConfigReferences: Map<string, RawConfigReference>;
  spawnMemoryStore?: Record<string, unknown>;
  creepMemoryStore?: Record<string, unknown>;
  invalidCount: number;
}

type RawConfigReference =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly configName: string };

type OwnDataProperty =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: unknown };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addSystemIssue(
  accumulator: ProjectionAccumulator,
  issue: WorkProjectionIssue,
): void {
  accumulator.invalidCount += 1;
  addBoundedIssue(accumulator.issues, issue, MAX_SYSTEM_ISSUES);
}

function getProjection(
  accumulator: ProjectionAccumulator,
  localId: string,
): MutableProjection {
  const existing = accumulator.projections.get(localId);
  if (existing) return existing;

  const created: MutableProjection = {
    localId,
    facts: [],
    authorities: [],
    issues: [],
    configSeen: false,
    configValid: false,
  };
  accumulator.projections.set(localId, created);
  return created;
}

function addProjectionIssue(
  projection: MutableProjection,
  issue: WorkProjectionIssue,
): void {
  addBoundedIssue(projection.issues, issue, MAX_PROJECTION_ISSUES);
}

function addBoundedIssue(
  issues: WorkProjectionIssue[],
  issue: WorkProjectionIssue,
  limit: number,
): void {
  const copied = { ...issue };
  if (issues.length < limit) {
    issues.push(copied);
    return;
  }

  let greatestIndex = 0;
  for (let index = 1; index < issues.length; index += 1) {
    if (compareIssues(issues[index], issues[greatestIndex]) > 0) {
      greatestIndex = index;
    }
  }
  if (compareIssues(copied, issues[greatestIndex]) < 0) {
    issues[greatestIndex] = copied;
  }
}

function isDenseStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      typeof value[index] !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function isValidBody(value: unknown): value is BodyPartConstant[] {
  if (!Array.isArray(value) || value.length > MAX_CREEP_SIZE) return false;
  for (let index = 0; index < value.length; index += 1) {
    const part = value[index];
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      typeof part !== "string" ||
      !Object.prototype.hasOwnProperty.call(VALID_BODY_PARTS, part)
    ) {
      return false;
    }
  }
  return true;
}

function validateOptionalString(
  record: Record<string, unknown>,
  field: string,
  projection: MutableProjection,
): boolean {
  const value = record[field];
  if (value === undefined || isNonEmptyString(value)) {
    return true;
  }
  addProjectionIssue(projection, {
    code: "spawn-config-invalid-field",
    message: `spawn config field ${field} must be a non-empty string when present`,
    field,
  });
  return false;
}

function validateSpawnOnce(
  value: unknown,
  projection: MutableProjection,
): boolean {
  if (value === undefined) return true;
  if (!isPlainRecord(value)) {
    addProjectionIssue(projection, {
      code: "spawn-config-invalid-spawn-once",
      message: "spawnOnce must be a record when present",
      field: "spawnOnce",
    });
    return false;
  }

  const queuedAt = value.queuedAt;
  if (queuedAt === undefined) return true;
  if (!isFiniteTick(queuedAt)) {
    addProjectionIssue(projection, {
      code: "spawn-config-invalid-spawn-once",
      message: "spawnOnce.queuedAt must be a non-negative safe integer",
      field: "spawnOnce.queuedAt",
    });
    return false;
  }

  projection.spawnOnceQueuedAt = queuedAt;
  return true;
}

function observeConfig(
  accumulator: ProjectionAccumulator,
  configName: string,
  rawConfig: unknown,
): void {
  const projection = getProjection(accumulator, configName);
  projection.configSeen = true;

  if (!isPlainRecord(rawConfig)) {
    addProjectionIssue(projection, {
      code: "spawn-config-malformed",
      message: "spawn config must be a plain record",
      field: "config",
    });
    return;
  }

  let valid = true;
  if (!isRoleName(rawConfig.role)) {
    valid = false;
    addProjectionIssue(projection, {
      code: "spawn-config-unknown-role",
      message: "spawn config role is not registered in the role catalog",
      field: "role",
    });
  }
  if (!isDenseStringArray(rawConfig.args)) {
    valid = false;
    addProjectionIssue(projection, {
      code: "spawn-config-invalid-args",
      message: "spawn config args must be an array of strings",
      field: "args",
    });
  }

  const roomNameValid = validateOptionalString(rawConfig, "roomName", projection);
  valid = roomNameValid && valid;
  if (isNonEmptyString(rawConfig.roomName)) {
    projection.configuredRoomName = rawConfig.roomName;
  }

  for (const field of ["name", "taskId"] as const) {
    valid = validateOptionalString(rawConfig, field, projection) && valid;
  }
  if (
    rawConfig.powerBankGeneration !== undefined &&
    (!Number.isSafeInteger(rawConfig.powerBankGeneration) || (rawConfig.powerBankGeneration as number) < 0)
  ) {
    valid = false;
    addProjectionIssue(projection, {
      code: "spawn-config-invalid-generation",
      message: "powerBankGeneration must be a non-negative safe integer when present",
      field: "powerBankGeneration",
    });
  }
  if (rawConfig.body !== undefined && !isValidBody(rawConfig.body)) {
    valid = false;
    addProjectionIssue(projection, {
      code: "spawn-config-invalid-body",
      message: "spawn config body must be a dense array of BodyPartConstant values when present",
      field: "body",
    });
  }
  valid = validateSpawnOnce(rawConfig.spawnOnce, projection) && valid;

  projection.configValid = valid;
  projection.facts.push({
    kind: "desired",
    ...(projection.configuredRoomName ? { roomName: projection.configuredRoomName } : {}),
    ...(typeof rawConfig.role === "string" ? { role: rawConfig.role } : {}),
    ...(projection.spawnOnceQueuedAt !== undefined
      ? { spawnOnceQueuedAt: projection.spawnOnceQueuedAt }
      : {}),
  });
}

function readConfigStore(accumulator: ProjectionAccumulator): void {
  const data = (Memory as Memory & { data?: unknown }).data;
  if (data === undefined) return;
  if (!isPlainRecord(data)) {
    addSystemIssue(accumulator, {
      code: "spawn-config-store-malformed",
      message: "Memory.data must be a plain record",
      field: "Memory.data",
    });
    return;
  }

  const store = data.creepConfigs;
  if (store === undefined) return;
  if (!isPlainRecord(store)) {
    addSystemIssue(accumulator, {
      code: "spawn-config-store-malformed",
      message: "Memory.data.creepConfigs must be a plain record",
      field: "Memory.data.creepConfigs",
    });
    return;
  }

  for (const [configName, rawConfig] of Object.entries(store)) {
    if (!isNonEmptyString(configName)) {
      addSystemIssue(accumulator, {
        code: "spawn-config-id-invalid",
        message: "spawn config store key must be a non-empty string",
        field: "Memory.data.creepConfigs",
      });
      continue;
    }
    observeConfig(accumulator, configName, rawConfig);
  }
}

function getSpawnRoomName(spawn: StructureSpawn): string | undefined {
  return isNonEmptyString(spawn.room?.name) ? spawn.room.name : undefined;
}

function observeExecutorRoom(
  projection: MutableProjection,
  roomName: string,
  field: string,
): void {
  if (
    projection.configSeen &&
    projection.configuredRoomName !== undefined &&
    projection.configuredRoomName !== roomName
  ) {
    addProjectionIssue(projection, {
      code: "spawn-reference-room-mismatch",
      message: `spawn reference room ${roomName} does not match config room ${projection.configuredRoomName}`,
      field,
    });
  }
}

function getOwnMemoryRecord(
  accumulator: ProjectionAccumulator,
  store: Record<string, unknown> | undefined,
  key: string,
  field: string,
): Record<string, unknown> | undefined {
  if (!store) return undefined;
  const property = readOwnDataProperty(accumulator, store, key, field);
  if (property.kind !== "value") return undefined;
  const value = property.value;
  if (isPlainRecord(value)) return value;
  addSystemIssue(accumulator, {
    code: "spawn-raw-memory-record-malformed",
    message: `${field} must be a plain own record`,
    field,
  });
  return undefined;
}

function readOwnDataProperty(
  accumulator: ProjectionAccumulator,
  record: Record<string, unknown>,
  key: string,
  field: string,
): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { kind: "missing" };
  if (!("value" in descriptor)) {
    addSystemIssue(accumulator, {
      code: "spawn-raw-memory-accessor-unsupported",
      message: `${field} must be an own data property`,
      field,
    });
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value };
}

function observeQueue(
  accumulator: ProjectionAccumulator,
  spawnName: string,
  roomName: string,
): void {
  const rawSpawnMemory = getOwnMemoryRecord(
    accumulator,
    accumulator.spawnMemoryStore,
    spawnName,
    `Memory.spawns.${spawnName}`,
  );
  if (!rawSpawnMemory) return;
  const queueProperty = readOwnDataProperty(
    accumulator,
    rawSpawnMemory,
    "spawnList",
    `Memory.spawns.${spawnName}.spawnList`,
  );
  if (queueProperty.kind !== "value") return;
  const queue = queueProperty.value;
  if (!Array.isArray(queue)) {
    addSystemIssue(accumulator, {
      code: "spawn-queue-malformed",
      message: `spawn ${spawnName} queue must be an array`,
      field: `Memory.spawns.${spawnName}.spawnList`,
    });
    return;
  }

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const configName: unknown = queue[queueIndex];
    if (!isNonEmptyString(configName)) {
      addSystemIssue(accumulator, {
        code: "spawn-queue-reference-invalid",
        message: `spawn ${spawnName} queue item ${queueIndex} is not a non-empty config name`,
        field: `Memory.spawns.${spawnName}.spawnList.${queueIndex}`,
      });
      continue;
    }

    const projection = getProjection(accumulator, configName);
    observeExecutorRoom(projection, roomName, "queue.roomName");
    projection.facts.push({ kind: "queued", spawnName, roomName, queueIndex });
    projection.authorities.push({ role: "queue_owner", id: spawnName, component: roomName });
  }
}

function readRawCreepConfigReference(
  accumulator: ProjectionAccumulator,
  creepName: string,
): RawConfigReference {
  const cached = accumulator.creepConfigReferences.get(creepName);
  if (cached) return cached;

  const rawCreepMemory = getOwnMemoryRecord(
    accumulator,
    accumulator.creepMemoryStore,
    creepName,
    `Memory.creeps.${creepName}`,
  );
  if (!rawCreepMemory) {
    const missing: RawConfigReference = { kind: "missing" };
    accumulator.creepConfigReferences.set(creepName, missing);
    return missing;
  }

  const configProperty = readOwnDataProperty(
    accumulator,
    rawCreepMemory,
    "configName",
    `Memory.creeps.${creepName}.configName`,
  );
  if (configProperty.kind === "missing") {
    const missing: RawConfigReference = { kind: "missing" };
    accumulator.creepConfigReferences.set(creepName, missing);
    return missing;
  }
  if (configProperty.kind === "invalid") {
    const invalid: RawConfigReference = { kind: "invalid" };
    accumulator.creepConfigReferences.set(creepName, invalid);
    return invalid;
  }

  const configName = configProperty.value;
  if (!isNonEmptyString(configName)) {
    addSystemIssue(accumulator, {
      code: "spawn-creep-reference-invalid",
      message: `raw creep Memory for ${creepName} has an invalid config reference`,
      field: `Memory.creeps.${creepName}.configName`,
    });
    const invalid: RawConfigReference = { kind: "invalid" };
    accumulator.creepConfigReferences.set(creepName, invalid);
    return invalid;
  }

  const valid: RawConfigReference = { kind: "valid", configName };
  accumulator.creepConfigReferences.set(creepName, valid);
  return valid;
}

function observeSpawning(
  accumulator: ProjectionAccumulator,
  spawn: StructureSpawn,
  spawnName: string,
  roomName: string,
): void {
  const spawning = spawn.spawning;
  if (!spawning) return;
  const creepName = (spawning as Spawning & { name?: unknown }).name;
  if (!isNonEmptyString(creepName)) {
    addSystemIssue(accumulator, {
      code: "spawn-spawning-name-invalid",
      message: `spawn ${spawnName} has a malformed spawning creep name`,
      field: `Game.spawns.${spawnName}.spawning.name`,
    });
    return;
  }

  const configReference = readRawCreepConfigReference(accumulator, creepName);
  if (configReference.kind !== "valid") {
    if (configReference.kind === "missing") {
      addSystemIssue(accumulator, {
        code: "spawn-spawning-reference-missing",
        message: `spawn ${spawnName} cannot prove the config for spawning creep ${creepName}`,
        field: `Memory.creeps.${creepName}.configName`,
      });
    }
    return;
  }

  const projection = getProjection(accumulator, configReference.configName);
  observeExecutorRoom(projection, roomName, "spawning.roomName");
  projection.facts.push({ kind: "spawning", spawnName, roomName, creepName });
  projection.authorities.push({ role: "executor", id: spawnName, component: creepName });
}

function readSpawns(accumulator: ProjectionAccumulator): void {
  for (const [fallbackSpawnName, spawn] of Object.entries(Game.spawns || {})) {
    if (!spawn || typeof spawn !== "object") {
      addSystemIssue(accumulator, {
        code: "spawn-record-malformed",
        message: `Game.spawns entry ${fallbackSpawnName} must be an object`,
        field: `Game.spawns.${fallbackSpawnName}`,
      });
      continue;
    }
    const spawnName = isNonEmptyString(spawn.name) ? spawn.name : fallbackSpawnName;
    const roomName = getSpawnRoomName(spawn);
    if (!isNonEmptyString(spawnName) || !roomName) {
      addSystemIssue(accumulator, {
        code: "spawn-identity-malformed",
        message: "spawn observation requires a non-empty name and room",
        field: `Game.spawns.${fallbackSpawnName}`,
      });
      continue;
    }

    observeQueue(accumulator, spawnName, roomName);
    observeSpawning(accumulator, spawn, spawnName, roomName);
  }
}

function readLiveCreeps(accumulator: ProjectionAccumulator): void {
  for (const [fallbackCreepName, creep] of Object.entries(Game.creeps || {})) {
    if (!creep || typeof creep !== "object") {
      addSystemIssue(accumulator, {
        code: "spawn-live-record-malformed",
        message: `Game.creeps entry ${fallbackCreepName} must be an object`,
        field: `Game.creeps.${fallbackCreepName}`,
      });
      continue;
    }
    if (creep.spawning === true) continue;
    const creepName = isNonEmptyString(creep.name) ? creep.name : fallbackCreepName;
    if (!isNonEmptyString(creepName)) {
      addSystemIssue(accumulator, {
        code: "spawn-live-identity-invalid",
        message: "live creep observation requires a non-empty own name or Game.creeps key",
        field: "Game.creeps",
      });
      continue;
    }
    const configReference = readRawCreepConfigReference(accumulator, creepName);
    if (configReference.kind !== "valid") continue;
    const roomName = isNonEmptyString(creep.room?.name) ? creep.room.name : undefined;
    if (!roomName) {
      addSystemIssue(accumulator, {
        code: "spawn-live-room-invalid",
        message: `live creep ${creepName} has no provable current room`,
        field: `Game.creeps.${fallbackCreepName}.room.name`,
      });
      continue;
    }
    const projection = getProjection(accumulator, configReference.configName);
    projection.facts.push({ kind: "materialized", creepName, roomName });
    projection.authorities.push({ role: "assignee", id: creepName, component: "materialized" });
  }
}

const FACT_KIND_ORDER: Readonly<Record<SpawnProductionFact["kind"], number>> = {
  desired: 0,
  queued: 1,
  spawning: 2,
  materialized: 3,
};

function factIdentity(fact: SpawnProductionFact): readonly (string | number)[] {
  switch (fact.kind) {
    case "desired":
      return [fact.roomName || "", fact.role || "", fact.spawnOnceQueuedAt ?? -1];
    case "queued":
      return [fact.roomName, fact.spawnName, fact.queueIndex];
    case "spawning":
      return [fact.roomName, fact.spawnName, fact.creepName];
    case "materialized":
      return [fact.roomName, fact.creepName];
  }
}

function compareFact(left: SpawnProductionFact, right: SpawnProductionFact): number {
  const kindDifference = FACT_KIND_ORDER[left.kind] - FACT_KIND_ORDER[right.kind];
  if (kindDifference !== 0) return kindDifference;
  const leftParts = factIdentity(left);
  const rightParts = factIdentity(right);
  const count = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return leftParts.length - rightParts.length;
}

function compareAuthorities(left: WorkAuthorityRef, right: WorkAuthorityRef): number {
  return left.role.localeCompare(right.role)
    || left.id.localeCompare(right.id)
    || (left.component || "").localeCompare(right.component || "")
    || (left.generation ?? -1) - (right.generation ?? -1);
}

function compareIssues(left: WorkProjectionIssue, right: WorkProjectionIssue): number {
  return left.code.localeCompare(right.code)
    || (left.field || "").localeCompare(right.field || "")
    || left.message.localeCompare(right.message);
}

function uniqueFactKinds(facts: readonly SpawnProductionFact[]): SpawnProductionFact["kind"][] {
  const present = new Set(facts.map((fact) => fact.kind));
  return (["desired", "queued", "spawning", "materialized"] as const)
    .filter((kind) => present.has(kind));
}

function addReferenceIssues(projection: MutableProjection): void {
  const acceptedTransient = isAcceptedTransientProjection(projection);
  if (!projection.configSeen && !acceptedTransient) {
    addProjectionIssue(projection, {
      code: "spawn-reference-missing-config",
      message: "spawn queue, spawning, or live reference has no matching creep config",
      field: "configName",
    });
  }

  const queuedFacts = projection.facts.filter(
    (fact): fact is Extract<SpawnProductionFact, { kind: "queued" }> => fact.kind === "queued",
  );
  const queueOwners = new Set(queuedFacts.map((fact) => fact.spawnName));
  if (queueOwners.size > 1) {
    addProjectionIssue(projection, {
      code: "spawn-multiple-queue-owners",
      message: "config is referenced by more than one Spawn queue owner",
      field: "spawnList",
    });
  }
  if (
    acceptedTransient &&
    queuedFacts.length > 0
  ) {
    addProjectionIssue(projection, {
      code: "spawn-transient-stale-queue-reference",
      message: "accepted transient production still has a stale queue reference after its config was consumed",
      field: "spawnList",
    });
  }
  if (queuedFacts.length > queueOwners.size) {
    addProjectionIssue(projection, {
      code: "spawn-duplicate-queue-reference",
      message: "config has duplicate queue references within at least one Spawn",
      field: "spawnList",
    });
  }

  const hasPendingOrMaterializedFact = projection.facts.some((fact) => fact.kind !== "desired");
  if (
    projection.configSeen &&
    projection.spawnOnceQueuedAt !== undefined &&
    !hasPendingOrMaterializedFact
  ) {
    addProjectionIssue(projection, {
      code: "spawn-once-observation-ambiguous",
      message: "spawnOnce was queued but no queue, spawning, or live reference remains; fulfillment and lost-owner states are indistinguishable",
      field: "spawnOnce.queuedAt",
    });
  }
}

function isAcceptedTransientProjection(projection: MutableProjection): boolean {
  return !projection.configSeen &&
    isTransientConfigName(projection.localId) &&
    projection.facts.some((fact) => fact.kind === "spawning" || fact.kind === "materialized");
}

function resolveActivity(projection: MutableProjection): WorkActivity {
  if (projection.issues.length > 0) return "unknown";
  if (isAcceptedTransientProjection(projection)) return "running";
  if (!projection.configSeen || !projection.configValid) return "unknown";
  if (projection.facts.some((fact) => fact.kind === "spawning")) return "running";
  if (projection.facts.some((fact) => fact.kind === "queued")) return "available";
  return "desired";
}

function resolveSourceState(
  projection: MutableProjection,
  facts: readonly SpawnProductionFact[],
): string {
  const factState = uniqueFactKinds(facts).join("+") || "unknown";
  return isAcceptedTransientProjection(projection)
    ? `transient-accepted:${factState}`
    : factState;
}

function toStatusView(projection: MutableProjection): SpawnProductionStatusView {
  addReferenceIssues(projection);
  const facts = [...projection.facts].sort(compareFact).map((fact) => ({ ...fact }));
  const authorities = [...projection.authorities].sort(compareAuthorities).map((authority) => ({ ...authority }));
  const issues = [...projection.issues].sort(compareIssues).map((issue) => ({ ...issue }));

  return {
    ref: {
      system: "spawn-production",
      namespace: SPAWN_PRODUCTION_NAMESPACE,
      scope: { kind: "global" },
      localId: projection.localId,
    },
    activity: resolveActivity(projection),
    sourceState: resolveSourceState(projection, facts),
    authorities,
    issues,
    facts,
  };
}

export function snapshotSpawnProduction(): SpawnProductionAdapterResult {
  const accumulator: ProjectionAccumulator = {
    projections: new Map(),
    invalidCount: 0,
    issues: [],
    creepConfigReferences: new Map(),
  };

  const rawSpawnMemory = (Memory as Memory & { spawns?: unknown }).spawns;
  if (rawSpawnMemory !== undefined) {
    if (isPlainRecord(rawSpawnMemory)) {
      accumulator.spawnMemoryStore = rawSpawnMemory;
    } else {
      addSystemIssue(accumulator, {
        code: "spawn-raw-memory-store-malformed",
        message: "Memory.spawns must be a plain record",
        field: "Memory.spawns",
      });
    }
  }
  const rawCreepMemory = (Memory as Memory & { creeps?: unknown }).creeps;
  if (rawCreepMemory !== undefined) {
    if (isPlainRecord(rawCreepMemory)) {
      accumulator.creepMemoryStore = rawCreepMemory;
    } else {
      addSystemIssue(accumulator, {
        code: "spawn-raw-memory-store-malformed",
        message: "Memory.creeps must be a plain record",
        field: "Memory.creeps",
      });
    }
  }

  readConfigStore(accumulator);
  readSpawns(accumulator);
  readLiveCreeps(accumulator);

  const entries = sortWorkStatusViews(
    Array.from(accumulator.projections.values(), toStatusView),
  ) as SpawnProductionStatusView[];
  return {
    entries,
    invalidCount: accumulator.invalidCount,
    issues: [...accumulator.issues].sort(compareIssues).map((issue) => ({ ...issue })),
  };
}

export const spawnProductionAdapter: TaskSystemAdapter<void> & {
  snapshot(): SpawnProductionAdapterResult;
} = {
  system: "spawn-production",
  snapshot: snapshotSpawnProduction,
};
