import {
  LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE_FINGERPRINT,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
  appendMarketDirectContinuousPermit,
  buildMarketDirectContinuousPermit,
  canonicalStableHashV1,
  createLegacyReviewedXEntryLifecycle,
  createMarketDirectEntryLifecycle,
  createMarketDirectPermitChainState,
  marketDirectContinuousEntry,
  marketDirectContinuousEvidenceFingerprint,
  marketDirectContinuousLegacyXOutcomeFingerprint,
  marketDirectLifecycleEvidenceDigest,
  marketDirectContinuousSharedFingerprint,
  marketDirectPermitAllowsNewDeal,
  observeMarketDirectShadowCycle,
  promoteMarketDirectEntryToCanary,
  promoteMarketDirectEntryToContinuous,
  reconcileMarketDirectEntryLifecycleFingerprints,
  reconcileMarketDirectLifecycleSetSharedFingerprint,
  recordMarketDirectCanaryConfirmation,
  validateMarketDirectContinuousPermitChain,
  type MarketDirectContinuousPermit,
  type MarketDirectEntryLifecycle,
  type MarketDirectPermitEntryGrant,
  type MarketDirectPermitEvidenceBinding,
} from "@/runtime/marketDirectContinuousPolicy";

const DIRECT_RUNTIME_FINGERPRINT = "direct-runtime-v2:fixture";
const SHARED = marketDirectContinuousSharedFingerprint({
  directRuntimeFingerprint: DIRECT_RUNTIME_FINGERPRINT,
});
const LEDGER_GENESIS = "receipt-head:legacy-x";

function frozenLegacyXOutcome(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { entryId: _entryId, ...identity } =
    LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY;
  return {
    ...identity,
    resolvedAt: 72_585_531,
    configRevision: "market-direct-canary-v1",
    directSafetyFingerprint: "frozen-direct-v1",
    observedOrderAmount: 5_000,
    plannedTransactionEnergy: 394,
    effectiveEnergyShadowPrice: 32.06,
    effectiveEnergyShadowPriceMilli: 32_060,
    energyShadowComponents: {
      hardFloor: 20,
      explicit: null,
      historyFloor: 32.06,
      ratchetFloor: null,
    },
    energyShadowObservedAt: 72_585_530,
    plannedNetCreditsMilli: 682_331_360,
    worstCaseActualAmount: 1,
    worstCaseNetCreditsMilli: 662_903,
    effectiveNetFloor: 600,
    effectiveNetFloorMilli: 600_000,
    protectionRevision: 72_585_530,
    attemptAt: 72_585_530,
    pendingRecoveryFingerprint: "v1:fixture",
    ...overrides,
  };
}

const LEGACY_X_FULL_OUTCOME_DIGEST =
  marketDirectContinuousLegacyXOutcomeFingerprint(
    frozenLegacyXOutcome(),
  );

function lifecycleDigest(
  entryId: string,
  stage: MarketDirectPermitEntryGrant["stage"],
): string {
  return marketDirectContinuousEvidenceFingerprint({
    entryId,
    stage,
    fixture: true,
  });
}

function grants(
  overrides: Partial<
    Record<
      string,
      Pick<MarketDirectPermitEntryGrant, "stage" | "newDealGrant">
    >
  > = {},
): MarketDirectPermitEntryGrant[] {
  return MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => {
    const defaults =
      entry.resourceType === "X"
        ? {
            stage: "continuous" as const,
            newDealGrant: "enabled" as const,
          }
        : {
            stage: "shadow" as const,
            newDealGrant: "suspended" as const,
          };
    const selected = overrides[entry.entryId] ?? defaults;
    return {
      entryId: entry.entryId,
      resourceFingerprint: entry.resourceFingerprint,
      stage: selected.stage,
      newDealGrant: selected.newDealGrant,
      lifecycleEvidenceDigest: lifecycleDigest(
        entry.entryId,
        selected.stage,
      ),
    };
  });
}

function legacyXEvidence(): MarketDirectPermitEvidenceBinding {
  return {
    entryId: "base-x-e6n59-v1",
    evidenceKey:
      "6a65f8e1656d080013d32210:6a65e025656d080013ccad03",
    kind: "legacy_reviewed_canary",
    digest: LEGACY_X_FULL_OUTCOME_DIGEST,
  };
}

function buildGenesis(
  override: Partial<Parameters<typeof buildMarketDirectContinuousPermit>[0]> =
    {},
): MarketDirectContinuousPermit {
  return buildMarketDirectContinuousPermit({
    epoch: 1,
    accountIdentity: "account:fixture",
    sharedDirectFingerprint: DIRECT_RUNTIME_FINGERPRINT,
    entryGrants: grants(),
    reviewedEvidence: [legacyXEvidence()],
    previousPermitId: "",
    previousPermitHead: MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
    previousLedgerHead: LEDGER_GENESIS,
    createdAt: 72_600_000,
    operatorAuthorizationFingerprint: "operator-review:fixture",
    ...override,
  });
}

function appendInput(
  ledgerHead = LEDGER_GENESIS,
): Parameters<typeof appendMarketDirectContinuousPermit>[2] {
  return {
    currentShard: "shard1",
    currentLedgerHead: ledgerHead,
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
  };
}

describe("marketDirectContinuous canonical policy", () => {
  it("canonicalStableHashV1 与对象键顺序无关，数组顺序仍有意义", () => {
    expect(canonicalStableHashV1({ b: 2, a: { y: 1, x: 0 } })).toBe(
      canonicalStableHashV1({ a: { x: 0, y: 1 }, b: 2 }),
    );
    expect(canonicalStableHashV1(["X", "H"])).not.toBe(
      canonicalStableHashV1(["H", "X"]),
    );
    expect(canonicalStableHashV1({ a: 1 })).toMatch(
      /^csh1:[0-9a-f]{32}$/,
    );
    expect(() => canonicalStableHashV1({ bad: Number.NaN })).toThrow(
      "non-finite",
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalStableHashV1(cyclic)).toThrow("cycle");
  });

  it("冻结且只包含精确 X/H/Z execution table", () => {
    expect(
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
        entryId: entry.entryId,
        resource: entry.resourceType,
        rooms: entry.allowedRoomNames,
        native: entry.requireNativeMineral,
        floors: [entry.hardFloor, entry.economicFloor],
        reserve: entry.laneReserve,
        minOrderAmount: entry.minOrderAmount,
        minNotional: entry.minOrderNotional,
        deal: entry.maxDealAmount,
        cooldown: entry.cooldownTicks,
        window: entry.rollingWindowTicks,
        cap: entry.rollingMaxAmount,
        opportunityReserve: entry.rollingOpportunityReserveAmount,
        scans: [
          entry.maxRawOrdersScanned,
          entry.maxEligibleOrdersPriced,
        ],
        maxEnergy: entry.maxTransactionEnergy,
        energyReserve: entry.terminalEnergyReserve,
      })),
    ).toEqual([
      {
        entryId: "base-h-e3n59-v1",
        resource: "H",
        rooms: ["E3N59"],
        native: true,
        floors: [428, 451],
        reserve: 100_000,
        minOrderAmount: 1_000,
        minNotional: 451_000,
        deal: 1_000,
        cooldown: 1_000,
        window: 30_000,
        cap: 8_000,
        opportunityReserve: 1_000,
        scans: [1_000, 200],
        maxEnergy: 1_000,
        energyReserve: 25_000,
      },
      {
        entryId: "base-x-e6n59-v1",
        resource: "X",
        rooms: ["E6N59"],
        native: false,
        floors: [600, 600],
        reserve: 100_000,
        minOrderAmount: 1_000,
        minNotional: 600_000,
        deal: 1_000,
        cooldown: 1_000,
        window: 30_000,
        cap: 8_000,
        opportunityReserve: 1_000,
        scans: [1_000, 200],
        maxEnergy: 1_000,
        energyReserve: 25_000,
      },
      {
        entryId: "base-z-e7n57-v1",
        resource: "Z",
        rooms: ["E7N57"],
        native: true,
        floors: [43, 45],
        reserve: 100_000,
        minOrderAmount: 1_000,
        minNotional: 45_000,
        deal: 1_000,
        cooldown: 1_000,
        window: 30_000,
        cap: 5_000,
        opportunityReserve: 1_000,
        scans: [1_000, 200],
        maxEnergy: 1_000,
        energyReserve: 25_000,
      },
    ]);
    expect(MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY).toEqual(
      expect.objectContaining({
        plannedDealAmount: 1_000,
        rollingWindowTicks: 30_000,
        rollingMaxAmount: 12_000,
        minConfirmedIntervalTicks: 1_000,
        maxDealsPerCycle: 1,
        maxActivePending: 1,
        requiredShadowCycles: 100,
      }),
    );
    expect(MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE_FINGERPRINT).toMatch(
      /^csh1:/,
    );
    expect(Object.isFrozen(MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE)).toBe(
      true,
    );
  });

  it("resource/shared/evidence fingerprints 各自隔离作用域", () => {
    const x = marketDirectContinuousEntry("base-x-e6n59-v1")!;
    const h = marketDirectContinuousEntry("base-h-e3n59-v1")!;
    expect(x.resourceFingerprint).not.toBe(h.resourceFingerprint);
    expect(
      marketDirectContinuousSharedFingerprint({
        directRuntimeFingerprint: "runtime-a",
      }),
    ).not.toBe(
      marketDirectContinuousSharedFingerprint({
        directRuntimeFingerprint: "runtime-b",
      }),
    );
    expect(
      marketDirectContinuousEvidenceFingerprint({ transaction: "a" }),
    ).not.toBe(
      marketDirectContinuousEvidenceFingerprint({ transaction: "b" }),
    );
  });

  it("legacy X digest 绑定完整 frozen outcome，不混入事后 terminal snapshot", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY,
        "terminalEnergyAfter",
      ),
    ).toBe(false);
    const baseline = marketDirectContinuousLegacyXOutcomeFingerprint(
      frozenLegacyXOutcome(),
    );
    expect(
      marketDirectContinuousLegacyXOutcomeFingerprint(
        frozenLegacyXOutcome({ resolvedAt: 72_585_532 }),
      ),
    ).not.toBe(baseline);
    expect(() =>
      marketDirectContinuousLegacyXOutcomeFingerprint(
        frozenLegacyXOutcome({ actualTransactionEnergy: 395 }),
      ),
    ).toThrow("actualTransactionEnergy");
  });
});

describe("marketDirectContinuous per-entry lifecycle", () => {
  function completeCycles(
    initial: MarketDirectEntryLifecycle,
    startTick: number,
    count: number,
    tickStep = 1,
  ): MarketDirectEntryLifecycle {
    const entry = marketDirectContinuousEntry(initial.entryId)!;
    let state = initial;
    for (let offset = 0; offset < count; offset += 1) {
      state = observeMarketDirectShadowCycle(state, {
        tick: startTick + offset * tickStep,
        result: offset % 2 ? "safe_no_opportunity" : "safe_opportunity",
        resourceFingerprint: entry.resourceFingerprint,
        sharedFingerprint: SHARED,
      });
    }
    return state;
  }

  it("H/Z 不继承 X；连续 100 个完整周期才 qualified", () => {
    const h = createMarketDirectEntryLifecycle(
      "base-h-e3n59-v1",
      SHARED,
    );
    const after99 = completeCycles(h, 1_000, 99, 10);
    expect(after99.stage).toBe("shadow");
    expect(after99.consecutiveCompleteCycles).toBe(99);
    const after100 = completeCycles(after99, 1_990, 1, 10);
    expect(after100.stage).toBe("qualified");
    expect(after100.qualifiedAt).toBe(1_990);
    expect(
      after100.evidenceHistory.some(
        (entry) => entry.kind === "shadow_qualification",
      ),
    ).toBe(true);

    const x = createLegacyReviewedXEntryLifecycle(
      SHARED,
      frozenLegacyXOutcome(),
    );
    expect(x.stage).toBe("review_paused");
    expect(x.canaryConfirmedCount).toBe(1);
    expect(h.canaryConfirmedCount).toBe(0);
  });

  it("按完整规划观测累计周期；无观测 tick 不打断，incomplete 才清零", () => {
    const h = createMarketDirectEntryLifecycle(
      "base-h-e3n59-v1",
      SHARED,
    );
    const entry = marketDirectContinuousEntry(h.entryId)!;
    let state = observeMarketDirectShadowCycle(h, {
      tick: 10,
      result: "safe_no_opportunity",
      resourceFingerprint: entry.resourceFingerprint,
      sharedFingerprint: SHARED,
    });
    state = observeMarketDirectShadowCycle(state, {
      tick: 12,
      result: "production_priority_wait",
      resourceFingerprint: entry.resourceFingerprint,
      sharedFingerprint: SHARED,
    });
    expect(state.consecutiveCompleteCycles).toBe(2);
    const duplicate = observeMarketDirectShadowCycle(state, {
      tick: 12,
      result: "safe_opportunity",
      resourceFingerprint: entry.resourceFingerprint,
      sharedFingerprint: SHARED,
    });
    expect(duplicate).toEqual(state);
    state = observeMarketDirectShadowCycle(state, {
      tick: 13,
      result: "incomplete",
      resourceFingerprint: entry.resourceFingerprint,
      sharedFingerprint: SHARED,
    });
    expect(state.consecutiveCompleteCycles).toBe(0);
  });

  it("qualified 后 tick 回拨必须退回 Shadow 并从一个完整周期重新开始", () => {
    const qualified = completeCycles(
      createMarketDirectEntryLifecycle(
        "base-h-e3n59-v1",
        SHARED,
      ),
      1_000,
      100,
      10,
    );
    const entry = marketDirectContinuousEntry(
      qualified.entryId,
    )!;
    const evidenceCount = qualified.evidenceHistory.length;

    const rolledBack = observeMarketDirectShadowCycle(
      qualified,
      {
        tick: qualified.lastCycleTick! - 1,
        result: "safe_no_opportunity",
        resourceFingerprint: entry.resourceFingerprint,
        sharedFingerprint: SHARED,
      },
    );

    expect(rolledBack).toMatchObject({
      stage: "shadow",
      consecutiveCompleteCycles: 1,
      lastCycleTick: qualified.lastCycleTick! - 1,
      lastShadowResult: "safe_no_opportunity",
      qualifiedAt: undefined,
    });
    expect(rolledBack.evidenceHistory).toHaveLength(
      evidenceCount,
    );
  });

  it("entry-local reset 不影响其他 entry；shared reset 清空全部当前资格但保留历史", () => {
    const hQualified = completeCycles(
      createMarketDirectEntryLifecycle("base-h-e3n59-v1", SHARED),
      1,
      100,
    );
    const zQualified = completeCycles(
      createMarketDirectEntryLifecycle("base-z-e7n57-v1", SHARED),
      1,
      100,
    );
    const hLocal = reconcileMarketDirectEntryLifecycleFingerprints(
      hQualified,
      {
        resourceFingerprint: "changed-h-resource-policy",
        sharedFingerprint: SHARED,
      },
    );
    expect(hLocal.reset).toBe("entry");
    expect(hLocal.state.stage).toBe("shadow");
    expect(zQualified.stage).toBe("qualified");

    const sharedReset =
      reconcileMarketDirectLifecycleSetSharedFingerprint(
        [hQualified, zQualified],
        "changed-shared",
      );
    expect(sharedReset.every((entry) => entry.stage === "shadow")).toBe(
      true,
    );
    expect(
      sharedReset.every((entry) => entry.sharedReviewRequired),
    ).toBe(true);
    expect(
      sharedReset.every((entry) => entry.evidenceHistory.length === 1),
    ).toBe(true);
  });

  it("qualified → canary → review_paused → continuous 严格逐 entry 推进", () => {
    const qualified = completeCycles(
      createMarketDirectEntryLifecycle("base-h-e3n59-v1", SHARED),
      20_000,
      100,
    );
    const qualification = qualified.evidenceHistory.find(
      (entry) => entry.kind === "shadow_qualification",
    )!;
    const canary = promoteMarketDirectEntryToCanary(qualified, {
      tick: 20_100,
      qualificationDigest: qualification.digest,
    });
    const evidence = {
      transactionId: "h-canary-tx",
      actualAmount: 1_000,
      price: 642.408,
    };
    const paused = recordMarketDirectCanaryConfirmation(canary, {
      tick: 20_101,
      actualAmount: 1_000,
      evidence,
    });
    expect(paused.stage).toBe("review_paused");
    expect(paused.canaryConfirmedCount).toBe(1);
    expect(() =>
      recordMarketDirectCanaryConfirmation(paused, {
        tick: 20_102,
        actualAmount: 1_000,
        evidence,
      }),
    ).toThrow();

    const reviewedEvidenceDigest =
      marketDirectContinuousEvidenceFingerprint({
        review: "independent-pass",
        transactionId: "h-canary-tx",
      });
    expect(() =>
      promoteMarketDirectEntryToContinuous(paused, {
        tick: 20_200,
        reviewedEvidenceDigest: "ok",
        expectedReviewedEvidenceDigest:
          reviewedEvidenceDigest,
      }),
    ).toThrow(
      "reviewed evidence does not match confirmed canary",
    );
    const continuous = promoteMarketDirectEntryToContinuous(paused, {
      tick: 20_200,
      reviewedEvidenceDigest,
      expectedReviewedEvidenceDigest:
        reviewedEvidenceDigest,
    });
    expect(continuous.stage).toBe("continuous");
  });
});

describe("marketDirectContinuous append-only permit chain", () => {
  it("签收 genesis，重复签收在 ledger 前进后仍幂等", () => {
    const genesis = buildGenesis();
    const first = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      appendInput(),
    );
    expect(first.status).toBe("appended");
    expect(first.state.currentPermitEpoch).toBe(1);
    expect(first.state.permitEpochHighWater).toBe(1);
    expect(first.state.currentPermitId).toBe(genesis.permitId);

    const retry = appendMarketDirectContinuousPermit(
      first.state,
      genesis,
      appendInput("receipt-head:advanced-after-deal"),
    );
    expect(retry.status).toBe("idempotent");
    expect(retry.state).toBe(first.state);
  });

  it("successor 可 suspend/resume grant，但不回退 stage 或删除历史", () => {
    const genesis = buildGenesis();
    const first = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      appendInput(),
    );
    const ledgerAfterFirst = "receipt-head:after-first";
    const suspended = buildMarketDirectContinuousPermit({
      epoch: 2,
      accountIdentity: genesis.accountIdentity,
      sharedDirectFingerprint: DIRECT_RUNTIME_FINGERPRINT,
      entryGrants: grants({
        "base-x-e6n59-v1": {
          stage: "continuous",
          newDealGrant: "suspended",
        },
      }),
      reviewedEvidence: [legacyXEvidence()],
      previousPermitId: genesis.permitId,
      previousPermitHead: genesis.permitHead,
      previousLedgerHead: ledgerAfterFirst,
      createdAt: genesis.createdAt + 1,
      operatorAuthorizationFingerprint: "operator:suspend-x",
    });
    const second = appendMarketDirectContinuousPermit(
      first.state,
      suspended,
      appendInput(ledgerAfterFirst),
    );
    expect(second.status).toBe("appended");
    expect(second.state.permitEpochHighWater).toBe(2);

    const xLifecycle = promoteMarketDirectEntryToContinuous(
      createLegacyReviewedXEntryLifecycle(
        genesis.sharedPolicyFingerprint,
        frozenLegacyXOutcome(),
      ),
      {
        tick: genesis.createdAt,
        reviewedEvidenceDigest:
          LEGACY_X_FULL_OUTCOME_DIGEST,
        expectedReviewedEvidenceDigest:
          LEGACY_X_FULL_OUTCOME_DIGEST,
      },
    );
    const resumedGrants = grants().map((grant) =>
      grant.entryId === "base-x-e6n59-v1"
        ? {
            ...grant,
            lifecycleEvidenceDigest:
              marketDirectLifecycleEvidenceDigest(
                xLifecycle,
              ),
          }
        : grant,
    );
    const ledgerAfterSecond = "receipt-head:after-second";
    const resumed = buildMarketDirectContinuousPermit({
      epoch: 3,
      accountIdentity: genesis.accountIdentity,
      sharedDirectFingerprint: DIRECT_RUNTIME_FINGERPRINT,
      entryGrants: resumedGrants,
      reviewedEvidence: [legacyXEvidence()],
      previousPermitId: suspended.permitId,
      previousPermitHead: suspended.permitHead,
      previousLedgerHead: ledgerAfterSecond,
      createdAt: genesis.createdAt + 2,
      operatorAuthorizationFingerprint: "operator:resume-x",
    });
    const third = appendMarketDirectContinuousPermit(
      second.state,
      resumed,
      appendInput(ledgerAfterSecond),
    );
    expect(third.status).toBe("appended");
    expect(third.state.permits).toHaveLength(3);

    expect(
      marketDirectPermitAllowsNewDeal(third.state, {
        shard: "shard1",
        entryId: "base-x-e6n59-v1",
        lifecycle: xLifecycle,
      }),
    ).toBe(true);
    expect(
      marketDirectPermitAllowsNewDeal(third.state, {
        shard: "shard1",
        entryId: "base-x-e6n59-v1",
        lifecycle: {
          ...xLifecycle,
          evidenceHistory:
            xLifecycle.evidenceHistory.slice(0, 1),
        },
      }),
    ).toBe(false);
  });

  it("WAL 未收敛只拒绝 successor，不覆盖 current", () => {
    const genesis = buildGenesis();
    const first = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      appendInput(),
    );
    const successor = buildMarketDirectContinuousPermit({
      epoch: 2,
      accountIdentity: genesis.accountIdentity,
      sharedDirectFingerprint: DIRECT_RUNTIME_FINGERPRINT,
      entryGrants: grants({
        "base-x-e6n59-v1": {
          stage: "continuous",
          newDealGrant: "suspended",
        },
      }),
      reviewedEvidence: [legacyXEvidence()],
      previousPermitId: genesis.permitId,
      previousPermitHead: genesis.permitHead,
      previousLedgerHead: "head:current",
      createdAt: genesis.createdAt + 1,
      operatorAuthorizationFingerprint: "operator:successor",
    });
    const rejected = appendMarketDirectContinuousPermit(
      first.state,
      successor,
      {
        ...appendInput("head:current"),
        hasPending: true,
      },
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.state.currentPermitId).toBe(genesis.permitId);
    expect(rejected.state.blocker).toBeUndefined();
  });

  it.each([
    ["wrong shard", { currentShard: "shard0" }],
    ["wrong ledger predecessor", { currentLedgerHead: "wrong-head" }],
  ])("%s 进入持久 permit_conflict", (_label, override) => {
    const genesis = buildGenesis();
    const result = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      { ...appendInput(), ...override },
    );
    expect(result.status).toBe("conflict");
    expect(result.state.blocker).toBe("permit_conflict");
    const retry = appendMarketDirectContinuousPermit(
      result.state,
      genesis,
      appendInput(),
    );
    expect(retry.status).toBe("conflict");
  });

  it("tip/high-water 回拨或 checkpoint 不一致 fail-closed", () => {
    const genesis = buildGenesis();
    const first = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      appendInput(),
    );
    const rolledBack = {
      ...first.state,
      currentPermitEpoch: 0,
      currentPermitId: "",
      permitChainHead: MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
    };
    const result = appendMarketDirectContinuousPermit(
      rolledBack,
      genesis,
      appendInput("receipt-head:later"),
    );
    expect(result.status).toBe("conflict");
    expect(result.state.blockerReason).toBe("permit_tip_mismatch");

    const checkpointMismatch = appendMarketDirectContinuousPermit(
      first.state,
      genesis,
      {
        ...appendInput("receipt-head:later"),
        checkpoint: {
          permitEpochHighWater: 0,
          permitChainHeadHighWater:
            MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
        },
      },
    );
    expect(checkpointMismatch.status).toBe("conflict");
  });

  it("只读 validator 覆盖 permit 自身份、连续 epoch/head、current pointer 与 checkpoint", () => {
    const genesis = buildGenesis();
    const first = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      appendInput(),
    );
    expect(
      validateMarketDirectContinuousPermitChain(first.state, {
        permitEpochHighWater: 1,
        permitChainHeadHighWater: genesis.permitHead,
      }),
    ).toEqual({ ok: true });

    const corruptions: Array<{
      label: string;
      state: typeof first.state;
    }> = [
      {
        label: "permit self identity",
        state: {
          ...first.state,
          permits: [
            {
              ...genesis,
              permitId: `${genesis.permitId}:tampered`,
            },
          ],
        },
      },
      {
        label: "permit epoch",
        state: {
          ...first.state,
          permits: [{ ...genesis, epoch: 2 }],
        },
      },
      {
        label: "permit head",
        state: {
          ...first.state,
          permits: [{ ...genesis, permitHead: "tampered-head" }],
        },
      },
      {
        label: "current pointer",
        state: {
          ...first.state,
          currentPermitId: "rolled-back-pointer",
        },
      },
    ];
    for (const corruption of corruptions) {
      const before = canonicalStableHashV1(corruption.state);
      expect(
        validateMarketDirectContinuousPermitChain(corruption.state),
      ).toEqual({
        ok: false,
        reason: "permit_chain_mismatch",
      });
      expect(canonicalStableHashV1(corruption.state)).toBe(before);
    }

    expect(
      validateMarketDirectContinuousPermitChain(first.state, {
        permitEpochHighWater: 0,
        permitChainHeadHighWater:
          MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
      }),
    ).toEqual({
      ok: false,
      reason: "permit_chain_or_checkpoint_mismatch",
    });
    expect(
      validateMarketDirectContinuousPermitChain({
        ...first.state,
        blocker: "permit_conflict",
        blockerReason: "persisted-conflict",
      }),
    ).toEqual({ ok: false, reason: "persisted-conflict" });
  });

  it("same epoch different content 与 evidence key 改绑均持久冲突", () => {
    const genesis = buildGenesis();
    const first = appendMarketDirectContinuousPermit(
      createMarketDirectPermitChainState(),
      genesis,
      appendInput(),
    );
    const sameEpochDifferent = buildGenesis({
      createdAt: genesis.createdAt + 1,
      operatorAuthorizationFingerprint: "different-operator",
    });
    const epochConflict = appendMarketDirectContinuousPermit(
      first.state,
      sameEpochDifferent,
      appendInput("receipt-head:later"),
    );
    expect(epochConflict.status).toBe("conflict");
    expect(epochConflict.state.blocker).toBe("permit_conflict");

    const evidenceConflict = buildMarketDirectContinuousPermit({
      epoch: 2,
      accountIdentity: genesis.accountIdentity,
      sharedDirectFingerprint: DIRECT_RUNTIME_FINGERPRINT,
      entryGrants: grants(),
      reviewedEvidence: [
        {
          ...legacyXEvidence(),
          digest: "different-evidence-content",
        },
      ],
      previousPermitId: genesis.permitId,
      previousPermitHead: genesis.permitHead,
      previousLedgerHead: "receipt-head:later",
      createdAt: genesis.createdAt + 1,
      operatorAuthorizationFingerprint: "operator:conflict",
    });
    const bindingConflict = appendMarketDirectContinuousPermit(
      first.state,
      evidenceConflict,
      appendInput("receipt-head:later"),
    );
    expect(bindingConflict.status).toBe("conflict");
    expect(bindingConflict.state.blockerReason).toBe(
      "reviewed_evidence_conflict",
    );
  });
});
