import {
  CONTINUOUS_PLANNED_AMOUNT,
  LEGACY_X_PROCESSED_EVIDENCE_KEY,
  advanceContinuousWal,
  canonicalStableHashV1,
  computeContinuousQuota,
  migrateLegacyXSeedLedger,
  prepareContinuousAttempt,
  recordContinuousOutcome,
  validateContinuousLedger,
  type ContinuousOutcome,
  type ContinuousPendingAttempt,
  type ContinuousSafeOpportunity,
  type LegacyV1SafeStateFixture,
  type LegacyXGenesisInput,
  type LegacyXReviewedOutcomeFixture,
  type MarketDirectContinuousLedger,
  type PrepareContinuousAttemptInput,
} from "@/runtime/marketDirectContinuousLedger";

const LEGACY_TRANSACTION_TICK = 72_585_530;
const MIGRATION_TICK = 72_585_531;

const LEGACY_STATE: LegacyV1SafeStateFixture = {
  schema: 1,
  directConfirmedDealCount: 1,
  directPausedForReview: true,
  pendingCount: 0,
  quarantinedCount: 0,
  reconcileGapCount: 0,
};

const CANONICAL_LEGACY_OUTCOME = {
  requestId: "direct:72585530:E6N59:X",
  transactionId: "6a65f8e1656d080013d32210",
  orderId: "6a65e025656d080013ccad03",
  evidenceKey:
    "6a65f8e1656d080013d32210:6a65e025656d080013ccad03",
  status: "confirmed",
  resolvedAt: 72_585_531,
  attemptAt: 72_585_530,
  transactionTime: 72_585_530,
  canaryRoomName: "E6N59",
  resource: "X",
  orderRoomName: "E21S49",
  observedOrderAmount: 28_920,
  observedOrderPrice: 694.963,
  observedOrderPriceMilli: 694_963,
  submittedDealAmount: 1_000,
  plannedTransactionEnergy: 394,
  plannedNetCreditsMilli: 682_331_360,
  actualAmount: 1_000,
  actualTransactionEnergy: 394,
  actualNetCreditsMilli: 682_331_360,
  worstCaseNetCreditsMilli: 662_903,
  effectiveEnergyShadowPrice: 32.06,
  effectiveEnergyShadowPriceMilli: 32_060,
  energyShadowComponents: {
    hardFloor: 20,
    historyFloor: 31.276,
    ratchetFloor: 32.06,
  },
  protectionRevision: 72_585_530,
  pendingRecoveryFingerprint: "v1:bbb1de5ce52cb2d0",
  directSafetyFingerprint: "v1:live-reviewed-x",
};

function genesisInput(
  overrides: Partial<LegacyXReviewedOutcomeFixture> = {},
): LegacyXGenesisInput {
  const reviewedOutcome: LegacyXReviewedOutcomeFixture = {
    requestId: "direct:72585530:E6N59:X",
    transactionId: "6a65f8e1656d080013d32210",
    orderId: "6a65e025656d080013ccad03",
    evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
    status: "confirmed",
    resolvedAt: 72_585_531,
    attemptAt: 72_585_530,
    transactionTime: 72_585_530,
    sellerRoom: "E6N59",
    orderRoom: "E21S49",
    resource: "X",
    observedOrderAmount: 28_920,
    actualAmount: 1_000,
    plannedTransactionEnergy: 394,
    actualTransactionEnergy: 394,
    observedOrderPriceMilli: 694_963,
    plannedNetCreditsMilli: 682_331_360,
    actualNetCreditsMilli: 682_331_360,
    worstCaseNetCreditsMilli: 662_903,
    effectiveEnergyShadowPriceMilli: 32_060,
    energyShadowComponents: {
      hardFloor: 20,
      historyFloor: 31.276,
      ratchetFloor: 32.06,
    },
    protectionRevision: 72_585_530,
    pendingRecoveryFingerprint: "v1:bbb1de5ce52cb2d0",
    directSafetyFingerprint: "v1:live-reviewed-x",
    canonicalOutcome: CANONICAL_LEGACY_OUTCOME,
    ...overrides,
  };
  return {
    migrationTick: MIGRATION_TICK,
    legacyState: LEGACY_STATE,
    reviewedOutcome,
    expectedLegacyStateDigest: canonicalStableHashV1(LEGACY_STATE),
    expectedReviewedOutcomeDigest: canonicalStableHashV1(
      CANONICAL_LEGACY_OUTCOME,
    ),
  };
}

function genesis(): MarketDirectContinuousLedger {
  const migrated = migrateLegacyXSeedLedger(genesisInput());
  expect(migrated.ok).toBe(true);
  return migrated.state;
}

const SAFE_RESOURCES: ContinuousSafeOpportunity[] = [
  { resource: "X", resourceLimit: 8_000 },
  { resource: "H", resourceLimit: 8_000 },
  { resource: "Z", resourceLimit: 5_000 },
];

function planningFingerprint(evidence: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < evidence.length; index += 1) {
    hash ^= evidence.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `market-direct-continuous:plan:v1:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}:${evidence.length}`;
}

function details(resource: string) {
  if (resource === "X") {
    return {
      entryId: "base-x-e6n59-v1",
      room: "E6N59",
      orderRoom: "E21S49",
      resourceLimit: 8_000,
    };
  }
  if (resource === "H") {
    return {
      entryId: "base-h-e3n59-v1",
      room: "E3N59",
      orderRoom: "E11S21",
      resourceLimit: 8_000,
    };
  }
  return {
    entryId: "base-z-e7n57-v1",
    room: "E7N57",
    orderRoom: "W11S21",
    resourceLimit: 5_000,
  };
}

function prepareInput(
  state: MarketDirectContinuousLedger,
  tick: number,
  resource: string,
  safeOpportunityResources = SAFE_RESOURCES,
): PrepareContinuousAttemptInput {
  const selected = details(resource);
  const planningEvidence = JSON.stringify({
    tick,
    resource,
    orderId: `buy-${resource}-${state.nextAttemptSeq}`,
  });
  return {
    tick,
    executionPolicy: "continuous",
    permitId: "permit-epoch-1",
    permitEpoch: 1,
    entryId: selected.entryId,
    resourcePolicyFingerprint: `fingerprint-${resource}`,
    sellerRoom: selected.room,
    resource,
    orderId: `buy-${resource}-${state.nextAttemptSeq}`,
    orderRoom: selected.orderRoom,
    plannedAmount: CONTINUOUS_PLANNED_AMOUNT,
    plannedTransactionEnergy: 400,
    plannedNetCreditsMilli: 600_000_000,
    evidenceKeyHint: `attempt-${state.nextAttemptSeq}`,
    executionEvidence: {
      observedOrderPriceMilli: 650_000,
      observedOrderAmount: 5_000,
      effectiveEnergyShadowPriceMilli: 32_060,
      effectiveNetFloorMilli:
        resource === "Z" ? 45_000 : resource === "H" ? 451_000 : 600_000,
      worstCaseNetCreditsMilli:
        resource === "Z" ? 48_000 : resource === "H" ? 610_000 : 620_000,
      protectionRevision: tick,
      planningFingerprint: planningFingerprint(planningEvidence),
      planningEvidence,
      terminalResourceBefore: 150_000,
      terminalEnergyBefore: 50_000,
      terminalCooldownBefore: 0,
      creditsBefore: 2_000_000.25,
      outgoingTransactionKeysBefore: [
        "baseline-tx:baseline-order",
      ],
      outgoingWindowObservedAt: tick,
      outgoingWindowOldestTime: Math.max(0, tick - 10),
      outgoingWindowNewestTime: tick,
      outgoingWindowCoversAttemptAt: true,
    },
    resourceLimit: selected.resourceLimit,
    globalLimit: 12_000,
    safeOpportunityResources,
  };
}

function confirmedOutcome(
  pending: ContinuousPendingAttempt,
  actualAmount = CONTINUOUS_PLANNED_AMOUNT,
): ContinuousOutcome {
  return {
    attemptSeq: pending.attemptSeq,
    status: "confirmed",
    permitId: pending.permitId,
    permitEpoch: pending.permitEpoch,
    entryId: pending.entryId,
    resourcePolicyFingerprint:
      pending.resourcePolicyFingerprint,
    sellerRoom: pending.sellerRoom,
    resource: pending.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: CONTINUOUS_PLANNED_AMOUNT,
    resolvedAt: pending.attemptAt + 1,
    evidenceKey: `tx-${pending.attemptSeq}:${pending.orderId}`,
    transactionId: `tx-${pending.attemptSeq}`,
    transactionTime: pending.attemptAt,
    actualAmount,
    actualTransactionEnergy: 400,
    actualNetCreditsMilli: actualAmount * 600_000,
    pendingEvidenceHash: pending.frozenEvidenceHash,
  };
}


function finish(
  state: MarketDirectContinuousLedger,
  outcome: ContinuousOutcome,
): MarketDirectContinuousLedger {
  const written = recordContinuousOutcome(
    state,
    outcome.resolvedAt,
    outcome,
  );
  expect(written.action).toBe("outcome_written");
  const receipt = advanceContinuousWal(
    written.state,
    outcome.resolvedAt,
  );
  expect(receipt.action).toBe("receipt_written");
  const processed = advanceContinuousWal(
    receipt.state,
    outcome.resolvedAt,
  );
  expect(processed.action).toBe("processed_key_written");
  const deleted = advanceContinuousWal(
    processed.state,
    outcome.resolvedAt,
  );
  expect(deleted.action).toBe("pending_deleted");
  expect(validateContinuousLedger(deleted.state, outcome.resolvedAt)).toEqual(
    expect.objectContaining({ ok: true, prefix: "idle" }),
  );
  return deleted.state;
}

function executeConfirmed(
  state: MarketDirectContinuousLedger,
  tick: number,
  resource: string,
  actualAmount = CONTINUOUS_PLANNED_AMOUNT,
  safe = SAFE_RESOURCES,
): MarketDirectContinuousLedger {
  const prepared = prepareContinuousAttempt(
    state,
    prepareInput(state, tick, resource, safe),
  );
  expect(prepared.action).toBe("prepared");
  return finish(
    prepared.state,
    confirmedOutcome(prepared.state.pending!, actualAmount),
  );
}




describe("Continuous Direct WAL prefixes", () => {

  it("断链、分叉、逆序和 processed key 冲突均被检测", () => {
    const state = executeConfirmed(
      genesis(),
      LEGACY_TRANSACTION_TICK + 1_000,
      "H",
    );
    const corruptions: Array<
      (copy: MarketDirectContinuousLedger) => void
    > = [
      (copy) => {
        copy.receipts[1].prevHash = "fork";
      },
      (copy) => {
        copy.receipts[1].eventHash = "fork";
      },
      (copy) => {
        copy.receipts[1].attemptAt =
          copy.receipts[0].attemptAt - 1;
      },
      (copy) => {
        copy.processedEvidenceKeys[1].key =
          LEGACY_X_PROCESSED_EVIDENCE_KEY;
      },
    ];
    corruptions.forEach((corrupt) => {
      const copy = JSON.parse(
        JSON.stringify(state),
      ) as MarketDirectContinuousLedger;
      corrupt(copy);
      expect(validateContinuousLedger(copy).ok).toBe(false);
    });
  });
});

describe("Continuous Direct receipt retention and quota", () => {

  it("rolling 窗口左边界包含，下一 tick 严格移出", () => {
    const state = genesis();
    const insideTick =
      LEGACY_TRANSACTION_TICK + 30_000 - 1;
    const outsideTick = LEGACY_TRANSACTION_TICK + 30_000;
    expect(
      computeContinuousQuota(state, insideTick, "X", 8_000, 12_000)!
        .resourceConfirmedActual,
    ).toBe(1_000);
    expect(
      computeContinuousQuota(state, outsideTick, "X", 8_000, 12_000)!
        .resourceConfirmedActual,
    ).toBe(0);
  });
});
