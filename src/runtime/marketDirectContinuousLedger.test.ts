import {
  CONTINUOUS_FAILED_RETRY_TICKS,
  CONTINUOUS_CONFIRMED_CANARY_CHECKPOINT_GENESIS,
  CONTINUOUS_OUTCOME_RING_LIMIT,
  CONTINUOUS_PLANNED_AMOUNT,
  CONTINUOUS_RECEIPT_GENESIS,
  CONTINUOUS_RECEIPT_RING_LIMIT,
  LEGACY_X_PROCESSED_EVIDENCE_KEY,
  advanceContinuousWal,
  canonicalStableHashV1,
  computeContinuousQuota,
  computeOpportunityAdmissions,
  migrateLegacyXSeedLedger,
  prepareContinuousAttempt,
  recordContinuousOutcome,
  sealContinuousOutcome,
  validateContinuousLedger,
  type ContinuousOutcome,
  type ContinuousPendingAttempt,
  type ContinuousReceipt,
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

function failedOutcome(
  pending: ContinuousPendingAttempt,
  status: "failed" | "not_filled" = "failed",
): ContinuousOutcome {
  return {
    attemptSeq: pending.attemptSeq,
    status,
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
    evidenceKey: `${status}-${pending.attemptSeq}:${pending.orderId}`,
    reason: status,
    actualAmount: 0,
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

function executeFailed(
  state: MarketDirectContinuousLedger,
  tick: number,
): MarketDirectContinuousLedger {
  const safe = [{ resource: "H", resourceLimit: 100_000 }];
  const prepared = prepareContinuousAttempt(
    state,
    prepareInput(state, tick, "H", safe),
  );
  expect(prepared.action).toBe("prepared");
  return finish(
    prepared.state,
    failedOutcome(prepared.state.pending!),
  );
}

function appendFailedFixture(
  state: MarketDirectContinuousLedger,
  attemptAt: number,
): MarketDirectContinuousLedger {
  const next = JSON.parse(
    JSON.stringify(state),
  ) as MarketDirectContinuousLedger;
  const attemptSeq = next.nextAttemptSeq;
  const orderId = `buy-H-${attemptSeq}`;
  const evidenceKey = `failed-${attemptSeq}:${orderId}`;
  const storedOutcome = sealContinuousOutcome({
    attemptSeq,
    status: "failed",
    permitId: "permit-epoch-1",
    permitEpoch: 1,
    entryId: "base-h-e3n59-v1",
    resourcePolicyFingerprint: "fingerprint-H",
    sellerRoom: "E3N59",
    resource: "H",
    orderId,
    orderRoom: "E11S21",
    attemptAt,
    plannedAmount: 1_000,
    resolvedAt: attemptAt + 1,
    evidenceKey,
    reason: "failed",
    actualAmount: 0,
    pendingEvidenceHash: "fixture",
  });
  const base: Omit<
    ContinuousReceipt,
    "prevHash" | "eventHash" | "headHash"
  > = {
    attemptSeq,
    executionPolicy: "continuous",
    status: "failed",
    permitId: "permit-epoch-1",
    permitEpoch: 1,
    entryId: "base-h-e3n59-v1",
    resourcePolicyFingerprint: "fingerprint-H",
    sellerRoom: "E3N59",
    resource: "H",
    orderId,
    orderRoom: "E11S21",
    attemptAt,
    plannedAmount: 1_000,
    resolvedAt: attemptAt + 1,
    retentionTick: attemptAt + 1,
    evidenceKey,
    reason: "failed",
    actualAmount: 0,
    outcomeEventHash: storedOutcome.outcomeEventHash!,
  };
  const eventHash = canonicalStableHashV1({
    domain: "market-direct-continuous:receipt-v2",
    attemptSeq: base.attemptSeq,
    executionPolicy: base.executionPolicy,
    status: base.status,
    permitId: base.permitId,
    permitEpoch: base.permitEpoch,
    entryId: base.entryId,
    resourcePolicyFingerprint: base.resourcePolicyFingerprint,
    sellerRoom: base.sellerRoom,
    resource: base.resource,
    orderId: base.orderId,
    orderRoom: base.orderRoom,
    attemptAt: base.attemptAt,
    plannedAmount: base.plannedAmount,
    resolvedAt: base.resolvedAt,
    retentionTick: base.retentionTick,
    evidenceKey: base.evidenceKey,
    reason: base.reason,
    transactionId: null,
    transactionTime: null,
    actualAmount: 0,
    actualTransactionEnergy: null,
    actualNetCreditsMilli: null,
    outcomeEventHash: base.outcomeEventHash,
  });
  const receipt: ContinuousReceipt = {
    ...base,
    prevHash: next.receiptHeadHash,
    eventHash,
    headHash: canonicalStableHashV1({
      domain: "receipt-head-v2",
      prevHash: next.receiptHeadHash,
      eventHash,
    }),
  };
  next.receipts.push(receipt);
  next.receiptHeadHash = receipt.headHash;
  next.finalizedAttemptSeq = attemptSeq;
  next.nextAttemptSeq = attemptSeq + 1;
  next.retryNotBefore = attemptAt + CONTINUOUS_FAILED_RETRY_TICKS;
  next.processedEvidenceKeys.push({ attemptSeq, key: evidenceKey });
  next.outcomes.push(storedOutcome);
  if (next.outcomes.length > CONTINUOUS_OUTCOME_RING_LIMIT) {
    next.outcomes.splice(
      0,
      next.outcomes.length - CONTINUOUS_OUTCOME_RING_LIMIT,
    );
  }
  return next;
}

function failedFixture(count: number): {
  state: MarketDirectContinuousLedger;
  nextTick: number;
} {
  let state = genesis();
  let tick = LEGACY_TRANSACTION_TICK + 30_000;
  for (let index = 0; index < count; index += 1) {
    state = appendFailedFixture(state, tick);
    tick += CONTINUOUS_FAILED_RETRY_TICKS;
  }
  return { state, nextTick: tick };
}

describe("Continuous Direct deterministic genesis", () => {
  it("与 policy 共用 csh1 canonical hash 且不受 object insertion order 影响", () => {
    expect(canonicalStableHashV1({ b: 2, a: 1 })).toBe(
      canonicalStableHashV1({ a: 1, b: 2 }),
    );
    expect(canonicalStableHashV1({ a: 1 })).toMatch(
      /^csh1:[0-9a-f]{32}$/,
    );
  });

  it("把唯一 live X outcome 确定性映射为 seq1 genesis", () => {
    const first = migrateLegacyXSeedLedger(genesisInput());
    const second = migrateLegacyXSeedLedger(genesisInput());
    expect(first).toEqual(second);
    expect(first.action).toBe("migrated");
    expect(first.state).toEqual(
      expect.objectContaining({
        receiptHeadHash: first.state.receipts[0].headHash,
        finalizedAttemptSeq: 1,
        nextAttemptSeq: 2,
        permitEpochHighWater: 0,
      }),
    );
    expect(first.state.checkpoint).toEqual({
      prunedThroughSeq: 0,
      prunedHeadHash: CONTINUOUS_RECEIPT_GENESIS,
      confirmed: { global: { count: 0, amount: 0 }, resources: {} },
      confirmedCanaries: {},
      confirmedCanaryCommitment:
        CONTINUOUS_CONFIRMED_CANARY_CHECKPOINT_GENESIS,
    });
    expect(first.state.receipts[0]).toEqual(
      expect.objectContaining({
        attemptSeq: 1,
        executionPolicy: "legacy_canary_seed",
        permitEpoch: 0,
        evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
        transactionTime: LEGACY_TRANSACTION_TICK,
        retentionTick: LEGACY_TRANSACTION_TICK,
        actualAmount: 1_000,
        actualTransactionEnergy: 394,
        actualNetCreditsMilli: 682_331_360,
      }),
    );
    expect(first.state.processedEvidenceKeys).toEqual([
      {
        attemptSeq: 1,
        key: LEGACY_X_PROCESSED_EVIDENCE_KEY,
      },
    ]);
    expect(first.state.lifetimeConfirmed).toEqual({
      global: { count: 1, amount: 1_000 },
      resources: { X: { count: 1, amount: 1_000 } },
    });
    expect(validateContinuousLedger(first.state, MIGRATION_TICK).ok).toBe(
      true,
    );
  });

  it.each([
    ["resolvedAt", 72_585_532],
    ["observedOrderAmount", 28_921],
    ["actualNetCreditsMilli", 682_331_359],
    ["pendingRecoveryFingerprint", "v1:other"],
  ] as const)("核心字段 %s 漂移时 fail closed", (field, value) => {
    const result = migrateLegacyXSeedLedger(
      genesisInput({ [field]: value }),
    );
    expect(result.action).toBe("blocked");
    expect(result.blockerCode).toBe(
      "direct_migration_evidence_mismatch",
    );
    expect(result.state.receipts).toHaveLength(0);
  });
});

describe("Continuous Direct WAL prefixes", () => {
  it.each([
    [
      "缺少 executionEvidence",
      (input: PrepareContinuousAttemptInput) => {
        delete (
          input as Partial<PrepareContinuousAttemptInput>
        ).executionEvidence;
      },
    ],
    [
      "protection revision 不是 current tick",
      (input: PrepareContinuousAttemptInput) => {
        input.executionEvidence.protectionRevision -= 1;
      },
    ],
    [
      "outgoing window 不覆盖 attempt",
      (input: PrepareContinuousAttemptInput) => {
        input.executionEvidence.outgoingWindowCoversAttemptAt = false;
      },
    ],
    [
      "planning evidence 与 fingerprint 不一致",
      (input: PrepareContinuousAttemptInput) => {
        input.executionEvidence.planningEvidence += ":changed";
      },
    ],
    [
      "transaction keys 重复",
      (input: PrepareContinuousAttemptInput) => {
        input.executionEvidence.outgoingTransactionKeysBefore.push(
          input.executionEvidence.outgoingTransactionKeysBefore[0],
        );
      },
    ],
  ] as const)("%s 时 prepare fail closed", (_label, mutate) => {
    const initial = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const input = prepareInput(initial, tick, "H");
    mutate(input);
    const result = prepareContinuousAttempt(initial, input);
    expect(result.action).toBe("blocked");
    expect(result.blockerCode).toBe("direct_pending_invalid");
    expect(result.state.pending).toBeUndefined();
  });

  it("pending 落盘后 executionEvidence 被篡改会形成持久 blocker", () => {
    const initial = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const prepared = prepareContinuousAttempt(
      initial,
      prepareInput(initial, tick, "H"),
    );
    expect(prepared.action).toBe("prepared");
    const tampered = JSON.parse(
      JSON.stringify(prepared.state),
    ) as MarketDirectContinuousLedger;
    tampered.pending!.executionEvidence.creditsBefore += 1;
    expect(validateContinuousLedger(tampered, tick)).toEqual(
      expect.objectContaining({
        ok: false,
        blockerCode: "direct_pending_invalid",
      }),
    );
    const blocked = advanceContinuousWal(tampered, tick);
    expect(blocked.action).toBe("blocked");
    expect(blocked.state.blocker?.code).toBe(
      "direct_pending_invalid",
    );
  });

  it("outcome_written 前缀的终态字段被篡改时不得生成 receipt", () => {
    const initial = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const prepared = prepareContinuousAttempt(
      initial,
      prepareInput(initial, tick, "H"),
    );
    const outcome = confirmedOutcome(prepared.state.pending!);
    const written = recordContinuousOutcome(
      prepared.state,
      outcome.resolvedAt,
      outcome,
    );
    expect(written.action).toBe("outcome_written");

    const tampered = JSON.parse(
      JSON.stringify(written.state),
    ) as MarketDirectContinuousLedger;
    tampered.outcomes[0].actualAmount = 1;
    expect(
      validateContinuousLedger(
        tampered,
        outcome.resolvedAt,
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        blockerCode: "direct_outcome_conflict",
      }),
    );
    const blocked = advanceContinuousWal(
      tampered,
      outcome.resolvedAt,
    );
    expect(blocked.action).toBe("blocked");
    expect(blocked.state.receipts).toHaveLength(1);
    expect(blocked.state.lifetimeConfirmed.global.amount).toBe(
      1_000,
    );
  });

  it("严格逐步恢复 outcome -> receipt -> key -> delete", () => {
    const initial = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const prepared = prepareContinuousAttempt(
      initial,
      prepareInput(initial, tick, "H"),
    );
    expect(prepared.action).toBe("prepared");
    expect(validateContinuousLedger(prepared.state, tick).prefix).toBe(
      "active_waiting_outcome",
    );
    const outcome = confirmedOutcome(prepared.state.pending!);
    const outcomeWritten = recordContinuousOutcome(
      prepared.state,
      outcome.resolvedAt,
      outcome,
    );
    expect(
      validateContinuousLedger(
        outcomeWritten.state,
        outcome.resolvedAt,
      ).prefix,
    ).toBe("outcome_written");

    const receiptWritten = advanceContinuousWal(
      outcomeWritten.state,
      outcome.resolvedAt,
    );
    expect(receiptWritten.action).toBe("receipt_written");
    expect(
      validateContinuousLedger(
        receiptWritten.state,
        outcome.resolvedAt,
      ).prefix,
    ).toBe("receipt_written");

    const keyWritten = advanceContinuousWal(
      receiptWritten.state,
      outcome.resolvedAt,
    );
    expect(keyWritten.action).toBe("processed_key_written");
    expect(
      validateContinuousLedger(
        keyWritten.state,
        outcome.resolvedAt,
      ).prefix,
    ).toBe("processed_key_written");

    const deleted = advanceContinuousWal(
      keyWritten.state,
      outcome.resolvedAt,
    );
    expect(deleted.action).toBe("pending_deleted");
    expect(validateContinuousLedger(deleted.state, outcome.resolvedAt)).toEqual(
      expect.objectContaining({ ok: true, prefix: "idle" }),
    );
    expect(deleted.state.lifetimeConfirmed.global).toEqual({
      count: 2,
      amount: 2_000,
    });
  });

  it("重复 outcome 幂等，不生成第二 receipt", () => {
    const initial = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const prepared = prepareContinuousAttempt(
      initial,
      prepareInput(initial, tick, "H"),
    );
    const outcome = confirmedOutcome(prepared.state.pending!);
    const once = recordContinuousOutcome(
      prepared.state,
      tick + 1,
      outcome,
    );
    const twice = recordContinuousOutcome(
      once.state,
      tick + 1,
      outcome,
    );
    expect(twice.action).toBe("outcome_idempotent");
    expect(twice.state.outcomes).toHaveLength(1);
  });

  it("pending 单独丢失和 attempt 跳号均 fail closed", () => {
    const initial = genesis();
    const prepared = prepareContinuousAttempt(
      initial,
      prepareInput(initial, LEGACY_TRANSACTION_TICK + 1_000, "H"),
    ).state;
    const deleted = JSON.parse(
      JSON.stringify(prepared),
    ) as MarketDirectContinuousLedger;
    delete deleted.pending;
    expect(validateContinuousLedger(deleted)).toEqual(
      expect.objectContaining({
        ok: false,
        blockerCode: "direct_attempt_sequence_gap",
      }),
    );

    const jumped = JSON.parse(
      JSON.stringify(initial),
    ) as MarketDirectContinuousLedger;
    jumped.nextAttemptSeq += 2;
    const blocked = advanceContinuousWal(jumped, MIGRATION_TICK);
    expect(blocked.action).toBe("blocked");
    expect(blocked.state.blocker?.code).toBe(
      "direct_attempt_sequence_gap",
    );
  });

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
  it("confirmed 用 transactionTime；failed 用首次 resolvedAt 并 backoff 100", () => {
    let state = genesis();
    const confirmedTick = LEGACY_TRANSACTION_TICK + 1_000;
    state = executeConfirmed(state, confirmedTick, "H", 400);
    const confirmed = state.receipts[state.receipts.length - 1];
    expect(confirmed.retentionTick).toBe(confirmedTick);
    expect(confirmed.actualAmount).toBe(400);

    const failedTick = confirmedTick + 1_000;
    state = executeFailed(state, failedTick);
    const failed = state.receipts[state.receipts.length - 1];
    expect(failed.status).toBe("failed");
    expect(failed.transactionTime).toBeUndefined();
    expect(failed.retentionTick).toBe(failedTick + 1);
    expect(state.retryNotBefore).toBe(
      failedTick + CONTINUOUS_FAILED_RETRY_TICKS,
    );
  });

  it("planned reservation 同时进入 resource/global，partial receipt 原位替换 actual", () => {
    const initial = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const prepared = prepareContinuousAttempt(
      initial,
      prepareInput(initial, tick, "H"),
    ).state;
    const pendingQuota = computeContinuousQuota(
      prepared,
      tick,
      "H",
      8_000,
      12_000,
    )!;
    expect(pendingQuota.resourceUnmatchedPlanned).toBe(1_000);
    expect(pendingQuota.globalUnmatchedPlanned).toBe(1_000);

    const final = finish(
      prepared,
      confirmedOutcome(prepared.pending!, 400),
    );
    const quota = computeContinuousQuota(
      final,
      tick + 1,
      "H",
      8_000,
      12_000,
    )!;
    expect(quota.resourceUnmatchedPlanned).toBe(0);
    expect(quota.globalUnmatchedPlanned).toBe(0);
    expect(quota.resourceConfirmedActual).toBe(400);
    expect(quota.globalConfirmedActual).toBe(1_400);
    expect(quota.confirmedCooldownNotBefore).toBe(tick + 1_000);
  });

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

  it("第 51/65/201 笔后不把 lifetime/high-water 退化为 bounded outcome 长度", () => {
    const after51 = failedFixture(51);
    const after65 = failedFixture(65);
    const after201 = failedFixture(201);
    const state = after201.state;
    expect(after51.state.finalizedAttemptSeq).toBe(52);
    expect(after65.state.finalizedAttemptSeq).toBe(66);
    expect(after201.state.finalizedAttemptSeq).toBe(202);
    expect(state.outcomes).toHaveLength(CONTINUOUS_OUTCOME_RING_LIMIT);
    expect(state.receipts).toHaveLength(202);
    expect(state.processedEvidenceKeys).toHaveLength(202);
    expect(state.lifetimeConfirmed.global).toEqual({
      count: 1,
      amount: 1_000,
    });
    expect(
      validateContinuousLedger(state, after201.nextTick).ok,
    ).toBe(true);
  });

  it("第 513 条后仅裁剪过窗连续前缀，512 ring/checkpoint/head 仍闭合", () => {
    const fixture = failedFixture(511);
    let state = executeFailed(fixture.state, fixture.nextTick);
    const tick = fixture.nextTick + CONTINUOUS_FAILED_RETRY_TICKS;
    state = executeFailed(state, tick);
    expect(state.receipts).toHaveLength(
      CONTINUOUS_RECEIPT_RING_LIMIT,
    );
    expect(state.checkpoint.prunedThroughSeq).toBe(2);
    expect(state.checkpoint.confirmed).toEqual({
      global: { count: 1, amount: 1_000 },
      resources: { X: { count: 1, amount: 1_000 } },
    });
    expect(state.lifetimeConfirmed).toEqual({
      global: { count: 1, amount: 1_000 },
      resources: { X: { count: 1, amount: 1_000 } },
    });
    expect(state.receipts[0].attemptSeq).toBe(3);
    expect(state.receipts[0].prevHash).toBe(
      state.checkpoint.prunedHeadHash,
    );
    expect(validateContinuousLedger(state, tick + 1).ok).toBe(true);

    expect(
      state.checkpoint.confirmedCanaries[
        "base-x-e6n59-v1"
      ],
    ).toEqual(state.confirmedCanaries["base-x-e6n59-v1"]);
    const deletedCanaryHighWater = JSON.parse(
      JSON.stringify(state),
    ) as MarketDirectContinuousLedger;
    delete deletedCanaryHighWater.checkpoint
      .confirmedCanaries["base-x-e6n59-v1"];
    delete deletedCanaryHighWater.confirmedCanaries[
      "base-x-e6n59-v1"
    ];
    expect(
      validateContinuousLedger(
        deletedCanaryHighWater,
        tick + 1,
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        blockerCode:
          "direct_canary_checkpoint_commitment_mismatch",
      }),
    );
  });
});

describe("Continuous Direct opportunity reserve", () => {
  it("只给 current safe resources 留 1,000，且不改变 X > H > Z 价格顺序", () => {
    const state = genesis();
    const tick = LEGACY_TRANSACTION_TICK + 1_000;
    const all = computeOpportunityAdmissions(
      state,
      tick,
      SAFE_RESOURCES,
      12_000,
    )!;
    expect(all.find((entry) => entry.resource === "X")).toEqual(
      expect.objectContaining({
        admitted: true,
        unmetOtherReserves: { H: 1_000, Z: 1_000 },
      }),
    );
    const withoutZ = computeOpportunityAdmissions(
      state,
      tick,
      SAFE_RESOURCES.filter((entry) => entry.resource !== "Z"),
      12_000,
    )!;
    expect(
      withoutZ.find((entry) => entry.resource === "X")
        ?.unmetOtherReserves,
    ).toEqual({ H: 1_000 });
  });

  it("90,000 tick 内 X>H>Z 持续安全时 Z 不会饥饿", () => {
    let state = genesis();
    let tick = LEGACY_TRANSACTION_TICK + 1_000;
    const confirmed: Array<{ tick: number; resource: string }> = [];
    for (let step = 0; step < 90; step += 1) {
      const admissions = computeOpportunityAdmissions(
        state,
        tick,
        SAFE_RESOURCES,
        12_000,
      )!;
      const selected = ["X", "H", "Z"].find(
        (resource) =>
          admissions.find((entry) => entry.resource === resource)
            ?.admitted,
      );
      if (selected) {
        state = executeConfirmed(
          state,
          tick,
          selected,
          CONTINUOUS_PLANNED_AMOUNT,
        );
        confirmed.push({ tick, resource: selected });
      }
      tick += 1_000;
    }
    for (let window = 0; window < 3; window += 1) {
      const start =
        LEGACY_TRANSACTION_TICK + 1_000 + window * 30_000;
      const end = start + 29_999;
      expect(
        confirmed.some(
          (entry) =>
            entry.resource === "Z" &&
            entry.tick >= start &&
            entry.tick <= end,
        ),
      ).toBe(true);
    }
    expect(confirmed.some((entry) => entry.resource === "X")).toBe(true);
    expect(confirmed.some((entry) => entry.resource === "H")).toBe(true);
    expect(validateContinuousLedger(state, tick).ok).toBe(true);
  });
});
