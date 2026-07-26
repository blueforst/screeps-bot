import {
  priceToMilliDown,
  priceToMilliUp,
  type MarketOrderSnapshot,
  type MilliCredits,
} from "@/runtime/marketSalePricing";
import { DIRECT_ENGINE_ASSUMPTIONS } from "@/runtime/marketSaleDirectEngineAssumptions";

export const DIRECT_CANARY_MAX_RAW_ORDERS = 1_000;
export const DIRECT_CANARY_MAX_ELIGIBLE_ORDERS = 200;
export const DIRECT_CANARY_MIN_ORDER_AMOUNT = 1_000;
export const DIRECT_CANARY_MIN_ORDER_NOTIONAL_CREDITS = 600_000;
export const DIRECT_CANARY_MAX_DEAL_AMOUNT = 1_000;
export const DIRECT_CANARY_MAX_TRANSACTION_ENERGY = 1_000;

const MILLI_CREDITS_PER_CREDIT = 1_000;

export type DirectPricingOrderRejectionReason =
  | "duplicate_order_id"
  | "invalid_order_id"
  | "side_mismatch"
  | "resource_mismatch"
  | "missing_room"
  | "self_order"
  | "invalid_price"
  | "invalid_amount"
  | "dust_amount"
  | "deal_amount_below_minimum"
  | "dust_notional"
  | "gross_below_floor"
  | "transaction_energy_exceeded"
  | "planned_net_below_floor"
  | "worst_case_net_below_floor";

export type DirectPricingCycleRejectionReason =
  | "invalid_input"
  | "raw_order_limit_exceeded"
  | "eligible_order_limit_exceeded"
  | "energy_pricing_failed"
  | "unsafe_arithmetic";

export interface DirectPricingOrderRejection {
  orderId?: string;
  reason: DirectPricingOrderRejectionReason;
}

export interface DirectPricingCycleRejection {
  reason: DirectPricingCycleRejectionReason;
  orderId?: string;
  detail?: string;
}

export interface DirectPricingCandidate {
  order: MarketOrderSnapshot;
  dealAmount: number;
  grossPriceMilli: MilliCredits;
  grossCreditsMilli: MilliCredits;
  transactionEnergy: number;
  energyShadowPriceMilli: MilliCredits;
  energyShadowCostMilli: MilliCredits;
  netCreditsMilli: MilliCredits;
  effectiveNetFloorMilli: MilliCredits;
  requiredNetCreditsMilli: MilliCredits;
  worstCaseActualAmount:
    typeof DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount;
  worstCaseTransactionEnergy: number;
  worstCaseNetCreditsMilli: MilliCredits;
  worstCaseRequiredNetCreditsMilli: MilliCredits;
}

export interface DirectPricingSummary {
  rawOrderCount: number;
  highestGrossPrice?: number;
  eligibleOrderCount: number;
  eligibleDepth: number;
  eligibleDistinctRoomCount: number;
  pricedOrderCount: number;
  safeCandidateCount: number;
  rejectedOrderCount: number;
  orderRejectionCounts: Partial<Record<DirectPricingOrderRejectionReason, number>>;
}

export interface RankDirectCurrentBuyOrdersInput {
  orders: readonly MarketOrderSnapshot[];
  resourceType: string;
  ownOrderIds?: readonly string[];
  sellableAmount: number;
  terminalStock: number;
  effectiveNetFloor: number;
  effectiveEnergyShadowPrice: number;
  maxTransactionEnergyAvailable: number;
  calculateTransactionEnergy: (
    amount: number,
    order: MarketOrderSnapshot,
  ) => number;
}

export interface DirectPricingResult {
  safe: boolean;
  effectiveNetFloorMilli?: MilliCredits;
  energyShadowPriceMilli?: MilliCredits;
  candidates: DirectPricingCandidate[];
  selected?: DirectPricingCandidate;
  rejectedOrders: DirectPricingOrderRejection[];
  cycleRejection?: DirectPricingCycleRejection;
  summary: DirectPricingSummary;
}

interface EligibleOrder {
  order: MarketOrderSnapshot;
  dealAmount: number;
  grossPriceMilli: MilliCredits;
  grossCreditsMilli: MilliCredits;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkedMultiply(left: number, right: number): number | undefined {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function checkedSubtract(left: number, right: number): number | undefined {
  const result = left - right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function stableStringCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function incrementReason(
  counts: Partial<Record<DirectPricingOrderRejectionReason, number>>,
  reason: DirectPricingOrderRejectionReason,
): void {
  counts[reason] = (counts[reason] || 0) + 1;
}

function emptySummary(rawOrderCount: number): DirectPricingSummary {
  return {
    rawOrderCount,
    eligibleOrderCount: 0,
    eligibleDepth: 0,
    eligibleDistinctRoomCount: 0,
    pricedOrderCount: 0,
    safeCandidateCount: 0,
    rejectedOrderCount: 0,
    orderRejectionCounts: {},
  };
}

function rejectCycle(
  summary: DirectPricingSummary,
  rejectedOrders: DirectPricingOrderRejection[],
  rejection: DirectPricingCycleRejection,
  effectiveNetFloorMilli?: MilliCredits,
  energyShadowPriceMilli?: MilliCredits,
): DirectPricingResult {
  summary.rejectedOrderCount = rejectedOrders.length;
  return {
    safe: false,
    effectiveNetFloorMilli,
    energyShadowPriceMilli,
    candidates: [],
    rejectedOrders,
    cycleRejection: rejection,
    summary,
  };
}

/**
 * Compare Direct candidates without floating point arithmetic.
 *
 * Unit net value is compared by quotient first, then by the exact fractional
 * remainder. The remaining tie-breaks are total net value, gross quote and ID.
 */
export function compareDirectPricingCandidates(
  left: DirectPricingCandidate,
  right: DirectPricingCandidate,
): number {
  const leftQuotient = Math.floor(left.netCreditsMilli / left.dealAmount);
  const rightQuotient = Math.floor(right.netCreditsMilli / right.dealAmount);
  if (leftQuotient !== rightQuotient) {
    return leftQuotient > rightQuotient ? -1 : 1;
  }

  const leftRemainder = left.netCreditsMilli % left.dealAmount;
  const rightRemainder = right.netCreditsMilli % right.dealAmount;
  const leftCross = checkedMultiply(leftRemainder, right.dealAmount);
  const rightCross = checkedMultiply(rightRemainder, left.dealAmount);
  if (leftCross === undefined || rightCross === undefined) {
    throw new RangeError("candidate unit-net comparison exceeds safe integer precision");
  }
  if (leftCross !== rightCross) {
    return leftCross > rightCross ? -1 : 1;
  }
  if (left.netCreditsMilli !== right.netCreditsMilli) {
    return left.netCreditsMilli > right.netCreditsMilli ? -1 : 1;
  }
  if (left.grossPriceMilli !== right.grossPriceMilli) {
    return left.grossPriceMilli > right.grossPriceMilli ? -1 : 1;
  }
  return stableStringCompare(left.order.id, right.order.id);
}

/**
 * Rank the complete current-tick BUY book for the first Direct X canary.
 *
 * This function intentionally has no SELL-book input. A single current BUY
 * order can be executable when its exact planned and worst-case partial-fill
 * economics satisfy the production floor.
 */
export function rankDirectCurrentBuyOrders(
  input: RankDirectCurrentBuyOrdersInput,
): DirectPricingResult {
  const rawOrderCount = Array.isArray(input.orders) ? input.orders.length : 0;
  const summary = emptySummary(rawOrderCount);
  const rejectedOrders: DirectPricingOrderRejection[] = [];
  const ownOrderIds = new Set(input.ownOrderIds || []);

  if (
    !Array.isArray(input.orders) ||
    typeof input.resourceType !== "string" ||
    input.resourceType.length === 0 ||
    !isNonNegativeSafeInteger(input.sellableAmount) ||
    !isNonNegativeSafeInteger(input.terminalStock) ||
    !Number.isFinite(input.effectiveNetFloor) ||
    input.effectiveNetFloor <= 0 ||
    !Number.isFinite(input.effectiveEnergyShadowPrice) ||
    input.effectiveEnergyShadowPrice < 0 ||
    !isNonNegativeSafeInteger(input.maxTransactionEnergyAvailable) ||
    typeof input.calculateTransactionEnergy !== "function" ||
    [...ownOrderIds].some((orderId) => typeof orderId !== "string")
  ) {
    return rejectCycle(summary, rejectedOrders, { reason: "invalid_input" });
  }

  if (input.orders.length > DIRECT_CANARY_MAX_RAW_ORDERS) {
    return rejectCycle(summary, rejectedOrders, {
      reason: "raw_order_limit_exceeded",
      detail: `${input.orders.length}>${DIRECT_CANARY_MAX_RAW_ORDERS}`,
    });
  }

  let effectiveNetFloorMilli: MilliCredits;
  let energyShadowPriceMilli: MilliCredits;
  const minOrderNotionalMilli = checkedMultiply(
    DIRECT_CANARY_MIN_ORDER_NOTIONAL_CREDITS,
    MILLI_CREDITS_PER_CREDIT,
  );
  try {
    effectiveNetFloorMilli = priceToMilliUp(input.effectiveNetFloor);
    energyShadowPriceMilli = priceToMilliUp(
      Math.max(input.effectiveEnergyShadowPrice, Number.MIN_VALUE),
    );
  } catch (error) {
    return rejectCycle(summary, rejectedOrders, {
      reason: "unsafe_arithmetic",
      detail: error instanceof Error ? error.message : "price conversion failed",
    });
  }
  if (input.effectiveEnergyShadowPrice === 0) {
    energyShadowPriceMilli = 0;
  }
  if (minOrderNotionalMilli === undefined) {
    return rejectCycle(
      summary,
      rejectedOrders,
      { reason: "unsafe_arithmetic", detail: "minimum order notional overflow" },
      effectiveNetFloorMilli,
      energyShadowPriceMilli,
    );
  }

  const seenOrderIds = new Set<string>();
  const eligibleRoomNames = new Set<string>();
  const eligibleOrders: EligibleOrder[] = [];
  const rejectOrder = (
    orderId: string | undefined,
    reason: DirectPricingOrderRejectionReason,
  ): void => {
    rejectedOrders.push({ orderId, reason });
    incrementReason(summary.orderRejectionCounts, reason);
  };

  for (const order of input.orders) {
    const orderId = typeof order?.id === "string" ? order.id : undefined;
    if (!orderId || orderId.length === 0) {
      rejectOrder(orderId, "invalid_order_id");
      continue;
    }
    if (seenOrderIds.has(orderId)) {
      rejectOrder(orderId, "duplicate_order_id");
      continue;
    }
    seenOrderIds.add(orderId);
    if (order.type !== "buy") {
      rejectOrder(orderId, "side_mismatch");
      continue;
    }
    if (order.resourceType !== input.resourceType) {
      rejectOrder(orderId, "resource_mismatch");
      continue;
    }
    if (typeof order.roomName !== "string" || order.roomName.length === 0) {
      rejectOrder(orderId, "missing_room");
      continue;
    }
    if (ownOrderIds.has(orderId)) {
      rejectOrder(orderId, "self_order");
      continue;
    }
    if (!Number.isFinite(order.price) || order.price <= 0) {
      rejectOrder(orderId, "invalid_price");
      continue;
    }
    summary.highestGrossPrice = Math.max(
      summary.highestGrossPrice ?? Number.NEGATIVE_INFINITY,
      order.price,
    );
    if (!Number.isSafeInteger(order.amount) || order.amount <= 0) {
      rejectOrder(orderId, "invalid_amount");
      continue;
    }
    if (order.amount < DIRECT_CANARY_MIN_ORDER_AMOUNT) {
      rejectOrder(orderId, "dust_amount");
      continue;
    }

    const dealAmount = Math.min(
      order.amount,
      input.sellableAmount,
      input.terminalStock,
      DIRECT_CANARY_MAX_DEAL_AMOUNT,
    );
    if (dealAmount < DIRECT_CANARY_MIN_ORDER_AMOUNT) {
      rejectOrder(orderId, "deal_amount_below_minimum");
      continue;
    }

    let grossPriceMilli: MilliCredits;
    try {
      grossPriceMilli = priceToMilliDown(order.price);
    } catch (error) {
      return rejectCycle(
        summary,
        rejectedOrders,
        {
          reason: "unsafe_arithmetic",
          orderId,
          detail: error instanceof Error ? error.message : "order price conversion failed",
        },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }
    if (grossPriceMilli < effectiveNetFloorMilli) {
      rejectOrder(orderId, "gross_below_floor");
      continue;
    }
    const grossCreditsMilli = checkedMultiply(grossPriceMilli, dealAmount);
    if (grossCreditsMilli === undefined) {
      return rejectCycle(
        summary,
        rejectedOrders,
        { reason: "unsafe_arithmetic", orderId, detail: "gross notional overflow" },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }
    if (grossCreditsMilli < minOrderNotionalMilli) {
      rejectOrder(orderId, "dust_notional");
      continue;
    }
    eligibleOrders.push({
      order,
      dealAmount,
      grossPriceMilli,
      grossCreditsMilli,
    });
    if (
      summary.eligibleDepth >
      Number.MAX_SAFE_INTEGER - order.amount
    ) {
      return rejectCycle(
        summary,
        rejectedOrders,
        {
          reason: "unsafe_arithmetic",
          orderId,
          detail: "eligible depth overflow",
        },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }
    summary.eligibleDepth += order.amount;
    eligibleRoomNames.add(order.roomName);
  }

  summary.eligibleOrderCount = eligibleOrders.length;
  summary.eligibleDistinctRoomCount = eligibleRoomNames.size;
  if (eligibleOrders.length > DIRECT_CANARY_MAX_ELIGIBLE_ORDERS) {
    return rejectCycle(
      summary,
      rejectedOrders,
      {
        reason: "eligible_order_limit_exceeded",
        detail: `${eligibleOrders.length}>${DIRECT_CANARY_MAX_ELIGIBLE_ORDERS}`,
      },
      effectiveNetFloorMilli,
      energyShadowPriceMilli,
    );
  }

  const candidates: DirectPricingCandidate[] = [];
  for (const eligible of eligibleOrders) {
    const { order, dealAmount, grossPriceMilli, grossCreditsMilli } = eligible;
    let transactionEnergy: number;
    let worstCaseTransactionEnergy: number;
    try {
      transactionEnergy = input.calculateTransactionEnergy(dealAmount, order);
      worstCaseTransactionEnergy = input.calculateTransactionEnergy(1, order);
    } catch (error) {
      return rejectCycle(
        summary,
        rejectedOrders,
        {
          reason: "energy_pricing_failed",
          orderId: order.id,
          detail: error instanceof Error ? error.message : "energy pricing threw",
        },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }
    if (
      !isNonNegativeSafeInteger(transactionEnergy) ||
      !isNonNegativeSafeInteger(worstCaseTransactionEnergy)
    ) {
      return rejectCycle(
        summary,
        rejectedOrders,
        {
          reason: "energy_pricing_failed",
          orderId: order.id,
          detail: "energy cost must be a non-negative safe integer",
        },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }
    summary.pricedOrderCount += 1;
    if (
      transactionEnergy >
      Math.min(
        DIRECT_CANARY_MAX_TRANSACTION_ENERGY,
        input.maxTransactionEnergyAvailable,
      )
    ) {
      rejectOrder(order.id, "transaction_energy_exceeded");
      continue;
    }

    const energyShadowCostMilli = checkedMultiply(
      transactionEnergy,
      energyShadowPriceMilli,
    );
    const requiredNetCreditsMilli = checkedMultiply(
      effectiveNetFloorMilli,
      dealAmount,
    );
    const worstCaseEnergyShadowCostMilli = checkedMultiply(
      worstCaseTransactionEnergy,
      energyShadowPriceMilli,
    );
    if (
      energyShadowCostMilli === undefined ||
      requiredNetCreditsMilli === undefined ||
      worstCaseEnergyShadowCostMilli === undefined
    ) {
      return rejectCycle(
        summary,
        rejectedOrders,
        { reason: "unsafe_arithmetic", orderId: order.id },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }

    const netCreditsMilli = checkedSubtract(
      grossCreditsMilli,
      energyShadowCostMilli,
    );
    const worstCaseNetCreditsMilli = checkedSubtract(
      grossPriceMilli,
      worstCaseEnergyShadowCostMilli,
    );
    if (netCreditsMilli === undefined || worstCaseNetCreditsMilli === undefined) {
      return rejectCycle(
        summary,
        rejectedOrders,
        {
          reason: "unsafe_arithmetic",
          orderId: order.id,
          detail: "net value overflow",
        },
        effectiveNetFloorMilli,
        energyShadowPriceMilli,
      );
    }
    if (netCreditsMilli < requiredNetCreditsMilli) {
      rejectOrder(order.id, "planned_net_below_floor");
      continue;
    }
    if (worstCaseNetCreditsMilli < effectiveNetFloorMilli) {
      rejectOrder(order.id, "worst_case_net_below_floor");
      continue;
    }

    candidates.push({
      order,
      dealAmount,
      grossPriceMilli,
      grossCreditsMilli,
      transactionEnergy,
      energyShadowPriceMilli,
      energyShadowCostMilli,
      netCreditsMilli,
      effectiveNetFloorMilli,
      requiredNetCreditsMilli,
    worstCaseActualAmount:
      DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount,
      worstCaseTransactionEnergy,
      worstCaseNetCreditsMilli,
      worstCaseRequiredNetCreditsMilli: effectiveNetFloorMilli,
    });
  }

  try {
    candidates.sort(compareDirectPricingCandidates);
  } catch (error) {
    return rejectCycle(
      summary,
      rejectedOrders,
      {
        reason: "unsafe_arithmetic",
        detail: error instanceof Error ? error.message : "candidate comparison failed",
      },
      effectiveNetFloorMilli,
      energyShadowPriceMilli,
    );
  }

  summary.safeCandidateCount = candidates.length;
  summary.rejectedOrderCount = rejectedOrders.length;
  return {
    safe: true,
    effectiveNetFloorMilli,
    energyShadowPriceMilli,
    candidates,
    selected: candidates[0],
    rejectedOrders,
    summary,
  };
}
