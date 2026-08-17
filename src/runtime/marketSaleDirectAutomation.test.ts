import {
  createDirectAutomationState,
  normalizeDirectAutomationState,
  runDirectAutomationPlanning,
  runDirectAutomationPreflight,
  type DirectAutomationDependencies,
  type DirectRuntimeCandidate,
} from "@/runtime/marketSaleDirectAutomation";
import {
  directSafetyFingerprint,
  resolveMarketSaleAutomationConfig,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";

function config(
  mode: "shadow" | "direct",
): ResolvedMarketSaleAutomationConfig {
  const resolved = resolveMarketSaleAutomationConfig({
    mode,
    shadowStrategy: "direct",
    configRevision: "direct-x-r1",
    sellResources: [RESOURCE_CATALYST],
    hardFloor: { [RESOURCE_CATALYST]: 600 },
    economicFloor: { [RESOURCE_CATALYST]: 600 },
    forecastBuffer: { [RESOURCE_CATALYST]: 100_000 },
    minDealAmount: 1_000,
    makerBatchAmount: 5_000,
    creditReserve: 10_000,
    terminalEnergyReserve: 25_000,
    energyShadowHardFloor: 20,
    canary: { enabled: true, allowExpansion: false },
  });
  expect(resolved.invalidReasons).toEqual([]);
  return resolved;
}

function candidate(
  tick: number,
  overrides: Partial<DirectRuntimeCandidate> = {},
): DirectRuntimeCandidate {
  return {
    roomName: "E6N59",
    resourceType: RESOURCE_CATALYST,
    protectionRevision: tick,
    observedAt: tick,
    expiresAt: tick,
    sellableAmount: 72_047,
    terminalStock: 72_047,
    terminalCooldown: 0,
    terminalEnergy: 50_000,
    protectedAmount: 112_100,
    effectiveNetFloor: 600,
    directHistoryTrusted: true,
    effectiveEnergyShadowPrice: 26.8,
    energyShadowObservedAt: tick,
    energyShadowComponents: {
      hardFloor: 20,
      historyFloor: 26.8,
      ratchetFloor: 25.46,
    },
    capacityState: "pressure",
    isHubRoom: false,
    rejectionReasons: [],
    ...overrides,
  };
}

function order(
  id: string,
  price: number,
  amount: number,
  roomName: string,
): MarketOrderSnapshot {
  return {
    id,
    type: "buy",
    resourceType: RESOURCE_CATALYST,
    price,
    amount,
    roomName,
  };
}

function dependencies(
  overrides: Partial<DirectAutomationDependencies> = {},
): DirectAutomationDependencies {
  const orders = [
    order("lower-large", 640, 5_000, "E1N1"),
    order("top-small", 665.8, 1_000, "E51S9"),
  ];
  return {
    readCurrentBuyOrders: jest.fn(() => orders),
    readOwnOrders: jest.fn(() => []),
    getOrderById: jest.fn((orderId) =>
      orders.find((entry) => entry.id === orderId)),
    readTerminal: jest.fn((roomName) => ({
      roomName,
      resourceStock: 72_047,
      energy: 50_000,
      cooldown: 0,
    })),
    readCredits: jest.fn(() => 10_000_000),
    readOutgoingWindow: jest.fn(() => ({
      transactions: [],
      coversAttemptAt: true,
      observedAt: Game.time,
    })),
    calculateTransactionEnergy: jest.fn((amount, _from, to) => {
      if (amount === 1) return to === "E51S9" ? 1 : 0;
      return to === "E51S9" ? 900 : 100;
    }),
    claimPrepared: jest.fn(() => true),
    executePrepared: jest.fn(() => OK),
    releasePrepared: jest.fn(),
    hasProductionMarketIntent: jest.fn(() => false),
    hasTerminalOrMarketClaim: jest.fn(() => false),
    ...overrides,
  };
}

function qualifyForActive(
  state: ReturnType<typeof createDirectAutomationState>,
  shadowConfig: ResolvedMarketSaleAutomationConfig,
): void {
  const fingerprint = directSafetyFingerprint(shadowConfig)!;
  state.shadowQualification = {
    configRevision: shadowConfig.configRevision,
    safetyFingerprint: fingerprint,
    canary: {
      roomName: "E6N59",
      resourceType: RESOURCE_CATALYST,
      lockedAt: 10,
      configRevision: shadowConfig.configRevision!,
      safetyFingerprint: fingerprint,
    },
    consecutiveCycles: 100,
    lastCycleTick: 1_000,
    qualifiedAt: 1_000,
    lastLifecycleKey: "direct_shadow",
    lastLifecycleTick: 1_000,
    activationAuthorized: false,
  };
}

describe("Direct automation orchestration", () => {
  beforeEach(() => {
    Game.time = 10;
  });

  it("Shadow 连续 100 个完整周期零写，并按净价保留高价小单机会", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    const deps = dependencies();

    for (let cycle = 1; cycle <= 100; cycle += 1) {
      Game.time = cycle * 10;
      const result = runDirectAutomationPlanning(
        state,
        {
          tick: Game.time,
          fullPlanningTick: true,
          config: shadowConfig,
          candidates: [candidate(Game.time)],
          makerExposurePresent: false,
        },
        deps,
      );
      expect(result.writes).toBe(0);
      expect(result.planComplete).toBe(true);
      expect(result.opportunity).toMatchObject({
        orderId: "top-small",
        price: 665.8,
        dealAmount: 1_000,
      });
    }

    expect(state.shadowQualification.consecutiveCycles).toBe(100);
    expect(state.shadowQualification.qualifiedAt).toBe(1_000);
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("qualification-only 损坏不阻塞 WAL 确认，confirmed 后跨 revision 永久暂停且不能再资格化", () => {
    let state = createDirectAutomationState();
    qualifyForActive(state, config("shadow"));
    const deps = dependencies();
    Game.time = 1_010;
    runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: true,
        config: config("direct"),
        candidates: [candidate(Game.time)],
        makerExposurePresent: false,
      },
      deps,
    );
    const pending = Object.values(state.pendingDirectDeals)[0];
    expect(pending).toBeDefined();
    state.shadowQualification = {
      consecutiveCycles: 100,
      qualifiedAt: 1_000,
      activationAuthorized: true,
    };
    state = normalizeDirectAutomationState(
      JSON.parse(JSON.stringify(state)),
    );
    expect(state.migrationBlockedReason).toBe(
      "direct_qualification_state_invalid",
    );
    (deps.readOutgoingWindow as jest.Mock).mockReturnValue({
      transactions: [
        {
          transactionId: "tx-confirmed",
          time: pending.attemptAt,
          amount: pending.dealAmount,
          resourceType: pending.resource,
          from: pending.canaryRoomName,
          to: pending.orderRoomName,
          order: {
            id: pending.orderId,
            type: ORDER_BUY,
            price: pending.observedOrderPrice,
          },
        },
      ],
      coversAttemptAt: true,
      observedAt: pending.attemptAt + 1,
      oldestTime: pending.attemptAt,
      newestTime: pending.attemptAt,
    });

    Game.time = pending.attemptAt + 1;
    const reconciled = runDirectAutomationPreflight(
      state,
      {
        tick: Game.time,
        config: config("direct"),
      },
      deps,
    );
    expect(reconciled.rejectedByReason).toHaveProperty(
      "direct_qualification_state_invalid",
    );
    expect(state.pendingDirectDeals).toEqual({});
    expect(state.directDealOutcomes).toEqual([
      expect.objectContaining({
        status: "confirmed",
        requestId: pending.requestId,
      }),
    ]);
    expect(state.directConfirmedDealCount).toBe(1);
    expect(state.directPausedForReview).toBe(true);

    state = normalizeDirectAutomationState(
      JSON.parse(JSON.stringify(state)),
    );
    expect(state.migrationBlockedReason).toBeUndefined();
    const shadowR2 = {
      ...config("shadow"),
      configRevision: "direct-x-r2",
    };
    (deps.executePrepared as jest.Mock).mockClear();
    for (let cycle = 1; cycle <= 100; cycle += 1) {
      Game.time = 2_000 + cycle * 10;
      const paused = runDirectAutomationPlanning(
        state,
        {
          tick: Game.time,
          fullPlanningTick: true,
          config: shadowR2,
          candidates: [candidate(Game.time)],
          makerExposurePresent: false,
        },
        deps,
      );
      expect(paused.rejectedByReason).toHaveProperty(
        "paused_for_review",
      );
      expect(paused.writes).toBe(0);
      expect(
        state.shadowQualification.consecutiveCycles,
      ).toBe(0);
      expect(
        state.shadowQualification.activationAuthorized,
      ).toBe(false);
    }
    const directR2 = {
      ...config("direct"),
      configRevision: "direct-x-r2",
    };
    Game.time += 10;
    const stillPaused = runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: true,
        config: directR2,
        candidates: [candidate(Game.time)],
        makerExposurePresent: false,
      },
      deps,
    );
    expect(stillPaused.rejectedByReason).toHaveProperty(
      "paused_for_review",
    );
    expect(stillPaused.writes).toBe(0);
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });
});
