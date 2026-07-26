import {
  advanceTrustedFloor,
  allocateFeeDebtForFill,
  assessOrderBookDepth,
  buildTrustedHistoryFloor,
  calculateOrderFeeMilli,
  calculatePriceIncreaseFeeMilli,
  calculateProspectiveFeeMilli,
  ceilMilli,
  computeEffectiveNetFloor,
  computeEnergyShadowPrice,
  evaluatePostActionInvariant,
  findMinimumSafePrice,
  priceToMilliDown,
  rankDirectBuyOrders,
  roomBalancedMedianPrice,
  roundMarketPriceUp,
  weightedMedian,
  type MarketHistoryDay,
  type MarketOrderSnapshot,
} from "@/runtime/marketSalePricing";

function historyDay(
  date: string,
  avgPrice: number,
  volume: number,
  transactions = 10,
): MarketHistoryDay {
  return {
    resourceType: "H",
    date,
    transactions,
    volume,
    avgPrice,
    stddevPrice: avgPrice * 0.05,
  };
}

function buyOrder(
  id: string,
  price: number,
  amount: number,
  roomName: string,
): MarketOrderSnapshot {
  return {
    id,
    type: "buy",
    resourceType: "K",
    price,
    amount,
    roomName,
  };
}

describe("trusted market history", () => {
  it("uses complete liquid days, removes a log-MAD outlier, and takes a capped sqrt-volume weighted median", () => {
    const days: MarketHistoryDay[] = [
      historyDay("2026-07-18", 100, 100),
      historyDay("2026-07-19", 101, 400),
      historyDay("2026-07-20", 102, 900),
      historyDay("2026-07-21", 103, 1_600),
      historyDay("2026-07-22", 104, 2_500),
      historyDay("2026-07-23", 105, 3_600),
      historyDay("2026-07-24", 0.1, 1_000_000),
      historyDay("2026-07-25", 999, 1_000_000),
    ];

    const result = buildTrustedHistoryFloor(days, {
      asOfDate: "2026-07-25",
      resourceType: "H",
      minTransactionsPerDay: 3,
      minVolumePerDay: 100,
      maxSqrtVolumeWeightMultiple: 3,
      historyFloorRatio: 0.9,
    });

    expect(result).toMatchObject({
      trusted: true,
      latestHistoryDate: "2026-07-23",
      referencePrice: 104,
      trustedFloor: 93.6,
      completeDayCount: 7,
      acceptedDayCount: 6,
    });
    expect(result.acceptedDates).toEqual([
      "2026-07-18",
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
    ]);
    expect(result.rejectedDays).toEqual(expect.arrayContaining([
      { date: "2026-07-24", reason: "log_mad_outlier" },
      { date: "2026-07-25", reason: "incomplete_day" },
    ]));
  });

  it("caps one day's sqrt-volume weight so it cannot dominate the trusted median", () => {
    const result = buildTrustedHistoryFloor([
      historyDay("2026-07-18", 100, 100),
      historyDay("2026-07-19", 101, 100),
      historyDay("2026-07-20", 102, 100),
      historyDay("2026-07-21", 103, 100),
      historyDay("2026-07-22", 104, 100_000_000),
    ], {
      asOfDate: "2026-07-23",
      resourceType: "H",
      minTransactionsPerDay: 3,
      minVolumePerDay: 100,
      maxSqrtVolumeWeightMultiple: 1,
    });

    expect(result.trusted).toBe(true);
    expect(result.referencePrice).toBe(102);
  });

  it("fails closed when transaction and volume gates leave fewer than five complete days", () => {
    const result = buildTrustedHistoryFloor([
      historyDay("2026-07-17", 100, 1_000, 10),
      historyDay("2026-07-18", 101, 1_000, 10),
      historyDay("2026-07-19", 102, 1_000, 10),
      historyDay("2026-07-20", 103, 1_000, 10),
      historyDay("2026-07-21", 104, 50, 10),
      historyDay("2026-07-22", 105, 1_000, 1),
    ], {
      asOfDate: "2026-07-23",
      resourceType: "H",
      minTransactionsPerDay: 3,
      minVolumePerDay: 100,
    });

    expect(result).toMatchObject({
      trusted: false,
      reason: "insufficient_complete_days",
      completeDayCount: 4,
    });
    expect(result.rejectedDays).toEqual(expect.arrayContaining([
      { date: "2026-07-21", reason: "volume_below_minimum" },
      { date: "2026-07-22", reason: "transactions_below_minimum" },
    ]));
  });

  it("handles zero MAD conservatively and retains at least five identical trusted days", () => {
    const result = buildTrustedHistoryFloor([
      historyDay("2026-07-16", 100, 1_000),
      historyDay("2026-07-17", 100, 1_000),
      historyDay("2026-07-18", 100, 1_000),
      historyDay("2026-07-19", 100, 1_000),
      historyDay("2026-07-20", 100, 1_000),
      historyDay("2026-07-21", 100, 1_000),
      historyDay("2026-07-22", 1, 1_000_000),
    ], {
      asOfDate: "2026-07-23",
      resourceType: "H",
      minTransactionsPerDay: 3,
      minVolumePerDay: 100,
    });

    expect(result).toMatchObject({
      trusted: true,
      referencePrice: 100,
      acceptedDayCount: 6,
    });
    expect(result.rejectedDays).toContainEqual({
      date: "2026-07-22",
      reason: "log_mad_outlier",
    });
  });

  it("offers a deterministic weighted median primitive", () => {
    expect(weightedMedian([
      { value: 10, weight: 1 },
      { value: 20, weight: 2 },
      { value: 30, weight: 7 },
    ])).toBe(30);
    expect(weightedMedian([])).toBeNull();
  });

  it("compresses split orders to one equal-weight room vote and uses the safe upper middle boundary", () => {
    const orders = [
      buyOrder("low-1", 0.8, 1_000, "W1N1"),
      buyOrder("low-2", 0.8, 1_000, "W1N1"),
      buyOrder("low-3", 0.8, 1_000, "W1N1"),
      buyOrder("high-1", 1.2, 1_000, "W2N2"),
      buyOrder("high-2", 1.2, 1_000, "W3N3"),
    ];

    expect(roomBalancedMedianPrice(orders, 1_000)).toBe(1.2);
    expect(
      roomBalancedMedianPrice(
        orders.filter((order) => order.roomName !== "W3N3"),
        1_000,
      ),
    ).toBe(1.2);
    expect(roomBalancedMedianPrice([], 1_000)).toBeNull();
  });
});

describe("trusted floor daily ratchet", () => {
  it("limits decline by external history date and never compounds repeatedly in the same tick/day", () => {
    const initialized = advanceTrustedFloor(undefined, {
      historyDate: "2026-07-20",
      floor: 100,
    });
    const firstDecline = advanceTrustedFloor(initialized.state, {
      historyDate: "2026-07-21",
      floor: 50,
    });
    const sameHistoryDay = advanceTrustedFloor(firstDecline.state, {
      historyDate: "2026-07-21",
      floor: 10,
    });
    const nextHistoryDay = advanceTrustedFloor(sameHistoryDay.state, {
      historyDate: "2026-07-22",
      floor: 10,
    });

    expect(initialized.state.floor).toBe(100);
    expect(firstDecline).toMatchObject({
      changed: true,
      daysAdvanced: 1,
      ratchetFloor: 95,
      state: { floor: 95 },
    });
    expect(sameHistoryDay).toMatchObject({
      changed: false,
      reason: "same_history_day",
      state: { floor: 95 },
    });
    expect(nextHistoryDay).toMatchObject({
      daysAdvanced: 1,
      ratchetFloor: 90.25,
      state: { floor: 90.25 },
    });
  });

  it("allows at most five percent per elapsed complete day when dates jump", () => {
    const result = advanceTrustedFloor({
      historyDate: "2026-07-20",
      floor: 100,
      observedFloor: 100,
    }, {
      historyDate: "2026-07-22",
      floor: 1,
    });

    expect(result.daysAdvanced).toBe(2);
    expect(result.state.floor).toBe(90.25);
  });
});

describe("effective floor and energy shadow", () => {
  it("takes the maximum hard, economic, history, and ratchet component", () => {
    expect(computeEffectiveNetFloor({
      hardFloor: 1,
      economicFloor: 1.2,
      historyFloor: 1.1,
      ratchetFloor: 1.15,
    })).toMatchObject({
      valid: true,
      floor: 1.2,
      dominantComponent: "economic",
    });
  });

  it("fails closed without a positive hard floor", () => {
    expect(computeEffectiveNetFloor({
      hardFloor: 0,
      historyFloor: 10,
    })).toMatchObject({
      valid: false,
      reason: "hard_floor_missing_or_invalid",
    });
  });

  it("computes energy shadow price with the same conservative maximum", () => {
    expect(computeEnergyShadowPrice({
      hardFloor: 0.05,
      economicFloor: 0.07,
      historyFloor: 0.06,
      ratchetFloor: 0.065,
    })).toMatchObject({
      valid: true,
      price: 0.07,
      dominantComponent: "economic",
    });
  });
});

describe("order book depth and direct buy-order ranking", () => {
  it("filters dust and caps per-order depth contribution", () => {
    const assessment = assessOrderBookDepth({
      side: "buy",
      resourceType: "K",
      orders: [
        buyOrder("dust-amount", 1, 99, "W1N1"),
        buyOrder("dust-notional", 0.001, 1_000, "W1N2"),
        buyOrder("large", 1, 10_000, "W1N3"),
        buyOrder("second", 0.9, 800, "W1N4"),
      ],
      policy: {
        minOrderAmount: 100,
        minOrderNotional: 10,
        minCumulativeDepth: 1_000,
        minOrderCount: 2,
        minDistinctRooms: 2,
        maxDepthContributionPerOrder: 500,
      },
    });

    expect(assessment).toMatchObject({
      trusted: true,
      eligibleAmount: 10_800,
      trustedDepth: 1_000,
      distinctOrderCount: 2,
      distinctRoomCount: 2,
    });
    expect(assessment.rejectedOrders).toEqual(expect.arrayContaining([
      { orderId: "dust-amount", reason: "dust_amount" },
      { orderId: "dust-notional", reason: "dust_notional" },
    ]));
  });

  it("does not let one large order fake sufficient market depth", () => {
    const assessment = assessOrderBookDepth({
      side: "buy",
      resourceType: "K",
      orders: [
        buyOrder("large", 1, 100_000, "W1N1"),
        buyOrder("small", 0.9, 100, "W1N2"),
      ],
      policy: {
        minOrderAmount: 100,
        minCumulativeDepth: 1_100,
        minOrderCount: 2,
        minDistinctRooms: 2,
        maxDepthContributionPerOrder: 500,
      },
    });

    expect(assessment.trusted).toBe(false);
    expect(assessment.trustedDepth).toBe(600);
  });

  it("caps aggregate trusted depth from one room even when it splits into many orders", () => {
    const assessment = assessOrderBookDepth({
      side: "buy",
      resourceType: "K",
      orders: [
        buyOrder("split-1", 0.8, 1_000, "W1N1"),
        buyOrder("split-2", 0.8, 1_000, "W1N1"),
        buyOrder("split-3", 0.8, 1_000, "W1N1"),
        buyOrder("companion-1", 1.2, 1_000, "W2N2"),
        buyOrder("companion-2", 1.2, 1_000, "W3N3"),
      ],
      policy: {
        minOrderAmount: 1_000,
        minOrderNotional: 100,
        minCumulativeDepth: 3_000,
        minOrderCount: 3,
        minDistinctRooms: 3,
        maxDepthContributionPerOrder: 1_000,
        maxDepthContributionPerRoom: 1_000,
      },
    });

    expect(assessment).toMatchObject({
      trusted: true,
      eligibleAmount: 5_000,
      trustedDepth: 3_000,
      distinctOrderCount: 5,
      distinctRoomCount: 3,
    });
  });

  it("uses partial executable size and sorts by energy-shadow net price, not nominal quote", () => {
    const ranking = rankDirectBuyOrders({
      resourceType: "K",
      orders: [
        buyOrder("far-high", 1, 5_000, "W9N9"),
        buyOrder("near-lower", 0.95, 2_000, "W1N2"),
      ],
      safeAmount: 5_000,
      minDealAmount: 1_000,
      absoluteQuoteFloor: 0.7,
      effectiveNetFloor: 0.7,
      energyShadowPrice: 0.5,
      orderBookPolicy: {
        minOrderAmount: 100,
        minCumulativeDepth: 7_000,
        minOrderCount: 2,
        minDistinctRooms: 2,
      },
      calculateTransactionEnergy: (_amount, order) =>
        order.id === "far-high" ? 2_000 : 100,
    });

    expect(ranking.book.trusted).toBe(true);
    expect(ranking.candidates.map((candidate) => candidate.order.id)).toEqual([
      "near-lower",
      "far-high",
    ]);
    expect(ranking.selected).toMatchObject({
      order: { id: "near-lower" },
      dealAmount: 2_000,
    });
    expect(ranking.selected!.directNetPrice).toBeCloseTo(0.925, 12);
    expect(ranking.candidates[1].directNetPrice).toBe(0.8);
  });

  it("rejects direct execution when depth is untrusted or net price is below floor", () => {
    const untrusted = rankDirectBuyOrders({
      resourceType: "K",
      orders: [buyOrder("only", 1, 1_000, "W1N1")],
      safeAmount: 1_000,
      minDealAmount: 1_000,
      absoluteQuoteFloor: 0.5,
      effectiveNetFloor: 0.5,
      energyShadowPrice: 0.1,
      orderBookPolicy: {
        minOrderAmount: 100,
        minCumulativeDepth: 2_000,
      },
      calculateTransactionEnergy: () => 0,
    });
    expect(untrusted.candidates).toEqual([]);
    expect(untrusted.rejected).toContainEqual({ reason: "book_depth_untrusted" });

    const belowFloor = rankDirectBuyOrders({
      resourceType: "K",
      orders: [buyOrder("costly", 1, 2_000, "W9N9")],
      safeAmount: 2_000,
      minDealAmount: 1_000,
      absoluteQuoteFloor: 0.5,
      effectiveNetFloor: 0.95,
      energyShadowPrice: 0.5,
      requireTrustedDepth: false,
      orderBookPolicy: {
        minOrderAmount: 100,
        minCumulativeDepth: 0,
      },
      calculateTransactionEnergy: () => 1_000,
    });
    expect(belowFloor.candidates).toEqual([]);
    expect(belowFloor.rejected).toContainEqual({
      orderId: "costly",
      reason: "net_price_below_floor",
    });
  });

  it("requires depth from price-safe executable orders, not from low quotes that will be rejected", () => {
    const ranking = rankDirectBuyOrders({
      resourceType: "K",
      orders: [
        buyOrder("safe-thin", 1, 1_000, "W1N1"),
        buyOrder("low-deep", 0.01, 10_000, "W1N2"),
      ],
      safeAmount: 1_000,
      minDealAmount: 1_000,
      absoluteQuoteFloor: 0.5,
      effectiveNetFloor: 0.5,
      energyShadowPrice: 0.1,
      orderBookPolicy: {
        minOrderAmount: 100,
        minCumulativeDepth: 5_000,
        minOrderCount: 1,
        minDistinctRooms: 1,
      },
      calculateTransactionEnergy: () => 0,
    });

    expect(ranking.book.trusted).toBe(true);
    expect(ranking.executableBook.trusted).toBe(false);
    expect(ranking.candidates).toEqual([]);
    expect(ranking.rejected).toEqual(expect.arrayContaining([
      { orderId: "low-deep", reason: "quote_below_floor" },
      { reason: "book_depth_untrusted" },
    ]));
  });
});

describe("market price and fee fixed-point arithmetic", () => {
  it("rounds every quote upward to the next 0.001 market tick", () => {
    expect(roundMarketPriceUp(1)).toBe(1);
    expect(roundMarketPriceUp(1.0001)).toBe(1.001);
    expect(roundMarketPriceUp(0.00001)).toBe(0.001);
    expect(priceToMilliDown(1.0529)).toBe(1_052);
  });

  it("ceil-rounds order fees to integer milli-credits", () => {
    expect(ceilMilli(0)).toBe(0);
    expect(ceilMilli(0.00001)).toBe(1);
    expect(calculateOrderFeeMilli(0.001, 1)).toBe(1);
    expect(calculateOrderFeeMilli(1.053, 1_000)).toBe(52_650);
    expect(calculatePriceIncreaseFeeMilli(1, 1.001, 1_000)).toBe(50);
    expect(calculatePriceIncreaseFeeMilli(1.001, 1, 1_000)).toBe(0);
  });

  it("calculates prospective fees for create, extend, up-reprice, and down-reprice", () => {
    expect(calculateProspectiveFeeMilli(
      { kind: "create", amount: 1_000 },
      1.053,
    )).toBe(52_650);
    expect(calculateProspectiveFeeMilli({
      kind: "extend",
      currentPrice: 1.1,
      currentRemainingAmount: 1_000,
      addAmount: 500,
    })).toBe(27_500);
    expect(calculateProspectiveFeeMilli(
      { kind: "repriceUp", currentPrice: 1, remainingAmount: 1_000 },
      1.053,
    )).toBe(2_650);
    expect(calculateProspectiveFeeMilli(
      { kind: "repriceDown", currentPrice: 1.2, remainingAmount: 1_000 },
      1.06,
    )).toBe(0);
  });
});

describe("post-action order price invariant", () => {
  it("finds the minimum create price after prospective five-percent fee", () => {
    const result = findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 0,
      action: { kind: "create", amount: 1_000 },
    });

    expect(result).toMatchObject({
      safe: true,
      minimumSafePrice: 1.053,
      recommendedPrice: 1.053,
      evaluation: {
        prospectiveFeeMilli: 52_650,
        netRemainingValueMilli: 1_000_350,
        requiredNetValueMilli: 1_000_000,
        satisfiesInvariant: true,
      },
    });
    expect(evaluatePostActionInvariant({
      effectiveNetFloor: 1,
      feeDebtMilli: 0,
      action: { kind: "create", amount: 1_000 },
      candidatePrice: 1.052,
    }).satisfiesInvariant).toBe(false);
  });

  it("includes both remaining debt and prospective extend fee", () => {
    const safe = findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 55_000,
      action: {
        kind: "extend",
        currentPrice: 1.1,
        currentRemainingAmount: 1_000,
        addAmount: 500,
      },
    });
    expect(safe).toMatchObject({
      safe: true,
      minimumSafePrice: 1.055,
      recommendedPrice: 1.1,
      evaluation: {
        prospectiveFeeMilli: 27_500,
        postActionFeeDebtMilli: 82_500,
        satisfiesInvariant: true,
      },
    });

    const unsafe = findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 55_000,
      action: {
        kind: "extend",
        currentPrice: 1.03,
        currentRemainingAmount: 1_000,
        addAmount: 500,
      },
    });
    expect(unsafe).toMatchObject({
      safe: false,
      reason: "current_extend_price_unsafe",
      minimumSafePrice: 1.054,
    });

    expect(findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 0,
      action: {
        kind: "extend",
        currentPrice: 1.1,
        currentRemainingAmount: 0,
        addAmount: 500,
      },
    })).toMatchObject({
      safe: true,
      minimumSafePrice: 1.055,
    });
  });

  it("finds safe up- and down-reprice ticks with their different prospective fees", () => {
    const up = findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 50_000,
      action: {
        kind: "repriceUp",
        currentPrice: 1,
        remainingAmount: 1_000,
      },
    });
    expect(up).toMatchObject({
      safe: true,
      minimumSafePrice: 1.053,
      evaluation: {
        prospectiveFeeMilli: 2_650,
        netRemainingValueMilli: 1_000_350,
      },
    });

    const down = findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 60_000,
      action: {
        kind: "repriceDown",
        currentPrice: 1.2,
        remainingAmount: 1_000,
      },
    });
    expect(down).toMatchObject({
      safe: true,
      minimumSafePrice: 1.06,
      evaluation: {
        prospectiveFeeMilli: 0,
        netRemainingValueMilli: 1_000_000,
      },
    });

    const noSafeDown = findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 60_000,
      action: {
        kind: "repriceDown",
        currentPrice: 1.05,
        remainingAmount: 1_000,
      },
    });
    expect(noSafeDown).toMatchObject({
      safe: false,
      reason: "no_safe_down_reprice",
      minimumSafePrice: 1.06,
    });
  });

  it("fails rather than crossing a configured maximum quote", () => {
    expect(findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 0,
      action: { kind: "create", amount: 1_000 },
      maxPrice: 1.052,
    })).toMatchObject({
      safe: false,
      reason: "no_safe_price_within_limit",
    });
    expect(findMinimumSafePrice({
      effectiveNetFloor: 1,
      feeDebtMilli: 0,
      action: { kind: "create", amount: 1_000 },
      maxPrice: 1.0529,
    })).toMatchObject({
      safe: false,
      reason: "no_safe_price_within_limit",
    });
  });
});

describe("milli-credit fee debt allocation", () => {
  it("allocates floor-proportional debt and leaves every rounding remainder on remaining exposure", () => {
    const first = allocateFeeDebtForFill({
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 3,
    });
    const second = allocateFeeDebtForFill({
      feeDebtMilli: first.remainingFeeDebtMilli,
      filledAmount: 1,
      preRemainingAmount: first.postRemainingAmount,
    });
    const final = allocateFeeDebtForFill({
      feeDebtMilli: second.remainingFeeDebtMilli,
      filledAmount: 1,
      preRemainingAmount: second.postRemainingAmount,
    });

    expect(first).toEqual({
      allocatedFeeDebtMilli: 3,
      remainingFeeDebtMilli: 7,
      postRemainingAmount: 2,
    });
    expect(second).toEqual({
      allocatedFeeDebtMilli: 3,
      remainingFeeDebtMilli: 4,
      postRemainingAmount: 1,
    });
    expect(final).toEqual({
      allocatedFeeDebtMilli: 4,
      remainingFeeDebtMilli: 0,
      postRemainingAmount: 0,
    });
    expect(
      first.allocatedFeeDebtMilli +
        second.allocatedFeeDebtMilli +
        final.allocatedFeeDebtMilli,
    ).toBe(10);
  });

  it("does not lose a one-milli remainder across repeated partial fills", () => {
    const first = allocateFeeDebtForFill({
      feeDebtMilli: 1,
      filledAmount: 1,
      preRemainingAmount: 3,
    });
    const second = allocateFeeDebtForFill({
      feeDebtMilli: first.remainingFeeDebtMilli,
      filledAmount: 1,
      preRemainingAmount: 2,
    });
    const final = allocateFeeDebtForFill({
      feeDebtMilli: second.remainingFeeDebtMilli,
      filledAmount: 1,
      preRemainingAmount: 1,
    });

    expect(first.allocatedFeeDebtMilli).toBe(0);
    expect(second.allocatedFeeDebtMilli).toBe(0);
    expect(final.allocatedFeeDebtMilli).toBe(1);
    expect(final.remainingFeeDebtMilli).toBe(0);
  });
});
