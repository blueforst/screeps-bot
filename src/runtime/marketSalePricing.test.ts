import {
  buildTrustedHistoryFloor,
  rankDirectBuyOrders,
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
