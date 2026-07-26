import {
  LEGACY_V1_SAFE_FIXTURE_DIGEST,
  LEGACY_X_V1_OUTCOME_DIGEST,
  LEGACY_X_V1_OUTCOME_GOLDEN,
  LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST,
  acceptMarketDirectContinuousPermit,
  migrateLegacyDirectToContinuous,
  normalizeContinuousDirectState,
  proposeMarketDirectContinuousPermit,
  runMarketDirectContinuousPlanning,
  runMarketDirectContinuousPreflight,
  type MarketDirectContinuousAutomationInput,
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousDependencies,
  type MarketDirectContinuousRuntimeCandidate,
  type MarketDirectContinuousTerminalSnapshot,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  CONTINUOUS_PERMIT_GENESIS,
  CONTINUOUS_RECEIPT_GENESIS,
  LEGACY_X_PROCESSED_EVIDENCE_KEY,
  continuousConfirmedCanaryCheckpointCommitment,
} from "@/runtime/marketDirectContinuousLedger";
import {
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
  canonicalStableHashV1,
  marketDirectContinuousLegacyXOutcomeFingerprint,
  observeMarketDirectShadowCycle,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
  resolveMarketSaleAutomationConfig,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  createDirectAutomationState,
  normalizeDirectAutomationState,
  type DirectAutomationState,
} from "@/runtime/marketSaleDirectAutomation";
import type { DirectOutgoingTransaction } from "@/runtime/marketSaleDirectPending";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import {
  getMarketProtectionEntryKey,
  type MarketProtectionEntry,
  type MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";

const MIGRATION_TICK = 72_587_210;
const RUN_TICK = MIGRATION_TICK + 2_000;
const ACCOUNT_IDENTITY = "screeps-account:fixture";
const OPERATOR_AUTHORIZATION = "operator-authorization:fixture";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function exactLegacyState(): DirectAutomationState {
  const state = createDirectAutomationState();
  state.directDealOutcomes = [clone(LEGACY_X_V1_OUTCOME_GOLDEN)];
  state.processedDirectTransactionKeys = [
    LEGACY_X_PROCESSED_EVIDENCE_KEY,
  ];
  state.directConfirmedDealCount = 1;
  state.directPausedForReview = true;
  return state;
}

function continuousConfig(): ResolvedMarketSaleAutomationConfig {
  const config = resolveMarketSaleAutomationConfig({
    mode: "direct",
    directCapability: "continuous-v2",
    configRevision: MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
    sellResources: [
      RESOURCE_CATALYST,
      RESOURCE_HYDROGEN,
      RESOURCE_ZYNTHIUM,
    ],
    hardFloor: {
      [RESOURCE_CATALYST]: 600,
      [RESOURCE_HYDROGEN]: 428,
      [RESOURCE_ZYNTHIUM]: 43,
    },
    economicFloor: {
      [RESOURCE_CATALYST]: 600,
      [RESOURCE_HYDROGEN]: 451,
      [RESOURCE_ZYNTHIUM]: 45,
    },
    forecastBuffer: {
      [RESOURCE_CATALYST]: 100_000,
      [RESOURCE_HYDROGEN]: 100_000,
      [RESOURCE_ZYNTHIUM]: 100_000,
    },
    minDealAmount: 1_000,
    makerBatchAmount: 5_000,
    creditReserve: 0,
    terminalEnergyReserve: 25_000,
    maxDirectDealAmount: 1_000,
    maxDirectDealsPerCycle: 1,
    minDirectOrderAmount: 1_000,
    minDirectOrderNotional: 600_000,
    maxDirectRawOrdersScannedPerCycle: 1_000,
    maxDirectEligibleOrdersPricedPerCycle: 200,
    maxDirectTransactionEnergy: 1_000,
    directCanaryMaxConfirmedDeals: 1,
    energyShadowHardFloor: 20,
    planningSnapshotMaxAgeTicks: 10,
    minHistoryDays: 7,
    minHistoryTransactions: 100,
    minHistoryVolume: 100_000,
    historyFloorRatio: 0.95,
    historyMaxAgeDays: 2,
    canary: { enabled: true, allowExpansion: false },
  });
  if (!config.validForPlanning || config.invalidReasons.length > 0) {
    throw new Error(
      `continuous test config invalid: ${config.invalidReasons.join(
        ",",
      )}`,
    );
  }
  return config;
}

function acceptedXState(): MarketDirectContinuousAutomationState {
  const migrated = migrateLegacyDirectToContinuous(
    exactLegacyState(),
    MIGRATION_TICK,
  );
  const proposal = proposeMarketDirectContinuousPermit(
    migrated,
    MIGRATION_TICK + 1,
    ACCOUNT_IDENTITY,
    {
      operatorAuthorizationFingerprint:
        OPERATOR_AUTHORIZATION,
    },
  );
  if (!proposal.ok || !proposal.permit) {
    throw new Error(`genesis proposal failed: ${proposal.error}`);
  }
  const accepted = acceptMarketDirectContinuousPermit(
    proposal.state,
    MIGRATION_TICK + 2,
    proposal.permit.permitId,
    MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  );
  if (!accepted.ok) {
    throw new Error(`genesis accept failed: ${accepted.error}`);
  }
  return accepted.state;
}

function acceptedAllWritableState():
  MarketDirectContinuousAutomationState {
  const state = acceptedXState();
  const shadowEntryIds = [
    "base-h-e3n59-v1",
    "base-z-e7n57-v1",
  ];
  for (let cycle = 1; cycle <= 100; cycle += 1) {
    for (const entryId of shadowEntryIds) {
      const lifecycle = state.lifecycleByEntry[entryId];
      const policy = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
        (entry) => entry.entryId === entryId,
      )!;
      state.lifecycleByEntry[entryId] =
        observeMarketDirectShadowCycle(lifecycle, {
          tick: MIGRATION_TICK + 2 + cycle,
          result: "safe_no_opportunity",
          resourceFingerprint: policy.resourceFingerprint,
          sharedFingerprint: lifecycle.sharedFingerprint,
        });
    }
  }
  const proposal = proposeMarketDirectContinuousPermit(
    state,
    MIGRATION_TICK + 103,
    ACCOUNT_IDENTITY,
    {
      operatorAuthorizationFingerprint:
        "operator-authorization:all-canaries",
      entryStages: {
        "base-h-e3n59-v1": "canary",
        "base-z-e7n57-v1": "canary",
      },
    },
  );
  if (!proposal.ok || !proposal.permit) {
    throw new Error(`canary proposal failed: ${proposal.error}`);
  }
  const accepted = acceptMarketDirectContinuousPermit(
    proposal.state,
    MIGRATION_TICK + 104,
    proposal.permit.permitId,
    MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  );
  if (!accepted.ok) {
    throw new Error(`canary accept failed: ${accepted.error}`);
  }
  return accepted.state;
}

function seedShadowCycle(
  state: MarketDirectContinuousAutomationState,
  entryId: string,
  tick: number,
): void {
  const lifecycle = state.lifecycleByEntry[entryId];
  const policy = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
    (entry) => entry.entryId === entryId,
  )!;
  state.lifecycleByEntry[entryId] =
    observeMarketDirectShadowCycle(lifecycle, {
      tick,
      result: "safe_no_opportunity",
      resourceFingerprint: policy.resourceFingerprint,
      sharedFingerprint: lifecycle.sharedFingerprint,
    });
}

function runtimeCandidate(
  entryId: string,
  tick: number,
): MarketDirectContinuousRuntimeCandidate {
  const entry = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
    (candidate) => candidate.entryId === entryId,
  )!;
  return {
    roomName: entry.allowedRoomNames[0],
    resourceType: entry.resourceType,
    historyTrusted: true,
    historyFloor: entry.economicFloor,
    ratchetFloor: entry.economicFloor,
    effectiveNetFloor: Math.max(
      entry.hardFloor,
      entry.economicFloor,
    ),
    effectiveEnergyShadowPrice: 20,
    energyShadowObservedAt: tick,
    energyShadowComponents: {
      hardFloor: 20,
      historyFloor: 20,
      ratchetFloor: 20,
    },
    capacityState: "pressure",
    isHubRoom: false,
    rejectionReasons: [],
  };
}

function runtimeCandidates(
  tick: number,
): MarketDirectContinuousRuntimeCandidate[] {
  return MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) =>
    runtimeCandidate(entry.entryId, tick),
  );
}

function order(
  id: string,
  resourceType: ResourceConstant,
  price: number,
  amount: number,
  roomName: string,
): MarketOrderSnapshot {
  return {
    id,
    type: "buy",
    resourceType,
    price,
    amount,
    remainingAmount: amount,
    totalAmount: amount,
    roomName,
    created: 1,
  };
}

function terminal(
  resourceType: ResourceConstant,
): MarketDirectContinuousTerminalSnapshot {
  const entry = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
    (candidate) => candidate.resourceType === resourceType,
  )!;
  return {
    roomName: entry.allowedRoomNames[0],
    owned: true,
    resourceAmount: 200_000,
    energy: 50_000,
    cooldown: 0,
    nativeMineralType: entry.requireNativeMineral
      ? entry.resourceType
      : RESOURCE_OXYGEN,
  };
}

function protectionEntry(
  tick: number,
  resourceType: ResourceConstant,
): MarketProtectionEntry {
  const entry = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
    (candidate) => candidate.resourceType === resourceType,
  )!;
  return {
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    roomName: entry.allowedRoomNames[0],
    resource: resourceType,
    totalStock: 200_000,
    terminalStock: 200_000,
    hardReserve: 100_000,
    localReserve: 100_000,
    absoluteTarget: 0,
    consumptiveDemand: 0,
    boostWar: 0,
    hubCommitments: 0,
    productionDemand: 0,
    forecastBuffer: 100_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 100_000,
    grossSurplus: 100_000,
    managedExposure: 0,
    newExposureCapacity: 100_000,
    sellableAmount: 100_000,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
  };
}

function protectionLedger(
  tick: number,
): MarketSaleProtectionLedger {
  const entries: Record<string, MarketProtectionEntry> = {};
  for (const resource of [
    RESOURCE_CATALYST,
    RESOURCE_HYDROGEN,
    RESOURCE_ZYNTHIUM,
  ]) {
    const entry = protectionEntry(tick, resource);
    entries[
      getMarketProtectionEntryKey(entry.roomName, resource)
    ] = entry;
  }
  return {
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    currentTick: tick,
    fresh: true,
    entries,
    blockedEntryCount: 0,
    globalBlocked: false,
    globalIssues: [],
  };
}

type SecondReadMutation =
  | "order"
  | "credits"
  | "protection"
  | "terminal"
  | "shadow_order";

interface RuntimeHarness {
  tick: number;
  ordersByResource: Partial<
    Record<ResourceConstant, MarketOrderSnapshot[]>
  >;
  ownOrders?: MarketOrderSnapshot[];
  outgoingTransactions?: DirectOutgoingTransaction[];
  accountIdentity?: string;
  productionIntent?: boolean;
  protectionGlobalBlocked?: boolean;
  scopedProtectionBlockedResource?: ResourceConstant;
  missingTerminalResource?: ResourceConstant;
  secondReadMutation?: SecondReadMutation;
  claimResult?: boolean;
  executeResult?: ScreepsReturnCode;
  calculateEnergy?: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number;
  onClaim?: (
    request: Parameters<
      MarketDirectContinuousDependencies["claimPrepared"]
    >[0],
  ) => void;
  onExecute?: (
    request: Parameters<
      MarketDirectContinuousDependencies["executePrepared"]
    >[0],
  ) => void;
  onRelease?: (requestId: string) => void;
}

function dependenciesFor(
  harness: RuntimeHarness,
): MarketDirectContinuousDependencies {
  const orderReads: Record<string, number> = {};
  const terminalReads: Record<string, number> = {};
  let creditReads = 0;
  let protectionReads = 0;
  return {
    readCurrentBuyOrders: jest.fn((resource) => {
      const key = String(resource);
      orderReads[key] = (orderReads[key] || 0) + 1;
      const orders = clone(
        harness.ordersByResource[resource] || [],
      );
      if (
        (harness.secondReadMutation === "order" ||
          harness.secondReadMutation === "shadow_order") &&
        resource ===
          (harness.secondReadMutation === "shadow_order"
            ? RESOURCE_HYDROGEN
            : RESOURCE_CATALYST) &&
        orderReads[key] === 2 &&
        orders[0]
      ) {
        orders[0].remainingAmount =
          (orders[0].remainingAmount ?? orders[0].amount) - 1;
      }
      return orders;
    }),
    readOwnOrders: jest.fn(() => clone(harness.ownOrders || [])),
    readTerminal: jest.fn((_roomName, resource) => {
      const key = String(resource);
      terminalReads[key] = (terminalReads[key] || 0) + 1;
      if (harness.missingTerminalResource === resource) {
        return undefined;
      }
      const snapshot = terminal(resource);
      if (
        harness.secondReadMutation === "terminal" &&
        resource === RESOURCE_CATALYST &&
        terminalReads[key] === 2
      ) {
        snapshot.resourceAmount -= 1;
      }
      return snapshot;
    }),
    readProtection: jest.fn(() => {
      protectionReads += 1;
      const ledger = protectionLedger(harness.tick);
      if (harness.protectionGlobalBlocked) {
        ledger.globalBlocked = true;
        ledger.globalIssues = [
          {
            code: "protection_stale",
            detail: "fixture global source incomplete",
          },
        ];
      }
      if (harness.scopedProtectionBlockedResource) {
        const resource = harness.scopedProtectionBlockedResource;
        const entry = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
          (candidate) => candidate.resourceType === resource,
        )!;
        const key = getMarketProtectionEntryKey(
          entry.allowedRoomNames[0],
          resource,
        );
        ledger.entries[key].blocked = true;
        ledger.entries[key].blockedReasons = [
          "protection_donor_unbound",
        ];
        ledger.entries[key].issues = [
          {
            code: "protection_donor_unbound",
            detail: "fixture scoped protection blocker",
          },
        ];
        ledger.blockedEntryCount = 1;
      }
      if (
        harness.secondReadMutation === "protection" &&
        protectionReads === 2
      ) {
        const key = getMarketProtectionEntryKey(
          "E6N59",
          RESOURCE_CATALYST,
        );
        ledger.entries[key].grossSurplus -= 1;
        ledger.entries[key].sellableAmount -= 1;
      }
      return ledger;
    }),
    readCredits: jest.fn(() => {
      creditReads += 1;
      return harness.secondReadMutation === "credits" &&
        creditReads === 2
        ? 9_999_999
        : 10_000_000;
    }),
    readOutgoingWindow: jest.fn(() => {
      const transactions = clone(
        harness.outgoingTransactions || [],
      );
      const times = transactions.map(
        (transaction) => transaction.time,
      );
      return {
        observedAt: harness.tick,
        coversAttemptAt: true,
        transactions,
        oldestTime:
          times.length > 0 ? Math.min(...times) : undefined,
        newestTime:
          times.length > 0 ? Math.max(...times) : undefined,
      };
    }),
    calculateTransactionEnergy: jest.fn(
      (amount, fromRoomName, toRoomName) =>
        harness.calculateEnergy?.(
          amount,
          fromRoomName,
          toRoomName,
        ) ?? 0,
    ),
    readAccountIdentity: jest.fn(
      () => harness.accountIdentity ?? ACCOUNT_IDENTITY,
    ),
    readExecutorShard: jest.fn(
      () => MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
    ),
    hasProductionMarketIntent: jest.fn(
      () => harness.productionIntent === true,
    ),
    readArbiterSnapshot: jest.fn(() => ({
      blocked: false,
      revision: `arbiter:${harness.tick}`,
    })),
    claimPrepared: jest.fn((request) => {
      harness.onClaim?.(request);
      return harness.claimResult ?? true;
    }),
    executePrepared: jest.fn((request) => {
      harness.onExecute?.(request);
      return harness.executeResult ?? OK;
    }),
    releasePrepared: jest.fn((requestId) => {
      harness.onRelease?.(requestId);
      return true;
    }),
  };
}

function automationInput(
  tick: number,
): MarketDirectContinuousAutomationInput {
  return {
    tick,
    fullPlanningTick: true,
    config: continuousConfig(),
    candidates: runtimeCandidates(tick),
    makerExposurePresent: false,
    emergencyStop: false,
  };
}

describe("Continuous Direct automation state and permits", () => {
  it("仅用完整冻结 v1 证据确定性迁移，并保留 reviewed X 与 genesis 账本", () => {
    expect(
      canonicalStableHashV1(clone(LEGACY_X_V1_OUTCOME_GOLDEN)),
    ).toBe(LEGACY_X_V1_OUTCOME_DIGEST);
    expect(
      marketDirectContinuousLegacyXOutcomeFingerprint(
        clone(LEGACY_X_V1_OUTCOME_GOLDEN),
      ),
    ).toBe(LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST);

    const first = migrateLegacyDirectToContinuous(
      exactLegacyState(),
      MIGRATION_TICK,
    );
    const repeated = migrateLegacyDirectToContinuous(
      exactLegacyState(),
      MIGRATION_TICK,
    );

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: MARKET_DIRECT_CONTINUOUS_SCHEMA,
      capability: MARKET_DIRECT_CONTINUOUS_CAPABILITY,
      migrationStatus: "readyForPermit",
      rollbackEvidenceMarker:
        "market-direct-continuous:v2:migrated-from-669bce3",
      legacyStateDigest: LEGACY_V1_SAFE_FIXTURE_DIGEST,
      reviewedLegacyOutcomeDigest: LEGACY_X_V1_OUTCOME_DIGEST,
      directConfirmedDealCount: 1,
      directPausedForReview: true,
      lastLifecycleAppliedAttemptSeq: 1,
    });
    expect(first.currentPermit).toBeUndefined();
    expect(first.proposedPermit).toBeUndefined();
    expect(first.permitChain).toEqual({
      currentPermitEpoch: 0,
      currentPermitId: "",
      permitChainHead: CONTINUOUS_PERMIT_GENESIS,
      permitEpochHighWater: 0,
      permitChainHeadHighWater: CONTINUOUS_PERMIT_GENESIS,
      permits: [],
    });

    expect(first.lifecycleByEntry["base-x-e6n59-v1"]).toMatchObject({
      entryId: "base-x-e6n59-v1",
      stage: "review_paused",
      canaryConfirmedAt: 72_585_530,
      canaryConfirmedCount: 1,
      evidenceHistory: [
        {
          kind: "legacy_reviewed_canary",
          digest: LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST,
          recordedAt: 72_585_530,
        },
      ],
    });
    expect(first.lifecycleByEntry["base-h-e3n59-v1"]).toMatchObject({
      stage: "shadow",
      consecutiveCompleteCycles: 0,
      canaryConfirmedCount: 0,
    });
    expect(first.lifecycleByEntry["base-z-e7n57-v1"]).toMatchObject({
      stage: "shadow",
      consecutiveCompleteCycles: 0,
      canaryConfirmedCount: 0,
    });

    expect(first.ledger).toMatchObject({
      schema: MARKET_DIRECT_CONTINUOUS_SCHEMA,
      finalizedAttemptSeq: 1,
      nextAttemptSeq: 2,
      permitEpochHighWater: 0,
      permitChainHeadHighWater: CONTINUOUS_PERMIT_GENESIS,
      lifetimeConfirmed: {
        global: { count: 1, amount: 1_000 },
        resources: { X: { count: 1, amount: 1_000 } },
      },
      processedEvidenceKeys: [
        {
          attemptSeq: 1,
          key: LEGACY_X_PROCESSED_EVIDENCE_KEY,
        },
      ],
    });
    expect(first.ledger.receiptHeadHash).not.toBe(
      CONTINUOUS_RECEIPT_GENESIS,
    );
    expect(first.ledger.receipts).toEqual([
      expect.objectContaining({
        attemptSeq: 1,
        executionPolicy: "legacy_canary_seed",
        status: "confirmed",
        permitEpoch: 0,
        entryId: "base-x-e6n59-v1",
        resource: "X",
        sellerRoom: "E6N59",
        orderRoom: "E21S49",
        plannedAmount: 1_000,
        actualAmount: 1_000,
        actualTransactionEnergy: 394,
        actualNetCreditsMilli: 682_331_360,
        evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
      }),
    ]);
    expect(first.ledger.migrationAttestation).toMatchObject({
      migrationTick: MIGRATION_TICK,
      legacyStateDigest: LEGACY_V1_SAFE_FIXTURE_DIGEST,
      reviewedOutcomeDigest: LEGACY_X_V1_OUTCOME_DIGEST,
      seedLedgerHead: first.ledger.receiptHeadHash,
    });
    expect(first.directDealOutcomes).toEqual([
      LEGACY_X_V1_OUTCOME_GOLDEN,
    ]);
    expect(first.processedDirectTransactionKeys).toEqual([
      LEGACY_X_PROCESSED_EVIDENCE_KEY,
    ]);

    expect(
      normalizeContinuousDirectState(clone(first), MIGRATION_TICK),
    ).toEqual(first);
  });

  it.each([
    [
      "完整 outcome 任一字段变化",
      (state: DirectAutomationState) => {
        state.directDealOutcomes[0].observedOrderPrice = 694.964;
      },
    ],
    [
      "processed key 不精确",
      (state: DirectAutomationState) => {
        state.processedDirectTransactionKeys[0] = "wrong:key";
      },
    ],
    [
      "存在未决交易",
      (state: DirectAutomationState) => {
        state.pendingDirectDeals["unexpected"] = {} as never;
      },
    ],
    [
      "存在额外 outcome",
      (state: DirectAutomationState) => {
        state.directDealOutcomes.push(
          clone(LEGACY_X_V1_OUTCOME_GOLDEN),
        );
      },
    ],
  ])("%s 时迁移 fail-close 且不生成可用 permit", (_label, mutate) => {
    const legacy = exactLegacyState();
    mutate(legacy);

    const blocked = migrateLegacyDirectToContinuous(
      legacy,
      MIGRATION_TICK,
    );

    expect(blocked).toMatchObject({
      schemaVersion: MARKET_DIRECT_CONTINUOUS_SCHEMA,
      capability: MARKET_DIRECT_CONTINUOUS_CAPABILITY,
      migrationStatus: "blocked",
      migrationBlockedReason:
        "direct_migration_evidence_mismatch",
      directConfirmedDealCount: 0,
      directPausedForReview: true,
      lifecycleByEntry: {},
      pendingDirectDeals: {},
      directDealOutcomes: [],
      processedDirectTransactionKeys: [],
    });
    expect(blocked.currentPermit).toBeUndefined();
    expect(blocked.proposedPermit).toBeUndefined();
    expect(blocked.ledger).toMatchObject({
      receiptHeadHash: CONTINUOUS_RECEIPT_GENESIS,
      finalizedAttemptSeq: 0,
      nextAttemptSeq: 1,
      receipts: [],
      outcomes: [],
      blocker: {
        code: "direct_migration_evidence_mismatch",
        detectedAt: MIGRATION_TICK,
      },
    });
    expect(
      Object.keys(blocked.quarantinedPendingDirectDeals),
    ).toEqual([
      "__continuous_blocked__:direct_migration_evidence_mismatch",
    ]);

    const proposal = proposeMarketDirectContinuousPermit(
      blocked,
      MIGRATION_TICK + 1,
      ACCOUNT_IDENTITY,
      {
        operatorAuthorizationFingerprint:
          OPERATOR_AUTHORIZATION,
      },
    );
    expect(proposal).toEqual({
      ok: false,
      state: blocked,
      error: "direct_migration_evidence_mismatch",
    });
  });

  it("legacy 计数越过唯一 canary 时按 rollback evidence lost 永久闭锁", () => {
    const legacy = exactLegacyState();
    legacy.directConfirmedDealCount = 2;

    const blocked = migrateLegacyDirectToContinuous(
      legacy,
      MIGRATION_TICK,
    );

    expect(blocked.migrationStatus).toBe("blocked");
    expect(blocked.migrationBlockedReason).toBe(
      "rollback_evidence_lost",
    );
    expect(blocked.ledger.blocker?.code).toBe(
      "rollback_evidence_lost",
    );
    expect(blocked.ledger.receipts).toEqual([]);
    expect(blocked.lifecycleByEntry).toEqual({});
  });

  it("669bce3 old normalizer 受控回滚后只留下 unsupported blocker，再升级永久闭锁", () => {
    const v2 = migrateLegacyDirectToContinuous(
      exactLegacyState(),
      MIGRATION_TICK,
    );
    const oldBundleProjection =
      normalizeDirectAutomationState(
        v2 as unknown as DirectAutomationState,
      );

    expect(oldBundleProjection).toMatchObject({
      schemaVersion: 1,
      migrationBlockedReason:
        "unsupported_direct_state_schema",
      directConfirmedDealCount: 1,
      directPausedForReview: true,
    });
    expect(oldBundleProjection.directDealOutcomes).toEqual([
      LEGACY_X_V1_OUTCOME_GOLDEN,
    ]);

    const upgradedAgain =
      migrateLegacyDirectToContinuous(
        oldBundleProjection,
        MIGRATION_TICK + 1,
      );
    expect(upgradedAgain).toMatchObject({
      migrationStatus: "blocked",
      migrationBlockedReason:
        "rollback_evidence_lost",
      lifecycleByEntry: {},
    });
    expect(upgradedAgain.currentPermit).toBeUndefined();
    expect(upgradedAgain.ledger.blocker?.code).toBe(
      "rollback_evidence_lost",
    );
  });

  it("删除 state/permit/ledger/processed 证据不会生成 fresh canary；兼容 outcome/key 裁剪不回退 lifecycle", () => {
    const missingState = normalizeContinuousDirectState(
      undefined,
      RUN_TICK,
    );
    expect(missingState).toMatchObject({
      migrationStatus: "blocked",
      migrationBlockedReason: "direct_state_missing",
      lifecycleByEntry: {},
    });

    for (const mutate of [
      (state: MarketDirectContinuousAutomationState) => {
        delete state.currentPermit;
      },
      (state: MarketDirectContinuousAutomationState) => {
        delete (
          state as unknown as {
            ledger?: unknown;
          }
        ).ledger;
      },
      (state: MarketDirectContinuousAutomationState) => {
        state.ledger.processedEvidenceKeys = [];
      },
    ]) {
      const state = clone(acceptedXState());
      mutate(state);
      const normalized = normalizeContinuousDirectState(
        state,
        RUN_TICK,
      );
      expect(normalized.migrationStatus).toBe("blocked");
      expect(normalized.lifecycleByEntry).toEqual({});
      expect(normalized.currentPermit).toBeUndefined();
    }

    for (const mutate of [
      (state: MarketDirectContinuousAutomationState) => {
        state.directDealOutcomes = [];
      },
      (state: MarketDirectContinuousAutomationState) => {
        state.processedDirectTransactionKeys = [];
      },
    ]) {
      const state = clone(acceptedXState());
      mutate(state);
      const normalized = normalizeContinuousDirectState(
        state,
        RUN_TICK,
      );
      expect(normalized.migrationStatus).toBe("active");
      expect(
        normalized.lifecycleByEntry["base-x-e6n59-v1"],
      ).toMatchObject({
        stage: "continuous",
        canaryConfirmedCount: 1,
      });
    }
  });

  it("canary receipt 裁剪后双删高水位并回拨 lifecycle 会持久闭锁且零写", () => {
    const checkpointOnly = acceptedXState();
    const seedReceipt = checkpointOnly.ledger.receipts[0];
    checkpointOnly.ledger.checkpoint = {
      prunedThroughSeq: seedReceipt.attemptSeq,
      prunedHeadHash: seedReceipt.headHash,
      confirmed: clone(
        checkpointOnly.ledger.lifetimeConfirmed,
      ),
      confirmedCanaries: clone(
        checkpointOnly.ledger.confirmedCanaries,
      ),
      confirmedCanaryCommitment: "",
    };
    checkpointOnly.ledger.checkpoint
      .confirmedCanaryCommitment =
      continuousConfirmedCanaryCheckpointCommitment(
        checkpointOnly.ledger.checkpoint,
      );
    checkpointOnly.ledger.receipts = [];
    checkpointOnly.ledger.processedEvidenceKeys = [];
    expect(
      normalizeContinuousDirectState(
        checkpointOnly,
        RUN_TICK,
      ).migrationStatus,
    ).toBe("active");

    const corrupted = clone(checkpointOnly);
    delete corrupted.ledger.checkpoint.confirmedCanaries[
      "base-x-e6n59-v1"
    ];
    delete corrupted.ledger.confirmedCanaries[
      "base-x-e6n59-v1"
    ];
    const xLifecycle =
      corrupted.lifecycleByEntry["base-x-e6n59-v1"];
    const {
      canaryConfirmedAt: _canaryConfirmedAt,
      ...xLifecycleBeforeConfirmation
    } = xLifecycle;
    corrupted.lifecycleByEntry["base-x-e6n59-v1"] = {
      ...xLifecycleBeforeConfirmation,
      stage: "canary",
      canaryConfirmedCount: 0,
      evidenceHistory: [],
    };

    const normalized = normalizeContinuousDirectState(
      corrupted,
      RUN_TICK,
    );
    expect(normalized.migrationStatus).toBe("blocked");
    expect(normalized.migrationBlockedReason).toBe(
      "direct_canary_checkpoint_commitment_mismatch",
    );

    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-must-not-repeat",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
    };
    const dependencies = dependenciesFor(harness);
    expect(
      runMarketDirectContinuousPlanning(
        corrupted,
        automationInput(RUN_TICK),
        dependencies,
      ).writes,
    ).toBe(0);
    expect(dependencies.executePrepared).not.toHaveBeenCalled();
  });

  it("首个 proposal 确定性地只启用 X，accept 可重复且不重复推进 epoch", () => {
    const migrated = migrateLegacyDirectToContinuous(
      exactLegacyState(),
      MIGRATION_TICK,
    );
    const request = {
      operatorAuthorizationFingerprint:
        OPERATOR_AUTHORIZATION,
    };

    const firstProposal = proposeMarketDirectContinuousPermit(
      migrated,
      MIGRATION_TICK + 1,
      ACCOUNT_IDENTITY,
      request,
    );
    const repeatedProposal =
      proposeMarketDirectContinuousPermit(
        migrated,
        MIGRATION_TICK + 1,
        ACCOUNT_IDENTITY,
        request,
      );

    expect(firstProposal.ok).toBe(true);
    expect(repeatedProposal.ok).toBe(true);
    expect(repeatedProposal.permit).toEqual(
      firstProposal.permit,
    );
    expect(repeatedProposal.state).toEqual(firstProposal.state);

    const permit = firstProposal.permit!;
    expect(permit).toMatchObject({
      epoch: 1,
      accountIdentity: ACCOUNT_IDENTITY,
      executorShard: MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
      previousPermitId: "",
      previousPermitHead: CONTINUOUS_PERMIT_GENESIS,
      previousLedgerHead: migrated.ledger.receiptHeadHash,
      createdAt: MIGRATION_TICK + 1,
      operatorAuthorizationFingerprint:
        OPERATOR_AUTHORIZATION,
    });
    expect(permit.entryGrants).toEqual([
      expect.objectContaining({
        entryId: "base-h-e3n59-v1",
        stage: "shadow",
        newDealGrant: "suspended",
      }),
      expect.objectContaining({
        entryId: "base-x-e6n59-v1",
        stage: "continuous",
        newDealGrant: "enabled",
      }),
      expect.objectContaining({
        entryId: "base-z-e7n57-v1",
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    ]);
    expect(permit.reviewedEvidence).toContainEqual({
      entryId: "base-x-e6n59-v1",
      evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
      kind: "legacy_reviewed_canary",
      digest: LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST,
    });
    expect(
      firstProposal.state.proposedPermit!.lifecycleByEntry[
        "base-x-e6n59-v1"
      ],
    ).toMatchObject({
      stage: "continuous",
      canaryConfirmedCount: 1,
      evidenceHistory: expect.arrayContaining([
        expect.objectContaining({
          kind: "continuous_review",
          digest:
            migrated.ledger.confirmedCanaries[
              "base-x-e6n59-v1"
            ].reviewedEvidenceDigest,
        }),
      ]),
    });
    expect(
      firstProposal.state.lifecycleByEntry[
        "base-x-e6n59-v1"
      ].stage,
    ).toBe("review_paused");
    expect(
      migrated.lifecycleByEntry["base-x-e6n59-v1"].stage,
    ).toBe("review_paused");

    const accepted = acceptMarketDirectContinuousPermit(
      firstProposal.state,
      MIGRATION_TICK + 2,
      permit.permitId,
      MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.idempotent).toBe(false);
    expect(accepted.state).toMatchObject({
      migrationStatus: "active",
      currentPermit: permit,
      permitChain: {
        currentPermitEpoch: 1,
        currentPermitId: permit.permitId,
        permitChainHead: permit.permitHead,
        permitEpochHighWater: 1,
        permitChainHeadHighWater: permit.permitHead,
        permits: [permit],
      },
      ledger: {
        permitEpochHighWater: 1,
        permitChainHeadHighWater: permit.permitHead,
      },
      lifecycleByEntry: {
        "base-x-e6n59-v1": {
          stage: "continuous",
        },
      },
    });
    expect(accepted.state.proposedPermit).toBeUndefined();

    const repeatedAccept =
      acceptMarketDirectContinuousPermit(
        accepted.state,
        MIGRATION_TICK + 3,
        permit.permitId,
        MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
      );
    expect(repeatedAccept).toEqual({
      ok: true,
      idempotent: true,
      state: accepted.state,
    });
    const wrongShardRetry =
      acceptMarketDirectContinuousPermit(
        accepted.state,
        MIGRATION_TICK + 3,
        permit.permitId,
        "shard0",
      );
    expect(wrongShardRetry.ok).toBe(false);
    expect(wrongShardRetry.error).toBe(
      "executor_shard_mismatch",
    );
    expect(
      wrongShardRetry.state.permitChain.blocker,
    ).toBe("permit_conflict");
  });

  it("拒绝越级 lifecycle、shadow 写授权、错误 permit id 和错误 shard", () => {
    const migrated = migrateLegacyDirectToContinuous(
      exactLegacyState(),
      MIGRATION_TICK,
    );

    const illegalTransition =
      proposeMarketDirectContinuousPermit(
        migrated,
        MIGRATION_TICK + 1,
        ACCOUNT_IDENTITY,
        {
          operatorAuthorizationFingerprint:
            OPERATOR_AUTHORIZATION,
          entryStages: {
            "base-h-e3n59-v1": "continuous",
          },
        },
      );
    expect(illegalTransition).toEqual({
      ok: false,
      state: migrated,
      error:
        "illegal lifecycle transition base-h-e3n59-v1:shadow->continuous",
    });

    const illegalGrant = proposeMarketDirectContinuousPermit(
      migrated,
      MIGRATION_TICK + 1,
      ACCOUNT_IDENTITY,
      {
        operatorAuthorizationFingerprint:
          OPERATOR_AUTHORIZATION,
        newDealGrants: {
          "base-h-e3n59-v1": "enabled",
        },
      },
    );
    expect(illegalGrant).toEqual({
      ok: false,
      state: migrated,
      error:
        "non-writing lifecycle grant enabled: base-h-e3n59-v1",
    });

    const validProposal =
      proposeMarketDirectContinuousPermit(
        migrated,
        MIGRATION_TICK + 1,
        ACCOUNT_IDENTITY,
        {
          operatorAuthorizationFingerprint:
            OPERATOR_AUTHORIZATION,
        },
      );
    expect(validProposal.ok).toBe(true);

    const unknownPermit =
      acceptMarketDirectContinuousPermit(
        validProposal.state,
        MIGRATION_TICK + 2,
        "mdc-permit-v2:unknown",
        MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
      );
    expect(unknownPermit).toEqual({
      ok: false,
      state: validProposal.state,
      error: "continuous_permit_proposal_not_found",
    });

    const wrongShard = acceptMarketDirectContinuousPermit(
      validProposal.state,
      MIGRATION_TICK + 2,
      validProposal.permit!.permitId,
      "shard0",
    );
    expect(wrongShard.ok).toBe(false);
    expect(wrongShard.error).toBe("executor_shard_mismatch");
    expect(wrongShard.state.permitChain.blocker).toBe(
      "permit_conflict",
    );
    expect(wrongShard.state.currentPermit).toBeUndefined();
    expect(wrongShard.state.migrationStatus).toBe(
      "readyForPermit",
    );
    expect(wrongShard.state.ledger.permitEpochHighWater).toBe(0);
  });

  it("先按单位净价跨资源排序，并在同资源中让高价小单胜过低价大单", () => {
    Game.time = RUN_TICK;
    const xOnlyState = acceptedAllWritableState();
    const xOnlyHarness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-low-large",
            RESOURCE_CATALYST,
            650,
            50_000,
            "E20S20",
          ),
          order(
            "x-high-small",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E21S21",
          ),
        ],
        [RESOURCE_HYDROGEN]: [
          order(
            "h-below-floor",
            RESOURCE_HYDROGEN,
            450,
            20_000,
            "E22S22",
          ),
        ],
        [RESOURCE_ZYNTHIUM]: [
          order(
            "z-below-floor",
            RESOURCE_ZYNTHIUM,
            44,
            20_000,
            "E23S23",
          ),
        ],
      },
      claimResult: false,
    };
    const xOnlyDependencies =
      dependenciesFor(xOnlyHarness);

    const xOnlyResult =
      runMarketDirectContinuousPlanning(
        xOnlyState,
        automationInput(RUN_TICK),
        xOnlyDependencies,
      );

    expect(xOnlyResult.writes).toBe(0);
    expect(xOnlyState.lastPlanningSnapshot?.selected).toMatchObject({
      entryId: "base-x-e6n59-v1",
      resource: RESOURCE_CATALYST,
      orderId: "x-high-small",
      grossPrice: 700,
      unitNetPrice: 700,
    });
    expect(xOnlyState.lastPlanningSnapshot?.selected?.orderId).not.toBe(
      "x-low-large",
    );

    Game.time = RUN_TICK;
    const globalState = acceptedAllWritableState();
    const globalHarness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-net-700",
            RESOURCE_CATALYST,
            700,
            10_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [
          order(
            "h-net-720",
            RESOURCE_HYDROGEN,
            720,
            1_000,
            "E21S21",
          ),
        ],
        [RESOURCE_ZYNTHIUM]: [
          order(
            "z-net-730",
            RESOURCE_ZYNTHIUM,
            730,
            1_000,
            "E22S22",
          ),
        ],
      },
      claimResult: false,
    };

    runMarketDirectContinuousPlanning(
      globalState,
      automationInput(RUN_TICK),
      dependenciesFor(globalHarness),
    );

    expect(globalState.lastPlanningSnapshot?.selected).toMatchObject({
      entryId: "base-z-e7n57-v1",
      resource: RESOURCE_ZYNTHIUM,
      orderId: "z-net-730",
      unitNetPrice: 730,
    });
  });

  it.each([
    ["order remaining", "order"],
    ["credits", "credits"],
    ["protection", "protection"],
    ["terminal", "terminal"],
  ] as const)(
    "第二次完整读的 %s 变化时全局零写",
    (_label, mutation) => {
      Game.time = RUN_TICK;
      const state = acceptedXState();
      const harness: RuntimeHarness = {
        tick: RUN_TICK,
        ordersByResource: {
          [RESOURCE_CATALYST]: [
            order(
              "x-second-read",
              RESOURCE_CATALYST,
              700,
              1_000,
              "E20S20",
            ),
          ],
          [RESOURCE_HYDROGEN]: [],
          [RESOURCE_ZYNTHIUM]: [],
        },
        secondReadMutation: mutation,
      };
      const dependencies = dependenciesFor(harness);

      const result = runMarketDirectContinuousPlanning(
        state,
        automationInput(RUN_TICK),
        dependencies,
      );

      expect(result.writes).toBe(0);
      expect(result.planComplete).toBe(false);
      expect(result.rejectedByReason).toMatchObject({
        continuous_second_read_changed: 1,
      });
      expect(state.lastPlanningSnapshot?.blocker).toBe(
        "continuous_second_read_changed",
      );
      expect(state.ledger.pending).toBeUndefined();
      expect(dependencies.executePrepared).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "pricing/history",
      (
        input: MarketDirectContinuousAutomationInput,
        _harness: RuntimeHarness,
      ) => {
        const candidate = input.candidates.find(
          (entry) =>
            entry.resourceType === RESOURCE_HYDROGEN,
        )!;
        candidate.historyTrusted = false;
        candidate.rejectionReasons = [
          "pricing_cache_stale:fixture",
        ];
      },
    ],
    [
      "terminal",
      (
        _input: MarketDirectContinuousAutomationInput,
        harness: RuntimeHarness,
      ) => {
        harness.missingTerminalResource = RESOURCE_HYDROGEN;
      },
    ],
    [
      "book",
      (
        _input: MarketDirectContinuousAutomationInput,
        harness: RuntimeHarness,
      ) => {
        harness.ordersByResource[RESOURCE_HYDROGEN] = [
          order(
            "h-duplicate",
            RESOURCE_HYDROGEN,
            500,
            1_000,
            "E21S21",
          ),
          order(
            "h-duplicate",
            RESOURCE_HYDROGEN,
            501,
            1_000,
            "E22S22",
          ),
        ];
      },
    ],
    [
      "scoped protection",
      (
        _input: MarketDirectContinuousAutomationInput,
        harness: RuntimeHarness,
      ) => {
        harness.scopedProtectionBlockedResource =
          RESOURCE_HYDROGEN;
      },
    ],
  ] as Array<
    [
      string,
      (
        input: MarketDirectContinuousAutomationInput,
        harness: RuntimeHarness,
      ) => void,
    ]
  >)(
    "suspended H 的 entry-local %s 不阻断 X，且只重置 H shadow",
    (_label, configure) => {
      Game.time = RUN_TICK;
      const state = acceptedXState();
      seedShadowCycle(
        state,
        "base-h-e3n59-v1",
        RUN_TICK - 1,
      );
      const harness: RuntimeHarness = {
        tick: RUN_TICK,
        ordersByResource: {
          [RESOURCE_CATALYST]: [
            order(
              "x-survives-shadow-gap",
              RESOURCE_CATALYST,
              700,
              1_000,
              "E20S20",
            ),
          ],
          [RESOURCE_HYDROGEN]: [],
          [RESOURCE_ZYNTHIUM]: [],
        },
      };
      const input = automationInput(RUN_TICK);
      configure(input, harness);
      const dependencies = dependenciesFor(harness);

      const result = runMarketDirectContinuousPlanning(
        state,
        input,
        dependencies,
      );

      expect(result.writes).toBe(1);
      expect(result.planComplete).toBe(false);
      expect(dependencies.executePrepared).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "x-survives-shadow-gap",
          roomName: "E6N59",
        }),
      );
      expect(
        state.lifecycleByEntry["base-h-e3n59-v1"],
      ).toMatchObject({
        stage: "shadow",
        consecutiveCompleteCycles: 0,
        lastCycleTick: RUN_TICK,
        lastShadowResult: "incomplete",
      });
    },
  );

  it("H grant enabled 后，其 entry-local 输入不完整仍保持全局零写", () => {
    Game.time = RUN_TICK;
    const state = acceptedAllWritableState();
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-must-not-write",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
    };
    const input = automationInput(RUN_TICK);
    input.candidates.find(
      (entry) => entry.resourceType === RESOURCE_HYDROGEN,
    )!.historyTrusted = false;
    const dependencies = dependenciesFor(harness);

    const result = runMarketDirectContinuousPlanning(
      state,
      input,
      dependencies,
    );

    expect(result.writes).toBe(0);
    expect(result.rejectedByReason).toMatchObject({
      "continuous_pricing_incomplete:base-h-e3n59-v1": 1,
    });
    expect(state.ledger.pending).toBeUndefined();
    expect(dependencies.executePrepared).not.toHaveBeenCalled();
  });

  it("suspended H 的共享 energy 证据不一致仍保持全局零写", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-energy-global-block",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
    };
    const input = automationInput(RUN_TICK);
    input.candidates.find(
      (entry) => entry.resourceType === RESOURCE_HYDROGEN,
    )!.effectiveEnergyShadowPrice = 21;
    const dependencies = dependenciesFor(harness);

    const result = runMarketDirectContinuousPlanning(
      state,
      input,
      dependencies,
    );

    expect(result.writes).toBe(0);
    expect(result.rejectedByReason).toMatchObject({
      continuous_energy_shadow_inconsistent: 1,
    });
    expect(state.ledger.pending).toBeUndefined();
    expect(dependencies.executePrepared).not.toHaveBeenCalled();
  });

  it("X 触发二读时，H/Z 稳定 safe-no-op 仍各推进一个 Shadow 周期", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-stable-with-shadow-no-op",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
    };
    const dependencies = dependenciesFor(harness);

    const result = runMarketDirectContinuousPlanning(
      state,
      automationInput(RUN_TICK),
      dependencies,
    );

    expect(result.writes).toBe(1);
    expect(dependencies.executePrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "x-stable-with-shadow-no-op",
        roomName: "E6N59",
      }),
    );
    for (const entryId of [
      "base-h-e3n59-v1",
      "base-z-e7n57-v1",
    ]) {
      expect(state.lifecycleByEntry[entryId]).toMatchObject({
        stage: "shadow",
        consecutiveCompleteCycles: 1,
        lastCycleTick: RUN_TICK,
        lastShadowResult: "safe_no_opportunity",
      });
    }
  });

  it("H shadow 两读间变化不阻断 X，但本周期不计数", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    seedShadowCycle(
      state,
      "base-h-e3n59-v1",
      RUN_TICK - 1,
    );
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-stable-scope",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [
          order(
            "h-mutates-outside-x-scope",
            RESOURCE_HYDROGEN,
            500,
            1_000,
            "E21S21",
          ),
        ],
        [RESOURCE_ZYNTHIUM]: [],
      },
      secondReadMutation: "shadow_order",
    };
    const dependencies = dependenciesFor(harness);

    const result = runMarketDirectContinuousPlanning(
      state,
      automationInput(RUN_TICK),
      dependencies,
    );

    expect(result.writes).toBe(1);
    expect(result.planComplete).toBe(false);
    expect(dependencies.executePrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "x-stable-scope",
        roomName: "E6N59",
      }),
    );
    expect(
      state.lifecycleByEntry["base-h-e3n59-v1"],
    ).toMatchObject({
      consecutiveCompleteCycles: 0,
      lastCycleTick: RUN_TICK,
      lastShadowResult: "incomplete",
    });
  });

  it("生产优先等待不能掩盖 H 的 scoped protection incomplete", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    seedShadowCycle(
      state,
      "base-h-e3n59-v1",
      RUN_TICK - 1,
    );
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-production-wait",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
      productionIntent: true,
      scopedProtectionBlockedResource: RESOURCE_HYDROGEN,
    };
    const dependencies = dependenciesFor(harness);

    const result = runMarketDirectContinuousPlanning(
      state,
      automationInput(RUN_TICK),
      dependencies,
    );

    expect(result.writes).toBe(0);
    expect(
      state.lifecycleByEntry["base-h-e3n59-v1"],
    ).toMatchObject({
      consecutiveCompleteCycles: 0,
      lastCycleTick: RUN_TICK,
      lastShadowResult: "incomplete",
    });
    expect(dependencies.executePrepared).not.toHaveBeenCalled();
  });

  it("先持久化 prepared 再 deal；OK 后保留 pending，次 tick 精确成交令 WAL 收敛", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    const events: string[] = [];
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-exact-order",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
      claimResult: true,
      executeResult: OK,
      onClaim: () => {
        expect(state.ledger.pending).toBeDefined();
        events.push("claim-after-prepare");
      },
      onExecute: (request) => {
        expect(state.ledger.pending).toMatchObject({
          orderId: request.orderId,
          plannedAmount: request.amount,
          attemptAt: RUN_TICK,
        });
        events.push("deal-after-prepare");
      },
      onRelease: () => events.push("release-after-finalize"),
    };
    const dependencies = dependenciesFor(harness);

    const planned = runMarketDirectContinuousPlanning(
      state,
      automationInput(RUN_TICK),
      dependencies,
    );

    expect(planned.writes).toBe(1);
    expect(events).toEqual([
      "claim-after-prepare",
      "deal-after-prepare",
    ]);
    expect(planned.actions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^continuous-prepared:/),
        expect.stringMatching(/^continuous-deal-submitted:/),
      ]),
    );
    expect(state.ledger.pending).toMatchObject({
      attemptSeq: 2,
      entryId: "base-x-e6n59-v1",
      resource: RESOURCE_CATALYST,
      orderId: "x-exact-order",
      plannedAmount: 1_000,
      attemptAt: RUN_TICK,
    });
    expect(state.ledger.receipts).toHaveLength(1);
    expect(dependencies.releasePrepared).not.toHaveBeenCalled();

    harness.tick = RUN_TICK + 1;
    harness.outgoingTransactions = [
      {
        transactionId: "tx-exact-confirmed",
        time: RUN_TICK,
        amount: 1_000,
        resourceType: RESOURCE_CATALYST,
        from: "E6N59",
        to: "E20S20",
        order: {
          id: "x-exact-order",
          type: ORDER_BUY,
          price: 700,
        },
      },
    ];
    Game.time = RUN_TICK + 1;

    const preflight = runMarketDirectContinuousPreflight(
      state,
      {
        tick: RUN_TICK + 1,
        config: continuousConfig(),
      },
      dependencies,
    );

    expect(preflight.writes).toBe(0);
    expect(preflight.planComplete).toBe(true);
    expect(preflight.actions).toEqual(
      expect.arrayContaining([
        "continuous-outcome:confirmed",
        "continuous-wal:receipt_written",
        "continuous-wal:processed_key_written",
        "continuous-wal:pending_deleted",
      ]),
    );
    expect(events).toEqual([
      "claim-after-prepare",
      "deal-after-prepare",
      "claim-after-prepare",
      "release-after-finalize",
    ]);
    expect(state.ledger.pending).toBeUndefined();
    expect(state.pendingDirectDeals).toEqual({});
    expect(state.ledger.finalizedAttemptSeq).toBe(2);
    expect(state.ledger.nextAttemptSeq).toBe(3);
    expect(state.ledger.receipts).toHaveLength(2);
    expect(state.ledger.receipts[1]).toMatchObject({
      attemptSeq: 2,
      status: "confirmed",
      transactionId: "tx-exact-confirmed",
      transactionTime: RUN_TICK,
      actualAmount: 1_000,
      actualTransactionEnergy: 0,
      actualNetCreditsMilli: 700_000_000,
      evidenceKey: "tx-exact-confirmed:x-exact-order",
    });
    expect(state.ledger.processedEvidenceKeys).toContainEqual({
      attemptSeq: 2,
      key: "tx-exact-confirmed:x-exact-order",
    });
    expect(state.ledger.lifetimeConfirmed).toEqual({
      global: { count: 2, amount: 2_000 },
      resources: { X: { count: 2, amount: 2_000 } },
    });
    expect(state.directConfirmedDealCount).toBe(2);
    expect(dependencies.releasePrepared).toHaveBeenCalledTimes(1);
  });

  it("已确认 H canary 的 lifecycle 单字段回拨会闭锁，写时高水位也禁止第二笔", () => {
    Game.time = RUN_TICK;
    const state = acceptedAllWritableState();
    const hEntryId = "base-h-e3n59-v1";
    const hCanaryBefore = clone(
      state.lifecycleByEntry[hEntryId],
    );
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [],
        [RESOURCE_HYDROGEN]: [
          order(
            "h-canary-once",
            RESOURCE_HYDROGEN,
            500,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_ZYNTHIUM]: [],
      },
      executeResult: OK,
    };
    const dependencies = dependenciesFor(harness);

    expect(
      runMarketDirectContinuousPlanning(
        state,
        automationInput(RUN_TICK),
        dependencies,
      ).writes,
    ).toBe(1);
    expect(state.ledger.pending).toMatchObject({
      entryId: hEntryId,
      executionPolicy: "canary",
      resource: RESOURCE_HYDROGEN,
    });

    harness.tick = RUN_TICK + 1;
    harness.outgoingTransactions = [
      {
        transactionId: "tx-h-canary-once",
        time: RUN_TICK,
        amount: 1_000,
        resourceType: RESOURCE_HYDROGEN,
        from: "E3N59",
        to: "E20S20",
        order: {
          id: "h-canary-once",
          type: ORDER_BUY,
          price: 500,
        },
      },
    ];
    Game.time = RUN_TICK + 1;
    runMarketDirectContinuousPreflight(
      state,
      {
        tick: RUN_TICK + 1,
        config: continuousConfig(),
      },
      dependencies,
    );
    expect(state.lifecycleByEntry[hEntryId]).toMatchObject({
      stage: "review_paused",
      canaryConfirmedCount: 1,
    });
    expect(
      state.ledger.confirmedCanaries[hEntryId],
    ).toMatchObject({
      entryId: hEntryId,
      executionPolicy: "canary",
      attemptSeq: state.ledger.finalizedAttemptSeq,
    });

    const recoverableCpuCut = clone(state);
    recoverableCpuCut.lifecycleByEntry[hEntryId] =
      hCanaryBefore;
    recoverableCpuCut.lastLifecycleAppliedAttemptSeq =
      state.ledger.confirmedCanaries[hEntryId].attemptSeq - 1;
    expect(
      normalizeContinuousDirectState(
        recoverableCpuCut,
        RUN_TICK + 2,
      ).migrationStatus,
    ).toBe("active");
    harness.tick = RUN_TICK + 2;
    Game.time = RUN_TICK + 2;
    runMarketDirectContinuousPreflight(
      recoverableCpuCut,
      {
        tick: RUN_TICK + 2,
        config: continuousConfig(),
      },
      dependencies,
    );
    expect(
      recoverableCpuCut.lifecycleByEntry[hEntryId],
    ).toMatchObject({
      stage: "review_paused",
      canaryConfirmedCount: 1,
    });

    const rolledBack = clone(state);
    rolledBack.lifecycleByEntry[hEntryId] = hCanaryBefore;
    const normalized = normalizeContinuousDirectState(
      rolledBack,
      RUN_TICK + 1_001,
    );
    expect(normalized.migrationStatus).toBe("blocked");
    expect(normalized.migrationBlockedReason).toBe(
      "direct_v2_state_invalid",
    );

    harness.tick = RUN_TICK + 1_001;
    harness.outgoingTransactions = [];
    Game.time = RUN_TICK + 1_001;
    const writeTimeGate =
      runMarketDirectContinuousPlanning(
        rolledBack,
        automationInput(RUN_TICK + 1_001),
        dependencies,
      );
    expect(writeTimeGate.writes).toBe(0);
    expect(
      dependencies.executePrepared,
    ).toHaveBeenCalledTimes(1);
  });

  it("Emergency Stop 禁止新 pending，但 preflight 仍收敛已提交 WAL", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-emergency",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
      executeResult: OK,
    };
    const dependencies = dependenciesFor(harness);

    expect(
      runMarketDirectContinuousPlanning(
        state,
        automationInput(RUN_TICK),
        dependencies,
      ).writes,
    ).toBe(1);
    expect(state.ledger.pending).toBeDefined();

    const stoppedWithPending =
      runMarketDirectContinuousPlanning(
        state,
        {
          ...automationInput(RUN_TICK),
          emergencyStop: true,
        },
        dependencies,
      );
    expect(stoppedWithPending.writes).toBe(0);
    expect(state.ledger.pending).toBeDefined();

    harness.tick = RUN_TICK + 1;
    harness.outgoingTransactions = [
      {
        transactionId: "tx-emergency-confirmed",
        time: RUN_TICK,
        amount: 1_000,
        resourceType: RESOURCE_CATALYST,
        from: "E6N59",
        to: "E20S20",
        order: {
          id: "x-emergency",
          type: ORDER_BUY,
          price: 700,
        },
      },
    ];
    Game.time = RUN_TICK + 1;
    const reconciled =
      runMarketDirectContinuousPreflight(
        state,
        {
          tick: RUN_TICK + 1,
          config: continuousConfig(),
        },
        dependencies,
      );
    expect(reconciled.writes).toBe(0);
    expect(state.ledger.pending).toBeUndefined();
    expect(
      state.ledger.receipts[
        state.ledger.receipts.length - 1
      ],
    ).toMatchObject({
      status: "confirmed",
      transactionId: "tx-emergency-confirmed",
    });

    harness.tick = RUN_TICK + 1_001;
    Game.time = RUN_TICK + 1_001;
    const stoppedQuiescent =
      runMarketDirectContinuousPlanning(
        state,
        {
          ...automationInput(RUN_TICK + 1_001),
          emergencyStop: true,
        },
        dependencies,
      );
    expect(stoppedQuiescent.writes).toBe(0);
    expect(state.ledger.pending).toBeUndefined();
    expect(dependencies.executePrepared).toHaveBeenCalledTimes(1);
  });

  it("明确 non-OK 写入 failed receipt、删除 pending 并在终态后释放 claim", () => {
    Game.time = RUN_TICK;
    const state = acceptedXState();
    const events: string[] = [];
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [
          order(
            "x-non-ok",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_HYDROGEN]: [],
        [RESOURCE_ZYNTHIUM]: [],
      },
      claimResult: true,
      executeResult: ERR_BUSY,
      onExecute: () => {
        expect(state.ledger.pending).toBeDefined();
        events.push("deal");
      },
      onRelease: () => {
        expect(state.ledger.pending).toBeUndefined();
        expect(state.ledger.finalizedAttemptSeq).toBe(2);
        events.push("release");
      },
    };
    const dependencies = dependenciesFor(harness);

    const result = runMarketDirectContinuousPlanning(
      state,
      automationInput(RUN_TICK),
      dependencies,
    );

    expect(result.writes).toBe(1);
    expect(result.rejectedByReason).toMatchObject({
      [`continuous_deal_error:${ERR_BUSY}`]: 1,
    });
    expect(events).toEqual(["deal", "release"]);
    expect(state.ledger.pending).toBeUndefined();
    expect(state.ledger.finalizedAttemptSeq).toBe(2);
    expect(state.ledger.retryNotBefore).toBe(RUN_TICK + 100);
    expect(state.ledger.receipts[1]).toMatchObject({
      attemptSeq: 2,
      status: "failed",
      actualAmount: 0,
      reason: `market_non_ok:${ERR_BUSY}`,
    });
    expect(state.ledger.processedEvidenceKeys[1].key).toMatch(
      /^failed:continuous:2:/,
    );
    expect(dependencies.releasePrepared).toHaveBeenCalledTimes(1);
  });

  it("H/Z shadow 连续 100 个完整周期计数，低价 Z 记 safe_no_opportunity 且始终零写", () => {
    const state = acceptedXState();
    const harness: RuntimeHarness = {
      tick: RUN_TICK,
      ordersByResource: {
        [RESOURCE_CATALYST]: [],
        [RESOURCE_HYDROGEN]: [
          order(
            "h-safe-shadow",
            RESOURCE_HYDROGEN,
            500,
            1_000,
            "E20S20",
          ),
        ],
        [RESOURCE_ZYNTHIUM]: [
          order(
            "z-too-low-shadow",
            RESOURCE_ZYNTHIUM,
            44,
            50_000,
            "E21S21",
          ),
        ],
      },
    };
    const dependencies = dependenciesFor(harness);

    for (let cycle = 1; cycle <= 100; cycle += 1) {
      const tick = RUN_TICK + cycle;
      harness.tick = tick;
      Game.time = tick;
      const result = runMarketDirectContinuousPlanning(
        state,
        automationInput(tick),
        dependencies,
      );
      expect(result.writes).toBe(0);
      expect(state.ledger.pending).toBeUndefined();
    }

    expect(state.lifecycleByEntry["base-h-e3n59-v1"]).toMatchObject({
      stage: "qualified",
      consecutiveCompleteCycles: 100,
      lastCycleTick: RUN_TICK + 100,
      lastShadowResult: "safe_opportunity",
      qualifiedAt: RUN_TICK + 100,
    });
    expect(state.lifecycleByEntry["base-z-e7n57-v1"]).toMatchObject({
      stage: "qualified",
      consecutiveCompleteCycles: 100,
      lastCycleTick: RUN_TICK + 100,
      lastShadowResult: "safe_no_opportunity",
      qualifiedAt: RUN_TICK + 100,
    });
    expect(dependencies.executePrepared).not.toHaveBeenCalled();
  });

  it.each([
    [
      "manual own order",
      (harness: RuntimeHarness) => {
        harness.ownOrders = [
          order(
            "manual-own",
            RESOURCE_CATALYST,
            700,
            1_000,
            "E20S20",
          ),
        ];
      },
      "continuous_plan:write_context_blocked",
    ],
    [
      "production intent",
      (harness: RuntimeHarness) => {
        harness.productionIntent = true;
      },
      "continuous_plan:write_context_blocked",
    ],
    [
      "permit account mismatch",
      (harness: RuntimeHarness) => {
        harness.accountIdentity = "different-account";
      },
      "continuous_permit_mismatch",
    ],
    [
      "global protection incomplete",
      (harness: RuntimeHarness) => {
        harness.protectionGlobalBlocked = true;
      },
      "protection_stale",
    ],
  ] as const)(
    "%s 时保持全局零写",
    (_label, configure, rejectionKey) => {
      Game.time = RUN_TICK;
      const state = acceptedXState();
      const harness: RuntimeHarness = {
        tick: RUN_TICK,
        ordersByResource: {
          [RESOURCE_CATALYST]: [
            order(
              "x-blocked",
              RESOURCE_CATALYST,
              700,
              1_000,
              "E20S20",
            ),
          ],
          [RESOURCE_HYDROGEN]: [],
          [RESOURCE_ZYNTHIUM]: [],
        },
      };
      configure(harness);
      const dependencies = dependenciesFor(harness);

      const result = runMarketDirectContinuousPlanning(
        state,
        automationInput(RUN_TICK),
        dependencies,
      );

      expect(result.writes).toBe(0);
      expect(result.rejectedByReason[rejectionKey]).toBeGreaterThan(0);
      expect(state.ledger.pending).toBeUndefined();
      expect(dependencies.executePrepared).not.toHaveBeenCalled();
    },
  );
});
