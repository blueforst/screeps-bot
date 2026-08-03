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
  test("V2 opaque wrapper 重新验证原始 19 字段与 V2 id/head", () => {
    const raw = legacyV2Raw();
    const wrapped = wrapAuthenticatedLegacyV2PermitRecord({
      rawRecord: raw,
      authenticated: true,
    });
    expect(initialState().currentPermitId).toBe(raw.permitId);

    const tampered = clone(wrapped);
    (
      tampered.rawRecord as unknown as {
        previousLedgerHead: string;
      }
    ).previousLedgerHead = digest("rewritten-v2-ledger-head");
    expect(() =>
      createMarketBaseResourcePermitChainState({
        legacyV2PermitRecords: [tampered],
      }),
    ).toThrow("legacy v2 permit suffix is not continuous");
  });

  test("首个 V3 successor 原子绑定 cutoff、悬停 legacy X 且仅 shadow", () => {
    const first = acceptedFirst();
    expect(hasAcceptedMarketBaseResourceV3Successor(first.state)).toBe(true);
    expect(first.state.legacyV2GrantSuspended).toBe(true);
    expect(first.state.v2EventCutoverCheckpoint).toMatchObject({
      lastV2AttemptSeq: 6,
      lastV2OutcomeSeq: 6,
      v2ReceiptHeadHash: V2_LEDGER_HEAD,
    });
    expect(validateMarketBaseResourcePermitChain(first.state)).toEqual({
      ok: true,
    });
    expect(first.state).toMatchObject({
      totalChainLength: 2,
      permitEpochHighWater: 2,
      retainedPermits: expect.arrayContaining([
        expect.objectContaining({ epoch: 1 }),
        expect.objectContaining({ epoch: 2 }),
      ]),
      prefixCheckpoint: {
        prunedThroughEpoch: 0,
        referencedPermitBindings: [],
      },
    });
    const shortChainHighWater = {
      permitEpochHighWater: first.state.permitEpochHighWater,
      permitChainHeadHighWater: first.state.permitChainHeadHighWater,
      totalChainLength: first.state.totalChainLength,
      prefixCommitment: first.state.prefixCheckpoint.prefixCommitment,
      laneTombstoneCheckpointCommitment:
        first.state.laneTombstoneCheckpoint.checkpointCommitment,
    };
    expect(
      validateMarketBaseResourcePermitChain(first.state, shortChainHighWater),
    ).toEqual({ ok: true });
    expect(
      validateMarketBaseResourcePermitChain(first.state, {
        ...shortChainHighWater,
        permitEpochHighWater: shortChainHighWater.permitEpochHighWater - 1,
      }),
    ).toEqual({ ok: false, reason: "permit_high_water_rollback" });
  });

  test("Permit runtime context 隔离铸造后的外部 nested bit flip", () => {
    const accepted = acceptedFirst().state;
    const anchor = buildMarketBaseResourcePermitRuntimeAnchor(accepted);
    const mutableState = clone(accepted);
    const mutableAnchor = clone(anchor);
    Object.freeze(mutableState);
    Object.freeze(mutableAnchor);
    const result = createMarketBaseResourcePermitRuntimeContext({
      state: mutableState,
      anchor: mutableAnchor,
      tick: 70_000,
    });
    if ("reason" in result) throw new Error(result.reason);
    const mutableCurrent =
      mutableState.retainedPermits[mutableState.retainedPermits.length - 1];
    if (!mutableCurrent || mutableCurrent.schemaVersion !== 3) {
      throw new Error("missing mutable current permit");
    }
    (
      mutableCurrent.signedLaneGrants[0] as unknown as {
        newDealGrant: string;
      }
    ).newDealGrant = "enabled";
    expect(result.context.state.currentPermitId).toBe(accepted.currentPermitId);
    expect(result.context.anchor.currentPermitId).toBe(anchor.currentPermitId);
    const snapshotCurrent = result.context.state.retainedPermits[0];
    expect(
      snapshotCurrent?.schemaVersion === 3
        ? snapshotCurrent.signedLaneGrants[0].newDealGrant
        : undefined,
    ).toBe("suspended");
    expect(Object.isFrozen(result.context.state.retainedPermits[0])).toBe(true);

    const shallowFrozenCacheBasis = clone(accepted);
    Object.freeze(shallowFrozenCacheBasis);
    expect(
      validateMarketBaseResourcePermitChain(shallowFrozenCacheBasis),
    ).toEqual({
      ok: true,
    });
    const cacheCurrent =
      shallowFrozenCacheBasis.retainedPermits[
        shallowFrozenCacheBasis.retainedPermits.length - 1
      ];
    if (!cacheCurrent || cacheCurrent.schemaVersion !== 3) {
      throw new Error("missing shallow cache current permit");
    }
    (
      cacheCurrent.signedLaneGrants[0] as unknown as {
        newDealGrant: string;
      }
    ).newDealGrant = "enabled";
    expect(
      validateMarketBaseResourcePermitChain(shallowFrozenCacheBasis).ok,
    ).toBe(false);
  });

  test("runtime authority 扫描全部 grant bit，悬停字段不构成写权", () => {
    const accepted = acceptedFirst().state;
    const anchor = buildMarketBaseResourcePermitRuntimeAnchor(accepted);
    const forgedEnable = clone(accepted);
    const forgedCurrent =
      forgedEnable.retainedPermits[forgedEnable.retainedPermits.length - 1];
    if (!forgedCurrent || forgedCurrent.schemaVersion !== 3) {
      throw new Error("missing forged current permit");
    }
    (
      forgedCurrent.signedLaneGrants[0] as unknown as {
        newDealGrant: "enabled";
      }
    ).newDealGrant = "enabled";
    expect(
      validateMarketBaseResourcePermitRuntimeGate(forgedEnable, anchor).ok,
    ).toBe(false);

    const suspendedEvidenceMutation = clone(accepted);
    const suspendedCurrent =
      suspendedEvidenceMutation.retainedPermits[
        suspendedEvidenceMutation.retainedPermits.length - 1
      ];
    if (!suspendedCurrent || suspendedCurrent.schemaVersion !== 3) {
      throw new Error("missing suspended current permit");
    }
    (
      suspendedCurrent.signedLaneGrants[0] as unknown as {
        lifecycleEvidenceDigest: string;
      }
    ).lifecycleEvidenceDigest = "suspended-evidence-is-not-runtime-authority";
    expect(
      validateMarketBaseResourcePermitRuntimeGate(
        suspendedEvidenceMutation,
        anchor,
      ),
    ).toEqual({ ok: true });
    expect(
      createMarketBaseResourcePermitRuntimeContext({
        state: suspendedEvidenceMutation,
        anchor,
        tick: 70_001,
      }),
    ).toMatchObject({ ok: true });
  });

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

  test("runtime authority 支持同资源多房间及超过 7 条 continuous grant", () => {
    const roomALanes = derivedRoomLanes("E6N59", "runtime-authority-a");
    const roomBX = derivedLane("E3N59", "X", "runtime-authority-b");
    const scope = [...roomALanes, roomBX];
    let state = acceptedFirst(scope).state;
    const initialPermit =
      state.retainedPermits[state.retainedPermits.length - 1];
    if (!initialPermit || initialPermit.schemaVersion !== 3) {
      throw new Error("missing initial v3 permit");
    }
    let grants = [...initialPermit.signedLaneGrants];
    const proofs = new Map<
      string,
      MarketBaseResourceValidatedConfirmedCanaryProof
    >();

    const replaceGrant = (
      replacement: MarketBaseResourceSignedLaneGrant,
    ): readonly MarketBaseResourceSignedLaneGrant[] =>
      grants.map((grant) =>
        grant.laneId === replacement.laneId ? replacement : grant,
      );
    const appendTransition = (
      nextGrants: readonly MarketBaseResourceSignedLaneGrant[],
      extraEvidence: readonly MarketBaseResourceReviewedEvidence[] = [],
    ): MarketBaseResourcePermit => {
      const continuousEvidence = nextGrants
        .filter(
          (grant) =>
            grant.stage === "continuous" && grant.newDealGrant === "enabled",
        )
        .map((grant) => {
          const proof = proofs.get(grant.laneId);
          if (!proof) throw new Error("missing continuous proof");
          return continuousReview(proof, grant.reviewDigest);
        });
      const permit = buildPermit({
        state,
        grants: nextGrants,
        reviewedEvidence: [...extraEvidence, ...continuousEvidence],
      });
      state = appendOrThrow(state, permit, scope, {
        confirmedCanaryProofs: [...proofs.values()],
      });
      grants = [...nextGrants];
      return permit;
    };
    const enableContinuous = (lane: MarketBaseDerivedLaneLifecycle): void => {
      const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "canary",
        newDealGrant: "enabled",
      });
      const canaryPermit = appendTransition(replaceGrant(canaryGrant), [
        {
          laneId: lane.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest(`runtime-qualification:${lane.laneId}`),
          digest: canaryGrant.lifecycleEvidenceDigest,
        },
      ]);
      const reviewDigest = digest(`runtime-review:${lane.laneId}`);
      proofs.set(
        lane.laneId,
        canaryProof({
          laneId: lane.laneId,
          permitId: canaryPermit.permitId,
          permitEpoch: canaryPermit.epoch,
          reviewDigest: digest(`runtime-confirmation:${lane.laneId}`),
          attemptSeq: 100 + proofs.size,
        }),
      );
      appendTransition(
        replaceGrant(
          buildMarketBaseResourceSignedLaneGrant({
            lane,
            stage: "continuous",
            newDealGrant: "enabled",
            reviewDigest,
          }),
        ),
      );
    };

    for (const lane of roomALanes) enableContinuous(lane);

    const roomAX = roomALanes.find((lane) => lane.resource === "X")!;
    const roomAXGrant = grants.find((grant) => grant.laneId === roomAX.laneId)!;
    appendTransition(
      replaceGrant(
        buildMarketBaseResourceSignedLaneGrant({
          lane: roomAX,
          stage: "continuous",
          newDealGrant: "suspended",
          lifecycleEvidenceDigest: roomAXGrant.lifecycleEvidenceDigest,
          reviewDigest: roomAXGrant.reviewDigest,
        }),
      ),
    );
    enableContinuous(roomBX);
    appendTransition(
      replaceGrant(
        buildMarketBaseResourceSignedLaneGrant({
          lane: roomAX,
          stage: "continuous",
          newDealGrant: "enabled",
          lifecycleEvidenceDigest: roomAXGrant.lifecycleEvidenceDigest,
          reviewDigest: roomAXGrant.reviewDigest,
        }),
      ),
    );

    const current = state.retainedPermits[state.retainedPermits.length - 1];
    if (!current || current.schemaVersion !== 3) {
      throw new Error("missing current v3 permit");
    }
    const enabled = current.signedLaneGrants.filter(
      (grant) => grant.newDealGrant === "enabled",
    );
    expect(enabled).toHaveLength(8);
    expect(enabled.filter((grant) => grant.resource === "X")).toHaveLength(2);
    const anchor = buildMarketBaseResourcePermitRuntimeAnchor(state);
    expect(validateMarketBaseResourcePermitRuntimeGate(state, anchor)).toEqual({
      ok: true,
    });
  });

  test("首个 V3 不能直接赋予 canary 写权", () => {
    const state = initialState();
    const lane = derivedLane("E6N59");
    const permit = buildPermit({
      state,
      grants: [
        buildMarketBaseResourceSignedLaneGrant({
          lane,
          stage: "canary",
          newDealGrant: "enabled",
        }),
      ],
      ledgerHead: V2_LEDGER_HEAD,
    });
    const result = appendMarketBaseResourcePermit(
      state,
      permit,
      appendInput([lane], {
        currentLedgerHead: V2_LEDGER_HEAD,
      }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      reason: "first_v3_grants_must_be_shadow_suspended",
      state,
    });
  });

  test("canary 必须有前序 shadow 与精确 qualification", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "canary",
      newDealGrant: "enabled",
    });
    const missing = buildPermit({
      state: first.state,
      grants: [grant],
    });
    expect(
      appendMarketBaseResourcePermit(first.state, missing, appendInput([lane])),
    ).toMatchObject({
      status: "rejected",
      reason: "canary_requires_prior_suspended_grant_and_qualification",
    });

    const qualified = buildPermit({
      state: first.state,
      grants: [grant],
      reviewedEvidence: [
        {
          laneId: lane.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest(`qualification:${lane.laneId}`),
          digest: grant.lifecycleEvidenceDigest,
        },
      ],
    });
    expect(
      appendMarketBaseResourcePermit(
        first.state,
        qualified,
        appendInput([lane]),
      ).status,
    ).toBe("appended");
  });

  test("append 同时拒绝不足100周期和与外层 high-water 不一致的伪造证据", () => {
    const first = acceptedFirst();
    const trustedLane = first.lanes[0];
    const insufficient = {
      ...trustedLane,
      shadowEvidence: {
        ...trustedLane.shadowEvidence,
        completeCycles: 99,
      },
    };
    expect(validateMarketBaseDerivedLaneLifecycle(insufficient)).toBe(
      "derived_lane_qualification_evidence_incomplete",
    );
    const insufficientGrant = buildMarketBaseResourceSignedLaneGrant({
      lane: insufficient,
      stage: "canary",
      newDealGrant: "enabled",
    });
    const insufficientPermit = buildPermit({
      state: first.state,
      grants: [insufficientGrant],
      reviewedEvidence: [
        {
          laneId: insufficient.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest("qualification:insufficient"),
          digest: insufficientGrant.lifecycleEvidenceDigest,
        },
      ],
    });
    expect(
      appendMarketBaseResourcePermit(first.state, insufficientPermit, {
        ...appendInput([trustedLane]),
        currentDerivedLanes: [insufficient],
      }),
    ).toMatchObject({
      status: "rejected",
      reason: "derived_lane_qualification_evidence_incomplete",
    });

    const forgedEvidence = {
      ...trustedLane,
      shadowEvidence: {
        ...trustedLane.shadowEvidence,
        evidenceDigest: digest("forged-qualified-evidence"),
      },
    };
    expect(
      validateMarketBaseDerivedLaneLifecycle(forgedEvidence),
    ).toBeUndefined();
    const forgedGrant = buildMarketBaseResourceSignedLaneGrant({
      lane: forgedEvidence,
      stage: "canary",
      newDealGrant: "enabled",
    });
    const forgedPermit = buildPermit({
      state: first.state,
      grants: [forgedGrant],
      reviewedEvidence: [
        {
          laneId: forgedEvidence.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest("qualification:forged"),
          digest: forgedGrant.lifecycleEvidenceDigest,
        },
      ],
    });
    expect(
      appendMarketBaseResourcePermit(first.state, forgedPermit, {
        ...appendInput([trustedLane]),
        currentDerivedLanes: [forgedEvidence],
      }),
    ).toMatchObject({
      status: "rejected",
      reason: "lane_lifecycle_checkpoint_mismatch",
    });
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

  test("同资源 canary 排他；其他资源 continuous 可保留", () => {
    const laneA = derivedLane("E6N59", "X");
    const laneB = derivedLane("E3N59", "X");
    const laneH = derivedLane("E4N58", "H");
    const first = acceptedFirst([laneA, laneB]);

    const canaryA = buildMarketBaseResourceSignedLaneGrant({
      lane: laneA,
      stage: "canary",
      newDealGrant: "enabled",
    });
    const shadowB = buildMarketBaseResourceSignedLaneGrant({
      lane: laneB,
      stage: "shadow",
      newDealGrant: "suspended",
    });
    const canaryPermitA = buildPermit({
      state: first.state,
      grants: [canaryA, shadowB],
      reviewedEvidence: [
        {
          laneId: laneA.laneId,
          kind: "shadow_qualification",
          evidenceKey: digest("qualification:a"),
          digest: canaryA.lifecycleEvidenceDigest,
        },
      ],
    });
    const state = appendOrThrow(first.state, canaryPermitA, [laneA, laneB]);

    expect(() =>
      buildPermit({
        state,
        grants: [
          canaryA,
          buildMarketBaseResourceSignedLaneGrant({
            lane: laneB,
            stage: "canary",
            newDealGrant: "enabled",
          }),
        ],
      }),
    ).toThrow("invalid v3 permit lane grants");

    const continuousA = buildMarketBaseResourceSignedLaneGrant({
      lane: laneA,
      stage: "continuous",
      newDealGrant: "enabled",
    });
    const canaryB = buildMarketBaseResourceSignedLaneGrant({
      lane: laneB,
      stage: "canary",
      newDealGrant: "enabled",
    });
    expect(() =>
      buildPermit({
        state,
        grants: [continuousA, canaryB],
      }),
    ).toThrow("invalid v3 permit lane grants");

    const continuousH = buildMarketBaseResourceSignedLaneGrant({
      lane: laneH,
      stage: "continuous",
      newDealGrant: "enabled",
    });
    expect(() =>
      buildPermit({
        state,
        grants: [canaryA, shadowB, continuousH],
      }),
    ).not.toThrow();

    expect(() =>
      buildPermit({
        state,
        grants: [
          continuousA,
          buildMarketBaseResourceSignedLaneGrant({
            lane: laneB,
            stage: "continuous",
            newDealGrant: "enabled",
          }),
        ],
      }),
    ).not.toThrow();
  });

  test("112 active lane 与 tombstone history 分离且 discharge 后旧 lane 不可复活", () => {
    const roomNames = Array.from(
      { length: 16 },
      (_, index) => `E${index + 1}N1`,
    );
    const originalLanes = roomNames.flatMap((roomName) =>
      derivedRoomLanes(roomName),
    );
    expect(originalLanes).toHaveLength(112);
    const first = acceptedFirst(originalLanes);
    const priorPermit =
      first.state.retainedPermits[first.state.retainedPermits.length - 1];
    if (priorPermit.schemaVersion !== 3) {
      throw new Error("expected first v3 permit");
    }

    const replacedRoom = roomNames[15];
    const unchanged = originalLanes.filter(
      (lane) => lane.sellerRoomName !== replacedRoom,
    );
    const replacement = derivedRoomLanes(
      replacedRoom,
      `${replacedRoom}:terminal-b`,
    );
    const nextScope = [...unchanged, ...replacement];
    const priorGrantByLane = new Map(
      priorPermit.signedLaneGrants.map((grant) => [grant.laneId, grant]),
    );
    const activeGrants = nextScope.map(
      (lane) =>
        priorGrantByLane.get(lane.laneId) ??
        buildMarketBaseResourceSignedLaneGrant({
          lane,
          stage: "shadow",
          newDealGrant: "suspended",
        }),
    );
    const retiredGrants = originalLanes
      .filter((lane) => lane.sellerRoomName === replacedRoom)
      .map((lane) => {
        const priorGrant = priorGrantByLane.get(lane.laneId)!;
        return buildMarketBaseResourceSignedLaneGrant({
          lane,
          status: "tombstoned",
          stage: priorGrant.stage,
          newDealGrant: "suspended",
          lifecycleEvidenceDigest: priorGrant.lifecycleEvidenceDigest,
          reviewDigest: priorGrant.reviewDigest,
        });
      });
    const rolloverPermit = buildPermit({
      state: first.state,
      grants: [...activeGrants, ...retiredGrants],
    });
    expect(rolloverPermit.signedLaneGrants).toHaveLength(119);
    const rolloverState = appendOrThrow(first.state, rolloverPermit, nextScope);

    const dischargePermit = buildPermit({
      state: rolloverState,
      grants: activeGrants,
    });
    const dischargedState = appendOrThrow(
      rolloverState,
      dischargePermit,
      nextScope,
    );
    expect(
      dischargedState.laneTombstoneCheckpoint.dischargedTombstones,
    ).toHaveLength(7);
    expect(validateMarketBaseResourcePermitChain(dischargedState)).toEqual({
      ok: true,
    });

    const replacementIds = new Set(replacement.map((lane) => lane.laneId));
    const revivedScope = [
      ...unchanged,
      ...originalLanes.filter((lane) => lane.sellerRoomName === replacedRoom),
    ];
    const revivedGrants = [
      ...activeGrants.filter((grant) => !replacementIds.has(grant.laneId)),
      ...priorPermit.signedLaneGrants.filter(
        (grant) => grant.sellerRoom === replacedRoom,
      ),
    ];
    const revivalPermit = buildPermit({
      state: dischargedState,
      grants: revivedGrants,
    });
    expect(
      appendMarketBaseResourcePermit(
        dischargedState,
        revivalPermit,
        appendInput(revivedScope),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "discharged_lane_reintroduced",
    });
  });

  test("336 条 retirement 保持有界 checkpoint，Bloom 不拒绝 compressed/fresh lane", () => {
    const roomNames = Array.from(
      { length: 16 },
      (_, index) => `E${index + 1}N1`,
    );
    let scope = roomNames.flatMap((roomName) =>
      derivedRoomLanes(roomName, `generation-0:${roomName}`),
    );
    const oldestScope = scope;
    let state = acceptedFirst(scope).state;
    for (let generation = 1; generation <= 3; generation += 1) {
      const prior = state.retainedPermits[state.retainedPermits.length - 1];
      if (prior.schemaVersion !== 3) {
        throw new Error("expected v3 churn predecessor");
      }
      const nextScope = roomNames.flatMap((roomName) =>
        derivedRoomLanes(roomName, `generation-${generation}:${roomName}`),
      );
      const nextActive = nextScope.map((lane) =>
        buildMarketBaseResourceSignedLaneGrant({
          lane,
          stage: "shadow",
          newDealGrant: "suspended",
        }),
      );
      const priorLaneById = new Map(scope.map((lane) => [lane.laneId, lane]));
      const tombstones = prior.signedLaneGrants
        .filter((grant) => grant.status === "active")
        .map((grant) =>
          buildMarketBaseResourceSignedLaneGrant({
            lane: priorLaneById.get(grant.laneId)!,
            status: "tombstoned",
            stage: grant.stage,
            newDealGrant: "suspended",
            lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
            reviewDigest: grant.reviewDigest,
          }),
        );
      state = appendOrThrow(
        state,
        buildPermit({
          state,
          grants: [...nextActive, ...tombstones],
        }),
        nextScope,
      );
      state = appendOrThrow(
        state,
        buildPermit({ state, grants: nextActive }),
        nextScope,
      );
      scope = nextScope;
    }
    expect(state.laneTombstoneCheckpoint.compressedCount).toBe(112);
    expect(state.laneTombstoneCheckpoint.dischargedTombstones).toHaveLength(
      224,
    );
    expect(state.laneTombstoneCheckpoint.compressedPrefixHead).not.toBe(
      state.laneTombstoneCheckpoint.compressedFirstDischargeFingerprint,
    );
    expect(validateMarketBaseResourcePermitChain(state)).toEqual({
      ok: true,
    });

    const freshScope = derivedRoomLanes("E17N1", "fresh-generation");
    const current = state.retainedPermits[state.retainedPermits.length - 1];
    if (!current || current.schemaVersion !== 3) {
      throw new Error("expected current v3 permit");
    }
    const currentLaneById = new Map(scope.map((lane) => [lane.laneId, lane]));
    const freshGrants = freshScope.map((lane) =>
      buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    );
    const currentTombstones = current.signedLaneGrants
      .filter((grant) => grant.status === "active")
      .map((grant) =>
        buildMarketBaseResourceSignedLaneGrant({
          lane: currentLaneById.get(grant.laneId)!,
          status: "tombstoned",
          stage: grant.stage,
          newDealGrant: "suspended",
          lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
          reviewDigest: grant.reviewDigest,
        }),
      );
    const freshState = appendOrThrow(
      state,
      buildPermit({
        state,
        grants: [...freshGrants, ...currentTombstones],
      }),
      freshScope,
    );
    const freshCurrent =
      freshState.retainedPermits[freshState.retainedPermits.length - 1];
    if (!freshCurrent || freshCurrent.schemaVersion !== 3) {
      throw new Error("expected fresh v3 permit");
    }
    expect(
      freshCurrent.signedLaneGrants.filter(
        (grant) => grant.status === "active",
      ),
    ).toHaveLength(freshScope.length);
    expect(validateMarketBaseResourcePermitChain(freshState)).toEqual({
      ok: true,
    });

    const revivalGrants = oldestScope.map((lane) =>
      buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    );
    expect(
      appendMarketBaseResourcePermit(
        state,
        buildPermit({
          state,
          grants: [...revivalGrants, ...currentTombstones],
        }),
        appendInput(oldestScope),
      ),
    ).toMatchObject({ status: "appended" });
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

  test("continuous proof 必须绑定当前 ledger head/checkpoint/anchor", () => {
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
          evidenceKey: digest("qualification"),
          digest: canaryGrant.lifecycleEvidenceDigest,
        },
      ],
    });
    const canaryState = appendOrThrow(first.state, canaryPermit, [lane]);
    const continuousGrant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "continuous",
      newDealGrant: "enabled",
      reviewDigest: digest("continuous-review"),
    });
    const proof = canaryProof({
      laneId: lane.laneId,
      permitId: canaryPermit.permitId,
      permitEpoch: canaryPermit.epoch,
      reviewDigest: digest("confirmed-canary-review"),
      attemptSeq: 7,
    });
    expect(() =>
      buildPermit({
        state: canaryState,
        grants: [
          buildMarketBaseResourceSignedLaneGrant({
            lane,
            stage: "continuous",
            newDealGrant: "enabled",
            reviewDigest: proof.reviewDigest,
          }),
        ],
        reviewedEvidence: [continuousReview(proof, proof.reviewDigest)],
      }),
    ).toThrow("invalid v3 permit reviewed evidence");
    const continuousPermit = buildPermit({
      state: canaryState,
      grants: [continuousGrant],
      reviewedEvidence: [continuousReview(proof, continuousGrant.reviewDigest)],
    });
    expect(
      appendMarketBaseResourcePermit(
        canaryState,
        continuousPermit,
        appendInput([lane], {
          currentLedgerCheckpointHash: digest("wrong-checkpoint"),
          confirmedCanaryProofs: [proof],
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "confirmed_canary_proof_invalid",
    });

    const continuousState = appendOrThrow(
      canaryState,
      continuousPermit,
      [lane],
      { confirmedCanaryProofs: [proof] },
    );
    const suspendedContinuous = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "continuous",
      newDealGrant: "suspended",
      reviewDigest: continuousGrant.reviewDigest,
    });
    const suspendedState = appendOrThrow(
      continuousState,
      buildPermit({
        state: continuousState,
        grants: [suspendedContinuous],
      }),
      [lane],
    );
    const resumedReview = digest("continuous-resume-review");
    const resumedGrant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "continuous",
      newDealGrant: "enabled",
      reviewDigest: resumedReview,
    });
    const resumedPermit = buildPermit({
      state: suspendedState,
      grants: [resumedGrant],
      reviewedEvidence: [continuousReview(proof, resumedReview)],
    });
    expect(
      appendMarketBaseResourcePermit(
        suspendedState,
        resumedPermit,
        appendInput([lane], {
          confirmedCanaryProofs: [proof],
        }),
      ).status,
    ).toBe("appended");
  });

  test("ratchet 高水位提高后不可回退", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "shadow",
      newDealGrant: "suspended",
    });
    const prior = currentRatchet(first.state);
    const raised = prior.map((entry) =>
      entry.resource === "X"
        ? buildMarketBaseResourceRatchetHighWater({
            resource: "X",
            ratchetFloor: entry.ratchetFloor + 100,
            observedAt: entry.observedAt + 1,
            previousFingerprint: entry.fingerprint,
          })
        : entry,
    );
    const raisedPermit = buildPermit({
      state: first.state,
      grants: [grant],
      ratchetHighWater: raised,
    });
    const raisedState = appendOrThrow(first.state, raisedPermit, [lane]);
    const rollback = buildPermit({
      state: raisedState,
      grants: [grant],
      ratchetHighWater: prior,
    });
    expect(
      appendMarketBaseResourcePermit(
        raisedState,
        rollback,
        appendInput([lane]),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "ratchet_high_water_rollback",
    });
  });

  test("首个 V3 之后不得用新 observedAt 重做 bootstrap", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "shadow",
      newDealGrant: "suspended",
    });
    const duplicateBootstrap =
      buildMarketBaseResourceBootstrapRatchetHighWater(2_001);
    const permit = buildPermit({
      state: first.state,
      grants: [grant],
      ratchetHighWater: duplicateBootstrap,
    });
    expect(
      appendMarketBaseResourcePermit(first.state, permit, appendInput([lane])),
    ).toMatchObject({
      status: "rejected",
      reason: "ratchet_high_water_same_floor_rewrite",
    });
  });

  test("未知 permit 的伪造 receipt reference 不得写入 prefix binding", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "shadow",
      newDealGrant: "suspended",
    });
    const successor = buildPermit({
      state: first.state,
      grants: [grant],
    });
    expect(
      appendMarketBaseResourcePermit(
        first.state,
        successor,
        appendInput([lane], {
          receiptPermitReferences: [
            {
              sourceId: digest("fake-receipt"),
              permitId: digest("unknown-permit"),
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "receipt_permit_reference_invalid",
    });
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

  test("epoch 65/129 压缩、pending pin 释放、幂等与 pruned 重签均保持严格边界", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    const epoch2 = first.state.retainedPermits.find(
      (record) => record.schemaVersion === 3 && record.epoch === 2,
    );
    if (!epoch2 || epoch2.schemaVersion !== 3) {
      throw new Error("missing epoch-2 v3 permit");
    }
    const shadowGrant = () =>
      buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "shadow",
        newDealGrant: "suspended",
      });
    let state = first.state;
    for (let epoch = 3; epoch <= 65; epoch += 1) {
      state = appendOrThrow(
        state,
        buildPermit({ state, grants: [shadowGrant()] }),
        [lane],
        { tick: 2_000 + epoch },
      );
    }
    expect(state.totalChainLength).toBe(65);
    expect(state.retainedPermits).toHaveLength(64);
    expect(state.prefixCheckpoint.prunedThroughEpoch).toBe(1);

    const epoch66 = buildPermit({ state, grants: [shadowGrant()] });
    const epoch2Reference = [
      {
        sourceId: digest("receipt-pinning-epoch-2"),
        permitId: epoch2.permitId,
      },
    ];
    expect(
      appendMarketBaseResourcePermit(
        state,
        epoch66,
        appendInput([lane], {
          tick: 2_066,
          activePendingPermitId: epoch2.permitId,
          receiptPermitReferences: epoch2Reference,
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "active_pending_permit_pin",
      state,
    });
    const released = appendMarketBaseResourcePermit(
      state,
      epoch66,
      appendInput([lane], {
        tick: 2_066,
        receiptPermitReferences: epoch2Reference,
      }),
    );
    if (released.status !== "appended") {
      throw new Error(
        `${released.status}:${"reason" in released ? released.reason : ""}`,
      );
    }
    state = released.state;
    expect(state.prefixCheckpoint.prunedThroughEpoch).toBe(2);
    expect(state.prefixCheckpoint.referencedPermitBindings).toContainEqual(
      expect.objectContaining({ permitId: epoch2.permitId, epoch: 2 }),
    );
    const referencedBindingAnchor =
      buildMarketBaseResourcePermitRuntimeAnchor(state);
    const referencedBindingTamper = clone(state);
    const damagedBinding =
      referencedBindingTamper.prefixCheckpoint.referencedPermitBindings[0] as {
        grantDigest: string;
      };
    damagedBinding.grantDigest = digest("damaged-historical-grant-binding");
    const {
      prefixCommitment: _oldReferencedBindingCommitment,
      ...referencedBindingPrefixPayload
    } = referencedBindingTamper.prefixCheckpoint;
    (
      referencedBindingTamper.prefixCheckpoint as unknown as {
        prefixCommitment: string;
      }
    ).prefixCommitment = canonicalStableHashV1({
      domain: "market-base-resource:permit-prefix-v1",
      payload: referencedBindingPrefixPayload,
    });
    // 历史记录已裁剪后，攻击者可把 checkpoint 本身重签为局部自洽；
    // runtime high-water 仍必须把真实 referenced binding 的改写挡住。
    expect(
      validateMarketBaseResourcePermitChain(referencedBindingTamper),
    ).toEqual({ ok: true });
    expect(
      validateMarketBaseResourcePermitRuntimeGate(
        referencedBindingTamper,
        referencedBindingAnchor,
      ).ok,
    ).toBe(false);
    expect(
      appendMarketBaseResourcePermit(
        state,
        state.retainedPermits[state.retainedPermits.length - 1] as MarketBaseResourcePermit,
        appendInput([lane]),
      ),
    ).toMatchObject({ status: "idempotent", state });
    expect(
      appendMarketBaseResourcePermit(state, epoch2, appendInput([lane])),
    ).toMatchObject({
      status: "rejected",
      reason: "pruned_epoch_not_replayable",
    });
    const resignedEpoch2 = buildMarketBaseResourcePermit({
      epoch: epoch2.epoch,
      accountIdentity: epoch2.accountIdentity,
      sharedPolicy: epoch2.sharedPolicy,
      resourcePolicies: epoch2.resourcePolicies,
      ratchetHighWater: epoch2.ratchetHighWater,
      signedLaneGrants: epoch2.signedLaneGrants,
      reviewedEvidence: epoch2.reviewedEvidence,
      previousPermitId: epoch2.previousPermitId,
      previousPermitHead: epoch2.previousPermitHead,
      previousLedgerHead: epoch2.previousLedgerHead,
      v2EventCutoverCheckpoint: epoch2.v2EventCutoverCheckpoint,
      legacyV2GrantSuspension: epoch2.legacyV2GrantSuspension,
      createdAt: epoch2.createdAt + 1,
      operatorAuthorizationFingerprint: digest("resigned-pruned-epoch-2"),
    });
    expect(
      appendMarketBaseResourcePermit(
        state,
        resignedEpoch2,
        appendInput([lane]),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "pruned_epoch_not_replayable",
    });

    const wrongPredecessor = buildMarketBaseResourcePermit({
      epoch: state.permitEpochHighWater + 1,
      accountIdentity: ACCOUNT,
      sharedPolicy: createMarketBaseSharedPolicy(ACCOUNT),
      ratchetHighWater: currentRatchet(state),
      signedLaneGrants: [shadowGrant()],
      previousPermitId: state.currentPermitId,
      previousPermitHead: digest("wrong-suffix-predecessor"),
      previousLedgerHead: V3_LEDGER_HEAD,
      createdAt: 2_067,
      operatorAuthorizationFingerprint: digest("wrong-predecessor-operator"),
    });
    expect(
      appendMarketBaseResourcePermit(
        state,
        wrongPredecessor,
        appendInput([lane]),
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "permit_predecessor_mismatch",
    });

    for (let epoch = 67; epoch <= 129; epoch += 1) {
      state = appendOrThrow(
        state,
        buildPermit({ state, grants: [shadowGrant()] }),
        [lane],
        { tick: 2_000 + epoch },
      );
    }
    expect(state.totalChainLength).toBe(129);
    expect(state.retainedPermits).toHaveLength(64);
    expect(state.prefixCheckpoint.prunedThroughEpoch).toBe(65);
    expect(state.prefixCheckpoint.ratchetPermitEpoch).toBe(65);
    expect(validateMarketBaseResourcePermitChain(state)).toEqual({ ok: true });

    const wrongOutcomeCutoff = clone(state);
    (
      wrongOutcomeCutoff as unknown as {
        v2EventCutoverCheckpoint: ReturnType<
          typeof buildMarketBaseResourceV2EventCutoverCheckpoint
        >;
      }
    ).v2EventCutoverCheckpoint = buildMarketBaseResourceV2EventCutoverCheckpoint({
      lastV2AttemptSeq: 7,
      lastV2OutcomeSeq: 7,
      v2ReceiptHeadHash: V2_LEDGER_HEAD,
      v2LedgerCheckpointHash: V2_LEDGER_CHECKPOINT,
    });
    expect(validateMarketBaseResourcePermitChain(wrongOutcomeCutoff)).toEqual({
      ok: false,
      reason: "permit_cutover_prefix_commitment_mismatch",
    });
    const wrongReceiptCutoff = clone(state);
    (
      wrongReceiptCutoff as unknown as {
        v2EventCutoverCheckpoint: ReturnType<
          typeof buildMarketBaseResourceV2EventCutoverCheckpoint
        >;
      }
    ).v2EventCutoverCheckpoint = buildMarketBaseResourceV2EventCutoverCheckpoint({
      lastV2AttemptSeq: 6,
      lastV2OutcomeSeq: 6,
      v2ReceiptHeadHash: digest("wrong-cutoff-receipt-head"),
      v2LedgerCheckpointHash: V2_LEDGER_CHECKPOINT,
    });
    expect(validateMarketBaseResourcePermitChain(wrongReceiptCutoff)).toEqual({
      ok: false,
      reason: "permit_cutover_prefix_commitment_mismatch",
    });
    const brokenSuffixPredecessor = clone(state);
    (
      brokenSuffixPredecessor.retainedPermits[0] as unknown as {
        previousPermitHead: string;
      }
    ).previousPermitHead = digest("broken-retained-suffix-predecessor");
    expect(
      validateMarketBaseResourcePermitChain(brokenSuffixPredecessor),
    ).toEqual({ ok: false, reason: "permit_suffix_invalid" });
  });

  test("512 receipt + 112 active-review 经真实 append/compaction 在 624/625 精确边界 fail closed", () => {
    const first = acceptedFirst();
    const lane = first.lanes[0];
    let state = first.state;
    for (let epoch = 3; epoch <= 66; epoch += 1) {
      state = appendOrThrow(
        state,
        buildPermit({
          state,
          grants: [
            buildMarketBaseResourceSignedLaneGrant({
              lane,
              stage: "shadow",
              newDealGrant: "suspended",
            }),
          ],
        }),
        [lane],
        { tick: 3_000 + epoch },
      );
    }
    const bindings = Array.from(
      { length: MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT },
      (_, index) => ({
        permitId: digest(`binding-boundary-permit:${index}`),
        epoch: (index % state.prefixCheckpoint.prunedThroughEpoch) + 1,
        selfHash: digest(`binding-boundary-self:${index}`),
        grantDigest: digest(`binding-boundary-grant:${index}`),
        reviewDigest: digest(`binding-boundary-review:${index}`),
      }),
    );
    const checkpoint = clone(state.prefixCheckpoint) as unknown as {
      prefixCommitment: string;
      referencedPermitBindings: typeof bindings;
    };
    checkpoint.referencedPermitBindings = bindings;
    const { prefixCommitment: _old, ...payload } = checkpoint;
    checkpoint.prefixCommitment = canonicalStableHashV1({
      domain: "market-base-resource:permit-prefix-v1",
      payload,
    });
    const sourceState = clone(state);
    (
      sourceState as unknown as {
        prefixCheckpoint: typeof checkpoint;
      }
    ).prefixCheckpoint = checkpoint;
    expect(validateMarketBaseResourcePermitChain(sourceState)).toEqual({
      ok: true,
    });

    const activeLanes = Array.from({ length: 16 }, (_, index) =>
      derivedRoomLanes(`E${index + 1}N59`),
    ).flat();
    expect(activeLanes).toHaveLength(
      MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT,
    );
    const grants = activeLanes.map((activeLane) =>
      buildMarketBaseResourceSignedLaneGrant({
        lane: activeLane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    );
    const reviewBindings = bindings.slice(
      MARKET_BASE_RESOURCE_RECEIPT_REFERENCE_LIMIT,
    );
    const reviewedEvidence = activeLanes.map((activeLane, index) => ({
      laneId: activeLane.laneId,
      kind: "suspension_review" as const,
      evidenceKey: digest(`binding-boundary-review-key:${index}`),
      digest: digest(`binding-boundary-review-digest:${index}`),
      permitId: reviewBindings[index]!.permitId,
    }));
    const successor = buildPermit({
      state: sourceState,
      grants,
      reviewedEvidence,
    });
    const receiptPermitReferences = bindings
      .slice(0, MARKET_BASE_RESOURCE_RECEIPT_REFERENCE_LIMIT)
      .map((binding, index) => ({
        sourceId: digest(`binding-boundary-receipt:${index}`),
        permitId: binding.permitId,
      }));
    const activeReviewPermitReferences = activeLanes.map(
      (activeLane, index) => ({
        sourceId: activeLane.laneId,
        permitId: reviewBindings[index]!.permitId,
      }),
    );
    const exactBoundary = appendMarketBaseResourcePermit(
      sourceState,
      successor,
      appendInput(activeLanes, {
        receiptPermitReferences,
        activeReviewPermitReferences,
      }),
    );
    expect(exactBoundary.status).toBe("appended");
    if (exactBoundary.status !== "appended") {
      throw new Error(
        `${exactBoundary.status}:${"reason" in exactBoundary ? exactBoundary.reason : ""}`,
      );
    }
    expect(
      exactBoundary.state.prefixCheckpoint.referencedPermitBindings,
    ).toHaveLength(MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT);
    expect(validateMarketBaseResourcePermitChain(exactBoundary.state)).toEqual(
      { ok: true },
    );

    const retainedSource = sourceState.retainedPermits[0];
    expect(retainedSource).toBeDefined();
    expect(
      appendMarketBaseResourcePermit(
        sourceState,
        successor,
        appendInput(activeLanes, {
          receiptPermitReferences: [
            ...receiptPermitReferences,
            {
              sourceId: digest("binding-boundary-receipt:625"),
              permitId: retainedSource!.permitId,
            },
          ],
          activeReviewPermitReferences,
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "permit_binding_bound_exceeded",
    });
  });

  test("tombstoned lane 不得冒充 active review binding source", () => {
    const oldLane = derivedLane("E6N59", "X", "tombstone-reference-old");
    const nextLane = derivedLane("E3N59", "X", "tombstone-reference-next");
    const first = acceptedFirst([oldLane]);
    const current =
      first.state.retainedPermits[
        first.state.retainedPermits.length - 1
      ];
    if (!current || current.schemaVersion !== 3) {
      throw new Error("missing current v3 permit");
    }
    const tombstoneGrant = buildMarketBaseResourceSignedLaneGrant({
      lane: oldLane,
      status: "tombstoned",
      stage: "shadow",
      newDealGrant: "suspended",
      lifecycleEvidenceDigest: current.signedLaneGrants[0].lifecycleEvidenceDigest,
      reviewDigest: current.signedLaneGrants[0].reviewDigest,
    });
    const nextGrant = buildMarketBaseResourceSignedLaneGrant({
      lane: nextLane,
      stage: "shadow",
      newDealGrant: "suspended",
    });
    const moved = appendOrThrow(
      first.state,
      buildPermit({
        state: first.state,
        grants: [nextGrant, tombstoneGrant],
      }),
      [nextLane],
    );
    const review = {
      laneId: oldLane.laneId,
      kind: "suspension_review" as const,
      evidenceKey: digest("tombstoned-review-source"),
      digest: digest("tombstoned-review-digest"),
      permitId: current.permitId,
    };
    const illegal = buildPermit({
      state: moved,
      grants: [nextGrant, tombstoneGrant],
      reviewedEvidence: [review],
    });
    expect(
      appendMarketBaseResourcePermit(
        moved,
        illegal,
        appendInput([nextLane], {
          activeReviewPermitReferences: [
            { sourceId: oldLane.laneId, permitId: current.permitId },
          ],
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "review_permit_reference_invalid",
    });
  });
});
