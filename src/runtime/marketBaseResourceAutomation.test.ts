import {
  applyMarketBaseResourceShadowObservations,
  buildMarketBaseResourcePricingRatchetState,
  marketBaseResourceCpuFallbackRequiresCanonicalCommit,
  marketBaseResourceOperatorAuthorizationFingerprint,
  materializeMarketBaseResourceCpuFallback,
  planMarketBaseResourceTwoRead,
  reconcileLiveMarketBaseResourceScope,
  runMarketBaseResourceAutomation,
  type MarketBaseResourceAutomationInput,
  type MarketBaseResourcePlanningDependencies,
  type MarketBaseResourcePlanningScopeSnapshot,
  type MarketBaseResourceRuntimeCandidate,
  type MarketBaseResourceRuntimeDependencies,
  type MarketBaseResourceScopeState,
  type MarketBaseResourceV3RuntimeState,
  type MarketBaseResourceTerminalRead,
} from "@/runtime/marketBaseResourceAutomation";
import {
  MARKET_DIRECT_CONTINUOUS_LANE_ROLLING_CAP,
  MARKET_DIRECT_CONTINUOUS_ROOM_ROLLING_CAP,
  type MarketDirectContinuousEntryInput,
} from "@/runtime/marketDirectContinuousPlanner";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CATALOG_REVISION,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  MARKET_BASE_RESOURCE_POLICIES,
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseRoomObservation,
} from "@/runtime/marketBaseResourcePolicy";
import {
  appendMarketBaseResourcePermit,
  buildMarketBaseResourceBootstrapRatchetHighWater,
  buildMarketBaseResourceLegacyV2GrantSuspension,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourceSignedLaneGrant,
  buildMarketBaseResourceV2EventCutoverCheckpoint,
  createMarketBaseResourcePermitChainState,
  wrapAuthenticatedLegacyV2PermitRecord,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitChainState,
  type MarketBaseResourceSignedLaneGrant,
} from "@/runtime/marketBaseResourcePermit";
import {
  buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis,
  buildMarketBaseResourceLedgerRuntimeAnchor,
  createMarketBaseResourceLedger,
} from "@/runtime/marketBaseResourceLedger";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  buildMarketDirectContinuousPermit,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  resolveMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import type { MarketProtectionEntry } from "@/runtime/marketSaleProtection";

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

function entry(
  resource: ResourceConstant,
  rooms: readonly string[],
  authorization: "writable" | "suspended_shadow" = "writable",
  floor = 10,
): MarketDirectContinuousEntryInput & {
  lanes: Array<
    MarketDirectContinuousEntryInput["lanes"][number] & {
      laneId: string;
      roomInstanceId: string;
    }
  >;
} {
  const immutable =
    MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[
      resource as keyof typeof MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE
    ];
  return {
    policy: {
      entryId: immutable?.policyId || `policy:${resource}`,
      revision: immutable?.policyRevision || `policy:${resource}:v3`,
      resourceType: resource,
      allowedRooms: [...rooms],
      requireNativeMineral: false,
      grant: "continuous",
      hardNetFloor: immutable?.hardFloor || floor,
      economicNetFloor: immutable?.economicFloor || floor,
      historyNetFloor: immutable?.economicFloor || floor,
      ratchetNetFloor: immutable?.economicFloor || floor,
      minExecutableNotional: immutable?.minOrderNotional || floor * 1_000,
      maxRawOrders: immutable?.maxRawOrdersScanned || 1_000,
      maxEligibleOrders: immutable?.maxEligibleOrdersPriced || 200,
      maxTransactionEnergy: immutable?.maxTransactionEnergy || 1_000,
      terminalEnergyReserve: immutable?.terminalEnergyReserve || 25_000,
      resourceRollingCap: immutable?.rollingMaxAmount || 8_000,
      opportunityReserve: immutable?.rollingOpportunityReserveAmount || 1_000,
      evaluatorVersion: 3,
    },
    quota: {
      complete: true,
      revision: `quota:${resource}`,
      resourceType: resource,
      rollingCap: 8_000,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
      opportunityReserveSatisfied: true,
    },
    lanes: rooms.map((roomName) => ({
      laneId: `lane:${resource}:${roomName}`,
      roomInstanceId: `room:${roomName}`,
      lane: {
        roomName,
        resourceType: resource,
        owned: true,
        hub: false,
        capacityEmergency: false,
        authorization,
      },
      protection: {
        complete: true,
        revision: `protection:${roomName}:${resource}`,
        sellableAmount: 10_000,
      },
      terminal: {
        revision: `seed-terminal:${roomName}:${resource}`,
        normal: true,
        ready: true,
        claimed: false,
        cooldown: 0,
        resourceAmount: 10_000,
        energy: 50_000,
        effectivePostDealEnergyReserve: 25_000,
      },
      quota: {
        complete: true,
        revision: `lane-quota:${roomName}:${resource}`,
        roomRollingCap: MARKET_DIRECT_CONTINUOUS_ROOM_ROLLING_CAP,
        roomConfirmedAmount: 0,
        roomUnmatchedPlannedAmount: 0,
        laneRollingCap: MARKET_DIRECT_CONTINUOUS_LANE_ROLLING_CAP,
        laneConfirmedAmount: 0,
        laneUnmatchedPlannedAmount: 0,
      },
    })),
  };
}


function scope(
  entries: readonly ReturnType<typeof entry>[],
  revision = "scope:stable",
): MarketBaseResourcePlanningScopeSnapshot {
  const presentResources = new Set(
    entries.map((candidate) => candidate.policy.resourceType),
  );
  const catalogEntries = [
    ...entries,
    ...MARKET_BASE_RESOURCE_CATALOG.filter(
      (resource) => !presentResources.has(resource),
    ).map((resource) => entry(resource, [])),
  ];
  const rooms = new Set(
    catalogEntries.flatMap((candidate) =>
      candidate.lanes.map((lane) => lane.lane.roomName),
    ),
  );
  const activeLaneCount = catalogEntries.reduce(
    (sum, candidate) => sum + candidate.lanes.length,
    0,
  );
  return {
    complete: true,
    scopeEvidence: revision,
    currentRosterFingerprint: `roster:${revision}`,
    currentLaneSetFingerprint: `lanes:${revision}`,
    activeRoomCount: rooms.size,
    knownRoomNameCount: rooms.size,
    activeLaneCount,
    entries: catalogEntries,
    energyShadow: {
      complete: true,
      revision: "energy-shadow",
      price: 20,
    },
    globalQuota: {
      complete: true,
      revision: "global-quota",
      rollingCap: 12_000,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
    },
    writeContext: {
      complete: true,
      revision: "write-context",
      credits: 10_000_000,
      executorShard: "shard1",
      permitEpoch: 2,
      permitId: "permit-v3",
      permitHead: "permit-head-v3",
      pendingState: "none",
      arbiterState: "available",
    },
  };
}

interface Harness {
  scope: MarketBaseResourcePlanningScopeSnapshot;
  secondScope?: MarketBaseResourcePlanningScopeSnapshot;
  books: Partial<Record<ResourceConstant, MarketOrderSnapshot[]>>;
  secondBooks?: Partial<Record<ResourceConstant, MarketOrderSnapshot[]>>;
  throwBook?: ResourceConstant;
  mutateNonSelectedTerminal?: boolean;
}

function terminal(
  roomName: string,
  resource: ResourceConstant,
  revision: string,
): MarketBaseResourceTerminalRead {
  return {
    roomName,
    terminalId: `terminal:${roomName}`,
    owned: true,
    ready: true,
    cooldown: 0,
    resourceAmount: 10_000,
    energy: 50_000,
    nativeMineralType: resource,
    effectivePostDealEnergyReserve: 25_000,
    revision,
  };
}

function dependencies(
  harness: Harness,
): MarketBaseResourcePlanningDependencies & {
  readCurrentBuyOrders: jest.Mock;
} {
  const terminalReads = new Map<string, number>();
  const bookReads = new Map<ResourceConstant, number>();
  let scopeReads = 0;
  return {
    readScope: jest.fn(() => {
      scopeReads += 1;
      return JSON.parse(
        JSON.stringify(
          scopeReads === 2 && harness.secondScope
            ? harness.secondScope
            : harness.scope,
        ),
      ) as MarketBaseResourcePlanningScopeSnapshot;
    }),
    readCurrentBuyOrders: jest.fn((resource: ResourceConstant) => {
      if (harness.throwBook === resource) {
        throw new Error("fixture book unavailable");
      }
      const reads = (bookReads.get(resource) || 0) + 1;
      bookReads.set(resource, reads);
      return JSON.parse(
        JSON.stringify(
          reads === 2 && harness.secondBooks?.[resource]
            ? harness.secondBooks[resource]
            : harness.books[resource] || [],
        ),
      ) as MarketOrderSnapshot[];
    }),
    readOwnOrders: jest.fn(() => []),
    readTerminal: jest.fn((roomName, resource) => {
      const key = `${roomName}:${resource}`;
      const reads = (terminalReads.get(key) || 0) + 1;
      terminalReads.set(key, reads);
      return terminal(
        roomName,
        resource,
        harness.mutateNonSelectedTerminal && roomName === "W2N2" && reads === 2
          ? "terminal:changed"
          : "terminal:stable",
      );
    }),
    calculateTransactionEnergy: jest.fn(() => 0),
    cpuUsed: jest.fn(() => 1),
  };
}

/** 运行时写路径用的最小完整 V3 许可、账本和 live-read 夹具。 */
const V3_TEST_ACCOUNT = "market-base-runtime-test";
const V3_TEST_ROOM = "W9N9";
const V3_V2_HEAD = canonicalStableHashV1("mbr-runtime:v2-head");
const V3_V2_CHECKPOINT = canonicalStableHashV1("mbr-runtime:v2-checkpoint");

function v3Digest(label: string): string {
  return canonicalStableHashV1(`mbr-runtime:${label}`);
}

function v3Config() {
  return resolveMarketSaleAutomationConfig({
    mode: "direct",
    directCapability: "continuous-v3",
    configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
    sellResources: [...MARKET_BASE_RESOURCE_CATALOG],
    hardFloor: Object.fromEntries(
      MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
        policy.resource,
        policy.hardFloor,
      ]),
    ),
    economicFloor: Object.fromEntries(
      MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
        policy.resource,
        policy.economicFloor,
      ]),
    ),
    forecastBuffer: Object.fromEntries(
      MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
        policy.resource,
        policy.laneReserve,
      ]),
    ),
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
}

function v3Protection(
  tick: number,
  resource: ResourceConstant,
): MarketProtectionEntry {
  return {
    revision: tick,
    observedAt: tick,
    expiresAt: tick + 10,
    roomName: V3_TEST_ROOM,
    resource,
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

interface V3RuntimeHarness {
  tick: number;
  claim: boolean;
  execute: unknown;
  terminalResource: number;
  terminalEnergy: number;
  outgoing: Array<{
    transactionId: string;
    time: number;
    amount: number;
    resourceType: ResourceConstant;
    from: string;
    to: string;
    order: { id: string; type: ORDER_BUY; price: number };
  }>;
}

function v3RuntimeFixture(writableCatalyst = true): {
  state: MarketBaseResourceV3RuntimeState;
  harness: V3RuntimeHarness;
  deps: MarketBaseResourceRuntimeDependencies & {
    commitPreparedState: jest.Mock;
    validatePreparedCanonicalRoot: jest.Mock;
    cpuUsed: jest.Mock;
    claimPrepared: jest.Mock;
    executePrepared: jest.Mock;
    releasePrepared: jest.Mock;
    readCurrentBuyOrders: jest.Mock;
    readTrustedFloors: jest.Mock;
  };
  input: () => MarketBaseResourceAutomationInput;
} {
  Game.rooms = {
    [V3_TEST_ROOM]: {
      name: V3_TEST_ROOM,
      controller: {
        my: true,
        owner: { username: V3_TEST_ACCOUNT },
      },
      terminal: {
        id: "terminal:W9N9",
        my: true,
        owner: { username: V3_TEST_ACCOUNT },
      },
    } as Room,
  };
  const reconciled = reconcileLiveMarketBaseResourceScope({
    tick: 100,
    accountIdentity: V3_TEST_ACCOUNT,
    observations: [
      {
        roomName: V3_TEST_ROOM,
        visible: true,
        controllerMy: true,
        controllerOwner: V3_TEST_ACCOUNT,
        terminalId: "terminal:W9N9",
        terminalOwned: true,
        roomClass: "normal",
      },
    ],
  });
  if (!reconciled.ok) throw new Error("fixture scope rejected");
  const lanes = reconciled.state.laneLifecycles.map((lane) =>
    writableCatalyst && lane.resource === RESOURCE_CATALYST
      ? {
          ...lane,
          stage: "canary" as const,
          status: "writable" as const,
          shadowEvidence: {
            completeCycles: 100,
            lastCompleteTick: 100,
            evidenceDigest: v3Digest(`qualified:${lane.laneId}`),
          },
        }
      : lane,
  );
  const scopeState = { ...reconciled.state, laneLifecycles: lanes };
  const rawLegacyPermit = buildMarketDirectContinuousPermit({
    epoch: 1,
    accountIdentity: V3_TEST_ACCOUNT,
    sharedDirectFingerprint: v3Digest("v2-shared"),
    entryGrants: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
      entryId: entry.entryId,
      stage:
        writableCatalyst && entry.resourceType === RESOURCE_CATALYST
          ? ("continuous" as const)
          : ("shadow" as const),
      newDealGrant:
        writableCatalyst && entry.resourceType === RESOURCE_CATALYST
          ? ("enabled" as const)
          : ("suspended" as const),
      resourceFingerprint: entry.resourceFingerprint,
      lifecycleEvidenceDigest: v3Digest(`v2-lifecycle:${entry.entryId}`),
    })),
    reviewedEvidence: [],
    previousPermitId: "",
    previousPermitHead: v3Digest("v2-genesis"),
    previousLedgerHead: V3_V2_HEAD,
    createdAt: 99,
    operatorAuthorizationFingerprint: v3Digest("v2-operator"),
  });
  const legacy = wrapAuthenticatedLegacyV2PermitRecord({
    rawRecord: rawLegacyPermit,
    authenticated: true,
  });
  let chain = createMarketBaseResourcePermitChainState({
    legacyV2PermitRecords: [legacy],
  });
  const shared = createMarketBaseSharedPolicy(V3_TEST_ACCOUNT);
  const cutover = buildMarketBaseResourceV2EventCutoverCheckpoint({
    lastV2AttemptSeq: 0,
    lastV2OutcomeSeq: 0,
    v2ReceiptHeadHash: V3_V2_HEAD,
    v2LedgerCheckpointHash: V3_V2_CHECKPOINT,
  });
  const ratchetHighWater =
    buildMarketBaseResourceBootstrapRatchetHighWater(100);
  const operatorAuthorizationFingerprint =
    marketBaseResourceOperatorAuthorizationFingerprint(v3Config());
  const first = buildMarketBaseResourcePermit({
    epoch: 2,
    accountIdentity: V3_TEST_ACCOUNT,
    sharedPolicy: shared,
    ratchetHighWater,
    signedLaneGrants: lanes.map((lane) =>
      buildMarketBaseResourceSignedLaneGrant({ lane, stage: "shadow" }),
    ),
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V3_V2_HEAD,
    v2EventCutoverCheckpoint: cutover,
    legacyV2GrantSuspension: buildMarketBaseResourceLegacyV2GrantSuspension({
      previousPermitId: chain.currentPermitId,
      previousPermitHead: chain.permitChainHead,
      cutoverCheckpointHash: cutover.checkpointHash,
    }),
    createdAt: 100,
    operatorAuthorizationFingerprint,
  });
  const append = (permit: ReturnType<typeof buildMarketBaseResourcePermit>) => {
    const result = appendMarketBaseResourcePermit(chain, permit, {
      tick: 100,
      currentShard: "shard1",
      currentLedgerHead: V3_V2_HEAD,
      currentV2LedgerCheckpointHash: V3_V2_CHECKPOINT,
      currentV2AttemptSeqHighWater: 0,
      currentV2OutcomeSeqHighWater: 0,
      currentDerivedLanes: lanes,
      currentLifecycleCheckpointCommitment:
        marketBaseDerivedLaneLifecycleCheckpointCommitment(lanes),
      hasPending: false,
      hasQuarantine: false,
      hasGap: false,
      hasUnmatchedReservation: false,
    });
    if (result.status !== "appended") {
      throw new Error("reason" in result ? result.reason : result.status);
    }
    chain = result.state;
  };
  append(first);
  if (writableCatalyst) {
    const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
      lane: lanes.find((lane) => lane.resource === RESOURCE_CATALYST)!,
      stage: "canary",
      newDealGrant: "enabled",
    });
    append(
      buildMarketBaseResourcePermit({
        epoch: 3,
        accountIdentity: V3_TEST_ACCOUNT,
        sharedPolicy: shared,
        ratchetHighWater,
        signedLaneGrants: lanes.map((lane) =>
          lane.resource === RESOURCE_CATALYST
            ? canaryGrant
            : buildMarketBaseResourceSignedLaneGrant({ lane, stage: "shadow" }),
        ),
        reviewedEvidence: [
          {
            laneId: canaryGrant.laneId,
            kind: "shadow_qualification",
            evidenceKey: v3Digest("qualified:x"),
            digest: canaryGrant.lifecycleEvidenceDigest,
          },
        ],
        previousPermitId: chain.currentPermitId,
        previousPermitHead: chain.permitChainHead,
        previousLedgerHead: V3_V2_HEAD,
        createdAt: 101,
        operatorAuthorizationFingerprint,
      }),
    );
  }
  const migrationBasis =
    buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis({
      tick: 100,
      cutoverCheckpoint: cutover,
      v2PrunedThroughAttemptSeq: 0,
      legacyQuotaReceipts: [],
      legacyV2ConfirmedCanaries: {},
      lifetimeConfirmed: {
        global: { count: 0, amount: 0 },
        resources: {},
        rooms: {},
        lanes: {},
      },
      retryNotBefore: 0,
      authenticated: true,
    });
  const pricingRatchet = buildMarketBaseResourcePricingRatchetState({
    initializedAt: 100,
    entries: ratchetHighWater.map((entry) => ({
      resource: entry.resource,
      value: entry.ratchetFloor,
      marketDate: "2026-07-27",
    })),
  });
  const harness: V3RuntimeHarness = {
    tick: 101,
    claim: true,
    execute: OK,
    terminalResource: 200_000,
    terminalEnergy: 50_000,
    outgoing: [],
  };
  const ledger = createMarketBaseResourceLedger({
    tick: 100,
    permitChain: chain,
    migrationBasis,
  });
  const deps = {
    readCurrentBuyOrders: jest.fn((resource: ResourceConstant) =>
      resource === RESOURCE_CATALYST
        ? [order("x-buy", resource, 700, 1_000, "E1S1")]
        : [],
    ),
    readOwnOrders: jest.fn(() => []),
    readTerminal: jest.fn((roomName: string, resource: ResourceConstant) => ({
      roomName,
      terminalId: "terminal:W9N9",
      owned: true,
      ready: true,
      cooldown: 0,
      resourceAmount: harness.terminalResource,
      energy: harness.terminalEnergy,
      nativeMineralType: resource,
      effectivePostDealEnergyReserve: 25_000,
      revision: `terminal:${harness.tick}`,
    })),
    readCredits: jest.fn(() => 10_000_000),
    readAccountIdentity: jest.fn(() => V3_TEST_ACCOUNT),
    readExecutorShard: jest.fn(() => "shard1"),
    readArbiterSnapshot: jest.fn(() => ({
      blocked: false,
      revision: `arbiter:${harness.tick}`,
    })),
    readOutgoingWindow: jest.fn(() => ({
      observedAt: harness.tick,
      coversAttemptAt: true,
      transactions: harness.outgoing,
    })),
    readTrustedFloors: jest.fn(() => ({
      ...Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          {
            value: policy.economicFloor,
            marketDate: "2026-07-27",
            updatedAt: harness.tick,
          },
        ]),
      ),
      [RESOURCE_ENERGY]: {
        value: 20,
        marketDate: "2026-07-27",
        updatedAt: harness.tick,
      },
    })),
    calculateTransactionEnergy: jest.fn(() => 0),
    cpuUsed: jest.fn(() => 1),
    // Unit harness 充当 outer activation owner：每次调用从当前 canonical
    // fixture 重建 full anchor。生产路径只会返回已持久化的双份 outer
    // anchor，另有 MarketSale CAS/rollback 回归覆盖。
    readLedgerRuntimeAnchor: jest.fn(
      (current: MarketBaseResourceV3RuntimeState) =>
        buildMarketBaseResourceLedgerRuntimeAnchor(
          current.ledger!,
          current.permitChain!,
        ),
    ),
    commitPreparedState: jest.fn(
      (
        _state: MarketBaseResourceV3RuntimeState,
        _anchor: ReturnType<typeof buildMarketBaseResourceLedgerRuntimeAnchor>,
      ) => {
        return true;
      },
    ),
    validatePreparedCanonicalRoot: jest.fn(() => true),
    claimPrepared: jest.fn(() => harness.claim),
    executePrepared: jest.fn(() => harness.execute),
    releasePrepared: jest.fn(),
  } as unknown as MarketBaseResourceRuntimeDependencies & {
    commitPreparedState: jest.Mock;
    validatePreparedCanonicalRoot: jest.Mock;
    cpuUsed: jest.Mock;
    claimPrepared: jest.Mock;
    executePrepared: jest.Mock;
    releasePrepared: jest.Mock;
    readCurrentBuyOrders: jest.Mock;
    readTrustedFloors: jest.Mock;
  };
  return {
    state: {
      schemaVersion: 3,
      catalog: {
        revision: MARKET_BASE_RESOURCE_CATALOG_REVISION,
        configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
        resources: [...MARKET_BASE_RESOURCE_CATALOG],
      },
      scope: scopeState,
      permitChain: chain,
      ledger,
      pricingRatchet,
      cutoverLatched: true,
    },
    harness,
    deps,
    input: () => ({
      tick: harness.tick,
      fullPlanningTick: true,
      config: v3Config(),
      readCandidates: () =>
        MARKET_BASE_RESOURCE_POLICIES.map(
          (policy): MarketBaseResourceRuntimeCandidate => ({
            roomName: V3_TEST_ROOM,
            resourceType: policy.resource,
            protectionEntry: v3Protection(harness.tick, policy.resource),
            historyTrusted: true,
            historyFloor: policy.economicFloor,
            ratchetFloor: policy.economicFloor,
            effectiveNetFloor: policy.economicFloor,
            effectiveEnergyShadowPrice: 20,
            energyShadowObservedAt: harness.tick,
            energyShadowComponents: {
              hardFloor: 20,
              historyFloor: 20,
              ratchetFloor: 20,
            },
            capacityState: "normal",
            isHubRoom: false,
            rejectionReasons: [],
          }),
        ),
      makerExposurePresent: false,
      emergencyStop: false,
    }),
  };
}


function currentScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermit {
  const current = chain.retainedPermits[chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("scope churn requires current v3 permit");
  }
  return current;
}

function buildScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  grants: readonly MarketBaseResourceSignedLaneGrant[],
  tick: number,
): MarketBaseResourcePermit {
  return buildMarketBaseResourcePermit({
    epoch: chain.permitEpochHighWater + 1,
    accountIdentity: V3_TEST_ACCOUNT,
    sharedPolicy: createMarketBaseSharedPolicy(V3_TEST_ACCOUNT),
    ratchetHighWater: currentScopeChurnPermit(chain).ratchetHighWater,
    signedLaneGrants: grants,
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V3_V2_HEAD,
    createdAt: tick,
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(v3Config()),
  });
}

function appendScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  permit: MarketBaseResourcePermit,
  lanes: readonly MarketBaseDerivedLaneLifecycle[],
  tick: number,
): MarketBaseResourcePermitChainState {
  const result = appendMarketBaseResourcePermit(chain, permit, {
    tick,
    currentShard: "shard1",
    currentLedgerHead: V3_V2_HEAD,
    currentLedgerCheckpointHash: v3Digest("scope-churn-ledger-checkpoint"),
    currentLedgerPermitAnchorHash: v3Digest("scope-churn-ledger-anchor"),
    currentV2LedgerCheckpointHash: V3_V2_CHECKPOINT,
    currentV2AttemptSeqHighWater: 0,
    currentV2OutcomeSeqHighWater: 0,
    currentDerivedLanes: lanes,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(lanes),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
  });
  if (result.status !== "appended") {
    throw new Error(
      `${result.status}:${"reason" in result ? result.reason : "unexpected"}`,
    );
  }
  return result.state;
}

function rolloverScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  oldLanes: readonly MarketBaseDerivedLaneLifecycle[],
  newLanes: readonly MarketBaseDerivedLaneLifecycle[],
  tick: number,
): {
  state: MarketBaseResourcePermitChainState;
  nextActive: readonly MarketBaseResourceSignedLaneGrant[];
} {
  const current = currentScopeChurnPermit(chain);
  const oldLaneById = new Map(oldLanes.map((lane) => [lane.laneId, lane]));
  const nextActive = newLanes.map((lane) =>
    buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "shadow",
      newDealGrant: "suspended",
    }),
  );
  const tombstones = current.signedLaneGrants.map((grant) =>
    buildMarketBaseResourceSignedLaneGrant({
      lane: oldLaneById.get(grant.laneId)!,
      status: "tombstoned",
      stage: grant.stage,
      newDealGrant: "suspended",
      lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
      reviewDigest: grant.reviewDigest,
    }),
  );
  return {
    state: appendScopeChurnPermit(
      chain,
      buildScopeChurnPermit(chain, [...nextActive, ...tombstones], tick),
      newLanes,
      tick,
    ),
    nextActive,
  };
}

function advanceScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  oldLanes: readonly MarketBaseDerivedLaneLifecycle[],
  newLanes: readonly MarketBaseDerivedLaneLifecycle[],
  tick: number,
): MarketBaseResourcePermitChainState {
  const rollover = rolloverScopeChurnPermit(chain, oldLanes, newLanes, tick);
  return appendScopeChurnPermit(
    rollover.state,
    buildScopeChurnPermit(rollover.state, rollover.nextActive, tick + 1),
    newLanes,
    tick + 1,
  );
}

function scopeChurnObservations(
  generation: number,
): MarketBaseRoomObservation[] {
  return [
    V3_TEST_ROOM,
    ...Array.from({ length: 15 }, (_value, index) => `E${index + 1}N1`),
  ].map((roomName, index) => ({
    roomName,
    visible: true,
    controllerMy: true,
    controllerOwner: V3_TEST_ACCOUNT,
    terminalId: `terminal:scope-churn:${generation}:${roomName}`,
    terminalOwned: true,
    roomClass: (generation + index) % 2 === 0 ? "normal" : "hub",
  }));
}

describe("Market Base Resource high-risk decision and retirement contracts", () => {

  it("覆盖最高净价、二读与 outer CAS fail-closed，以及 225+ retirement 边界", () => {
    // 子场景 1：fresh planner fixture，normal lane 跨资源统一按单位净价选 winner。
    {
      const h = entry(RESOURCE_HYDROGEN, ["W1N1"], "writable", 100);
      const x = entry(RESOURCE_CATALYST, ["W2N2"], "writable", 500);
      const deps = dependencies({
        scope: scope([h, x]),
        books: {
          [RESOURCE_HYDROGEN]: [
            order("h-large-low", RESOURCE_HYDROGEN, 200, 100_000, "E20S20"),
          ],
          [RESOURCE_CATALYST]: [
            order("x-small-high", RESOURCE_CATALYST, 700, 1_000, "E21S21"),
          ],
        },
      });

      const result = planMarketBaseResourceTwoRead(deps);

      expect(result.complete).toBe(true);
      expect(result.selected).toMatchObject({
        resourceType: RESOURCE_CATALYST,
        roomName: "W2N2",
        order: { id: "x-small-high" },
      });
      expect(
        deps.readCurrentBuyOrders.mock.calls.filter(
          ([resource]) => resource === RESOURCE_HYDROGEN,
        ),
      ).toHaveLength(2);
      expect(
        deps.readCurrentBuyOrders.mock.calls.filter(
          ([resource]) => resource === RESOURCE_CATALYST,
        ),
      ).toHaveLength(2);
      expect(result.firstReadEvidence).toBeDefined();
      expect(result.actualTransactionEnergyEvaluations).toBe(4);
    }

    // 子场景 2：fresh runtime fixture，第二读只改变 protection contribution 也必须零写拒绝。
    {
      const { state, harness, deps, input } = v3RuntimeFixture();
      const runtimeInput = input();
      const originalReadCandidates = runtimeInput.readCandidates;
      let candidateReads = 0;
      runtimeInput.readCandidates = () => {
        candidateReads += 1;
        return originalReadCandidates().map((candidate) =>
          candidateReads === 2 && candidate.resourceType === RESOURCE_CATALYST
            ? {
                ...candidate,
                protectionEntry: {
                  ...candidate.protectionEntry,
                  sourceContributions: [
                    {
                      dedupeKey: "second-read-protection-only",
                      stableKey: "second-read-protection-only",
                      anonymous: false,
                      bucket: "hardReserve" as const,
                      amount: 0,
                      sourceKinds: ["floor" as const],
                      observedAt: harness.tick,
                      expiresAt: harness.tick + 10,
                    },
                  ],
                },
              }
            : candidate,
        );
      };

      const result = runMarketBaseResourceAutomation(state, runtimeInput, deps);

      expect(candidateReads).toBe(2);
      expect(result.planComplete).toBe(false);
      expect(result.writes).toBe(0);
      expect(result.rejectedByReason).toHaveProperty(
        "market_base_second_read_scope_changed",
      );
      expect(state.lastPlanningSnapshot?.selected).toBeUndefined();
      expect(state.ledger?.pending).toBeUndefined();
      expect(deps.commitPreparedState).not.toHaveBeenCalled();
      expect(deps.claimPrepared).not.toHaveBeenCalled();
      expect(deps.executePrepared).not.toHaveBeenCalled();
    }

    // 子场景 3：fresh runtime fixture，prepared root 丢失 outer exact CAS 时保留 WAL 且零 deal。
    {
      const { state, deps, input } = v3RuntimeFixture();
      deps.validatePreparedCanonicalRoot.mockReturnValue(false);

      const result = runMarketBaseResourceAutomation(state, input(), deps);

      expect(deps.commitPreparedState).toHaveBeenCalledTimes(1);
      expect(deps.validatePreparedCanonicalRoot).toHaveBeenCalledTimes(1);
      expect(deps.claimPrepared).not.toHaveBeenCalled();
      expect(deps.executePrepared).not.toHaveBeenCalled();
      expect(state.ledger?.pending).toBeDefined();
      expect(result.rejectedByReason).toMatchObject({
        market_base_v3_prepared_root_cas_failed: 1,
      });
    }

    // 子场景 4：fresh scope/permit fixture，33+ room incarnation 的大批 retirement 只按 exact discharge 收敛。
    const fixture = v3RuntimeFixture();
    let scopeState = fixture.state.scope!;
    let chain = fixture.state.permitChain!;
    let oldLanes = scopeState.laneLifecycles;
    const initialScope = JSON.parse(
      JSON.stringify(scopeState),
    ) as MarketBaseResourceScopeState;

    for (let generation = 1; generation <= 2; generation += 1) {
      const reconciled = reconcileLiveMarketBaseResourceScope({
        tick: 200 + generation * 2,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(generation),
        previous: scopeState,
      });
      expect(reconciled.ok).toBe(true);
      if (!reconciled.ok) return;
      scopeState = reconciled.state;
      const newLanes = scopeState.laneLifecycles;
      chain = advanceScopeChurnPermit(
        chain,
        oldLanes,
        newLanes,
        2_000 + generation * 2,
      );
      oldLanes = newLanes;
    }
    expect(scopeState.recentLaneTombstones).toHaveLength(119);
    expect(chain.laneTombstoneCheckpoint.dischargedTombstones).toHaveLength(
      119,
    );
    expect(chain.laneTombstoneCheckpoint.compressedCount).toBe(0);

    const forged = JSON.parse(
      JSON.stringify(chain),
    ) as MarketBaseResourcePermitChainState;
    (forged.laneTombstoneCheckpoint.dischargedTombstones[0] as any).sellerRoom =
      "W0N0";
    const unauthenticated = reconcileLiveMarketBaseResourceScope({
      tick: 206,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(3),
      previous: scopeState,
      permitChain: forged,
    });
    expect(unauthenticated.ok).toBe(false);
    if (unauthenticated.ok === false) {
      expect(unauthenticated.blockers[0]).toMatch(
        /^derived_lane_tombstone_permit_invalid:/,
      );
    }

    const pinnedLaneId = scopeState.recentLaneTombstones[0].laneId;
    const pinned = reconcileLiveMarketBaseResourceScope({
      tick: 206,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(3),
      previous: scopeState,
      permitChain: chain,
      pinnedLaneIds: [pinnedLaneId],
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.state.recentLaneTombstones).toHaveLength(113);
    expect(
      pinned.state.recentLaneTombstones.some(
        (lane) => lane.laneId === pinnedLaneId,
      ),
    ).toBe(true);
    expect(pinned.state.laneTombstoneDischargeCheckpoint.dischargedCount).toBe(
      118,
    );

    const unpinned = reconcileLiveMarketBaseResourceScope({
      tick: 207,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(3),
      previous: pinned.state,
      permitChain: chain,
      pinnedLaneIds: [],
      expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
        pinned.state.laneTombstoneDischargeCheckpoint.checkpointCommitment,
    });
    expect(unpinned.ok).toBe(true);
    if (!unpinned.ok) return;
    expect(unpinned.state.recentLaneTombstones).toHaveLength(112);
    expect(
      unpinned.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(119);

    const generation33Lanes = unpinned.state.laneLifecycles;
    chain = advanceScopeChurnPermit(chain, oldLanes, generation33Lanes, 2_100);
    expect(chain.laneTombstoneCheckpoint.compressedCount).toBe(7);
    expect(chain.laneTombstoneCheckpoint.dischargedTombstones).toHaveLength(
      224,
    );

    const generation34 = reconcileLiveMarketBaseResourceScope({
      tick: 208,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(4),
      previous: unpinned.state,
      permitChain: chain,
      pinnedLaneIds: [],
    });
    expect(generation34.ok).toBe(true);
    if (!generation34.ok) return;
    expect(
      generation34.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(231);
    expect(generation34.state.recentLaneTombstones).toHaveLength(112);

    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 209,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(4),
        previous: generation34.state,
        permitChain: chain,
        expectedPermitLaneTombstoneCheckpointCommitment: v3Digest(
          "rolled-permit-tombstone-checkpoint",
        ),
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_permit_checkpoint_rollback"],
    });

    const tampered = JSON.parse(
      JSON.stringify(generation34.state),
    ) as MarketBaseResourceScopeState;
    (tampered.laneTombstoneDischargeCheckpoint as any).dischargedPrefixHead =
      v3Digest("tampered-scope-discharge");
    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 209,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(4),
        previous: tampered,
        permitChain: chain,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_invalid"],
    });

    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 209,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(4),
        previous: unpinned.state,
        permitChain: chain,
        expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
          generation34.state.laneTombstoneDischargeCheckpoint
            .checkpointCommitment,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_rollback"],
    });

    const oldLaneRevival = reconcileLiveMarketBaseResourceScope({
      tick: 209,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(0),
      previous: initialScope,
      permitChain: chain,
      expectedPreviousRoomCheckpointCommitment:
        generation34.state.roomRegistry.checkpointCommitment,
    });
    expect(oldLaneRevival.ok).toBe(false);
    if (oldLaneRevival.ok === false) {
      expect(oldLaneRevival.blockers).toContain(
        "room_incarnation_external_checkpoint_mismatch",
      );
    }
  });
});

describe("Market Base Resource V3 live WAL glue", () => {

  it("Shadow batch 内 CPU cut 携带 incomplete fallback 但不再销毁已积累周期", () => {
    const { state, harness, deps, input } = v3RuntimeFixture(false);
    harness.tick = 200;
    state.preflightAt = harness.tick;
    const hydrogenLane = state.scope!.laneLifecycles.find(
      (lane) => lane.resource === RESOURCE_HYDROGEN,
    )!;
    for (let tick = 101; tick <= 199; tick += 1) {
      state.scope = applyMarketBaseResourceShadowObservations(
        state.scope!,
        tick,
        [{ laneId: hydrogenLane.laneId, result: "safe_no_opportunity" }],
        undefined,
      );
    }
    const canonicalSource = { ...state };
    const cursorBefore = state.scope!.shadowCursor;
    let determinedIncomplete = false;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (resource === RESOURCE_HYDROGEN) {
          determinedIncomplete = true;
          throw new Error("injected shadow book gap before batch");
        }
        return [];
      },
    );
    deps.cpuUsed.mockImplementation(() =>
      determinedIncomplete ? 26 : 1,
    );

    const result = runMarketBaseResourceAutomation(
      state,
      { ...input(), cpuStartedAt: 0 },
      deps,
    );

    expect(result.planComplete).toBe(false);
    expect(result.rejectedByReason).toMatchObject({
      market_base_cpu_ceiling_exceeded: 1,
    });
    expect(result.cpuTrace).toMatchObject({
      cpuCutPhase: "market_facts_read1",
      marketFactsDisposition: "read",
    });
    expect(result.cpuFallbackCapability).toBeDefined();
    expect(
      marketBaseResourceCpuFallbackRequiresCanonicalCommit(
        result.cpuFallbackCapability,
        canonicalSource,
        harness.tick,
      ),
    ).toBe(true);
    const fallback = materializeMarketBaseResourceCpuFallback(
      result.cpuFallbackCapability,
      result.cpuTrace!,
    );
    expect(fallback?.appliedResetCount).toBe(1);
    expect(fallback?.state.scope?.shadowCursor).toBe(cursorBefore);
    expect(
      fallback?.state.scope?.laneLifecycles.find(
        (lane) => lane.laneId === hydrogenLane.laneId,
      ),
    ).toMatchObject({
      stage: "shadow",
      status: "suspended",
      shadowEvidence: { completeCycles: 99 },
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("incomplete 与同 tick 冲突观察保持周期证据，tick 回滚仍清零", () => {
    const { state } = v3RuntimeFixture(false);
    const lane = state.scope!.laneLifecycles[0]!;
    const scope = state.scope!;

    const accumulated = applyMarketBaseResourceShadowObservations(
      scope,
      100,
      [{ laneId: lane.laneId, result: "safe_no_opportunity" }],
      undefined,
    );
    const accumulatedLane = accumulated.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(accumulatedLane.shadowEvidence.completeCycles).toBe(1);

    const afterIncomplete = applyMarketBaseResourceShadowObservations(
      accumulated,
      110,
      [
        {
          laneId: lane.laneId,
          result: "incomplete",
          blocker: "market_base_terminal_incomplete",
        },
      ],
      undefined,
    );
    const incompleteLane = afterIncomplete.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(incompleteLane.shadowEvidence.completeCycles).toBe(1);
    expect(incompleteLane.shadowEvidence.lastCompleteTick).toBe(100);
    expect(incompleteLane.shadowEvidence.evidenceDigest).toBe(
      accumulatedLane.shadowEvidence.evidenceDigest,
    );

    const afterConflict = applyMarketBaseResourceShadowObservations(
      afterIncomplete,
      120,
      [
        { laneId: lane.laneId, result: "safe_opportunity" },
        { laneId: lane.laneId, result: "safe_no_opportunity" },
      ],
      undefined,
    );
    const conflictLane = afterConflict.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(conflictLane.shadowEvidence.completeCycles).toBe(1);
    expect(conflictLane.shadowEvidence.lastCompleteTick).toBe(100);

    // 三重冲突 [A,B,A]：第 3 条与第 1 条相同的观察不得复活计数
    const afterTripleConflict = applyMarketBaseResourceShadowObservations(
      afterConflict,
      130,
      [
        { laneId: lane.laneId, result: "safe_opportunity" },
        { laneId: lane.laneId, result: "safe_no_opportunity" },
        { laneId: lane.laneId, result: "safe_opportunity" },
      ],
      undefined,
    );
    const tripleConflictLane = afterTripleConflict.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(tripleConflictLane.shadowEvidence.completeCycles).toBe(1);
    expect(tripleConflictLane.shadowEvidence.lastCompleteTick).toBe(100);

    const afterRollback = applyMarketBaseResourceShadowObservations(
      afterTripleConflict,
      99,
      [{ laneId: lane.laneId, result: "safe_no_opportunity" }],
      undefined,
    );
    const rollbackLane = afterRollback.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(rollbackLane.shadowEvidence.completeCycles).toBe(0);

    // wait 类结果是完整观察，照常累计
    let waitScope = afterRollback;
    for (let tick = 200; tick <= 298; tick += 1) {
      waitScope = applyMarketBaseResourceShadowObservations(
        waitScope,
        tick,
        [{ laneId: lane.laneId, result: "production_priority_wait" }],
        undefined,
      );
    }
    const waitLane = waitScope.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(waitLane.shadowEvidence.completeCycles).toBe(99);
    expect(waitLane.stage).toBe("shadow");

    // 第 100 个完整观察触发 qualified，此后 incomplete 保持 qualified（冻结）
    let qualifiedScope = applyMarketBaseResourceShadowObservations(
      waitScope,
      299,
      [{ laneId: lane.laneId, result: "wait_no_opportunity" }],
      undefined,
    );
    let qualifiedLane = qualifiedScope.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(qualifiedLane.stage).toBe("qualified");
    expect(qualifiedLane.shadowEvidence.completeCycles).toBe(100);

    qualifiedScope = applyMarketBaseResourceShadowObservations(
      qualifiedScope,
      300,
      [
        {
          laneId: lane.laneId,
          result: "incomplete",
          blocker: "market_base_protection_incomplete",
        },
      ],
      undefined,
    );
    qualifiedLane = qualifiedScope.laneLifecycles.find(
      (candidate) => candidate.laneId === lane.laneId,
    )!;
    expect(qualifiedLane.stage).toBe("qualified");
    expect(qualifiedLane.shadowEvidence.completeCycles).toBe(100);
    expect(qualifiedLane.shadowEvidence.lastCompleteTick).toBe(299);
  });
});
