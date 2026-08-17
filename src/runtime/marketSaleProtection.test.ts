import {
  MARKET_PROTECTION_SOURCE_KINDS,
  buildMarketSaleProtectionLedger,
  getMarketProtectionEntryKey,
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
});
