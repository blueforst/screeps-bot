import {
  LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
  appendMarketDirectContinuousPermit,
  buildMarketDirectContinuousPermit,
  createMarketDirectPermitChainState,
  marketDirectContinuousEvidenceFingerprint,
  marketDirectContinuousLegacyXOutcomeFingerprint,
  type MarketDirectContinuousPermit,
  type MarketDirectPermitEntryGrant,
  type MarketDirectPermitEvidenceBinding,
} from "@/runtime/marketDirectContinuousPolicy";

const DIRECT_RUNTIME_FINGERPRINT = "direct-runtime-v2:fixture";
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

describe("marketDirectContinuous append-only permit chain", () => {

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
