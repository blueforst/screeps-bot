export type MarketSaleMode = "off" | "shadow" | "maker" | "hybrid" | "emergencyStop";

export type MarketSalePhase =
  | "off"
  | "shadow"
  | "maker"
  | "hybrid"
  | "requested"
  | "draining"
  | "stopped";

export interface MarketOrderSnapshot {
  id: string;
  type: string;
  resourceType: MarketResourceConstant;
  roomName?: string;
  price: number;
  totalAmount?: number;
  remainingAmount: number;
  amount?: number;
  created: number;
  active?: boolean;
}

export interface OrderMutationLease {
  epoch: string;
  grantedAt: number;
  expiresAt: number;
  baselineHash: string;
  revokedAt?: number;
  revokeReason?: string;
}

export interface PendingCreateTuple {
  type: ORDER_BUY | ORDER_SELL;
  resourceType: MarketResourceConstant;
  roomName?: string;
  price: number;
  totalAmount: number;
  createdNotBefore: number;
  createdNotAfter: number;
}

export interface PendingCreateAuditEntry {
  tick: number;
  action: string;
  candidateIds: string[];
}

export interface PendingCreateState {
  requestId: string;
  requestedAt: number;
  baselineOrderIds: string[];
  baselineHash: string;
  leaseEpoch: string;
  tuple: PendingCreateTuple;
  feeMilli: number;
  exposure: number;
  zeroDeltaConfirmations: number;
  lastZeroDeltaTick?: number;
  status: "prepared" | "submitted" | "ambiguous";
  audit: PendingCreateAuditEntry[];
}

export interface ManagedMarketOrderState {
  orderId: string;
  roomName: string;
  resourceType: MarketResourceConstant;
  price: number;
  originalAmount: number;
  lastRemainingAmount: number;
  remainingExposure: number;
  feeDebtMilli: number;
  createdAt: number;
  lastSeenAt: number;
  lastFillAt?: number;
  policyCancelAtTick: number;
  /**
   * Screeps exposes Order.created as a game tick, not a wall-clock timestamp.
   * Natural expiry cannot be inferred from this public field.
   */
  serverCreatedTick: number;
  /**
   * A live price/totalAmount drift without our own pending mutation means an
   * external mutation may have incurred an unobserved fee.  Keep this fence
   * until an operator reconciles the exact managed ID and remaining fee debt.
   */
  externalMutationGap?: {
    detectedAt: number;
    expectedPrice: number;
    observedPrice: number;
    expectedTotalAmount: number;
    observedTotalAmount?: number;
    conservativeExposure: number;
  };
  /**
   * The ID disappeared without a transaction/pending-mutation proof.  Exposure
   * remains fenced until an operator identifies policy cancellation or proves
   * server expiry together with the actual refund.
   */
  disappearanceGap?: {
    detectedAt: number;
    reason: "unknown_disappearance" | "server_expiry_refund_mismatch";
  };
}

export type PendingMutationKind = "cancel" | "extend" | "reprice";

export interface PendingOrderMutation {
  kind: PendingMutationKind;
  orderId: string;
  requestedAt: number;
  pre: {
    price: number;
    totalAmount: number;
    remainingAmount: number;
    active?: boolean;
  };
  requested: {
    price?: number;
    addAmount?: number;
  };
  prospectiveFeeMilli: number;
  conservativeExposure: number;
  status: "prepared" | "submitted" | "reconcile_gap";
}

export interface CanaryLock {
  roomName: string;
  resourceType: MarketResourceConstant;
  lockedAt: number;
  configRevision: string;
}

export interface DrainState {
  phase: MarketSalePhase;
  targetMode?: "off" | "shadow";
  zeroConfirmations: number;
  lastZeroConfirmationTick?: number;
}

export interface PendingCreateReconcileResult {
  pending?: PendingCreateState;
  adoptedOrderId?: string;
  resolvedAs?: "filled_or_absent" | "operator_reconciled";
  blockedReason?: "lease_invalid" | "ambiguous_candidates" | "awaiting_confirmation";
}

export interface PendingMutationReconcileResult {
  pending?: PendingOrderMutation;
  confirmed: boolean;
  reconcileGap?: boolean;
  observedFillAmount?: number;
}

function quantizePrice(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function hashOrderIds(orderIds: string[]): string {
  let hash = 2_166_136_261;
  for (const id of [...orderIds].sort()) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 124;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createPendingCreateState(input: {
  requestId: string;
  gameTime: number;
  liveOrders: MarketOrderSnapshot[];
  lease: OrderMutationLease;
  tuple: PendingCreateTuple;
  feeMilli: number;
  exposure: number;
}): PendingCreateState | null {
  const baselineOrderIds = input.liveOrders.map((order) => order.id).sort();
  const baselineHash = hashOrderIds(baselineOrderIds);
  if (
    input.lease.revokedAt !== undefined ||
    input.lease.grantedAt > input.gameTime ||
    input.lease.expiresAt < input.gameTime ||
    input.lease.baselineHash !== baselineHash
  ) {
    return null;
  }
  return {
    requestId: input.requestId,
    requestedAt: input.gameTime,
    baselineOrderIds,
    baselineHash,
    leaseEpoch: input.lease.epoch,
    tuple: input.tuple,
    feeMilli: Math.max(0, Math.floor(input.feeMilli)),
    exposure: Math.max(0, Math.floor(input.exposure)),
    zeroDeltaConfirmations: 0,
    status: "prepared",
    audit: [],
  };
}

export function markPendingCreateSubmitted(pending: PendingCreateState): PendingCreateState {
  return {
    ...pending,
    status: "submitted",
    audit: [
      ...pending.audit,
      {
        tick: pending.requestedAt,
        action: "create_submitted",
        candidateIds: [],
      },
    ].slice(-20),
  };
}

function matchesPendingCreateTuple(order: MarketOrderSnapshot, tuple: PendingCreateTuple): boolean {
  return (
    order.type === tuple.type &&
    order.resourceType === tuple.resourceType &&
    order.roomName === tuple.roomName &&
    quantizePrice(order.price) === quantizePrice(tuple.price) &&
    order.totalAmount === tuple.totalAmount &&
    order.created >= tuple.createdNotBefore &&
    order.created <= tuple.createdNotAfter
  );
}

function isLeaseValidForPending(
  pending: PendingCreateState,
  lease: OrderMutationLease | undefined,
  gameTime: number,
): boolean {
  return Boolean(
    lease &&
      lease.epoch === pending.leaseEpoch &&
      lease.baselineHash === pending.baselineHash &&
      lease.revokedAt === undefined &&
      lease.grantedAt <= pending.requestedAt &&
      lease.expiresAt >= gameTime,
  );
}

export function reconcilePendingCreate(input: {
  pending: PendingCreateState;
  liveOrders: MarketOrderSnapshot[];
  lease?: OrderMutationLease;
  gameTime: number;
}): PendingCreateReconcileResult {
  const baseline = new Set(input.pending.baselineOrderIds);
  const added = input.liveOrders.filter((order) => !baseline.has(order.id));
  const candidateIds = added.map((order) => order.id).sort();

  if (added.length === 0) {
    const isNewTick = input.pending.lastZeroDeltaTick !== input.gameTime;
    const confirmations = isNewTick
      ? input.pending.zeroDeltaConfirmations + 1
      : input.pending.zeroDeltaConfirmations;
    if (confirmations >= 2) {
      return {
        resolvedAs: "filled_or_absent",
      };
    }
    return {
      pending: {
        ...input.pending,
        zeroDeltaConfirmations: confirmations,
        lastZeroDeltaTick: input.gameTime,
        audit: [
          ...input.pending.audit,
          {
            tick: input.gameTime,
            action: "zero_delta_observed",
            candidateIds: [],
          },
        ].slice(-20),
      },
      blockedReason: "awaiting_confirmation",
    };
  }

  const matches = added.filter((order) => matchesPendingCreateTuple(order, input.pending.tuple));
  const leaseValid = isLeaseValidForPending(input.pending, input.lease, input.gameTime);
  if (leaseValid && added.length === 1 && matches.length === 1) {
    return {
      adoptedOrderId: matches[0].id,
    };
  }

  return {
    pending: {
      ...input.pending,
      status: "ambiguous",
      zeroDeltaConfirmations: 0,
      lastZeroDeltaTick: undefined,
      audit: [
        ...input.pending.audit,
        {
          tick: input.gameTime,
          action: leaseValid ? "ambiguous_candidates" : "lease_invalid",
          candidateIds,
        },
      ].slice(-20),
    },
    blockedReason: leaseValid ? "ambiguous_candidates" : "lease_invalid",
  };
}

export function attestPendingCreateOrder(input: {
  pending: PendingCreateState;
  liveOrders: MarketOrderSnapshot[];
  orderId: string;
  gameTime: number;
}): PendingCreateReconcileResult {
  const baseline = new Set(input.pending.baselineOrderIds);
  const order = input.liveOrders.find((candidate) => candidate.id === input.orderId);
  if (!order || baseline.has(order.id) || !matchesPendingCreateTuple(order, input.pending.tuple)) {
    return {
      pending: {
        ...input.pending,
        audit: [
          ...input.pending.audit,
          {
            tick: input.gameTime,
            action: "operator_attestation_rejected",
            candidateIds: [input.orderId],
          },
        ].slice(-20),
      },
      blockedReason: "ambiguous_candidates",
    };
  }
  return {
    adoptedOrderId: order.id,
  };
}

export function createPendingMutation(input: {
  kind: PendingMutationKind;
  order: MarketOrderSnapshot;
  gameTime: number;
  requested?: { price?: number; addAmount?: number };
  prospectiveFeeMilli?: number;
  conservativeExposure: number;
}): PendingOrderMutation {
  return {
    kind: input.kind,
    orderId: input.order.id,
    requestedAt: input.gameTime,
    pre: {
      price: input.order.price,
      totalAmount: input.order.totalAmount ?? input.order.remainingAmount,
      remainingAmount: input.order.remainingAmount,
      active: input.order.active,
    },
    requested: input.requested || {},
    prospectiveFeeMilli: Math.max(0, Math.floor(input.prospectiveFeeMilli || 0)),
    conservativeExposure: Math.max(0, Math.floor(input.conservativeExposure)),
    status: "prepared",
  };
}

export function markPendingMutationSubmitted(pending: PendingOrderMutation): PendingOrderMutation {
  return {
    ...pending,
    status: "submitted",
  };
}

export function reconcilePendingMutation(input: {
  pending: PendingOrderMutation;
  liveOrder?: MarketOrderSnapshot;
}): PendingMutationReconcileResult {
  const { pending, liveOrder } = input;
  if (pending.kind === "cancel") {
    return liveOrder
      ? { pending, confirmed: false }
      : { confirmed: true };
  }

  if (!liveOrder) {
    return {
      pending: {
        ...pending,
        status: "reconcile_gap",
      },
      confirmed: false,
      reconcileGap: true,
    };
  }

  if (pending.kind === "extend") {
    const addAmount = Math.max(0, pending.requested.addAmount || 0);
    const expectedTotal = pending.pre.totalAmount + addAmount;
    if ((liveOrder.totalAmount ?? 0) !== expectedTotal) {
      return { pending, confirmed: false };
    }
    return {
      confirmed: true,
      observedFillAmount: Math.max(
        0,
        pending.pre.remainingAmount + addAmount - liveOrder.remainingAmount,
      ),
    };
  }

  if (quantizePrice(liveOrder.price) !== quantizePrice(pending.requested.price || 0)) {
    return { pending, confirmed: false };
  }
  return {
    confirmed: true,
    observedFillAmount: Math.max(0, pending.pre.remainingAmount - liveOrder.remainingAmount),
  };
}

export function lockCanary(
  current: CanaryLock | undefined,
  candidate: CanaryLock,
): CanaryLock | null {
  if (!current) return candidate;
  if (
    current.roomName !== candidate.roomName ||
    current.resourceType !== candidate.resourceType ||
    current.configRevision !== candidate.configRevision
  ) {
    return null;
  }
  return current;
}

export function canUseCanary(
  lock: CanaryLock | undefined,
  roomName: string,
  resourceType: MarketResourceConstant,
  configRevision: string,
): boolean {
  return Boolean(
    lock &&
      lock.roomName === roomName &&
      lock.resourceType === resourceType &&
      lock.configRevision === configRevision,
  );
}

export function updateDrainState(input: {
  state: DrainState;
  desiredMode: MarketSaleMode;
  gameTime: number;
  knownManagedIdsPresent: number;
  pendingCreateCount: number;
  pendingMutationCount: number;
  stagingAmount: number;
  reservationAmount: number;
  exposureAmount: number;
  reconcileGapCount: number;
}): DrainState {
  const wantsPassiveMode =
    input.desiredMode === "off" ||
    input.desiredMode === "shadow" ||
    input.desiredMode === "emergencyStop";
  const hasOutstanding =
    input.knownManagedIdsPresent > 0 ||
    input.pendingCreateCount > 0 ||
    input.pendingMutationCount > 0 ||
    input.stagingAmount > 0 ||
    input.reservationAmount > 0 ||
    input.exposureAmount > 0 ||
    input.reconcileGapCount > 0;

  if (!wantsPassiveMode) {
    return {
      phase: input.desiredMode === "hybrid" ? "hybrid" : "maker",
      zeroConfirmations: 0,
    };
  }

  const targetMode = input.desiredMode === "shadow" ? "shadow" : "off";
  if (hasOutstanding) {
    return {
      phase: input.state.phase === "requested" ? "draining" : "requested",
      targetMode,
      zeroConfirmations: 0,
    };
  }

  const isNewTick = input.state.lastZeroConfirmationTick !== input.gameTime;
  const confirmations = isNewTick
    ? input.state.zeroConfirmations + 1
    : input.state.zeroConfirmations;
  if (confirmations < 2) {
    return {
      phase: "draining",
      targetMode,
      zeroConfirmations: confirmations,
      lastZeroConfirmationTick: input.gameTime,
    };
  }

  if (input.desiredMode === "emergencyStop") {
    return {
      phase: "stopped",
      targetMode: "off",
      zeroConfirmations: confirmations,
      lastZeroConfirmationTick: input.gameTime,
    };
  }
  return {
    phase: targetMode,
    targetMode,
    zeroConfirmations: confirmations,
    lastZeroConfirmationTick: input.gameTime,
  };
}
