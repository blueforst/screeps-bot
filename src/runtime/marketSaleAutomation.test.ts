import {
  MARKET_MAKER_HYBRID_PERMANENTLY_DISABLED,
  acceptMarketBaseResourcePermit,
  advanceMarketBaseResourceActivationAnchor,
  acceptMarketDirectContinuousPermit,
  grantMarketSaleMutationLease,
  marketBaseResourceStatus,
  marketDirectContinuousStatus,
  proposeMarketBaseResourcePermit,
  proposeMarketDirectContinuousPermit,
  resolveMarketSaleExternalOrderMutation,
  resolveMarketSaleOrderDisappearance,
  runMarketSaleAutomation,
  runMarketSalePreflight,
  type MarketBaseResourceActivationAnchor,
  type MarketBaseResourceContinuousReviewSnapshot,
  type MarketSalePlanCandidate,
} from "@/runtime/marketSaleAutomation";
import * as marketBaseResourceAutomationModule from "@/runtime/marketBaseResourceAutomation";
import * as marketSaleProtectionAdapterModule from "@/runtime/marketSaleProtectionAdapter";
import {
  applyMarketBaseResourceShadowObservations,
  createMarketBaseResourceReadinessRuntimeCapability,
  type MarketBaseResourceAutomationResult,
  type MarketBaseResourceV3RuntimeState,
} from "@/runtime/marketBaseResourceAutomation";
import * as marketBaseResourceLedgerModule from "@/runtime/marketBaseResourceLedger";
import * as marketBaseResourcePermitModule from "@/runtime/marketBaseResourcePermit";
import {
  MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS,
  MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
  MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT,
  MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT,
  advanceMarketBaseResourceWal,
  advanceMarketBaseResourceWalWithRuntimeContext,
  buildMarketBaseResourceLedgerRuntimeAnchor,
  buildMarketBaseResourceHistoricalPermitRef,
  createMarketBaseResourceLedgerRuntimeContext,
  prepareMarketBaseResourceAttempt,
  prepareMarketBaseResourceAttemptWithRuntimeContext,
  recordMarketBaseResourceOutcome,
  recordMarketBaseResourceOutcomeWithRuntimeContext,
  sealMarketBaseResourceOutcome,
  type MarketBaseResourceLedger,
  type MarketBaseResourceReceipt,
  type PrepareMarketBaseResourceAttemptInput,
} from "@/runtime/marketBaseResourceLedger";
import { prepareContinuousAttempt } from "@/runtime/marketDirectContinuousLedger";
import type {
  MarketBaseResourcePermit,
  MarketBaseResourceSignedLaneGrant,
} from "@/runtime/marketBaseResourcePermit";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_POLICIES,
} from "@/runtime/marketBaseResourcePolicy";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import {
  clearMarketActionArbiterForTest,
  getTerminalActionClaims,
} from "@/runtime/marketActionArbiter";
import { runResourceControl } from "@/runtime/resourceControl";
import { createDirectAutomationState } from "@/runtime/marketSaleDirectAutomation";
import {
  LEGACY_X_V1_OUTCOME_GOLDEN,
  type MarketDirectContinuousAutomationState,
} from "@/runtime/marketDirectContinuousAutomation";
import type {
  MarketProtectionContribution,
  MarketProtectionEntry,
} from "@/runtime/marketSaleProtection";

type MutableMarket = Partial<Market> & {
  orders: Record<string, Order>;
  credits: number;
  outgoingTransactions: Transaction[];
};

function installMarket(overrides: Partial<MutableMarket> = {}): MutableMarket {
  const market: MutableMarket = {
    orders: {},
    credits: 1_000_000,
    outgoingTransactions: [],
    incomingTransactions: [],
    createOrder: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
    deal: jest.fn(() => OK),
    getAllOrders: jest.fn(() => []),
    getHistory: jest.fn(() => []),
    calcTransactionCost: jest.fn(() => 0),
    ...overrides,
  };
  (Game as unknown as { market: MutableMarket }).market = market;
  return market;
}

function installRoom(
  roomName = "W1N1",
  resource: ResourceConstant = RESOURCE_KEANIUM,
): StructureTerminal {
  const amounts: Partial<Record<ResourceConstant, number>> = {
    [RESOURCE_ENERGY]: 100_000,
    [resource]: 20_000,
  };
  const terminal = {
    cooldown: 0,
    send: jest.fn(() => OK),
    store: {
      getUsedCapacity: (requested?: ResourceConstant) =>
        requested ? amounts[requested] || 0 : 120_000,
      getFreeCapacity: () => 180_000,
    },
  } as unknown as StructureTerminal;
  const room = {
    name: roomName,
    controller: { my: true },
    terminal,
    find: jest.fn(() => []),
  } as unknown as Room;
  (terminal as unknown as { room: Room }).room = room;
  Game.rooms[roomName] = room;
  return terminal;
}

function validConfig(
  mode: "off" | "shadow" | "maker" | "hybrid" | "emergencyStop",
  revision = "rev-1",
): void {
  Memory.cfg = {
    resourceControl: { market: { enabled: true } },
    factoryControl: { market: { enabled: true } },
    marketSaleAutomation: {
      mode,
      configRevision: revision,
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      economicFloor: { [RESOURCE_KEANIUM]: 1.1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 1_000 },
      minDealAmount: 100,
      maxDealAmount: 5_000,
      makerBatchAmount: 1_000,
      maxManagedOrders: 3,
      minFreeOrderSlots: 5,
      creditReserve: 10_000,
      rollingFeeBudget: 1_000_000,
      feeWindowTicks: 20_000,
      terminalEnergyReserve: 25_000,
      orderPolicyTtl: 20_000,
      mutationBackoffTicks: 10,
      canary: { enabled: true, allowExpansion: false },
    },
  };
}

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    created: Game.time,
    type: ORDER_SELL,
    resourceType: RESOURCE_KEANIUM,
    roomName: "W1N1",
    price: 2,
    totalAmount: 1_000,
    remainingAmount: 1_000,
    amount: 1_000,
    active: true,
    ...overrides,
  } as Order;
}

function protectionEntry(
  overrides: Partial<MarketProtectionEntry> = {},
): MarketProtectionEntry {
  return {
    roomName: "W1N1",
    resource: RESOURCE_KEANIUM,
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    totalStock: 20_000,
    terminalStock: 20_000,
    hardReserve: 5_000,
    productionDemand: 0,
    forecastBuffer: 1_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 6_000,
    grossSurplus: 14_000,
    managedExposure: 0,
    newExposureCapacity: 14_000,
    sellableAmount: 14_000,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
    ...overrides,
  };
}

function managedExposureContribution(
  orderId: string,
  amount: number,
): MarketProtectionContribution {
  return {
    dedupeKey: `managed:${orderId}`,
    stableKey: `managed:${orderId}`,
    anonymous: false,
    bucket: "managedExposure",
    amount,
    sourceKinds: ["managedExposure"],
    managedOrderId: orderId,
    observedAt: Game.time,
    expiresAt: Game.time,
  };
}

function continuousPlanningFingerprint(evidence: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < evidence.length; index += 1) {
    hash ^= evidence.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `market-direct-continuous:plan:v1:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}:${evidence.length}`;
}

function candidate(
  overrides: Partial<MarketSalePlanCandidate> = {},
): MarketSalePlanCandidate {
  return {
    roomName: "W1N1",
    resourceType: RESOURCE_KEANIUM,
    protectionEntry: protectionEntry(),
    effectiveNetFloor: 1.1,
    makerPrice: 2,
    trustedPrice: true,
    trustedDepth: true,
    capacityState: "normal",
    hasCriticalConflict: false,
    isHubRoom: false,
    minimumTerminalFreeCapacity: 0,
    ...overrides,
  };
}

function installManagedOrder(orderId: string): void {
  const managed = managedOrderState(orderId);
  (Memory as unknown as { data: unknown }).data = {
    marketSaleAutomation: {
      managedOrders: {
        [orderId]: managed,
      },
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
      drain: { phase: "maker", zeroConfirmations: 0 },
    },
  };
}

function managedOrderState(
  orderId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orderId,
    roomName: "W1N1",
    resourceType: RESOURCE_KEANIUM,
    price: 2,
    originalAmount: 1_000,
    lastRemainingAmount: 1_000,
    remainingExposure: 1_000,
    feeDebtMilli: 100_000,
    createdAt: Game.time - 10,
    lastSeenAt: Game.time - 1,
    policyCancelAtTick: Game.time + 1_000,
    serverCreatedTick: Game.time - 10,
    ...overrides,
  };
}

function qualifyMaker(revision = "rev-1"): void {
  validConfig("shadow", revision);
  Memory.runtime = {
    resourceControl: {
      updatedAt: Game.time,
      rooms: {},
      lastActions: [],
      lastMarketActions: [],
    },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    const result = runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    if (result.phase === "shadow") break;
    Game.time += 1;
  }
  expect(Memory.runtime!.marketSaleAutomation!.phase).toBe("shadow");
  Memory.runtime!.marketSaleAutomation!.shadowConsecutiveCycles = 100;
  Memory.cfg!.marketSaleAutomation!.mode = "maker";
}

function installContinuousDirectConfig(): void {
  Memory.cfg = {
    resourceControl: { market: { enabled: true } },
    factoryControl: { market: { enabled: true } },
    marketSaleAutomation: {
      mode: "direct",
      directCapability: "continuous-v2",
      configRevision: "market-direct-continuous-v2-r1",
      sellResources: [RESOURCE_CATALYST, RESOURCE_HYDROGEN, RESOURCE_ZYNTHIUM],
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
    },
  };
}

function installMarketBaseV3DirectConfig(): void {
  Memory.cfg = {
    resourceControl: {
      market: { enabled: true },
    },
    factoryControl: {
      market: { enabled: true },
    },
    marketSaleAutomation: {
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
      canary: {
        enabled: true,
        allowExpansion: false,
      },
    },
  };
}

function installExactReviewedLegacyDirectState(): void {
  const direct = createDirectAutomationState();
  direct.directDealOutcomes = [
    JSON.parse(JSON.stringify(LEGACY_X_V1_OUTCOME_GOLDEN)),
  ];
  direct.processedDirectTransactionKeys = [
    LEGACY_X_V1_OUTCOME_GOLDEN.evidenceKey!,
  ];
  direct.directConfirmedDealCount = 1;
  direct.directPausedForReview = true;
  Memory.data = {
    marketSaleAutomation: {
      directAutomation: direct,
      pendingDirectDeals: direct.pendingDirectDeals,
    },
  } as Memory["data"];
}

function proposeMarketBaseV3CutoverFixture(): string {
  installContinuousDirectConfig();
  installExactReviewedLegacyDirectState();
  const catalystTerminal = installRoom("E6N59", RESOURCE_CATALYST);
  for (const roomName of ["W1N1", "E6N59"]) {
    (
      Game.rooms[roomName].terminal as StructureTerminal & {
        id: Id<StructureTerminal>;
        my: boolean;
      }
    ).id = (
      roomName === "W1N1"
        ? "aaaaaaaaaaaaaaaaaaaaaaaa"
        : "bbbbbbbbbbbbbbbbbbbbbbbb"
    ) as Id<StructureTerminal>;
    (
      Game.rooms[roomName].terminal as StructureTerminal & {
        my: boolean;
      }
    ).my = true;
    (
      Game.rooms[roomName].controller as StructureController & {
        owner?: Owner;
      }
    ).owner = {
      username: "forst",
    };
    (
      Game.rooms[roomName].terminal as StructureTerminal & {
        owner?: Owner;
      }
    ).owner = {
      username: "forst",
    };
  }
  (
    catalystTerminal as StructureTerminal & {
      owner?: Owner;
    }
  ).owner = {
    username: "forst",
  };
  (
    Game as unknown as {
      shard: {
        name: string;
        type: string;
        ptr: boolean;
      };
    }
  ).shard = {
    name: "shard1",
    type: "normal",
    ptr: false,
  };
  runMarketSalePreflight();
  const v2Proposal = proposeMarketDirectContinuousPermit({
    operatorAuthorizationFingerprint: "operator:codex:v3-activation-fixture",
  }) as {
    ok: boolean;
    permit?: { permitId: string };
  };
  expect(v2Proposal.ok).toBe(true);
  expect(
    acceptMarketDirectContinuousPermit(v2Proposal.permit!.permitId),
  ).toMatchObject({ ok: true });
  Game.time += 1;
  expect(runMarketSalePreflight().phase).toBe("direct");
  installMarketBaseV3DirectConfig();
  const v3Proposal = proposeMarketBaseResourcePermit() as {
    ok: boolean;
    proposalId?: string;
  };
  expect(v3Proposal.ok).toBe(true);
  return v3Proposal.proposalId!;
}

function activateMarketBaseV3Fixture(): void {
  const proposalId = proposeMarketBaseV3CutoverFixture();
  expect(acceptMarketBaseResourcePermit(proposalId)).toMatchObject({
    ok: true,
  });
  expect(marketBaseResourceStatus()).toMatchObject({
    active: true,
    cutoverLatched: true,
  });
}

function currentMarketBaseV3StateFixture(): MarketBaseResourceV3RuntimeState {
  const state = (
    Memory.data!.marketSaleAutomation!.directAutomation as unknown as {
      baseResourceV3?: MarketBaseResourceV3RuntimeState;
    }
  ).baseResourceV3;
  expect(state).toBeDefined();
  expect(state?.scope).toBeDefined();
  expect(state?.permitChain).toBeDefined();
  expect(state?.ledger).toBeDefined();
  return state!;
}

function activateMarketBaseV3CanaryFixture(): {
  laneId: string;
  resource: (typeof MARKET_BASE_RESOURCE_CATALOG)[number];
  sellerRoom: string;
} {
  activateMarketBaseV3Fixture();
  const data = Memory.data!.marketSaleAutomation! as unknown as {
    baseResourceV3ActivationAnchor: Parameters<
      typeof advanceMarketBaseResourceActivationAnchor
    >[0];
    baseResourceV3ActivationAnchorMirror: Parameters<
      typeof advanceMarketBaseResourceActivationAnchor
    >[0];
  };
  const state = currentMarketBaseV3StateFixture();
  const target =
    state.scope!.laneLifecycles.find(
      (lane) => lane.resource === RESOURCE_KEANIUM,
    ) ??
    state.scope!.laneLifecycles.find(
      (lane) => lane.resource !== RESOURCE_CATALYST,
    ) ??
    state.scope!.laneLifecycles[0];
  expect(target).toBeDefined();
  let scope = state.scope!;
  for (let cycle = 0; cycle < 100; cycle += 1) {
    Game.time += 1;
    scope = applyMarketBaseResourceShadowObservations(
      scope,
      Game.time,
      [
        {
          laneId: target!.laneId,
          result: "safe_no_opportunity",
        },
      ],
      undefined,
    );
  }
  expect(
    scope.laneLifecycles.find((lane) => lane.laneId === target!.laneId),
  ).toMatchObject({
    stage: "qualified",
    status: "suspended",
    shadowEvidence: {
      completeCycles: 100,
    },
  });
  state.scope = scope;
  const nextAnchor = advanceMarketBaseResourceActivationAnchor(
    data.baseResourceV3ActivationAnchor,
    state,
    Memory.data!.marketSaleAutomation!.trustedFloors,
    Game.time,
  );
  data.baseResourceV3ActivationAnchor = nextAnchor;
  data.baseResourceV3ActivationAnchorMirror = JSON.parse(
    JSON.stringify(nextAnchor),
  ) as typeof nextAnchor;

  const proposed = proposeMarketBaseResourcePermit({
    laneId: target!.laneId,
    targetStage: "canary",
  }) as {
    ok: boolean;
    proposalId?: string;
    error?: string;
  };
  expect(proposed).toMatchObject({
    ok: true,
  });
  expect(acceptMarketBaseResourcePermit(proposed.proposalId!)).toMatchObject({
    ok: true,
  });
  const accepted = currentMarketBaseV3StateFixture();
  const currentPermit = accepted.permitChain!.retainedPermits[
    accepted.permitChain!.retainedPermits.length - 1
  ] as MarketBaseResourcePermit;
  expect(
    currentPermit.signedLaneGrants.find(
      (grant) => grant.laneId === target!.laneId,
    ),
  ).toMatchObject({
    status: "active",
    stage: "canary",
    newDealGrant: "enabled",
  });
  // Legacy V2 migration 会把最后一次全局 confirmed cooldown 带入 V3。
  // fixture 前进到该已认证 cooldown 之后，才能覆盖 prepared WAL 而非 quota gate。
  Game.time = Math.max(
    Game.time + 40_000,
    accepted.ledger!.confirmedCooldownNotBefore + 1,
  );
  return {
    laneId: target!.laneId,
    resource: target!.resource,
    sellerRoom: target!.sellerRoomName,
  };
}

function buildMarketBaseAttemptInputFixture(
  source: MarketBaseResourceV3RuntimeState,
  options: {
    executionPolicy?: "canary" | "continuous";
    laneId?: string;
  } = {},
): PrepareMarketBaseResourceAttemptInput {
  const executionPolicy = options.executionPolicy ?? "canary";
  const permit = source.permitChain!.retainedPermits[
    source.permitChain!.retainedPermits.length - 1
  ] as MarketBaseResourcePermit;
  const grant = permit.signedLaneGrants.find(
    (candidate): candidate is MarketBaseResourceSignedLaneGrant =>
      candidate.status === "active" &&
      candidate.stage === executionPolicy &&
      candidate.newDealGrant === "enabled" &&
      (options.laneId === undefined || candidate.laneId === options.laneId),
  );
  expect(grant).toBeDefined();
  const lane = source.scope!.laneLifecycles.find(
    (candidate) => candidate.laneId === grant!.laneId,
  );
  const room = source.scope!.sellerRooms.find(
    (candidate) => candidate.roomInstanceId === grant!.roomInstanceId,
  );
  const policy = MARKET_BASE_RESOURCE_POLICIES.find(
    (candidate) => candidate.resource === grant!.resource,
  );
  expect(lane).toBeDefined();
  expect(room).toBeDefined();
  expect(policy).toBeDefined();
  const ratchet = source.pricingRatchet!.entries.find(
    (candidate) => candidate.resource === grant!.resource,
  )!;
  const effectiveFloorMilli = Math.ceil(
    Math.max(policy!.hardFloor, policy!.economicFloor, ratchet.value) * 1_000,
  );
  const observedOrderPriceMilli = effectiveFloorMilli + 10_000;
  const fullReadFingerprint = canonicalStableHashV1({
    domain: "market-base-resource:outer-wal-test-read-v1",
    laneId: grant!.laneId,
    tick: Game.time,
  });
  return {
    tick: Game.time,
    resourceLimit: policy!.rollingMaxAmount,
    permitChain: source.permitChain!,
    executionPolicy,
    historicalPermit: buildMarketBaseResourceHistoricalPermitRef(permit),
    historicalLane: {
      laneId: grant!.laneId,
      roomInstanceId: grant!.roomInstanceId,
      sellerRoom: grant!.sellerRoom,
      resource: grant!.resource,
      resourcePolicyId: grant!.resourcePolicyId,
      resourcePolicyFingerprint: grant!.resourcePolicyFingerprint,
      roomFingerprint: grant!.roomFingerprint,
      sharedPolicyFingerprint: grant!.sharedPolicyFingerprint,
    },
    firstDynamicScope: {
      admissionPolicyFingerprint:
        permit.sharedPolicy.roomAdmissionPolicy.fingerprint,
      rosterFingerprint: source.scope!.rosterFingerprint,
      laneSetFingerprint: source.scope!.laneSetFingerprint,
      laneId: grant!.laneId,
      roomInstanceId: grant!.roomInstanceId,
    },
    secondDynamicScope: {
      admissionPolicyFingerprint:
        permit.sharedPolicy.roomAdmissionPolicy.fingerprint,
      rosterFingerprint: source.scope!.rosterFingerprint,
      laneSetFingerprint: source.scope!.laneSetFingerprint,
      laneId: grant!.laneId,
      roomInstanceId: grant!.roomInstanceId,
    },
    fullReads: {
      firstReadFingerprint: fullReadFingerprint,
      secondReadFingerprint: fullReadFingerprint,
      bookFingerprint: canonicalStableHashV1("outer-wal-book"),
      protectionFingerprint: canonicalStableHashV1("outer-wal-protection"),
      energyReadinessFingerprint: canonicalStableHashV1("outer-wal-energy"),
      arbiterFingerprint: canonicalStableHashV1("outer-wal-arbiter"),
    },
    executionEvidence: {
      observedOrderPriceMilli,
      observedOrderAmount: 10_000,
      effectiveEnergyShadowPriceMilli: 20_000,
      effectiveNetFloorMilli: effectiveFloorMilli,
      terminalResourceBefore: 20_000,
      terminalEnergyBefore: 100_000,
      terminalCooldownBefore: 0,
      creditsBefore: Game.market.credits,
      outgoingTransactionKeysBefore: [],
      outgoingWindowObservedAt: Game.time,
      outgoingWindowCoversAttemptAt: true,
    },
    orderId: "outer-wal-buy-order",
    orderRoom: "E1S1",
    plannedTransactionEnergy: 0,
    plannedNetCreditsMilli: observedOrderPriceMilli * 1_000,
    worstUnitNetCreditsMilli: observedOrderPriceMilli,
    evidenceKeyHint: canonicalStableHashV1({
      domain: "market-base-resource:outer-wal-test-attempt-v1",
      laneId: grant!.laneId,
      tick: Game.time,
    }),
  };
}

function buildPreparedMarketBaseV3StateFixture(
  source: MarketBaseResourceV3RuntimeState,
): MarketBaseResourceV3RuntimeState {
  const prepared = prepareMarketBaseResourceAttempt(
    source.ledger!,
    buildMarketBaseAttemptInputFixture(source),
  );
  if (!prepared.ok || prepared.action !== "prepared") {
    throw new Error(
      `fixture_prepare_failed:${prepared.blockerCode ?? prepared.action}:${JSON.stringify(
        {
          tick: Game.time,
          confirmedCooldownNotBefore: source.ledger!.confirmedCooldownNotBefore,
          retryNotBefore: source.ledger!.retryNotBefore,
          receipts: source.ledger!.receipts.map((receipt) => ({
            actualAmount: receipt.actualAmount,
            resource: receipt.resource,
            retentionTick: receipt.retentionTick,
            sellerRoom: receipt.sellerRoom,
            status: receipt.status,
          })),
        },
      )}`,
    );
  }
  expect(prepared.state.pending).toBeDefined();
  return {
    ...source,
    ledger: prepared.state,
  };
}

function markDirectLegacyExposureDrainedFixture(): void {
  const data = Memory.data!.marketSaleAutomation! as unknown as {
    directLegacyExposureDrain: {
      schemaVersion: 1;
      zeroConfirmations: number;
      lastZeroConfirmationTick: number;
      completedAt: number;
    };
    drain: {
      phase: "direct";
      targetMode: "direct";
      zeroConfirmations: number;
    };
  };
  data.directLegacyExposureDrain = {
    schemaVersion: 1,
    zeroConfirmations: 2,
    lastZeroConfirmationTick: Game.time - 1,
    completedAt: Game.time - 1,
  };
  data.drain = {
    phase: "direct",
    targetMode: "direct",
    zeroConfirmations: 2,
  };
}

function installOwnedMarketBaseRoom(
  roomName: string,
  terminalId: string,
): void {
  const terminal = installRoom(roomName, RESOURCE_KEANIUM);
  (
    terminal as StructureTerminal & {
      id: Id<StructureTerminal>;
      my: boolean;
      owner?: Owner;
    }
  ).id = terminalId as Id<StructureTerminal>;
  (
    terminal as StructureTerminal & {
      my: boolean;
      owner?: Owner;
    }
  ).my = true;
  (
    terminal as StructureTerminal & {
      owner?: Owner;
    }
  ).owner = {
    username: "forst",
  };
  (
    Game.rooms[roomName].controller as StructureController & {
      owner?: Owner;
    }
  ).owner = {
    username: "forst",
  };
}

function persistMarketBaseFixtureState(
  state: MarketBaseResourceV3RuntimeState,
): void {
  const data = Memory.data!.marketSaleAutomation as unknown as {
    trustedFloors: Record<string, unknown>;
    baseResourceV3ActivationAnchor: Parameters<
      typeof advanceMarketBaseResourceActivationAnchor
    >[0];
    baseResourceV3ActivationAnchorMirror: Parameters<
      typeof advanceMarketBaseResourceActivationAnchor
    >[0];
    directAutomation: {
      baseResourceV3: MarketBaseResourceV3RuntimeState;
    };
  };
  data.directAutomation.baseResourceV3 = state;
  const nextAnchor = advanceMarketBaseResourceActivationAnchor(
    data.baseResourceV3ActivationAnchor,
    state,
    data.trustedFloors as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >["trustedFloors"],
    Game.time,
  );
  data.baseResourceV3ActivationAnchor = nextAnchor;
  data.baseResourceV3ActivationAnchorMirror = JSON.parse(
    JSON.stringify(nextAnchor),
  ) as typeof nextAnchor;
}

function buildOuterShadowProgressResult(
  source: MarketBaseResourceV3RuntimeState,
): MarketBaseResourceAutomationResult {
  const lane = source.scope!.laneLifecycles.find(
    (candidate) =>
      candidate.stage === "shadow" && candidate.status === "suspended",
  )!;
  const nextScope = applyMarketBaseResourceShadowObservations(
    source.scope!,
    Game.time,
    [{ laneId: lane.laneId, result: "safe_no_opportunity" }],
    lane.laneId,
  );
  const state: MarketBaseResourceV3RuntimeState = {
    ...source,
    scope: nextScope,
    lastPlanningSnapshot: {
      observedAt: Game.time,
      complete: true,
      sampledShadowLaneIds: [lane.laneId],
      cpuUsed: 5,
      rawOrderCount: 0,
      eligibleOrderCount: 0,
      distinctOrderRoomCount: 0,
      transactionCostEvaluationBudget: 0,
      shadowPlannerMode: "batch_zero_candidate",
      shadowPlannerInvocationCount: 1,
      actualTransactionEnergyEvaluations: 0,
      evaluatedShadowResourceCount: 1,
      candidateIdentityOrderChecks: 0,
    },
  };
  const ledgerRuntimeAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
    state.ledger!,
    state.permitChain!,
  );
  const readinessRuntimeCapability =
    createMarketBaseResourceReadinessRuntimeCapability(
      state,
      Game.time,
      ledgerRuntimeAnchor,
    );
  if (!readinessRuntimeCapability) {
    throw new Error("outer shadow fixture capability unavailable");
  }
  return {
    actions: [],
    rejectedByReason: {},
    writes: 0,
    planComplete: true,
    state,
    ledgerRuntimeAnchor,
    readinessRuntimeCapability,
    cpuRawHighWater: 5,
    cpuTrace: {
      observedAt: Game.time,
      cpuAfterOuterSession: 1,
      cpuAfterScopeCore: 2,
      cpuAfterMarketFacts: 3,
      cpuAfterShadowBatch: 4,
      cpuAfterInnerApply: 5,
      cpuCutPhase: null,
      marketFactsDisposition: "read",
    },
  };
}

type MarketSaleStoredRoot = NonNullable<
  NonNullable<Memory["data"]>["marketSaleAutomation"]
>;

function installMarketSaleRootSetterFault(
  source: MarketSaleStoredRoot,
  mode: "throw" | "throw_after_write" | "swallow" | "substitute",
): {
  concurrent: MarketSaleStoredRoot;
  current: () => MarketSaleStoredRoot;
  restore: () => void;
} {
  const concurrent = {
    ...source,
    operatorAudit: [
      ...((
        source as unknown as {
          operatorAudit?: unknown[];
        }
      ).operatorAudit ?? []),
      { tick: Game.time, action: "injected_root_setter_substitution" },
    ],
  } as MarketSaleStoredRoot;
  let stored = source;
  Object.defineProperty(Memory.data!, "marketSaleAutomation", {
    configurable: true,
    get: () => stored,
    set: (candidate: MarketSaleStoredRoot) => {
      if (mode === "throw") {
        throw new Error("injected root setter throw");
      }
      if (mode === "throw_after_write") {
        stored = candidate;
        throw new Error("injected root setter post-write throw");
      }
      if (mode === "substitute") {
        stored = concurrent;
      }
      // swallow 刻意保留 source。
    },
  });
  return {
    concurrent,
    current: () => stored,
    restore: () => {
      Object.defineProperty(Memory.data!, "marketSaleAutomation", {
        configurable: true,
        writable: true,
        value: stored,
      });
    },
  };
}

function currentMarketBasePlanningCandidates(): MarketSalePlanCandidate[] {
  const current = currentMarketBaseV3StateFixture();
  const trustedFloors = (
    Memory.data!.marketSaleAutomation as unknown as {
      trustedFloors: Record<
        string,
        { value: number; marketDate: string; updatedAt: number }
      >;
    }
  ).trustedFloors;
  const trustedEnergyFloor = trustedFloors[RESOURCE_ENERGY]!;
  return current.scope!.sellerRooms.flatMap((sellerRoom) =>
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => {
      const trustedFloor = trustedFloors[policy.resource]!;
      return candidate({
        roomName: sellerRoom.roomName,
        resourceType: policy.resource,
        protectionEntry: protectionEntry({
          roomName: sellerRoom.roomName,
          resource: policy.resource,
          revision: Game.time,
          observedAt: Game.time,
          expiresAt: Game.time,
        }),
        effectiveNetFloor: Math.max(
          policy.hardFloor,
          policy.economicFloor,
          trustedFloor.value,
        ),
        directHistoryTrusted: true,
        historyFloor: policy.economicFloor,
        ratchetFloor: trustedFloor.value,
        effectiveEnergyShadowPrice: trustedEnergyFloor.value,
        energyShadowObservedAt: trustedEnergyFloor.updatedAt,
        energyShadowComponents: {
          hardFloor: trustedEnergyFloor.value,
          ratchetFloor: trustedEnergyFloor.value,
        },
        isHubRoom: sellerRoom.roomClass === "hub",
      });
    }),
  );
}

function qualifyMarketBaseLaneFixture(laneId: string): void {
  const state = currentMarketBaseV3StateFixture();
  let scope = state.scope!;
  for (let cycle = 0; cycle < 100; cycle += 1) {
    Game.time += 1;
    scope = applyMarketBaseResourceShadowObservations(
      scope,
      Game.time,
      [
        {
          laneId,
          result: "safe_no_opportunity",
        },
      ],
      undefined,
    );
  }
  state.scope = scope;
  expect(
    state.scope.laneLifecycles.find((lane) => lane.laneId === laneId),
  ).toMatchObject({
    stage: "qualified",
    status: "suspended",
  });
  persistMarketBaseFixtureState(state);
}

function transitionMarketBaseLaneFixture(
  laneId: string,
  targetStage: "canary" | "suspend",
): void {
  const proposed = proposeMarketBaseResourcePermit({
    laneId,
    targetStage,
  }) as {
    ok: boolean;
    proposalId?: string;
    error?: string;
  };
  expect(proposed).toMatchObject({ ok: true });
  expect(acceptMarketBaseResourcePermit(proposed.proposalId!)).toMatchObject({
    ok: true,
  });
}

function settleMarketBaseCanaryFixture(
  laneId: string,
  status: "confirmed" | "failed" | "not_filled",
): void {
  const state = currentMarketBaseV3StateFixture();
  Game.time = Math.max(
    Game.time + 1,
    state.ledger!.confirmedCooldownNotBefore + 1,
    state.ledger!.retryNotBefore + 1,
  );
  const preparedState = buildPreparedMarketBaseV3StateFixture(state);
  const pending = preparedState.ledger!.pending!;
  expect(pending.historicalLane.laneId).toBe(laneId);
  state.ledger = preparedState.ledger;
  persistMarketBaseFixtureState(state);
  const actualAmount = status === "confirmed" ? pending.plannedAmount : 0;
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
    plannedAmount: pending.plannedAmount,
    resolvedAt: Game.time,
    evidenceKey: canonicalStableHashV1({
      domain: "market-base-resource:orchestration-recovery-outcome-v1",
      laneId,
      status,
      attemptSeq: pending.attemptSeq,
    }),
    actualAmount,
    ...(status === "confirmed"
      ? {
          transactionId: `recovery-transaction-${pending.attemptSeq}`,
          transactionTime: Game.time,
          actualTransactionEnergy: 0,
          actualNetCreditsMilli:
            pending.executionEvidence.observedOrderPriceMilli * actualAmount,
        }
      : {
          reason: `fixture_${status}`,
        }),
    pendingEvidenceHash: pending.frozenEvidenceHash,
  });
  let operation = recordMarketBaseResourceOutcome(
    preparedState.ledger!,
    outcome,
    preparedState.permitChain!,
  );
  expect(operation.action).toBe("outcome_written");
  for (let step = 0; step < 3; step += 1) {
    operation = advanceMarketBaseResourceWal(
      operation.state,
      preparedState.permitChain!,
    );
  }
  expect(operation.action).toBe("pending_deleted");
  state.ledger = operation.state;
  state.lastLifecycleAppliedAttemptSeq = operation.state.finalizedAttemptSeq;
  if (status === "confirmed") {
    state.scope = {
      ...state.scope!,
      laneLifecycles: state.scope!.laneLifecycles.map((lane) =>
        lane.laneId === laneId
          ? {
              ...lane,
              stage: "review_paused",
              status: "suspended",
            }
          : lane,
      ),
    };
  }
  persistMarketBaseFixtureState(state);
}

function installMarketBaseContinuousReviewMocks(): {
  restore: () => void;
} {
  const terminalSpy = jest
    .spyOn(marketBaseResourceAutomationModule, "readLiveMarketBaseTerminal")
    .mockImplementation((roomName, resource) => {
      const terminal = Game.rooms[roomName]?.terminal as
        | (StructureTerminal & {
            id?: Id<StructureTerminal>;
          })
        | undefined;
      return terminal?.id
        ? {
            roomName,
            terminalId: terminal.id,
            owned: true,
            ready: true,
            cooldown: 0,
            resourceAmount: 200_000,
            energy: 100_000,
            effectivePostDealEnergyReserve: 25_000,
            revision: `market-base-review-ready:${Game.time}:${resource}`,
          }
        : undefined;
    });
  const protectionSpy = jest
    .spyOn(
      marketSaleProtectionAdapterModule,
      "collectLiveMarketSaleProtectionLedger",
    )
    .mockImplementation((_config, _managed, options) => {
      const entries = Object.fromEntries(
        (options.candidates ?? []).map(({ roomName, resource }) => {
          const entry = protectionEntry({
            roomName,
            resource,
            revision: Game.time,
            observedAt: Game.time,
            expiresAt: Game.time,
            totalStock: 200_000,
            terminalStock: 200_000,
            hardReserve: 100_000,
            protectedAmount: 100_000,
            grossSurplus: 100_000,
            newExposureCapacity: 100_000,
            sellableAmount: 100_000,
          });
          return [`${roomName}:${resource}`, entry];
        }),
      );
      return {
        currentTick: Game.time,
        revision: Game.time,
        observedAt: Game.time,
        expiresAt: Game.time,
        fresh: true,
        entries,
        blockedEntryCount: 0,
        globalBlocked: false,
        issues: [],
      };
    });
  return {
    restore: () => {
      protectionSpy.mockRestore();
      terminalSpy.mockRestore();
    },
  };
}

function currentMarketBaseContinuousReviewFixture(
  laneId: string,
): MarketBaseResourceContinuousReviewSnapshot {
  const status = marketBaseResourceStatus() as {
    continuousReviewCandidates: Array<{
      laneId: string;
      snapshot?: MarketBaseResourceContinuousReviewSnapshot;
      blocker?: string;
    }>;
  };
  const candidate = status.continuousReviewCandidates.find(
    (entry) => entry.laneId === laneId,
  );
  expect(candidate?.blocker).toBeUndefined();
  expect(candidate?.snapshot).toBeDefined();
  return candidate!.snapshot!;
}

function promoteMarketBaseContinuousFixture(laneId: string): void {
  const review = currentMarketBaseContinuousReviewFixture(laneId);
  const proposed = proposeMarketBaseResourcePermit({
    laneId,
    targetStage: "continuous",
    reviewedEvidenceDigest: review.stableReviewDigest,
    continuousReview: review,
  }) as {
    ok: boolean;
    proposalId?: string;
    error?: string;
  };
  expect(proposed).toMatchObject({ ok: true });
  expect(acceptMarketBaseResourcePermit(proposed.proposalId!)).toMatchObject({
    ok: true,
  });
}

function currentMarketBaseGrantFixture(
  laneId: string,
): MarketBaseResourceSignedLaneGrant {
  const state = currentMarketBaseV3StateFixture();
  const permit =
    state.permitChain!.retainedPermits[
      state.permitChain!.retainedPermits.length - 1
    ];
  expect(permit?.schemaVersion).toBe(3);
  const grant =
    permit?.schemaVersion === 3
      ? permit.signedLaneGrants.find((entry) => entry.laneId === laneId)
      : undefined;
  expect(grant).toBeDefined();
  return grant!;
}

function extendNotFilledMarketBaseReceiptChainFixture(input: {
  first: MarketBaseResourceReceipt;
  previousHead: string;
  firstAttemptSeq: number;
  lastAttemptSeq: number;
  firstAttemptAt: number;
}): readonly MarketBaseResourceReceipt[] {
  const receipts: MarketBaseResourceReceipt[] = [];
  let previousHead = input.previousHead;
  for (
    let attemptSeq = input.firstAttemptSeq;
    attemptSeq <= input.lastAttemptSeq;
    attemptSeq += 1
  ) {
    const attemptAt =
      input.firstAttemptAt +
      (attemptSeq - input.firstAttemptSeq) *
        (MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS + 1);
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
      evidenceKey: canonicalStableHashV1({
        domain: "market-base-resource:synthetic-not-filled-v1",
        attemptSeq,
      }),
      pendingEvidenceHash: canonicalStableHashV1({
        domain: "market-base-resource:synthetic-pending-v1",
        attemptSeq,
      }),
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

function marketBaseOutcomeFromReceiptFixture(
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

function fillMarketBaseReceiptRingFixture(laneId: string): void {
  const state = currentMarketBaseV3StateFixture();
  const data = Memory.data!.marketSaleAutomation as unknown as {
    trustedFloors: Record<string, unknown>;
    baseResourceV3ActivationAnchor: Parameters<
      typeof advanceMarketBaseResourceActivationAnchor
    >[0];
    baseResourceV3ActivationAnchorMirror: Parameters<
      typeof advanceMarketBaseResourceActivationAnchor
    >[0];
    directAutomation: {
      baseResourceV3: MarketBaseResourceV3RuntimeState;
    };
  };
  let ledger = state.ledger!;
  let ledgerRuntimeAnchor = data.baseResourceV3ActivationAnchor.ledger;
  Game.time = Math.max(
    Game.time + 1,
    ledger.confirmedCooldownNotBefore + 1,
    ledger.retryNotBefore + 1,
  );
  const opened = createMarketBaseResourceLedgerRuntimeContext({
    state: ledger,
    permitChain: state.permitChain!,
    anchor: ledgerRuntimeAnchor,
    tick: Game.time,
  });
  if ("reason" in opened) {
    throw new Error(`ring_context_failed:${opened.reason}`);
  }
  const source = {
    ...state,
    ledger,
  };
  const prepared = prepareMarketBaseResourceAttemptWithRuntimeContext(
    opened.context,
    buildMarketBaseAttemptInputFixture(source, {
      executionPolicy: "continuous",
      laneId,
    }),
  );
  if (!prepared.ok || prepared.action !== "prepared") {
    throw new Error(
      `ring_prepare_failed:${prepared.blockerCode ?? prepared.action}`,
    );
  }
  const pending = prepared.state.pending!;
  let operation = recordMarketBaseResourceOutcomeWithRuntimeContext(
    prepared.runtimeContext,
    sealMarketBaseResourceOutcome({
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
      plannedAmount: pending.plannedAmount,
      resolvedAt: Game.time,
      evidenceKey: canonicalStableHashV1({
        domain: "market-base-resource:full-ring-not-filled-v1",
        attemptSeq: pending.attemptSeq,
      }),
      actualAmount: 0,
      reason: "full_ring_fixture",
      pendingEvidenceHash: pending.frozenEvidenceHash,
    }),
  );
  for (let step = 0; step < 3; step += 1) {
    operation = advanceMarketBaseResourceWalWithRuntimeContext(
      operation.runtimeContext,
    );
  }
  if (!operation.ok || operation.action !== "pending_deleted") {
    throw new Error(
      `ring_settle_failed:${operation.blockerCode ?? operation.action}`,
    );
  }
  ledger = operation.state;
  ledgerRuntimeAnchor = operation.runtimeAnchor;
  const firstContinuousReceipt = ledger.receipts[ledger.receipts.length - 1];
  if (!firstContinuousReceipt) {
    throw new Error("ring_continuous_receipt_missing");
  }
  const syntheticCount =
    MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT -
    ledger.legacyQuotaReceipts.length -
    ledger.receipts.length;
  const synthetic =
    syntheticCount > 0
      ? extendNotFilledMarketBaseReceiptChainFixture({
          first: firstContinuousReceipt,
          previousHead: ledger.receiptHeadHash,
          firstAttemptSeq: firstContinuousReceipt.attemptSeq + 1,
          lastAttemptSeq: firstContinuousReceipt.attemptSeq + syntheticCount,
          firstAttemptAt:
            firstContinuousReceipt.attemptAt +
            MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS +
            1,
        })
      : [];
  const allReceipts = [...ledger.receipts, ...synthetic];
  const finalReceipt = allReceipts[allReceipts.length - 1];
  if (!finalReceipt) {
    throw new Error("ring_final_receipt_missing");
  }
  ledger = {
    ...ledger,
    receipts: allReceipts,
    outcomes: allReceipts
      .slice(-MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT)
      .map(marketBaseOutcomeFromReceiptFixture),
    processedEvidenceKeys: allReceipts.map((receipt) => ({
      attemptSeq: receipt.attemptSeq,
      key: receipt.evidenceKey,
    })),
    receiptHeadHash: finalReceipt.headHash,
    finalizedAttemptSeq: finalReceipt.attemptSeq,
    nextAttemptSeq: finalReceipt.attemptSeq + 1,
    retryNotBefore:
      finalReceipt.attemptAt + MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS,
  } as MarketBaseResourceLedger;
  Game.time =
    finalReceipt.attemptAt + MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS + 1;
  const validation =
    marketBaseResourceLedgerModule.validateMarketBaseResourceLedger(
      ledger,
      Game.time,
      state.permitChain!,
    );
  if (!validation.ok) {
    throw new Error(`ring_validation_failed:${validation.reason}`);
  }
  ledgerRuntimeAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
    ledger,
    state.permitChain!,
  );
  state.ledger = ledger;
  state.lastLifecycleAppliedAttemptSeq = ledger.finalizedAttemptSeq;
  state.preflightAt = Game.time;
  data.directAutomation.baseResourceV3 = state;
  // 测试一次合成 510 条历史，刻意不冒充生产中的单步 WAL transition；
  // production advance 只允许 nextAttemptSeq 单步前进，因此这里按同一
  // canonical payload/hash 合同直接安装 cold-Memory fixture anchor。
  const currentAnchor = data.baseResourceV3ActivationAnchor;
  const runtimeSafetyCommitment = canonicalStableHashV1({
    domain: "market-base-resource:outer-runtime-safety-v1",
    ledger: ledgerRuntimeAnchor,
    pricingRatchetCommitment: currentAnchor.pricingRatchetCommitment,
    trustedFloorsCommitment: currentAnchor.trustedFloorsCommitment,
    hardBlocker: currentAnchor.hardBlocker,
  });
  const { anchorHash: _anchorHash, ...currentAnchorPayload } = currentAnchor;
  const nextAnchorPayload = {
    ...currentAnchorPayload,
    updatedAt: Game.time,
    ledger: ledgerRuntimeAnchor,
    runtimeSafetyCommitment,
  };
  const nextAnchor = {
    ...nextAnchorPayload,
    anchorHash: canonicalStableHashV1({
      domain: "market-base-resource:activation-anchor-v1",
      payload: nextAnchorPayload,
    }),
  };
  data.baseResourceV3ActivationAnchor = nextAnchor;
  data.baseResourceV3ActivationAnchorMirror = JSON.parse(
    JSON.stringify(nextAnchor),
  ) as typeof nextAnchor;
}

describe("marketSaleAutomation 编排", () => {
  beforeEach(() => {
    clearMarketActionArbiterForTest();
    installMarket();
    installRoom();
    (
      Game as unknown as {
        cpu: {
          getUsed: jest.Mock<number, []>;
        };
      }
    ).cpu = {
      getUsed: jest.fn(() => 0),
    };
    Game.time = 100;
  });

  it("unknown disappearance 只能由 exact-ID operator 分类收敛，server expiry 必须核验退款", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");

    runMarketSalePreflight();

    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed.disappearanceGap,
    ).toMatchObject({ reason: "unknown_disappearance" });
    expect(
      (resolveMarketSaleOrderDisappearance as any)("managed", "unknown"),
    ).toMatchObject({
      ok: false,
      error: "disappearance_classification_invalid",
    });
    expect(
      resolveMarketSaleOrderDisappearance("managed", "server_expired"),
    ).toMatchObject({
      ok: false,
      error: "verified_refund_milli_required",
    });
    expect(
      resolveMarketSaleOrderDisappearance("managed", "server_expired", 40_000),
    ).toMatchObject({
      ok: true,
      refundedFeeDebtMilli: 40_000,
      carriedFeeDebtMilli: 60_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[RESOURCE_KEANIUM],
    ).toBe(60_000);
    expect(market.orders.manual).toBeDefined();
  });

  it("旧 room generation 与旧 lanes 随 scope/registry 回拨时由 activation high-water 精确闭锁", () => {
    activateMarketBaseV3Fixture();
    const generationOneRoot = JSON.parse(
      JSON.stringify(Memory.data!.marketSaleAutomation),
    ) as NonNullable<Memory["data"]>["marketSaleAutomation"];
    const generationOneState = (
      generationOneRoot!.directAutomation as unknown as {
        baseResourceV3: MarketBaseResourceV3RuntimeState;
      }
    ).baseResourceV3;
    const generationOneRoom = generationOneState.scope!.roomRegistry.rooms.W1N1;
    expect(generationOneRoom.incarnationHighWater).toBe(1);

    const liveTerminal = Game.rooms.W1N1.terminal as StructureTerminal & {
      id: Id<StructureTerminal>;
    };
    liveTerminal.id = "dddddddddddddddddddddddd" as Id<StructureTerminal>;
    Game.time += 1;
    runMarketSalePreflight();
    const generationTwoRoot = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor: {
        roomIncarnationHighWater: Array<{
          roomName: string;
          incarnationHighWater: number;
        }>;
      };
      baseResourceV3ActivationAnchorMirror: unknown;
      directAutomation: {
        baseResourceV3: MarketBaseResourceV3RuntimeState;
      };
    };
    const generationTwoRoom =
      generationTwoRoot.directAutomation.baseResourceV3.scope!.roomRegistry
        .rooms.W1N1;
    expect(generationTwoRoom.incarnationHighWater).toBe(2);
    expect(
      generationTwoRoot.baseResourceV3ActivationAnchor.roomIncarnationHighWater.find(
        (entry) => entry.roomName === "W1N1",
      ),
    ).toMatchObject({
      incarnationHighWater: 2,
    });

    const attacked = JSON.parse(
      JSON.stringify(generationTwoRoot),
    ) as typeof generationTwoRoot;
    const rolledBackScope = JSON.parse(
      JSON.stringify(generationOneState.scope),
    ) as MarketBaseResourceV3RuntimeState["scope"];
    rolledBackScope!.laneTombstoneDischargeCheckpoint =
      generationTwoRoot.directAutomation.baseResourceV3.scope!.laneTombstoneDischargeCheckpoint;
    attacked.directAutomation.baseResourceV3.scope = rolledBackScope;
    Memory.data!.marketSaleAutomation = attacked as unknown as NonNullable<
      Memory["data"]
    >["marketSaleAutomation"];
    const innerSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    Game.time += 1;
    const result = runMarketSaleAutomation({ candidates: [] });
    innerSpy.mockRestore();

    expect(result.writes).toBe(0);
    expect(result.rejectedByReason).toHaveProperty(
      "market_base_room_registry_checkpoint_rollback",
    );
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getTerminalActionClaims()).toHaveLength(0);
    expect(innerSpy).not.toHaveBeenCalled();
  });

  it("activation blocker 已写入双 anchor；恢复配置后删 sibling、替换 sibling 或回滚单份 anchor 都保持零成交", () => {
    activateMarketBaseV3Fixture();
    const cleanAnchor = JSON.parse(
      JSON.stringify(
        (
          Memory.data!.marketSaleAutomation as unknown as {
            baseResourceV3ActivationAnchor: unknown;
          }
        ).baseResourceV3ActivationAnchor,
      ),
    );
    Memory.cfg!.marketSaleAutomation!.directCapability = "continuous-v2";
    Game.time += 1;
    runMarketSalePreflight();
    const blockedCanonical = JSON.parse(
      JSON.stringify(Memory.data!.marketSaleAutomation),
    ) as NonNullable<Memory["data"]>["marketSaleAutomation"];
    const blockedView = blockedCanonical as unknown as {
      baseResourceV3ActivationAnchor: {
        activationBlocker: {
          code: string;
          detectedAt: number;
          detailHash: string;
        } | null;
      };
      baseResourceV3ActivationAnchorMirror: {
        activationBlocker: {
          code: string;
          detectedAt: number;
          detailHash: string;
        } | null;
      };
      baseResourceV3ActivationBlocker?: {
        schemaVersion: 1;
        hashRevision: string;
        code: string;
        detectedAt: number;
        detailHash: string;
      };
      directAutomation: {
        baseResourceV3?: {
          blocker?: string;
        };
      };
    };
    expect(
      blockedView.baseResourceV3ActivationAnchor.activationBlocker,
    ).toEqual(blockedView.baseResourceV3ActivationBlocker);
    expect(
      blockedView.baseResourceV3ActivationAnchorMirror.activationBlocker,
    ).toEqual(blockedView.baseResourceV3ActivationBlocker);
    Memory.cfg!.marketSaleAutomation!.directCapability = "continuous-v3";

    const attacks = [
      (data: typeof blockedView): void => {
        delete data.baseResourceV3ActivationBlocker;
        delete data.directAutomation.baseResourceV3?.blocker;
      },
      (data: typeof blockedView): void => {
        data.baseResourceV3ActivationBlocker = {
          ...data.baseResourceV3ActivationBlocker!,
          code: "tampered-activation-blocker",
        };
        delete data.directAutomation.baseResourceV3?.blocker;
      },
      (data: typeof blockedView): void => {
        data.baseResourceV3ActivationAnchor = JSON.parse(
          JSON.stringify(cleanAnchor),
        );
        delete data.directAutomation.baseResourceV3?.blocker;
      },
    ];
    for (const attack of attacks) {
      const attacked = JSON.parse(
        JSON.stringify(blockedCanonical),
      ) as unknown as typeof blockedView;
      attack(attacked);
      Memory.data!.marketSaleAutomation = attacked as unknown as NonNullable<
        Memory["data"]
      >["marketSaleAutomation"];
      (Game.market.deal as jest.Mock).mockClear();
      Game.time += 1;
      const result = runMarketSaleAutomation({
        candidates: [],
      });
      expect(result.writes).toBe(0);
      expect(Game.market.deal).not.toHaveBeenCalled();
      const persisted = Memory.data!
        .marketSaleAutomation as unknown as typeof blockedView;
      expect(persisted.baseResourceV3ActivationBlocker?.code).toBe(
        "market_base_v3_config_rollback_after_cutover",
      );
      expect(
        persisted.baseResourceV3ActivationAnchor.activationBlocker,
      ).toEqual(persisted.baseResourceV3ActivationBlocker);
      expect(
        persisted.baseResourceV3ActivationAnchorMirror.activationBlocker,
      ).toEqual(persisted.baseResourceV3ActivationBlocker);
    }
  });

  it("V3 cutover 后回植合法旧 V2 pending、兼容 projection 与 reservation 时在 claim/deal 前持久闭锁", () => {
    activateMarketBaseV3Fixture();
    markDirectLegacyExposureDrainedFixture();
    Game.time = 72_700_000;
    const data = Memory.data!.marketSaleAutomation as unknown as {
      directAutomation: MarketDirectContinuousAutomationState;
      pendingDirectDeals: Record<string, unknown>;
      marketReservations?: unknown;
      baseResourceV3ActivationBlocker?: {
        code: string;
      };
      baseResourceV3ActivationAnchor: {
        activationBlocker: {
          code: string;
        } | null;
      };
      baseResourceV3ActivationAnchorMirror: {
        activationBlocker: {
          code: string;
        } | null;
      };
    };
    const direct = data.directAutomation;
    const planningEvidence = JSON.stringify({
      tick: Game.time,
      resource: RESOURCE_HYDROGEN,
      orderId: `legacy-graft-${direct.ledger.nextAttemptSeq}`,
    });
    const prepared = prepareContinuousAttempt(direct.ledger, {
      tick: Game.time,
      executionPolicy: "continuous",
      permitId: direct.currentPermit!.permitId,
      permitEpoch: direct.currentPermit!.epoch,
      entryId: "base-h-e3n59-v1",
      resourcePolicyFingerprint: "legacy-graft-h-policy",
      sellerRoom: "E3N59",
      resource: RESOURCE_HYDROGEN,
      orderId: `legacy-graft-${direct.ledger.nextAttemptSeq}`,
      orderRoom: "E11S21",
      plannedAmount: 1_000,
      plannedTransactionEnergy: 400,
      plannedNetCreditsMilli: 600_000_000,
      evidenceKeyHint: `legacy-graft-${direct.ledger.nextAttemptSeq}`,
      executionEvidence: {
        observedOrderPriceMilli: 650_000,
        observedOrderAmount: 5_000,
        effectiveEnergyShadowPriceMilli: 32_060,
        effectiveNetFloorMilli: 451_000,
        worstCaseNetCreditsMilli: 610_000,
        protectionRevision: Game.time,
        planningFingerprint: continuousPlanningFingerprint(planningEvidence),
        planningEvidence,
        terminalResourceBefore: 150_000,
        terminalEnergyBefore: 50_000,
        terminalCooldownBefore: 0,
        creditsBefore: 2_000_000.25,
        outgoingTransactionKeysBefore: ["legacy-baseline:legacy-order"],
        outgoingWindowObservedAt: Game.time,
        outgoingWindowOldestTime: Game.time - 10,
        outgoingWindowNewestTime: Game.time,
        outgoingWindowCoversAttemptAt: true,
      },
      resourceLimit: 8_000,
      globalLimit: 12_000,
      safeOpportunityResources: [
        {
          resource: RESOURCE_CATALYST,
          resourceLimit: 8_000,
        },
        {
          resource: RESOURCE_HYDROGEN,
          resourceLimit: 8_000,
        },
        {
          resource: RESOURCE_ZYNTHIUM,
          resourceLimit: 5_000,
        },
      ],
    });
    expect(prepared).toMatchObject({
      ok: true,
      action: "prepared",
    });
    const pending = prepared.state.pending!;
    const projection = {
      requestId: pending.evidenceKeyHint,
      status: "prepared" as const,
      roomName: pending.sellerRoom,
      canaryRoomName: pending.sellerRoom,
      resource: pending.resource as ResourceConstant,
      resourceType: pending.resource as ResourceConstant,
      amount: pending.plannedAmount,
      dealAmount: pending.plannedAmount,
      orderId: pending.orderId,
      attemptAt: pending.attemptAt,
    };
    direct.ledger = prepared.state;
    direct.pendingDirectDeals = {
      [pending.evidenceKeyHint]: projection,
    };
    data.pendingDirectDeals = {
      [pending.evidenceKeyHint]: projection,
    };
    data.marketReservations = {
      "legacy-v2-graft": {
        amount: 1_000,
      },
    };
    const innerSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );

    const result = runMarketSaleAutomation({
      candidates: [],
    });

    expect(innerSpy).not.toHaveBeenCalled();
    innerSpy.mockRestore();
    expect(result.writes).toBe(0);
    expect(Game.market.deal).not.toHaveBeenCalled();
    const persisted = Memory.data!
      .marketSaleAutomation as unknown as typeof data;
    expect(persisted.baseResourceV3ActivationBlocker?.code).toMatch(
      /^market_base_legacy_v2_/,
    );
    expect(persisted.baseResourceV3ActivationAnchor.activationBlocker).toEqual(
      persisted.baseResourceV3ActivationBlocker,
    );
    expect(
      persisted.baseResourceV3ActivationAnchorMirror.activationBlocker,
    ).toEqual(persisted.baseResourceV3ActivationBlocker);
  });

  it("首个 V3 proposal 跨 tick pending 时始终 pin V2 dispatcher，accept 后才 cutover", () => {
    const proposalId = proposeMarketBaseV3CutoverFixture();
    const proposed = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor?: unknown;
      baseResourceV3ActivationAnchorMirror?: unknown;
      directAutomation: MarketDirectContinuousAutomationState & {
        baseResourceV3?: MarketBaseResourceV3RuntimeState;
      };
    };
    const legacyPermitId = proposed.directAutomation.currentPermit?.permitId;
    expect(legacyPermitId).toBeTruthy();
    expect(proposed.baseResourceV3ActivationAnchor).toBeUndefined();
    expect(proposed.baseResourceV3ActivationAnchorMirror).toBeUndefined();
    expect(
      proposed.directAutomation.baseResourceV3?.proposedPermit?.proposalId,
    ).toBe(proposalId);

    const pendingSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    Game.time += 1;
    runMarketSaleAutomation({ candidates: [] });
    expect(pendingSpy).not.toHaveBeenCalled();
    pendingSpy.mockRestore();
    const stillPending = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor?: unknown;
      directAutomation: MarketDirectContinuousAutomationState & {
        baseResourceV3?: MarketBaseResourceV3RuntimeState;
      };
    };
    expect(stillPending.directAutomation.currentPermit?.permitId).toBe(
      legacyPermitId,
    );
    expect(
      stillPending.directAutomation.baseResourceV3?.proposedPermit?.proposalId,
    ).toBe(proposalId);
    expect(stillPending.baseResourceV3ActivationAnchor).toBeUndefined();

    expect(acceptMarketBaseResourcePermit(proposalId)).toMatchObject({
      ok: true,
    });
    const activeSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    Game.time += 1;
    runMarketSaleAutomation({ candidates: [] });
    expect(activeSpy).toHaveBeenCalledTimes(1);
    activeSpy.mockRestore();
    expect(
      (
        Memory.data!.marketSaleAutomation as unknown as {
          baseResourceV3ActivationAnchor?: {
            anchorHash: string;
          };
        }
      ).baseResourceV3ActivationAnchor?.anchorHash,
    ).toBeTruthy();
  });

  it("outer runtime anchor reader 只接受 canonical exact identity，prepared successor anchor 不匹配时零写", () => {
    activateMarketBaseV3CanaryFixture();
    markDirectLegacyExposureDrainedFixture();
    const runtimeSpy = jest
      .spyOn(
        marketBaseResourceAutomationModule,
        "runMarketBaseResourceAutomation",
      )
      .mockImplementation(
        (source, _input, dependencies): MarketBaseResourceAutomationResult => {
          const canonicalBefore = Memory.data!.marketSaleAutomation!;
          const sourceAnchor = dependencies.readLedgerRuntimeAnchor(source);
          expect(sourceAnchor).toBeDefined();
          expect(
            dependencies.readLedgerRuntimeAnchor({
              ...source,
              ledger: JSON.parse(JSON.stringify(source.ledger)),
            }),
          ).toBeUndefined();
          const preparedState = buildPreparedMarketBaseV3StateFixture(source);
          expect(
            dependencies.commitPreparedState(preparedState, sourceAnchor!),
          ).toBe(false);
          expect(Memory.data!.marketSaleAutomation).toBe(canonicalBefore);
          return {
            actions: ["market-base-v3-successor-anchor-rejected"],
            rejectedByReason: {
              market_base_v3_prepared_commit_failed: 1,
            },
            writes: 0,
            planComplete: false,
            state: source,
          };
        },
      );
    try {
      runMarketSaleAutomation({ candidates: [] });
    } finally {
      runtimeSpy.mockRestore();
    }
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(currentMarketBaseV3StateFixture().ledger?.pending).toBeUndefined();
  });
});
