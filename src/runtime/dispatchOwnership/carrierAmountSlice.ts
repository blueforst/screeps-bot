import {
  cloneCarrierDispatchRef,
  type CarrierDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

export interface CarrierAmountSliceStepBudget {
  readonly id: string;
  readonly amount: number;
}

export interface CarrierAmountSliceClaimRequest {
  readonly taskRef: CarrierDispatchRef;
  readonly taskSteps: readonly CarrierAmountSliceStepBudget[];
  readonly stepId: string;
  readonly claimantId: string;
  readonly requestedAmount: number;
}

export interface CarrierAmountSliceClaim {
  readonly amount: number;
  commit(): void;
  release(): void;
}

export interface CarrierAmountSlicePort {
  claim(request: CarrierAmountSliceClaimRequest): CarrierAmountSliceClaim | null;
  releaseUncommitted(taskRef: CarrierDispatchRef): void;
}

interface CarrierAmountSliceClaimRecord {
  readonly stepId: string;
  readonly amount: number;
  readonly claimantWasLiveAtClaim: boolean;
  committed: boolean;
}

interface CarrierAmountStepLedger {
  readonly stepId: string;
  readonly claims: Map<string, CarrierAmountSliceClaimRecord>;
}

interface CarrierAmountTaskLedger {
  readonly taskRef: CarrierDispatchRef;
  readonly claimsByClaimant: Map<string, CarrierAmountSliceClaimRecord>;
  readonly steps: Map<string, CarrierAmountStepLedger>;
}

type CarrierAmountLocalIdIndex = Map<string, CarrierAmountTaskLedger>;
type CarrierAmountRoomIndex = Map<string, CarrierAmountLocalIdIndex>;
type CarrierAmountScopeKindIndex = Map<string, CarrierAmountRoomIndex>;
type CarrierAmountNamespaceIndex = Map<string, CarrierAmountScopeKindIndex>;
type CarrierAmountSystemIndex = Map<string, CarrierAmountNamespaceIndex>;

interface CarrierAmountSliceRuntime {
  readonly tick: number;
  readonly game: Game;
  readonly bySystem: CarrierAmountSystemIndex;
}

type RuntimeGlobalWithCarrierAmountSlices = typeof global & {
  __carrierTaskClaims?: CarrierAmountSliceRuntime;
};

const runtimeGlobal = global as RuntimeGlobalWithCarrierAmountSlices;

function normalizeAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(amount));
}

function addAmount(total: number, amount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + amount);
}

function hasOwnLiveCreep(claimantId: string): boolean {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(Game.creeps, claimantId);
  } catch {
    return false;
  }
  return !!descriptor && "value" in descriptor && !!descriptor.value;
}

function ensureCarrierAmountSliceRuntime(): CarrierAmountSliceRuntime {
  const current = runtimeGlobal.__carrierTaskClaims;
  if (
    current
    && current.tick === Game.time
    && current.game === Game
    && current.bySystem instanceof Map
  ) {
    return current;
  }

  const created: CarrierAmountSliceRuntime = {
    tick: Game.time,
    game: Game,
    bySystem: new Map(),
  };
  runtimeGlobal.__carrierTaskClaims = created;
  return created;
}

function getCarrierAmountTaskLedger(
  runtime: CarrierAmountSliceRuntime,
  taskRef: CarrierDispatchRef,
): CarrierAmountTaskLedger | undefined {
  return runtime.bySystem
    .get(taskRef.system)
    ?.get(taskRef.namespace)
    ?.get(taskRef.scope.kind)
    ?.get(taskRef.scope.roomName)
    ?.get(taskRef.localId);
}

function ensureCarrierAmountTaskLedger(
  runtime: CarrierAmountSliceRuntime,
  taskRef: CarrierDispatchRef,
): CarrierAmountTaskLedger {
  let namespaceIndex = runtime.bySystem.get(taskRef.system);
  if (!namespaceIndex) {
    namespaceIndex = new Map();
    runtime.bySystem.set(taskRef.system, namespaceIndex);
  }

  let scopeKindIndex = namespaceIndex.get(taskRef.namespace);
  if (!scopeKindIndex) {
    scopeKindIndex = new Map();
    namespaceIndex.set(taskRef.namespace, scopeKindIndex);
  }

  let roomIndex = scopeKindIndex.get(taskRef.scope.kind);
  if (!roomIndex) {
    roomIndex = new Map();
    scopeKindIndex.set(taskRef.scope.kind, roomIndex);
  }

  let localIdIndex = roomIndex.get(taskRef.scope.roomName);
  if (!localIdIndex) {
    localIdIndex = new Map();
    roomIndex.set(taskRef.scope.roomName, localIdIndex);
  }

  let taskLedger = localIdIndex.get(taskRef.localId);
  if (!taskLedger) {
    taskLedger = {
      taskRef,
      claimsByClaimant: new Map(),
      steps: new Map(),
    };
    localIdIndex.set(taskRef.localId, taskLedger);
  }
  return taskLedger;
}

function deleteCarrierAmountTaskLedgerIfEmpty(
  runtime: CarrierAmountSliceRuntime,
  taskLedger: CarrierAmountTaskLedger,
): void {
  if (taskLedger.claimsByClaimant.size > 0) return;

  const taskRef = taskLedger.taskRef;
  const namespaceIndex = runtime.bySystem.get(taskRef.system);
  const scopeKindIndex = namespaceIndex?.get(taskRef.namespace);
  const roomIndex = scopeKindIndex?.get(taskRef.scope.kind);
  const localIdIndex = roomIndex?.get(taskRef.scope.roomName);
  if (localIdIndex?.get(taskRef.localId) !== taskLedger) return;

  localIdIndex.delete(taskRef.localId);
  if (localIdIndex.size > 0) return;
  roomIndex?.delete(taskRef.scope.roomName);
  if ((roomIndex?.size ?? 0) > 0) return;
  scopeKindIndex?.delete(taskRef.scope.kind);
  if ((scopeKindIndex?.size ?? 0) > 0) return;
  namespaceIndex?.delete(taskRef.namespace);
  if ((namespaceIndex?.size ?? 0) > 0) return;
  runtime.bySystem.delete(taskRef.system);
}

function removeCarrierAmountClaim(
  taskLedger: CarrierAmountTaskLedger,
  claimantId: string,
  record: CarrierAmountSliceClaimRecord,
): boolean {
  if (taskLedger.claimsByClaimant.get(claimantId) !== record) return false;
  taskLedger.claimsByClaimant.delete(claimantId);

  const stepLedger = taskLedger.steps.get(record.stepId);
  if (stepLedger?.claims.get(claimantId) === record) {
    stepLedger.claims.delete(claimantId);
    if (stepLedger.claims.size === 0) {
      taskLedger.steps.delete(record.stepId);
    }
  }
  return true;
}

function pruneDeadCarrierAmountClaimants(
  taskLedger: CarrierAmountTaskLedger,
): void {
  for (const [claimantId, record] of taskLedger.claimsByClaimant) {
    if (!record.claimantWasLiveAtClaim || hasOwnLiveCreep(claimantId)) continue;
    removeCarrierAmountClaim(taskLedger, claimantId, record);
  }
}

function readTaskLimits(
  taskSteps: readonly CarrierAmountSliceStepBudget[],
  stepId: string,
): { readonly stepLimit: number; readonly taskLimit: number } | undefined {
  if (!Array.isArray(taskSteps) || typeof stepId !== "string" || stepId.length === 0) {
    return undefined;
  }

  let stepLimit = 0;
  let taskLimit = 0;
  let foundStep = false;
  try {
    for (const taskStep of taskSteps) {
      const amount = normalizeAmount(taskStep.amount);
      taskLimit = addAmount(taskLimit, amount);
      if (!foundStep && taskStep.id === stepId) {
        foundStep = true;
        stepLimit = amount;
      }
    }
  } catch {
    return undefined;
  }

  if (!foundStep || stepLimit <= 0 || taskLimit <= 0) return undefined;
  return { stepLimit, taskLimit };
}

/**
 * Claims one same-tick execution budget. It deliberately does not represent
 * carrying, delivery, progress, or a cross-tick lease.
 */
export function claimCarrierAmountSlice(
  request: CarrierAmountSliceClaimRequest,
): CarrierAmountSliceClaim | null {
  const taskRef = cloneCarrierDispatchRef(request.taskRef);
  const requestedAmount = normalizeAmount(request.requestedAmount);
  if (
    !taskRef
    || typeof request.claimantId !== "string"
    || request.claimantId.length === 0
    || requestedAmount <= 0
  ) {
    return null;
  }

  const limits = readTaskLimits(request.taskSteps, request.stepId);
  if (!limits) return null;
  const stepId = request.stepId;
  const claimantId = request.claimantId;
  const runtime = ensureCarrierAmountSliceRuntime();
  const taskLedger = ensureCarrierAmountTaskLedger(runtime, taskRef);
  pruneDeadCarrierAmountClaimants(taskLedger);
  if (taskLedger.claimsByClaimant.has(claimantId)) return null;

  let taskClaimed = 0;
  for (const record of taskLedger.claimsByClaimant.values()) {
    taskClaimed = addAmount(taskClaimed, record.amount);
  }

  const existingStepLedger = taskLedger.steps.get(stepId);
  let stepClaimed = 0;
  if (existingStepLedger) {
    for (const record of existingStepLedger.claims.values()) {
      stepClaimed = addAmount(stepClaimed, record.amount);
    }
  }

  const amount = Math.min(
    requestedAmount,
    Math.max(0, limits.taskLimit - taskClaimed),
    Math.max(0, limits.stepLimit - stepClaimed),
  );
  if (amount <= 0) return null;

  const stepLedger = existingStepLedger ?? {
    stepId,
    claims: new Map<string, CarrierAmountSliceClaimRecord>(),
  };
  if (!existingStepLedger) {
    taskLedger.steps.set(stepId, stepLedger);
  }
  const record: CarrierAmountSliceClaimRecord = {
    stepId,
    amount,
    committed: false,
    claimantWasLiveAtClaim: hasOwnLiveCreep(claimantId),
  };
  taskLedger.claimsByClaimant.set(claimantId, record);
  stepLedger.claims.set(claimantId, record);

  const isCurrentRecord = (): boolean =>
    runtimeGlobal.__carrierTaskClaims === runtime
    && runtime.tick === Game.time
    && runtime.game === Game
    && getCarrierAmountTaskLedger(runtime, taskLedger.taskRef) === taskLedger
    && taskLedger.claimsByClaimant.get(claimantId) === record
    && taskLedger.steps.get(stepId) === stepLedger
    && stepLedger.claims.get(claimantId) === record;

  return {
    amount,
    commit(): void {
      if (!isCurrentRecord()) return;
      record.committed = true;
    },
    release(): void {
      if (!isCurrentRecord() || record.committed) return;
      removeCarrierAmountClaim(taskLedger, claimantId, record);
      deleteCarrierAmountTaskLedgerIfEmpty(runtime, taskLedger);
    },
  };
}

/**
 * Board deletion releases only intents that have not been accepted. Committed
 * slices remain until tick/Game rollover so same-tick republish cannot execute
 * the already accepted amount twice.
 */
export function releaseUncommittedCarrierAmountSlices(
  sourceRef: CarrierDispatchRef,
): void {
  const runtime = runtimeGlobal.__carrierTaskClaims;
  const taskRef = cloneCarrierDispatchRef(sourceRef);
  if (
    !runtime
    || runtime.tick !== Game.time
    || runtime.game !== Game
    || !(runtime.bySystem instanceof Map)
    || !taskRef
  ) {
    return;
  }

  const taskLedger = getCarrierAmountTaskLedger(runtime, taskRef);
  if (!taskLedger) return;
  for (const [claimantId, record] of taskLedger.claimsByClaimant) {
    if (record.committed) continue;
    removeCarrierAmountClaim(taskLedger, claimantId, record);
  }
  deleteCarrierAmountTaskLedgerIfEmpty(runtime, taskLedger);
}

export const carrierAmountSlicePort: CarrierAmountSlicePort = Object.freeze({
  claim: claimCarrierAmountSlice,
  releaseUncommitted: releaseUncommittedCarrierAmountSlices,
});

/** Removes the private runtime ledger during the existing board/global reset. */
export function clearCarrierAmountSlices(): void {
  delete runtimeGlobal.__carrierTaskClaims;
}

export const clearCarrierAmountSlicesForTest = clearCarrierAmountSlices;
