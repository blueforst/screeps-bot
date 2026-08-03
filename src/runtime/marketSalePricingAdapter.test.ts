import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import {
  collectMarketSalePriceSnapshots,
  type MarketSalePricingDataStore,
  type MarketSalePricingReadMarket,
} from "@/runtime/marketSalePricingAdapter";

const UTC_NOW = new Date("2026-07-26T12:00:00.000Z");

function config(overrides: Record<string, unknown> = {}) {
  return resolveMarketSaleAutomationConfig({
    mode: "shadow",
    configRevision: "pricing-adapter-test-v1",
    sellResources: [RESOURCE_KEANIUM],
    hardFloor: { [RESOURCE_KEANIUM]: 1 },
    economicFloor: { [RESOURCE_KEANIUM]: 0.9 },
    forecastBuffer: {
      [RESOURCE_KEANIUM]: 20_000,
      [RESOURCE_UTRIUM]: 20_000,
    },
    creditReserve: 1_000_000,
    energyShadowPrice: 0.2,
    makerBatchAmount: 1_000,
    minHistoryDays: 5,
    minHistoryTransactions: 1,
    minHistoryVolume: 1,
    historyFloorRatio: 1,
    historyMaxAgeDays: 2,
    minReferenceOrderAmount: 1_000,
    minReferenceOrderCount: 3,
    referenceDepthMultiplier: 3,
    ...overrides,
  });
}

function history(
  resource: MarketResourceConstant,
  price: number,
  dates: string[] = [
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25",
  ],
  volume = 10_000,
): PriceHistory[] {
  return dates.map((date) => ({
    resourceType: resource,
    date,
    transactions: 10,
    volume,
    avgPrice: price,
    stddevPrice: 0.01,
  }));
}

function orders(
  resource: MarketResourceConstant,
  price = 1.2,
): Order[] {
  return ["W1N1", "W2N2", "W3N3"].map(
    (roomName, index) =>
      ({
        id: `${resource}-sell-${index}`,
        created: index + 1,
        type: ORDER_SELL,
        resourceType: resource,
        roomName,
        amount: 1_000,
        remainingAmount: 1_000,
        totalAmount: 1_000,
        price,
      }) as Order,
  );
}

function readMarket(input: {
  historyPrice?: number | ((resource: MarketResourceConstant) => number);
  historyDates?: string[];
  historyVolume?: number;
  orderPrice?: number;
} = {}): {
  market: MarketSalePricingReadMarket;
  getHistory: jest.Mock<PriceHistory[], [MarketResourceConstant?]>;
  getAllOrders: jest.Mock<Order[], [OrderFilter?]>;
} {
  const getHistory = jest.fn(
    (resource: MarketResourceConstant = RESOURCE_ENERGY) => {
      const price =
        typeof input.historyPrice === "function"
          ? input.historyPrice(resource)
          : (input.historyPrice ?? 0.8);
      return history(
        resource,
        price,
        input.historyDates,
        input.historyVolume,
      );
    },
  );
  const getAllOrders = jest.fn((filter: OrderFilter = {}) =>
    orders(
      (filter.resourceType ?? RESOURCE_KEANIUM) as MarketResourceConstant,
      input.orderPrice,
    ),
  );
  return {
    market: {
      getHistory,
      getAllOrders,
      orders: {},
    },
    getHistory,
    getAllOrders,
  };
}

describe("collectMarketSalePriceSnapshots", () => {
  it("Direct 的低显式 energy override 不能压低可信历史与 ratchet", () => {
    const cfg = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      shadowStrategy: "direct",
      configRevision: "direct-energy-v1",
      sellResources: [RESOURCE_CATALYST],
      hardFloor: { [RESOURCE_CATALYST]: 600 },
      economicFloor: { [RESOURCE_CATALYST]: 600 },
      forecastBuffer: { [RESOURCE_CATALYST]: 100_000 },
      creditReserve: 1_000_000,
      minDealAmount: 1_000,
      energyShadowPrice: 1,
      energyShadowHardFloor: 20,
      terminalEnergyReserve: 25_000,
      minHistoryDays: 5,
      minHistoryTransactions: 1,
      minHistoryVolume: 1,
      historyFloorRatio: 1,
      historyMaxAgeDays: 2,
      canary: { enabled: true, allowExpansion: false },
    });
    const api = readMarket({
      historyPrice: (resource) =>
        resource === RESOURCE_ENERGY ? 30 : 650,
      orderPrice: 700,
    });
    const dataStore: MarketSalePricingDataStore = {
      trustedFloors: {
        [RESOURCE_ENERGY]: {
          value: 40,
          marketDate: "2026-07-24",
          updatedAt: 100,
        },
      },
    };

    const result = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [RESOURCE_CATALYST],
      { market: api.market, gameTime: 200, utcNow: UTC_NOW },
    );

    expect(result.energyShadowPrice).toBe(38);
    expect(result.energyShadowEvidence).toEqual({
      trusted: true,
      observedAt: 200,
      hardFloor: 20,
      explicit: 1,
      historyFloor: 30,
      ratchetFloor: 38,
      effective: 38,
    });
    expect(dataStore.trustedFloors?.[RESOURCE_ENERGY]).toEqual({
      value: 38,
      marketDate: "2026-07-25",
      updatedAt: 200,
    });
  });

  it("每周期对每个 unique resource 的 history 和 order book 最多读取一次", () => {
    const cfg = config({
      sellResources: [RESOURCE_KEANIUM, RESOURCE_UTRIUM],
      hardFloor: {
        [RESOURCE_KEANIUM]: 1,
        [RESOURCE_UTRIUM]: 0.8,
      },
      economicFloor: {
        [RESOURCE_KEANIUM]: 0.9,
        [RESOURCE_UTRIUM]: 0.7,
      },
    });
    const api = readMarket({
      historyPrice: (resource) =>
        resource === RESOURCE_KEANIUM ? 0.8 : 0.8,
    });

    const result = collectMarketSalePriceSnapshots(
      cfg,
      {},
      [
        RESOURCE_KEANIUM,
        { resource: RESOURCE_KEANIUM },
        RESOURCE_UTRIUM,
        { resource: RESOURCE_UTRIUM },
      ],
      { market: api.market, gameTime: 123, utcNow: UTC_NOW },
    );

    expect(api.getHistory).toHaveBeenCalledTimes(2);
    expect(api.getAllOrders).toHaveBeenCalledTimes(2);
    expect(
      api.getHistory.mock.calls.map(([resource]) => resource).sort(),
    ).toEqual([RESOURCE_KEANIUM, RESOURCE_UTRIUM].sort());
    expect(
      api.getAllOrders.mock.calls
        .map(([filter]) => filter?.resourceType)
        .sort(),
    ).toEqual([RESOURCE_KEANIUM, RESOURCE_UTRIUM].sort());
    expect(result.snapshots[RESOURCE_KEANIUM]?.trusted).toBe(true);
    expect(result.snapshots[RESOURCE_UTRIUM]?.trusted).toBe(true);
  });

  it("只在新的完整 historyDate 上最多下调 5%，同日重复采样不递归下降", () => {
    const cfg = config({
      hardFloor: { [RESOURCE_KEANIUM]: 0.4 },
      economicFloor: { [RESOURCE_KEANIUM]: 0.3 },
    });
    const dataStore: MarketSalePricingDataStore = {
      trustedFloors: {
        [RESOURCE_KEANIUM]: {
          value: 1,
          marketDate: "2026-07-24",
          updatedAt: 100,
        },
      },
    };
    const firstApi = readMarket({ historyPrice: 0.5 });

    const first = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [RESOURCE_KEANIUM],
      { market: firstApi.market, gameTime: 200, utcNow: UTC_NOW },
    );

    expect(first.snapshots[RESOURCE_KEANIUM]).toMatchObject({
      historyDate: "2026-07-25",
      historyFloor: 0.5,
      ratchetFloor: 0.95,
      effectiveNetFloor: 0.95,
    });
    expect(dataStore.trustedFloors?.[RESOURCE_KEANIUM]).toEqual({
      value: 0.95,
      marketDate: "2026-07-25",
      updatedAt: 200,
    });

    const sameDayApi = readMarket({ historyPrice: 0.1 });
    const sameDay = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [RESOURCE_KEANIUM],
      { market: sameDayApi.market, gameTime: 201, utcNow: UTC_NOW },
    );

    expect(sameDay.snapshots[RESOURCE_KEANIUM]?.ratchetFloor).toBe(0.95);
    expect(dataStore.trustedFloors?.[RESOURCE_KEANIUM]).toEqual({
      value: 0.95,
      marketDate: "2026-07-25",
      updatedAt: 200,
    });
  });

  it("V3 跨日低历史价只推进日期，不回退基础资源或 Energy 高水位", () => {
    const cfg = config({
      hardFloor: { [RESOURCE_KEANIUM]: 0.4 },
      economicFloor: { [RESOURCE_KEANIUM]: 0.3 },
    });
    const dataStore: MarketSalePricingDataStore = {
      trustedFloors: {
        [RESOURCE_KEANIUM]: {
          value: 1,
          marketDate: "2026-07-24",
          updatedAt: 100,
        },
      },
    };
    const api = readMarket({ historyPrice: 0.5 });

    const result = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [RESOURCE_KEANIUM],
      {
        market: api.market,
        gameTime: 200,
        utcNow: UTC_NOW,
        nondecreasingTrustedFloors: true,
      },
    );

    expect(result.snapshots[RESOURCE_KEANIUM]).toMatchObject({
      historyDate: "2026-07-25",
      historyFloor: 0.5,
      ratchetFloor: 1,
      effectiveNetFloor: 1,
    });
    expect(dataStore.trustedFloors).toMatchObject({
      [RESOURCE_KEANIUM]: {
        value: 1,
        marketDate: "2026-07-25",
        updatedAt: 200,
      },
    });

    const directCfg = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      shadowStrategy: "direct",
      configRevision: "direct-energy-v3-high-water-test",
      sellResources: [RESOURCE_CATALYST],
      hardFloor: { [RESOURCE_CATALYST]: 600 },
      economicFloor: { [RESOURCE_CATALYST]: 600 },
      forecastBuffer: { [RESOURCE_CATALYST]: 100_000 },
      creditReserve: 1_000_000,
      minDealAmount: 1_000,
      energyShadowPrice: 1,
      energyShadowHardFloor: 20,
      terminalEnergyReserve: 25_000,
      minHistoryDays: 5,
      minHistoryTransactions: 1,
      minHistoryVolume: 1,
      historyFloorRatio: 1,
      historyMaxAgeDays: 2,
      canary: { enabled: true, allowExpansion: false },
    });
    const energyStore: MarketSalePricingDataStore = {
      trustedFloors: {
        [RESOURCE_ENERGY]: {
          value: 40,
          marketDate: "2026-07-24",
          updatedAt: 100,
        },
      },
    };
    const directApi = readMarket({
      historyPrice: (resource) =>
        resource === RESOURCE_ENERGY ? 30 : 650,
      orderPrice: 700,
    });
    const energyResult = collectMarketSalePriceSnapshots(
      directCfg,
      energyStore,
      [RESOURCE_CATALYST],
      {
        market: directApi.market,
        gameTime: 200,
        utcNow: UTC_NOW,
        nondecreasingTrustedFloors: true,
      },
    );

    expect(energyResult.energyShadowEvidence).toMatchObject({
      trusted: true,
      observedAt: 200,
      historyFloor: 30,
      ratchetFloor: 40,
      effective: 40,
    });
    expect(energyStore.trustedFloors).toMatchObject({
      [RESOURCE_ENERGY]: {
        value: 40,
        marketDate: "2026-07-25",
        updatedAt: 200,
      },
    });
  });

  it("历史超过 freshness 窗口时冻结已有缓存并 fail closed", () => {
    const cfg = config({ historyMaxAgeDays: 2 });
    const dataStore: MarketSalePricingDataStore = {
      trustedFloors: {
        [RESOURCE_KEANIUM]: {
          value: 1.1,
          marketDate: "2026-07-22",
          updatedAt: 50,
        },
      },
    };
    const api = readMarket({
      historyPrice: 0.8,
      historyDates: [
        "2026-07-17",
        "2026-07-18",
        "2026-07-19",
        "2026-07-20",
        "2026-07-21",
        "2026-07-22",
      ],
    });

    const result = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [RESOURCE_KEANIUM],
      { market: api.market, gameTime: 60, utcNow: UTC_NOW },
    );
    const snapshot = result.snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.trusted).toBe(false);
    expect(snapshot?.rejectedReason).toBe("history_stale");
    expect(snapshot?.makerPrice).toBeUndefined();
    expect(dataStore.trustedFloors?.[RESOURCE_KEANIUM]).toEqual({
      value: 1.1,
      marketDate: "2026-07-22",
      updatedAt: 50,
    });
  });

  it("maker 最低安全价覆盖 hard/economic/history/ratchet 与向上取整后的 5% create fee", () => {
    const cfg = config();
    const api = readMarket({ historyPrice: 0.8 });
    api.getHistory.mockImplementation(
      (resource: MarketResourceConstant = RESOURCE_ENERGY) => [
        ...history(resource, 0.8),
        {
          resourceType: resource,
          date: "2026-07-26",
          transactions: 1_000,
          volume: 1_000_000,
          avgPrice: 0.001,
          stddevPrice: 0,
        },
      ],
    );
    const dataStore: MarketSalePricingDataStore = {};

    const result = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [{ resource: RESOURCE_KEANIUM, makerAmount: 1_000, feeDebtMilli: 0 }],
      { market: api.market, gameTime: 300, utcNow: UTC_NOW },
    );
    const snapshot = result.snapshots[RESOURCE_KEANIUM];

    expect(snapshot).toMatchObject({
      trusted: true,
      historyDate: "2026-07-25",
      historyFloor: 0.8,
      ratchetFloor: 0.8,
      effectiveNetFloor: 1,
      energyShadowPrice: 0.2,
      makerAmount: 1_000,
      trustedDailyVolume: 10_000,
      makerVolumeCap: 1_000,
      feeDebtMilli: 0,
      referenceSellAsk: 1.2,
      makerAskFloor: 1.176,
      makerPrice: 1.176,
      makerPriceResult: {
        safe: true,
        recommendedPrice: 1.176,
        evaluation: {
          prospectiveFeeMilli: 58_800,
          satisfiesInvariant: true,
        },
      },
    });
    expect(snapshot?.referenceSellBook?.trusted).toBe(true);
  });

  it("历史与可信 ask 显著偏离时 fail closed，不以历史低价挂入高价盘口", () => {
    const cfg = config();
    const api = readMarket({ historyPrice: 0.8, orderPrice: 10 });

    const result = collectMarketSalePriceSnapshots(
      cfg,
      {},
      [RESOURCE_KEANIUM],
      { market: api.market, gameTime: 350, utcNow: UTC_NOW },
    );
    const snapshot = result.snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.referenceSellBook?.trusted).toBe(true);
    expect(snapshot?.referenceSellAsk).toBe(10);
    expect(snapshot?.historyAskDeviationRatio).toBeGreaterThan(
      cfg.maxHistoryAskDeviationRatio!,
    );
    expect(snapshot?.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "history_ask_divergence" }),
      ]),
    );
    expect(snapshot?.makerAskFloor).toBeUndefined();
    expect(snapshot?.makerPrice).toBeUndefined();
    expect(snapshot?.trusted).toBe(false);
  });

  it("同一房间拆成多个订单仍不能构成可信 ask 锚", () => {
    const api = readMarket({ historyPrice: 0.8, orderPrice: 1.2 });
    api.getAllOrders.mockImplementation(
      (filter: OrderFilter = {}) =>
        [0, 1, 2].map(
          (index) =>
            ({
              id: `single-room-${index}`,
              created: index + 1,
              type: ORDER_SELL,
              resourceType:
                filter.resourceType ?? RESOURCE_KEANIUM,
              roomName: "W9N9",
              amount: 1_000,
              remainingAmount: 1_000,
              totalAmount: 1_000,
              price: 1.2,
            }) as Order,
        ),
    );

    const snapshot = collectMarketSalePriceSnapshots(
      config(),
      {},
      [RESOURCE_KEANIUM],
      { market: api.market, gameTime: 355, utcNow: UTC_NOW },
    ).snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.referenceSellBook).toMatchObject({
      trusted: false,
      distinctOrderCount: 3,
      distinctRoomCount: 1,
    });
    expect(snapshot?.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "reference_order_book_untrusted",
        }),
      ]),
    );
    expect(snapshot?.makerPrice).toBeUndefined();
    expect(snapshot?.trusted).toBe(false);
  });

  it("单房间三笔低价单加两个高价房间时按房间等权锚定高价多数", () => {
    const api = readMarket({ historyPrice: 1.2 });
    api.getAllOrders.mockImplementation(
      (filter: OrderFilter = {}) =>
        [
          ["low-1", "W1N1", 0.8],
          ["low-2", "W1N1", 0.8],
          ["low-3", "W1N1", 0.8],
          ["high-1", "W2N2", 1.2],
          ["high-2", "W3N3", 1.2],
        ].map(
          ([id, roomName, price], index) =>
            ({
              id,
              created: index + 1,
              type: ORDER_SELL,
              resourceType:
                filter.resourceType ?? RESOURCE_KEANIUM,
              roomName,
              amount: 1_000,
              remainingAmount: 1_000,
              totalAmount: 1_000,
              price,
            }) as Order,
        ),
    );

    const snapshot = collectMarketSalePriceSnapshots(
      config({
        hardFloor: { [RESOURCE_KEANIUM]: 0.4 },
        economicFloor: { [RESOURCE_KEANIUM]: 0.4 },
        historyFloorRatio: 0.5,
      }),
      {},
      [RESOURCE_KEANIUM],
      { market: api.market, gameTime: 355, utcNow: UTC_NOW },
    ).snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.referenceSellBook).toMatchObject({
      trusted: true,
      eligibleAmount: 5_000,
      trustedDepth: 3_000,
      distinctOrderCount: 5,
      distinctRoomCount: 3,
    });
    expect(snapshot).toMatchObject({
      trusted: true,
      referenceSellAsk: 1.2,
      historyAskDeviationRatio: 0,
      makerAskFloor: 1.176,
      makerPrice: 1.176,
    });
  });

  it("两个可信房间的偶数边界采用偏高侧代表价", () => {
    const api = readMarket({ historyPrice: 1.2 });
    api.getAllOrders.mockImplementation(
      (filter: OrderFilter = {}) =>
        [
          ["low-1", "W1N1", 0.8],
          ["low-2", "W1N1", 0.8],
          ["low-3", "W1N1", 0.8],
          ["high-1", "W2N2", 1.2],
        ].map(
          ([id, roomName, price], index) =>
            ({
              id,
              created: index + 1,
              type: ORDER_SELL,
              resourceType:
                filter.resourceType ?? RESOURCE_KEANIUM,
              roomName,
              amount: 1_000,
              remainingAmount: 1_000,
              totalAmount: 1_000,
              price,
            }) as Order,
        ),
    );

    const snapshot = collectMarketSalePriceSnapshots(
      config({
        hardFloor: { [RESOURCE_KEANIUM]: 0.4 },
        economicFloor: { [RESOURCE_KEANIUM]: 0.4 },
        historyFloorRatio: 0.5,
        minReferenceOrderCount: 2,
        minReferenceDistinctRooms: 2,
        referenceDepthMultiplier: 2,
      }),
      {},
      [RESOURCE_KEANIUM],
      { market: api.market, gameTime: 356, utcNow: UTC_NOW },
    ).snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.referenceSellBook).toMatchObject({
      trusted: true,
      eligibleAmount: 4_000,
      trustedDepth: 2_000,
      distinctOrderCount: 4,
      distinctRoomCount: 2,
    });
    expect(snapshot?.referenceSellAsk).toBe(1.2);
    expect(snapshot?.makerPrice).toBe(1.176);
    expect(snapshot?.trusted).toBe(true);
  });

  it("数量达标但名义金额过小的多房间订单仍按尘埃拒绝", () => {
    const api = readMarket({ historyPrice: 0.05, orderPrice: 0.05 });
    const snapshot = collectMarketSalePriceSnapshots(
      config({
        hardFloor: { [RESOURCE_KEANIUM]: 0.01 },
        economicFloor: { [RESOURCE_KEANIUM]: 0.01 },
        minReferenceOrderNotional: 100,
      }),
      {},
      [RESOURCE_KEANIUM],
      { market: api.market, gameTime: 356, utcNow: UTC_NOW },
    ).snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.referenceSellBook).toMatchObject({
      trusted: false,
      distinctOrderCount: 0,
      distinctRoomCount: 0,
    });
    expect(snapshot?.referenceSellBook?.rejectedOrders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "dust_notional" }),
      ]),
    );
    expect(snapshot?.makerPrice).toBeUndefined();
    expect(snapshot?.trusted).toBe(false);
  });

  it("maker 批次超过可信完整日成交量比例时拒绝，边界批次的数量与报价保持一致", () => {
    const api = readMarket({ historyPrice: 0.8, historyVolume: 10_000 });
    const rejected = collectMarketSalePriceSnapshots(
      config(),
      {},
      [{ resource: RESOURCE_KEANIUM, makerAmount: 2_000 }],
      { market: api.market, gameTime: 360, utcNow: UTC_NOW },
    ).snapshots[RESOURCE_KEANIUM];

    expect(rejected).toMatchObject({
      makerAmount: 2_000,
      trustedDailyVolume: 10_000,
      makerVolumeCap: 1_000,
      trusted: false,
    });
    expect(rejected?.rejections).toContainEqual({
      reason: "maker_amount_exceeds_history_volume_cap",
      detail: "amount=2000,cap=1000",
    });
    expect(rejected?.makerPrice).toBeUndefined();

    const accepted = collectMarketSalePriceSnapshots(
      config({ makerHistoryVolumeRatio: 0.2 }),
      {},
      [{ resource: RESOURCE_KEANIUM, makerAmount: 2_000 }],
      { market: api.market, gameTime: 361, utcNow: UTC_NOW },
    ).snapshots[RESOURCE_KEANIUM];
    expect(accepted).toMatchObject({
      makerAmount: 2_000,
      makerVolumeCap: 2_000,
      makerPrice: 1.176,
      trusted: true,
      makerPriceResult: {
        recommendedPrice: 1.176,
        evaluation: {
          postRemainingAmount: 2_000,
          satisfiesInvariant: true,
        },
      },
    });
  });

  it("history API 异常时给出明确拒绝且不产生可执行 maker 价格", () => {
    const cfg = config();
    const getHistory = jest.fn(() => {
      throw new Error("market history unavailable");
    });
    const getAllOrders = jest.fn(() => orders(RESOURCE_KEANIUM));

    const result = collectMarketSalePriceSnapshots(
      cfg,
      {},
      [RESOURCE_KEANIUM],
      {
        market: { getHistory, getAllOrders, orders: {} },
        gameTime: 400,
        utcNow: UTC_NOW,
      },
    );
    const snapshot = result.snapshots[RESOURCE_KEANIUM];

    expect(snapshot?.trusted).toBe(false);
    expect(snapshot?.rejectedReason).toBe("history_fetch_failed");
    expect(snapshot?.makerPrice).toBeUndefined();
    expect(snapshot?.rejections).toContainEqual({
      reason: "history_fetch_failed",
      detail: "market history unavailable",
    });
  });
});
