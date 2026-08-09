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

describe("order book depth and direct buy-order ranking", () => {

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

describe("post-action order price invariant", () => {

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
});
