import {
  clearMarketSaleRuntimeCachesForTest,
  composeMarketSalePlanCandidates,
  runLiveMarketSaleAutomation,
  type MarketSaleRuntimeCompositionContext,
} from "@/runtime/marketSaleRuntime";
import { collectMarketSaleDomainActivity } from "@/runtime/marketSaleAutomation";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import type {
  MarketProtectionContribution,
  MarketProtectionEntry,
  MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import type { MarketSalePriceSnapshotCollection } from "@/runtime/marketSalePricingAdapter";

function config(): MarketSaleAutomationConfig {
  return {
    mode: "shadow",
    configRevision: "rev-1",
    sellResources: [RESOURCE_KEANIUM],
    hardFloor: { [RESOURCE_KEANIUM]: 65 },
    economicFloor: {},
    forecastBuffer: { [RESOURCE_KEANIUM]: 5_000 },
    minDealAmount: 500,
    maxDealAmount: 5_000,
    makerBatchAmount: 1_000,
    maxManagedOrders: 1,
    minFreeOrderSlots: 5,
    creditReserve: 100_000,
    rollingFeeBudget: 1_000,
    feeWindowTicks: 20_000,
    terminalEnergyReserve: 25_000,
    directDiscountRatio: 0.95,
    minHistoryDays: 5,
    minHistoryTransactions: 3,
    minHistoryVolume: 1_000,
    historyFloorRatio: 0.9,
    historyMaxAgeDays: 2,
    minReferenceOrderAmount: 1_000,
    minReferenceOrderNotional: 100,
    minReferenceOrderCount: 3,
    minReferenceDistinctRooms: 3,
    referenceDepthMultiplier: 3,
    orderPolicyTtl: 20_000,
    mutationBackoffTicks: 1_000,
    canaryEnabled: true,
    canaryAllowExpansion: false,
    validForPlanning: true,
    invalidReasons: [],
  };
}

function entry(): MarketProtectionEntry {
  return {
    roomName: "W1N1",
    resource: RESOURCE_KEANIUM,
    revision: 100,
    observedAt: 100,
    expiresAt: 100,
    totalStock: 80_000,
    terminalStock: 20_000,
    hardReserve: 5_000,
    productionDemand: 10_000,
    forecastBuffer: 5_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 15_000,
    grossSurplus: 65_000,
    managedExposure: 0,
    newExposureCapacity: 65_000,
    sellableAmount: 20_000,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
  };
}

function protection(): MarketSaleProtectionLedger {
  return {
    currentTick: 100,
    revision: 100,
    observedAt: 100,
    expiresAt: 100,
    fresh: true,
    blockedEntryCount: 0,
    entries: { "W1N1:K": entry() },
  };
}

function pricing(): MarketSalePriceSnapshotCollection {
  return {
    observedAt: 100,
    asOfDate: "2026-07-25",
    snapshots: {
      [RESOURCE_KEANIUM]: {
        resource: RESOURCE_KEANIUM,
        observedAt: 100,
        asOfDate: "2026-07-25",
        trusted: true,
        rejections: [],
        historyFloor: 68,
        ratchetFloor: 69,
        historyResult: {
          trusted: true,
          latestHistoryDate: "2026-07-24",
          referencePrice: 72,
          trustedFloor: 68,
          medianLogPrice: Math.log(72),
          madLogPrice: 0.01,
          completeDayCount: 7,
          acceptedDayCount: 6,
          acceptedDates: [
            "2026-07-18",
            "2026-07-19",
            "2026-07-20",
            "2026-07-21",
            "2026-07-22",
            "2026-07-24",
          ],
          rejectedDays: [],
        },
        effectiveNetFloor: 70,
        makerPrice: 74,
        makerPriceResult: {
          safe: true,
          minimumSafePrice: 74,
          minimumSafePriceMilli: 74_000,
          recommendedPrice: 74,
          evaluation: {
            action: "create",
            candidatePrice: 74,
            candidatePriceMilli: 74_000,
            postRemainingAmount: 1_000,
            prospectiveFeeMilli: 3_700_000,
            postActionFeeDebtMilli: 3_700_000,
            grossRemainingValueMilli: 74_000_000,
            netRemainingValueMilli: 70_300_000,
            requiredNetValueMilli: 70_000_000,
            satisfiesInvariant: true,
          },
        },
        referenceSellBook: {
          trusted: true,
          eligibleOrders: [],
          rejectedOrders: [],
          eligibleAmount: 5_000,
          trustedDepth: 5_000,
          distinctOrderCount: 3,
          distinctRoomCount: 3,
        },
      },
    },
  };
}

function protectionAt(tick: number): MarketSaleProtectionLedger {
  const value = protection();
  const protectedEntry = {
    ...value.entries["W1N1:K"],
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
  };
  return {
    ...value,
    currentTick: tick,
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    entries: { "W1N1:K": protectedEntry },
  };
}

function pricingAt(tick: number): MarketSalePriceSnapshotCollection {
  const value = pricing();
  return {
    ...value,
    observedAt: tick,
    snapshots: {
      [RESOURCE_KEANIUM]: {
        ...value.snapshots[RESOURCE_KEANIUM]!,
        observedAt: tick,
      },
    },
  };
}

function managedProtectionAt(
  tick: number,
  overrides: Partial<MarketProtectionEntry> = {},
): MarketSaleProtectionLedger {
  const contribution: MarketProtectionContribution = {
    dedupeKey: "managed-order:managed",
    stableKey: "managed-order:managed",
    anonymous: false,
    bucket: "managedExposure",
    amount: 1_000,
    sourceKinds: ["managedExposure"],
    managedOrderId: "managed",
    observedAt: tick,
    expiresAt: tick,
  };
  const protectedEntry: MarketProtectionEntry = {
    ...entry(),
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    totalStock: 7_000,
    terminalStock: 1_000,
    hardReserve: 5_000,
    productionDemand: 0,
    forecastBuffer: 1_000,
    protectedAmount: 6_000,
    grossSurplus: 1_000,
    managedExposure: 1_000,
    newExposureCapacity: 0,
    sellableAmount: 0,
    sourceContributions: [contribution],
    ...overrides,
  };
  return {
    currentTick: tick,
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    fresh: !protectedEntry.blocked,
    blockedEntryCount: protectedEntry.blocked ? 1 : 0,
    entries: { "W1N1:K": protectedEntry },
  };
}

function installLiveRuntimeFixture(tick: number, bucket = 9_000): void {
  Game.time = tick;
  (Game as unknown as { cpu: { bucket: number } }).cpu = { bucket };
  (Game as unknown as { market: Partial<Market> }).market = {
    orders: {},
    getHistory: jest.fn(() => []),
    getAllOrders: jest.fn(() => []),
  };
  Memory.cfg = {
    marketSaleAutomation: {
      mode: "shadow",
      configRevision: "rev-1",
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 65 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 5_000 },
      creditReserve: 100_000,
      makerBatchAmount: 1_000,
    },
  };
  Memory.data = {
    marketSaleAutomation: {
      managedOrders: {},
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
    },
  };
  Memory.runtime = {
    resourceControl: {
      updatedAt: tick,
      rooms: {
        W1N1: {
          capacityState: "normal",
        },
      },
      capacityPolicy: {
        receiverTerminalMinFreeCapacity: 50_000,
      },
      lastActions: [],
      lastMarketActions: [],
    },
    marketSaleAutomation: {
      updatedAt: tick,
      requestedMode: "shadow",
      phase: "shadow",
      configRevision: "rev-1",
      shadowConfigRevision: "rev-1",
      shadowConfigSignature: "qualified",
      shadowConsecutiveCycles: 50,
      zeroConfirmations: 0,
      managedOrderCount: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      exposureAmount: 0,
      rollingFeeMilli: 0,
      terminalClaims: [],
      rejectedByReason: {},
      candidates: {},
      recentActions: [],
      safetyViolationCount: 0,
    },
  } as unknown as Memory["runtime"];
}

function installContinuousPricingCacheFixture(tick: number): void {
  installLiveRuntimeFixture(tick);
  Memory.cfg!.marketSaleAutomation = {
    mode: "direct",
    directCapability: "continuous-v2",
    configRevision: "market-direct-continuous-v2-r1",
    sellResources: [
      RESOURCE_CATALYST,
      RESOURCE_HYDROGEN,
      RESOURCE_ZYNTHIUM,
    ],
    hardFloor: {
      [RESOURCE_CATALYST]: 600,
      [RESOURCE_HYDROGEN]: 428,
      [RESOURCE_ZYNTHIUM]: 43,
    },
    economicFloor: {
      [RESOURCE_CATALYST]: 600,
      [RESOURCE_HYDROGEN]: 451,
      [RESOURCE_ZYNTHIUM]: 45,
    },
    forecastBuffer: {
      [RESOURCE_CATALYST]: 100_000,
      [RESOURCE_HYDROGEN]: 100_000,
      [RESOURCE_ZYNTHIUM]: 100_000,
    },
    minDealAmount: 1_000,
    makerBatchAmount: 5_000,
    creditReserve: 0,
    terminalEnergyReserve: 25_000,
    maxDirectDealAmount: 1_000,
    maxDirectDealsPerCycle: 1,
    minDirectOrderAmount: 1_000,
    minDirectOrderNotional: 600_000,
    maxDirectRawOrdersScannedPerCycle: 1_000,
    maxDirectEligibleOrdersPricedPerCycle: 200,
    maxDirectTransactionEnergy: 1_000,
    directCanaryMaxConfirmedDeals: 1,
    energyShadowHardFloor: 20,
    planningSnapshotMaxAgeTicks: 10,
    minHistoryDays: 7,
    minHistoryTransactions: 100,
    minHistoryVolume: 100_000,
    historyFloorRatio: 0.95,
    historyMaxAgeDays: 2,
    canary: {
      enabled: true,
      allowExpansion: false,
    },
  };
  Memory.runtime!.marketSaleAutomation!.phase = "direct";
}

function installNonResourceControlManagedFixture(tick: number): {
  market: Partial<Market> & { orders: Record<string, Order> };
} {
  installLiveRuntimeFixture(tick);
  Memory.cfg!.marketSaleAutomation!.mode = "maker";
  Memory.runtime!.resourceControl!.updatedAt = tick - 1;
  Memory.runtime!.marketSaleAutomation!.phase = "maker";
  Memory.data!.marketSaleAutomation!.managedOrders = {
    managed: {
      orderId: "managed",
      roomName: "W1N1",
      resourceType: RESOURCE_KEANIUM,
      price: 74,
      originalAmount: 1_000,
      lastRemainingAmount: 1_000,
      remainingExposure: 1_000,
      feeDebtMilli: 3_700_000,
      createdAt: tick - 10,
      lastSeenAt: tick - 1,
      policyCancelAtTick: tick + 10_000,
      serverCreatedTick: tick - 10,
    },
  };
  Memory.data!.marketSaleAutomation!.drain = {
    phase: "maker",
    zeroConfirmations: 0,
  };
  const amounts: Partial<Record<ResourceConstant, number>> = {
    [RESOURCE_ENERGY]: 100_000,
    [RESOURCE_KEANIUM]: 1_000,
  };
  Game.rooms = {
    W1N1: {
      name: "W1N1",
      controller: { my: true },
      terminal: {
        cooldown: 0,
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource ? amounts[resource] || 0 : 101_000,
          getFreeCapacity: () => 199_000,
        },
      },
    } as unknown as Room,
  };
  const market = {
    orders: {
      managed: {
        id: "managed",
        created: tick - 10,
        type: ORDER_SELL,
        resourceType: RESOURCE_KEANIUM,
        roomName: "W1N1",
        price: 74,
        totalAmount: 1_000,
        remainingAmount: 1_000,
        amount: 1_000,
        active: true,
      } as Order,
    },
    credits: 1_000_000,
    outgoingTransactions: [],
    incomingTransactions: [],
    createOrder: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    getHistory: jest.fn(() => []),
    getAllOrders: jest.fn(() => []),
  };
  (Game as unknown as { market: typeof market }).market = market;
  return { market };
}

function automationResult() {
  return {
    requestedMode: "shadow" as const,
    effectiveMode: "shadow" as const,
    phase: "shadow" as const,
    writes: 0,
    actions: [],
    rejectedByReason: {},
  };
}

function primeMakerPricingCache(tick: number): void {
  installLiveRuntimeFixture(tick);
  Memory.cfg!.marketSaleAutomation!.mode = "maker";
  Memory.runtime!.marketSaleAutomation!.phase = "maker";
  runLiveMarketSaleAutomation({
    collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
    collectPricing: jest.fn(() => pricingAt(Game.time)) as never,
    runAutomation: jest.fn(() => automationResult()) as never,
  });
}

function context(
  overrides: Partial<MarketSaleRuntimeCompositionContext> = {},
): MarketSaleRuntimeCompositionContext {
  return {
    currentTick: 100,
    resourceControlUpdatedAt: 100,
    capacityStateByRoom: { W1N1: "normal" },
    hubEnabled: true,
    hubRoomName: "W9N9",
    minimumTerminalFreeCapacity: 50_000,
    ...overrides,
  };
}

describe("market sale live composition", () => {
  beforeEach(() => {
    clearMarketSaleRuntimeCachesForTest();
    clearMarketActionArbiterForTest();
  });

  it("joins a fresh non-Hub protection entry with trusted pricing", () => {
    const [candidate] = composeMarketSalePlanCandidates(
      config(),
      protection(),
      pricing(),
      context(),
    );

    expect(candidate).toMatchObject({
      roomName: "W1N1",
      resourceType: RESOURCE_KEANIUM,
      effectiveNetFloor: 70,
      historyTrusted: true,
      historyCompleteDayCount: 7,
      historyAcceptedDayCount: 6,
      historyFloor: 68,
      ratchetFloor: 69,
      makerPrice: 74,
      makerNetPrice: 70.3,
      trustedPrice: true,
      trustedDepth: true,
      capacityState: "normal",
      isHubRoom: false,
      hasCriticalConflict: false,
    });
    expect(candidate.additionalRejectionReasons).toEqual([]);
  });

  it("Direct 结构证据忽略 Maker SELL 深度，但保留历史与能源门禁", () => {
    const makerBlocked = pricing();
    makerBlocked.energyShadowPrice = 30;
    makerBlocked.energyShadowEvidence = {
      trusted: true,
      observedAt: 100,
      hardFloor: 20,
      explicit: 1,
      historyFloor: 30,
      ratchetFloor: 30,
      effective: 30,
    };
    makerBlocked.snapshots[RESOURCE_KEANIUM] = {
      ...makerBlocked.snapshots[RESOURCE_KEANIUM]!,
      trusted: false,
      makerPrice: undefined,
      rejections: [
        { reason: "reference_order_book_untrusted" },
        { reason: "maker_price_unavailable" },
      ],
      referenceSellBook: {
        trusted: false,
        eligibleOrders: [],
        rejectedOrders: [],
        eligibleAmount: 2_000,
        trustedDepth: 2_000,
        distinctOrderCount: 2,
        distinctRoomCount: 2,
      },
    };
    const [candidate] = composeMarketSalePlanCandidates(
      { ...config(), shadowStrategy: "direct" },
      protection(),
      makerBlocked,
      context(),
    );

    expect(candidate.trustedPrice).toBe(false);
    expect(candidate.trustedDepth).toBe(false);
    expect(candidate.directHistoryTrusted).toBe(true);
    expect(candidate.effectiveEnergyShadowPrice).toBe(30);
    expect(candidate.directAdditionalRejectionReasons).toEqual([]);
  });

  it("keeps stale ResourceControl and missing price evidence fail-closed", () => {
    const missingPricing: MarketSalePriceSnapshotCollection = {
      observedAt: 100,
      asOfDate: "2026-07-25",
      snapshots: {},
    };
    const [candidate] = composeMarketSalePlanCandidates(
      config(),
      protection(),
      missingPricing,
      context({ resourceControlUpdatedAt: 99 }),
    );

    expect(candidate.capacityState).toBeUndefined();
    expect(candidate.trustedPrice).toBe(false);
    expect(candidate.trustedDepth).toBe(false);
    expect(candidate.additionalRejectionReasons).toEqual(
      expect.arrayContaining([
        "pricing:snapshot_missing",
        "resource_control_cycle_stale",
      ]),
    );
  });

  it("reuses bounded pricing results, refreshes the order book less often, and history less often still", () => {
    installLiveRuntimeFixture(100);
    const collectPricing = jest.fn(
      (
        _config: unknown,
        _store: unknown,
        _candidates: unknown,
        options: {
          market?: {
            getHistory?: (resource: MarketResourceConstant) => PriceHistory[];
            getAllOrders?: (filter: OrderFilter) => Order[];
          };
        },
      ) => {
        options.market!.getHistory!(RESOURCE_KEANIUM);
        options.market!.getAllOrders!({
          resourceType: RESOURCE_KEANIUM,
        });
        return pricingAt(Game.time);
      },
    );
    const runAutomation = jest.fn(() => automationResult());
    const collectProtection = jest.fn(() => protectionAt(Game.time));
    const dependencies = {
      collectPricing: collectPricing as never,
      collectProtection: collectProtection as never,
      runAutomation: runAutomation as never,
    };

    runLiveMarketSaleAutomation(dependencies);
    Game.time = 150;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(1);
    expect(Game.market.getAllOrders).toHaveBeenCalledTimes(1);
    expect(Game.market.getHistory).toHaveBeenCalledTimes(1);

    Game.time = 200;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(2);
    expect(Game.market.getAllOrders).toHaveBeenCalledTimes(2);
    expect(Game.market.getHistory).toHaveBeenCalledTimes(1);

    Game.time = 5_100;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(3);
    expect(Game.market.getAllOrders).toHaveBeenCalledTimes(3);
    expect(Game.market.getHistory).toHaveBeenCalledTimes(2);
  });

  it("Continuous pricing result never outlives the 10-tick execution evidence window", () => {
    installContinuousPricingCacheFixture(100);
    const collectPricing = jest.fn(() => pricingAt(Game.time));
    const dependencies = {
      collectPricing: collectPricing as never,
      collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
      runAutomation: jest.fn(() => automationResult()) as never,
    };

    runLiveMarketSaleAutomation(dependencies);
    Game.time = 110;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);
    Game.time = 111;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);
    Game.time = 121;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);
    Game.time = 122;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(3);
    expect(collectPricing.mock.results.map((result) => result.value.observedAt))
      .toEqual([100, 111, 122]);
  });

  it("Maker keeps its 100-tick pricing cache even when an inactive Continuous capability remains configured", () => {
    installContinuousPricingCacheFixture(100);
    Memory.cfg!.marketSaleAutomation!.mode = "maker";
    Memory.runtime!.marketSaleAutomation!.phase = "maker";
    const collectPricing = jest.fn(() => pricingAt(Game.time));
    const dependencies = {
      collectPricing: collectPricing as never,
      collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
      runAutomation: jest.fn(() => automationResult()) as never,
    };

    runLiveMarketSaleAutomation(dependencies);
    Game.time = 199;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);
    Game.time = 200;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(2);
    expect(collectPricing.mock.results.map((result) => result.value.observedAt))
      .toEqual([100, 200]);
  });

  it("invalidates pricing and raw caches on revision, signature, and resource-set changes", () => {
    installLiveRuntimeFixture(100);
    const collectPricing = jest.fn(
      (
        _config: unknown,
        _store: unknown,
        _candidates: unknown,
        options: {
          market?: {
            getHistory?: (resource: MarketResourceConstant) => PriceHistory[];
            getAllOrders?: (filter: OrderFilter) => Order[];
          };
        },
      ) => {
        options.market!.getHistory!(RESOURCE_KEANIUM);
        options.market!.getAllOrders!({
          resourceType: RESOURCE_KEANIUM,
        });
        return pricingAt(Game.time);
      },
    );
    const dependencies = {
      collectPricing: collectPricing as never,
      collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
      runAutomation: jest.fn(() => automationResult()) as never,
    };

    runLiveMarketSaleAutomation(dependencies);
    Game.time = 110;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    Memory.cfg!.marketSaleAutomation!.configRevision = "rev-2";
    runLiveMarketSaleAutomation(dependencies);

    Game.time = 120;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    Memory.cfg!.marketSaleAutomation!.hardFloor![RESOURCE_KEANIUM] = 66;
    runLiveMarketSaleAutomation(dependencies);

    Game.time = 125;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    Memory.cfg!.marketSaleAutomation!.minReferenceOrderNotional = 125;
    runLiveMarketSaleAutomation(dependencies);

    Game.time = 127;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    Memory.cfg!.marketSaleAutomation!.minReferenceDistinctRooms = 2;
    runLiveMarketSaleAutomation(dependencies);

    Game.time = 129;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    Memory.cfg!.marketSaleAutomation!.makerAskFloorRatio = 0.97;
    runLiveMarketSaleAutomation(dependencies);

    Game.time = 130;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    Memory.cfg!.marketSaleAutomation!.sellResources = [
      RESOURCE_KEANIUM,
      RESOURCE_OXYGEN,
    ];
    Memory.cfg!.marketSaleAutomation!.hardFloor![RESOURCE_OXYGEN] = 20;
    Memory.cfg!.marketSaleAutomation!.forecastBuffer![RESOURCE_OXYGEN] = 1_000;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(7);
    expect(Game.market.getAllOrders).toHaveBeenCalledTimes(7);
    expect(Game.market.getHistory).toHaveBeenCalledTimes(7);
  });

  it("fails closed under a low CPU bucket without pricing reads or Shadow qualification", () => {
    installLiveRuntimeFixture(100, 4_999);
    const collectPricing = jest.fn(() => pricingAt(Game.time));
    const runAutomation = jest.fn(() => automationResult());

    const result = runLiveMarketSaleAutomation({
      collectPricing: collectPricing as never,
      collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
      runAutomation: runAutomation as never,
    });

    expect(collectPricing).not.toHaveBeenCalled();
    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
    expect(Game.market.getHistory).not.toHaveBeenCalled();
    expect(runAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            trustedPrice: false,
            trustedDepth: false,
            additionalRejectionReasons: expect.arrayContaining([
              "cpu_bucket_low",
            ]),
          }),
        ],
      }),
    );
    expect(
      Memory.runtime!.marketSaleAutomation!.shadowConsecutiveCycles,
    ).toBe(0);
    expect(
      Memory.runtime!.marketSaleAutomation!.shadowConfigRevision,
    ).toBeUndefined();
    expect(result.rejectedByReason.cpu_bucket_low).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["below safe batch", 999],
  ] as const)(
    "does not enter live planning when the configured forecast buffer is %s",
    (_label, forecastBuffer) => {
      installLiveRuntimeFixture(100);
      if (forecastBuffer === undefined) {
        delete Memory.cfg!.marketSaleAutomation!.forecastBuffer;
      } else {
        Memory.cfg!.marketSaleAutomation!.forecastBuffer = {
          [RESOURCE_KEANIUM]: forecastBuffer,
        };
      }
      Memory.cfg!.marketSaleAutomation!.minDealAmount = 500;
      Memory.cfg!.marketSaleAutomation!.makerBatchAmount = 1_000;
      const collectProtection = jest.fn(() => protectionAt(Game.time));
      const collectPricing = jest.fn(() => pricingAt(Game.time));
      const runAutomation = jest.fn(() => automationResult());

      const result = runLiveMarketSaleAutomation({
        collectProtection: collectProtection as never,
        collectPricing: collectPricing as never,
        runAutomation: runAutomation as never,
      });

      expect(collectProtection).not.toHaveBeenCalled();
      expect(collectPricing).not.toHaveBeenCalled();
      expect(Game.market.getAllOrders).not.toHaveBeenCalled();
      expect(Game.market.getHistory).not.toHaveBeenCalled();
      expect(runAutomation).toHaveBeenCalledTimes(1);
      expect(runAutomation).toHaveBeenCalledWith({
        stagingAmount: 0,
        reservationAmount: 0,
      });
      expect(result).toEqual(automationResult());
    },
  );

  it("从 canonical domain stores 实时采集 staging/reservation，异常结构阻断归零证明", () => {
    expect(
      collectMarketSaleDomainActivity({
        marketStaging: {
          "stage:x": { amount: 321 },
        },
        marketReservations: {
          "reservation:x": { amount: 45 },
        },
      }),
    ).toEqual({
      stagingAmount: 321,
      reservationAmount: 45,
      valid: true,
    });
    expect(
      collectMarketSaleDomainActivity({
        marketStaging: [],
        marketReservations: {},
      }),
    ).toEqual({
      stagingAmount: 1,
      reservationAmount: 0,
      valid: false,
    });
    expect(
      collectMarketSaleDomainActivity({
        marketStaging: {
          ghost: { amount: 0 },
        },
        marketReservations: {},
      }),
    ).toEqual({
      stagingAmount: 1,
      reservationAmount: 0,
      valid: false,
    });

    installLiveRuntimeFixture(100);
    Memory.cfg!.marketSaleAutomation!.mode = "off";
    Memory.data!.marketSaleAutomation!.marketStaging = {
      "stage:x": { amount: 321 },
    };
    Memory.data!.marketSaleAutomation!.marketReservations = {
      "reservation:x": { amount: 45 },
    };
    const runAutomation = jest.fn(() => automationResult());
    runLiveMarketSaleAutomation({
      runAutomation: runAutomation as never,
    });
    expect(runAutomation).toHaveBeenCalledWith({
      stagingAmount: 321,
      reservationAmount: 45,
    });
  });

  it.each([
    ["entry-null", { bad: null }],
    ["container-null", null],
    ["container-array", []],
  ] as const)(
    "live entrypoint 对 malformed Direct alias %s 不抛错、不写市场并保留 blocker",
    (_label, pendingAlias) => {
      installLiveRuntimeFixture(100);
      const market = Game.market as Partial<Market> & {
        deal: jest.Mock;
        createOrder: jest.Mock;
        cancelOrder: jest.Mock;
      };
      market.deal = jest.fn(() => OK);
      market.createOrder = jest.fn(() => OK);
      market.cancelOrder = jest.fn(() => OK);
      const data =
        Memory.data!.marketSaleAutomation as unknown as {
          managedOrders: unknown;
          pendingDirectDeals: unknown;
          directAutomation?: unknown;
        };
      data.managedOrders = { malformed: null };
      data.pendingDirectDeals = pendingAlias;
      delete data.directAutomation;

      let result:
        | ReturnType<typeof runLiveMarketSaleAutomation>
        | undefined;
      expect(() => {
        result = runLiveMarketSaleAutomation();
      }).not.toThrow();

      expect(result!.writes).toBe(0);
      expect(market.deal).not.toHaveBeenCalled();
      expect(market.createOrder).not.toHaveBeenCalled();
      expect(market.cancelOrder).not.toHaveBeenCalled();
      const direct =
        Memory.data!.marketSaleAutomation!.directAutomation!;
      expect(direct.migrationBlockedReason).toBeDefined();
      expect(
        Object.keys(direct.quarantinedPendingDirectDeals),
      ).not.toHaveLength(0);
      expect(
        direct.quarantinedPendingDirectDeals,
      ).toHaveProperty("__managed_order__:malformed", null);
      expect(
        (
          Memory.runtime!.marketSaleAutomation!
            .direct as unknown as {
              ledger: { quarantinedCount: number };
            }
        ).ledger.quarantinedCount,
      ).toBeGreaterThanOrEqual(2);

      Game.time += 1;
      expect(() => {
        result = runLiveMarketSaleAutomation();
      }).not.toThrow();
      expect(result!.writes).toBe(0);
      expect(
        Memory.data!.marketSaleAutomation!.directAutomation!
          .migrationBlockedReason,
      ).toBeDefined();
      expect(market.deal).not.toHaveBeenCalled();
      expect(market.createOrder).not.toHaveBeenCalled();
      expect(market.cancelOrder).not.toHaveBeenCalled();
    },
  );

  it("live entrypoint 对 malformed canonical Direct container 不抛错且 fail-closed", () => {
    installLiveRuntimeFixture(100);
    const market = Game.market as Partial<Market> & {
      deal: jest.Mock;
    };
    market.deal = jest.fn(() => OK);
    (
      Memory.data!.marketSaleAutomation as unknown as {
        directAutomation: unknown;
      }
    ).directAutomation = null;

    let result:
      | ReturnType<typeof runLiveMarketSaleAutomation>
      | undefined;
    expect(() => {
      result = runLiveMarketSaleAutomation();
    }).not.toThrow();

    expect(result!.writes).toBe(0);
    expect(market.deal).not.toHaveBeenCalled();
    expect(
      Memory.data!.marketSaleAutomation!.directAutomation!
        .migrationBlockedReason,
    ).toBeDefined();
    expect(
      (
        Memory.runtime!.marketSaleAutomation!
          .direct as unknown as {
            ledger: { quarantinedCount: number };
          }
      ).ledger.quarantinedCount,
    ).toBeGreaterThanOrEqual(1);

    Game.time += 1;
    expect(() => {
      result = runLiveMarketSaleAutomation();
    }).not.toThrow();
    expect(result!.writes).toBe(0);
    expect(
      Memory.data!.marketSaleAutomation!.directAutomation!
        .migrationBlockedReason,
    ).toBeDefined();
    expect(market.deal).not.toHaveBeenCalled();
  });

  it("marks an expired cached price fail-closed when refresh throws", () => {
    installLiveRuntimeFixture(100);
    const collectPricing = jest
      .fn()
      .mockImplementationOnce(() => pricingAt(Game.time))
      .mockImplementationOnce(() => {
        throw new Error("market read unavailable");
      });
    const runAutomation = jest.fn(() => automationResult());
    const dependencies = {
      collectPricing: collectPricing as never,
      collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
      runAutomation: runAutomation as never,
    };

    runLiveMarketSaleAutomation(dependencies);
    Game.time = 200;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    const result = runLiveMarketSaleAutomation(dependencies);

    expect(runAutomation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            trustedPrice: false,
            trustedDepth: false,
            additionalRejectionReasons: expect.arrayContaining([
              "pricing_refresh_failed",
            ]),
          }),
        ],
      }),
    );
    expect(
      Memory.runtime!.marketSaleAutomation!.shadowConsecutiveCycles,
    ).toBe(0);
    expect(result.rejectedByReason.pricing_refresh_failed).toBe(1);
  });

  it("非 ResourceControl tick 缺少可证明的价格缓存时立即撤单", () => {
    const { market } = installNonResourceControlManagedFixture(1_000);
    const collectProtection = jest.fn(() => managedProtectionAt(Game.time));
    const collectPricing = jest.fn(() => pricingAt(Game.time));

    const result = runLiveMarketSaleAutomation({
      collectProtection: collectProtection as never,
      collectPricing: collectPricing as never,
    });

    expect(collectProtection).toHaveBeenCalledWith(
      expect.anything(),
      Memory.data!.marketSaleAutomation!.managedOrders,
      {
        candidates: [
          { roomName: "W1N1", resource: RESOURCE_KEANIUM },
        ],
      },
    );
    expect(collectPricing).not.toHaveBeenCalled();
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(result.phase).toMatch(/requested|draining/);
    expect(result.rejectedByReason.current_tick_floor_unknown).toBe(1);
  });

  it("非 ResourceControl tick 配置签名变化清空旧底价缓存并安全撤单", () => {
    primeMakerPricingCache(1_009);
    const { market } = installNonResourceControlManagedFixture(1_010);
    Memory.cfg!.marketSaleAutomation!.hardFloor![RESOURCE_KEANIUM] = 71;

    const result = runLiveMarketSaleAutomation({
      collectProtection: jest.fn(() =>
        managedProtectionAt(Game.time),
      ) as never,
      collectPricing: jest.fn(() => pricingAt(Game.time)) as never,
    });

    expect(result.rejectedByReason.current_tick_floor_unknown).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data!.marketSaleAutomation!.managedOrders.managed
        .remainingExposure,
    ).toBe(1_000);
  });

  it("非 ResourceControl tick 有效缓存且 live 净价满足不变量时保持订单", () => {
    primeMakerPricingCache(1_019);
    const { market } = installNonResourceControlManagedFixture(1_020);

    const result = runLiveMarketSaleAutomation({
      collectProtection: jest.fn(() =>
        managedProtectionAt(Game.time),
      ) as never,
      collectPricing: jest.fn(() => pricingAt(Game.time)) as never,
    });

    expect(result.phase).toBe("maker");
    expect(result.rejectedByReason.current_tick_floor_unknown).toBeUndefined();
    expect(
      result.rejectedByReason.current_tick_floor_violation,
    ).toBeUndefined();
    expect(market.cancelOrder).not.toHaveBeenCalled();
  });

  it("非 ResourceControl tick 生产需求上升挤占 exposure 时立即撤单并保留暴露", () => {
    primeMakerPricingCache(1_099);
    const { market } = installNonResourceControlManagedFixture(1_100);
    const protection = managedProtectionAt(Game.time, {
      productionDemand: 100,
      protectedAmount: 6_100,
      grossSurplus: 900,
      newExposureCapacity: 0,
      sellableAmount: 0,
    });

    const result = runLiveMarketSaleAutomation({
      collectProtection: jest.fn(() => protection) as never,
      collectPricing: jest.fn(() => pricingAt(Game.time)) as never,
    });

    expect(
      result.rejectedByReason.current_tick_protection_insufficient,
    ).toBe(1);
    expect(result.phase).toMatch(/requested|draining/);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data!.marketSaleAutomation!.managedOrders.managed
        .remainingExposure,
    ).toBe(1_000);
    expect(
      Memory.data!.marketSaleAutomation!.pendingMutations.managed,
    ).toMatchObject({
      kind: "cancel",
      status: "submitted",
      conservativeExposure: 1_000,
    });
  });

  it("非 ResourceControl tick collector 不可用时 fail-closed 排空托管 exposure", () => {
    const { market } = installNonResourceControlManagedFixture(1_200);

    const result = runLiveMarketSaleAutomation({
      collectProtection: jest.fn(() => {
        throw new Error("collector unavailable");
      }) as never,
      collectPricing: jest.fn(() => pricingAt(Game.time)) as never,
    });

    expect(result.rejectedByReason.current_tick_protection_missing).toBe(1);
    expect(result.phase).toMatch(/requested|draining/);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data!.marketSaleAutomation!.managedOrders.managed
        .remainingExposure,
    ).toBe(1_000);
  });
});
