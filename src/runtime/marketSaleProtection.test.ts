import {
  MARKET_PROTECTION_SOURCE_KINDS,
  buildMarketSaleProtectionLedger,
  evaluateMarketSaleCanaryPrerequisites,
  getMarketProtectionEntryKey,
  getMarketProtectionSellableAmount,
  type BuildMarketSaleProtectionLedgerInput,
  type MarketProtectionFact,
  type MarketProtectionSourceKind,
  type MarketProtectionSourceSnapshot,
} from "@/runtime/marketSaleProtection";

const TICK = 12_345;
const ROOM = "W1N1";
const RESOURCE = "K" as ResourceConstant;

function fact(
  amount: number,
  overrides: Partial<MarketProtectionFact> = {},
): MarketProtectionFact {
  return {
    roomName: ROOM,
    resource: RESOURCE,
    amount,
    ...overrides,
  };
}

function snapshot(
  facts: readonly MarketProtectionFact[] = [],
  overrides: Partial<MarketProtectionSourceSnapshot> = {},
): MarketProtectionSourceSnapshot {
  return {
    revision: TICK,
    observedAt: TICK,
    expiresAt: TICK + 1,
    complete: true,
    facts,
    ...overrides,
  };
}

function completeSources(): Record<
  MarketProtectionSourceKind,
  MarketProtectionSourceSnapshot
> {
  const sources = {} as Record<
    MarketProtectionSourceKind,
    MarketProtectionSourceSnapshot
  >;
  for (const sourceKind of MARKET_PROTECTION_SOURCE_KINDS) {
    sources[sourceKind] = snapshot();
  }
  sources.stock = snapshot([
    fact(1_000, { stableKey: "stock:W1N1:K", terminalStock: 600 }),
  ]);
  sources.floor = snapshot([
    fact(100, { stableKey: "floor:W1N1:K" }),
  ]);
  sources.forecast = snapshot([
    fact(50, { stableKey: "forecast:W1N1:K" }),
  ]);
  return sources;
}

function input(
  sourceOverrides: Partial<
    Record<MarketProtectionSourceKind, MarketProtectionSourceSnapshot>
  > = {},
): BuildMarketSaleProtectionLedgerInput {
  return {
    currentTick: TICK,
    revision: TICK,
    observedAt: TICK,
    expiresAt: TICK + 1,
    candidates: [{ roomName: ROOM, resource: RESOURCE }],
    sources: {
      ...completeSources(),
      ...sourceOverrides,
    },
  };
}

function entryFrom(
  sourceOverrides: Partial<
    Record<MarketProtectionSourceKind, MarketProtectionSourceSnapshot>
  > = {},
) {
  const ledger = buildMarketSaleProtectionLedger(input(sourceOverrides));
  return ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE)];
}

describe("marketSaleProtection", () => {
  it("aggregates every producer class and computes terminal-backed sellable stock", () => {
    const entry = entryFrom({
      resourceReservations: snapshot([
        fact(30, { stableKey: "reservation:factory-a" }),
      ]),
      blockedOutgoing: snapshot([
        fact(40, {
          stableKey: "transfer:manual-1",
          status: "blocked",
          blockedReason: "receiver_capacity",
        }),
      ]),
      carrierInFlight: snapshot([
        fact(20, { stableKey: "carrier:task-1:step-1" }),
      ]),
      factoryTargets: snapshot([
        fact(120, { stableKey: "factory:target:K" }),
      ]),
      factoryComponents: snapshot([
        fact(30, { stableKey: "factory:component:K" }),
      ]),
      factoryTasks: snapshot([
        fact(10, { stableKey: "factory:task:explicit-1" }),
      ]),
      synthesisActive: snapshot([
        fact(25, { stableKey: "synthesis:active:1" }),
      ]),
      synthesisPaused: snapshot([
        fact(15, { stableKey: "synthesis:paused:1" }),
      ]),
      hub: snapshot([fact(20, { stableKey: "hub:route:1" })]),
      boost: snapshot([fact(10, { stableKey: "boost:task:1" })]),
      war: snapshot([fact(10, { stableKey: "war:task:1" })]),
      managedExposure: snapshot([
        fact(50, {
          stableKey: "order:managed-1",
          managedOrderId: "managed-1",
        }),
      ]),
    });

    expect(entry.blocked).toBe(false);
    expect(entry.productionDemand).toBe(240);
    expect(entry.protectedOutgoing).toBe(70);
    expect(entry.carrierOrInFlight).toBe(20);
    expect(entry.protectedAmount).toBe(380);
    expect(entry.grossSurplus).toBe(670);
    expect(entry.managedExposure).toBe(50);
    expect(entry.newExposureCapacity).toBe(620);
    expect(entry.sellableAmount).toBe(550);
  });

  it("deduplicates stable contracts at their greatest amount across repeated views", () => {
    const entry = entryFrom({
      resourceReservations: snapshot([
        fact(80, { stableKey: "contract:shared" }),
      ]),
      blockedOutgoing: snapshot([
        fact(120, { stableKey: "contract:shared", status: "blocked" }),
      ]),
    });

    expect(entry.protectedOutgoing).toBe(120);
    const shared = entry.sourceContributions.find(
      (contribution) => contribution.stableKey === "contract:shared",
    );
    expect(shared).toMatchObject({
      amount: 120,
      sourceKinds: expect.arrayContaining([
        "resourceReservations",
        "blockedOutgoing",
      ]),
    });
  });

  it("counts legacy facts without stable keys independently", () => {
    const entry = entryFrom({
      blockedOutgoing: snapshot([
        fact(25, { status: "blocked" }),
        fact(25, { status: "blocked" }),
      ]),
    });

    expect(entry.protectedOutgoing).toBe(50);
    expect(
      entry.sourceContributions.filter(
        (contribution) =>
          contribution.sourceKinds.includes("blockedOutgoing"),
      ),
    ).toHaveLength(2);
  });

  it("keeps pending blocked outgoing protected until explicitly disposable and expired", () => {
    const entry = entryFrom({
      blockedOutgoing: snapshot([
        fact(100, {
          stableKey: "manual:blocked",
          status: "blocked",
          blockedReason: "receiver_capacity",
        }),
        fact(80, {
          stableKey: "auto:still-live",
          status: "pending",
          disposable: true,
          contractExpired: false,
        }),
        fact(60, {
          stableKey: "auto:expired",
          status: "pending",
          disposable: true,
          contractExpired: true,
        }),
        fact(20, {
          stableKey: "critical:failed",
          status: "failed",
        }),
      ]),
    });

    expect(entry.protectedOutgoing).toBe(200);
    expect(
      entry.sourceContributions.some(
        (contribution) => contribution.stableKey === "auto:expired",
      ),
    ).toBe(false);
  });

  it("includes both active and boost-paused synthesis plans", () => {
    const entry = entryFrom({
      synthesisActive: snapshot([
        fact(200, { stableKey: "synthesis:active:K" }),
      ]),
      synthesisPaused: snapshot([
        fact(300, { stableKey: "synthesis:paused:K" }),
      ]),
    });

    expect(entry.productionDemand).toBe(500);
    expect(entry.protectedAmount).toBe(600);
    expect(entry.sellableAmount).toBe(400);
  });

  it("layers local reserve, absolute target and consumptive demand without double-counting forecast", () => {
    const entry = entryFrom({
      floor: snapshot([
        fact(80, { stableKey: "floor:mineral-export" }),
        fact(90, { stableKey: "floor:factory" }),
      ]),
      forecast: snapshot([
        fact(100, { stableKey: "lane-reserve" }),
        fact(100, { stableKey: "lane-reserve" }),
      ]),
      factoryTargets: snapshot([
        fact(150, {
          stableKey: "factory:target:K",
          bucket: "absoluteTarget",
        }),
      ]),
      factoryComponents: snapshot([
        fact(40, {
          stableKey: "factory:component:other:K",
          bucket: "consumptiveDemand",
        }),
      ]),
      managedExposure: snapshot([
        fact(10, {
          stableKey: "managed:pending",
          managedOrderId: "pending",
        }),
      ]),
    });

    expect(entry.localReserve).toBe(100);
    expect(entry.absoluteTarget).toBe(150);
    expect(entry.consumptiveDemand).toBe(40);
    expect(entry.forecastBuffer).toBe(100);
    expect(entry.protectedAmount).toBe(200);
    expect(entry.sellableAmount).toBe(590);
  });

  it("fails closed when a required source is missing or observed incompletely", () => {
    const missingInput = input();
    delete missingInput.sources.war;
    const missing = buildMarketSaleProtectionLedger(missingInput).entries[
      getMarketProtectionEntryKey(ROOM, RESOURCE)
    ];
    const incomplete = entryFrom({
      boost: snapshot([], { complete: false }),
    });

    expect(missing.blocked).toBe(true);
    expect(missing.fresh).toBe(false);
    expect(missing.sellableAmount).toBe(0);
    expect(missing.blockedReasons).toContain("protection_stale");
    expect(incomplete.blockedReasons).toContain("protection_stale");
    expect(incomplete.sellableAmount).toBe(0);
  });

  it("fails only the matching candidate when a fact-specific lease is stale", () => {
    const otherRoom = "W2N2";
    const sources = completeSources();
    sources.stock = snapshot([
      fact(1_000, { terminalStock: 600 }),
      fact(1_000, {
        roomName: otherRoom,
        terminalStock: 600,
      }),
    ]);
    sources.floor = snapshot([
      fact(100),
      fact(100, { roomName: otherRoom }),
    ]);
    sources.forecast = snapshot([
      fact(50),
      fact(50, { roomName: otherRoom }),
    ]);
    sources.war = snapshot([
      fact(100, {
        stableKey: "war:stale",
        expiresAt: TICK - 1,
      }),
    ]);
    const ledger = buildMarketSaleProtectionLedger({
      ...input(),
      candidates: [
        { roomName: ROOM, resource: RESOURCE },
        { roomName: otherRoom, resource: RESOURCE },
      ],
      sources,
    });

    expect(
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE)].blockedReasons,
    ).toContain("protection_stale");
    expect(
      ledger.entries[getMarketProtectionEntryKey(otherRoom, RESOURCE)].blocked,
    ).toBe(false);
  });

  it("fails closed on conflicting stock observations and absent forecast", () => {
    const entry = entryFrom({
      stock: snapshot([
        fact(1_000, { terminalStock: 600 }),
        fact(900, { terminalStock: 500 }),
      ]),
      forecast: snapshot([]),
    });

    expect(entry.blockedReasons).toEqual(
      expect.arrayContaining(["stock_ambiguous", "forecast_missing"]),
    );
    expect(entry.totalStock).toBe(900);
    expect(entry.terminalStock).toBe(500);
    expect(entry.sellableAmount).toBe(0);
  });

  it("excludes the maintained order from managed exposure without releasing other orders", () => {
    const entry = entryFrom({
      managedExposure: snapshot([
        fact(200, {
          stableKey: "order:a",
          managedOrderId: "a",
        }),
        fact(50, {
          stableKey: "order:b",
          managedOrderId: "b",
        }),
      ]),
    });

    expect(entry.grossSurplus).toBe(900);
    expect(entry.sellableAmount).toBe(350);
    expect(getMarketProtectionSellableAmount(entry, TICK, {
      excludeManagedOrderId: "a",
    })).toBe(550);
    expect(getMarketProtectionSellableAmount(entry, TICK, {
      excludeManagedOrderId: "b",
    })).toBe(400);
    expect(getMarketProtectionSellableAmount(entry, TICK + 1, {
      excludeManagedOrderId: "a",
    })).toBe(0);
  });

  it("applies exact self-exclusion and the maintained amount to canary prerequisites", () => {
    const entry = entryFrom({
      managedExposure: snapshot([
        fact(200, {
          stableKey: "order:a",
          managedOrderId: "a",
        }),
        fact(50, {
          stableKey: "order:b",
          managedOrderId: "b",
        }),
      ]),
    });
    const prerequisite = {
      currentTick: TICK,
      isHubRoom: false,
      capacityState: "normal" as const,
      terminalExists: true,
      terminalCooldown: 0,
      terminalEnergy: 50_000,
      terminalEnergyReserve: 20_000,
      terminalFreeCapacity: 80_000,
      minimumTerminalFreeCapacity: 40_000,
      resourceAllowed: true,
      hasCriticalConflict: false,
      trustedPrice: true,
      trustedDepth: true,
      requireNoManagedExposure: false,
    };

    expect(
      evaluateMarketSaleCanaryPrerequisites(entry, {
        ...prerequisite,
        excludeManagedOrderId: "a",
        minimumSellableAmount: 550,
      }),
    ).toMatchObject({
      eligible: true,
      sellableAmount: 550,
      reasons: [],
    });
    expect(
      evaluateMarketSaleCanaryPrerequisites(entry, {
        ...prerequisite,
        excludeManagedOrderId: "a",
        minimumSellableAmount: 551,
      }),
    ).toMatchObject({
      eligible: false,
      sellableAmount: 550,
      reasons: ["no_sellable_amount"],
    });
    expect(
      evaluateMarketSaleCanaryPrerequisites(entry, {
        ...prerequisite,
        minimumSellableAmount: 500,
      }),
    ).toMatchObject({
      eligible: false,
      sellableAmount: 350,
      reasons: ["no_sellable_amount"],
    });
  });

  it("blocks an ambiguous stable key that crosses protection buckets", () => {
    const entry = entryFrom({
      factoryTargets: snapshot([
        fact(100, { stableKey: "ambiguous:key" }),
      ]),
      managedExposure: snapshot([
        fact(100, {
          stableKey: "ambiguous:key",
          managedOrderId: "order-1",
        }),
      ]),
    });

    expect(entry.blockedReasons).toContain(
      "protection_ambiguous_contribution",
    );
    expect(entry.sellableAmount).toBe(0);
  });

  it("accepts a fully known dynamic canary candidate", () => {
    const entry = entryFrom();
    const result = evaluateMarketSaleCanaryPrerequisites(entry, {
      currentTick: TICK,
      isHubRoom: false,
      capacityState: "pressure",
      terminalExists: true,
      terminalCooldown: 0,
      terminalEnergy: 50_000,
      terminalEnergyReserve: 20_000,
      terminalFreeCapacity: 80_000,
      minimumTerminalFreeCapacity: 40_000,
      resourceAllowed: true,
      hasCriticalConflict: false,
      trustedPrice: true,
      trustedDepth: true,
      minimumSellableAmount: 100,
    });

    expect(result).toEqual({
      eligible: true,
      sellableAmount: 600,
      reasons: [],
    });
  });

  it("returns every known canary rejection without relaxing safety", () => {
    const entry = entryFrom({
      managedExposure: snapshot([
        fact(100, {
          stableKey: "order:a",
          managedOrderId: "a",
        }),
      ]),
    });
    const result = evaluateMarketSaleCanaryPrerequisites(entry, {
      currentTick: TICK,
      isHubRoom: true,
      capacityState: "emergency",
      terminalExists: true,
      terminalCooldown: 5,
      terminalEnergy: 10_000,
      terminalEnergyReserve: 20_000,
      terminalFreeCapacity: 1_000,
      minimumTerminalFreeCapacity: 40_000,
      resourceAllowed: false,
      hasCriticalConflict: true,
      trustedPrice: false,
      trustedDepth: false,
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "hub_room",
        "capacity_emergency",
        "terminal_cooldown",
        "terminal_energy_reserve",
        "terminal_capacity",
        "resource_not_allowed",
        "critical_conflict",
        "price_untrusted",
        "depth_untrusted",
        "managed_exposure_present",
      ]),
    );
  });

  it("rejects malformed canary capacity and numeric prerequisites", () => {
    const entry = entryFrom();
    const result = evaluateMarketSaleCanaryPrerequisites(entry, {
      currentTick: TICK,
      isHubRoom: false,
      capacityState: "unknown" as "normal",
      terminalExists: true,
      terminalCooldown: 0,
      terminalEnergy: -1,
      terminalEnergyReserve: 0,
      terminalFreeCapacity: 10_000,
      minimumTerminalFreeCapacity: -1,
      resourceAllowed: true,
      hasCriticalConflict: false,
      trustedPrice: true,
      trustedDepth: true,
      minimumSellableAmount: Number.NaN,
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "capacity_unknown",
        "terminal_energy_unknown",
        "terminal_capacity_unknown",
        "no_sellable_amount",
      ]),
    );
  });
});
