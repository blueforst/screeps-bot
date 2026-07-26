import {
  createDirectAutomationState,
  defaultDirectAutomationDependencies,
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

  it("能量影子价证据 age=99 可用，age=100 fail-closed", () => {
    const freshState = createDirectAutomationState();
    Game.time = 100;
    const fresh = runDirectAutomationPlanning(
      freshState,
      {
        tick: Game.time,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [
          candidate(Game.time, {
            energyShadowObservedAt: 1,
          }),
        ],
        makerExposurePresent: false,
      },
      dependencies(),
    );
    expect(fresh.planComplete).toBe(true);
    expect(freshState.shadowQualification.consecutiveCycles).toBe(1);

    const staleState = createDirectAutomationState();
    Game.time = 101;
    const stale = runDirectAutomationPlanning(
      staleState,
      {
        tick: Game.time,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [
          candidate(Game.time, {
            energyShadowObservedAt: 1,
          }),
        ],
        makerExposurePresent: false,
      },
      dependencies(),
    );
    expect(stale.rejectedByReason).toHaveProperty(
      "direct_structural_evidence_incomplete",
    );
    expect(staleState.shadowQualification.consecutiveCycles).toBe(0);
  });

  it("合法 Shadow→Direct 边只提交最高净价的 1,000 X，并先持久化 WAL", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    qualifyForActive(state, shadowConfig);
    const activeConfig = config("direct");
    const deps = dependencies();
    Game.time = 1_010;

    const result = runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: true,
        config: activeConfig,
        candidates: [candidate(Game.time)],
        makerExposurePresent: false,
      },
      deps,
    );

    expect(result.writes).toBe(1);
    expect(result.actions).toContain(
      "direct-submitted:E6N59:X:1000:top-small",
    );
    expect(deps.executePrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "top-small",
        amount: 1_000,
      }),
    );
    expect(Object.values(state.pendingDirectDeals)).toEqual([
      expect.objectContaining({
        status: "submitted",
        orderId: "top-small",
        dealAmount: 1_000,
        netCreditsMilli: 641_680_000,
      }),
    ]);
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

  it("生产市场 intent 优先，Direct 不写且保留可解释快照", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    qualifyForActive(state, shadowConfig);
    const deps = dependencies({
      hasProductionMarketIntent: jest.fn(() => true),
    });
    Game.time = 1_010;

    const result = runDirectAutomationPlanning(
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

    expect(result.actions).toContain("direct:production_priority_wait");
    expect(result.writes).toBe(0);
    expect(deps.executePrepared).not.toHaveBeenCalled();
    expect(state.lastPlanningSnapshot?.result).toBe(
      "production_priority_wait",
    );
  });

  it("inactive 但 remaining>0 的自有 SELL 仍阻断，remaining=0 不阻断", () => {
    const blockingOwnOrder: MarketOrderSnapshot = {
      id: "manual-low-sell",
      type: "sell",
      resourceType: RESOURCE_CATALYST,
      price: 0.5,
      amount: 1_000,
      remainingAmount: 1_000,
      roomName: "E6N59",
    };
    const state = createDirectAutomationState();
    const deps = dependencies({
      readOwnOrders: jest.fn(() => [blockingOwnOrder]),
    });

    const blocked = runDirectAutomationPlanning(
      state,
      {
        tick: 10,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [candidate(10)],
        makerExposurePresent: false,
      },
      deps,
    );
    expect(blocked.rejectedByReason).toEqual({
      manual_sell_order_present: 1,
    });
    expect(state.lastPlanningSnapshot?.manualSellOrderCount).toBe(1);

    const zeroRemaining = dependencies({
      readOwnOrders: jest.fn(() => [
        { ...blockingOwnOrder, remainingAmount: 0 },
      ]),
    });
    Game.time = 20;
    const allowed = runDirectAutomationPlanning(
      state,
      {
        tick: 20,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [candidate(20)],
        makerExposurePresent: false,
      },
      zeroRemaining,
    );
    expect(allowed.planComplete).toBe(true);
    expect(state.lastPlanningSnapshot?.zeroRemainingOwnOrderCount).toBe(1);
  });

  it("非规划 invalid tick 清资格但不读盘口或覆盖最后完整规划快照", () => {
    const state = createDirectAutomationState();
    const deps = dependencies();
    runDirectAutomationPlanning(
      state,
      {
        tick: 10,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [candidate(10)],
        makerExposurePresent: false,
      },
      deps,
    );
    const snapshot = state.lastPlanningSnapshot;
    const readCount = (deps.readCurrentBuyOrders as jest.Mock).mock.calls.length;

    runDirectAutomationPlanning(
      state,
      {
        tick: 11,
        fullPlanningTick: false,
        config: config("shadow"),
        candidates: [],
        makerExposurePresent: false,
      },
      deps,
    );

    expect(state.lastPlanningSnapshot).toBe(snapshot);
    expect(deps.readCurrentBuyOrders).toHaveBeenCalledTimes(readCount);

    const invalidShadow = {
      ...config("shadow"),
      validForPlanning: false,
      invalidReasons: ["direct_canary_allowlist_invalid"],
    };
    Game.time = 12;
    const invalid = runDirectAutomationPlanning(
      state,
      {
        tick: 12,
        fullPlanningTick: false,
        config: invalidShadow,
        candidates: [],
        makerExposurePresent: false,
      },
      deps,
    );

    expect(invalid.rejectedByReason).toHaveProperty(
      "direct_config_invalid",
    );
    expect(state.shadowQualification.consecutiveCycles).toBe(0);
    expect(state.shadowQualification.canary).toBeUndefined();
    expect(state.lastPlanningSnapshot).toBe(snapshot);
    expect(deps.readCurrentBuyOrders).toHaveBeenCalledTimes(readCount);
  });

  it("非规划 revision 往返会清空旧资格，恢复 r1 后仍不能激活 Direct", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    qualifyForActive(state, shadowConfig);
    const deps = dependencies();
    const changedConfig = {
      ...shadowConfig,
      configRevision: "direct-x-r2",
    };

    Game.time = 1_001;
    runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: false,
        config: changedConfig,
        candidates: [],
        makerExposurePresent: false,
      },
      deps,
    );
    expect(state.shadowQualification.configRevision).toBeUndefined();
    expect(state.shadowQualification.safetyFingerprint).toBeUndefined();
    expect(state.shadowQualification.canary).toBeUndefined();
    expect(state.shadowQualification.consecutiveCycles).toBe(0);

    Game.time = 1_002;
    runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: false,
        config: shadowConfig,
        candidates: [],
        makerExposurePresent: false,
      },
      deps,
    );

    Game.time = 1_010;
    const restored = runDirectAutomationPlanning(
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

    expect(restored.rejectedByReason).toHaveProperty(
      "direct_locked_canary_missing",
    );
    expect(restored.writes).toBe(0);
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("preflight 对同指纹 invalid 配置立即清资格，并继续收敛已有 pending", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    qualifyForActive(state, shadowConfig);
    const activeConfig = config("direct");
    const deps = dependencies();
    Game.time = 1_010;
    runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: true,
        config: activeConfig,
        candidates: [candidate(Game.time)],
        makerExposurePresent: false,
      },
      deps,
    );
    expect(Object.keys(state.pendingDirectDeals)).toHaveLength(1);
    const readsBefore = (deps.readOutgoingWindow as jest.Mock).mock.calls.length;
    const invalidActive = {
      ...activeConfig,
      validForPlanning: false,
      invalidReasons: ["direct_max_deal_amount_invalid"],
    };
    expect(directSafetyFingerprint(invalidActive)).toBe(
      directSafetyFingerprint(activeConfig),
    );

    Game.time = 1_011;
    runDirectAutomationPreflight(
      state,
      {
        tick: Game.time,
        config: invalidActive,
      },
      deps,
    );

    expect(state.shadowQualification.configRevision).toBeUndefined();
    expect(state.shadowQualification.safetyFingerprint).toBeUndefined();
    expect(state.shadowQualification.canary).toBeUndefined();
    expect(state.shadowQualification.consecutiveCycles).toBe(0);
    expect(state.shadowQualification.qualifiedAt).toBeUndefined();
    expect(state.shadowQualification.activationAuthorized).toBe(false);
    expect(deps.readOutgoingWindow).toHaveBeenCalledTimes(readsBefore + 1);
    expect(Object.keys(state.pendingDirectDeals)).toHaveLength(1);
  });

  it("active Direct 配置曾失效后必须重新跑 Shadow，不能原地恢复写权限", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    qualifyForActive(state, shadowConfig);
    const deps = dependencies();
    const invalidActive = {
      ...config("direct"),
      validForPlanning: false,
      invalidReasons: ["direct_canary_allowlist_invalid"],
    };
    Game.time = 1_010;

    const invalid = runDirectAutomationPlanning(
      state,
      {
        tick: Game.time,
        fullPlanningTick: false,
        config: invalidActive,
        candidates: [candidate(Game.time)],
        makerExposurePresent: false,
      },
      deps,
    );
    expect(invalid.writes).toBe(0);
    expect(state.shadowQualification.activationAuthorized).toBe(false);
    expect(state.shadowQualification.consecutiveCycles).toBe(0);

    Game.time = 1_020;
    const repairedInPlace = runDirectAutomationPlanning(
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
    expect(repairedInPlace.rejectedByReason).toHaveProperty(
      "direct_locked_canary_missing",
    );
    expect(repairedInPlace.writes).toBe(0);
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("Shadow 遇到生产 market intent 或 terminal/account claim 时不计完整周期", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    const base = dependencies();

    runDirectAutomationPlanning(
      state,
      {
        tick: 10,
        fullPlanningTick: true,
        config: shadowConfig,
        candidates: [candidate(10)],
        makerExposurePresent: false,
      },
      base,
    );
    expect(state.shadowQualification.consecutiveCycles).toBe(1);

    Game.time = 20;
    const production = runDirectAutomationPlanning(
      state,
      {
        tick: 20,
        fullPlanningTick: true,
        config: shadowConfig,
        candidates: [candidate(20)],
        makerExposurePresent: false,
      },
      dependencies({
        hasProductionMarketIntent: jest.fn(() => true),
      }),
    );
    expect(production.rejectedByReason).toHaveProperty(
      "direct_shadow_production_market_intent",
    );
    expect(state.shadowQualification.consecutiveCycles).toBe(0);
    expect(state.shadowQualification.canary?.roomName).toBe("E6N59");

    Game.time = 30;
    const claimed = runDirectAutomationPlanning(
      state,
      {
        tick: 30,
        fullPlanningTick: true,
        config: shadowConfig,
        candidates: [candidate(30)],
        makerExposurePresent: false,
      },
      dependencies({
        hasTerminalOrMarketClaim: jest.fn(() => true),
      }),
    );
    expect(claimed.rejectedByReason).toHaveProperty(
      "direct_shadow_action_claim_present",
    );
    expect(state.shadowQualification.consecutiveCycles).toBe(0);
  });

  it.each([
    ["WAL baseline", "direct_wal_baseline_unavailable"],
    ["pending prepare", "direct_pending_prepare_failed"],
    ["arbiter claim", "direct_arbiter_claim_failed"],
  ])(
    "active 完整规划的 %s 失败会替换本轮 snapshot",
    (failure, rejectionReason) => {
      const state = createDirectAutomationState();
      const shadowConfig = config("shadow");
      qualifyForActive(state, shadowConfig);
      Game.time = 1_001;
      runDirectAutomationPlanning(
        state,
        {
          tick: Game.time,
          fullPlanningTick: true,
          config: shadowConfig,
          candidates: [candidate(Game.time)],
          makerExposurePresent: false,
        },
        dependencies(),
      );
      const previousSnapshot = state.lastPlanningSnapshot;
      expect(previousSnapshot?.observedAt).toBe(1_001);

      const activeDependencies =
        failure === "WAL baseline"
          ? dependencies({
              readCredits: jest.fn(() => undefined),
            })
          : failure === "pending prepare"
            ? dependencies({
                readOutgoingWindow: jest.fn(() => {
                  (
                    state.pendingDirectDeals as unknown as Record<
                      string,
                      unknown
                    >
                  ).injected = {};
                  return {
                    transactions: [],
                    coversAttemptAt: true,
                    observedAt: Game.time,
                  };
                }),
              })
            : dependencies({
                claimPrepared: jest.fn(() => false),
              });
      Game.time = 1_010;
      const result = runDirectAutomationPlanning(
        state,
        {
          tick: Game.time,
          fullPlanningTick: true,
          config: config("direct"),
          candidates: [candidate(Game.time)],
          makerExposurePresent: false,
        },
        activeDependencies,
      );

      expect(result.rejectedByReason).toHaveProperty(rejectionReason);
      expect(state.lastPlanningSnapshot).not.toBe(previousSnapshot);
      expect(state.lastPlanningSnapshot).toMatchObject({
        observedAt: 1_010,
        result: "incomplete",
        opportunity: {
          orderId: "top-small",
        },
        rejectedByReason: {
          [rejectionReason]: 1,
        },
      });
    },
  );

  it("Shadow 最终 exact order 或 terminal 变化时不累计资格", () => {
    const changedOrderState = createDirectAutomationState();
    const changedOrder = dependencies({
      getOrderById: jest.fn(() =>
        order("top-small", 665.8, 1_001, "E51S9")),
    });

    const orderResult = runDirectAutomationPlanning(
      changedOrderState,
      {
        tick: 10,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [candidate(10)],
        makerExposurePresent: false,
      },
      changedOrder,
    );
    expect(orderResult.rejectedByReason).toHaveProperty(
      "direct_exact_order_changed",
    );
    expect(changedOrderState.shadowQualification.consecutiveCycles).toBe(0);

    const terminalState = createDirectAutomationState();
    const terminalReads = [
      {
        roomName: "E6N59",
        resourceStock: 72_047,
        energy: 50_000,
        cooldown: 0,
      },
      {
        roomName: "E6N59",
        resourceStock: 72_047,
        energy: 25_100,
        cooldown: 0,
      },
    ];
    const terminalResult = runDirectAutomationPlanning(
      terminalState,
      {
        tick: 10,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [candidate(10)],
        makerExposurePresent: false,
      },
      dependencies({
        readTerminal: jest.fn(() => terminalReads.shift()),
      }),
    );
    expect(terminalResult.rejectedByReason).toHaveProperty(
      "direct_terminal_changed",
    );
    expect(terminalState.shadowQualification.consecutiveCycles).toBe(0);
  });

  it("首次完整周期锁定结构 canary，后续优先级变化或暂时缺失都不自动换房", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    runDirectAutomationPlanning(
      state,
      {
        tick: 10,
        fullPlanningTick: true,
        config: shadowConfig,
        candidates: [
          candidate(10),
          candidate(10, {
            roomName: "E7N59",
            capacityState: "normal",
          }),
        ],
        makerExposurePresent: false,
      },
      dependencies(),
    );
    expect(state.shadowQualification.canary?.roomName).toBe("E6N59");

    Game.time = 20;
    runDirectAutomationPlanning(
      state,
      {
        tick: 20,
        fullPlanningTick: true,
        config: shadowConfig,
        candidates: [
          candidate(20, {
            capacityState: "normal",
            sellableAmount: 1_000,
          }),
          candidate(20, {
            roomName: "E7N59",
            capacityState: "pressure",
            sellableAmount: 500_000,
          }),
        ],
        makerExposurePresent: false,
      },
      dependencies(),
    );
    expect(state.shadowQualification.canary?.roomName).toBe("E6N59");
    expect(state.shadowQualification.consecutiveCycles).toBe(2);

    Game.time = 30;
    const unavailable = runDirectAutomationPlanning(
      state,
      {
        tick: 30,
        fullPlanningTick: true,
        config: shadowConfig,
        candidates: [
          candidate(30, {
            roomName: "E7N59",
            capacityState: "pressure",
          }),
        ],
        makerExposurePresent: false,
      },
      dependencies(),
    );
    expect(unavailable.rejectedByReason).toHaveProperty(
      "direct_locked_canary_unavailable",
    );
    expect(state.shadowQualification.canary?.roomName).toBe("E6N59");
    expect(state.shadowQualification.consecutiveCycles).toBe(0);
  });

  it("结构排序会跳过 terminal 不可执行候选，并锁定下一可执行房间", () => {
    const state = createDirectAutomationState();
    const result = runDirectAutomationPlanning(
      state,
      {
        tick: 10,
        fullPlanningTick: true,
        config: config("shadow"),
        candidates: [
          candidate(10, {
            rejectionReasons: ["direct_terminal_cooldown"],
            terminalCooldown: 5,
          }),
          candidate(10, {
            roomName: "E7N59",
            capacityState: "normal",
          }),
        ],
        makerExposurePresent: false,
      },
      dependencies(),
    );
    expect(result.planComplete).toBe(true);
    expect(state.shadowQualification.canary?.roomName).toBe("E7N59");
  });

  it("已有 Direct 状态缺 schema 或 qualification 损坏时迁移阻断且资格归零", () => {
    const missingSchema = normalizeDirectAutomationState({
      shadowQualification: {
        consecutiveCycles: 100,
        qualifiedAt: 1_000,
        activationAuthorized: true,
      },
    } as Partial<ReturnType<typeof createDirectAutomationState>>);
    expect(missingSchema.migrationBlockedReason).toBe(
      "unsupported_direct_state_schema",
    );
    expect(missingSchema.shadowQualification.consecutiveCycles).toBe(0);
    expect(missingSchema.shadowQualification.activationAuthorized).toBe(false);

    const corruptQualification = normalizeDirectAutomationState({
      ...createDirectAutomationState(),
      shadowQualification: {
        consecutiveCycles: 100,
        qualifiedAt: 1_000,
        activationAuthorized: true,
      },
    });
    expect(corruptQualification.migrationBlockedReason).toBe(
      "direct_qualification_state_invalid",
    );
    expect(corruptQualification.shadowQualification.consecutiveCycles).toBe(0);
    expect(
      normalizeDirectAutomationState(
        corruptQualification,
      ).migrationBlockedReason,
    ).toBeUndefined();
  });

  it("迁移时拒绝 count 已达门槛但 qualifiedAt 缺失的不可能资格状态", () => {
    const state = createDirectAutomationState();
    qualifyForActive(state, config("shadow"));
    state.shadowQualification.qualifiedAt = undefined;

    const normalized = normalizeDirectAutomationState(state);

    expect(normalized.migrationBlockedReason).toBe(
      "direct_qualification_state_invalid",
    );
    expect(normalized.shadowQualification.consecutiveCycles).toBe(0);
    expect(normalized.shadowQualification.canary).toBeUndefined();
  });

  it.each([
    ["pending missing", "pendingDirectDeals", undefined],
    ["pending null", "pendingDirectDeals", null],
    ["pending array", "pendingDirectDeals", []],
    ["outcomes missing", "directDealOutcomes", undefined],
    ["processed keys invalid", "processedDirectTransactionKeys", [1]],
    ["count missing", "directConfirmedDealCount", undefined],
    ["paused invalid", "directPausedForReview", "false"],
  ])(
    "schema-v1 %s 不得归一化成虚假空 WAL",
    (_label, field, malformed) => {
      const state = createDirectAutomationState() as unknown as Record<
        string,
        unknown
      >;
      state[field] = malformed;
      const normalized = normalizeDirectAutomationState(
        state as unknown as ReturnType<
          typeof createDirectAutomationState
        >,
      );

      expect(normalized.migrationBlockedReason).toBe(
        "direct_pending_store_state_invalid",
      );
    },
  );

  it("迁移时拒绝可提前触发 not-filled 的损坏 pending tick", () => {
    const state = createDirectAutomationState();
    const shadowConfig = config("shadow");
    qualifyForActive(state, shadowConfig);
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
      dependencies(),
    );
    const pending = Object.values(state.pendingDirectDeals)[0];
    expect(pending).toBeDefined();
    pending.successfulMissingObservationTicks = [pending.attemptAt];

    const normalized = normalizeDirectAutomationState(state);
    expect(normalized.migrationBlockedReason).toBe(
      "direct_pending_store_state_invalid",
    );
  });

  it("默认依赖在 Game.market.orders 缺失或损坏时 fail-closed", () => {
    const originalMarket = Game.market;
    (Game as unknown as { market: Partial<Market> }).market = {};
    expect(() =>
      defaultDirectAutomationDependencies.readOwnOrders(),
    ).toThrow("own market orders are unavailable");
    (Game as unknown as { market: Market }).market = originalMarket;
  });
});
