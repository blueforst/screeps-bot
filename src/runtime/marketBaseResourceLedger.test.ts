import {
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  type MarketBaseDerivedLaneLifecycle,
} from "@/runtime/marketBaseResourcePolicy";
import {
  appendMarketBaseResourcePermit,
  buildMarketBaseResourceBootstrapRatchetHighWater,
  buildMarketBaseResourceLegacyV2GrantSuspension,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourcePermitRuntimeAnchor,
  buildMarketBaseResourceSignedLaneGrant,
  buildMarketBaseResourceV2EventCutoverCheckpoint,
  createMarketBaseResourcePermitRuntimeContext,
  createMarketBaseResourcePermitChainState,
  validateMarketBaseResourcePermitChain,
  validateMarketBaseResourcePermitRuntimeGate,
  wrapAuthenticatedLegacyV2PermitRecord,
  type AppendMarketBaseResourcePermitInput,
  type MarketBaseResourcePermitChainState,
} from "@/runtime/marketBaseResourcePermit";
import {
  MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
  MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
  MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT,
  MARKET_BASE_RESOURCE_PENDING_HASH_REVISION,
  MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT,
  MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT,
  advanceMarketBaseResourceWal,
  advanceMarketBaseResourceWalWithRuntimeContext,
  buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis,
  buildMarketBaseResourceConfirmedCanaryProof,
  buildMarketBaseResourceHistoricalPermitRef,
  buildMarketBaseResourceLedgerRuntimeAnchor,
  buildMarketBaseResourcePermitChainAnchor,
  computeMarketBaseResourceQuota,
  createMarketBaseResourceLedgerRuntimeContext,
  createMarketBaseResourceLedger,
  inspectMarketBaseResourceCanaryGrantAvailability,
  inspectMarketBaseResourceCanaryGrantAvailabilityWithRuntimeContext,
  marketBaseResourceCanaryReviewFactsFor,
  marketBaseResourceConfirmedCanaryFor,
  marketBaseResourceRetainedReceiptPermitReferences,
  prepareMarketBaseResourceAttempt,
  prepareMarketBaseResourceAttemptWithRuntimeContext,
  rebindMarketBaseResourceLedgerPermitAnchor,
  recordMarketBaseResourceOutcome,
  recordMarketBaseResourceOutcomeWithRuntimeContext,
  sealMarketBaseResourceOutcome,
  validateMarketBaseResourceLedger,
  validateMarketBaseResourceLedgerRuntimeGate,
  validateMarketBaseResourceMixedVersionEvent,
  validateMarketBaseResourcePermitChainDominatesAnchor,
  type MarketBaseResourceLedger,
  type MarketBaseResourceLedgerOperation,
  type MarketBaseResourceLedgerCounters,
  type MarketBaseResourceLegacyV2ConfirmedCanary,
  type MarketBaseResourceQuotaReceipt,
  type MarketBaseResourceReceipt,
} from "@/runtime/marketBaseResourceLedger";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  buildMarketDirectContinuousPermit,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";

const ACCOUNT = "forst";
const V2_HEAD = canonicalStableHashV1("ledger-test:v2-head");
const V2_CHECKPOINT = canonicalStableHashV1("ledger-test:v2-checkpoint");
const MIGRATION_TICK = 50_000;

function digest(label: string): string {
  return canonicalStableHashV1(`ledger-test:${label}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lane(): MarketBaseDerivedLaneLifecycle {
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const rooms = reconcileMarketBaseSellerRooms({
    tick: 1_000,
    admissionPolicy: shared.roomAdmissionPolicy,
    observations: [
      {
        roomName: "E6N59",
        visible: true,
        controllerMy: true,
        controllerOwner: ACCOUNT,
        terminalId: "terminal-e6n59",
        terminalOwned: true,
        roomClass: "normal",
      },
    ],
  });
  if ("blockers" in rooms) {
    throw new Error(rooms.blockers.join(","));
  }
  const lanes = reconcileMarketBaseDerivedLanes({
    sharedPolicyFingerprint: shared.fingerprint,
    sellerRooms: rooms.sellerRooms,
  });
  const fresh = lanes.lanes?.find((candidate) => candidate.resource === "X");
  if (!lanes.ok || !fresh) {
    throw new Error(lanes.blockers?.join(",") ?? "missing X lane");
  }
  return {
    ...fresh,
    stage: "qualified",
    status: "suspended",
    shadowEvidence: {
      completeCycles: 100,
      lastCompleteTick: 1_000,
      evidenceDigest: digest("shadow:E6N59:X"),
    },
  };
}

function legacyV2Permit() {
  return buildMarketDirectContinuousPermit({
    epoch: 1,
    accountIdentity: ACCOUNT,
    sharedDirectFingerprint: digest("v2-shared-direct"),
    entryGrants: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
      entryId: entry.entryId,
      stage:
        entry.entryId === "base-x-e6n59-v1"
          ? ("continuous" as const)
          : ("shadow" as const),
      newDealGrant:
        entry.entryId === "base-x-e6n59-v1"
          ? ("enabled" as const)
          : ("suspended" as const),
      resourceFingerprint: entry.resourceFingerprint,
      lifecycleEvidenceDigest: digest(`v2-lifecycle:${entry.entryId}`),
    })),
    reviewedEvidence: [],
    previousPermitId: "",
    previousPermitHead: digest("v2-genesis"),
    previousLedgerHead: V2_HEAD,
    createdAt: 1_000,
    operatorAuthorizationFingerprint: digest("v2-operator"),
  });
}

function appendPermitOrThrow(
  chain: MarketBaseResourcePermitChainState,
  permit: ReturnType<typeof buildMarketBaseResourcePermit>,
  currentLane: MarketBaseDerivedLaneLifecycle,
  overrides: Partial<AppendMarketBaseResourcePermitInput> = {},
): MarketBaseResourcePermitChainState {
  const result = appendMarketBaseResourcePermit(chain, permit, {
    tick: permit.createdAt,
    currentShard: "shard1",
    currentLedgerHead: permit.previousLedgerHead,
    currentV2LedgerCheckpointHash: V2_CHECKPOINT,
    currentV2AttemptSeqHighWater: 6,
    currentV2OutcomeSeqHighWater: 6,
    currentDerivedLanes: [currentLane],
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment([currentLane]),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
    ...overrides,
  });
  if (result.status !== "appended") {
    throw new Error(
      `${result.status}:${
        "reason" in result ? result.reason : "unexpected-idempotent"
      }`,
    );
  }
  return result.state;
}

function permitChains(): {
  readonly first: MarketBaseResourcePermitChainState;
  readonly canary: MarketBaseResourcePermitChainState;
  readonly currentLane: MarketBaseDerivedLaneLifecycle;
} {
  const currentLane = lane();
  let chain = createMarketBaseResourcePermitChainState({
    legacyV2PermitRecords: [
      wrapAuthenticatedLegacyV2PermitRecord({
        rawRecord: legacyV2Permit(),
        authenticated: true,
      }),
    ],
  });
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const eventCutover = buildMarketBaseResourceV2EventCutoverCheckpoint({
    lastV2AttemptSeq: 6,
    lastV2OutcomeSeq: 6,
    v2ReceiptHeadHash: V2_HEAD,
    v2LedgerCheckpointHash: V2_CHECKPOINT,
  });
  const firstPermit = buildMarketBaseResourcePermit({
    epoch: 2,
    accountIdentity: ACCOUNT,
    sharedPolicy: shared,
    ratchetHighWater: buildMarketBaseResourceBootstrapRatchetHighWater(2_000),
    signedLaneGrants: [
      buildMarketBaseResourceSignedLaneGrant({
        lane: currentLane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    ],
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V2_HEAD,
    v2EventCutoverCheckpoint: eventCutover,
    legacyV2GrantSuspension: buildMarketBaseResourceLegacyV2GrantSuspension({
      previousPermitId: chain.currentPermitId,
      previousPermitHead: chain.permitChainHead,
      cutoverCheckpointHash: eventCutover.checkpointHash,
    }),
    createdAt: 2_000,
    operatorAuthorizationFingerprint: digest("operator:first"),
  });
  chain = appendPermitOrThrow(chain, firstPermit, currentLane);
  const first = chain;
  const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: currentLane,
    stage: "canary",
    newDealGrant: "enabled",
  });
  const canaryPermit = buildMarketBaseResourcePermit({
    epoch: 3,
    accountIdentity: ACCOUNT,
    sharedPolicy: shared,
    ratchetHighWater: firstPermit.ratchetHighWater,
    signedLaneGrants: [canaryGrant],
    reviewedEvidence: [
      {
        laneId: currentLane.laneId,
        kind: "shadow_qualification",
        evidenceKey: digest("qualification:E6N59:X"),
        digest: canaryGrant.lifecycleEvidenceDigest,
      },
    ],
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V2_HEAD,
    createdAt: 2_001,
    operatorAuthorizationFingerprint: digest("operator:canary"),
  });
  chain = appendPermitOrThrow(chain, canaryPermit, currentLane);
  return { first, canary: chain, currentLane };
}

function incarnatedXLanes(
  count: number,
): readonly MarketBaseDerivedLaneLifecycle[] {
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const result: MarketBaseDerivedLaneLifecycle[] = [];
  for (let index = 0; index < count; index += 1) {
    const rooms = reconcileMarketBaseSellerRooms({
      tick: 10_000 + index,
      admissionPolicy: shared.roomAdmissionPolicy,
      observations: [
        {
          roomName: "E6N59",
          visible: true,
          controllerMy: true,
          controllerOwner: ACCOUNT,
          terminalId: `terminal-e6n59-${index}`,
          terminalOwned: true,
          roomClass: "normal",
        },
      ],
    });
    if ("blockers" in rooms) {
      throw new Error(rooms.blockers.join(","));
    }
    const lanes = reconcileMarketBaseDerivedLanes({
      sharedPolicyFingerprint: shared.fingerprint,
      sellerRooms: rooms.sellerRooms,
    });
    const lane = lanes.lanes?.find((candidate) => candidate.resource === "X");
    if (!lanes.ok || !lane) {
      throw new Error(lanes.blockers?.join(",") ?? "missing incarnated X lane");
    }
    result.push({
      ...lane,
      stage: "qualified",
      status: "suspended",
      shadowEvidence: {
        completeCycles: 100,
        lastCompleteTick: 10_000 + index,
        evidenceDigest: digest(`shadow:E6N59:X:${index}`),
      },
    });
  }
  return result;
}

function replacementXLaneFromOwnedTerminalIncarnation(): {
  readonly lane: MarketBaseDerivedLaneLifecycle;
  readonly incarnation: number;
  readonly rosterFingerprint: string;
  readonly laneSetFingerprint: string;
} {
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const observation = (terminalId: string) => [
    {
      roomName: "E6N59",
      visible: true,
      controllerMy: true,
      controllerOwner: ACCOUNT,
      terminalId,
      terminalOwned: true,
      roomClass: "normal" as const,
    },
  ];
  const initial = reconcileMarketBaseSellerRooms({
    tick: 1_000,
    admissionPolicy: shared.roomAdmissionPolicy,
    observations: observation("terminal-e6n59"),
  });
  if ("blockers" in initial) {
    throw new Error(initial.blockers.join(","));
  }
  const replacement = reconcileMarketBaseSellerRooms({
    tick: 1_001,
    admissionPolicy: shared.roomAdmissionPolicy,
    observations: observation("terminal-e6n59-replacement"),
    previous: initial.state,
    expectedPreviousCheckpointCommitment: initial.state.checkpointCommitment,
  });
  if ("blockers" in replacement) {
    throw new Error(replacement.blockers.join(","));
  }
  const lanes = reconcileMarketBaseDerivedLanes({
    sharedPolicyFingerprint: shared.fingerprint,
    sellerRooms: replacement.sellerRooms,
  });
  const lane = lanes.lanes?.find((candidate) => candidate.resource === "X");
  const room = replacement.sellerRooms[0];
  if (!lanes.ok || !lane || !room || !lanes.laneSetFingerprint) {
    throw new Error(lanes.blockers?.join(",") ?? "missing replacement X lane");
  }
  return {
    lane: {
      ...lane,
      stage: "qualified",
      status: "suspended",
      shadowEvidence: {
        completeCycles: 100,
        lastCompleteTick: 1_001,
        evidenceDigest: digest("shadow:E6N59:X:replacement"),
      },
    },
    incarnation: room.incarnation,
    rosterFingerprint: replacement.state.checkpointCommitment,
    laneSetFingerprint: lanes.laneSetFingerprint,
  };
}

function retireCanaryAndAuthorizeNext(input: {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
  readonly oldLane: MarketBaseDerivedLaneLifecycle;
  readonly nextLane: MarketBaseDerivedLaneLifecycle;
  readonly tick: number;
}): {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
} {
  const current =
    input.chain.retainedPermits[input.chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("missing current canary permit");
  }
  const oldGrant = current.signedLaneGrants.find(
    (grant) => grant.laneId === input.oldLane.laneId,
  );
  if (!oldGrant) throw new Error("missing old canary grant");
  const tombstoneGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.oldLane,
    status: "tombstoned",
    stage: oldGrant.stage,
    newDealGrant: "suspended",
    lifecycleEvidenceDigest: oldGrant.lifecycleEvidenceDigest,
    reviewDigest: oldGrant.reviewDigest,
  });
  const shadowGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.nextLane,
    stage: "shadow",
    newDealGrant: "suspended",
  });
  const tombstonePermit = buildMarketBaseResourcePermit({
    epoch: input.chain.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: current.sharedPolicy,
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: [tombstoneGrant, shadowGrant],
    previousPermitId: input.chain.currentPermitId,
    previousPermitHead: input.chain.permitChainHead,
    previousLedgerHead: input.state.receiptHeadHash,
    createdAt: input.tick,
    operatorAuthorizationFingerprint: digest(
      `operator:tombstone:${input.oldLane.laneId}`,
    ),
  });
  const tombstoned = appendPermitOrThrow(
    input.chain,
    tombstonePermit,
    input.nextLane,
    {
      currentDerivedLanes: [input.nextLane],
      currentLifecycleCheckpointCommitment:
        marketBaseDerivedLaneLifecycleCheckpointCommitment([input.nextLane]),
      receiptPermitReferences:
        marketBaseResourceRetainedReceiptPermitReferences(
          input.state,
          input.chain,
        ),
    },
  );
  const tombstonedState = rebindMarketBaseResourceLedgerPermitAnchor(
    input.state,
    tombstoned,
  );
  const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.nextLane,
    stage: "canary",
    newDealGrant: "enabled",
  });
  const canaryPermit = buildMarketBaseResourcePermit({
    epoch: tombstoned.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: current.sharedPolicy,
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: [canaryGrant],
    reviewedEvidence: [
      {
        laneId: input.nextLane.laneId,
        kind: "shadow_qualification",
        evidenceKey: digest(`qualification:${input.nextLane.laneId}`),
        digest: canaryGrant.lifecycleEvidenceDigest,
      },
    ],
    previousPermitId: tombstoned.currentPermitId,
    previousPermitHead: tombstoned.permitChainHead,
    previousLedgerHead: tombstonedState.receiptHeadHash,
    createdAt: input.tick + 1,
    operatorAuthorizationFingerprint: digest(
      `operator:canary:${input.nextLane.laneId}`,
    ),
  });
  const chain = appendPermitOrThrow(tombstoned, canaryPermit, input.nextLane, {
    currentLedgerCheckpointHash: tombstonedState.checkpoint.checkpointHash,
    currentLedgerPermitAnchorHash: tombstonedState.permitAnchor.anchorHash,
    receiptPermitReferences: marketBaseResourceRetainedReceiptPermitReferences(
      tombstonedState,
      tombstoned,
    ),
  });
  return {
    chain,
    state: rebindMarketBaseResourceLedgerPermitAnchor(tombstonedState, chain),
  };
}

function replaceLaneScopeThroughCanonicalTombstones(input: {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
  readonly priorLanes: readonly MarketBaseDerivedLaneLifecycle[];
  readonly nextLanes: readonly MarketBaseDerivedLaneLifecycle[];
  readonly tick: number;
}): {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
} {
  const current =
    input.chain.retainedPermits[input.chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("missing current v3 permit");
  }
  const laneById = new Map(input.priorLanes.map((lane) => [lane.laneId, lane]));
  const tombstones = current.signedLaneGrants
    .filter((grant) => grant.status === "active")
    .map((grant) =>
      buildMarketBaseResourceSignedLaneGrant({
        lane: laneById.get(grant.laneId)!,
        status: "tombstoned",
        stage: grant.stage,
        newDealGrant: "suspended",
        lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
        reviewDigest: grant.reviewDigest,
      }),
    );
  const nextGrants = input.nextLanes.map((lane) =>
    buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "shadow",
      newDealGrant: "suspended",
    }),
  );
  const transitionPermit = buildMarketBaseResourcePermit({
    epoch: input.chain.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: current.sharedPolicy,
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: [...nextGrants, ...tombstones],
    previousPermitId: input.chain.currentPermitId,
    previousPermitHead: input.chain.permitChainHead,
    previousLedgerHead: input.state.receiptHeadHash,
    createdAt: input.tick,
    operatorAuthorizationFingerprint: digest(`operator:scope:${input.tick}`),
  });
  const transitioning = appendPermitOrThrow(
    input.chain,
    transitionPermit,
    input.nextLanes[0],
    {
      currentDerivedLanes: input.nextLanes,
      currentLifecycleCheckpointCommitment:
        marketBaseDerivedLaneLifecycleCheckpointCommitment(input.nextLanes),
      receiptPermitReferences:
        marketBaseResourceRetainedReceiptPermitReferences(
          input.state,
          input.chain,
        ),
    },
  );
  const transitioningState = rebindMarketBaseResourceLedgerPermitAnchor(
    input.state,
    transitioning,
  );
  const dischargePermit = buildMarketBaseResourcePermit({
    epoch: transitioning.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: current.sharedPolicy,
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: nextGrants,
    previousPermitId: transitioning.currentPermitId,
    previousPermitHead: transitioning.permitChainHead,
    previousLedgerHead: transitioningState.receiptHeadHash,
    createdAt: input.tick + 1,
    operatorAuthorizationFingerprint: digest(
      `operator:discharge:${input.tick}`,
    ),
  });
  const chain = appendPermitOrThrow(
    transitioning,
    dischargePermit,
    input.nextLanes[0],
    {
      currentDerivedLanes: input.nextLanes,
      currentLifecycleCheckpointCommitment:
        marketBaseDerivedLaneLifecycleCheckpointCommitment(input.nextLanes),
      receiptPermitReferences:
        marketBaseResourceRetainedReceiptPermitReferences(
          transitioningState,
          transitioning,
        ),
    },
  );
  return {
    chain,
    state: rebindMarketBaseResourceLedgerPermitAnchor(
      transitioningState,
      chain,
    ),
  };
}

function legacyReceipt(attemptSeq: number): MarketBaseResourceQuotaReceipt {
  const transactionTime = 49_800 + attemptSeq;
  return {
    sourceVersion: 2,
    attemptSeq,
    evidenceKey: digest(`legacy-evidence:${attemptSeq}`),
    status: "confirmed",
    resource: "X",
    sellerRoom: "E6N59",
    plannedAmount: 1_000,
    actualAmount: 1_000,
    resolvedAt: transactionTime + 1,
    retentionTick: transactionTime,
    transactionTime,
  };
}

function legacyReceipts(): readonly MarketBaseResourceQuotaReceipt[] {
  return Array.from({ length: 6 }, (_, index) => legacyReceipt(index + 1));
}

function lifetime(): MarketBaseResourceLedgerCounters {
  return {
    global: { count: 6, amount: 6_000 },
    resources: { X: { count: 6, amount: 6_000 } },
    rooms: { E6N59: { count: 6, amount: 6_000 } },
    lanes: { "X:E6N59": { count: 6, amount: 6_000 } },
  };
}

function lifetimeForReceipts(
  receipts: readonly MarketBaseResourceQuotaReceipt[],
): MarketBaseResourceLedgerCounters {
  const counters: {
    global: { count: number; amount: number };
    resources: Record<string, { count: number; amount: number }>;
    rooms: Record<string, { count: number; amount: number }>;
    lanes: Record<string, { count: number; amount: number }>;
  } = {
    global: { count: 0, amount: 0 },
    resources: {},
    rooms: {},
    lanes: {},
  };
  for (const receipt of receipts) {
    if (receipt.status !== "confirmed") continue;
    counters.global.count += 1;
    counters.global.amount += receipt.actualAmount;
    for (const [map, key] of [
      [counters.resources, receipt.resource],
      [counters.rooms, receipt.sellerRoom],
      [counters.lanes, `${receipt.resource}:${receipt.sellerRoom}`],
    ] as const) {
      const current = map[key] ?? { count: 0, amount: 0 };
      map[key] = {
        count: current.count + 1,
        amount: current.amount + receipt.actualAmount,
      };
    }
  }
  return counters;
}

function legacyConfirmedCanaries(): Readonly<
  Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
> {
  return {
    "base-x-e6n59-v1": {
      entryId: "base-x-e6n59-v1",
      attemptSeq: 1,
      executionPolicy: "legacy_canary_seed",
      evidenceKey: digest("legacy-evidence:1"),
      receiptEventHash: digest("legacy-seed-event"),
      reviewedEvidenceDigest: digest("legacy-seed-review"),
    },
  };
}

function migrationBasis(
  chain: MarketBaseResourcePermitChainState,
  overrides: {
    readonly prunedThrough?: number;
    readonly receipts?: readonly MarketBaseResourceQuotaReceipt[];
    readonly lifetimeConfirmed?: MarketBaseResourceLedgerCounters;
  } = {},
) {
  return buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis({
    tick: MIGRATION_TICK,
    cutoverCheckpoint: chain.v2EventCutoverCheckpoint!,
    v2PrunedThroughAttemptSeq: overrides.prunedThrough ?? 0,
    legacyQuotaReceipts: overrides.receipts ?? legacyReceipts(),
    legacyV2ConfirmedCanaries: legacyConfirmedCanaries(),
    lifetimeConfirmed: overrides.lifetimeConfirmed ?? lifetime(),
    retryNotBefore: 0,
    authenticated: true,
  });
}

function ledger(
  chain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedger {
  return createMarketBaseResourceLedger({
    tick: MIGRATION_TICK,
    permitChain: chain,
    migrationBasis: migrationBasis(chain),
  });
}

function prepareInput(
  chain: MarketBaseResourcePermitChainState,
  currentLane: MarketBaseDerivedLaneLifecycle,
  tick: number,
) {
  const current = chain.retainedPermits[chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("missing current V3 permit");
  }
  const dynamicScope = {
    admissionPolicyFingerprint:
      current.sharedPolicy.roomAdmissionPolicy.fingerprint,
    rosterFingerprint: digest("roster"),
    laneSetFingerprint: digest("lane-set"),
    laneId: currentLane.laneId,
    roomInstanceId: currentLane.roomInstanceId,
  };
  const fullRead = digest(`full-read:${tick}`);
  return {
    tick,
    resourceLimit: 8_000,
    permitChain: chain,
    executionPolicy: "canary" as const,
    historicalPermit: buildMarketBaseResourceHistoricalPermitRef(current),
    historicalLane: {
      laneId: currentLane.laneId,
      roomInstanceId: currentLane.roomInstanceId,
      sellerRoom: currentLane.sellerRoomName,
      resource: currentLane.resource,
      resourcePolicyId: currentLane.resourcePolicyId,
      resourcePolicyFingerprint: currentLane.resourcePolicyFingerprint,
      roomFingerprint: currentLane.roomFingerprint,
      sharedPolicyFingerprint: currentLane.sharedPolicyFingerprint,
    },
    firstDynamicScope: dynamicScope,
    secondDynamicScope: clone(dynamicScope),
    fullReads: {
      firstReadFingerprint: fullRead,
      secondReadFingerprint: fullRead,
      bookFingerprint: digest(`book:${tick}`),
      protectionFingerprint: digest(`protection:${tick}`),
      energyReadinessFingerprint: digest(`energy:${tick}`),
      arbiterFingerprint: digest(`arbiter:${tick}`),
    },
    executionEvidence: {
      observedOrderPriceMilli: 700_000,
      observedOrderAmount: 10_000,
      effectiveEnergyShadowPriceMilli: 100,
      effectiveNetFloorMilli: 600_000,
      terminalResourceBefore: 101_000,
      terminalEnergyBefore: 30_000,
      terminalCooldownBefore: 0,
      creditsBefore: 1_000_000,
      outgoingTransactionKeysBefore: [],
      outgoingWindowObservedAt: tick,
      outgoingWindowCoversAttemptAt: true as const,
    },
    orderId: "0123456789abcdef01234567",
    orderRoom: "W9N9",
    plannedTransactionEnergy: 400,
    plannedNetCreditsMilli: 699_960_000,
    worstUnitNetCreditsMilli: 699_900,
    evidenceKeyHint: digest(`evidence-hint:${tick}`),
  };
}

function prepareContinuousInput(
  chain: MarketBaseResourcePermitChainState,
  currentLane: MarketBaseDerivedLaneLifecycle,
  tick: number,
) {
  return {
    ...prepareInput(chain, currentLane, tick),
    executionPolicy: "continuous" as const,
  };
}

function notFilledOutcomeFor(state: MarketBaseResourceLedger, tick: number) {
  const pending = state.pending;
  if (!pending) {
    throw new Error("missing pending for outcome");
  }
  return sealMarketBaseResourceOutcome({
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
    attemptSeq: pending.attemptSeq,
    status: "not_filled",
    permitId: pending.historicalPermit.permitId,
    permitEpoch: pending.historicalPermit.permitEpoch,
    laneId: pending.historicalLane.laneId,
    sellerRoom: pending.historicalLane.sellerRoom,
    resource: pending.historicalLane.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: 1_000,
    resolvedAt: tick,
    evidenceKey: digest(`runtime-not-filled:${pending.attemptSeq}`),
    actualAmount: 0,
    reason: "test_not_filled",
    pendingEvidenceHash: pending.frozenEvidenceHash,
  });
}

function settlePreparedCanary(
  prepared: MarketBaseResourceLedgerOperation,
  chain: MarketBaseResourcePermitChainState,
  status: "failed" | "not_filled",
  tick: number,
): MarketBaseResourceLedger {
  const pending = prepared.state.pending;
  if (!pending) {
    throw new Error("missing prepared canary");
  }
  const outcome = sealMarketBaseResourceOutcome({
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
    attemptSeq: pending.attemptSeq,
    status,
    permitId: pending.historicalPermit.permitId,
    permitEpoch: pending.historicalPermit.permitEpoch,
    laneId: pending.historicalLane.laneId,
    sellerRoom: pending.historicalLane.sellerRoom,
    resource: pending.historicalLane.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: 1_000,
    resolvedAt: tick,
    evidenceKey: digest(`${status}:${pending.attemptSeq}`),
    actualAmount: 0,
    reason: `test_${status}`,
    pendingEvidenceHash: pending.frozenEvidenceHash,
  });
  let operation = recordMarketBaseResourceOutcome(
    prepared.state,
    outcome,
    chain,
  );
  expect(operation.action).toBe("outcome_written");
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  expect(operation.action).toBe("receipt_written");
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  expect(operation.action).toBe("processed_key_written");
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  expect(operation.action).toBe("pending_deleted");
  return operation.state;
}

function settleConfirmedCanary(
  prepared: MarketBaseResourceLedgerOperation,
  chain: MarketBaseResourcePermitChainState,
  tick: number,
): MarketBaseResourceLedger {
  const pending = prepared.state.pending;
  if (!pending) {
    throw new Error("missing prepared canary");
  }
  const outcome = sealMarketBaseResourceOutcome({
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
    attemptSeq: pending.attemptSeq,
    status: "confirmed",
    permitId: pending.historicalPermit.permitId,
    permitEpoch: pending.historicalPermit.permitEpoch,
    laneId: pending.historicalLane.laneId,
    sellerRoom: pending.historicalLane.sellerRoom,
    resource: pending.historicalLane.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: 1_000,
    resolvedAt: tick,
    evidenceKey: digest(`confirmed:${pending.attemptSeq}`),
    actualAmount: 400,
    transactionId: `transaction-${pending.attemptSeq}`,
    transactionTime: tick,
    actualTransactionEnergy: 160,
    actualNetCreditsMilli: 279_960_000,
    pendingEvidenceHash: pending.frozenEvidenceHash,
  });
  let operation = recordMarketBaseResourceOutcome(
    prepared.state,
    outcome,
    chain,
  );
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  if (operation.action !== "pending_deleted") {
    throw new Error(`canary settlement failed:${operation.blockerCode}`);
  }
  return operation.state;
}

function promoteConfirmedCanaryToContinuous(input: {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
  readonly currentLane: MarketBaseDerivedLaneLifecycle;
  readonly tick: number;
}): {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
} {
  const current =
    input.chain.retainedPermits[input.chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("missing canary permit");
  }
  const proof = buildMarketBaseResourceConfirmedCanaryProof(
    input.state,
    input.currentLane.laneId,
    input.chain,
  );
  const operatorReviewSnapshotDigest = digest(
    `operator-review:${proof.attemptSeq}`,
  );
  const continuousGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.currentLane,
    stage: "continuous",
    newDealGrant: "enabled",
    reviewDigest: operatorReviewSnapshotDigest,
  });
  const continuousPermit = buildMarketBaseResourcePermit({
    epoch: input.chain.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: createMarketBaseSharedPolicy(ACCOUNT),
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: [continuousGrant],
    reviewedEvidence: [
      {
        laneId: input.currentLane.laneId,
        kind: "continuous_review",
        evidenceKey: proof.evidenceKey,
        digest: operatorReviewSnapshotDigest,
        confirmedCanaryReviewDigest: proof.reviewDigest,
        operatorReviewSnapshotDigest,
        permitId: proof.permitId,
        attemptSeq: proof.attemptSeq,
        receiptEventHash: proof.receiptEventHash,
        ledgerCheckpointHash: proof.ledgerCheckpointHash,
        ledgerReceiptHeadHash: proof.ledgerReceiptHeadHash,
        ledgerPermitAnchorHash: proof.ledgerPermitAnchorHash,
      },
    ],
    previousPermitId: input.chain.currentPermitId,
    previousPermitHead: input.chain.permitChainHead,
    previousLedgerHead: input.state.receiptHeadHash,
    createdAt: input.tick,
    operatorAuthorizationFingerprint: digest(
      `operator:continuous:${proof.attemptSeq}`,
    ),
  });
  const chain = appendPermitOrThrow(
    input.chain,
    continuousPermit,
    input.currentLane,
    {
      currentLedgerCheckpointHash: input.state.checkpoint.checkpointHash,
      currentLedgerPermitAnchorHash: input.state.permitAnchor.anchorHash,
      confirmedCanaryProofs: [proof],
      receiptPermitReferences:
        marketBaseResourceRetainedReceiptPermitReferences(
          input.state,
          input.chain,
        ),
      activeReviewPermitReferences: [
        {
          sourceId: input.currentLane.laneId,
          permitId: proof.permitId,
        },
      ],
    },
  );
  return {
    chain,
    state: rebindMarketBaseResourceLedgerPermitAnchor(input.state, chain),
  };
}

function extendNotFilledReceiptChain(input: {
  readonly first: MarketBaseResourceReceipt;
  readonly previousHead: string;
  readonly firstAttemptSeq: number;
  readonly lastAttemptSeq: number;
  readonly firstAttemptAt: number;
}): readonly MarketBaseResourceReceipt[] {
  const receipts: MarketBaseResourceReceipt[] = [];
  let previousHead = input.previousHead;
  for (
    let attemptSeq = input.firstAttemptSeq;
    attemptSeq <= input.lastAttemptSeq;
    attemptSeq += 1
  ) {
    const attemptAt =
      input.firstAttemptAt + (attemptSeq - input.firstAttemptSeq) * 101;
    const {
      prevHash: _templatePrevHash,
      eventHash: _templateEventHash,
      headHash: _templateHeadHash,
      outcomeEventHash: _templateOutcomeEventHash,
      ...templatePayload
    } = input.first;
    const payload = {
      ...templatePayload,
      attemptSeq,
      attemptAt,
      resolvedAt: attemptAt,
      retentionTick: attemptAt,
      evidenceKey: digest(`synthetic-not-filled:${attemptSeq}`),
      pendingEvidenceHash: digest(`synthetic-pending:${attemptSeq}`),
    };
    const {
      executionPolicy: _executionPolicy,
      retentionTick: _retentionTick,
      hashRevision: _receiptHashRevision,
      ...outcomePayload
    } = payload;
    const outcomeEventHash = sealMarketBaseResourceOutcome({
      ...outcomePayload,
      hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
    }).outcomeEventHash;
    const receiptPayload = {
      ...payload,
      outcomeEventHash,
    };
    const eventHash = canonicalStableHashV1({
      domain: "market-base-resource:receipt-v1",
      receipt: receiptPayload,
    });
    const headHash = canonicalStableHashV1({
      domain: "market-base-resource:receipt-head-v1",
      eventHash,
      prevHash: previousHead,
    });
    receipts.push({
      ...receiptPayload,
      prevHash: previousHead,
      eventHash,
      headHash,
    });
    previousHead = headHash;
  }
  return receipts;
}

function outcomeFromReceipt(
  receipt: MarketBaseResourceReceipt,
): ReturnType<typeof sealMarketBaseResourceOutcome> {
  const {
    executionPolicy: _executionPolicy,
    retentionTick: _retentionTick,
    prevHash: _prevHash,
    eventHash: _eventHash,
    headHash: _headHash,
    outcomeEventHash: _outcomeEventHash,
    hashRevision: _receiptHashRevision,
    ...payload
  } = receipt;
  return sealMarketBaseResourceOutcome({
    ...payload,
    hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
  });
}

describe("marketBaseResourceLedger", () => {
  test("迁移原样继承 seq/head/lifetime/cooldown 与 legacy canary high-water", () => {
    const { canary } = permitChains();
    const state = ledger(canary);
    expect(state.finalizedAttemptSeq).toBe(6);
    expect(state.nextAttemptSeq).toBe(7);
    expect(state.receiptHeadHash).toBe(V2_HEAD);
    expect(state.confirmedCooldownNotBefore).toBe(50_806);
    expect(state.lifetimeConfirmed).toEqual(lifetime());
    expect(state.legacyV2ConfirmedCanaries).toEqual(legacyConfirmedCanaries());
    expect(state.checkpoint.legacyV2ConfirmedCanaryCommitment).toBeTruthy();
    expect(
      validateMarketBaseResourceLedger(state, MIGRATION_TICK, canary),
    ).toEqual({ ok: true, prefix: "idle" });
  });

  test("缺 receipt、伪 lifetime 或 pruned V2 历史一律拒绝迁移", () => {
    const { canary } = permitChains();
    expect(() =>
      migrationBasis(canary, {
        receipts: legacyReceipts().slice(1),
      }),
    ).toThrow("invalid authenticated v2 ledger migration basis");
    expect(() =>
      migrationBasis(canary, {
        lifetimeConfirmed: {
          ...lifetime(),
          global: { count: 0, amount: 0 },
        },
      }),
    ).toThrow("invalid authenticated v2 ledger migration basis");
    expect(() => migrationBasis(canary, { prunedThrough: 1 })).toThrow(
      "v2_migration_room_lane_history_incomplete",
    );
  });

  test("全局 confirmed cooldown 从 legacy receipts 自动派生", () => {
    const { canary, currentLane } = permitChains();
    const distributed = legacyReceipts().map((receipt, index) => ({
      ...receipt,
      sellerRoom: index === 0 ? "E6N59" : `E${index}N58`,
    }));
    const state = createMarketBaseResourceLedger({
      tick: MIGRATION_TICK,
      permitChain: canary,
      migrationBasis: migrationBasis(canary, {
        receipts: distributed,
        lifetimeConfirmed: lifetimeForReceipts(distributed),
      }),
    });
    const latest = 49_806;
    const blocked = prepareMarketBaseResourceAttempt(
      state,
      prepareInput(canary, currentLane, MIGRATION_TICK),
    );
    expect(blocked).toMatchObject({
      ok: false,
      blockerCode: "quota_or_global_cooldown",
    });
    const afterCooldown = prepareMarketBaseResourceAttempt(
      state,
      prepareInput(
        canary,
        currentLane,
        latest + MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
      ),
    );
    expect(afterCooldown.action).toBe("prepared");
  });

  test("WAL 分步收敛并产生只能由已验证账本导出的 canary proof/ref", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const prepared = prepareMarketBaseResourceAttempt(
      ledger(canary),
      prepareInput(canary, currentLane, tick),
    );
    expect(prepared.action).toBe("prepared");
    expect(prepared.state.pending).toMatchObject({
      schemaVersion: 3,
      hashRevision: MARKET_BASE_RESOURCE_PENDING_HASH_REVISION,
      attemptSeq: 7,
    });
    const pending = prepared.state.pending!;
    const outcome = sealMarketBaseResourceOutcome({
      schemaVersion: 3,
      hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
      attemptSeq: pending.attemptSeq,
      status: "confirmed",
      permitId: pending.historicalPermit.permitId,
      permitEpoch: pending.historicalPermit.permitEpoch,
      laneId: pending.historicalLane.laneId,
      sellerRoom: pending.historicalLane.sellerRoom,
      resource: pending.historicalLane.resource,
      orderId: pending.orderId,
      orderRoom: pending.orderRoom,
      attemptAt: pending.attemptAt,
      plannedAmount: 1_000,
      resolvedAt: tick,
      evidenceKey: digest("confirmed:7"),
      actualAmount: 400,
      transactionId: "transaction-7",
      transactionTime: tick,
      actualTransactionEnergy: 160,
      actualNetCreditsMilli: 279_960_000,
      pendingEvidenceHash: pending.frozenEvidenceHash,
    });
    const written = recordMarketBaseResourceOutcome(
      prepared.state,
      outcome,
      canary,
    );
    expect(written.action).toBe("outcome_written");
    expect(
      recordMarketBaseResourceOutcome(written.state, outcome, canary).action,
    ).toBe("outcome_idempotent");
    const receipt = advanceMarketBaseResourceWal(written.state, canary);
    expect(receipt.action).toBe("receipt_written");
    const processed = advanceMarketBaseResourceWal(receipt.state, canary);
    expect(processed.action).toBe("processed_key_written");
    const settled = advanceMarketBaseResourceWal(processed.state, canary);
    expect(settled.action).toBe("pending_deleted");
    expect(
      marketBaseResourceConfirmedCanaryFor(
        settled.state,
        currentLane.laneId,
        canary,
      ),
    ).toMatchObject({
      attemptSeq: 7,
      transactionTime: tick,
      actualAmount: 400,
      actualTransactionEnergy: 160,
      actualNetCreditsMilli: 279_960_000,
    });

    const proof = buildMarketBaseResourceConfirmedCanaryProof(
      settled.state,
      currentLane.laneId,
      canary,
    );
    expect(proof).toMatchObject({
      transactionTime: tick,
      actualAmount: 400,
      actualTransactionEnergy: 160,
      actualNetCreditsMilli: 279_960_000,
      ledgerCheckpointHash: settled.state.checkpoint.checkpointHash,
      ledgerReceiptHeadHash: settled.state.receiptHeadHash,
      ledgerPermitAnchorHash: settled.state.permitAnchor.anchorHash,
    });
    expect(
      marketBaseResourceCanaryReviewFactsFor(
        settled.state,
        currentLane.laneId,
        canary,
      ),
    ).toMatchObject({
      laneId: currentLane.laneId,
      retired: false,
      confirmed: {
        transactionTime: tick,
        actualAmount: 400,
        actualTransactionEnergy: 160,
        actualNetCreditsMilli: 279_960_000,
      },
    });
    expect(
      marketBaseResourceRetainedReceiptPermitReferences(settled.state, canary),
    ).toEqual([
      {
        sourceId: settled.state.receipts[0].eventHash,
        permitId: settled.state.receipts[0].permitId,
      },
    ]);
  });

  test("Canary prepare 当场消费 one-shot，uncertain pending 不能二次授权", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const prepared = prepareMarketBaseResourceAttempt(
      ledger(canary),
      prepareInput(canary, currentLane, tick),
    );
    expect(prepared.action).toBe("prepared");
    expect(
      inspectMarketBaseResourceCanaryGrantAvailability(
        prepared.state,
        canary,
        currentLane.laneId,
      ),
    ).toMatchObject({
      ok: true,
      available: false,
      reason: "canary_grant_already_attempted",
      attempt: {
        attemptSeq: 7,
        permitId: canary.currentPermitId,
        permitEpoch: canary.currentPermitEpoch,
      },
    });
    expect(
      validateMarketBaseResourceLedger(prepared.state, tick, canary),
    ).toEqual({ ok: true, prefix: "waiting_outcome" });

    const runtimeAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      prepared.state,
      canary,
    );
    const pendingBitFlip = clone(prepared.state);
    (
      pendingBitFlip.pending as unknown as {
        frozenEvidenceHash: string;
      }
    ).frozenEvidenceHash = digest("pending-bit-flip");
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        pendingBitFlip,
        canary,
        runtimeAnchor,
        tick,
      ).ok,
    ).toBe(false);
  });

  test("V2 迁移后的 V3 pending 冻结历史 scope，owned terminal incarnation 变化后仍按旧 WAL 收敛再授权新 lane", () => {
    const { canary, currentLane } = permitChains();
    const replacement = replacementXLaneFromOwnedTerminalIncarnation();
    expect(replacement.incarnation).toBe(2);
    expect(replacement.lane.laneId).not.toBe(currentLane.laneId);
    expect(replacement.lane.roomInstanceId).not.toBe(
      currentLane.roomInstanceId,
    );
    const tick = 80_000;
    const prepared = prepareMarketBaseResourceAttempt(
      ledger(canary),
      prepareInput(canary, currentLane, tick),
    );
    expect(prepared.action).toBe("prepared");
    const frozenScope = clone(prepared.state.pending!.dynamicScope);
    const changedScopeInput = prepareInput(canary, currentLane, tick + 1);
    const changedScope = {
      ...changedScopeInput.firstDynamicScope,
      rosterFingerprint: replacement.rosterFingerprint,
      laneSetFingerprint: replacement.laneSetFingerprint,
      laneId: replacement.lane.laneId,
      roomInstanceId: replacement.lane.roomInstanceId,
    };
    const changedFullRead = digest("changed-full-read-after-pending");
    const secondPrepare = prepareMarketBaseResourceAttempt(prepared.state, {
      ...changedScopeInput,
      firstDynamicScope: changedScope,
      secondDynamicScope: clone(changedScope),
      fullReads: {
        ...changedScopeInput.fullReads,
        firstReadFingerprint: changedFullRead,
        secondReadFingerprint: changedFullRead,
      },
    });
    expect(secondPrepare).toMatchObject({
      action: "blocked",
      blockerCode: "single_pending_already_active",
    });
    expect(prepared.state.pending!.dynamicScope).toEqual(frozenScope);
    expect(prepared.state.pending!.historicalLane).toMatchObject({
      laneId: currentLane.laneId,
      roomInstanceId: currentLane.roomInstanceId,
    });

    const settled = settlePreparedCanary(
      prepared,
      canary,
      "not_filled",
      tick + 1,
    );
    expect(settled.pending).toBeUndefined();
    expect(settled.terminalSlotReservation).toBeUndefined();
    expect(settled.legacyQuotaReceipts).toHaveLength(0);
    expect(settled.checkpoint.prunedThroughAttemptSeq).toBe(6);
    expect(settled.lifetimeConfirmed.global).toEqual({
      count: 6,
      amount: 6_000,
    });
    expect(settled.receipts[0]).toMatchObject({
      attemptSeq: 7,
      permitId: canary.currentPermitId,
    });
    expect(validateMarketBaseResourceLedger(settled, tick + 1, canary)).toEqual(
      { ok: true, prefix: "idle" },
    );
    const recovered = retireCanaryAndAuthorizeNext({
      state: settled,
      chain: canary,
      oldLane: currentLane,
      nextLane: replacement.lane,
      tick: tick + 2,
    });
    expect(
      validateMarketBaseResourceLedger(
        recovered.state,
        tick + 4,
        recovered.chain,
      ),
    ).toEqual({ ok: true, prefix: "idle" });
    const recoveredCurrent =
      recovered.chain.retainedPermits[
        recovered.chain.retainedPermits.length - 1
      ];
    expect(recoveredCurrent?.schemaVersion).toBe(3);
    expect(
      recoveredCurrent?.schemaVersion === 3
        ? recoveredCurrent.signedLaneGrants.find(
            (grant) => grant.laneId === replacement.lane.laneId,
          )
        : undefined,
    ).toMatchObject({
      stage: "canary",
      newDealGrant: "enabled",
    });
  });

  test("historical permit prefix binding 损坏在 prepare 与 runtime anchor 两层均 fail closed", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const input = prepareInput(canary, currentLane, tick);
    const badInput = {
      ...input,
      historicalPermit: {
        ...input.historicalPermit,
        prefixBindingHash: digest("damaged-input-prefix-binding"),
      },
    };
    expect(
      prepareMarketBaseResourceAttempt(ledger(canary), badInput),
    ).toMatchObject({
      action: "blocked",
      blockerCode: "historical_permit_reference_mismatch",
    });

    const prepared = prepareMarketBaseResourceAttempt(
      ledger(canary),
      input,
    ).state;
    const anchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      prepared,
      canary,
    );
    const forged = clone(prepared);
    if (!forged.pending) throw new Error("missing pending");
    (
      forged.pending.historicalPermit as unknown as {
        prefixBindingHash: string;
      }
    ).prefixBindingHash = digest("damaged-memory-prefix-binding");
    const { frozenEvidenceHash: _oldHash, ...payload } = forged.pending;
    (
      forged.pending as unknown as {
        frozenEvidenceHash: string;
      }
    ).frozenEvidenceHash = canonicalStableHashV1({
      domain: "market-base-resource:pending-v1",
      payload,
    });
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        forged,
        canary,
        anchor,
        tick,
      ).ok,
    ).toBe(false);
  });

  test("runtime context 单次消费并原子推进 WAL state+anchor", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const initial = ledger(canary);
    const initialAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      initial,
      canary,
    );
    const mutableInitial = clone(initial);
    const mutableCanary = clone(canary);
    const mutableAnchor = clone(initialAnchor);
    Object.freeze(mutableInitial);
    Object.freeze(mutableCanary);
    Object.freeze(mutableAnchor);
    const initialContext = createMarketBaseResourceLedgerRuntimeContext({
      state: mutableInitial,
      permitChain: mutableCanary,
      anchor: mutableAnchor,
      tick,
    });
    if ("reason" in initialContext) throw new Error(initialContext.reason);
    expect(() => {
      (
        mutableInitial as unknown as {
          receiptHeadHash: string;
        }
      ).receiptHeadHash = digest("post-context-ledger-bitflip");
    }).toThrow(TypeError);
    expect(() => {
      (
        mutableCanary as unknown as {
          currentPermitId: string;
        }
      ).currentPermitId = digest("post-context-permit-bitflip");
    }).toThrow(TypeError);
    expect(() => {
      (
        mutableAnchor as unknown as {
          receiptHeadHash: string;
        }
      ).receiptHeadHash = digest("post-context-anchor-bitflip");
    }).toThrow(TypeError);
    expect(() => {
      (
        mutableInitial.legacyQuotaReceipts[0] as unknown as {
          actualAmount: number;
        }
      ).actualAmount += 1;
    }).toThrow(TypeError);
    (
      mutableAnchor.permitRuntimeAnchor as unknown as {
        currentPermitId: string;
      }
    ).currentPermitId = digest("post-context-nested-anchor-bitflip");
    expect(initialContext.context.state.receiptHeadHash).toBe(
      initial.receiptHeadHash,
    );
    expect(initialContext.context.permitChain.currentPermitId).toBe(
      canary.currentPermitId,
    );
    expect(initialContext.context.anchor.receiptHeadHash).toBe(
      initialAnchor.receiptHeadHash,
    );
    expect(
      initialContext.context.state.legacyQuotaReceipts[0].actualAmount,
    ).toBe(initial.legacyQuotaReceipts[0].actualAmount);
    expect(
      initialContext.context.anchor.permitRuntimeAnchor.currentPermitId,
    ).toBe(initialAnchor.permitRuntimeAnchor.currentPermitId);
    const prepared = prepareMarketBaseResourceAttemptWithRuntimeContext(
      initialContext.context,
      prepareInput(canary, currentLane, tick),
    );
    expect(prepared.action).toBe("prepared");
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        prepared.state,
        canary,
        prepared.runtimeAnchor,
        tick,
      ),
    ).toEqual({ ok: true, prefix: "waiting_outcome" });
    expect(() =>
      prepareMarketBaseResourceAttemptWithRuntimeContext(
        initialContext.context,
        prepareInput(canary, currentLane, tick),
      ),
    ).toThrow("ledger_runtime_context_invalid");

    let nextContext = createMarketBaseResourceLedgerRuntimeContext({
      state: prepared.state,
      permitChain: canary,
      anchor: prepared.runtimeAnchor,
      tick,
    });
    if ("reason" in nextContext) throw new Error(nextContext.reason);
    expect(
      inspectMarketBaseResourceCanaryGrantAvailabilityWithRuntimeContext(
        nextContext.context,
        currentLane.laneId,
      ),
    ).toMatchObject({
      ok: true,
      available: false,
      reason: "canary_grant_already_attempted",
    });
    let operation = recordMarketBaseResourceOutcomeWithRuntimeContext(
      nextContext.context,
      notFilledOutcomeFor(prepared.state, tick),
    );
    expect(operation.action).toBe("outcome_written");
    for (const expectedAction of [
      "receipt_written",
      "processed_key_written",
      "pending_deleted",
    ] as const) {
      nextContext = createMarketBaseResourceLedgerRuntimeContext({
        state: operation.state,
        permitChain: canary,
        anchor: operation.runtimeAnchor,
        tick,
      });
      if ("reason" in nextContext) throw new Error(nextContext.reason);
      operation = advanceMarketBaseResourceWalWithRuntimeContext(
        nextContext.context,
      );
      expect(operation.action).toBe(expectedAction);
      expect(
        validateMarketBaseResourceLedgerRuntimeGate(
          operation.state,
          canary,
          operation.runtimeAnchor,
          tick,
        ).ok,
      ).toBe(true);
    }
    expect(operation.state.pending).toBeUndefined();
  });

  test("shallow-frozen ledger root 不得命中 immutable validation cache", () => {
    const { canary } = permitChains();
    const state = clone(ledger(canary));
    Object.freeze(state);
    expect(
      validateMarketBaseResourceLedger(state, MIGRATION_TICK, canary),
    ).toEqual({ ok: true, prefix: "idle" });
    (
      state.legacyQuotaReceipts[0] as unknown as {
        actualAmount: number;
      }
    ).actualAmount += 1;
    expect(
      validateMarketBaseResourceLedger(state, MIGRATION_TICK, canary).ok,
    ).toBe(false);
  });

  test("malformed Permit/Ledger runtime gate 与 context 全部 fail closed 而不抛错", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const initial = ledger(canary);
    const permitAnchor =
      buildMarketBaseResourcePermitRuntimeAnchor(
        canary,
      );
    const initialAnchor =
      buildMarketBaseResourceLedgerRuntimeAnchor(
        initial,
        canary,
      );
    const malformedPermits = [
      (() => {
        const value = clone(canary);
        delete (
          value as unknown as {
            retainedPermits?: unknown;
          }
        ).retainedPermits;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        (
          value as unknown as {
            retainedPermits: unknown;
          }
        ).retainedPermits = null;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        delete (
          value as unknown as {
            prefixCheckpoint?: unknown;
          }
        ).prefixCheckpoint;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        delete (
          value as unknown as {
            laneTombstoneCheckpoint?: unknown;
          }
        ).laneTombstoneCheckpoint;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        const current =
          value.retainedPermits[
            value.retainedPermits.length - 1
          ];
        if (!current || current.schemaVersion !== 3) {
          throw new Error("missing malformed current permit");
        }
        (
          current as unknown as {
            ratchetHighWater: unknown;
          }
        ).ratchetHighWater = null;
        return value;
      })(),
    ];
    for (const malformed of malformedPermits) {
      let gate:
        | ReturnType<
            typeof validateMarketBaseResourcePermitRuntimeGate
          >
        | undefined;
      expect(() => {
        gate =
          validateMarketBaseResourcePermitRuntimeGate(
            malformed,
            permitAnchor,
          );
      }).not.toThrow();
      expect(gate?.ok).toBe(false);
      let context:
        | ReturnType<
            typeof createMarketBaseResourcePermitRuntimeContext
          >
        | undefined;
      expect(() => {
        context =
          createMarketBaseResourcePermitRuntimeContext({
            state: malformed,
            anchor: permitAnchor,
            tick,
          });
      }).not.toThrow();
      expect(context).toMatchObject({ ok: false });
    }

    const prepared =
      prepareMarketBaseResourceAttempt(
        initial,
        prepareInput(
          canary,
          currentLane,
          tick,
        ),
      ).state;
    const preparedAnchor =
      buildMarketBaseResourceLedgerRuntimeAnchor(
        prepared,
        canary,
      );
    const malformedLedgers = [
      (() => {
        const value = clone(prepared);
        delete (
          value as unknown as {
            checkpoint?: unknown;
          }
        ).checkpoint;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        delete (
          value as unknown as {
            receipts?: unknown;
          }
        ).receipts;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value as unknown as {
            processedEvidenceKeys: unknown;
          }
        ).processedEvidenceKeys = [
          {
            attemptSeq:
              value.pending!.attemptSeq,
          },
        ];
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value as unknown as {
            lifetimeConfirmed: unknown;
          }
        ).lifetimeConfirmed = null;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value as unknown as {
            receipts: unknown;
          }
        ).receipts = [
          {
            status: "confirmed",
          },
        ];
        return value;
      })(),
    ];
    for (const malformed of malformedLedgers) {
      let gate:
        | ReturnType<
            typeof validateMarketBaseResourceLedgerRuntimeGate
          >
        | undefined;
      expect(() => {
        gate =
          validateMarketBaseResourceLedgerRuntimeGate(
            malformed,
            canary,
            preparedAnchor,
            tick,
          );
      }).not.toThrow();
      expect(gate?.ok).toBe(false);
      let context:
        | ReturnType<
            typeof createMarketBaseResourceLedgerRuntimeContext
          >
        | undefined;
      expect(() => {
        context =
          createMarketBaseResourceLedgerRuntimeContext({
            state: malformed,
            permitChain: canary,
            anchor: preparedAnchor,
            tick,
          });
      }).not.toThrow();
      expect(context).toMatchObject({ ok: false });
    }

    // Ledger gate 必须同样吞掉 malformed Permit，而不是在嵌套 gate 抛错。
    expect(() =>
      validateMarketBaseResourceLedgerRuntimeGate(
        initial,
        malformedPermits[0],
        initialAnchor,
        tick,
      ),
    ).not.toThrow();
  });

  test("runtime anchor 拒绝 outcome/processed/slot/blocker 删除替换与单字段攻击", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const prepared = prepareMarketBaseResourceAttempt(
      ledger(canary),
      prepareInput(canary, currentLane, tick),
    ).state;
    const preparedAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      prepared,
      canary,
    );
    for (const attacked of [
      (() => {
        const value = clone(prepared);
        delete (
          value as unknown as {
            terminalSlotReservation?: unknown;
          }
        ).terminalSlotReservation;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value.terminalSlotReservation as unknown as {
            attemptSeq: number;
          }
        ).attemptSeq += 1;
        return value;
      })(),
    ]) {
      expect(
        validateMarketBaseResourceLedgerRuntimeGate(
          attacked,
          canary,
          preparedAnchor,
          tick,
        ).ok,
      ).toBe(false);
    }

    const outcome = notFilledOutcomeFor(prepared, tick);
    const withOutcome = recordMarketBaseResourceOutcome(
      prepared,
      outcome,
      canary,
    ).state;
    const outcomeAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      withOutcome,
      canary,
    );
    for (const attacked of [
      { ...clone(withOutcome), outcomes: [] },
      {
        ...clone(withOutcome),
        outcomes: [
          {
            ...clone(withOutcome.outcomes[0]),
            reason: "replacement",
          },
        ],
      },
    ]) {
      expect(
        validateMarketBaseResourceLedgerRuntimeGate(
          attacked,
          canary,
          outcomeAnchor,
          tick,
        ).ok,
      ).toBe(false);
    }

    const receiptWritten = advanceMarketBaseResourceWal(
      withOutcome,
      canary,
    ).state;
    const processedWritten = advanceMarketBaseResourceWal(
      receiptWritten,
      canary,
    ).state;
    const processedAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      processedWritten,
      canary,
    );
    for (const attacked of [
      { ...clone(processedWritten), processedEvidenceKeys: [] },
      {
        ...clone(processedWritten),
        processedEvidenceKeys: [
          {
            ...clone(processedWritten.processedEvidenceKeys[0]),
            key: digest("processed-replacement"),
          },
        ],
      },
    ]) {
      expect(
        validateMarketBaseResourceLedgerRuntimeGate(
          attacked,
          canary,
          processedAnchor,
          tick,
        ).ok,
      ).toBe(false);
    }

    const context = createMarketBaseResourceLedgerRuntimeContext({
      state: prepared,
      permitChain: canary,
      anchor: preparedAnchor,
      tick,
    });
    if ("reason" in context) throw new Error(context.reason);
    const invalidOutcome = clone(outcome);
    (
      invalidOutcome as unknown as {
        outcomeEventHash: string;
      }
    ).outcomeEventHash = digest("invalid-outcome");
    const blocked = recordMarketBaseResourceOutcomeWithRuntimeContext(
      context.context,
      invalidOutcome,
    );
    expect(blocked.state.blocker).toBeDefined();
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        blocked.state,
        canary,
        blocked.runtimeAnchor,
        tick,
      ),
    ).toMatchObject({ ok: false, reason: "outcome_pending_mismatch" });
    const blockerDeleted = clone(blocked.state);
    delete (
      blockerDeleted as unknown as {
        blocker?: unknown;
      }
    ).blocker;
    const blockerFieldChanged = clone(blocked.state);
    if (!blockerFieldChanged.blocker) throw new Error("missing blocker");
    (
      blockerFieldChanged.blocker as unknown as {
        detectedAt: number;
      }
    ).detectedAt += 1;
    const blockerReplaced = clone(blocked.state);
    if (!blockerReplaced.blocker) throw new Error("missing blocker");
    (
      blockerReplaced as unknown as {
        blocker: {
          code: string;
          detectedAt: number;
          detailHash: string;
        };
      }
    ).blocker = {
      code: "replacement_blocker",
      detectedAt: tick,
      detailHash: digest("replacement-blocker"),
    };
    for (const attacked of [
      blockerDeleted,
      blockerFieldChanged,
      blockerReplaced,
    ]) {
      expect(
        validateMarketBaseResourceLedgerRuntimeGate(
          attacked,
          canary,
          blocked.runtimeAnchor,
          tick,
        ).ok,
      ).toBe(false);
    }
  });

  test.each(["not_filled", "failed"] as const)(
    "Canary %s 终态仍永久消费当前 successor one-shot",
    (status) => {
      const { canary, currentLane } = permitChains();
      const tick = 80_000;
      const prepared = prepareMarketBaseResourceAttempt(
        ledger(canary),
        prepareInput(canary, currentLane, tick),
      );
      const settled = settlePreparedCanary(prepared, canary, status, tick);
      expect(settled.pending).toBeUndefined();
      expect(
        inspectMarketBaseResourceCanaryGrantAvailability(
          settled,
          canary,
          currentLane.laneId,
        ),
      ).toMatchObject({
        ok: true,
        available: false,
        reason: "canary_grant_already_attempted",
        attempt: {
          attemptSeq: 7,
          permitId: canary.currentPermitId,
          permitEpoch: canary.currentPermitEpoch,
        },
      });
      expect(
        prepareMarketBaseResourceAttempt(
          settled,
          prepareInput(canary, currentLane, tick + 1_000),
        ),
      ).toMatchObject({
        ok: false,
        action: "blocked",
        blockerCode: "canary_grant_already_attempted",
      });
    },
  );

  test("Canary attempt 顶层 high-water 单边回拨会被 receipt 重演拒绝", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const settled = settlePreparedCanary(
      prepareMarketBaseResourceAttempt(
        ledger(canary),
        prepareInput(canary, currentLane, tick),
      ),
      canary,
      "not_filled",
      tick,
    );
    const rolledBack = clone(settled);
    delete (rolledBack.canaryAttemptHighWater as Record<string, unknown>)[
      currentLane.laneId
    ];
    expect(validateMarketBaseResourceLedger(rolledBack, tick, canary)).toEqual({
      ok: false,
      reason: "ledger_tip_or_lifetime_invalid",
    });
  });

  test("Canary receipt 裁剪后 checkpoint 仍封存 one-shot high-water", () => {
    const { canary, currentLane } = permitChains();
    const canaryTick = 80_000;
    const settledCanary = settleConfirmedCanary(
      prepareMarketBaseResourceAttempt(
        ledger(canary),
        prepareInput(canary, currentLane, canaryTick),
      ),
      canary,
      canaryTick,
    );
    const promoted = promoteConfirmedCanaryToContinuous({
      state: settledCanary,
      chain: canary,
      currentLane,
      tick: canaryTick + 1,
    });
    const firstContinuousTick =
      canaryTick + MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS;
    const firstContinuous = settlePreparedCanary(
      prepareMarketBaseResourceAttempt(
        promoted.state,
        prepareContinuousInput(
          promoted.chain,
          currentLane,
          firstContinuousTick,
        ),
      ),
      promoted.chain,
      "not_filled",
      firstContinuousTick,
    );
    expect(firstContinuous.legacyQuotaReceipts).toHaveLength(0);
    const firstContinuousReceipt = firstContinuous.receipts[1];
    if (!firstContinuousReceipt) {
      throw new Error("missing first continuous receipt");
    }
    const synthetic = extendNotFilledReceiptChain({
      first: firstContinuousReceipt,
      previousHead: firstContinuous.receiptHeadHash,
      firstAttemptSeq: 9,
      lastAttemptSeq: 518,
      firstAttemptAt: firstContinuousTick + 101,
    });
    const finalReceipt = synthetic[synthetic.length - 1];
    const allReceipts = [...firstContinuous.receipts, ...synthetic];
    const fullRing = {
      ...clone(firstContinuous),
      receipts: allReceipts,
      outcomes: allReceipts.slice(-50).map(outcomeFromReceipt),
      processedEvidenceKeys: allReceipts.map((receipt) => ({
        attemptSeq: receipt.attemptSeq,
        key: receipt.evidenceKey,
      })),
      receiptHeadHash: finalReceipt.headHash,
      finalizedAttemptSeq: finalReceipt.attemptSeq,
      nextAttemptSeq: finalReceipt.attemptSeq + 1,
      retryNotBefore: finalReceipt.attemptAt + 100,
    } as MarketBaseResourceLedger;
    const nextTick = finalReceipt.attemptAt + 101;
    expect(fullRing.receipts).toHaveLength(512);
    expect(
      validateMarketBaseResourceLedger(fullRing, nextTick, promoted.chain),
    ).toEqual({ ok: true, prefix: "idle" });
    expect(fullRing.outcomes).toHaveLength(50);
    expect(fullRing.processedEvidenceKeys).toHaveLength(512);
    const maxRingAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      fullRing,
      promoted.chain,
    );
    const benchmarkStats = (samples: readonly number[]) => {
      const sorted = [...samples].sort((left, right) => left - right);
      return {
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      };
    };
    const maxRingRuntimeGateSamples = Array.from({ length: 20 }, () => {
      const coldMaxRing = clone(fullRing);
      const coldMaxRingChain = clone(promoted.chain);
      const coldMaxRingAnchor = clone(maxRingAnchor);
      const maxRingStartedAt = performance.now();
      expect(
        validateMarketBaseResourceLedgerRuntimeGate(
          coldMaxRing,
          coldMaxRingChain,
          coldMaxRingAnchor,
          nextTick,
        ),
      ).toEqual({ ok: true, prefix: "idle" });
      return performance.now() - maxRingStartedAt;
    });
    const maxRingRuntimeGateStats = benchmarkStats(maxRingRuntimeGateSamples);
    const processedReplayBitFlip = clone(fullRing);
    (
      processedReplayBitFlip.processedEvidenceKeys[256] as unknown as {
        key: string;
      }
    ).key = digest("processed-replay-middle-bitflip");
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        processedReplayBitFlip,
        promoted.chain,
        maxRingAnchor,
        nextTick,
      ).ok,
    ).toBe(false);
    const confirmedQuotaBitFlip = clone(fullRing);
    (
      confirmedQuotaBitFlip.receipts[0] as unknown as {
        actualAmount: number;
      }
    ).actualAmount += 1;
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        confirmedQuotaBitFlip,
        promoted.chain,
        maxRingAnchor,
        nextTick,
      ).ok,
    ).toBe(false);
    const auditOnlyNotFilledBitFlip = clone(fullRing);
    (
      auditOnlyNotFilledBitFlip.receipts[1] as unknown as {
        reason: string;
      }
    ).reason = "audit_only_reason_bitflip";
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        auditOnlyNotFilledBitFlip,
        promoted.chain,
        maxRingAnchor,
        nextTick,
      ),
    ).toEqual({ ok: true, prefix: "idle" });
    expect(
      validateMarketBaseResourceLedger(
        auditOnlyNotFilledBitFlip,
        nextTick,
        promoted.chain,
      ).ok,
    ).toBe(false);
    console.info("ledger-max-ring-runtime-gate-benchmark", {
      receipts: fullRing.receipts.length,
      outcomes: fullRing.outcomes.length,
      processedEvidenceKeys: fullRing.processedEvidenceKeys.length,
      coldRuntimeGate: maxRingRuntimeGateStats,
    });
    expect(maxRingRuntimeGateStats.medianMs).toBeLessThan(10);
    expect(maxRingRuntimeGateStats.p95Ms).toBeLessThan(15);
    const maxRingContextSamples: number[] = [];
    const maxRingPrepareSamples: number[] = [];
    const maxRingRecordOutcomeSamples: number[] = [];
    const maxRingAdvanceReceiptSamples: number[] = [];
    Array.from({ length: 10 }, () => {
      const coldContextState = clone(fullRing);
      const coldContextChain = clone(promoted.chain);
      const coldContextAnchor = clone(maxRingAnchor);
      const contextStartedAt = performance.now();
      const maxRingContext = createMarketBaseResourceLedgerRuntimeContext({
        state: coldContextState,
        permitChain: coldContextChain,
        anchor: coldContextAnchor,
        tick: nextTick,
      });
      maxRingContextSamples.push(performance.now() - contextStartedAt);
      if ("reason" in maxRingContext) throw new Error(maxRingContext.reason);
      let mutatorStartedAt = performance.now();
      const runtimePrepared =
        prepareMarketBaseResourceAttemptWithRuntimeContext(
          maxRingContext.context,
          prepareContinuousInput(promoted.chain, currentLane, nextTick),
        );
      maxRingPrepareSamples.push(performance.now() - mutatorStartedAt);
      mutatorStartedAt = performance.now();
      const runtimeOutcome = recordMarketBaseResourceOutcomeWithRuntimeContext(
        runtimePrepared.runtimeContext,
        notFilledOutcomeFor(runtimePrepared.state, nextTick),
      );
      maxRingRecordOutcomeSamples.push(performance.now() - mutatorStartedAt);
      mutatorStartedAt = performance.now();
      advanceMarketBaseResourceWalWithRuntimeContext(
        runtimeOutcome.runtimeContext,
      );
      maxRingAdvanceReceiptSamples.push(performance.now() - mutatorStartedAt);
    });
    const maxRingContextStats = benchmarkStats(maxRingContextSamples);
    const maxRingPrepareStats = benchmarkStats(maxRingPrepareSamples);
    const maxRingRecordOutcomeStats = benchmarkStats(
      maxRingRecordOutcomeSamples,
    );
    const maxRingAdvanceReceiptStats = benchmarkStats(
      maxRingAdvanceReceiptSamples,
    );
    console.info("ledger-max-ring-runtime-mutator-benchmark", {
      createContext: maxRingContextStats,
      prepare: maxRingPrepareStats,
      recordOutcome: maxRingRecordOutcomeStats,
      advanceReceipt: maxRingAdvanceReceiptStats,
    });
    expect(maxRingContextStats.medianMs).toBeLessThan(20);
    expect(maxRingContextStats.p95Ms).toBeLessThan(30);
    expect(maxRingPrepareStats.medianMs).toBeLessThan(10);
    expect(maxRingPrepareStats.p95Ms).toBeLessThan(15);
    expect(maxRingRecordOutcomeStats.medianMs).toBeLessThan(10);
    expect(maxRingRecordOutcomeStats.p95Ms).toBeLessThan(15);
    expect(maxRingAdvanceReceiptStats.medianMs).toBeLessThan(10);
    expect(maxRingAdvanceReceiptStats.p95Ms).toBeLessThan(15);
    const compacted = prepareMarketBaseResourceAttempt(
      fullRing,
      prepareContinuousInput(promoted.chain, currentLane, nextTick),
    );
    expect(compacted.action).toBe("prepared");
    const state = compacted.state;
    expect(state.checkpoint.prunedThroughAttemptSeq).toBe(7);
    expect(state.receipts[0].attemptSeq).toBe(8);
    expect(
      state.checkpoint.canaryAttemptHighWater[currentLane.laneId],
    ).toMatchObject({
      attemptSeq: 7,
      permitId: canary.currentPermitId,
      permitEpoch: canary.currentPermitEpoch,
    });
    expect(state.canaryAttemptHighWater[currentLane.laneId]).toEqual(
      state.checkpoint.canaryAttemptHighWater[currentLane.laneId],
    );
    expect(
      validateMarketBaseResourceLedger(state, nextTick, promoted.chain),
    ).toEqual({ ok: true, prefix: "waiting_outcome" });

    let converging = recordMarketBaseResourceOutcome(
      state,
      notFilledOutcomeFor(state, nextTick),
      promoted.chain,
    );
    expect(converging.action).toBe("outcome_written");
    for (const expectedAction of [
      "receipt_written",
      "processed_key_written",
      "pending_deleted",
    ] as const) {
      converging = advanceMarketBaseResourceWal(
        converging.state,
        promoted.chain,
      );
      expect(converging.action).toBe(expectedAction);
    }
    expect(converging.state.pending).toBeUndefined();
    expect(converging.state.terminalSlotReservation).toBeUndefined();
    expect(converging.state.receipts.length).toBeLessThanOrEqual(
      MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT,
    );
    expect(converging.state.outcomes.length).toBeLessThanOrEqual(
      MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT,
    );
    expect(converging.state.processedEvidenceKeys.length).toBeLessThanOrEqual(
      MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT,
    );
    expect(JSON.stringify(converging.state).length).toBeLessThan(2_000_000);
    expect(
      validateMarketBaseResourceLedger(
        converging.state,
        nextTick,
        promoted.chain,
      ),
    ).toEqual({ ok: true, prefix: "idle" });

    const checkpointRollback = clone(state);
    delete (
      checkpointRollback.checkpoint.canaryAttemptHighWater as Record<
        string,
        unknown
      >
    )[currentLane.laneId];
    expect(
      validateMarketBaseResourceLedger(
        checkpointRollback,
        nextTick,
        promoted.chain,
      ),
    ).toEqual({
      ok: false,
      reason: "ledger_checkpoint_invalid",
    });
  });

  test("旧 chain+新 ledger 回滚被拒绝，合法 permit forward 仍支配旧 anchor", () => {
    const { first, canary, currentLane } = permitChains();
    const state = ledger(canary);
    expect(
      validateMarketBaseResourceLedger(state, MIGRATION_TICK, first),
    ).toMatchObject({
      ok: false,
      reason: "ledger_permit_anchor_rollback",
    });

    const confirmed = settleConfirmedCanary(
      prepareMarketBaseResourceAttempt(
        state,
        prepareInput(canary, currentLane, 80_000),
      ),
      canary,
      80_000,
    );
    const promoted = promoteConfirmedCanaryToContinuous({
      state: confirmed,
      chain: canary,
      currentLane,
      tick: 80_001,
    });
    expect(
      validateMarketBaseResourcePermitChainDominatesAnchor(
        promoted.chain,
        confirmed.permitAnchor,
      ),
    ).toEqual({ ok: true });
    expect(
      validateMarketBaseResourceLedger(confirmed, 80_001, promoted.chain),
    ).toEqual({ ok: true, prefix: "idle" });
    const rebound = promoted.state;
    expect(rebound.permitAnchor).toEqual(
      buildMarketBaseResourcePermitChainAnchor(promoted.chain),
    );
    expect(
      validateMarketBaseResourceLedger(rebound, MIGRATION_TICK, canary).ok,
    ).toBe(false);
  });

  test("ledger/checkpoint 两份 permit anchor 任一单边篡改均失败", () => {
    const { canary } = permitChains();
    const state = ledger(canary);
    expect(buildMarketBaseResourcePermitChainAnchor(canary)).toEqual(
      state.permitAnchor,
    );
    const tampered = clone(state);
    (
      tampered.permitAnchor as unknown as {
        currentPermitId: string;
      }
    ).currentPermitId = digest("old-permit");
    expect(validateMarketBaseResourceLedger(tampered)).toEqual({
      ok: false,
      reason: "ledger_shape_invalid",
    });
  });

  test("130 条 canonical retired lane 批量收敛且 tombstone rollback 被 anchor 拒绝", () => {
    const { canary, currentLane } = permitChains();
    const lanes = incarnatedXLanes(130);
    const confirmed = settleConfirmedCanary(
      prepareMarketBaseResourceAttempt(
        ledger(canary),
        prepareInput(canary, currentLane, 80_000),
      ),
      canary,
      80_000,
    );
    const first = retireCanaryAndAuthorizeNext({
      state: confirmed,
      chain: canary,
      oldLane: currentLane,
      nextLane: lanes[0],
      tick: 80_001,
    });
    expect(
      inspectMarketBaseResourceCanaryGrantAvailability(
        first.state,
        first.chain,
        lanes[0].laneId,
      ),
    ).toMatchObject({ ok: true, available: true });
    const earlyTombstoneCheckpoint = clone(first.chain.laneTombstoneCheckpoint);
    const firstBatch = replaceLaneScopeThroughCanonicalTombstones({
      state: first.state,
      chain: first.chain,
      priorLanes: [lanes[0]],
      nextLanes: lanes.slice(1, 113),
      tick: 80_003,
    });
    const secondBatch = replaceLaneScopeThroughCanonicalTombstones({
      state: firstBatch.state,
      chain: firstBatch.chain,
      priorLanes: lanes.slice(1, 113),
      nextLanes: lanes.slice(113, 129),
      tick: 80_005,
    });
    const transitionStartedAt = Date.now();
    const final = replaceLaneScopeThroughCanonicalTombstones({
      state: secondBatch.state,
      chain: secondBatch.chain,
      priorLanes: lanes.slice(113, 129),
      nextLanes: lanes.slice(129),
      tick: 80_007,
    });
    const transitionElapsedMs = Date.now() - transitionStartedAt;
    for (let warm = 0; warm < 3; warm += 1) {
      expect(validateMarketBaseResourcePermitChain(final.chain)).toEqual({
        ok: true,
      });
      expect(
        validateMarketBaseResourceLedger(final.state, 80_009, final.chain),
      ).toEqual({ ok: true, prefix: "idle" });
    }
    const permitSamples: number[] = [];
    const ledgerSamples: number[] = [];
    for (let sample = 0; sample < 20; sample += 1) {
      let startedAt = performance.now();
      validateMarketBaseResourcePermitChain(final.chain);
      permitSamples.push(performance.now() - startedAt);
      startedAt = performance.now();
      validateMarketBaseResourceLedger(final.state, 80_009, final.chain);
      ledgerSamples.push(performance.now() - startedAt);
    }
    const benchmark = (samples: readonly number[]) => {
      const sorted = [...samples].sort((left, right) => left - right);
      return {
        totalMs: samples.reduce((total, sample) => total + sample, 0),
        averageMs:
          samples.reduce((total, sample) => total + sample, 0) / samples.length,
        p95Ms: sorted[Math.floor(sorted.length * 0.95) - 1],
      };
    };
    const permitBenchmark = benchmark(permitSamples);
    const ledgerBenchmark = benchmark(ledgerSamples);
    const coldPermit = clone(final.chain);
    let coldStartedAt = performance.now();
    expect(validateMarketBaseResourcePermitChain(coldPermit)).toEqual({
      ok: true,
    });
    const coldPermitValidationMs = performance.now() - coldStartedAt;
    const coldLedger = clone(final.state);
    coldStartedAt = performance.now();
    expect(
      validateMarketBaseResourceLedger(coldLedger, 80_009, coldPermit),
    ).toEqual({ ok: true, prefix: "idle" });
    const coldLedgerValidationMs = performance.now() - coldStartedAt;
    const permitRuntimeAnchor = buildMarketBaseResourcePermitRuntimeAnchor(
      final.chain,
    );
    const ledgerRuntimeAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      final.state,
      final.chain,
    );
    const coldRuntimeChain = clone(final.chain);
    const coldRuntimeLedger = clone(final.state);
    coldStartedAt = performance.now();
    expect(
      validateMarketBaseResourcePermitRuntimeGate(
        coldRuntimeChain,
        clone(permitRuntimeAnchor),
      ),
    ).toEqual({ ok: true });
    const coldPermitRuntimeGateMs = performance.now() - coldStartedAt;
    coldStartedAt = performance.now();
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        coldRuntimeLedger,
        coldRuntimeChain,
        clone(ledgerRuntimeAnchor),
        80_009,
      ),
    ).toEqual({ ok: true, prefix: "idle" });
    const coldLedgerRuntimeGateMs = performance.now() - coldStartedAt;
    const { state, chain } = final;
    console.info("ledger-retired-churn-benchmark", {
      transitionElapsedMs,
      permitBenchmark,
      ledgerBenchmark,
      coldPermitValidationMs,
      coldLedgerValidationMs,
      coldPermitRuntimeGateMs,
      coldLedgerRuntimeGateMs,
    });
    expect(transitionElapsedMs).toBeLessThan(5_000);
    expect(permitBenchmark.averageMs).toBeLessThan(10);
    expect(ledgerBenchmark.averageMs).toBeLessThan(10);
    expect(coldPermitRuntimeGateMs).toBeLessThan(25);
    expect(coldLedgerRuntimeGateMs).toBeLessThan(25);
    expect(Object.keys(state.canaryAttemptHighWater)).toHaveLength(0);
    expect(Object.keys(state.confirmedCanaries)).toHaveLength(0);
    expect(
      state.checkpoint.retiredCanaryCheckpoint.retiredCanaries,
    ).toHaveLength(1);
    // 没有 attempt/confirmed 的 129 条 tombstone 只由 permit exact
    // dischargedTombstones 管理；Ledger 不再用 Bloom mayContain 建立
    // membership，因此不会制造假阳性永久拒绝。
    expect(state.checkpoint.retiredCanaryCheckpoint.compressedCount).toBe(0);
    expect(
      marketBaseResourceCanaryReviewFactsFor(state, currentLane.laneId, chain),
    ).toMatchObject({
      retired: true,
      confirmed: {
        transactionTime: 80_000,
        actualAmount: 400,
        actualTransactionEnergy: 160,
        actualNetCreditsMilli: 279_960_000,
      },
    });
    expect(state.permitAnchor.laneTombstoneCheckpointCommitment).toBe(
      chain.laneTombstoneCheckpoint.checkpointCommitment,
    );

    const oldSuffixBitFlip = clone(chain);
    (
      oldSuffixBitFlip.retainedPermits[0] as unknown as {
        permitHead: string;
      }
    ).permitHead = digest("old-suffix-bit-flip");
    expect(
      validateMarketBaseResourcePermitRuntimeGate(
        oldSuffixBitFlip,
        permitRuntimeAnchor,
      ),
    ).toEqual({ ok: true });
    expect(validateMarketBaseResourcePermitChain(oldSuffixBitFlip).ok).toBe(
      false,
    );
    const currentPermitBitFlip = clone(chain);
    (
      currentPermitBitFlip.retainedPermits[
        currentPermitBitFlip.retainedPermits.length - 1
      ] as unknown as { selfHash: string }
    ).selfHash = digest("current-permit-bit-flip");
    expect(
      validateMarketBaseResourcePermitRuntimeGate(
        currentPermitBitFlip,
        permitRuntimeAnchor,
      ).ok,
    ).toBe(false);
    const quotaBitFlip = clone(state);
    (
      quotaBitFlip.receipts[0] as unknown as {
        actualAmount: number;
      }
    ).actualAmount += 1;
    expect(
      validateMarketBaseResourceLedgerRuntimeGate(
        quotaBitFlip,
        chain,
        ledgerRuntimeAnchor,
        80_009,
      ).ok,
    ).toBe(false);

    const rolledBack = clone(chain);
    (
      rolledBack as unknown as {
        laneTombstoneCheckpoint: MarketBaseResourcePermitChainState["laneTombstoneCheckpoint"];
      }
    ).laneTombstoneCheckpoint = earlyTombstoneCheckpoint;
    expect(
      validateMarketBaseResourceLedger(state, 80_009, rolledBack),
    ).toMatchObject({
      ok: false,
      reason: "ledger_permit_tombstone_anchor_mismatch",
    });
  });

  test("跨版本 partial actual 与 unmatched planned 精确计入四层", () => {
    const quota = computeMarketBaseResourceQuota({
      tick: 50_500,
      resource: "X",
      sellerRoom: "E6N59",
      resourceLimit: 8_000,
      receipts: [
        {
          ...legacyReceipt(1),
          actualAmount: 600,
        },
      ],
      pending: {
        resource: "X",
        sellerRoom: "E6N59",
        plannedAmount: 1_000,
      },
    });
    expect(quota.global).toMatchObject({
      confirmedActual: 600,
      unmatchedPlanned: 1_000,
      used: 1_600,
    });
    expect(quota.resourceQuota.used).toBe(1_600);
    expect(quota.room.used).toBe(1_600);
    expect(quota.lane.used).toBe(1_600);
  });

  test("V3 outer 对 V2 outcome/receipt 使用认证 cutover，截止值可读而上界+1拒绝", () => {
    const cutover = permitChains().canary.v2EventCutoverCheckpoint!;
    const rawOutcome = {
      attemptSeq: cutover.lastV2OutcomeSeq,
      status: "confirmed",
      permitId: digest("cutover-v2-outcome-permit"),
      permitEpoch: 1,
      entryId: "base-x-e6n59-v1",
      resourcePolicyFingerprint: digest("cutover-v2-outcome-policy"),
      sellerRoom: "E6N59",
      resource: "X",
      orderId: "cutover-v2-outcome-order",
      orderRoom: "W9N9",
      attemptAt: 1,
      plannedAmount: 1_000,
      resolvedAt: 2,
      evidenceKey: digest("cutover-v2-outcome-evidence"),
      actualAmount: 1_000,
      pendingEvidenceHash: digest("cutover-v2-pending"),
      outcomeEventHash: digest("cutover-v2-outcome"),
    };
    const rawReceipt = {
      attemptSeq: cutover.lastV2OutcomeSeq,
      executionPolicy: "continuous",
      status: "confirmed",
      permitId: digest("cutover-v2-receipt-permit"),
      permitEpoch: 1,
      entryId: "base-x-e6n59-v1",
      resourcePolicyFingerprint: digest("cutover-v2-receipt-policy"),
      sellerRoom: "E6N59",
      resource: "X",
      orderId: "cutover-v2-receipt-order",
      orderRoom: "W9N9",
      attemptAt: 1,
      plannedAmount: 1_000,
      resolvedAt: 2,
      retentionTick: 2,
      evidenceKey: digest("cutover-v2-receipt-evidence"),
      actualAmount: 1_000,
      outcomeEventHash: digest("cutover-v2-receipt-outcome"),
      prevHash: digest("cutover-v2-receipt-prev"),
      eventHash: digest("cutover-v2-receipt-event"),
      headHash: digest("cutover-v2-receipt-head"),
    };
    for (const [kind, raw] of [
      ["outcome", rawOutcome],
      ["receipt", rawReceipt],
    ] as const) {
      const validator = jest.fn((candidate: unknown) => candidate === raw);
      const atCutoff = validateMarketBaseResourceMixedVersionEvent(
        raw,
        {
          kind,
          outerLedgerSchema: 3,
          outerAttemptSeqHighWater: 100,
          outerOutcomeSeqHighWater: 100,
          cutover,
        },
        validator,
      );
      expect(atCutoff).toMatchObject({
        ok: true,
        version: "legacy-v2-implicit",
      });
      expect(atCutoff.ok && atCutoff.rawRecord).toBe(raw);
      expect(validator).toHaveBeenCalledWith(raw);

      const aboveCutoff = {
        ...raw,
        attemptSeq: cutover.lastV2OutcomeSeq + 1,
      };
      const rejectedValidator = jest.fn(() => true);
      expect(
        validateMarketBaseResourceMixedVersionEvent(
          aboveCutoff,
          {
            kind,
            outerLedgerSchema: 3,
            outerAttemptSeqHighWater: 100,
            outerOutcomeSeqHighWater: 100,
            cutover,
          },
          rejectedValidator,
        ),
      ).toEqual({ ok: false, reason: "legacy_v2_seq_above_cutover" });
      expect(rejectedValidator).not.toHaveBeenCalled();
    }
  });

  test("mixed-version dispatcher 保持 raw V2 对象引用且拒绝畸形 V3", () => {
    const rawV2 = {
      attemptSeq: 6,
      executionPolicy: "continuous",
      permitId: digest("legacy-permit"),
      permitEpoch: 1,
      entryId: "base-x-e6n59-v1",
      resourcePolicyFingerprint: digest("legacy-policy"),
      sellerRoom: "E6N59",
      resource: "X",
      orderId: "legacy-order",
      orderRoom: "W9N9",
      attemptAt: 1,
      plannedAmount: 1_000,
      plannedTransactionEnergy: 100,
      plannedNetCreditsMilli: 1,
      evidenceKeyHint: "legacy-evidence",
      executionEvidence: {},
      resourceQuota: {},
      globalOpportunityReservation: {},
      frozenEvidenceHash: "legacy-hash",
    };
    const validator = jest.fn((candidate: unknown) => candidate === rawV2);
    expect(
      validateMarketBaseResourceMixedVersionEvent(
        rawV2,
        {
          kind: "pending",
          outerLedgerSchema: 2,
          outerAttemptSeqHighWater: 6,
          outerOutcomeSeqHighWater: 6,
        },
        validator,
      ),
    ).toMatchObject({
      ok: true,
      version: "legacy-v2-implicit",
      rawRecord: rawV2,
    });
    expect(validator).toHaveBeenCalledWith(rawV2);
    expect(
      validateMarketBaseResourceMixedVersionEvent(
        {
          schemaVersion: 3,
          hashRevision: MARKET_BASE_RESOURCE_PENDING_HASH_REVISION,
          attemptSeq: 7,
        },
        {
          kind: "pending",
          outerLedgerSchema: 3,
          outerAttemptSeqHighWater: 7,
          outerOutcomeSeqHighWater: 6,
        },
        () => true,
      ),
    ).toEqual({
      ok: false,
      reason: "v3_explicit_codec_rejected",
    });
  });
});
