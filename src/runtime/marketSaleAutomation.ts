import {
  executeCancelOrder,
  executeCreateOrder,
  getTerminalActionClaims,
  hasTerminalActionClaim,
} from "@/runtime/marketActionArbiter";
import {
  enforceLegacyMarketSafetyLatch,
  resolveMarketSaleAutomationConfig,
  type MarketSaleAutomationConfig,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  directAutomationExposure,
  directAutomationSnapshotStatus,
  normalizeDirectAutomationState,
  resolveDirectAutomationPending,
  runDirectAutomationPlanning,
  runDirectAutomationPreflight,
  type DirectAutomationState,
  type DirectRuntimeCandidate,
} from "@/runtime/marketSaleDirectAutomation";
import {
  acceptMarketDirectContinuousPermit as acceptContinuousPermitState,
  defaultMarketDirectContinuousDependencies,
  marketDirectContinuousExposure,
  marketDirectContinuousStatus as projectContinuousDirectStatus,
  migrateLegacyDirectToContinuous,
  normalizeContinuousDirectState,
  proposeMarketDirectContinuousPermit as proposeContinuousPermitState,
  runMarketDirectContinuousPlanning,
  runMarketDirectContinuousPreflight,
  type ContinuousPendingProjection,
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousPermitRequest,
  type MarketDirectContinuousResult,
  type MarketDirectContinuousRuntimeCandidate,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
} from "@/runtime/marketDirectContinuousPolicy";
import { computeContinuousQuota } from "@/runtime/marketDirectContinuousLedger";
import {
  isResolvedDirectPendingCompatibilityAlias,
  recoverPendingDirectDeal,
  type OperatorDirectPendingEvidence,
  type PendingDirectDeal,
} from "@/runtime/marketSaleDirectPending";
import {
  calculateProspectiveFeeMilli,
  evaluatePostActionInvariant,
  findMinimumSafePrice,
  priceToMilliUp,
  roundMarketPriceUp,
} from "@/runtime/marketSalePricing";
import {
  evaluateMarketSaleCanaryPrerequisites,
  getMarketProtectionSellableAmount,
  isMarketProtectionEntryFresh,
  type MarketProtectionEntry,
} from "@/runtime/marketSaleProtection";
import {
  advanceFeeLedgerWindow,
  applyFillFeeDebt,
  commitProspectiveFeeReservation,
  createEmptyMarketSaleFeeLedger,
  getFeeLedgerTotals,
  markExternalOrderMutationFeeGap,
  reconcileDisappearedOrderFeeDebt,
  releaseProspectiveFeeReservation,
  reserveProspectiveFee,
  resolveDisappearedOrderFeeGap,
  resolveExternalOrderMutationFeeGap,
  takeCarriedFeeDebt,
  type MarketSaleFeeLedgerState,
} from "@/runtime/marketSaleFeeLedger";
import {
  attestPendingCreateOrder,
  createPendingCreateState,
  createPendingMutation,
  hashOrderIds,
  lockCanary,
  markPendingCreateSubmitted,
  markPendingMutationSubmitted,
  reconcilePendingCreate,
  reconcilePendingMutation,
  updateDrainState,
  type CanaryLock,
  type DrainState,
  type ManagedMarketOrderState,
  type MarketOrderSnapshot,
  type OrderMutationLease,
  type PendingCreateState,
  type PendingOrderMutation,
} from "@/runtime/marketSaleLifecycle";

const MAX_MARKET_ORDERS = 300;
const MAX_RECENT_ACTIONS = 20;
const MAX_AUDIT_ENTRIES = 50;
const MAX_FEE_EVENTS = 100;
const MAX_TRANSACTION_KEYS = 200;
const MAX_MANAGED_ORDER_SUMMARIES = 20;
const REQUIRED_SHADOW_CYCLES = 100;

export interface MarketSalePlanCandidate {
  roomName: string;
  resourceType: ResourceConstant;
  protectionEntry: MarketProtectionEntry;
  effectiveNetFloor: number;
  /** Pricing adapter history evidence; absent means no trustworthy observation. */
  historyTrusted?: boolean;
  historyCompleteDayCount?: number;
  historyAcceptedDayCount?: number;
  historyFloor?: number;
  ratchetFloor?: number;
  makerPrice?: number;
  /** Per-unit maker value after current and prospective fee debt. */
  makerNetPrice?: number;
  /** Direct 只使用历史/ratchet/底价证据，不继承 Maker SELL 深度门禁。 */
  directHistoryTrusted?: boolean;
  effectiveEnergyShadowPrice?: number;
  energyShadowObservedAt?: number;
  energyShadowComponents?: {
    hardFloor: number;
    explicit?: number;
    historyFloor?: number;
    ratchetFloor?: number;
  };
  directAdditionalRejectionReasons?: readonly string[];
  trustedPrice: boolean;
  trustedDepth: boolean;
  capacityState?: "normal" | "pressure" | "emergency";
  hasCriticalConflict?: boolean;
  isHubRoom?: boolean;
  minimumTerminalFreeCapacity?: number;
  /** Adapter-level fail-closed reasons retained for operator diagnostics. */
  additionalRejectionReasons?: readonly string[];
}

export interface MarketSaleAutomationInput {
  candidates?: readonly MarketSalePlanCandidate[];
  stagingAmount?: number;
  reservationAmount?: number;
  marketDomainActivityValid?: boolean;
}

export interface MarketSaleAutomationResult {
  requestedMode: MarketSaleAutomationConfig["mode"];
  effectiveMode: MarketSaleAutomationConfig["mode"];
  phase: DrainState["phase"];
  writes: number;
  actions: string[];
  rejectedByReason: Record<string, number>;
}

interface PendingCreateEvidence {
  creditsBefore?: number;
  terminalStockBefore?: number;
  outgoingKeysBefore?: string[];
  baselineOrderFingerprints?: Record<string, string>;
  operatorResolutionCandidateIds?: string[];
}

interface ExpansionGrant {
  configRevision: string;
  grantedAt: number;
}

type OwnedManagedOrder = Omit<
  ManagedMarketOrderState,
  "resourceType"
> & {
  resourceType: ResourceConstant;
  backoffUntil?: number;
};

type OwnedPendingCreate = Omit<PendingCreateState, "tuple"> &
  PendingCreateEvidence & {
    tuple: Omit<PendingCreateState["tuple"], "resourceType"> & {
      resourceType: ResourceConstant;
    };
  };

type OwnedCanaryLock = Omit<CanaryLock, "resourceType"> & {
  resourceType: ResourceConstant;
};

interface MarketSaleDataState {
  managedOrders: Record<string, OwnedManagedOrder>;
  pendingCreate?: OwnedPendingCreate;
  pendingMutations: Record<string, PendingOrderMutation>;
  feeEvents: Array<{
    id: string;
    tick: number;
    resource: ResourceConstant;
    amountMilli: number;
    kind: "create" | "extend" | "reprice" | "refund" | "carry";
  }>;
  feeLedger?: MarketSaleFeeLedgerState;
  carriedFeeDebtMilli: Partial<Record<ResourceConstant, number>>;
  trustedFloors: Partial<
    Record<
      ResourceConstant,
      { value: number; marketDate: string; updatedAt: number }
    >
  >;
  processedTransactionKeys: string[];
  canaryLock?: OwnedCanaryLock;
  drain?: DrainState;
  operatorAudit: Array<{
    tick: number;
    action: string;
    orderId?: string;
    requestId?: string;
    candidateIds?: string[];
  }>;
  directAutomation?:
    | DirectAutomationState
    | MarketDirectContinuousAutomationState;
  pendingDirectDeals?: Record<
    string,
    PendingDirectDeal | ContinuousPendingProjection
  >;
  /** Canonical stores for any market-sale-owned staged or reserved amount. */
  marketStaging?: unknown;
  marketReservations?: unknown;
  expansionGrant?: ExpansionGrant;
}

type MarketSaleRuntimeState = NonNullable<
  NonNullable<Memory["runtime"]>["marketSaleAutomation"]
> & {
  lastShadowCycleTick?: number;
  shadowConfigSignature?: string;
};

interface RunContext {
  config: ResolvedMarketSaleAutomationConfig;
  data: MarketSaleDataState;
  runtime: MarketSaleRuntimeState;
  liveOrders: MarketOrderSnapshot[];
  liveOrderById: Map<string, MarketOrderSnapshot>;
  actions: string[];
  rejectedByReason: Record<string, number>;
  writes: number;
  shadowPlanComplete: boolean;
  stagingAmount: number;
  reservationAmount: number;
  marketDomainActivityValid: boolean;
}

type OperatorResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown };

type OperatorGlobals = typeof global & {
  grantMarketSaleMutationLease?: (
    epoch: string,
    expiresAt: number,
  ) => OperatorResult;
  revokeMarketSaleMutationLease?: (reason?: string) => OperatorResult;
  attestMarketSalePendingCreate?: (orderId: string) => OperatorResult;
  resolveMarketSalePendingCreateAbsence?: (
    candidateIds: string[],
  ) => OperatorResult;
  resolveMarketSaleExternalOrderMutation?: (
    orderId: string,
    verifiedRemainingFeeDebtMilli: number,
  ) => OperatorResult;
  resolveMarketSaleOrderDisappearance?: (
    orderId: string,
    classification: "policy_cancelled" | "server_expired",
    verifiedRefundMilli?: number,
  ) => OperatorResult;
  expandMarketSaleCanary?: (configRevision: string) => OperatorResult;
  emergencyStopMarketSaleAutomation?: (reason?: string) => OperatorResult;
  marketSaleAutomationStatus?: () => unknown;
  resolveMarketSaleDirectPending?: (
    evidence: OperatorDirectPendingEvidence,
  ) => OperatorResult;
  proposeMarketDirectContinuousPermit?: (
    request: MarketDirectContinuousPermitRequest,
  ) => OperatorResult;
  acceptMarketDirectContinuousPermit?: (
    permitId: string,
  ) => OperatorResult;
  marketDirectContinuousStatus?: () => unknown;
};

const operatorGlobals = global as OperatorGlobals;

function boundedPush<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export interface MarketSaleDomainActivity {
  stagingAmount: number;
  reservationAmount: number;
  valid: boolean;
}

function sumDomainActivity(
  value: unknown,
): { amount: number; valid: boolean } {
  if (value === undefined) return { amount: 0, valid: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { amount: 1, valid: false };
  }
  let amount = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.length === 0 ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      return { amount: 1, valid: false };
    }
    const candidate = (entry as { amount?: unknown }).amount;
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) <= 0 ||
      !Number.isSafeInteger(amount + (candidate as number))
    ) {
      return { amount: 1, valid: false };
    }
    amount += candidate as number;
  }
  return { amount, valid: true };
}

/**
 * Canonical live evidence for market-sale-owned staging/reservation. No
 * previous bundle produced these stores, so absence is an empty migration;
 * malformed state is conservatively projected as non-zero.
 */
export function collectMarketSaleDomainActivity(
  value: unknown,
): MarketSaleDomainActivity {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as {
          marketStaging?: unknown;
          marketReservations?: unknown;
        })
      : undefined;
  const staging = sumDomainActivity(data?.marketStaging);
  const reservations = sumDomainActivity(data?.marketReservations);
  return {
    stagingAmount: staging.amount,
    reservationAmount: reservations.amount,
    valid: staging.valid && reservations.valid,
  };
}

function quarantinedDirectPendingAlias(
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { "__compatibility_alias__": value };
  }
  const quarantined: Record<string, unknown> = {};
  for (const [requestId, pending] of Object.entries(value)) {
    if (!recoverPendingDirectDeal(pending, requestId)) {
      quarantined[requestId] = pending;
    }
  }
  return quarantined;
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}

function isContinuousDirectState(
  value: unknown,
): value is MarketDirectContinuousAutomationState {
  return Boolean(
    isPlainRecord(value) &&
      value.schemaVersion === MARKET_DIRECT_CONTINUOUS_SCHEMA &&
      value.capability === MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  );
}

function isLegacyDirectState(
  value: unknown,
): value is DirectAutomationState {
  return Boolean(
    isPlainRecord(value) &&
      value.schemaVersion === 1 &&
      value.capability === undefined,
  );
}

function canonicalMemoryEvidence(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : JSON.parse(serialized);
  } catch {
    return {
      invalidEvidenceType:
        value === null ? "null" : typeof value,
    };
  }
}

function continuousStateHasCoreContainers(
  value: unknown,
): value is MarketDirectContinuousAutomationState {
  if (!isContinuousDirectState(value)) return false;
  const ledger = value.ledger as unknown;
  return Boolean(
    isPlainRecord(ledger) &&
      Array.isArray(ledger.receipts) &&
      Array.isArray(ledger.outcomes) &&
      Array.isArray(ledger.processedEvidenceKeys) &&
      isPlainRecord(ledger.checkpoint) &&
      isPlainRecord(ledger.lifetimeConfirmed) &&
      isPlainRecord(value.permitChain) &&
      isPlainRecord(value.lifecycleByEntry) &&
      isPlainRecord(value.pendingDirectDeals) &&
      isPlainRecord(value.quarantinedPendingDirectDeals),
  );
}

function normalizeContinuousForStorage(
  raw: unknown,
  tick: number,
): MarketDirectContinuousAutomationState {
  const evidence = canonicalMemoryEvidence(raw);
  let normalized: MarketDirectContinuousAutomationState;
  try {
    normalized = normalizeContinuousDirectState(
      continuousStateHasCoreContainers(evidence)
        ? evidence
        : { invalidContinuousState: evidence },
      tick,
    );
  } catch {
    normalized = normalizeContinuousDirectState(
      { invalidContinuousState: evidence },
      tick,
    );
  }
  return continuousStateHasCoreContainers(normalized)
    ? normalized
    : normalizeContinuousDirectState(
        {
          invalidContinuousNormalizerResult:
            canonicalMemoryEvidence(normalized),
        },
        tick,
      );
}

function createBaseMarketSaleDataState(): MarketSaleDataState {
  return {
    managedOrders: {},
    pendingMutations: {},
    feeEvents: [],
    carriedFeeDebtMilli: {},
    trustedFloors: {},
    processedTransactionKeys: [],
    operatorAudit: [],
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRoomName(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    /^[WE]\d+[NS]\d+$/.test(value)
  );
}

function isResourceConstant(
  value: unknown,
): value is ResourceConstant {
  return (
    typeof value === "string" &&
    RESOURCES_ALL.includes(value as ResourceConstant)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isNonEmptyString(entry))
  );
}

function isRecoverableManagedOrder(
  value: unknown,
  orderId: string,
): value is OwnedManagedOrder {
  if (!isPlainRecord(value)) return false;
  const externalGap = value.externalMutationGap;
  const disappearanceGap = value.disappearanceGap;
  const exposureInvariant =
    externalGap === undefined
      ? value.remainingExposure === value.lastRemainingAmount
      : isPlainRecord(externalGap) &&
        value.remainingExposure ===
          externalGap.conservativeExposure &&
        (value.remainingExposure as number) >=
          (value.lastRemainingAmount as number);
  return Boolean(
    value.orderId === orderId &&
      isRoomName(value.roomName) &&
      isResourceConstant(value.resourceType) &&
      isPositiveFiniteNumber(value.price) &&
      isNonNegativeSafeInteger(value.originalAmount) &&
      value.originalAmount > 0 &&
      isNonNegativeSafeInteger(value.lastRemainingAmount) &&
      value.lastRemainingAmount <= value.originalAmount &&
      isNonNegativeSafeInteger(value.remainingExposure) &&
      isNonNegativeSafeInteger(value.feeDebtMilli) &&
      isNonNegativeSafeInteger(value.createdAt) &&
      isNonNegativeSafeInteger(value.lastSeenAt) &&
      (value.lastFillAt === undefined ||
        isNonNegativeSafeInteger(value.lastFillAt)) &&
      isNonNegativeSafeInteger(value.policyCancelAtTick) &&
      isNonNegativeSafeInteger(value.serverCreatedTick) &&
      (value.backoffUntil === undefined ||
        isNonNegativeSafeInteger(value.backoffUntil)) &&
      exposureInvariant &&
      !(
        externalGap !== undefined &&
        disappearanceGap !== undefined
      ) &&
      (externalGap === undefined ||
        (isPlainRecord(externalGap) &&
          isNonNegativeSafeInteger(externalGap.detectedAt) &&
          isPositiveFiniteNumber(externalGap.expectedPrice) &&
          isPositiveFiniteNumber(externalGap.observedPrice) &&
          isNonNegativeSafeInteger(
            externalGap.expectedTotalAmount,
          ) &&
          (externalGap.observedTotalAmount === undefined ||
            isNonNegativeSafeInteger(
              externalGap.observedTotalAmount,
            )) &&
          isNonNegativeSafeInteger(
            externalGap.conservativeExposure,
          ))) &&
      (disappearanceGap === undefined ||
        (isPlainRecord(disappearanceGap) &&
          isNonNegativeSafeInteger(disappearanceGap.detectedAt) &&
          (disappearanceGap.reason === "unknown_disappearance" ||
            disappearanceGap.reason ===
              "server_expiry_refund_mismatch"))),
  );
}

function isRecoverablePendingMutation(
  value: unknown,
  orderId: string,
): value is PendingOrderMutation {
  if (!isPlainRecord(value)) return false;
  const pre = value.pre;
  const requested = value.requested;
  const requestedExposure =
    isPlainRecord(pre) &&
    isNonNegativeSafeInteger(pre.remainingAmount) &&
    isPlainRecord(requested) &&
    value.kind === "extend" &&
    isNonNegativeSafeInteger(requested.addAmount)
      ? pre.remainingAmount + requested.addAmount
      : isPlainRecord(pre)
        ? pre.remainingAmount
        : undefined;
  let expectedProspectiveFeeMilli: number | undefined;
  try {
    if (value.kind === "cancel") {
      expectedProspectiveFeeMilli = 0;
    } else if (
      value.kind === "extend" &&
      isPlainRecord(pre) &&
      isPositiveFiniteNumber(pre.price) &&
      isNonNegativeSafeInteger(pre.remainingAmount) &&
      isPlainRecord(requested) &&
      isNonNegativeSafeInteger(requested.addAmount) &&
      requested.addAmount > 0
    ) {
      expectedProspectiveFeeMilli =
        calculateProspectiveFeeMilli({
          kind: "extend",
          currentPrice: pre.price,
          currentRemainingAmount: pre.remainingAmount,
          addAmount: requested.addAmount,
        });
    } else if (
      value.kind === "reprice" &&
      isPlainRecord(pre) &&
      isPositiveFiniteNumber(pre.price) &&
      isNonNegativeSafeInteger(pre.remainingAmount) &&
      isPlainRecord(requested) &&
      isPositiveFiniteNumber(requested.price)
    ) {
      expectedProspectiveFeeMilli =
        requested.price > pre.price
          ? calculateProspectiveFeeMilli(
              {
                kind: "repriceUp",
                currentPrice: pre.price,
                remainingAmount: pre.remainingAmount,
              },
              requested.price,
            )
          : calculateProspectiveFeeMilli(
              {
                kind: "repriceDown",
                currentPrice: pre.price,
                remainingAmount: pre.remainingAmount,
              },
              requested.price,
            );
    }
  } catch {
    expectedProspectiveFeeMilli = undefined;
  }
  return Boolean(
    value.orderId === orderId &&
      (value.kind === "cancel" ||
        value.kind === "extend" ||
        value.kind === "reprice") &&
      isNonNegativeSafeInteger(value.requestedAt) &&
      isPlainRecord(pre) &&
      isPositiveFiniteNumber(pre.price) &&
      isNonNegativeSafeInteger(pre.totalAmount) &&
      isNonNegativeSafeInteger(pre.remainingAmount) &&
      pre.remainingAmount <= pre.totalAmount &&
      (pre.active === undefined ||
        typeof pre.active === "boolean") &&
      isPlainRecord(requested) &&
      (requested.price === undefined ||
        isPositiveFiniteNumber(requested.price)) &&
      (requested.addAmount === undefined ||
        (isNonNegativeSafeInteger(requested.addAmount) &&
          requested.addAmount > 0)) &&
      ((value.kind === "cancel" &&
        requested.price === undefined &&
        requested.addAmount === undefined) ||
        (value.kind === "extend" &&
          requested.price === undefined &&
          isNonNegativeSafeInteger(requested.addAmount) &&
          requested.addAmount > 0) ||
        (value.kind === "reprice" &&
          isPositiveFiniteNumber(requested.price) &&
          requested.addAmount === undefined)) &&
      isNonNegativeSafeInteger(value.prospectiveFeeMilli) &&
      value.prospectiveFeeMilli ===
        expectedProspectiveFeeMilli &&
      isNonNegativeSafeInteger(value.conservativeExposure) &&
      isNonNegativeSafeInteger(requestedExposure) &&
      value.conservativeExposure >= requestedExposure &&
      (value.status === "prepared" ||
        value.status === "submitted" ||
        value.status === "reconcile_gap"),
  );
}

function isRecoverablePendingCreate(
  value: unknown,
): value is OwnedPendingCreate {
  if (!isPlainRecord(value)) return false;
  const tuple = value.tuple;
  const audit = value.audit;
  const baselineFingerprints = value.baselineOrderFingerprints;
  const baselineOrderIds = value.baselineOrderIds;
  const baselineOrderIdsCanonical =
    isStringArray(baselineOrderIds) &&
    new Set(baselineOrderIds).size === baselineOrderIds.length &&
    baselineOrderIds.every(
      (entry, index) =>
        entry === [...baselineOrderIds].sort()[index],
    );
  const baselineFingerprintKeys =
    isPlainRecord(baselineFingerprints)
      ? Object.keys(baselineFingerprints).sort()
      : [];
  let expectedCreateFeeMilli: number | undefined;
  try {
    if (
      isPlainRecord(tuple) &&
      isNonNegativeSafeInteger(tuple.totalAmount) &&
      tuple.totalAmount > 0 &&
      isPositiveFiniteNumber(tuple.price)
    ) {
      expectedCreateFeeMilli =
        calculateProspectiveFeeMilli(
          {
            kind: "create",
            amount: tuple.totalAmount,
          },
          tuple.price,
        );
    }
  } catch {
    expectedCreateFeeMilli = undefined;
  }
  return Boolean(
    isNonEmptyString(value.requestId) &&
      isNonNegativeSafeInteger(value.requestedAt) &&
      baselineOrderIdsCanonical &&
      isNonEmptyString(value.baselineHash) &&
      value.baselineHash === hashOrderIds(baselineOrderIds) &&
      isNonEmptyString(value.leaseEpoch) &&
      isPlainRecord(tuple) &&
      tuple.type === ORDER_SELL &&
      isResourceConstant(tuple.resourceType) &&
      isRoomName(tuple.roomName) &&
      isPositiveFiniteNumber(tuple.price) &&
      isNonNegativeSafeInteger(tuple.totalAmount) &&
      tuple.totalAmount > 0 &&
      isNonNegativeSafeInteger(tuple.createdNotBefore) &&
      isNonNegativeSafeInteger(tuple.createdNotAfter) &&
      tuple.createdNotBefore === value.requestedAt &&
      tuple.createdNotAfter === value.requestedAt + 2 &&
      isNonNegativeSafeInteger(value.feeMilli) &&
      value.feeMilli === expectedCreateFeeMilli &&
      isNonNegativeSafeInteger(value.exposure) &&
      value.exposure === tuple.totalAmount &&
      isNonNegativeSafeInteger(value.zeroDeltaConfirmations) &&
      (value.lastZeroDeltaTick === undefined ||
        isNonNegativeSafeInteger(value.lastZeroDeltaTick)) &&
      ((value.zeroDeltaConfirmations === 0 &&
        value.lastZeroDeltaTick === undefined) ||
        (value.zeroDeltaConfirmations > 0 &&
          value.lastZeroDeltaTick !== undefined)) &&
      (value.status === "prepared" ||
        value.status === "submitted" ||
        value.status === "ambiguous") &&
      Array.isArray(audit) &&
      audit.every(
        (entry) =>
          isPlainRecord(entry) &&
          isNonNegativeSafeInteger(entry.tick) &&
          isNonEmptyString(entry.action) &&
          isStringArray(entry.candidateIds),
      ) &&
      typeof value.creditsBefore === "number" &&
          Number.isFinite(value.creditsBefore) &&
          value.creditsBefore >= 0 &&
      isNonNegativeSafeInteger(value.terminalStockBefore) &&
      isStringArray(value.outgoingKeysBefore) &&
      isPlainRecord(baselineFingerprints) &&
          Object.values(baselineFingerprints).every(
            (entry) => typeof entry === "string",
          ) &&
      baselineFingerprintKeys.length === baselineOrderIds.length &&
      baselineFingerprintKeys.every(
        (entry, index) => entry === baselineOrderIds[index],
      ) &&
      (value.operatorResolutionCandidateIds === undefined ||
        isStringArray(value.operatorResolutionCandidateIds)),
  );
}

function recoverMarketStateRecord<T extends object>(
  value: unknown,
  containerSentinel: string,
  entrySentinelPrefix: string,
  quarantine: Record<string, unknown>,
  isRecoverable: (entry: unknown, key: string) => entry is T,
): Record<string, T> {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    quarantine[containerSentinel] = value;
    return {};
  }
  const recovered: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || !isRecoverable(entry, key)) {
      quarantine[`${entrySentinelPrefix}:${key || "<empty>"}`] =
        entry;
      continue;
    }
    recovered[key] = entry as T;
  }
  return recovered;
}

function ensureDataState(): MarketSaleDataState {
  if (!Memory.data) Memory.data = {};
  const rawMarketSaleAutomation =
    Memory.data.marketSaleAutomation as unknown;
  if (rawMarketSaleAutomation === undefined) {
    Memory.data.marketSaleAutomation =
      createBaseMarketSaleDataState() as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >;
  } else if (!isPlainRecord(rawMarketSaleAutomation)) {
    const direct = normalizeDirectAutomationState(undefined);
    direct.quarantinedPendingDirectDeals[
      "__market_sale_automation_container__"
    ] = rawMarketSaleAutomation;
    direct.migrationBlockedReason =
      "market_sale_automation_container_invalid";
    Memory.data.marketSaleAutomation = {
      ...createBaseMarketSaleDataState(),
      pendingDirectDeals: direct.pendingDirectDeals,
      directAutomation: direct,
    } as unknown as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >;
  }
  const data = Memory.data.marketSaleAutomation as unknown as MarketSaleDataState;
  const quarantinedMarketState: Record<string, unknown> = {};
  const recoveredManagedOrders =
    recoverMarketStateRecord<OwnedManagedOrder>(
    data.managedOrders as unknown,
    "__managed_orders_container__",
    "__managed_order__",
    quarantinedMarketState,
    isRecoverableManagedOrder,
  );
  const recoveredPendingMutations =
    recoverMarketStateRecord<PendingOrderMutation>(
      data.pendingMutations as unknown,
      "__pending_mutations_container__",
      "__pending_mutation__",
      quarantinedMarketState,
      isRecoverablePendingMutation,
    );
  const rawPendingMutationRecord = isPlainRecord(
    data.pendingMutations as unknown,
  )
    ? (data.pendingMutations as unknown as Record<string, unknown>)
    : {};
  for (const orderId of Object.keys(
    recoveredPendingMutations,
  )) {
    if (recoveredManagedOrders[orderId]) continue;
    quarantinedMarketState[
      `__orphan_pending_mutation__:${orderId}`
    ] =
      rawPendingMutationRecord[orderId] ??
      recoveredPendingMutations[orderId];
    delete recoveredPendingMutations[orderId];
  }
  const rawPendingCreate = data.pendingCreate as unknown;
  let recoveredPendingCreate: OwnedPendingCreate | undefined;
  if (
    rawPendingCreate !== undefined &&
    !isRecoverablePendingCreate(rawPendingCreate)
  ) {
    quarantinedMarketState["__pending_create__"] =
      rawPendingCreate;
  } else {
    recoveredPendingCreate =
      rawPendingCreate as OwnedPendingCreate | undefined;
  }
  data.feeEvents ||= [];
  data.feeLedger ||= createEmptyMarketSaleFeeLedger();
  data.carriedFeeDebtMilli ||= {};
  data.trustedFloors ||= {};
  data.processedTransactionKeys ||= [];
  data.operatorAudit ||= [];
  data.drain ||= { phase: "off", zeroConfirmations: 0 };
  if (data.marketStaging === undefined) data.marketStaging = {};
  if (data.marketReservations === undefined) {
    data.marketReservations = {};
  }
  const rawDirectAutomation =
    data.directAutomation as unknown;
  let normalizedDirect:
    | DirectAutomationState
    | MarketDirectContinuousAutomationState;
  if (isContinuousDirectState(rawDirectAutomation)) {
    // v2 绝不能经过 legacy normalizer，否则 schema/capability、permit/WAL
    // 会被旧版“修复”为一个看似可写的 v1 空状态。
    normalizedDirect = normalizeContinuousForStorage(
      rawDirectAutomation,
      Game.time,
    );
  } else if (isLegacyDirectState(rawDirectAutomation)) {
    // 只有 schema=1 且无 v2 capability 的 canonical 才允许先按 v1
    // 精确归一化，再由确定性 golden migration 尝试升级。任何 alias
    // 分叉先固化为 blocker，不能把兼容投影合并回 canonical WAL。
    const legacy = normalizeDirectAutomationState(
      rawDirectAutomation,
    );
    const compatibilityPending =
      data.pendingDirectDeals as unknown;
    const compatibilityMatchesCanonical =
      compatibilityPending === undefined ||
      compatibilityPending === legacy.pendingDirectDeals ||
      JSON.stringify(compatibilityPending) ===
        JSON.stringify(legacy.pendingDirectDeals) ||
      isResolvedDirectPendingCompatibilityAlias(
        compatibilityPending,
        legacy.directDealOutcomes,
      );
    if (!compatibilityMatchesCanonical) {
      legacy.quarantinedPendingDirectDeals = {
        ...quarantinedDirectPendingAlias(
          compatibilityPending,
        ),
        ...legacy.quarantinedPendingDirectDeals,
      };
      legacy.migrationBlockedReason =
        "direct_pending_alias_mismatch";
    }
    normalizedDirect = normalizeContinuousForStorage(
      migrateLegacyDirectToContinuous(
        canonicalMemoryEvidence(
          legacy,
        ) as DirectAutomationState,
        Game.time,
      ),
      Game.time,
    );
  } else {
    // 新 bundle 不再把 missing/unknown Direct state 初始化成可写 v1。
    // canonical 与兼容 alias 一并进入 blocked evidence；禁止覆盖掉一个
    // 可能代表 CPU-cut 中间态的旧 pending。
    const compatibilityPending =
      data.pendingDirectDeals as unknown;
    const safeEmptyCompatibility =
      compatibilityPending === undefined ||
      (isPlainRecord(compatibilityPending) &&
        Object.keys(compatibilityPending).length === 0);
    normalizedDirect = normalizeContinuousForStorage(
      rawDirectAutomation === undefined &&
        safeEmptyCompatibility
        ? undefined
        : {
            canonicalDirectState:
              rawDirectAutomation,
            compatibilityPending,
          },
      Game.time,
    );
  }
  // pendingDirectDeals 只是回滚/保护账本兼容投影；canonical v2 永远覆盖
  // alias，禁止把旧 alias 反向合并进 permit/WAL。
  data.pendingDirectDeals =
    normalizedDirect.pendingDirectDeals;
  data.directAutomation = normalizedDirect;
  let committedDirect = data.directAutomation!;
  if (Object.keys(quarantinedMarketState).length > 0) {
    const existingBlocker =
      committedDirect.migrationBlockedReason;
    committedDirect = {
      ...committedDirect,
      quarantinedPendingDirectDeals: {
      ...quarantinedMarketState,
        ...committedDirect.quarantinedPendingDirectDeals,
      },
      migrationBlockedReason:
        !existingBlocker ||
        existingBlocker ===
          "direct_qualification_state_invalid"
          ? "market_sale_data_state_invalid"
          : existingBlocker,
    };
  }
  const committedData: MarketSaleDataState = {
    ...data,
    managedOrders: recoveredManagedOrders,
    pendingMutations: recoveredPendingMutations,
    pendingCreate: recoveredPendingCreate,
    pendingDirectDeals: committedDirect.pendingDirectDeals,
    directAutomation: committedDirect,
  };
  // 右值先完整构造，最后以单次 canonical container assignment 作为
  // commit marker。CPU 若在它之前中断，原始损坏记录仍在；若在它之后
  // 中断，quarantine/blocker 与 typed 清理已经不可分割地同时落盘。
  Memory.data.marketSaleAutomation =
    committedData as unknown as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >;
  // 保护账本和 carrier 仍读取兼容字段；正常返回时它与 Direct WAL
  // 使用同一对象，写入顺序同时覆盖 CPU 截断恢复。
  return committedData;
}

function ensureRuntimeState(): MarketSaleRuntimeState {
  if (!Memory.runtime) Memory.runtime = {};
  const previous = Memory.runtime.marketSaleAutomation as
    | MarketSaleRuntimeState
    | undefined;
  if (previous) return previous;
  const runtime: MarketSaleRuntimeState = {
    updatedAt: Game.time,
    requestedMode: "off",
    phase: "off",
    shadowConsecutiveCycles: 0,
    zeroConfirmations: 0,
    managedOrderCount: 0,
    pendingCreateCount: 0,
    pendingMutationCount: 0,
    stagingAmount: 0,
    reservationAmount: 0,
    exposureAmount: 0,
    rollingFeeMilli: 0,
    terminalClaims: [],
    rejectedByReason: {},
    candidates: {},
    recentActions: [],
    safetyViolationCount: 0,
  };
  Memory.runtime.marketSaleAutomation = runtime;
  return runtime;
}

function appendAudit(
  data: MarketSaleDataState,
  entry: {
    action: string;
    orderId?: string;
    requestId?: string;
    candidateIds?: string[];
  },
): void {
  boundedPush(
    data.operatorAudit,
    { tick: Game.time, ...entry },
    MAX_AUDIT_ENTRIES,
  );
}

function readLiveOrders(): MarketOrderSnapshot[] {
  const orders = Game.market?.orders;
  if (!orders || typeof orders !== "object") return [];
  return Object.values(orders)
    .filter((order): order is Order => Boolean(order && typeof order.id === "string"))
    .map((order) => ({
      id: order.id,
      type: order.type,
      resourceType: order.resourceType,
      roomName: order.roomName,
      price: order.price,
      totalAmount: order.totalAmount,
      remainingAmount: order.remainingAmount,
      amount: order.amount,
      created: order.created,
      active: order.active,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function orderFingerprint(order: MarketOrderSnapshot): string {
  return [
    order.id,
    order.type,
    order.resourceType,
    order.roomName || "",
    order.price,
    order.totalAmount ?? "",
    order.created,
  ].join("|");
}

function makeContext(): RunContext {
  const config = resolveMarketSaleAutomationConfig();
  const data = ensureDataState();
  const domainActivity = collectMarketSaleDomainActivity(data);
  const runtime = ensureRuntimeState();
  const liveOrders = readLiveOrders();
  return {
    config,
    data,
    runtime,
    liveOrders,
    liveOrderById: new Map(liveOrders.map((order) => [order.id, order])),
    actions: [],
    rejectedByReason: {},
    writes: 0,
    shadowPlanComplete: false,
    stagingAmount: domainActivity.stagingAmount,
    reservationAmount: domainActivity.reservationAmount,
    marketDomainActivityValid: domainActivity.valid,
  };
}

function reject(context: RunContext, reason: string): void {
  context.rejectedByReason[reason] =
    (context.rejectedByReason[reason] || 0) + 1;
}

function usesDirectStrategy(
  config: MarketSaleAutomationConfig,
): boolean {
  return (
    config.mode === "direct" ||
    (config.mode === "shadow" && config.shadowStrategy === "direct")
  );
}

function mergeDirectResult(
  context: RunContext,
  result:
    | ReturnType<typeof runDirectAutomationPlanning>
    | MarketDirectContinuousResult,
): void {
  context.writes += result.writes;
  for (const action of result.actions) recordAction(context, action);
  for (const [reason, count] of Object.entries(result.rejectedByReason)) {
    context.rejectedByReason[reason] =
      (context.rejectedByReason[reason] || 0) +
      nonNegativeInteger(count);
  }
}

function directCandidateRejectionReasons(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
): string[] {
  const reasons = new Set<string>();
  const entry = candidate.protectionEntry;
  const terminal = roomTerminal(candidate.roomName);
  const terminalEnergy =
    terminal?.store.getUsedCapacity(RESOURCE_ENERGY);
  for (const reason of candidate.directAdditionalRejectionReasons || []) {
    const normalized =
      typeof reason === "string" ? reason.trim().slice(0, 120) : "";
    if (normalized) reasons.add(normalized);
  }
  if (!isMarketProtectionEntryFresh(entry, Game.time)) {
    reasons.add("direct_protection_not_current");
  }
  if (!context.config.sellResources.includes(candidate.resourceType)) {
    reasons.add("direct_resource_not_allowed");
  }
  if (candidate.hasCriticalConflict || entry.blocked) {
    reasons.add("direct_critical_conflict");
  }
  if (candidate.capacityState === undefined) {
    reasons.add("direct_capacity_state_unknown");
  } else if (candidate.capacityState === "emergency") {
    reasons.add("direct_capacity_emergency");
  }
  if (candidate.isHubRoom === undefined) {
    reasons.add("direct_hub_state_unknown");
  } else if (candidate.isHubRoom) {
    reasons.add("direct_hub_room_blocked");
  }
  if (!terminal) {
    reasons.add("direct_terminal_missing");
  } else {
    if (
      !Number.isSafeInteger(terminal.cooldown) ||
      terminal.cooldown !== 0
    ) {
      reasons.add("direct_terminal_cooldown");
    }
    if (
      !Number.isSafeInteger(terminalEnergy) ||
      terminalEnergy! < context.config.terminalEnergyReserve
    ) {
      reasons.add("direct_terminal_energy_unsafe");
    }
  }
  if (
    !Number.isFinite(candidate.effectiveNetFloor) ||
    candidate.effectiveNetFloor <= 0
  ) {
    reasons.add("direct_effective_floor_invalid");
  }
  if (candidate.directHistoryTrusted !== true) {
    reasons.add("direct_history_untrusted");
  }
  if (
    !Number.isFinite(candidate.effectiveEnergyShadowPrice) ||
    candidate.energyShadowObservedAt === undefined ||
    !candidate.energyShadowComponents
  ) {
    reasons.add("direct_energy_shadow_untrusted");
  }
  return [...reasons].sort();
}

function toDirectRuntimeCandidates(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): DirectRuntimeCandidate[] {
  return candidates.map((candidate) => {
    const terminal = roomTerminal(candidate.roomName);
    const terminalEnergy =
      terminal?.store.getUsedCapacity(RESOURCE_ENERGY);
    return {
      roomName: candidate.roomName,
      resourceType: candidate.resourceType,
      protectionRevision: candidate.protectionEntry.revision,
      observedAt: candidate.protectionEntry.observedAt,
      expiresAt: candidate.protectionEntry.expiresAt,
      sellableAmount: getMarketProtectionSellableAmount(
        candidate.protectionEntry,
        Game.time,
      ),
      terminalStock: candidate.protectionEntry.terminalStock,
      terminalCooldown: terminal?.cooldown,
      terminalEnergy:
        typeof terminalEnergy === "number"
          ? terminalEnergy
          : undefined,
      protectedAmount: candidate.protectionEntry.protectedAmount,
      effectiveNetFloor: candidate.effectiveNetFloor,
      directHistoryTrusted: candidate.directHistoryTrusted === true,
      effectiveEnergyShadowPrice:
        candidate.effectiveEnergyShadowPrice,
      energyShadowObservedAt: candidate.energyShadowObservedAt,
      energyShadowComponents: candidate.energyShadowComponents,
      capacityState: candidate.capacityState,
      isHubRoom: candidate.isHubRoom,
      rejectionReasons: directCandidateRejectionReasons(
        context,
        candidate,
      ),
    };
  });
}

function toContinuousRuntimeCandidates(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): MarketDirectContinuousRuntimeCandidate[] {
  return candidates.map((candidate) => ({
    roomName: candidate.roomName,
    resourceType: candidate.resourceType,
    historyTrusted: candidate.directHistoryTrusted === true,
    historyFloor: candidate.historyFloor,
    ratchetFloor: candidate.ratchetFloor,
    effectiveNetFloor: candidate.effectiveNetFloor,
    effectiveEnergyShadowPrice:
      candidate.effectiveEnergyShadowPrice,
    energyShadowObservedAt: candidate.energyShadowObservedAt,
    energyShadowComponents:
      candidate.energyShadowComponents,
    capacityState: candidate.capacityState,
    isHubRoom: candidate.isHubRoom,
    rejectionReasons: directCandidateRejectionReasons(
      context,
      candidate,
    ),
  }));
}

function makerExposurePresent(
  context: RunContext,
): boolean {
  return Boolean(
    Object.keys(context.data.managedOrders).length > 0 ||
      context.data.pendingCreate ||
      Object.keys(context.data.pendingMutations).length > 0 ||
      context.data.feeLedger?.reconcileGap ||
      Object.values(context.data.managedOrders).some(
        (managed) =>
          managed.externalMutationGap !== undefined ||
          managed.disappearanceGap !== undefined,
      ) ||
      context.stagingAmount > 0 ||
      context.reservationAmount > 0,
  );
}

function structuralMarketSaleWriteBlocker(
  data: MarketSaleDataState,
  config: MarketSaleAutomationConfig,
): string | undefined {
  const direct = data.directAutomation;
  if (!direct) return "direct_state_missing";
  if (isContinuousDirectState(direct)) {
    const quarantineKeys = Object.keys(
      direct.quarantinedPendingDirectDeals,
    );
    const inactiveMissingState =
      !usesDirectStrategy(config) &&
      direct.migrationStatus === "blocked" &&
      direct.migrationBlockedReason === "direct_state_missing" &&
      direct.ledger.blocker?.code === "direct_state_missing" &&
      direct.ledger.pending === undefined &&
      Object.keys(direct.pendingDirectDeals).length === 0 &&
      quarantineKeys.length === 1 &&
      quarantineKeys[0] ===
        "__continuous_blocked__:direct_state_missing" &&
      Object.keys(direct.lifecycleByEntry).length === 0 &&
      direct.currentPermit === undefined &&
      direct.proposedPermit === undefined &&
      direct.lastPlanningSnapshot === undefined &&
      direct.lastLifecycleAppliedAttemptSeq === 0 &&
      direct.directDealOutcomes.length === 0 &&
      direct.processedDirectTransactionKeys.length === 0 &&
      direct.directConfirmedDealCount === 0 &&
      direct.directPausedForReview === true &&
      direct.ledger.receipts.length === 0 &&
      direct.ledger.outcomes.length === 0 &&
      direct.ledger.processedEvidenceKeys.length === 0 &&
      direct.ledger.finalizedAttemptSeq === 0 &&
      direct.ledger.nextAttemptSeq === 1;
    if (inactiveMissingState) {
      // Maker 与 Continuous Direct 的授权域彼此独立。一个从未启用过
      // Direct 的空状态不能误伤 Maker；但只要存在未知/损坏 WAL，
      // 或配置已经选择 Direct，下面仍保持全局 fail-closed。
      return undefined;
    }
    if (direct.migrationBlockedReason) {
      return direct.migrationBlockedReason;
    }
    if (direct.ledger.blocker) {
      return direct.ledger.blocker.code;
    }
    if (
      marketDirectContinuousExposure(direct)
        .quarantinedCount > 0
    ) {
      return "direct_quarantine_present";
    }
    return undefined;
  }
  const blocker = direct.migrationBlockedReason;
  if (
    blocker &&
    blocker !== "direct_qualification_state_invalid"
  ) {
    return blocker;
  }
  if (
    Object.keys(
      direct.quarantinedPendingDirectDeals || {},
    ).length > 0
  ) {
    return "direct_quarantine_present";
  }
  return undefined;
}

function recordAction(context: RunContext, action: string): void {
  boundedPush(context.actions, action, MAX_RECENT_ACTIONS);
}

function sortedThresholdMap(
  value: Partial<Record<ResourceConstant, number>>,
): Array<[string, number]> {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * The operator-facing revision is necessary for auditability, but it is not
 * sufficient to prove that the underlying policy stayed frozen. Persist the
 * complete planning signature so an accidental in-place config edit resets
 * Shadow qualification even when the revision string was not changed.
 */
function planningConfigSignature(
  config: MarketSaleAutomationConfig,
): string {
  return JSON.stringify({
    configRevision: config.configRevision,
    sellResources: [...config.sellResources].sort(),
    hardFloor: sortedThresholdMap(config.hardFloor),
    economicFloor: sortedThresholdMap(config.economicFloor),
    forecastBuffer: sortedThresholdMap(config.forecastBuffer),
    minDealAmount: config.minDealAmount,
    maxDealAmount: config.maxDealAmount,
    makerBatchAmount: config.makerBatchAmount,
    maxManagedOrders: config.maxManagedOrders,
    minFreeOrderSlots: config.minFreeOrderSlots,
    creditReserve: config.creditReserve,
    rollingFeeBudget: config.rollingFeeBudget,
    feeWindowTicks: config.feeWindowTicks,
    terminalEnergyReserve: config.terminalEnergyReserve,
    energyShadowPrice: config.energyShadowPrice,
    directDiscountRatio: config.directDiscountRatio,
    minHistoryDays: config.minHistoryDays,
    minHistoryTransactions: config.minHistoryTransactions,
    minHistoryVolume: config.minHistoryVolume,
    historyFloorRatio: config.historyFloorRatio,
    historyMaxAgeDays: config.historyMaxAgeDays,
    minReferenceOrderAmount: config.minReferenceOrderAmount,
    minReferenceOrderNotional: config.minReferenceOrderNotional,
    minReferenceOrderCount: config.minReferenceOrderCount,
    minReferenceDistinctRooms: config.minReferenceDistinctRooms,
    referenceDepthMultiplier: config.referenceDepthMultiplier,
    maxHistoryAskDeviationRatio: config.maxHistoryAskDeviationRatio,
    makerAskFloorRatio: config.makerAskFloorRatio,
    makerHistoryVolumeRatio: config.makerHistoryVolumeRatio,
    orderPolicyTtl: config.orderPolicyTtl,
    mutationBackoffTicks: config.mutationBackoffTicks,
    canaryEnabled: config.canaryEnabled,
    canaryAllowExpansion: config.canaryAllowExpansion,
  });
}

function rollingFeeMilli(
  data: MarketSaleDataState,
  config: MarketSaleAutomationConfig,
): number {
  const cutoff = Game.time - config.feeWindowTicks;
  data.feeEvents = data.feeEvents
    .filter((event) => event.tick >= cutoff)
    .slice(-MAX_FEE_EVENTS);
  return data.feeEvents
    .filter(
      (event) =>
        event.kind === "create" ||
        event.kind === "extend" ||
        event.kind === "reprice",
    )
    .reduce((sum, event) => sum + nonNegativeInteger(event.amountMilli), 0);
}

function carryFeeDebt(
  data: MarketSaleDataState,
  resource: ResourceConstant,
  amountMilli: number,
  id: string,
): void {
  const amount = nonNegativeInteger(amountMilli);
  if (amount <= 0) return;
  data.carriedFeeDebtMilli[resource] =
    nonNegativeInteger(data.carriedFeeDebtMilli[resource]) + amount;
  if (!data.feeEvents.some((event) => event.id === id)) {
    boundedPush(
      data.feeEvents,
      {
        id,
        tick: Game.time,
        resource,
        amountMilli: amount,
        kind: "carry",
      },
      MAX_FEE_EVENTS,
    );
  }
}

type PendingCreateZeroDeltaEvidence =
  | "absent"
  | "filled"
  | "insufficient";

function creditsToMilli(value: number): number | undefined {
  const milli = Math.round(value * 1_000);
  return Number.isSafeInteger(milli) && milli >= 0 ? milli : undefined;
}

/**
 * A zero order-ID delta alone cannot distinguish an absent create from an
 * order which filled before it was observed. Require the write-ahead credit,
 * terminal and outgoing-transaction baselines to close to one exact outcome.
 */
function classifyPendingCreateZeroDelta(
  pending: OwnedPendingCreate,
): PendingCreateZeroDeltaEvidence {
  if (
    typeof pending.creditsBefore !== "number" ||
    !Number.isFinite(pending.creditsBefore) ||
    typeof pending.terminalStockBefore !== "number" ||
    !Number.isSafeInteger(pending.terminalStockBefore) ||
    pending.terminalStockBefore < 0 ||
    !Array.isArray(pending.outgoingKeysBefore) ||
    !pending.tuple.roomName
  ) {
    return "insufficient";
  }
  const credits = Game.market?.credits;
  const terminal = roomTerminal(pending.tuple.roomName);
  const terminalStock = terminal?.store.getUsedCapacity(
    pending.tuple.resourceType,
  );
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    typeof terminalStock !== "number" ||
    !Number.isSafeInteger(terminalStock) ||
    terminalStock < 0
  ) {
    return "insufficient";
  }
  const creditsBeforeMilli = creditsToMilli(pending.creditsBefore);
  const creditsAfterMilli = creditsToMilli(credits);
  if (
    creditsBeforeMilli === undefined ||
    creditsAfterMilli === undefined
  ) {
    return "insufficient";
  }

  const outgoingBaseline = new Set(pending.outgoingKeysBefore);
  const newOutgoing = (Game.market?.outgoingTransactions || []).filter(
    (transaction) => !outgoingBaseline.has(transaction.transactionId),
  );
  const creditDeltaMilli = creditsAfterMilli - creditsBeforeMilli;
  if (
    newOutgoing.length === 0 &&
    terminalStock === pending.terminalStockBefore &&
    creditDeltaMilli === -pending.feeMilli
  ) {
    return "absent";
  }

  let priceMilli: number;
  try {
    priceMilli = priceToMilliUp(pending.tuple.price);
  } catch {
    return "insufficient";
  }
  const matchingOrderIds = new Set<string>();
  let filledAmount = 0;
  for (const transaction of newOutgoing) {
    const transactionOrder = transaction.order;
    let transactionPriceMilli: number | undefined;
    try {
      transactionPriceMilli = transactionOrder
        ? priceToMilliUp(transactionOrder.price)
        : undefined;
    } catch {
      return "insufficient";
    }
    if (
      !transactionOrder ||
      transactionOrder.type !== ORDER_SELL ||
      transaction.resourceType !== pending.tuple.resourceType ||
      transaction.from !== pending.tuple.roomName ||
      transactionPriceMilli !== priceMilli ||
      !Number.isSafeInteger(transaction.amount) ||
      transaction.amount <= 0 ||
      transaction.time < pending.requestedAt
    ) {
      return "insufficient";
    }
    matchingOrderIds.add(transactionOrder.id);
    filledAmount += transaction.amount;
  }
  if (
    newOutgoing.length > 0 &&
    matchingOrderIds.size === 1 &&
    filledAmount === pending.tuple.totalAmount &&
    terminalStock ===
      pending.terminalStockBefore - pending.tuple.totalAmount &&
    creditDeltaMilli ===
      priceMilli * pending.tuple.totalAmount - pending.feeMilli
  ) {
    return "filled";
  }
  return "insufficient";
}

function transactionOrderId(transaction: Transaction): string | undefined {
  const order = transaction.order as { id?: string } | undefined;
  return typeof order?.id === "string" ? order.id : undefined;
}

function transactionKey(transaction: Transaction, orderId: string): string {
  return `${transaction.transactionId}:${orderId}`;
}

function unprocessedFillTransactions(
  data: MarketSaleDataState,
  orderId: string,
  notBeforeTick: number,
): Transaction[] {
  const processed = new Set(data.processedTransactionKeys);
  return (Game.market?.outgoingTransactions || [])
    .filter(
      (transaction) =>
        transactionOrderId(transaction) === orderId &&
        transaction.time >= notBeforeTick &&
        !processed.has(transactionKey(transaction, orderId)),
    )
    .sort(
      (left, right) =>
        left.time - right.time ||
        left.transactionId.localeCompare(right.transactionId),
    );
}

function markTransactionsProcessed(
  data: MarketSaleDataState,
  orderId: string,
  transactions: readonly Transaction[],
): void {
  for (const transaction of transactions) {
    const key = transactionKey(transaction, orderId);
    if (!data.processedTransactionKeys.includes(key)) {
      boundedPush(data.processedTransactionKeys, key, MAX_TRANSACTION_KEYS);
    }
  }
}

function allocateObservedFill(
  data: MarketSaleDataState,
  managed: ManagedMarketOrderState,
  filledAmount: number,
  transactions: readonly Transaction[],
  config: MarketSaleAutomationConfig,
): boolean {
  if (filledAmount <= 0) return true;
  const transactionAmount = transactions.reduce(
    (sum, transaction) => sum + nonNegativeInteger(transaction.amount),
    0,
  );
  if (transactionAmount !== filledAmount) return false;
  let feeDebtMilli = nonNegativeInteger(managed.feeDebtMilli);
  let preRemainingAmount = managed.lastRemainingAmount;
  try {
    for (const transaction of transactions) {
      const amount = nonNegativeInteger(transaction.amount);
      if (amount <= 0 || amount > preRemainingAmount) return false;
      const result = applyFillFeeDebt({
        ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
        gameTime: Game.time,
        transactionId: transaction.transactionId,
        orderId: managed.orderId,
        feeDebtMilli,
        filledAmount: amount,
        preRemainingAmount,
        limits: {
          feeWindowTicks: config.feeWindowTicks,
          fillReceiptWindowTicks: config.feeWindowTicks,
        },
      });
      data.feeLedger = result.ledger;
      if (
        result.reconcileGap ||
        result.duplicate ||
        !result.applied ||
        !result.allocation
      ) {
        return false;
      }
      feeDebtMilli = result.allocation.remainingFeeDebtMilli;
      preRemainingAmount = result.allocation.postRemainingAmount;
    }
  } catch {
    return false;
  }
  managed.feeDebtMilli = feeDebtMilli;
  managed.lastRemainingAmount = preRemainingAmount;
  managed.remainingExposure = preRemainingAmount;
  managed.lastFillAt = Game.time;
  markTransactionsProcessed(data, managed.orderId, transactions);
  return true;
}

function adoptPendingOrder(
  context: RunContext,
  pending: PendingCreateState,
  orderId: string,
): boolean {
  const order = context.liveOrderById.get(orderId);
  if (!order || !order.roomName) return false;
  const carried = nonNegativeInteger(
    context.data.carriedFeeDebtMilli[pending.tuple.resourceType as ResourceConstant],
  );
  const managed: OwnedManagedOrder = {
    orderId,
    roomName: order.roomName,
    resourceType: pending.tuple.resourceType as ResourceConstant,
    price: order.price,
    originalAmount: pending.tuple.totalAmount,
    lastRemainingAmount: pending.tuple.totalAmount,
    remainingExposure: pending.tuple.totalAmount,
    feeDebtMilli: pending.feeMilli + carried,
    createdAt: pending.requestedAt,
    lastSeenAt: pending.requestedAt,
    policyCancelAtTick: pending.requestedAt + context.config.orderPolicyTtl,
    serverCreatedTick: order.created,
  };
  context.data.carriedFeeDebtMilli[pending.tuple.resourceType as ResourceConstant] = 0;
  context.data.managedOrders[orderId] = managed;
  context.data.pendingCreate = undefined;
  appendAudit(context.data, {
    action: "pending_create_adopted",
    orderId,
    requestId: pending.requestId,
  });
  recordAction(context, `adopt:${orderId}`);
  return true;
}

function reconcilePendingCreateState(context: RunContext): void {
  const pending = context.data.pendingCreate;
  if (!pending) return;
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease as
    | OrderMutationLease
    | undefined;
  const baselineChanged = Boolean(
    pending.baselineOrderFingerprints &&
      Object.entries(pending.baselineOrderFingerprints).some(
        ([orderId, fingerprint]) => {
          const live = context.liveOrderById.get(orderId);
          return !live || orderFingerprint(live) !== fingerprint;
        },
      ),
  );
  const result = reconcilePendingCreate({
    pending,
    liveOrders: context.liveOrders,
    lease: baselineChanged ? undefined : lease,
    gameTime: Game.time,
  });
  if (result.adoptedOrderId) {
    if (!adoptPendingOrder(context, pending, result.adoptedOrderId)) {
      context.data.pendingCreate = {
        ...pending,
        status: "ambiguous",
      };
      reject(context, "pending_create_adoption_failed");
    }
    return;
  }
  if (result.pending) {
    context.data.pendingCreate = {
      ...result.pending,
      creditsBefore: pending.creditsBefore,
      terminalStockBefore: pending.terminalStockBefore,
      outgoingKeysBefore: pending.outgoingKeysBefore,
      baselineOrderFingerprints: pending.baselineOrderFingerprints,
      operatorResolutionCandidateIds:
        pending.operatorResolutionCandidateIds,
    } as unknown as OwnedPendingCreate;
    if (result.blockedReason) reject(context, `pending_create:${result.blockedReason}`);
    return;
  }
  if (result.resolvedAs === "filled_or_absent") {
    const operatorResolved =
      pending.operatorResolutionCandidateIds !== undefined;
    const evidence = operatorResolved
      ? "absent"
      : classifyPendingCreateZeroDelta(pending);
    if (evidence === "insufficient") {
      context.data.pendingCreate = {
        ...pending,
        status: "ambiguous",
        zeroDeltaConfirmations: Math.max(
          2,
          pending.zeroDeltaConfirmations,
        ),
        lastZeroDeltaTick: Game.time,
        audit: [
          ...pending.audit,
          {
            tick: Game.time,
            action: "zero_delta_evidence_incomplete",
            candidateIds: [],
          },
        ].slice(-20),
      };
      reject(context, "pending_create:zero_delta_evidence_incomplete");
      appendAudit(context.data, {
        action: "pending_create_zero_delta_evidence_incomplete",
        requestId: pending.requestId,
      });
      return;
    }
    if (evidence === "absent") {
      carryFeeDebt(
        context.data,
        pending.tuple.resourceType as ResourceConstant,
        pending.feeMilli,
        `pending-create-carry:${pending.requestId}`,
      );
    }
    context.data.pendingCreate = undefined;
    appendAudit(context.data, {
      action: operatorResolved
        ? "pending_create_operator_absence_confirmed"
        : evidence === "filled"
          ? "pending_create_filled_confirmed"
          : "pending_create_absence_confirmed",
      requestId: pending.requestId,
      candidateIds: pending.operatorResolutionCandidateIds,
    });
    recordAction(context, `pending-create-resolved:${pending.requestId}`);
  }
}

function reconcilePendingMutationStates(context: RunContext): void {
  for (const [orderId, pending] of Object.entries(
    context.data.pendingMutations,
  )) {
    const live = context.liveOrderById.get(orderId);
    const result = reconcilePendingMutation({ pending, liveOrder: live });
    if (!result.confirmed) {
      if (result.pending) context.data.pendingMutations[orderId] = result.pending;
      if (result.reconcileGap) reject(context, "pending_mutation_reconcile_gap");
      continue;
    }
    const managed = context.data.managedOrders[orderId];
    if (pending.kind === "cancel") {
      if (managed) {
        if (managed.externalMutationGap) {
          managed.remainingExposure = Math.max(
            nonNegativeInteger(managed.remainingExposure),
            nonNegativeInteger(pending.conservativeExposure),
            nonNegativeInteger(
              managed.externalMutationGap.conservativeExposure,
            ),
          );
          managed.externalMutationGap.conservativeExposure =
            managed.remainingExposure;
          managed.lastSeenAt = Game.time;
          delete context.data.pendingMutations[orderId];
          recordAction(
            context,
            `external-mutation-cancel-confirmed:${orderId}`,
          );
          continue;
        }
        carryFeeDebt(
          context.data,
          managed.resourceType as ResourceConstant,
          managed.feeDebtMilli,
          `cancel-carry:${orderId}:${pending.requestedAt}`,
        );
        delete context.data.managedOrders[orderId];
      }
      delete context.data.pendingMutations[orderId];
      recordAction(context, `cancel-confirmed:${orderId}`);
      continue;
    }
    if (!managed || !live) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "pending_mutation_managed_order_missing");
      continue;
    }
    const filled = nonNegativeInteger(result.observedFillAmount);
    const transactions = unprocessedFillTransactions(
      context.data,
      orderId,
      pending.requestedAt,
    );
    const preRemaining =
      pending.kind === "extend"
        ? pending.pre.remainingAmount +
          nonNegativeInteger(pending.requested.addAmount)
        : pending.pre.remainingAmount;
    managed.lastRemainingAmount = preRemaining;
    if (
      !allocateObservedFill(
        context.data,
        managed,
        filled,
        transactions,
        context.config,
      )
    ) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "pending_mutation_fill_gap");
      continue;
    }
    if (pending.kind === "extend") {
      managed.originalAmount += nonNegativeInteger(pending.requested.addAmount);
    } else if (pending.requested.price !== undefined) {
      managed.price = pending.requested.price;
    }
    managed.lastRemainingAmount = live.remainingAmount;
    managed.remainingExposure = live.remainingAmount;
    managed.lastSeenAt = Game.time;
    managed.feeDebtMilli += pending.prospectiveFeeMilli;
    delete context.data.pendingMutations[orderId];
    recordAction(context, `${pending.kind}-confirmed:${orderId}`);
  }
}

function reconcileManagedOrders(context: RunContext): void {
  for (const [orderId, managed] of Object.entries(
    context.data.managedOrders,
  )) {
    if (context.data.pendingMutations[orderId]) continue;
    const live = context.liveOrderById.get(orderId);
    if (managed.externalMutationGap) {
      if (live) {
        managed.remainingExposure = Math.max(
          nonNegativeInteger(managed.remainingExposure),
          nonNegativeInteger(live.remainingAmount),
          nonNegativeInteger(
            managed.externalMutationGap.conservativeExposure,
          ),
        );
        managed.externalMutationGap.conservativeExposure =
          managed.remainingExposure;
        requestCancel(context, orderId);
      }
      continue;
    }
    if (managed.disappearanceGap) continue;
    if (!live) {
      const transactions = unprocessedFillTransactions(
        context.data,
        orderId,
        managed.lastSeenAt,
      );
      if (
        managed.lastRemainingAmount > 0 &&
        allocateObservedFill(
          context.data,
          managed,
          managed.lastRemainingAmount,
          transactions,
          context.config,
        )
      ) {
        delete context.data.managedOrders[orderId];
        recordAction(context, `filled:${orderId}`);
      } else {
        try {
          const reconciliation = reconcileDisappearedOrderFeeDebt({
            ledger:
              context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
            gameTime: Game.time,
            orderId,
            resourceType: managed.resourceType,
            remainingFeeDebtMilli: nonNegativeInteger(
              managed.feeDebtMilli,
            ),
            reason: "unknown",
          });
          context.data.feeLedger = reconciliation.ledger;
          managed.disappearanceGap = {
            detectedAt: Game.time,
            reason: reconciliation.ledger.reconcileGap?.reason ===
              "server_expiry_refund_mismatch"
              ? "server_expiry_refund_mismatch"
              : "unknown_disappearance",
          };
        } catch {
          reject(context, "fee_ledger_invalid");
        }
        managed.backoffUntil = Math.max(
          managed.backoffUntil || 0,
          Game.time + context.config.mutationBackoffTicks,
        );
        reject(context, "managed_order_unknown_disappearance");
      }
      continue;
    }
    let priceChanged = true;
    try {
      priceChanged =
        priceToMilliUp(live.price) !== priceToMilliUp(managed.price);
    } catch {
      priceChanged = true;
    }
    const liveTotalAmount = live.totalAmount;
    const totalAmountChanged =
      !Number.isSafeInteger(liveTotalAmount) ||
      liveTotalAmount !== managed.originalAmount;
    if (priceChanged || totalAmountChanged) {
      const conservativeExposure = Math.max(
        nonNegativeInteger(managed.remainingExposure),
        nonNegativeInteger(managed.lastRemainingAmount),
        nonNegativeInteger(live.remainingAmount),
      );
      managed.externalMutationGap = {
        detectedAt: Game.time,
        expectedPrice: managed.price,
        observedPrice: live.price,
        expectedTotalAmount: managed.originalAmount,
        observedTotalAmount: Number.isSafeInteger(liveTotalAmount)
          ? liveTotalAmount
          : undefined,
        conservativeExposure,
      };
      managed.remainingExposure = conservativeExposure;
      try {
        context.data.feeLedger = markExternalOrderMutationFeeGap({
          ledger:
            context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
          gameTime: Game.time,
          orderId,
        });
      } catch {
        reject(context, "fee_ledger_invalid");
      }
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_external_mutation");
      appendAudit(context.data, {
        action: "managed_order_external_mutation",
        orderId,
      });
      requestCancel(context, orderId);
      continue;
    }
    if (
      live.type !== ORDER_SELL ||
      live.resourceType !== managed.resourceType ||
      live.roomName !== managed.roomName ||
      live.remainingAmount > managed.lastRemainingAmount
    ) {
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_identity_changed");
      requestCancel(context, orderId);
      continue;
    }
    const filled = managed.lastRemainingAmount - live.remainingAmount;
    if (filled > 0) {
      const transactions = unprocessedFillTransactions(
        context.data,
        orderId,
        managed.lastSeenAt,
      );
      if (
        !allocateObservedFill(
          context.data,
          managed,
          filled,
          transactions,
          context.config,
        )
      ) {
        context.runtime.safetyViolationCount += 1;
        reject(context, "managed_order_fill_gap");
        requestCancel(context, orderId);
        continue;
      }
    }
    managed.price = live.price;
    managed.lastRemainingAmount = live.remainingAmount;
    managed.remainingExposure = live.remainingAmount;
    managed.lastSeenAt = Game.time;
    if (Game.time >= managed.policyCancelAtTick) {
      reject(context, "managed_order_policy_ttl_expired");
      requestCancel(context, orderId);
    }
  }
}

function reconcilePersistentState(context: RunContext): void {
  reconcilePendingCreateState(context);
  reconcilePendingMutationStates(context);
  reconcileManagedOrders(context);
}

function totalExposure(data: MarketSaleDataState): number {
  const managed = Object.values(data.managedOrders).reduce(
    (sum, order) => sum + nonNegativeInteger(order.remainingExposure),
    0,
  );
  const pendingCreate = nonNegativeInteger(data.pendingCreate?.exposure);
  const direct = data.directAutomation;
  const pendingDirect = direct
    ? isContinuousDirectState(direct)
      ? marketDirectContinuousExposure(direct).resourceAmount
      : directAutomationExposure(direct).resourceAmount
    : Object.values(data.pendingDirectDeals || {}).reduce(
        (sum, deal) =>
          sum + nonNegativeInteger(deal.dealAmount),
        0,
      );
  return managed + pendingCreate + pendingDirect;
}

function effectiveMode(config: MarketSaleAutomationConfig): MarketSaleAutomationConfig["mode"] {
  if (
    (config.mode === "shadow" ||
      config.mode === "maker" ||
      config.mode === "direct" ||
      config.mode === "hybrid") &&
    !config.validForPlanning
  ) {
    return "off";
  }
  if (config.mode === "hybrid") return "off";
  return config.mode;
}

function requestCancel(context: RunContext, orderId: string): boolean {
  if (context.data.pendingMutations[orderId]) return false;
  const managed = context.data.managedOrders[orderId];
  const live = context.liveOrderById.get(orderId);
  if (!managed || !live) return false;
  if ((managed.backoffUntil || 0) > Game.time) {
    reject(context, "cancel_backoff");
    return false;
  }
  let pending = createPendingMutation({
    kind: "cancel",
    order: live,
    gameTime: Game.time,
    conservativeExposure: Math.max(
      managed.remainingExposure,
      live.remainingAmount,
    ),
  });
  context.data.pendingMutations[orderId] = pending;
  const code = executeCancelOrder(orderId);
  context.writes += 1;
  if (code === OK) {
    pending = markPendingMutationSubmitted(pending);
    context.data.pendingMutations[orderId] = pending;
    recordAction(context, `cancel-submitted:${orderId}`);
    return true;
  }
  delete context.data.pendingMutations[orderId];
  managed.backoffUntil = Game.time + context.config.mutationBackoffTicks;
  reject(context, `cancel_error:${code}`);
  return false;
}

function retryPreparedCancels(context: RunContext): void {
  for (const [orderId, pending] of Object.entries(
    context.data.pendingMutations,
  )) {
    if (pending.kind !== "cancel" || pending.status !== "prepared") continue;
    if (pending.requestedAt >= Game.time) continue;
    if (!context.liveOrderById.has(orderId)) continue;
    const code = executeCancelOrder(orderId);
    context.writes += 1;
    if (code === OK) {
      context.data.pendingMutations[orderId] =
        markPendingMutationSubmitted(pending);
      recordAction(context, `cancel-resubmitted:${orderId}`);
    } else {
      reject(context, `cancel_retry_error:${code}`);
    }
  }
}

function updateDrain(
  context: RunContext,
  mode: MarketSaleAutomationConfig["mode"],
): void {
  context.data.drain = updateDrainState({
    state: context.data.drain || { phase: "off", zeroConfirmations: 0 },
    desiredMode: mode,
    gameTime: Game.time,
    knownManagedIdsPresent: Object.keys(context.data.managedOrders).filter(
      (orderId) => context.liveOrderById.has(orderId),
    ).length,
    pendingCreateCount: context.data.pendingCreate ? 1 : 0,
    pendingMutationCount: Object.keys(context.data.pendingMutations).length,
    stagingAmount: context.stagingAmount,
    reservationAmount: context.reservationAmount,
    exposureAmount: totalExposure(context.data),
    reconcileGapCount:
      structuralMarketSaleWriteBlocker(
        context.data,
        context.config,
      ) ||
      context.data.feeLedger?.reconcileGap ||
      Object.values(context.data.managedOrders).some(
        (managed) =>
          managed.externalMutationGap !== undefined ||
          managed.disappearanceGap !== undefined,
      ) ||
      Object.values(context.data.pendingDirectDeals || {}).some(
        (pending) => pending.status === "reconcile_gap",
      )
        ? 1
        : 0,
  });
}

function drainIfRequired(
  context: RunContext,
  mode: MarketSaleAutomationConfig["mode"],
): void {
  const passive =
    mode === "off" || mode === "shadow" || mode === "emergencyStop";
  updateDrain(context, mode);
  if (!passive || context.data.drain?.phase === "shadow") return;
  retryPreparedCancels(context);
  for (const orderId of Object.keys(context.data.managedOrders).sort()) {
    requestCancel(context, orderId);
  }
  updateDrain(context, mode);
}

function roomTerminal(roomName: string): StructureTerminal | undefined {
  const room = Game.rooms?.[roomName];
  return room?.terminal || undefined;
}

interface CandidateRejectionOptions {
  /**
   * Only maintenance of this exact managed order may recover its own reserved
   * exposure. New and Shadow planning must leave this unset.
   */
  excludeManagedOrderId?: string;
  minimumSellableAmount?: number;
}

function candidateRejectionReasons(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  options: CandidateRejectionOptions = {},
): string[] {
  const terminal = roomTerminal(candidate.roomName);
  const terminalEnergy = terminal?.store.getUsedCapacity(RESOURCE_ENERGY);
  const terminalFree = terminal?.store.getFreeCapacity();
  const result = evaluateMarketSaleCanaryPrerequisites(
    candidate.protectionEntry,
    {
      currentTick: Game.time,
      isHubRoom: candidate.isHubRoom,
      capacityState: candidate.capacityState,
      terminalExists: Boolean(terminal),
      terminalCooldown: terminal?.cooldown,
      terminalEnergy:
        typeof terminalEnergy === "number" ? terminalEnergy : undefined,
      terminalEnergyReserve: context.config.terminalEnergyReserve,
      terminalFreeCapacity:
        typeof terminalFree === "number" ? terminalFree : undefined,
      minimumTerminalFreeCapacity:
        candidate.minimumTerminalFreeCapacity ?? 0,
      resourceAllowed: context.config.sellResources.includes(
        candidate.resourceType,
      ),
      hasCriticalConflict: candidate.hasCriticalConflict,
      trustedPrice: candidate.trustedPrice,
      trustedDepth: candidate.trustedDepth,
      requireNoManagedExposure: false,
      excludeManagedOrderId: options.excludeManagedOrderId,
      minimumSellableAmount:
        options.minimumSellableAmount ?? context.config.minDealAmount,
    },
  );
  const reasons = [...result.reasons];
  if (
    !Number.isFinite(candidate.effectiveNetFloor) ||
    candidate.effectiveNetFloor <= 0
  ) {
    reasons.push("effective_floor_invalid" as never);
  }
  for (const reason of candidate.additionalRejectionReasons || []) {
    const normalized =
      typeof reason === "string" ? reason.trim().slice(0, 120) : "";
    if (normalized && !reasons.includes(normalized as never)) {
      reasons.push(normalized as never);
    }
  }
  return reasons;
}

function maintenanceCandidateOptions(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  phase: DrainState["phase"] | undefined,
): CandidateRejectionOptions | undefined {
  if (phase !== "maker" && phase !== "hybrid") return undefined;
  const matching = Object.values(context.data.managedOrders)
    .filter(
      (managed) =>
        managed.roomName === candidate.roomName &&
        managed.resourceType === candidate.resourceType,
    )
    .map((managed) => ({
      managed,
      live: context.liveOrderById.get(managed.orderId),
    }))
    .filter(
      (
        entry,
      ): entry is {
        managed: OwnedManagedOrder;
        live: MarketOrderSnapshot;
      } => entry.live !== undefined,
    );
  if (matching.length !== 1) return undefined;
  return {
    excludeManagedOrderId: matching[0].managed.orderId,
    minimumSellableAmount: matching[0].live.remainingAmount,
  };
}

function selectAndLockCanary(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
  allowNewLock: boolean,
): MarketSalePlanCandidate | undefined {
  const revision = context.config.configRevision;
  if (!context.config.canaryEnabled || !revision) return undefined;
  const sorted = [...candidates].sort(
    (left, right) =>
      left.roomName.localeCompare(right.roomName) ||
      left.resourceType.localeCompare(right.resourceType),
  );
  const current = context.data.canaryLock;
  if (current) {
    if (current.configRevision !== revision) {
      if (
        allowNewLock &&
        totalExposure(context.data) === 0 &&
        !context.data.pendingCreate &&
        Object.keys(context.data.pendingMutations).length === 0
      ) {
        context.data.canaryLock = undefined;
      } else {
        reject(context, "canary_revision_mismatch");
        return undefined;
      }
    } else {
      return sorted.find(
        (candidate) =>
          candidate.roomName === current.roomName &&
          candidate.resourceType === current.resourceType,
      );
    }
  }
  if (!allowNewLock) {
    reject(context, "canary_lock_missing");
    return undefined;
  }
  const candidate = sorted.find(
    (entry) => candidateRejectionReasons(context, entry).length === 0,
  );
  if (!candidate) return undefined;
  const lock = lockCanary(undefined, {
    roomName: candidate.roomName,
    resourceType: candidate.resourceType,
    lockedAt: Game.time,
    configRevision: revision,
  });
  if (!lock) return undefined;
  const ownedLock = lock as OwnedCanaryLock;
  context.data.canaryLock = ownedLock;
  context.runtime.canaryLock = ownedLock;
  appendAudit(context.data, {
    action: "canary_locked",
    candidateIds: [`${ownedLock.roomName}:${ownedLock.resourceType}`],
  });
  recordAction(
    context,
    `canary-lock:${ownedLock.roomName}:${ownedLock.resourceType}`,
  );
  return candidate;
}

function revalidateManagedOrdersForPlanning(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): void {
  if (Memory.runtime?.resourceControl?.updatedAt !== Game.time) return;
  const lock = context.data.canaryLock;
  const signature = planningConfigSignature(context.config);
  const policyMatchesShadow =
    Boolean(lock) &&
    lock?.configRevision === context.config.configRevision &&
    context.runtime.shadowConfigRevision === context.config.configRevision &&
    context.runtime.shadowConfigSignature === signature;
  const lockedCandidate = lock
    ? candidates.find(
        (candidate) =>
          candidate.roomName === lock.roomName &&
          candidate.resourceType === lock.resourceType,
      )
    : undefined;

  for (const managed of Object.values(context.data.managedOrders)) {
    if (context.data.pendingMutations[managed.orderId]) continue;
    const live = context.liveOrderById.get(managed.orderId);
    if (!live) continue;
    let unsafeReason: string | undefined;
    if (
      !policyMatchesShadow ||
      !lock ||
      managed.roomName !== lock.roomName ||
      managed.resourceType !== lock.resourceType
    ) {
      unsafeReason = "managed_order_policy_changed";
    } else if (!lockedCandidate) {
      unsafeReason = "managed_order_locked_candidate_missing";
    } else if (live.remainingAmount <= 0) {
      unsafeReason = "managed_order_remaining_invalid";
    } else {
      const reasons = candidateRejectionReasons(context, lockedCandidate, {
        excludeManagedOrderId: managed.orderId,
        minimumSellableAmount: live.remainingAmount,
      });
      if (reasons.length > 0) {
        unsafeReason = "managed_order_candidate_rejected";
      } else {
        try {
          const invariant = evaluatePostActionInvariant({
            effectiveNetFloor: lockedCandidate.effectiveNetFloor,
            feeDebtMilli: nonNegativeInteger(managed.feeDebtMilli),
            action: {
              kind: "repriceDown",
              currentPrice: live.price,
              remainingAmount: live.remainingAmount,
            },
            candidatePrice: live.price,
          });
          if (!invariant.satisfiesInvariant) {
            unsafeReason = "managed_order_floor_violation";
          }
        } catch {
          unsafeReason = "managed_order_floor_unknown";
        }
      }
    }
    if (!unsafeReason) continue;
    context.runtime.safetyViolationCount += 1;
    reject(context, unsafeReason);
    requestCancel(context, managed.orderId);
  }
}

function findCurrentProtectionCandidate(
  candidates: readonly MarketSalePlanCandidate[],
  roomName: string,
  resourceType: ResourceConstant,
): MarketSalePlanCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.roomName === roomName &&
      candidate.resourceType === resourceType &&
      candidate.protectionEntry.roomName === roomName &&
      candidate.protectionEntry.resource === resourceType,
  );
}

function currentManagedFloorFailureReason(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  managed: OwnedManagedOrder,
  live: MarketOrderSnapshot | undefined,
): string | undefined {
  const hardFloor = context.config.hardFloor[managed.resourceType];
  const economicFloor = context.config.economicFloor[managed.resourceType];
  if (
    !live ||
    !Number.isFinite(live.price) ||
    live.price <= 0 ||
    !Number.isSafeInteger(live.remainingAmount) ||
    live.remainingAmount <= 0 ||
    !Number.isSafeInteger(managed.feeDebtMilli) ||
    managed.feeDebtMilli < 0 ||
    !Number.isFinite(candidate.effectiveNetFloor) ||
    candidate.effectiveNetFloor <= 0 ||
    !Number.isFinite(hardFloor) ||
    hardFloor === undefined ||
    hardFloor <= 0 ||
    (economicFloor !== undefined &&
      (!Number.isFinite(economicFloor) || economicFloor < 0))
  ) {
    return "current_tick_floor_unknown";
  }

  try {
    const invariant = evaluatePostActionInvariant({
      effectiveNetFloor: Math.max(
        candidate.effectiveNetFloor,
        hardFloor,
        economicFloor || 0,
      ),
      feeDebtMilli: managed.feeDebtMilli,
      action: {
        kind: "repriceDown",
        currentPrice: live.price,
        remainingAmount: live.remainingAmount,
      },
      candidatePrice: live.price,
    });
    return invariant.satisfiesInvariant
      ? undefined
      : "current_tick_floor_violation";
  } catch {
    return "current_tick_floor_unknown";
  }
}

/**
 * Every passive market exposure must be backed by a complete protection
 * observation from this tick and a provable current net floor. ResourceControl
 * cadence and capacity-state remain mandatory only for a new order, but every
 * live managed order is re-priced against current config and cached pricing
 * evidence on every tick.
 */
function currentProtectionFailureReason(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): string | undefined {
  const managedByTuple = new Map<string, OwnedManagedOrder[]>();
  for (const managed of Object.values(context.data.managedOrders)) {
    const tupleKey = `${managed.roomName}:${managed.resourceType}`;
    const tuple = managedByTuple.get(tupleKey) || [];
    tuple.push(managed);
    managedByTuple.set(tupleKey, tuple);

    const candidate = findCurrentProtectionCandidate(
      candidates,
      managed.roomName,
      managed.resourceType,
    );
    if (
      !candidate ||
      !isMarketProtectionEntryFresh(candidate.protectionEntry, Game.time)
    ) {
      return "current_tick_protection_missing";
    }
    const live = context.liveOrderById.get(managed.orderId);
    const floorFailure = currentManagedFloorFailureReason(
      context,
      candidate,
      managed,
      live,
    );
    if (floorFailure) return floorFailure;
    const requiredExposure = Math.max(
      nonNegativeInteger(managed.remainingExposure),
      nonNegativeInteger(live?.remainingAmount),
      nonNegativeInteger(
        context.data.pendingMutations[managed.orderId]?.conservativeExposure,
      ),
    );
    const ownContribution = candidate.protectionEntry.sourceContributions
      .filter(
        (contribution) =>
          contribution.bucket === "managedExposure" &&
          contribution.managedOrderId === managed.orderId,
      )
      .reduce((sum, contribution) => sum + contribution.amount, 0);
    if (
      requiredExposure <= 0 ||
      ownContribution < requiredExposure ||
      getMarketProtectionSellableAmount(
        candidate.protectionEntry,
        Game.time,
        { excludeManagedOrderId: managed.orderId },
      ) < requiredExposure
    ) {
      return "current_tick_protection_insufficient";
    }
  }

  const pending = context.data.pendingCreate;
  if (pending) {
    const roomName = pending.tuple.roomName;
    const resourceType = pending.tuple.resourceType as ResourceConstant;
    if (!roomName) return "current_tick_protection_missing";
    const candidate = findCurrentProtectionCandidate(
      candidates,
      roomName,
      resourceType,
    );
    if (
      !candidate ||
      !isMarketProtectionEntryFresh(candidate.protectionEntry, Game.time)
    ) {
      return "current_tick_protection_missing";
    }

    const tupleKey = `${roomName}:${resourceType}`;
    const managedExposure = (managedByTuple.get(tupleKey) || []).reduce(
      (sum, managed) =>
        sum +
        Math.max(
          nonNegativeInteger(managed.remainingExposure),
          nonNegativeInteger(
            context.data.pendingMutations[managed.orderId]
              ?.conservativeExposure,
          ),
        ),
      0,
    );
    const requiredExposure =
      managedExposure + nonNegativeInteger(pending.exposure);
    const entry = candidate.protectionEntry;
    if (
      requiredExposure <= managedExposure ||
      entry.managedExposure < requiredExposure ||
      entry.grossSurplus < requiredExposure ||
      entry.terminalStock < requiredExposure
    ) {
      return "current_tick_protection_insufficient";
    }
  }

  return undefined;
}

function hasFeeSensitiveFence(data: MarketSaleDataState): boolean {
  return Boolean(
    data.pendingCreate ||
      data.feeLedger?.reconcileGap ||
      Object.values(data.managedOrders).some(
        (managed) =>
          managed.externalMutationGap !== undefined ||
          managed.disappearanceGap !== undefined,
      ) ||
      Object.values(data.pendingMutations).some(
        (pending) =>
          pending.kind === "extend" ||
          pending.kind === "reprice" ||
          pending.status === "reconcile_gap",
      ),
  );
}

interface MakerTerminalSnapshot {
  resourceStock: number;
}

/**
 * Maker 的最终 TOCTOU 栅栏。
 *
 * ResourceControl 先于市场出售运行；成功的 terminal.send intent 不会在同 tick
 * 立即反映到 store/cooldown，因此必须先尊重 arbiter claim。没有 claim 时仍重读
 * Terminal 的资源、能量与容量，并把实时资源量叠加到本 tick 的保护账本上限。
 */
function readSafeMakerTerminalSnapshot(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  amount: number,
): MakerTerminalSnapshot | undefined {
  if (hasTerminalActionClaim(candidate.roomName)) {
    reject(context, "terminal_claimed");
    return undefined;
  }

  const terminal = roomTerminal(candidate.roomName);
  if (!terminal) {
    reject(context, "terminal_missing");
    return undefined;
  }
  if (
    typeof terminal.cooldown !== "number" ||
    !Number.isFinite(terminal.cooldown) ||
    terminal.cooldown !== 0
  ) {
    reject(context, "terminal_cooldown");
    return undefined;
  }

  const resourceStock = terminal.store.getUsedCapacity(
    candidate.resourceType,
  );
  if (
    typeof resourceStock !== "number" ||
    !Number.isFinite(resourceStock) ||
    resourceStock < 0
  ) {
    reject(context, "terminal_resource_unknown");
    return undefined;
  }
  const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  if (
    typeof terminalEnergy !== "number" ||
    !Number.isFinite(terminalEnergy) ||
    terminalEnergy < 0
  ) {
    reject(context, "terminal_energy_unknown");
    return undefined;
  }
  if (terminalEnergy < context.config.terminalEnergyReserve) {
    reject(context, "terminal_energy");
    return undefined;
  }
  const terminalFree = terminal.store.getFreeCapacity();
  if (
    typeof terminalFree !== "number" ||
    !Number.isFinite(terminalFree) ||
    terminalFree < 0
  ) {
    reject(context, "terminal_capacity_unknown");
    return undefined;
  }
  if (
    terminalFree <
    (candidate.minimumTerminalFreeCapacity ?? 0)
  ) {
    reject(context, "terminal_capacity");
    return undefined;
  }

  const protectedSellable = getMarketProtectionSellableAmount(
    candidate.protectionEntry,
    Game.time,
  );
  const currentSellable = Math.min(
    nonNegativeInteger(protectedSellable),
    Math.floor(resourceStock),
  );
  if (amount > currentSellable) {
    reject(context, "maker_amount_no_longer_sellable");
    return undefined;
  }

  return {
    resourceStock: Math.floor(resourceStock),
  };
}

function createMakerOrder(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
): boolean {
  if (hasFeeSensitiveFence(context.data)) {
    reject(context, "mutation_fence");
    return false;
  }
  const lock = context.data.canaryLock;
  if (
    !lock ||
    lock.roomName !== candidate.roomName ||
    lock.resourceType !== candidate.resourceType
  ) {
    reject(context, "canary_lock_missing");
    return false;
  }
  if (
    Object.values(context.data.managedOrders).some(
      (order) =>
        order.roomName === candidate.roomName &&
        order.resourceType === candidate.resourceType,
    )
  ) {
    return false;
  }
  const expansion =
    context.config.canaryAllowExpansion &&
    context.data.expansionGrant?.configRevision === context.config.configRevision;
  const maximumOrders = expansion
    ? context.config.maxManagedOrders
    : 1;
  if (Object.keys(context.data.managedOrders).length >= maximumOrders) {
    reject(context, "managed_order_limit");
    return false;
  }
  if (
    context.liveOrders.length + context.config.minFreeOrderSlots >=
    MAX_MARKET_ORDERS
  ) {
    reject(context, "order_slots_reserved");
    return false;
  }
  const signature = planningConfigSignature(context.config);
  if (
    context.runtime.shadowConfigRevision !== context.config.configRevision ||
    context.runtime.shadowConfigSignature !== signature ||
    context.runtime.shadowConsecutiveCycles < REQUIRED_SHADOW_CYCLES
  ) {
    reject(context, "shadow_qualification_incomplete");
    return false;
  }
  const amount = Math.min(
    context.config.makerBatchAmount,
    nonNegativeInteger(candidate.protectionEntry.sellableAmount),
  );
  if (amount < context.config.minDealAmount) {
    reject(context, "maker_amount_too_small");
    return false;
  }
  const carried = nonNegativeInteger(
    context.data.carriedFeeDebtMilli[candidate.resourceType],
  );
  const minimum = findMinimumSafePrice({
    effectiveNetFloor: candidate.effectiveNetFloor,
    feeDebtMilli: carried,
    action: { kind: "create", amount },
  });
  if (!minimum.safe || minimum.recommendedPrice === undefined) {
    reject(context, "maker_price_unavailable");
    return false;
  }
  const price = roundMarketPriceUp(
    Math.max(minimum.recommendedPrice, candidate.makerPrice || 0),
  );
  const invariant = evaluatePostActionInvariant({
    effectiveNetFloor: candidate.effectiveNetFloor,
    feeDebtMilli: carried,
    action: { kind: "create", amount },
    candidatePrice: price,
  });
  if (!invariant.satisfiesInvariant) {
    context.runtime.safetyViolationCount += 1;
    reject(context, "maker_floor_violation");
    return false;
  }
  const feeMilli = calculateProspectiveFeeMilli(
    { kind: "create", amount },
    price,
  );
  const credits = Game.market?.credits;
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    credits < 0 ||
    context.config.creditReserve === undefined
  ) {
    reject(context, "credit_reserve");
    return false;
  }
  const creditsMilli = Math.floor(credits * 1_000);
  const creditReserveMilli = Math.ceil(
    context.config.creditReserve * 1_000,
  );
  const rollingFeeBudgetMilli = Math.ceil(
    context.config.rollingFeeBudget * 1_000,
  );
  if (
    !Number.isSafeInteger(creditsMilli) ||
    !Number.isSafeInteger(creditReserveMilli) ||
    !Number.isSafeInteger(rollingFeeBudgetMilli)
  ) {
    reject(context, "fee_integer_range");
    return false;
  }
  const terminalSnapshot = readSafeMakerTerminalSnapshot(
    context,
    candidate,
    amount,
  );
  if (!terminalSnapshot) return false;

  const feeReservationId = `create:market-sale:${Game.time}:${candidate.roomName}:${candidate.resourceType}`;
  try {
    const reservation = reserveProspectiveFee({
      ledger:
        context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
      reservationId: feeReservationId,
      gameTime: Game.time,
      action: "create",
      prospectiveFeeMilli: feeMilli,
      creditsMilli,
      creditReserveMilli,
      rollingFeeBudgetMilli,
      limits: {
        feeWindowTicks: context.config.feeWindowTicks,
        fillReceiptWindowTicks: context.config.feeWindowTicks,
      },
      orderSlots: {
        usedOrderSlots: context.liveOrders.length,
        totalOrderSlots: MAX_MARKET_ORDERS,
        minFreeOrderSlots: context.config.minFreeOrderSlots,
        managedOrderCount: Object.keys(context.data.managedOrders).length,
        maxManagedOrders: maximumOrders,
      },
    });
    context.data.feeLedger = reservation.ledger;
    if (!reservation.allowed) {
      for (const reason of reservation.reasons) {
        reject(context, `fee_gate:${reason}`);
      }
      return false;
    }
  } catch {
    reject(context, "fee_ledger_invalid");
    return false;
  }
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease as
    | OrderMutationLease
    | undefined;
  if (!lease) {
    reject(context, "mutation_lease_missing");
    return false;
  }
  const pending = createPendingCreateState({
    requestId: `market-sale:${Game.time}:${candidate.roomName}:${candidate.resourceType}`,
    gameTime: Game.time,
    liveOrders: context.liveOrders,
    lease,
    tuple: {
      type: ORDER_SELL,
      resourceType: candidate.resourceType,
      roomName: candidate.roomName,
      price,
      totalAmount: amount,
      createdNotBefore: Game.time,
      createdNotAfter: Game.time + 2,
    },
    feeMilli,
    exposure: amount,
  });
  if (!pending) {
    reject(context, "mutation_lease_invalid");
    return false;
  }
  context.data.pendingCreate = {
    ...pending,
    creditsBefore: credits,
    terminalStockBefore: terminalSnapshot.resourceStock,
    outgoingKeysBefore: (Game.market.outgoingTransactions || []).map(
      (transaction) => transaction.transactionId,
    ),
    baselineOrderFingerprints: Object.fromEntries(
      context.liveOrders.map((order) => [order.id, orderFingerprint(order)]),
    ),
  } as unknown as OwnedPendingCreate;
  const code = executeCreateOrder({
    type: ORDER_SELL,
    resourceType: candidate.resourceType,
    price,
    totalAmount: amount,
    roomName: candidate.roomName,
  });
  context.writes += 1;
  if (code !== OK) {
    try {
      context.data.feeLedger = releaseProspectiveFeeReservation({
        ledger:
          context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
        reservationId: feeReservationId,
        gameTime: Game.time,
        limits: {
          feeWindowTicks: context.config.feeWindowTicks,
          fillReceiptWindowTicks: context.config.feeWindowTicks,
        },
      });
    } catch {
      reject(context, "fee_reservation_release_failed");
    }
    context.data.pendingCreate = undefined;
    reject(context, `create_error:${code}`);
    appendAudit(context.data, {
      action: "pending_create_call_failed",
      requestId: pending.requestId,
    });
    return false;
  }
  try {
    context.data.feeLedger = commitProspectiveFeeReservation({
      ledger:
        context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
      reservationId: feeReservationId,
      gameTime: Game.time,
      limits: {
        feeWindowTicks: context.config.feeWindowTicks,
        fillReceiptWindowTicks: context.config.feeWindowTicks,
      },
    });
  } catch {
    reject(context, "fee_reservation_commit_failed");
  }
  context.data.pendingCreate = {
    ...markPendingCreateSubmitted(pending),
    creditsBefore: credits,
    terminalStockBefore: terminalSnapshot.resourceStock,
    outgoingKeysBefore: (Game.market.outgoingTransactions || []).map(
      (transaction) => transaction.transactionId,
    ),
    baselineOrderFingerprints: Object.fromEntries(
      context.liveOrders.map((order) => [order.id, orderFingerprint(order)]),
    ),
  } as unknown as OwnedPendingCreate;
  boundedPush(
    context.data.feeEvents,
    {
      id: `create:${pending.requestId}`,
      tick: Game.time,
      resource: candidate.resourceType,
      amountMilli: feeMilli,
      kind: "create",
    },
    MAX_FEE_EVENTS,
  );
  appendAudit(context.data, {
    action: "pending_create_submitted",
    requestId: pending.requestId,
  });
  recordAction(context, `create-submitted:${candidate.roomName}:${candidate.resourceType}`);
  return true;
}

function projectCandidate(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  reasons: string[],
): void {
  const entry = candidate.protectionEntry;
  const key = `${candidate.roomName}:${candidate.resourceType}`;
  context.runtime.candidates[key] = {
    roomName: candidate.roomName,
    resource: candidate.resourceType,
    revision: entry.revision,
    observedAt: entry.observedAt,
    expiresAt: entry.expiresAt,
    stock: entry.totalStock,
    terminalStock: entry.terminalStock,
    protectedAmount: entry.protectedAmount,
    forecastBuffer: entry.forecastBuffer,
    outgoingProtected: entry.protectedOutgoing,
    carrierOrInFlight: entry.carrierOrInFlight,
    managedExposure: entry.managedExposure,
    sellableAmount: entry.sellableAmount,
    hardFloor: context.config.hardFloor[candidate.resourceType],
    economicFloor: context.config.economicFloor[candidate.resourceType],
    historyTrusted: candidate.historyTrusted,
    historyCompleteDayCount: candidate.historyCompleteDayCount,
    historyAcceptedDayCount: candidate.historyAcceptedDayCount,
    historyFloor: candidate.historyFloor,
    ratchetFloor: candidate.ratchetFloor,
    effectiveNetFloor: candidate.effectiveNetFloor,
    makerPrice: candidate.makerPrice,
    makerNetPrice: candidate.makerNetPrice,
    rejectedReason: reasons.length > 0 ? reasons.join(",") : undefined,
  };
  for (const reason of reasons) reject(context, `candidate:${reason}`);
}

function updateShadowCount(
  context: RunContext,
  phase: DrainState["phase"],
): void {
  const directState = context.data.directAutomation;
  if (
    isContinuousDirectState(directState) &&
    usesDirectStrategy(context.config)
  ) {
    const activeShadow = Object.values(
      directState.lifecycleByEntry,
    ).filter(
      (entry) =>
        entry.stage === "shadow" ||
        entry.stage === "qualified",
    );
    context.runtime.shadowConsecutiveCycles =
      activeShadow.length > 0
        ? Math.min(
            ...activeShadow.map(
              (entry) => entry.consecutiveCompleteCycles,
            ),
          )
        : 0;
    context.runtime.shadowConfigRevision =
      context.config.configRevision;
    context.runtime.shadowConfigSignature =
      directState.currentPermit?.sharedPolicyFingerprint;
    const cycleTicks = activeShadow
      .map((entry) => entry.lastCycleTick)
      .filter(
        (tick): tick is number =>
          typeof tick === "number",
      );
    context.runtime.lastShadowCycleTick =
      cycleTicks.length > 0
        ? Math.max(...cycleTicks)
        : undefined;
    return;
  }
  if (
    usesDirectStrategy(context.config) &&
    directState &&
    !isContinuousDirectState(directState)
  ) {
    const qualification = directState.shadowQualification;
    context.runtime.shadowConsecutiveCycles =
      qualification.consecutiveCycles;
    context.runtime.shadowConfigRevision =
      qualification.configRevision;
    context.runtime.shadowConfigSignature =
      qualification.safetyFingerprint;
    context.runtime.lastShadowCycleTick =
      qualification.lastCycleTick;
    return;
  }
  const revision = context.config.configRevision;
  const signature = planningConfigSignature(context.config);
  const freshResourceControlCycle =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  if (
    phase !== "shadow" ||
    !revision ||
    !freshResourceControlCycle ||
    !context.shadowPlanComplete
  ) {
    if (
      phase === "shadow" &&
      freshResourceControlCycle &&
      !context.shadowPlanComplete
    ) {
      context.runtime.shadowConsecutiveCycles = 0;
      context.runtime.lastShadowCycleTick = Game.time;
    }
    const preserveQualifiedEvidence =
      (phase === "maker" || phase === "hybrid") &&
      context.runtime.shadowConfigRevision === revision &&
      context.runtime.shadowConfigSignature === signature;
    if (phase !== "shadow" && !preserveQualifiedEvidence) {
      context.runtime.shadowConsecutiveCycles = 0;
      context.runtime.shadowConfigRevision = undefined;
      context.runtime.shadowConfigSignature = undefined;
      context.runtime.lastShadowCycleTick = undefined;
    }
    return;
  }
  if (
    context.runtime.shadowConfigRevision !== revision ||
    context.runtime.shadowConfigSignature !== signature
  ) {
    context.runtime.shadowConfigRevision = revision;
    context.runtime.shadowConfigSignature = signature;
    context.runtime.shadowConsecutiveCycles = 0;
    context.runtime.lastShadowCycleTick = Game.time;
    return;
  }
  if (context.runtime.lastShadowCycleTick === Game.time) return;
  context.runtime.shadowConsecutiveCycles += 1;
  context.runtime.lastShadowCycleTick = Game.time;
}

function projectContinuousDirectRuntimeStatus(
  state: MarketDirectContinuousAutomationState,
  strategyActive: boolean,
): unknown {
  const lifecycleByEntry: Record<string, unknown> = {};
  for (const [entryId, lifecycle] of Object.entries(
    state.lifecycleByEntry,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    lifecycleByEntry[entryId] = {
      stage: lifecycle.stage,
      consecutiveCompleteCycles:
        lifecycle.consecutiveCompleteCycles,
      lastCycleTick: lifecycle.lastCycleTick,
      lastShadowResult: lifecycle.lastShadowResult,
      qualifiedAt: lifecycle.qualifiedAt,
      canaryConfirmedAt: lifecycle.canaryConfirmedAt,
      canaryConfirmedCount:
        lifecycle.canaryConfirmedCount,
      sharedReviewRequired:
        lifecycle.sharedReviewRequired,
    };
  }
  const pending = state.ledger.pending;
  const entries =
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => ({
        entryId: entry.entryId,
        resourceType: entry.resourceType,
        allowedRoomNames: entry.allowedRoomNames,
        hardFloor: entry.hardFloor,
        economicFloor: entry.economicFloor,
        laneReserve: entry.laneReserve,
        rollingWindowTicks: entry.rollingWindowTicks,
        rollingMaxAmount: entry.rollingMaxAmount,
        opportunityReserveAmount:
          entry.rollingOpportunityReserveAmount,
        lifecycle:
          lifecycleByEntry[entry.entryId],
        quota: computeContinuousQuota(
          state.ledger,
          Game.time,
          entry.resourceType,
          entry.rollingMaxAmount,
          MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.rollingMaxAmount,
        ),
      }),
    );
  return {
    strategyActive,
    schemaVersion: state.schemaVersion,
    capability: state.capability,
    migrationStatus: state.migrationStatus,
    migrationBlockedReason:
      state.migrationBlockedReason,
    permit: state.currentPermit
      ? {
          epoch: state.currentPermit.epoch,
          permitId: state.currentPermit.permitId,
          permitHead: state.currentPermit.permitHead,
          grants: state.currentPermit.entryGrants.map(
            (grant) => ({
              entryId: grant.entryId,
              stage: grant.stage,
              newDealGrant: grant.newDealGrant,
            }),
          ),
        }
      : undefined,
    proposedPermitId:
      state.proposedPermit?.permit.permitId,
    lifecycleByEntry,
    entries,
    ledger: {
      receiptHeadHash: state.ledger.receiptHeadHash,
      finalizedAttemptSeq:
        state.ledger.finalizedAttemptSeq,
      nextAttemptSeq: state.ledger.nextAttemptSeq,
      coverageStartTick:
        state.ledger.coverageStartTick,
      permitEpochHighWater:
        state.ledger.permitEpochHighWater,
      permitChainHeadHighWater:
        state.ledger.permitChainHeadHighWater,
      lifetimeConfirmed:
        state.ledger.lifetimeConfirmed,
      pending: pending
        ? {
            attemptSeq: pending.attemptSeq,
            requestId: pending.evidenceKeyHint,
            entryId: pending.entryId,
            sellerRoom: pending.sellerRoom,
            resource: pending.resource,
            orderId: pending.orderId,
            attemptAt: pending.attemptAt,
            plannedAmount: pending.plannedAmount,
            plannedTransactionEnergy:
              pending.plannedTransactionEnergy,
          }
        : undefined,
      blocker: state.ledger.blocker,
      quarantinedCount: Object.keys(
        state.quarantinedPendingDirectDeals,
      ).length,
    },
    lastPlanningSnapshot:
      state.lastPlanningSnapshot,
  };
}

function projectRuntime(
  context: RunContext,
  requestedMode: MarketSaleAutomationConfig["mode"],
): void {
  const drain = context.data.drain || { phase: "off", zeroConfirmations: 0 };
  context.runtime.updatedAt = Game.time;
  context.runtime.requestedMode = requestedMode;
  context.runtime.phase = drain.phase;
  context.runtime.configRevision = context.config.configRevision;
  context.runtime.zeroConfirmations = drain.zeroConfirmations;
  context.runtime.lastZeroConfirmationTick = drain.lastZeroConfirmationTick;
  context.runtime.managedOrderCount = Object.keys(
    context.data.managedOrders,
  ).length;
  context.runtime.managedOrders = Object.values(context.data.managedOrders)
    .sort((left, right) => left.orderId.localeCompare(right.orderId))
    .slice(0, MAX_MANAGED_ORDER_SUMMARIES)
    .map((managed) => ({
      orderId: managed.orderId,
      roomName: managed.roomName,
      resourceType: managed.resourceType,
      remainingExposure: managed.remainingExposure,
      liveRemainingAmount:
        context.liveOrderById.get(managed.orderId)?.remainingAmount,
      policyCancelAtTick: managed.policyCancelAtTick,
      backoffUntil: managed.backoffUntil,
      pendingMutationKind:
        context.data.pendingMutations[managed.orderId]?.kind,
    }));
  context.runtime.managedOrderSummaryTruncated =
    context.runtime.managedOrderCount > context.runtime.managedOrders.length;
  const activeBackoffs = Object.values(context.data.managedOrders)
    .map((managed) => managed.backoffUntil)
    .filter(
      (backoffUntil): backoffUntil is number =>
        typeof backoffUntil === "number" && backoffUntil > Game.time,
    );
  context.runtime.backoffSummary = {
    activeCount: activeBackoffs.length,
    nextUntil:
      activeBackoffs.length > 0 ? Math.min(...activeBackoffs) : undefined,
  };
  context.runtime.orderSlots = {
    total: MAX_MARKET_ORDERS,
    current: context.liveOrders.length,
    free: Math.max(0, MAX_MARKET_ORDERS - context.liveOrders.length),
    // An unresolved create owns one serialization slot even before its ID is
    // safely attributable. Manual order details are intentionally not exposed.
    reserved: context.data.pendingCreate ? 1 : 0,
    minFree: context.config.minFreeOrderSlots,
  };
  context.runtime.pendingCreateCount = context.data.pendingCreate ? 1 : 0;
  context.runtime.pendingMutationCount = Object.keys(
    context.data.pendingMutations,
  ).length;
  context.runtime.stagingAmount = context.stagingAmount;
  context.runtime.reservationAmount = context.reservationAmount;
  context.runtime.exposureAmount = totalExposure(context.data);
  context.runtime.rollingFeeMilli = rollingFeeMilli(
    context.data,
    context.config,
  );
  context.runtime.creditReserve = context.config.creditReserve;
  const credits = Game.market?.credits;
  let reservedFeesThisTick: number | undefined;
  try {
    reservedFeesThisTick =
      getFeeLedgerTotals(
        advanceFeeLedgerWindow(
          context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
          Game.time,
          {
            feeWindowTicks: context.config.feeWindowTicks,
            fillReceiptWindowTicks: context.config.feeWindowTicks,
          },
        ),
      ).reservedThisTickMilli / 1_000;
  } catch {
    reservedFeesThisTick = undefined;
  }
  const trustedCredits =
    typeof credits === "number" && Number.isFinite(credits) && credits >= 0
      ? credits
      : undefined;
  const reserve =
    typeof context.config.creditReserve === "number" &&
    Number.isFinite(context.config.creditReserve) &&
    context.config.creditReserve >= 0
      ? context.config.creditReserve
      : undefined;
  context.runtime.creditSummary = {
    credits: trustedCredits,
    reserve,
    reservedFeesThisTick,
    availableAfterReserve:
      trustedCredits !== undefined &&
      reserve !== undefined &&
      reservedFeesThisTick !== undefined
        ? trustedCredits - reserve - reservedFeesThisTick
        : undefined,
  };
  context.runtime.terminalClaims = getTerminalActionClaims().map(
    (claim) => `${claim.roomName}:${claim.actor}:${claim.kind}`,
  );
  context.runtime.rejectedByReason = { ...context.rejectedByReason };
  context.runtime.canaryLock = context.data.canaryLock;
  const directState = context.data.directAutomation!;
  if (isContinuousDirectState(directState)) {
    (
      context.runtime as unknown as {
        direct?: unknown;
      }
    ).direct = projectContinuousDirectRuntimeStatus(
      directState,
      usesDirectStrategy(context.config),
    );
  } else {
    const directSnapshotStatus = directAutomationSnapshotStatus(
      directState,
      Game.time,
    );
    const directSnapshot = directState.lastPlanningSnapshot;
    const directPendingByStatus = Object.values(
      directState.pendingDirectDeals,
    ).reduce<Record<string, number>>((summary, pending) => {
      summary[pending.status] = (summary[pending.status] || 0) + 1;
      return summary;
    }, {});
    const directExposure = directAutomationExposure(directState);
    if (directExposure.quarantinedCount > 0) {
      directPendingByStatus.quarantined =
        directExposure.quarantinedCount;
    }
    context.runtime.direct = {
      strategyActive: usesDirectStrategy(context.config),
      shadowConsecutiveCycles:
        directState.shadowQualification.consecutiveCycles,
      qualifiedAt: directState.shadowQualification.qualifiedAt,
      activationAuthorized:
        directState.shadowQualification.activationAuthorized,
      canary: directState.shadowQualification.canary,
      pendingCount: directExposure.pendingCount,
      pendingByStatus: directPendingByStatus,
      confirmedDealCount: directState.directConfirmedDealCount,
      pausedForReview: directState.directPausedForReview,
      migrationBlockedReason: directState.migrationBlockedReason,
      exposure: directExposure,
      snapshot:
        directSnapshot && directSnapshotStatus.age !== undefined
          ? {
              observedAt: directSnapshot.observedAt,
              age: directSnapshotStatus.age,
              maxAgeTicks: directSnapshotStatus.maxAgeTicks,
              fresh: directSnapshotStatus.fresh,
              configRevision: directSnapshot.configRevision,
              safetyFingerprint: directSnapshot.safetyFingerprint,
              canary: directSnapshot.canary,
              result: directSnapshot.result,
              structuralCandidateCount:
                directSnapshot.structuralCandidateCount,
              eligibleStructuralCandidateCount:
                directSnapshot.eligibleStructuralCandidateCount,
              buyBook: directSnapshot.buyBook,
              opportunity: directSnapshot.opportunity,
              manualBuyOrderCount:
                directSnapshot.manualBuyOrderCount,
              manualSellOrderCount:
                directSnapshot.manualSellOrderCount,
              zeroRemainingOwnOrderCount:
                directSnapshot.zeroRemainingOwnOrderCount,
              effectiveNetFloor: directSnapshot.effectiveNetFloor,
              effectiveEnergyShadowPrice:
                directSnapshot.effectiveEnergyShadowPrice,
              energyShadowObservedAt:
                directSnapshot.energyShadowObservedAt,
              energyShadowComponents:
                directSnapshot.energyShadowComponents,
              rejectedByReason: {
                ...directSnapshot.rejectedByReason,
              },
            }
          : undefined,
    };
  }
  for (const action of context.actions) {
    boundedPush(
      context.runtime.recentActions,
      `${Game.time}:${action}`,
      MAX_RECENT_ACTIONS,
    );
  }
  updateShadowCount(context, drain.phase);
}

function finalizeResult(
  context: RunContext,
  requestedMode: MarketSaleAutomationConfig["mode"],
  mode: MarketSaleAutomationConfig["mode"],
): MarketSaleAutomationResult {
  projectRuntime(context, requestedMode);
  return {
    requestedMode,
    effectiveMode: mode,
    phase: context.data.drain?.phase || "off",
    writes: context.writes,
    actions: [...context.actions],
    rejectedByReason: { ...context.rejectedByReason },
  };
}

function registerOperatorControls(): void {
  operatorGlobals.grantMarketSaleMutationLease = grantMarketSaleMutationLease;
  operatorGlobals.revokeMarketSaleMutationLease = revokeMarketSaleMutationLease;
  operatorGlobals.attestMarketSalePendingCreate =
    attestMarketSalePendingCreate;
  operatorGlobals.resolveMarketSalePendingCreateAbsence =
    resolveMarketSalePendingCreateAbsence;
  operatorGlobals.resolveMarketSaleExternalOrderMutation =
    resolveMarketSaleExternalOrderMutation;
  operatorGlobals.resolveMarketSaleOrderDisappearance =
    resolveMarketSaleOrderDisappearance;
  operatorGlobals.expandMarketSaleCanary = expandMarketSaleCanary;
  operatorGlobals.emergencyStopMarketSaleAutomation =
    emergencyStopMarketSaleAutomation;
  operatorGlobals.marketSaleAutomationStatus = marketSaleAutomationStatus;
  operatorGlobals.resolveMarketSaleDirectPending =
    resolveMarketSaleDirectPending;
  operatorGlobals.proposeMarketDirectContinuousPermit =
    proposeMarketDirectContinuousPermit;
  operatorGlobals.acceptMarketDirectContinuousPermit =
    acceptMarketDirectContinuousPermit;
  operatorGlobals.marketDirectContinuousStatus =
    marketDirectContinuousStatus;
}

export function runMarketSalePreflight(): MarketSaleAutomationResult {
  enforceLegacyMarketSafetyLatch();
  registerOperatorControls();
  const context = makeContext();
  if (!context.marketDomainActivityValid) {
    reject(context, "market_domain_activity_invalid");
  }
  for (const reason of context.config.invalidReasons) reject(context, reason);
  if (context.config.mode === "hybrid") {
    reject(context, "hybrid_not_implemented");
  }
  const directState = context.data.directAutomation!;
  const inactiveMissingDirectState =
    structuralMarketSaleWriteBlocker(
      context.data,
      context.config,
    ) === undefined &&
    isContinuousDirectState(directState) &&
    directState.migrationBlockedReason ===
      "direct_state_missing";
  if (!inactiveMissingDirectState) {
    mergeDirectResult(
      context,
      isContinuousDirectState(directState)
        ? runMarketDirectContinuousPreflight(directState, {
            tick: Game.time,
            config: context.config,
          })
        : runDirectAutomationPreflight(directState, {
            tick: Game.time,
            config: context.config,
          }),
    );
  }
  context.data.pendingDirectDeals =
    directState.pendingDirectDeals;
  const structuralWriteBlocker =
    structuralMarketSaleWriteBlocker(
      context.data,
      context.config,
    );
  if (structuralWriteBlocker) {
    if (!context.rejectedByReason[structuralWriteBlocker]) {
      reject(context, structuralWriteBlocker);
    }
    // 损坏的 intent/market-data 无法证明任何 Maker mutation 是否安全。
    // 仍投影保守 exposure/drain，但禁止 reconcile、retry 和 cancel 写入。
    updateDrain(context, "emergencyStop");
    return finalizeResult(
      context,
      context.config.mode,
      "emergencyStop",
    );
  }
  reconcilePersistentState(context);
  const mode = effectiveMode(context.config);
  drainIfRequired(context, mode);
  return finalizeResult(context, context.config.mode, mode);
}

export function runMarketSaleAutomation(
  input: MarketSaleAutomationInput = {},
): MarketSaleAutomationResult {
  enforceLegacyMarketSafetyLatch();
  registerOperatorControls();
  const context = makeContext();
  if (input.stagingAmount !== undefined) {
    context.stagingAmount = nonNegativeInteger(input.stagingAmount);
  }
  if (input.reservationAmount !== undefined) {
    context.reservationAmount = nonNegativeInteger(
      input.reservationAmount,
    );
  }
  if (input.marketDomainActivityValid === false) {
    context.marketDomainActivityValid = false;
  }
  if (!context.marketDomainActivityValid) {
    reject(context, "market_domain_activity_invalid");
  }
  for (const reason of context.config.invalidReasons) reject(context, reason);
  if (context.config.mode === "hybrid") {
    reject(context, "hybrid_not_implemented");
  }
  const structuralWriteBlocker =
    structuralMarketSaleWriteBlocker(
      context.data,
      context.config,
    );
  if (structuralWriteBlocker) {
    reject(context, structuralWriteBlocker);
    updateDrain(context, "emergencyStop");
    return finalizeResult(
      context,
      context.config.mode,
      "emergencyStop",
    );
  }
  reconcilePersistentState(context);
  const candidates = input.candidates || [];
  const configuredMode = effectiveMode(context.config);
  const protectionFailure =
    configuredMode === "maker"
      ? currentProtectionFailureReason(context, candidates)
      : undefined;
  if (protectionFailure) {
    context.runtime.safetyViolationCount += 1;
    reject(context, protectionFailure);
  }
  const continuingProtectionDrain =
    configuredMode === "maker" &&
    context.data.drain?.targetMode === "off" &&
    (context.data.drain.phase === "requested" ||
      context.data.drain.phase === "draining");
  const mode =
    protectionFailure || continuingProtectionDrain
      ? "emergencyStop"
      : configuredMode;
  const planningCycleCurrent =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  if (planningCycleCurrent && configuredMode === "maker") {
    // Preserve the more specific policy/floor rejection evidence on planning
    // ticks even when the current protection failure below also forces drain.
    revalidateManagedOrdersForPlanning(context, candidates);
  }
  drainIfRequired(context, mode);
  const directStrategy = usesDirectStrategy(context.config);
  const phase = context.data.drain?.phase;

  if (directStrategy) {
    if (planningCycleCurrent) {
      context.runtime.candidates = {};
      for (const candidate of candidates) {
        projectCandidate(
          context,
          candidate,
          directCandidateRejectionReasons(context, candidate),
        );
      }
    }
    const lifecyclePhaseReady =
      (context.config.mode === "shadow" && phase === "shadow") ||
      (context.config.mode === "direct" && phase === "direct");
    const directState = context.data.directAutomation!;
    const directResult = isContinuousDirectState(directState)
      ? runMarketDirectContinuousPlanning(
          directState,
          {
            tick: Game.time,
            fullPlanningTick:
              planningCycleCurrent && lifecyclePhaseReady,
            config: context.config,
            candidates: toContinuousRuntimeCandidates(
              context,
              candidates,
            ),
            makerExposurePresent: makerExposurePresent(context),
            emergencyStop:
              mode === "emergencyStop" ||
              (context.config.mode === "direct" &&
                phase !== "direct"),
          },
        )
      : runDirectAutomationPlanning(
          directState,
          {
            tick: Game.time,
            fullPlanningTick:
              planningCycleCurrent && lifecyclePhaseReady,
            config: context.config,
            candidates: toDirectRuntimeCandidates(
              context,
              candidates,
            ),
            makerExposurePresent: makerExposurePresent(context),
          },
        );
    context.shadowPlanComplete = directResult.planComplete;
    mergeDirectResult(context, directResult);
    context.data.pendingDirectDeals =
      directState.pendingDirectDeals;
    updateDrain(context, mode);
    return finalizeResult(context, context.config.mode, mode);
  }

  if (planningCycleCurrent) {
    context.runtime.candidates = {};
  }

  context.shadowPlanComplete = false;
  for (const candidate of candidates) {
    projectCandidate(
      context,
      candidate,
      candidateRejectionReasons(
        context,
        candidate,
        maintenanceCandidateOptions(context, candidate, phase),
      ),
    );
  }

  if (
    planningCycleCurrent &&
    (phase === "maker" || phase === "hybrid" || phase === "shadow") &&
    context.config.validForPlanning
  ) {
    const selected = selectAndLockCanary(
      context,
      candidates,
      phase === "shadow",
    );
    context.shadowPlanComplete =
      phase === "shadow" &&
      candidates.length > 0 &&
      selected !== undefined &&
      context.data.canaryLock?.roomName === selected.roomName &&
      context.data.canaryLock?.resourceType === selected.resourceType;
    if (selected) {
      const reasons = candidateRejectionReasons(
        context,
        selected,
        maintenanceCandidateOptions(context, selected, phase),
      );
      if (reasons.length > 0) {
        const hasExposure = Object.values(context.data.managedOrders).some(
          (order) =>
            order.roomName === selected.roomName &&
            order.resourceType === selected.resourceType,
        );
        if (hasExposure && phase !== "shadow") {
          for (const order of Object.values(context.data.managedOrders)) {
            if (
              order.roomName === selected.roomName &&
              order.resourceType === selected.resourceType
            ) {
              requestCancel(context, order.orderId);
            }
          }
        }
      } else if (phase === "maker" || phase === "hybrid") {
        createMakerOrder(context, selected);
      }
    } else if (candidates.length === 0) {
      reject(context, "protection_or_price_input_missing");
    }
  }

  updateDrain(context, mode);
  return finalizeResult(context, context.config.mode, mode);
}

export function resolveMarketSaleDirectPending(
  evidence: OperatorDirectPendingEvidence,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  if (isContinuousDirectState(data.directAutomation)) {
    return {
      ok: false,
      error: "legacy_direct_pending_resolver_rejects_v2",
    };
  }
  if (
    data.directAutomation?.migrationBlockedReason &&
    data.directAutomation.migrationBlockedReason !==
      "direct_qualification_state_invalid"
  ) {
    return {
      ok: false,
      error: data.directAutomation.migrationBlockedReason,
    };
  }
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, error: "direct_operator_evidence_required" };
  }
  const result = resolveDirectAutomationPending(
    data.directAutomation!,
    evidence,
    Game.time,
  );
  data.pendingDirectDeals =
    data.directAutomation!.pendingDirectDeals;
  if (result.ok) {
    appendAudit(data, {
      action: result.duplicate
        ? "direct_pending_operator_duplicate"
        : "direct_pending_operator_resolved",
      requestId: evidence.requestId,
    });
  }
  return result;
}

function commitContinuousDirectState(
  data: MarketSaleDataState,
  state: MarketDirectContinuousAutomationState,
): void {
  data.pendingDirectDeals = state.pendingDirectDeals;
  data.directAutomation = state;
  Memory.data!.marketSaleAutomation =
    data as unknown as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >;
}

function continuousPermitConfigBlocker(
  config: ResolvedMarketSaleAutomationConfig,
): string | undefined {
  if (!usesDirectStrategy(config)) {
    return "continuous_direct_strategy_required";
  }
  if (config.directCapability !== "continuous-v2") {
    return "continuous_direct_capability_required";
  }
  if (
    !config.validForPlanning ||
    config.invalidReasons.length > 0
  ) {
    return (
      config.invalidReasons[0] ||
      "continuous_direct_config_invalid"
    );
  }
  return undefined;
}

export function proposeMarketDirectContinuousPermit(
  request: MarketDirectContinuousPermitRequest,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  if (!isContinuousDirectState(data.directAutomation)) {
    return {
      ok: false,
      error: "continuous_direct_state_required",
    };
  }
  const configBlocker = continuousPermitConfigBlocker(
    resolveMarketSaleAutomationConfig(),
  );
  if (configBlocker) {
    appendAudit(data, {
      action: `continuous_permit_proposal_rejected:${configBlocker}`,
    });
    commitContinuousDirectState(
      data,
      data.directAutomation,
    );
    return { ok: false, error: configBlocker };
  }
  let accountIdentity: string | undefined;
  try {
    accountIdentity =
      defaultMarketDirectContinuousDependencies
        .readAccountIdentity();
  } catch {
    accountIdentity = undefined;
  }
  const result = proposeContinuousPermitState(
    data.directAutomation,
    Game.time,
    accountIdentity || "",
    request,
  );
  data.pendingDirectDeals = result.state.pendingDirectDeals;
  data.directAutomation = result.state;
  appendAudit(data, {
    action: result.ok
      ? "continuous_permit_proposed"
      : `continuous_permit_proposal_rejected:${String(
          result.error || "unknown",
        ).slice(0, 80)}`,
    requestId: result.permit?.permitId,
  });
  commitContinuousDirectState(data, result.state);
  return result.ok
    ? {
        ok: true,
        permit: result.permit,
        accountIdentity,
      }
    : {
        ok: false,
        error:
          result.error ||
          "continuous_permit_proposal_failed",
      };
}

export function acceptMarketDirectContinuousPermit(
  permitId: string,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  if (!isContinuousDirectState(data.directAutomation)) {
    return {
      ok: false,
      error: "continuous_direct_state_required",
    };
  }
  const configBlocker = continuousPermitConfigBlocker(
    resolveMarketSaleAutomationConfig(),
  );
  if (configBlocker) {
    appendAudit(data, {
      action: `continuous_permit_accept_rejected:${configBlocker}`,
      requestId:
        typeof permitId === "string"
          ? permitId.trim()
          : undefined,
    });
    commitContinuousDirectState(
      data,
      data.directAutomation,
    );
    return { ok: false, error: configBlocker };
  }
  const normalizedPermitId =
    typeof permitId === "string" ? permitId.trim() : "";
  if (!normalizedPermitId) {
    appendAudit(data, {
      action:
        "continuous_permit_accept_rejected:continuous_permit_id_required",
    });
    commitContinuousDirectState(
      data,
      data.directAutomation,
    );
    return { ok: false, error: "continuous_permit_id_required" };
  }
  const result = acceptContinuousPermitState(
    data.directAutomation,
    Game.time,
    normalizedPermitId,
    Game.shard?.name || "",
  );
  data.pendingDirectDeals = result.state.pendingDirectDeals;
  data.directAutomation = result.state;
  appendAudit(data, {
    action: result.ok
      ? result.idempotent
        ? "continuous_permit_accept_idempotent"
        : "continuous_permit_accepted"
      : `continuous_permit_accept_rejected:${String(
          result.error || "unknown",
        ).slice(0, 80)}`,
    requestId: normalizedPermitId,
  });
  commitContinuousDirectState(data, result.state);
  return result.ok
    ? {
        ok: true,
        permitId: normalizedPermitId,
        idempotent: result.idempotent === true,
      }
    : {
        ok: false,
        error:
          result.error ||
          "continuous_permit_accept_failed",
      };
}

export function marketDirectContinuousStatus(): unknown {
  const data = ensureDataState();
  if (!isContinuousDirectState(data.directAutomation)) {
    return {
      tick: Game.time,
      error: "continuous_direct_state_required",
    };
  }
  return projectContinuousDirectStatus(
    data.directAutomation,
    Game.time,
  );
}

export function grantMarketSaleMutationLease(
  epoch: string,
  expiresAt: number,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedEpoch = typeof epoch === "string" ? epoch.trim() : "";
  if (!normalizedEpoch) return { ok: false, error: "epoch_required" };
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Game.time) {
    return { ok: false, error: "expires_at_must_be_future_tick" };
  }
  const data = ensureDataState();
  if (data.pendingCreate) {
    return { ok: false, error: "pending_create_exists" };
  }
  if (Object.keys(data.pendingMutations).length > 0) {
    return { ok: false, error: "pending_mutation_exists" };
  }
  if (!Memory.cfg) Memory.cfg = {};
  if (!Memory.cfg.marketSaleAutomation) {
    Memory.cfg.marketSaleAutomation = {};
  }
  const baselineIds = readLiveOrders().map((order) => order.id);
  const lease: OrderMutationLease = {
    epoch: normalizedEpoch,
    grantedAt: Game.time,
    expiresAt,
    baselineHash: hashOrderIds(baselineIds),
  };
  Memory.cfg.marketSaleAutomation.orderMutationLease = lease;
  appendAudit(data, {
    action: "mutation_lease_granted",
    candidateIds: baselineIds,
  });
  return { ok: true, lease: { ...lease }, baselineIds };
}

export function revokeMarketSaleMutationLease(
  reason = "operator_revoked",
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease;
  if (!lease) return { ok: false, error: "lease_missing" };
  lease.revokedAt = Game.time;
  lease.revokeReason =
    typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, 100)
      : "operator_revoked";
  appendAudit(ensureDataState(), { action: "mutation_lease_revoked" });
  return { ok: true, lease: { ...lease } };
}

export function attestMarketSalePendingCreate(
  orderId: string,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  const pending = data.pendingCreate;
  if (!pending) return { ok: false, error: "pending_create_missing" };
  const liveOrders = readLiveOrders();
  const result = attestPendingCreateOrder({
    pending,
    liveOrders,
    orderId,
    gameTime: Game.time,
  });
  appendAudit(data, {
    action: result.adoptedOrderId
      ? "operator_attestation_accepted"
      : "operator_attestation_rejected",
    orderId,
    requestId: pending.requestId,
    candidateIds: liveOrders
      .filter((order) => !pending.baselineOrderIds.includes(order.id))
      .map((order) => order.id),
  });
  if (!result.adoptedOrderId) {
    if (result.pending) {
      data.pendingCreate = result.pending as unknown as OwnedPendingCreate;
    }
    return { ok: false, error: result.blockedReason || "attestation_failed" };
  }
  const context = makeContext();
  context.data.pendingCreate = pending;
  if (!adoptPendingOrder(context, pending, result.adoptedOrderId)) {
    return { ok: false, error: "adoption_failed" };
  }
  return { ok: true, orderId: result.adoptedOrderId };
}

export function resolveMarketSalePendingCreateAbsence(
  candidateIds: string[],
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  const pending = data.pendingCreate;
  if (!pending) return { ok: false, error: "pending_create_missing" };
  if (!Array.isArray(candidateIds) || candidateIds.some((id) => typeof id !== "string")) {
    return { ok: false, error: "candidate_ids_invalid" };
  }
  const uniqueIds = [...new Set(candidateIds.map((id) => id.trim()).filter(Boolean))].sort();
  const liveIds = new Set(readLiveOrders().map((order) => order.id));
  const stillPresent = uniqueIds.filter((id) => liveIds.has(id));
  if (stillPresent.length > 0) {
    appendAudit(data, {
      action: "operator_absence_resolution_rejected",
      requestId: pending.requestId,
      candidateIds: stillPresent,
    });
    return { ok: false, error: "candidate_still_present", stillPresent };
  }
  data.pendingCreate = {
    ...pending,
    operatorResolutionCandidateIds: uniqueIds,
    zeroDeltaConfirmations: 0,
    lastZeroDeltaTick: undefined,
    status: "ambiguous",
  };
  appendAudit(data, {
    action: "operator_absence_resolution_requested",
    requestId: pending.requestId,
    candidateIds: uniqueIds,
  });
  return { ok: true, candidateIds: uniqueIds, confirmationsRequired: 2 };
}

function extractLedgerCarriedDebt(
  data: MarketSaleDataState,
  ledger: MarketSaleFeeLedgerState,
  resourceType: ResourceConstant,
): { ledger: MarketSaleFeeLedgerState; amountMilli: number } | undefined {
  const extracted = takeCarriedFeeDebt(ledger, resourceType);
  const current = data.carriedFeeDebtMilli[resourceType] ?? 0;
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(current + extracted.feeDebtMilli)
  ) {
    return undefined;
  }
  return {
    ledger: extracted.ledger,
    amountMilli: extracted.feeDebtMilli,
  };
}

function switchToNextManagedFeeGap(data: MarketSaleDataState): void {
  if (data.feeLedger?.reconcileGap) return;
  const managed = Object.values(data.managedOrders).sort((left, right) =>
    left.orderId.localeCompare(right.orderId),
  );
  const external = managed.find(
    (candidate) => candidate.externalMutationGap !== undefined,
  );
  if (external) {
    data.feeLedger = markExternalOrderMutationFeeGap({
      ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
      gameTime: external.externalMutationGap!.detectedAt,
      orderId: external.orderId,
    });
    return;
  }
  const disappeared = managed.find(
    (candidate) => candidate.disappearanceGap !== undefined,
  );
  if (!disappeared) return;
  data.feeLedger = reconcileDisappearedOrderFeeDebt({
    ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
    gameTime: disappeared.disappearanceGap!.detectedAt,
    orderId: disappeared.orderId,
    resourceType: disappeared.resourceType,
    remainingFeeDebtMilli: nonNegativeInteger(
      disappeared.feeDebtMilli,
    ),
    reason: "unknown",
  }).ledger;
}

/**
 * Operator-only closeout for a managed order whose live immutable state
 * changed outside our pending-mutation protocol.  The supplied milli-credit
 * debt must conservatively include every known and externally incurred fee.
 */
export function resolveMarketSaleExternalOrderMutation(
  orderId: string,
  verifiedRemainingFeeDebtMilli: number,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedOrderId =
    typeof orderId === "string" ? orderId.trim() : "";
  if (!normalizedOrderId) return { ok: false, error: "order_id_required" };
  if (
    !Number.isSafeInteger(verifiedRemainingFeeDebtMilli) ||
    verifiedRemainingFeeDebtMilli < 0
  ) {
    return {
      ok: false,
      error: "verified_remaining_fee_debt_milli_invalid",
    };
  }
  const data = ensureDataState();
  const managed = data.managedOrders[normalizedOrderId];
  if (!managed?.externalMutationGap) {
    return { ok: false, error: "external_mutation_gap_missing" };
  }
  if (verifiedRemainingFeeDebtMilli < managed.feeDebtMilli) {
    return { ok: false, error: "verified_fee_debt_below_known_debt" };
  }
  if (data.pendingMutations[normalizedOrderId]) {
    return { ok: false, error: "pending_mutation_exists" };
  }
  if (readLiveOrders().some((order) => order.id === normalizedOrderId)) {
    return { ok: false, error: "managed_order_still_present" };
  }
  const ledger = data.feeLedger || createEmptyMarketSaleFeeLedger();
  let resolved:
    | { ledger: MarketSaleFeeLedgerState; amountMilli: number }
    | undefined;
  try {
    const reconciled = resolveExternalOrderMutationFeeGap({
      ledger,
      orderId: normalizedOrderId,
      resourceType: managed.resourceType,
      verifiedRemainingFeeDebtMilli,
    });
    resolved = extractLedgerCarriedDebt(
      data,
      reconciled,
      managed.resourceType,
    );
  } catch {
    return { ok: false, error: "fee_reconcile_gap_mismatch" };
  }
  if (!resolved) return { ok: false, error: "carried_fee_debt_overflow" };
  data.feeLedger = resolved.ledger;
  carryFeeDebt(
    data,
    managed.resourceType,
    resolved.amountMilli,
    `external-mutation-carry:${normalizedOrderId}:${managed.externalMutationGap.detectedAt}`,
  );
  delete data.managedOrders[normalizedOrderId];
  switchToNextManagedFeeGap(data);
  appendAudit(data, {
    action: "external_order_mutation_reconciled",
    orderId: normalizedOrderId,
  });
  return {
    ok: true,
    orderId: normalizedOrderId,
    carriedFeeDebtMilli: resolved.amountMilli,
  };
}

export function resolveMarketSaleOrderDisappearance(
  orderId: string,
  classification: "policy_cancelled" | "server_expired",
  verifiedRefundMilli?: number,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedOrderId =
    typeof orderId === "string" ? orderId.trim() : "";
  if (!normalizedOrderId) return { ok: false, error: "order_id_required" };
  if (
    classification !== "policy_cancelled" &&
    classification !== "server_expired"
  ) {
    return { ok: false, error: "disappearance_classification_invalid" };
  }
  if (
    classification === "policy_cancelled" &&
    verifiedRefundMilli !== undefined
  ) {
    return { ok: false, error: "policy_cancel_does_not_refund" };
  }
  if (
    classification === "server_expired" &&
    (!Number.isSafeInteger(verifiedRefundMilli) ||
      (verifiedRefundMilli as number) < 0)
  ) {
    return { ok: false, error: "verified_refund_milli_required" };
  }
  const data = ensureDataState();
  const managed = data.managedOrders[normalizedOrderId];
  if (!managed?.disappearanceGap || managed.externalMutationGap) {
    return { ok: false, error: "disappearance_gap_missing" };
  }
  if (data.pendingMutations[normalizedOrderId]) {
    return { ok: false, error: "pending_mutation_exists" };
  }
  if (readLiveOrders().some((order) => order.id === normalizedOrderId)) {
    return { ok: false, error: "managed_order_still_present" };
  }

  let reconciliation: ReturnType<typeof resolveDisappearedOrderFeeGap>;
  try {
    reconciliation = resolveDisappearedOrderFeeGap({
      ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
      gameTime: Game.time,
      orderId: normalizedOrderId,
      resourceType: managed.resourceType,
      remainingFeeDebtMilli: nonNegativeInteger(managed.feeDebtMilli),
      reason: classification,
      verifiedRefundMilli:
        classification === "server_expired"
          ? verifiedRefundMilli
          : undefined,
    });
  } catch {
    return { ok: false, error: "fee_reconcile_gap_mismatch" };
  }
  if (!reconciliation.resolved) {
    data.feeLedger = reconciliation.ledger;
    managed.disappearanceGap.reason =
      reconciliation.ledger.reconcileGap?.reason ===
      "server_expiry_refund_mismatch"
        ? "server_expiry_refund_mismatch"
        : "unknown_disappearance";
    return { ok: false, error: "verified_refund_mismatch" };
  }
  const resolved = extractLedgerCarriedDebt(
    data,
    reconciliation.ledger,
    managed.resourceType,
  );
  if (!resolved) return { ok: false, error: "carried_fee_debt_overflow" };
  data.feeLedger = resolved.ledger;
  carryFeeDebt(
    data,
    managed.resourceType,
    resolved.amountMilli,
    `disappearance-carry:${normalizedOrderId}:${managed.disappearanceGap.detectedAt}`,
  );
  if (
    classification === "server_expired" &&
    typeof verifiedRefundMilli === "number" &&
    verifiedRefundMilli > 0
  ) {
    boundedPush(
      data.feeEvents,
      {
        id: `server-expiry-refund:${normalizedOrderId}:${Game.time}`,
        tick: Game.time,
        resource: managed.resourceType,
        amountMilli: verifiedRefundMilli,
        kind: "refund",
      },
      MAX_FEE_EVENTS,
    );
  }
  delete data.managedOrders[normalizedOrderId];
  switchToNextManagedFeeGap(data);
  appendAudit(data, {
    action: `order_disappearance_reconciled:${classification}`,
    orderId: normalizedOrderId,
  });
  return {
    ok: true,
    orderId: normalizedOrderId,
    classification,
    refundedFeeDebtMilli: reconciliation.refundedFeeDebtMilli,
    carriedFeeDebtMilli: resolved.amountMilli,
  };
}

export function expandMarketSaleCanary(
  configRevision: string,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const config = resolveMarketSaleAutomationConfig();
  if (
    !config.configRevision ||
    configRevision !== config.configRevision
  ) {
    return { ok: false, error: "config_revision_mismatch" };
  }
  if (!Memory.cfg?.marketSaleAutomation) {
    return { ok: false, error: "market_sale_config_missing" };
  }
  Memory.cfg.marketSaleAutomation.canary ||= {};
  Memory.cfg.marketSaleAutomation.canary.allowExpansion = true;
  const data = ensureDataState();
  data.expansionGrant = {
    configRevision,
    grantedAt: Game.time,
  };
  appendAudit(data, { action: "canary_expansion_granted" });
  return { ok: true, configRevision, grantedAt: Game.time };
}

export function emergencyStopMarketSaleAutomation(
  reason = "operator_requested",
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  if (!Memory.cfg) Memory.cfg = {};
  Memory.cfg.marketSaleAutomation ||= {};
  Memory.cfg.marketSaleAutomation.mode = "emergencyStop";
  appendAudit(ensureDataState(), {
    action: `emergency_stop:${String(reason).slice(0, 100)}`,
  });
  return { ok: true, requestedAt: Game.time };
}

export function marketSaleAutomationStatus(): unknown {
  const data = ensureDataState();
  return {
    tick: Game.time,
    config: resolveMarketSaleAutomationConfig(),
    runtime: Memory.runtime?.marketSaleAutomation || null,
    data,
    direct: isContinuousDirectState(data.directAutomation)
      ? projectContinuousDirectStatus(
          data.directAutomation,
          Game.time,
        )
      : data.directAutomation || null,
    legacyLatches: {
      resourceControl:
        Memory.cfg?.resourceControl?.market?.enabled === false,
      factoryControl:
        Memory.cfg?.factoryControl?.market?.enabled === false,
    },
  };
}
