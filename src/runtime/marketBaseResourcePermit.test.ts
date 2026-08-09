import {
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  reconcileMarketBaseDerivedLanes,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseResource,
  validateMarketBaseDerivedLaneLifecycle,
} from "@/runtime/marketBaseResourcePolicy";
import {
  MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT,
  MARKET_BASE_RESOURCE_RECEIPT_REFERENCE_LIMIT,
  MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT,
  appendMarketBaseResourcePermit,
  buildMarketBaseResourceBootstrapRatchetHighWater,
  buildMarketBaseResourceLegacyV2GrantSuspension,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourcePermitRuntimeAnchor,
  buildMarketBaseResourceRatchetHighWater,
  buildMarketBaseResourceSignedLaneGrant,
  buildMarketBaseResourceV2EventCutoverCheckpoint,
  compactMarketBaseResourceLaneTombstonesForAudit,
  createMarketBaseResourcePermitChainState,
  createMarketBaseResourcePermitRuntimeContext,
  hasAcceptedMarketBaseResourceV3Successor,
  sealMarketBaseResourceValidatedConfirmedCanaryProof,
  validateMarketBaseResourcePermitChain,
  validateMarketBaseResourcePermitRuntimeGate,
  wrapAuthenticatedLegacyV2PermitRecord,
  type AppendMarketBaseResourcePermitInput,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitChainState,
  type MarketBaseResourceLaneTombstoneDischarge,
  type MarketBaseResourceRatchetHighWater,
  type MarketBaseResourceReviewedEvidence,
  type MarketBaseResourceSignedLaneGrant,
  type MarketBaseResourceValidatedConfirmedCanaryProof,
} from "@/runtime/marketBaseResourcePermit";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  buildMarketDirectContinuousPermit,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";

const ACCOUNT = "forst";
const V2_LEDGER_HEAD = canonicalStableHashV1("permit-test:v2-ledger");
const V2_LEDGER_CHECKPOINT = canonicalStableHashV1(
  "permit-test:v2-ledger-checkpoint",
);
const V3_LEDGER_HEAD = canonicalStableHashV1("permit-test:v3-ledger");
const V3_LEDGER_CHECKPOINT = canonicalStableHashV1(
  "permit-test:v3-ledger-checkpoint",
);
const V3_LEDGER_ANCHOR = canonicalStableHashV1("permit-test:v3-ledger-anchor");

function digest(label: string): string {
  return canonicalStableHashV1(`permit-test:${label}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function derivedRoomLanes(
  roomName: string,
  instanceLabel = roomName,
): readonly MarketBaseDerivedLaneLifecycle[] {
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const roomInstanceId = digest(`room-instance:${instanceLabel}`);
  const reconciled = reconcileMarketBaseDerivedLanes({
    sharedPolicyFingerprint: shared.fingerprint,
    sellerRooms: [
      {
        roomName,
        roomClass: "normal",
        roomInstanceId,
        incarnation: 1,
        previousInstanceId: null,
        controllerOwner: ACCOUNT,
        terminalId: `terminal-${roomName}`,
        status: "admitted",
        admissionRevision: "owned-visible-terminal-v1",
        fingerprint: digest(`room:${roomName}`),
      },
    ],
  });
  if (!reconciled.ok || !reconciled.lanes) {
    throw new Error("failed to derive permit-test lane");
  }
  return reconciled.lanes.map((lane) => ({
    ...lane,
    stage: "qualified" as const,
    status: "suspended" as const,
    shadowEvidence: {
      completeCycles: 100,
      lastCompleteTick: 1_000,
      evidenceDigest: digest(`shadow:${lane.laneId}`),
    },
  }));
}

function derivedLane(
  roomName: string,
  resource: MarketBaseResource = "X",
  instanceLabel = roomName,
): MarketBaseDerivedLaneLifecycle {
  return derivedRoomLanes(roomName, instanceLabel).find(
    (candidate) => candidate.resource === resource,
  )!;
}

function legacyV2Raw() {
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
    previousLedgerHead: V2_LEDGER_HEAD,
    createdAt: 1_000,
    operatorAuthorizationFingerprint: digest("v2-operator"),
  });
}

function initialState(): MarketBaseResourcePermitChainState {
  return createMarketBaseResourcePermitChainState({
    legacyV2PermitRecords: [
      wrapAuthenticatedLegacyV2PermitRecord({
        rawRecord: legacyV2Raw(),
        authenticated: true,
      }),
    ],
  });
}

function currentRatchet(
  state: MarketBaseResourcePermitChainState,
): readonly MarketBaseResourceRatchetHighWater[] {
  const current = state.retainedPermits[state.retainedPermits.length - 1];
  return current?.schemaVersion === 3
    ? current.ratchetHighWater
    : buildMarketBaseResourceBootstrapRatchetHighWater(2_000);
}

function cutover() {
  return buildMarketBaseResourceV2EventCutoverCheckpoint({
    lastV2AttemptSeq: 6,
    lastV2OutcomeSeq: 6,
    v2ReceiptHeadHash: V2_LEDGER_HEAD,
    v2LedgerCheckpointHash: V2_LEDGER_CHECKPOINT,
  });
}

function buildPermit(input: {
  state: MarketBaseResourcePermitChainState;
  grants: readonly MarketBaseResourceSignedLaneGrant[];
  reviewedEvidence?: readonly MarketBaseResourceReviewedEvidence[];
  ratchetHighWater?: readonly MarketBaseResourceRatchetHighWater[];
  ledgerHead?: string;
}): MarketBaseResourcePermit {
  const firstV3 = !input.state.v2EventCutoverCheckpoint;
  const eventCutover = firstV3 ? cutover() : undefined;
  return buildMarketBaseResourcePermit({
    epoch: input.state.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: createMarketBaseSharedPolicy(ACCOUNT),
    ratchetHighWater: input.ratchetHighWater ?? currentRatchet(input.state),
    signedLaneGrants: input.grants,
    reviewedEvidence: input.reviewedEvidence,
    previousPermitId: input.state.currentPermitId,
    previousPermitHead: input.state.permitChainHead,
    previousLedgerHead:
      input.ledgerHead ?? (firstV3 ? V2_LEDGER_HEAD : V3_LEDGER_HEAD),
    ...(eventCutover
      ? {
          v2EventCutoverCheckpoint: eventCutover,
          legacyV2GrantSuspension:
            buildMarketBaseResourceLegacyV2GrantSuspension({
              previousPermitId: input.state.currentPermitId,
              previousPermitHead: input.state.permitChainHead,
              cutoverCheckpointHash: eventCutover.checkpointHash,
            }),
        }
      : {}),
    createdAt: 2_000 + input.state.permitEpochHighWater,
    operatorAuthorizationFingerprint: digest(
      `operator:${input.state.permitEpochHighWater + 1}`,
    ),
  });
}

function appendInput(
  lanes: readonly MarketBaseDerivedLaneLifecycle[],
  overrides: Partial<AppendMarketBaseResourcePermitInput> = {},
): AppendMarketBaseResourcePermitInput {
  return {
    tick: 2_000,
    currentShard: "shard1",
    currentLedgerHead: V3_LEDGER_HEAD,
    currentLedgerCheckpointHash: V3_LEDGER_CHECKPOINT,
    currentLedgerPermitAnchorHash: V3_LEDGER_ANCHOR,
    currentV2LedgerCheckpointHash: V2_LEDGER_CHECKPOINT,
    currentV2AttemptSeqHighWater: 6,
    currentV2OutcomeSeqHighWater: 6,
    currentDerivedLanes: lanes,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(lanes),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
    ...overrides,
  };
}

function appendOrThrow(
  state: MarketBaseResourcePermitChainState,
  permit: MarketBaseResourcePermit,
  lanes: readonly MarketBaseDerivedLaneLifecycle[],
  overrides: Partial<AppendMarketBaseResourcePermitInput> = {},
): MarketBaseResourcePermitChainState {
  const result = appendMarketBaseResourcePermit(
    state,
    permit,
    appendInput(lanes, {
      currentLedgerHead: permit.previousLedgerHead,
      ...overrides,
    }),
  );
  if (result.status !== "appended") {
    throw new Error(
      `${result.status}:${
        "reason" in result ? result.reason : "unexpected-idempotent"
      }`,
    );
  }
  return result.state;
}

function acceptedFirst(
  lanes: readonly MarketBaseDerivedLaneLifecycle[] = [derivedLane("E6N59")],
): {
  readonly state: MarketBaseResourcePermitChainState;
  readonly lanes: readonly MarketBaseDerivedLaneLifecycle[];
} {
  const state = initialState();
  const permit = buildPermit({
    state,
    grants: lanes.map((lane) =>
      buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    ),
    ledgerHead: V2_LEDGER_HEAD,
  });
  return {
    state: appendOrThrow(state, permit, lanes, {
      currentLedgerHead: V2_LEDGER_HEAD,
    }),
    lanes,
  };
}

function canaryProof(input: {
  laneId: string;
  permitId: string;
  permitEpoch: number;
  reviewDigest: string;
  attemptSeq: number;
}): MarketBaseResourceValidatedConfirmedCanaryProof {
  return sealMarketBaseResourceValidatedConfirmedCanaryProof({
    laneId: input.laneId,
    attemptSeq: input.attemptSeq,
    permitId: input.permitId,
    permitEpoch: input.permitEpoch,
    evidenceKey: digest(`receipt:${input.attemptSeq}`),
    receiptEventHash: digest(`receipt-event:${input.attemptSeq}`),
    confirmedAt: 5_000 + input.attemptSeq,
    transactionTime: 5_000 + input.attemptSeq,
    actualAmount: 1_000,
    actualTransactionEnergy: 100,
    actualNetCreditsMilli: 500_000,
    reviewDigest: input.reviewDigest,
    ledgerCheckpointHash: V3_LEDGER_CHECKPOINT,
    ledgerReceiptHeadHash: V3_LEDGER_HEAD,
    ledgerPermitAnchorHash: V3_LEDGER_ANCHOR,
  });
}

function continuousReview(
  proof: MarketBaseResourceValidatedConfirmedCanaryProof,
  operatorReviewSnapshotDigest: string,
): MarketBaseResourceReviewedEvidence {
  return {
    laneId: proof.laneId,
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
  };
}

describe("marketBaseResourcePermit", () => {

  test("reviewed evidence 在 112/113 边界与 runtime authority 同步", () => {
    const first = acceptedFirst();
    const current =
      first.state.retainedPermits[first.state.retainedPermits.length - 1];
    if (!current || current.schemaVersion !== 3) {
      throw new Error("missing current v3 permit");
    }
    const evidence = Array.from(
      { length: MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT + 1 },
      (_, index): MarketBaseResourceReviewedEvidence => ({
        laneId: first.lanes[0].laneId,
        kind: "shadow_qualification",
        evidenceKey: digest(`review-boundary-key:${index}`),
        digest: digest(`review-boundary-digest:${index}`),
      }),
    );
    expect(() =>
      buildPermit({
        state: first.state,
        grants: current.signedLaneGrants,
        reviewedEvidence: evidence.slice(
          0,
          MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT,
        ),
      }),
    ).not.toThrow();
    expect(() =>
      buildPermit({
        state: first.state,
        grants: current.signedLaneGrants,
        reviewedEvidence: evidence,
      }),
    ).toThrow("invalid v3 permit reviewed evidence");
  });

  test("同 laneId Canary 一经授权，跨 successor suspend 后也永不得重授权", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "canary",
      newDealGrant: "enabled",
    });
    const canaryPermit = buildPermit({
      state: first.state,
      grants: [canaryGrant],
      reviewedEvidence: [
        {
          laneId: lane.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest("one-shot:qualification"),
          digest: canaryGrant.lifecycleEvidenceDigest,
        },
      ],
    });
    const canaryState = appendOrThrow(first.state, canaryPermit, [lane]);
    const suspendedGrant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "canary",
      newDealGrant: "suspended",
    });
    const suspendedState = appendOrThrow(
      canaryState,
      buildPermit({
        state: canaryState,
        grants: [suspendedGrant],
      }),
      [lane],
    );
    const renewedGrant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "canary",
      newDealGrant: "enabled",
    });
    const renewedPermit = buildPermit({
      state: suspendedState,
      grants: [renewedGrant],
      reviewedEvidence: [
        {
          laneId: lane.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest("one-shot:forged-requalification"),
          digest: renewedGrant.lifecycleEvidenceDigest,
        },
      ],
    });
    expect(
      appendMarketBaseResourcePermit(
        suspendedState,
        renewedPermit,
        appendInput([lane]),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "canary_lane_already_consumed",
    });
  });

  test("数千 generations 的纯批量 compaction 保持 checkpoint JSON 常数尺寸", () => {
    const auditDischarges = Array.from(
      { length: 3_000 },
      (_, index): MarketBaseResourceLaneTombstoneDischarge => {
        const payload = {
          laneId: digest(`bounded-audit-lane:${index}`),
          resource: "X" as const,
          resourcePolicyId: "market-base-resource-policy:X",
          resourcePolicyFingerprint: digest("bounded-audit-resource-policy"),
          roomInstanceId: digest(`bounded-audit-room-instance:${index}`),
          sellerRoom: "E1N2",
          roomFingerprint: digest(`bounded-audit-room:${index}`),
          sharedPolicyFingerprint: digest("bounded-audit-shared-policy"),
          laneStableFingerprint: digest(`bounded-audit-lane-stable:${index}`),
          tombstonedGrantFingerprint: digest(
            `bounded-audit-tombstoned-grant:${index}`,
          ),
          dischargedAtEpoch: index + 1,
          dischargedByPermitId: digest(`bounded-audit-permit:${index}`),
        };
        return {
          ...payload,
          dischargeFingerprint: canonicalStableHashV1({
            domain: "market-base-resource:lane-tombstone-discharge-v1",
            discharge: payload,
          }),
        };
      },
    );
    const checkpointAt2000 = compactMarketBaseResourceLaneTombstonesForAudit(
      auditDischarges.slice(0, 2_000),
    );
    const checkpointAt3000 =
      compactMarketBaseResourceLaneTombstonesForAudit(auditDischarges);

    expect(checkpointAt2000.compressedCount).toBe(1_776);
    expect(checkpointAt3000.compressedCount).toBe(2_776);
    expect(checkpointAt2000.dischargedTombstones).toHaveLength(224);
    expect(checkpointAt3000.dischargedTombstones).toHaveLength(224);
    expect(checkpointAt2000.compressedRetiredLaneFilter).toHaveLength(2_048);
    expect(checkpointAt3000.compressedRetiredLaneFilter).toHaveLength(2_048);
    expect(JSON.stringify(checkpointAt3000).length).toBe(
      JSON.stringify(checkpointAt2000).length,
    );
  });

  test("64-record suffix 压缩保留 ratchet checkpoint，单边篡改失败", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    let state = first.state;
    for (let epoch = 3; epoch <= 66; epoch += 1) {
      const grant = buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "shadow",
        newDealGrant: "suspended",
      });
      state = appendOrThrow(
        state,
        buildPermit({ state, grants: [grant] }),
        [lane],
        { tick: 2_000 + epoch },
      );
    }
    expect(state.retainedPermits).toHaveLength(64);
    expect(state.prefixCheckpoint.prunedThroughEpoch).toBe(2);
    expect(state.prefixCheckpoint.ratchetPermitEpoch).toBe(2);
    expect(validateMarketBaseResourcePermitChain(state)).toEqual({
      ok: true,
    });

    const tampered = clone(state);
    (
      tampered.prefixCheckpoint.ratchetHighWater[0] as {
        ratchetFloor: number;
      }
    ).ratchetFloor += 1;
    expect(validateMarketBaseResourcePermitChain(tampered)).toEqual({
      ok: false,
      reason: "permit_chain_shape_invalid",
    });
  });
});
