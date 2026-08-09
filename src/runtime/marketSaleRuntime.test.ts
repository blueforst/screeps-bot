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
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_POLICIES,
} from "@/runtime/marketBaseResourcePolicy";

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

function installMarketBaseV3PricingCacheFixture(
  tick: number,
): Record<
  ResourceConstant,
  { value: number; marketDate: string; updatedAt: number }
> {
  installContinuousPricingCacheFixture(tick);
  const configured = Memory.cfg!.marketSaleAutomation!;
  configured.directCapability = "continuous-v3";
  configured.configRevision = MARKET_BASE_RESOURCE_CONFIG_REVISION;
  configured.sellResources = [...MARKET_BASE_RESOURCE_CATALOG];
  configured.hardFloor = Object.fromEntries(
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
      policy.resource,
      policy.hardFloor,
    ]),
  );
  configured.economicFloor = Object.fromEntries(
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
      policy.resource,
      policy.economicFloor,
    ]),
  );
  configured.forecastBuffer = Object.fromEntries(
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
      policy.resource,
      policy.laneReserve,
    ]),
  );
  const trustedFloors = Object.fromEntries(
    [
      ...MARKET_BASE_RESOURCE_CATALOG.map((resource) => {
        const policy = MARKET_BASE_RESOURCE_POLICIES.find(
          (candidate) => candidate.resource === resource,
        )!;
        return [
          resource,
          {
            value: policy.economicFloor,
            marketDate: "2026-07-24",
            updatedAt: tick - 10,
          },
        ];
      }),
      [
        RESOURCE_ENERGY,
        {
          value: 20,
          marketDate: "2026-07-24",
          updatedAt: tick - 10,
        },
      ],
    ],
  ) as Record<
    ResourceConstant,
    { value: number; marketDate: string; updatedAt: number }
  >;
  for (const entry of Object.values(trustedFloors)) Object.freeze(entry);
  Object.freeze(trustedFloors);
  Memory.data!.marketSaleAutomation!.trustedFloors = trustedFloors;
  return trustedFloors;
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
});
