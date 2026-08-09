import {
  MARKET_BASE_RESOURCE_CANONICAL_OPERATOR_AUTHORIZATION_FINGERPRINT,
  MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
  applyMarketBaseResourceShadowObservations,
  buildMarketBaseResourcePricingRatchetState,
  marketBaseResourceCpuFallbackRequiresCanonicalCommit,
  marketBaseResourceOperatorAuthorizationFingerprint,
  materializeMarketBaseResourceCpuFallback,
  observeMarketBaseResourceOuterPrecommitCpu,
  planMarketBaseResourceTwoRead,
  reconcileLiveMarketBaseResourceScope,
  runMarketBaseResourceAutomation,
  validateMarketBaseResourceReadinessRuntimeCapability,
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
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
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
  directSafetyFingerprint,
  MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT,
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

/** 仅用于覆盖 immutable catalog 到 direct-planner 映射的篡改边界。 */
function immutablePolicyEntry(
  resource: "H" | "K" | "L" | "O" | "U" | "X" | "Z",
  rooms: readonly string[],
  authorization: "writable" | "suspended_shadow" = "writable",
): ReturnType<typeof entry> {
  const base = entry(resource, rooms, authorization, 10);
  const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
  return {
    ...base,
    policy: {
      ...base.policy,
      entryId: policy.policyId,
      revision: policy.policyRevision,
      resourceType: policy.resource,
      hardNetFloor: policy.hardFloor,
      economicNetFloor: policy.economicFloor,
      historyNetFloor: policy.economicFloor,
      ratchetNetFloor: policy.economicFloor,
      minExecutableNotional: policy.minOrderNotional,
      maxRawOrders: policy.maxRawOrdersScanned,
      maxEligibleOrders: policy.maxEligibleOrdersPriced,
      maxTransactionEnergy: policy.maxTransactionEnergy,
      terminalEnergyReserve: policy.terminalEnergyReserve,
      resourceRollingCap: policy.rollingMaxAmount,
      opportunityReserve: policy.rollingOpportunityReserveAmount,
    },
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

describe("Market Base Resource V3 runtime", () => {
  it("跨资源和房间统一选择最高单位净价，不受大额低价单优先级影响", () => {
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
  });

  it("resource cohort 的候选批规划只处理同资源 ready 精确子集", () => {
    const makeHarness = (): Harness => {
      const entries = [
        immutablePolicyEntry(
          "H",
          ["E3N59", "E4N58"],
          "suspended_shadow",
        ),
        immutablePolicyEntry(
          "L",
          ["E7N57", "E1N57"],
          "suspended_shadow",
        ),
        immutablePolicyEntry("U", ["E7N57"], "suspended_shadow"),
        immutablePolicyEntry("O", ["E5N59"], "suspended_shadow"),
        immutablePolicyEntry("Z", ["E5N59"], "suspended_shadow"),
        immutablePolicyEntry("X", ["W1N57"], "suspended_shadow"),
      ].map((candidate) => ({
        ...candidate,
        quota: {
          ...candidate.quota,
          rollingCap: candidate.policy.resourceRollingCap,
        },
      }));
      entries
        .find((candidate) => candidate.policy.resourceType === RESOURCE_HYDROGEN)!
        .lanes.find((lane) => lane.lane.roomName === "E4N58")!.lane.hub = true;
      for (const [resource, roomName] of [
        [RESOURCE_HYDROGEN, "E3N59"],
        [RESOURCE_OXYGEN, "E5N59"],
        [RESOURCE_UTRIUM, "E7N57"],
      ] as const) {
        entries
          .find((candidate) => candidate.policy.resourceType === resource)!
          .lanes.find((lane) => lane.lane.roomName === roomName)!
          .protection.complete = false;
      }
      const bookShape: Array<{
        resource: ResourceConstant;
        raw: number;
        eligibleRooms: readonly string[];
      }> = [
        { resource: RESOURCE_HYDROGEN, raw: 16, eligibleRooms: ["E1S10", "E2S10"] },
        { resource: RESOURCE_LEMERGIUM, raw: 18, eligibleRooms: ["E3S10", "E4S10"] },
        { resource: RESOURCE_UTRIUM, raw: 14, eligibleRooms: ["E5S10"] },
        { resource: RESOURCE_OXYGEN, raw: 15, eligibleRooms: ["E6S10"] },
        { resource: RESOURCE_ZYNTHIUM, raw: 14, eligibleRooms: ["E7S10"] },
        { resource: RESOURCE_CATALYST, raw: 17, eligibleRooms: ["E8S10"] },
      ];
      const books = Object.fromEntries(
        bookShape.map(({ resource, raw, eligibleRooms }) => {
          const candidates = eligibleRooms.map((roomName, index) =>
            order(
              `${resource}-eligible-${index}`,
              resource,
              700,
              1_000,
              roomName,
            ));
          const lowOrders = Array.from(
            { length: raw - candidates.length },
            (_unused, index) =>
              order(
                `${resource}-low-${String(index).padStart(2, "0")}`,
                resource,
                1,
                index === 0 ? 100_000 : 1_000,
                `W${index + 1}S20`,
              ),
          );
          return [resource, [...lowOrders, ...candidates]];
        }),
      ) as Partial<Record<ResourceConstant, MarketOrderSnapshot[]>>;
      return { scope: scope(entries), books };
    };
    const batchDeps = dependencies(makeHarness());
    const fallbackDeps = dependencies(makeHarness());
    const batchProbe = jest.fn();
    const throwingProbe = jest.fn((_used: boolean) => {
      throw new Error("force fresh-capability fallback oracle");
    });
    batchDeps.observeShadowNormalizationArtifact = batchProbe;
    fallbackDeps.observeShadowNormalizationArtifact = throwingProbe;

    const batch = planMarketBaseResourceTwoRead(batchDeps);
    const fallback = planMarketBaseResourceTwoRead(fallbackDeps);

    expect(batch.complete).toBe(true);
    expect(batch.selected).toBeUndefined();
    expect(batch.firstReadEvidence).toBeUndefined();
    expect(batch.rawOrderCount).toBe(16);
    expect(batch.eligibleOrderCount).toBe(2);
    expect(batch.distinctOrderRoomCount).toBe(2);
    expect(batch.transactionCostEvaluationBudget).toBe(8);
    expect(batch.sampledShadowLaneIds).toHaveLength(2);
    expect(batch.shadowObservations.filter(
      (observation) =>
        observation.result === "incomplete" &&
        observation.blocker === "market_base_protection_incomplete",
    )).toHaveLength(1);
    expect(batch.shadowObservations.filter(
      (observation) => observation.result === "safe_opportunity",
    )).toHaveLength(1);
    expect(batch.shadowPlannerMode).toBe("batch_candidate");
    expect(batch.shadowPlannerInvocationCount).toBe(1);
    expect(batch.actualTransactionEnergyEvaluations).toBe(4);
    expect(batch.evaluatedShadowResourceCount).toBe(1);
    expect(batch.candidateIdentityOrderChecks).toBe(16);
    expect(batchProbe).toHaveBeenCalledTimes(1);
    expect(batchProbe).toHaveBeenLastCalledWith(false);
    expect(fallback.complete).toBe(true);
    expect(fallback.shadowObservations).toEqual(batch.shadowObservations);
    expect(fallback.shadowPlannerMode).toBe("batch_fallback");
    expect(fallback.shadowPlannerInvocationCount).toBe(2);
    expect(throwingProbe).toHaveBeenCalledTimes(2);
  });
});

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

function currentPolicyPricingRatchet(initializedAt = 100) {
  return buildMarketBaseResourcePricingRatchetState({
    initializedAt,
    entries: MARKET_BASE_RESOURCE_POLICIES.map((policy) => ({
      resource: policy.resource,
      value: policy.economicFloor,
      marketDate: "2026-07-27",
    })),
  });
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

describe("Market Base Resource scope tombstone discharge", () => {

  it("current permit grant 未 discharge 时保持 tombstone，historical pending pin 延迟 exact 消费", () => {
    const fixture = v3RuntimeFixture();
    const firstRetirement = reconcileLiveMarketBaseResourceScope({
      tick: 200,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(1),
      previous: fixture.state.scope,
    });
    expect(firstRetirement.ok).toBe(true);
    if (!firstRetirement.ok) return;
    const rollover = rolloverScopeChurnPermit(
      fixture.state.permitChain!,
      fixture.state.scope!.laneLifecycles,
      firstRetirement.state.laneLifecycles,
      2_000,
    );
    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 201,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(1),
        previous: firstRetirement.state,
        permitChain: rollover.state,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_pin_set_missing"],
    });
    const currentPinned = reconcileLiveMarketBaseResourceScope({
      tick: 201,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(1),
      previous: firstRetirement.state,
      permitChain: rollover.state,
      pinnedLaneIds: [],
    });
    expect(currentPinned.ok).toBe(true);
    if (!currentPinned.ok) return;
    expect(currentPinned.state.recentLaneTombstones).toHaveLength(7);
    expect(
      currentPinned.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(0);

    const discharged = appendScopeChurnPermit(
      rollover.state,
      buildScopeChurnPermit(rollover.state, rollover.nextActive, 2_001),
      firstRetirement.state.laneLifecycles,
      2_001,
    );
    const pendingLaneId = currentPinned.state.recentLaneTombstones[0].laneId;
    const pendingPinned = reconcileLiveMarketBaseResourceScope({
      tick: 202,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(1),
      previous: currentPinned.state,
      permitChain: discharged,
      pinnedLaneIds: [pendingLaneId],
    });
    expect(pendingPinned.ok).toBe(true);
    if (!pendingPinned.ok) return;
    expect(pendingPinned.state.recentLaneTombstones).toHaveLength(1);
    expect(pendingPinned.state.recentLaneTombstones[0].laneId).toBe(
      pendingLaneId,
    );
    expect(
      pendingPinned.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(6);
  });

  it("33+ room incarnation 形成 225+ lane retirement 时只消费 exact permit discharge", () => {
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

  it("第二读仅 protection contribution 变化时拒绝 evidence 且零 pending/commit/claim/deal", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    const runtimeInput = input();
    const originalReadCandidates = runtimeInput.readCandidates;
    let candidateReads = 0;
    runtimeInput.readCandidates = () => {
      candidateReads += 1;
      return originalReadCandidates().map((candidate) =>
        candidateReads === 2 &&
        candidate.resourceType === RESOURCE_CATALYST
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
  });

  it("inner apply CPU cut 保留一次性 reset-only capability，且 clone/重放均失败", () => {
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
        [
          {
            laneId: hydrogenLane.laneId,
            result: "safe_no_opportunity",
          },
        ],
        undefined,
      );
    }
    const canonicalScope = state.scope!;
    const canonicalSource = { ...state };
    const cursorBefore = canonicalScope.shadowCursor;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (resource === RESOURCE_HYDROGEN) {
          throw new Error("injected shadow book gap");
        }
        return [];
      },
    );
    deps.cpuUsed.mockImplementation(() =>
      state.scope === canonicalScope ? 1 : 26,
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
      observedAt: harness.tick,
      cpuAfterOuterSession: 1,
      cpuAfterScopeCore: 1,
      cpuAfterMarketFacts: 1,
      cpuAfterShadowBatch: 1,
      cpuAfterInnerApply: 26,
      cpuCutPhase: "inner_apply",
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
    const clonedCapability = JSON.parse(
      JSON.stringify(result.cpuFallbackCapability),
    );
    expect(
      materializeMarketBaseResourceCpuFallback(
        clonedCapability,
        result.cpuTrace!,
      ),
    ).toBeUndefined();

    const fallback = materializeMarketBaseResourceCpuFallback(
      result.cpuFallbackCapability,
      result.cpuTrace!,
    );
    expect(fallback).toBeDefined();
    expect(fallback?.appliedResetCount).toBe(1);
    expect(fallback?.state.scope?.shadowCursor).toBe(cursorBefore);
    expect(
      fallback?.state.scope?.laneLifecycles.find(
        (lane) => lane.laneId === hydrogenLane.laneId,
      ),
    ).toMatchObject({
      stage: "shadow",
      status: "suspended",
      shadowEvidence: { completeCycles: 0 },
    });
    expect(fallback?.state.lastPlanningSnapshot?.selected).toBeUndefined();
    expect(
      validateMarketBaseResourceReadinessRuntimeCapability(
        fallback?.readinessRuntimeCapability,
        fallback!.state,
        harness.tick,
        fallback?.ledgerRuntimeAnchor,
      ),
    ).toBe(true);
    expect(fallback?.state).not.toBe(result.state);
    expect(
      materializeMarketBaseResourceCpuFallback(
        result.cpuFallbackCapability,
        result.cpuTrace!,
      ),
    ).toBeUndefined();
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("Shadow batch 内 CPU cut 仍为已确定的 99-cycle reset 铸造 fallback", () => {
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
      shadowEvidence: { completeCycles: 0 },
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("outer anchor reader 与 runtime session 铸造成本计入同一 25 CPU 窗口", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    state.preflightAt = harness.tick;
    // 模拟上一版 bundle 留下、尚无 Shadow planner telemetry 的 snapshot。
    (state as any).lastPlanningSnapshot = {
      observedAt: harness.tick - 1,
      complete: true,
      sampledShadowLaneIds: [],
      cpuUsed: 1,
      rawOrderCount: 0,
      eligibleOrderCount: 0,
      distinctOrderRoomCount: 0,
      transactionCostEvaluationBudget: 0,
    };
    let anchorRead = false;
    const readLedgerRuntimeAnchor = deps.readLedgerRuntimeAnchor as jest.Mock;
    readLedgerRuntimeAnchor.mockImplementation(
      (current: MarketBaseResourceV3RuntimeState) => {
        anchorRead = true;
        return buildMarketBaseResourceLedgerRuntimeAnchor(
          current.ledger!,
          current.permitChain!,
        );
      },
    );
    deps.cpuUsed.mockImplementation(() => (anchorRead ? 26 : 0));

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_cpu_ceiling_exceeded: 1,
    });
    expect(readLedgerRuntimeAnchor).toHaveBeenCalledTimes(1);
    expect(deps.readCurrentBuyOrders).not.toHaveBeenCalled();
    expect(state.lastPlanningSnapshot).toMatchObject({
      complete: false,
      blocker: "market_base_cpu_ceiling_exceeded",
      shadowPlannerMode: "none",
      shadowPlannerInvocationCount: 0,
      actualTransactionEnergyEvaluations: 0,
      evaluatedShadowResourceCount: 0,
      candidateIdentityOrderChecks: 0,
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("pre-planner CPU cut 不把上一 tick 的非零 planner telemetry 冒充当前值", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    state.preflightAt = harness.tick;
    state.lastPlanningSnapshot = {
      observedAt: harness.tick - 1,
      complete: true,
      sampledShadowLaneIds: ["previous-lane"],
      cpuUsed: 10,
      rawOrderCount: 94,
      eligibleOrderCount: 8,
      distinctOrderRoomCount: 8,
      transactionCostEvaluationBudget: 96,
      shadowPlannerMode: "batch_candidate",
      shadowPlannerInvocationCount: 1,
      actualTransactionEnergyEvaluations: 12,
      evaluatedShadowResourceCount: 6,
      candidateIdentityOrderChecks: 94,
    };
    let anchorRead = false;
    (deps.readLedgerRuntimeAnchor as jest.Mock).mockImplementation(
      (current: MarketBaseResourceV3RuntimeState) => {
        anchorRead = true;
        return buildMarketBaseResourceLedgerRuntimeAnchor(
          current.ledger!,
          current.permitChain!,
        );
      },
    );
    deps.cpuUsed.mockImplementation(() => (anchorRead ? 26 : 0));

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_cpu_ceiling_exceeded: 1,
    });
    expect(deps.readCurrentBuyOrders).not.toHaveBeenCalled();
    expect(deps.calculateTransactionEnergy).not.toHaveBeenCalled();
    expect(state.lastPlanningSnapshot).toMatchObject({
      observedAt: harness.tick,
      complete: false,
      blocker: "market_base_cpu_ceiling_exceeded",
      sampledShadowLaneIds: [],
      rawOrderCount: 0,
      eligibleOrderCount: 0,
      distinctOrderRoomCount: 0,
      transactionCostEvaluationBudget: 0,
      shadowPlannerMode: "none",
      shadowPlannerInvocationCount: 0,
      actualTransactionEnergyEvaluations: 0,
      evaluatedShadowResourceCount: 0,
      candidateIdentityOrderChecks: 0,
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("prepared root 在 claim 前失去 outer exact CAS 时保留 WAL、零 claim、零 deal", () => {
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
  });
});
