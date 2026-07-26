import {
  DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
  DIRECT_CANARY_MAX_RAW_ORDERS,
  compareDirectPricingCandidates,
  rankDirectCurrentBuyOrders,
  type DirectPricingCandidate,
} from "@/runtime/marketSaleDirectPricing";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";

function order(
  id: string,
  price: number,
  amount = 1_000,
  roomName = "E51S9",
  type: "buy" | "sell" = "buy",
  resourceType = "X",
): MarketOrderSnapshot {
  return {
    id,
    type,
    resourceType,
    price,
    amount,
    roomName,
  };
}

function rank(
  orders: readonly MarketOrderSnapshot[],
  overrides: Partial<Parameters<typeof rankDirectCurrentBuyOrders>[0]> = {},
) {
  return rankDirectCurrentBuyOrders({
    orders,
    resourceType: "X",
    ownOrderIds: [],
    sellableAmount: 72_047,
    terminalStock: 72_047,
    effectiveNetFloor: 600,
    effectiveEnergyShadowPrice: 26.8,
    maxTransactionEnergyAvailable: 1_000,
    calculateTransactionEnergy: (amount) => (amount === 1 ? 1 : 900),
    ...overrides,
  });
}

function comparisonCandidate(
  id: string,
  netCreditsMilli: number,
  dealAmount: number,
  grossPriceMilli = 1_000,
): DirectPricingCandidate {
  return {
    order: order(id, grossPriceMilli / 1_000),
    dealAmount,
    grossPriceMilli,
    grossCreditsMilli: grossPriceMilli * dealAmount,
    transactionEnergy: 0,
    energyShadowPriceMilli: 0,
    energyShadowCostMilli: 0,
    netCreditsMilli,
    effectiveNetFloorMilli: 1,
    requiredNetCreditsMilli: dealAmount,
    worstCaseActualAmount: 1,
    worstCaseTransactionEnergy: 0,
    worstCaseNetCreditsMilli: grossPriceMilli,
    worstCaseRequiredNetCreditsMilli: 1,
  };
}

describe("Direct current BUY pricing", () => {
  it("accepts X 665.8 x 1,000 above a 600 floor without SELL depth or a 5,000 fill", () => {
    const result = rank([
      order("maker-sell-1", 1_120.638, 1_600, "E20S20", "sell"),
      order("maker-sell-2", 1_120.638, 3_700, "E21S20", "sell"),
      order("lower-large", 640, 5_000, "E1N1"),
      order("top", 665.8, 1_000, "E51S9"),
    ], {
      calculateTransactionEnergy: (amount, candidate) => {
        if (amount === 1) return 1;
        return candidate.id === "top" ? 900 : 100;
      },
    });

    expect(result).toMatchObject({
      safe: true,
      effectiveNetFloorMilli: 600_000,
      energyShadowPriceMilli: 26_800,
      selected: {
        order: { id: "top", amount: 1_000 },
        dealAmount: 1_000,
        grossPriceMilli: 665_800,
        grossCreditsMilli: 665_800_000,
        transactionEnergy: 900,
        energyShadowCostMilli: 24_120_000,
        netCreditsMilli: 641_680_000,
        worstCaseActualAmount: 1,
        worstCaseTransactionEnergy: 1,
        worstCaseNetCreditsMilli: 639_000,
      },
      summary: {
        rawOrderCount: 4,
        eligibleOrderCount: 2,
        eligibleDepth: 6_000,
        eligibleDistinctRoomCount: 2,
        pricedOrderCount: 2,
        safeCandidateCount: 2,
      },
    });
    expect(result.rejectedOrders).toEqual([
      { orderId: "maker-sell-1", reason: "side_mismatch" },
      { orderId: "maker-sell-2", reason: "side_mismatch" },
    ]);
  });

  it("uses transaction-energy net unit value before total amount or gross quote", () => {
    const result = rank([
      order("far-higher-gross", 670, 5_000, "W50N50"),
      order("near-better-net", 665, 1_000, "E7N59"),
    ], {
      effectiveEnergyShadowPrice: 30,
      calculateTransactionEnergy: (amount, candidate) => {
        if (amount === 1) return 1;
        return candidate.id === "far-higher-gross" ? 1_000 : 10;
      },
    });

    expect(result.candidates.map((candidate) => candidate.order.id)).toEqual([
      "near-better-net",
      "far-higher-gross",
    ]);
    expect(result.selected).toMatchObject({
      order: { id: "near-better-net" },
      dealAmount: 1_000,
    });
  });

  it("排除超过 terminal reservation 外能量的高价远单，并选择可执行的次高净价单", () => {
    const result = rank([
      order("far-high", 700, 1_000, "W50N50"),
      order("near-safe", 665, 1_000, "E7N59"),
    ], {
      maxTransactionEnergyAvailable: 500,
      calculateTransactionEnergy: (amount, candidate) => {
        if (amount === 1) return 1;
        return candidate.id === "far-high" ? 900 : 100;
      },
    });

    expect(result.selected?.order.id).toBe("near-safe");
    expect(result.rejectedOrders).toContainEqual({
      orderId: "far-high",
      reason: "transaction_energy_exceeded",
    });
  });

  it("requires both planned-size and amount-one conservative totals to clear the floor", () => {
    const plannedUnsafe = rank([order("planned-unsafe", 630)], {
      effectiveEnergyShadowPrice: 31,
      calculateTransactionEnergy: (amount) => (amount === 1 ? 1 : 1_000),
    });
    expect(plannedUnsafe.candidates).toEqual([]);
    expect(plannedUnsafe.rejectedOrders).toContainEqual({
      orderId: "planned-unsafe",
      reason: "planned_net_below_floor",
    });

    const partialUnsafe = rank([order("partial-unsafe", 625)], {
      effectiveEnergyShadowPrice: 26,
      calculateTransactionEnergy: (amount) => (amount === 1 ? 1 : 1),
    });
    expect(partialUnsafe.candidates).toEqual([]);
    expect(partialUnsafe.rejectedOrders).toContainEqual({
      orderId: "partial-unsafe",
      reason: "worst_case_net_below_floor",
    });
  });

  it("compares exact quotient and remainder before total net value", () => {
    const higherUnitSmallerTotal = comparisonCandidate("higher-unit", 10, 3);
    const lowerUnitLargerTotal = comparisonCandidate("lower-unit", 23, 7);

    expect([
      lowerUnitLargerTotal,
      higherUnitSmallerTotal,
    ].sort(compareDirectPricingCandidates).map((candidate) => candidate.order.id))
      .toEqual(["higher-unit", "lower-unit"]);
  });

  it("uses total net, gross milli and ID as deterministic tie-breaks", () => {
    const candidates = [
      comparisonCandidate("z", 20, 10, 1_001),
      comparisonCandidate("b", 20, 10, 1_002),
      comparisonCandidate("a", 20, 10, 1_002),
      comparisonCandidate("larger-total", 40, 20, 1_000),
    ];

    expect(candidates.sort(compareDirectPricingCandidates).map((candidate) =>
      candidate.order.id)).toEqual([
      "larger-total",
      "a",
      "b",
      "z",
    ]);
  });

  it("does not let dust, self orders or gross-below-floor quotes consume eligible budget", () => {
    const validOrders = Array.from(
      { length: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS },
      (_, index) => order(`valid-${index}`, 665.8),
    );
    const cheapRejects = [
      ...Array.from({ length: 300 }, (_, index) =>
        order(`dust-${index}`, 1_000, 999)),
      ...Array.from({ length: 300 }, (_, index) =>
        order(`low-${index}`, 599, 50_000)),
      ...Array.from({ length: 100 }, (_, index) =>
        order(`self-${index}`, 1_000)),
      ...Array.from({ length: 100 }, (_, index) =>
        order(`sell-${index}`, 1_000, 10_000, "E2N2", "sell")),
    ];
    const calculateTransactionEnergy = jest.fn((amount: number) =>
      amount === 1 ? 1 : 10);
    const result = rank([...validOrders, ...cheapRejects], {
      ownOrderIds: Array.from({ length: 100 }, (_, index) => `self-${index}`),
      calculateTransactionEnergy,
    });

    expect(result.safe).toBe(true);
    expect(result.cycleRejection).toBeUndefined();
    expect(result.summary).toMatchObject({
      rawOrderCount: DIRECT_CANARY_MAX_RAW_ORDERS,
      eligibleOrderCount: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
      pricedOrderCount: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
      safeCandidateCount: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
      orderRejectionCounts: {
        dust_amount: 300,
        gross_below_floor: 300,
        self_order: 100,
        side_mismatch: 100,
      },
    });
    expect(calculateTransactionEnergy).toHaveBeenCalledTimes(
      DIRECT_CANARY_MAX_ELIGIBLE_ORDERS * 2,
    );
  });

  it("rejects the whole cycle before energy pricing when raw or eligible budgets are exceeded", () => {
    const calculateRawEnergy = jest.fn(() => 0);
    const rawOverflow = rank(
      Array.from(
        { length: DIRECT_CANARY_MAX_RAW_ORDERS + 1 },
        (_, index) => order(`raw-${index}`, 665.8),
      ),
      { calculateTransactionEnergy: calculateRawEnergy },
    );
    expect(rawOverflow).toMatchObject({
      safe: false,
      cycleRejection: { reason: "raw_order_limit_exceeded" },
      candidates: [],
    });
    expect(calculateRawEnergy).not.toHaveBeenCalled();

    const calculateEligibleEnergy = jest.fn(() => 0);
    const eligibleOverflow = rank(
      Array.from(
        { length: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS + 1 },
        (_, index) => order(`eligible-${index}`, 665.8),
      ),
      { calculateTransactionEnergy: calculateEligibleEnergy },
    );
    expect(eligibleOverflow).toMatchObject({
      safe: false,
      cycleRejection: { reason: "eligible_order_limit_exceeded" },
      summary: {
        eligibleOrderCount: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS + 1,
        pricedOrderCount: 0,
      },
      candidates: [],
    });
    expect(calculateEligibleEnergy).not.toHaveBeenCalled();
  });

  it("uses actual executable notional and the fixed 600,000-credit minimum", () => {
    const result = rank([
      order("notional-dust", 599, 1_000),
      order("notional-ok", 600, 1_000),
    ], {
      effectiveNetFloor: 500,
      effectiveEnergyShadowPrice: 0,
      calculateTransactionEnergy: () => 0,
    });

    expect(result.rejectedOrders).toContainEqual({
      orderId: "notional-dust",
      reason: "dust_notional",
    });
    expect(result.selected).toMatchObject({
      order: { id: "notional-ok" },
      dealAmount: 1_000,
    });
  });

  it("fails closed on energy-pricing uncertainty instead of falling back to another order", () => {
    const result = rank([
      order("unknown-top", 700),
      order("known-lower", 665.8),
    ], {
      calculateTransactionEnergy: (_amount, candidate) => {
        if (candidate.id === "unknown-top") {
          throw new Error("market distance unavailable");
        }
        return 0;
      },
    });

    expect(result).toMatchObject({
      safe: false,
      cycleRejection: {
        reason: "energy_pricing_failed",
        orderId: "unknown-top",
      },
      candidates: [],
      summary: {
        eligibleOrderCount: 2,
        pricedOrderCount: 0,
      },
    });
  });

  it("fails closed when a conservative milli-credit operation exceeds safe precision", () => {
    const result = rank([order("overflow", Number.MAX_SAFE_INTEGER)]);

    expect(result).toMatchObject({
      safe: false,
      cycleRejection: {
        reason: "unsafe_arithmetic",
        orderId: "overflow",
      },
      candidates: [],
    });
  });
});
