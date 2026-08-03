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

  it("preflight 强制旧 seller 闩，Maker/hybrid 永久闩不可配置", () => {
    validConfig("off");

    runMarketSalePreflight();

    expect(MARKET_MAKER_HYBRID_PERMANENTLY_DISABLED).toBe(true);
    expect(Memory.cfg?.resourceControl?.market?.enabled).toBe(false);
    expect(Memory.cfg?.factoryControl?.market?.enabled).toBe(false);
    expect(typeof (global as any).grantMarketSaleMutationLease).toBe(
      "function",
    );
    expect(typeof (global as any).attestMarketSalePendingCreate).toBe(
      "function",
    );
    expect(typeof (global as any).resolveMarketSalePendingCreateAbsence).toBe(
      "function",
    );
    expect(typeof (global as any).resolveMarketSaleExternalOrderMutation).toBe(
      "function",
    );
    expect(typeof (global as any).resolveMarketSaleOrderDisappearance).toBe(
      "function",
    );
    expect(typeof (global as any).expandMarketSaleCanary).toBe("function");
    expect(typeof (global as any).emergencyStopMarketSaleAutomation).toBe(
      "function",
    );
    expect(typeof (global as any).marketSaleAutomationStatus).toBe("function");
  });

  it("off 排空只撤销 known managed order，保留手工订单与 exposure 直到 live ID 消失", () => {
    validConfig("off");
    const market = installMarket({
      orders: {
        managed: order("managed"),
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");

    const first = runMarketSalePreflight();

    expect(first.phase).toMatch(/requested|draining/);
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeDefined();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });

    Game.time += 1;
    market.orders = { manual: market.orders.manual };
    runMarketSalePreflight();

    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toBeUndefined();
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.orders.manual).toBeDefined();
  });

  it("Shadow 只按新鲜 ResourceControl 周期计数，重复 tick 不累加且 revision 变化清零", () => {
    validConfig("shadow", "rev-1");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    const market = Game.market as MutableMarket;

    runMarketSaleAutomation({ candidates: [candidate()] });
    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.phase).toBe("shadow");
    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      0,
    );

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      1,
    );

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    Memory.cfg!.marketSaleAutomation!.minReferenceOrderNotional = 125;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      0,
    );

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      1,
    );

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    Memory.cfg!.marketSaleAutomation!.minReferenceDistinctRooms = 2;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      0,
    );

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    Memory.cfg!.marketSaleAutomation!.configRevision = "rev-2";
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      0,
    );
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(market.cancelOrder).not.toHaveBeenCalled();
    expect(market.deal).not.toHaveBeenCalled();
  });

  it("有界投影历史证据、托管订单、slot、credit 与全部 active backoff", () => {
    validConfig("maker");
    Memory.cfg!.marketSaleAutomation!.maxManagedOrders = 1;
    installManagedOrder("managed-00");
    const data = Memory.data!.marketSaleAutomation!;
    const first = data.managedOrders["managed-00"];
    const orders: Record<string, Order> = {};
    for (let index = 0; index < 22; index += 1) {
      const orderId = `managed-${String(index).padStart(2, "0")}`;
      data.managedOrders[orderId] = {
        ...first,
        orderId,
        backoffUntil:
          index === 0
            ? Game.time + 10
            : index === 21
              ? Game.time + 20
              : undefined,
      };
      orders[orderId] = order(orderId);
    }
    orders.manual = order("manual", { roomName: "W9N9" });
    installMarket({ orders });
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    runMarketSaleAutomation({
      candidates: [
        candidate({
          historyTrusted: true,
          historyCompleteDayCount: 7,
          historyAcceptedDayCount: 6,
          historyFloor: 1.2,
          ratchetFloor: 1.25,
          makerNetPrice: 1.9,
        }),
      ],
    });

    const runtime = Memory.runtime!.marketSaleAutomation!;
    expect(runtime.candidates["W1N1:K"]).toMatchObject({
      historyTrusted: true,
      historyCompleteDayCount: 7,
      historyAcceptedDayCount: 6,
      historyFloor: 1.2,
      ratchetFloor: 1.25,
      makerNetPrice: 1.9,
    });
    expect(runtime.managedOrderCount).toBe(22);
    expect(runtime.managedOrders).toHaveLength(20);
    expect(runtime.managedOrders?.[0]).toMatchObject({
      orderId: "managed-00",
      roomName: "W1N1",
      resourceType: RESOURCE_KEANIUM,
      remainingExposure: 1_000,
      liveRemainingAmount: 1_000,
      backoffUntil: Game.time + 10,
    });
    expect(
      runtime.managedOrders?.some((entry) => entry.orderId === "manual"),
    ).toBe(false);
    expect(runtime.managedOrderSummaryTruncated).toBe(true);
    expect(runtime.backoffSummary).toEqual({
      activeCount: 2,
      nextUntil: Game.time + 10,
    });
    expect(runtime.orderSlots).toEqual({
      total: 300,
      current: 23,
      free: 277,
      reserved: 0,
      minFree: 5,
    });
    expect(runtime.creditSummary).toEqual({
      credits: 1_000_000,
      reserve: 10_000,
      reservedFeesThisTick: 0,
      availableAfterReserve: 990_000,
    });
  });

  it("空候选不能累计 Shadow，误开 Maker 直接进入永久紧停", () => {
    validConfig("shadow", "rev-empty");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    const market = Game.market as MutableMarket;

    for (let cycle = 0; cycle < 105; cycle += 1) {
      Memory.runtime!.resourceControl!.updatedAt = Game.time;
      runMarketSaleAutomation({ candidates: [] });
      Game.time += 1;
    }

    expect(Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles).toBe(
      0,
    );
    expect(Memory.data?.marketSaleAutomation?.canaryLock).toBeUndefined();

    Memory.cfg!.marketSaleAutomation!.mode = "maker";
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    grantMarketSaleMutationLease("empty-shadow", Game.time + 10);
    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(result.effectiveMode).toBe("emergencyStop");
    expect(
      result.rejectedByReason.market_maker_hybrid_permanently_disabled,
    ).toBe(1);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(market.extendOrder).not.toHaveBeenCalled();
    expect(market.changeOrderPrice).not.toHaveBeenCalled();
  });

  it("Hybrid 误配置永久 fail-closed 为 emergencyStop", () => {
    validConfig("hybrid", "rev-hybrid");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    const market = Game.market as MutableMarket;

    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(result.effectiveMode).toBe("emergencyStop");
    expect(result.phase).not.toMatch(/maker|hybrid/);
    expect(result.rejectedByReason.hybrid_not_implemented).toBe(1);
    expect(
      result.rejectedByReason.market_maker_hybrid_permanently_disabled,
    ).toBe(1);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(market.extendOrder).not.toHaveBeenCalled();
    expect(market.changeOrderPrice).not.toHaveBeenCalled();
    expect(market.deal).not.toHaveBeenCalled();
  });

  it("每个新鲜规划周期都按当前底线复验托管订单，净价不足时安全撤单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", { price: 1 }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.managedOrders.managed.price = 1;
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [candidate({ effectiveNetFloor: 1.1 })],
    });

    expect(result.rejectedByReason.managed_order_floor_violation).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("非 ResourceControl tick 提高 hard floor 时立即按 live 净价撤单", () => {
    validConfig("maker");
    Memory.cfg!.marketSaleAutomation!.hardFloor![RESOURCE_KEANIUM] = 1.95;
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 1.1,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_violation).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("非 ResourceControl tick 无法证明当前价格底线时安全撤单", () => {
    validConfig("maker");
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 0,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_unknown).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
  });

  it("Maker 永久闩不因有效底价而保留旧 managed exposure", () => {
    validConfig("maker");
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 1.1,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(
      result.rejectedByReason.current_tick_floor_violation,
    ).toBeUndefined();
    expect(result.rejectedByReason.current_tick_floor_unknown).toBeUndefined();
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(
      result.rejectedByReason.market_maker_hybrid_permanently_disabled,
    ).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("Maker 永久闩不能由 economicFloor 配置绕过", () => {
    validConfig("maker");
    Memory.cfg!.marketSaleAutomation!.economicFloor![RESOURCE_KEANIUM] = 0;
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 1.1,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_unknown).toBeUndefined();
    expect(
      result.rejectedByReason.current_tick_floor_violation,
    ).toBeUndefined();
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.createOrder).not.toHaveBeenCalled();
  });

  it("旧 managed exposure 即使库存安全也只能 cancel/drain", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed"),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          protectionEntry: protectionEntry({
            totalStock: 7_000,
            terminalStock: 1_000,
            grossSurplus: 1_000,
            managedExposure: 1_000,
            newExposureCapacity: 0,
            sellableAmount: 0,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(
      result.rejectedByReason.managed_order_candidate_rejected,
    ).toBeUndefined();
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("生产需求抢占后自排除可售量不足 live remaining，立即撤销托管单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed"),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          protectionEntry: protectionEntry({
            totalStock: 7_000,
            terminalStock: 1_000,
            productionDemand: 100,
            protectedAmount: 6_100,
            grossSurplus: 900,
            managedExposure: 1_000,
            newExposureCapacity: 0,
            sellableAmount: 0,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.managed_order_candidate_rejected).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("自排除不会释放其他 managed 暴露，其他订单占用导致不足时撤单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed"),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          protectionEntry: protectionEntry({
            totalStock: 7_100,
            terminalStock: 1_100,
            grossSurplus: 1_100,
            managedExposure: 1_200,
            newExposureCapacity: 0,
            sellableAmount: 0,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
              managedExposureContribution("other-managed", 200),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.managed_order_candidate_rejected).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
  });

  it("锁定候选从新鲜规划输入消失时撤销已有托管暴露", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", { price: 2 }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({ candidates: [] });

    expect(result.rejectedByReason.managed_order_locked_candidate_missing).toBe(
      1,
    );
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
  });

  it("policy TTL 到期只撤销对应 managed ID，不影响手工订单", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        managed: order("managed"),
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.managedOrders.managed.policyCancelAtTick =
      Game.time;

    const result = runMarketSalePreflight();

    expect(result.rejectedByReason.managed_order_policy_ttl_expired).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.cancelOrder).not.toHaveBeenCalledWith("manual");
    expect(market.orders.manual).toBeDefined();
  });

  it("外部扩量即使被并发成交掩盖 remaining 增长，也撤单并持续阻断到 operator 对账", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", {
          totalAmount: 1_500,
          remainingAmount: 900,
          amount: 900,
        }),
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const detected = runMarketSaleAutomation({
      candidates: [candidate()],
    });

    expect(detected.rejectedByReason.managed_order_external_mutation).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.cancelOrder).not.toHaveBeenCalledWith("manual");
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed
        .externalMutationGap,
    ).toMatchObject({
      expectedTotalAmount: 1_000,
      observedTotalAmount: 1_500,
      conservativeExposure: 1_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toMatchObject({
      reason: "external_order_mutation",
      orderId: "managed",
    });

    Memory.cfg!.marketSaleAutomation!.mode = "off";
    market.orders = { manual: market.orders.manual };
    Game.time += 1;
    const cancelled = runMarketSalePreflight();

    expect(cancelled.phase).toMatch(/requested|draining/);
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeDefined();
    expect(Memory.runtime?.marketSaleAutomation?.exposureAmount).toBe(1_000);
    expect(
      resolveMarketSaleExternalOrderMutation("managed", 99_999),
    ).toMatchObject({
      ok: false,
      error: "verified_fee_debt_below_known_debt",
    });

    expect(
      resolveMarketSaleExternalOrderMutation("managed", 125_000),
    ).toMatchObject({
      ok: true,
      orderId: "managed",
      carriedFeeDebtMilli: 125_000,
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
    ).toBe(125_000);
    expect(market.orders.manual).toBeDefined();
  });

  it("多个 external mutation gap 逐个 exact-ID 解决并保持单一 carried debt 权威", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        first: order("first", { price: 2.5 }),
        second: order("second", { price: 2.5 }),
      },
    });
    installManagedOrder("first");
    const first = Memory.data!.marketSaleAutomation!.managedOrders.first;
    Memory.data!.marketSaleAutomation!.managedOrders.second = {
      ...first,
      orderId: "second",
    };

    runMarketSalePreflight();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toMatchObject({ orderId: "first" });

    market.orders = {};
    Game.time += 1;
    runMarketSalePreflight();

    expect(
      resolveMarketSaleExternalOrderMutation("first", 110_000),
    ).toMatchObject({ ok: true });
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toMatchObject({
      reason: "external_order_mutation",
      orderId: "second",
    });
    expect(
      resolveMarketSaleExternalOrderMutation("second", 120_000),
    ).toMatchObject({ ok: true });
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
    ).toBe(230_000);
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

  it("operator 确认 policy cancellation 时不假设退款并 carry 全部剩余费用", () => {
    validConfig("maker");
    installMarket();
    installManagedOrder("managed");
    runMarketSalePreflight();

    expect(
      resolveMarketSaleOrderDisappearance("managed", "policy_cancelled"),
    ).toMatchObject({
      ok: true,
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 100_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[RESOURCE_KEANIUM],
    ).toBe(100_000);
  });

  it("无 pending mutation 的外部调价不会被吸收到托管账本", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", { price: 2.5 }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;

    runMarketSalePreflight();

    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed
        .externalMutationGap,
    ).toMatchObject({
      expectedPrice: 2,
      observedPrice: 2.5,
    });
    expect(Memory.data?.marketSaleAutomation?.managedOrders.managed.price).toBe(
      2,
    );
  });

  it("完整 Shadow 资格与有效 lease 也不能绕过 Maker 永久闩", () => {
    qualifyMaker();
    const market = installMarket();
    expect(
      grantMarketSaleMutationLease("maker-permanent-latch", Game.time + 10).ok,
    ).toBe(true);

    const result = runMarketSaleAutomation({
      candidates: [candidate()],
    });

    expect(result.effectiveMode).toBe("emergencyStop");
    expect(result.phase).not.toMatch(/maker|hybrid/);
    expect(result.writes).toBe(0);
    expect(
      result.rejectedByReason.market_maker_hybrid_permanently_disabled,
    ).toBe(1);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(market.extendOrder).not.toHaveBeenCalled();
    expect(market.changeOrderPrice).not.toHaveBeenCalled();
    expect(market.deal).not.toHaveBeenCalled();
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
  });

  it("emergencyStop 仅在 live ID、pending 与 exposure 归零后跨两个 tick 进入 stopped", () => {
    validConfig("emergencyStop");
    const market = installMarket({ orders: { managed: order("managed") } });
    installManagedOrder("managed");

    expect(runMarketSalePreflight().phase).toMatch(/requested|draining/);
    market.orders = {};
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("draining");
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("stopped");
    expect(Memory.data?.marketSaleAutomation?.managedOrders).toEqual({});
    expect(Memory.data?.marketSaleAutomation?.pendingMutations).toEqual({});
    expect(Memory.runtime?.marketSaleAutomation?.exposureAmount).toBe(0);
  });

  it("preflight 从 canonical stores 读取 staging/reservation，非空或损坏时阻断 stopped", () => {
    validConfig("emergencyStop");
    runMarketSalePreflight();
    Memory.data!.marketSaleAutomation!.marketStaging = {
      "stage:x": { amount: 1_000 },
    };
    Memory.data!.marketSaleAutomation!.marketReservations = {
      "reservation:x": { amount: 250 },
    };
    Game.time += 1;

    expect(runMarketSalePreflight().phase).toMatch(/requested|draining/);
    expect(Memory.runtime!.marketSaleAutomation).toMatchObject({
      stagingAmount: 1_000,
      reservationAmount: 250,
      zeroConfirmations: 0,
    });

    (
      Memory.data!.marketSaleAutomation as unknown as {
        marketStaging: unknown;
      }
    ).marketStaging = [];
    Game.time += 1;
    const malformed = runMarketSalePreflight();
    expect(malformed.phase).toMatch(/requested|draining/);
    expect(malformed.rejectedByReason).toHaveProperty(
      "market_domain_activity_invalid",
    );
    expect(Memory.runtime!.marketSaleAutomation!.stagingAmount).toBe(1);

    Memory.data!.marketSaleAutomation!.marketStaging = {
      ghost: { amount: 0 },
    };
    Game.time += 1;
    const zeroRecord = runMarketSalePreflight();
    expect(zeroRecord.phase).toMatch(/requested|draining/);
    expect(zeroRecord.rejectedByReason).toHaveProperty(
      "market_domain_activity_invalid",
    );
    expect(Memory.runtime!.marketSaleAutomation!.stagingAmount).toBe(1);

    Memory.data!.marketSaleAutomation!.marketStaging = {};
    Memory.data!.marketSaleAutomation!.marketReservations = {};
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("draining");
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("stopped");
  });

  it("有效 V3 Direct 遇到 managed T3 与低价 K 时只撤单，连续两次归零前绝不 deal", () => {
    activateMarketBaseV3Fixture();
    const data = Memory.data!.marketSaleAutomation!;
    (
      data as unknown as {
        managedOrders: Record<string, Record<string, unknown>>;
      }
    ).managedOrders = {
      "legacy-t3": managedOrderState("legacy-t3", {
        resourceType: RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
        price: 10,
      }),
      "legacy-low-k": managedOrderState("legacy-low-k", {
        resourceType: RESOURCE_KEANIUM,
        price: 0.1,
      }),
    };
    const market = installMarket({
      orders: {
        "legacy-t3": order("legacy-t3", {
          resourceType: RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
          price: 10,
        }),
        "legacy-low-k": order("legacy-low-k", {
          resourceType: RESOURCE_KEANIUM,
          price: 0.1,
        }),
      },
      getAllOrders: jest.fn(() => [
        order("high-k-buy", {
          type: ORDER_BUY,
          price: 10,
          roomName: "E1S1",
        }),
      ]),
    });
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const draining = runMarketSaleAutomation({
      candidates: [
        candidate({
          directHistoryTrusted: true,
          historyFloor: 1.1,
          ratchetFloor: 1.1,
          effectiveEnergyShadowPrice: 20,
          energyShadowObservedAt: Game.time,
          energyShadowComponents: {
            hardFloor: 20,
          },
        }),
      ],
    });

    expect(draining.phase).toMatch(/requested|draining/);
    expect(draining.rejectedByReason.direct_legacy_exposure_draining).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledTimes(2);
    expect(market.cancelOrder).toHaveBeenCalledWith("legacy-t3");
    expect(market.cancelOrder).toHaveBeenCalledWith("legacy-low-k");
    expect(market.deal).not.toHaveBeenCalled();

    market.orders = {};
    Game.time += 1;
    const firstZero = runMarketSalePreflight();
    expect(firstZero.phase).toBe("draining");
    expect(
      Memory.data!.marketSaleAutomation as unknown as {
        directLegacyExposureDrain: {
          zeroConfirmations: number;
        };
      },
    ).toMatchObject({
      directLegacyExposureDrain: {
        zeroConfirmations: 1,
      },
    });
    expect(market.deal).not.toHaveBeenCalled();

    Game.time += 1;
    const secondZero = runMarketSalePreflight();
    expect(secondZero.phase).toBe("direct");
    expect(Memory.runtime!.marketSaleAutomation!.zeroConfirmations).toBe(2);
    expect(
      Memory.data!.marketSaleAutomation as unknown as {
        directLegacyExposureDrain: {
          zeroConfirmations: number;
          completedAt: number;
        };
      },
    ).toMatchObject({
      directLegacyExposureDrain: {
        zeroConfirmations: 2,
        completedAt: Game.time,
      },
    });
  });

  it("V3 cutover 同一次 root replacement 写入双 activation anchor，nested 丢失后永久零写且不回退 V2", () => {
    activateMarketBaseV3Fixture();
    const activated = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor?: {
        anchorHash: string;
      };
      baseResourceV3ActivationAnchorMirror?: {
        anchorHash: string;
      };
      baseResourceV3ActivationBlocker?: {
        code: string;
      };
      directAutomation: {
        baseResourceV3?: unknown;
      };
    };
    expect(activated.baseResourceV3ActivationAnchor?.anchorHash).toBeTruthy();
    expect(activated.baseResourceV3ActivationAnchorMirror?.anchorHash).toBe(
      activated.baseResourceV3ActivationAnchor?.anchorHash,
    );

    delete activated.directAutomation.baseResourceV3;
    const market = Game.market as MutableMarket;
    Game.time += 1;
    const result = runMarketSalePreflight();
    const blocked = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationBlocker?: {
        code: string;
      };
      directAutomation: {
        baseResourceV3?: {
          cutoverLatched?: boolean;
          blocker?: string;
        };
      };
    };

    expect(result.rejectedByReason).toHaveProperty(
      "market_base_nested_state_missing_after_cutover",
    );
    expect(blocked.baseResourceV3ActivationBlocker?.code).toBe(
      "market_base_nested_state_missing_after_cutover",
    );
    expect(blocked.directAutomation.baseResourceV3).toMatchObject({
      cutoverLatched: true,
      blocker: "market_base_nested_state_missing_after_cutover",
    });
    expect(market.deal).not.toHaveBeenCalled();
  });

  it("runtimeOnly nested scope 删除或错类型均 fail closed，零 inner/claim/deal", () => {
    activateMarketBaseV3Fixture();
    const clean = JSON.parse(
      JSON.stringify(Memory.data!.marketSaleAutomation),
    ) as NonNullable<Memory["data"]>["marketSaleAutomation"];
    const attacks: Array<(state: Record<string, unknown>) => void> = [
      (state) => {
        delete state.roomRegistry;
      },
      (state) => {
        state.laneLifecycles = null;
      },
      (state) => {
        delete state.laneTombstoneDischargeCheckpoint;
      },
    ];
    for (const attack of attacks) {
      const attacked = JSON.parse(JSON.stringify(clean)) as unknown as {
        directAutomation: {
          baseResourceV3: {
            scope: Record<string, unknown>;
          };
        };
      };
      attack(attacked.directAutomation.baseResourceV3.scope);
      Memory.data!.marketSaleAutomation = attacked as unknown as NonNullable<
        Memory["data"]
      >["marketSaleAutomation"];
      clearMarketActionArbiterForTest();
      (Game.market.deal as jest.Mock).mockClear();
      const innerSpy = jest.spyOn(
        marketBaseResourceAutomationModule,
        "runMarketBaseResourceAutomation",
      );
      Game.time += 1;
      const preflight = runMarketSalePreflight();
      const result = runMarketSaleAutomation({ candidates: [] });
      innerSpy.mockRestore();

      const expected = [
        "market_base_v3_runtime_capability_open_failed",
        "market_base_nested_runtime_scope_invalid",
        "market_base_nested_state_shape_invalid_after_cutover",
      ].find((reason) => preflight.rejectedByReason[reason] === 1);
      expect(expected).toBeDefined();
      expect(result.rejectedByReason).toHaveProperty(expected!);
      expect(
        (
          Memory.data!.marketSaleAutomation as unknown as {
            baseResourceV3ActivationBlocker?: {
              code: string;
            };
          }
        ).baseResourceV3ActivationBlocker?.code,
      ).toBe(expected);
      expect(innerSpy).not.toHaveBeenCalled();
      expect(getTerminalActionClaims()).toHaveLength(0);
      expect(Game.market.deal).not.toHaveBeenCalled();
    }
  });

  it("marketBaseResourceStatus 有界投影 catalog、准入、quota、Hub 与 Energy readiness", () => {
    activateMarketBaseV3Fixture();
    Game.time += 1;
    runMarketSalePreflight();
    const state = JSON.parse(
      JSON.stringify(currentMarketBaseV3StateFixture()),
    ) as MarketBaseResourceV3RuntimeState;
    const room = state.scope!.sellerRooms[0];
    state.quotaProjection = {
      observedAt: Game.time,
      cooldownNotBefore: 0,
      retryNotBefore: 0,
      global: { cap: 12_000, confirmed: 0, unmatched: 0 },
      resources: Object.fromEntries(
        MARKET_BASE_RESOURCE_CATALOG.map((resource) => [
          resource,
          { cap: 8_000, confirmed: 0, unmatched: 0 },
        ]),
      ),
      rooms: {
        [room.roomName]: { cap: 4_000, confirmed: 0, unmatched: 0 },
      },
      lanes: {
        [state.scope!.laneLifecycles[0].laneId]: {
          cap: 2_000,
          confirmed: 0,
          unmatched: 0,
        },
      },
    };
    Memory.data!.marketSaleAutomation = JSON.parse(
      JSON.stringify(Memory.data!.marketSaleAutomation),
    ) as NonNullable<NonNullable<Memory["data"]>["marketSaleAutomation"]>;
    persistMarketBaseFixtureState(state);
    Memory.runtime = {
      ...(Memory.runtime ?? {}),
      hub: {
        protectionAttemptHighWater: 7,
        currentProtectionAttempt: {
          attemptRevision: 7,
          configIncarnation: 3,
          startedAt: Game.time,
          finishedAt: Game.time,
          configFingerprint: "hub-config-fixture",
          status: "committed",
          valid: true,
        },
        committedProtectionSnapshot: {
          schema: "hub-protection-snapshot-v1",
          planRevision: 7,
          configIncarnation: 3,
          observedAt: Game.time,
          expiresAt: Game.time + 10,
          configFingerprint: "hub-config-fixture",
          status: "committed",
          valid: true,
          marker: {
            revision: 7,
            configIncarnation: 3,
            configFingerprint: "hub-config-fixture",
            hubRoomName: room.roomName,
            planMode: "distributed",
            targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ACID],
            hubReservePerCompound: 50_000,
          },
        },
      },
      resourceControl: {
        updatedAt: Game.time,
        rooms: {
          [room.roomName]: {
            marketEnergyReadiness: {
              schemaVersion: 3,
              revision: "energy-readiness-fixture",
              observedAt: Game.time,
              expiresAt: Game.time + 1,
              authorizationRevision: "authorization-fixture",
              roomInstanceId: room.roomInstanceId,
              terminalId: room.terminalId,
              authorized: true,
              effectivePostDealEnergyReserve: 25_000,
              marketTerminalEnergyTarget: 26_000,
              ordinaryTerminalEnergyTarget: 20_000,
              unresolvedEnergySendAmount: 0,
              unresolvedInternalSendFees: 0,
              terminalScopedProductionEnergyCommitments: 0,
              maxTransactionEnergy: 1_000,
              contributionCount: 0,
              contributions: [],
              desiredTerminalEnergy: 26_000,
              plannedFeedAmount: 2_347,
              status: "feed_planned",
            },
          },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as unknown as Memory["runtime"];

    const status = marketBaseResourceStatus() as any;

    expect([...status.catalog.resources].sort()).toEqual([
      "H",
      "K",
      "L",
      "O",
      "U",
      "X",
      "Z",
    ]);
    expect(status.scope.admission.knownRoomCount).toBeGreaterThan(0);
    expect(status.scope.currentRoster[0]).toMatchObject({
      roomName: room.roomName,
      roomInstanceId: room.roomInstanceId,
      terminalId: room.terminalId,
    });
    expect(status.scope.lifecycleSample.length).toBeLessThanOrEqual(16);
    expect(status.quota.resources.total).toBe(7);
    expect(status.quota.lanes.entries.length).toBeLessThanOrEqual(16);
    expect(status.hubProtection.committedMarker).toMatchObject({
      planRevision: 7,
      hubRoomName: room.roomName,
      planMode: "distributed",
      targetCompoundCount: 1,
    });
    expect(status.terminalEnergyReadiness.rooms[0]).toMatchObject({
      roomName: room.roomName,
      observation: {
        authorized: true,
        effectivePostDealEnergyReserve: 25_000,
        plannedFeedAmount: 2_347,
        status: "feed_planned",
      },
    });
    expect(status.cpu).toHaveProperty("blocker");
  });

  it("cold Memory 单边改写 seller terminal 不得沿用旧 incarnation/grant", () => {
    activateMarketBaseV3CanaryFixture();
    const attacked = JSON.parse(
      JSON.stringify(Memory.data!.marketSaleAutomation),
    ) as unknown as {
      directAutomation: {
        baseResourceV3: MarketBaseResourceV3RuntimeState;
      };
    };
    const scope = attacked.directAutomation.baseResourceV3.scope!;
    const seller = scope.sellerRooms.find(
      (candidate) => candidate.roomName === "W1N1",
    );
    const registryCurrent = scope.roomRegistry.rooms.W1N1.current;
    if (!seller || !registryCurrent) {
      throw new Error("missing W1N1 scope fixture");
    }
    const originalInstanceId = seller.roomInstanceId;
    const replacementTerminalId = "eeeeeeeeeeeeeeeeeeeeeeee";
    (
      Game.rooms.W1N1.terminal as StructureTerminal & {
        id: Id<StructureTerminal>;
      }
    ).id = replacementTerminalId as Id<StructureTerminal>;
    (seller as { terminalId: string }).terminalId = replacementTerminalId;
    expect(registryCurrent.terminalId).not.toBe(replacementTerminalId);
    expect(seller.roomInstanceId).toBe(originalInstanceId);
    Memory.data!.marketSaleAutomation = attacked as unknown as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >;

    clearMarketActionArbiterForTest();
    (Game.market.deal as jest.Mock).mockClear();
    const innerSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    Game.time += 1;
    const preflight = runMarketSalePreflight();
    const result = runMarketSaleAutomation({ candidates: [] });
    innerSpy.mockRestore();

    expect(preflight.rejectedByReason).toHaveProperty(
      "market_base_v3_runtime_capability_open_failed",
    );
    expect(result.rejectedByReason).toHaveProperty(
      "market_base_v3_runtime_capability_open_failed",
    );
    expect(innerSpy).not.toHaveBeenCalled();
    expect(getTerminalActionClaims()).toHaveLength(0);
    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("activation anchor 任一副本缺失或 V3 config 回拨都会持久闭锁", () => {
    activateMarketBaseV3Fixture();
    const data = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchorMirror?: unknown;
      baseResourceV3ActivationBlocker?: {
        code: string;
      };
    };
    delete data.baseResourceV3ActivationAnchorMirror;
    Game.time += 1;
    const missingMirror = runMarketSalePreflight();
    expect(missingMirror.rejectedByReason).toHaveProperty(
      "market_base_activation_anchor_invalid",
    );
    expect(
      (
        Memory.data!.marketSaleAutomation as unknown as {
          baseResourceV3ActivationBlocker?: {
            code: string;
          };
        }
      ).baseResourceV3ActivationBlocker?.code,
    ).toBe("market_base_activation_anchor_invalid");

    // persistent blocker 不因把 config 改回 legacy capability 而消失或回退。
    Memory.cfg!.marketSaleAutomation!.directCapability = "continuous-v2";
    Game.time += 1;
    runMarketSalePreflight();
    expect(
      (
        Memory.data!.marketSaleAutomation as unknown as {
          baseResourceV3ActivationBlocker?: {
            code: string;
          };
        }
      ).baseResourceV3ActivationBlocker?.code,
    ).toBe("market_base_activation_anchor_invalid");
    expect(Game.market.deal).not.toHaveBeenCalled();
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

  it.each(["room", "lane"] as const)(
    "双 activation anchor 的 %s high-water 即使一起重签也不能绕过当前 scope",
    (kind) => {
      activateMarketBaseV3Fixture();
      const data = Memory.data!.marketSaleAutomation as unknown as {
        baseResourceV3ActivationAnchor: MarketBaseResourceActivationAnchor;
        baseResourceV3ActivationAnchorMirror: MarketBaseResourceActivationAnchor;
      };
      const attacked = JSON.parse(
        JSON.stringify(data.baseResourceV3ActivationAnchor),
      ) as MarketBaseResourceActivationAnchor;
      if (kind === "room") {
        const room = attacked.roomIncarnationHighWater[0] as {
          incarnationHighWater: number;
        };
        room.incarnationHighWater += 1;
      } else {
        const lane = attacked.laneLifecycleHighWater[0] as {
          completeCycles: number;
        };
        lane.completeCycles += 1;
      }
      const { anchorHash: _oldAnchorHash, ...payload } = attacked;
      (attacked as { anchorHash: string }).anchorHash = canonicalStableHashV1({
        domain: "market-base-resource:activation-anchor-v1",
        payload,
      });
      data.baseResourceV3ActivationAnchor = attacked;
      data.baseResourceV3ActivationAnchorMirror = JSON.parse(
        JSON.stringify(attacked),
      ) as MarketBaseResourceActivationAnchor;

      Game.time += 1;
      const result = runMarketSalePreflight();
      expect(result.writes).toBe(0);
      expect(result.rejectedByReason).toHaveProperty(
        kind === "room"
          ? "market_base_room_incarnation_high_water_rollback"
          : "market_base_lane_lifecycle_high_water_rollback",
      );
      expect(Game.market.deal).not.toHaveBeenCalled();
      expect(getTerminalActionClaims()).toHaveLength(0);
    },
  );

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

  it("V3 accept 的最终 root assignment 抛错时不原地污染 proposal/permit/anchor", () => {
    const proposalId = proposeMarketBaseV3CutoverFixture();
    const original = Memory.data!.marketSaleAutomation!;
    let canonical = original;
    let assignmentCount = 0;
    Object.defineProperty(Memory.data!, "marketSaleAutomation", {
      configurable: true,
      get: () => canonical,
      set: (next) => {
        assignmentCount += 1;
        if (assignmentCount === 1) {
          canonical = next;
          return;
        }
        throw new Error("injected-root-commit-failure");
      },
    });

    const result = acceptMarketBaseResourcePermit(proposalId);

    expect(result).toMatchObject({
      ok: false,
      error: "market_base_permit_accept_commit_failed",
    });
    expect(Memory.data!.marketSaleAutomation).toBe(canonical);
    const unchanged = canonical as unknown as {
      baseResourceV3ActivationAnchor?: unknown;
      directAutomation: {
        baseResourceV3?: {
          proposedPermit?: {
            proposalId: string;
          };
          cutoverLatched?: boolean;
        };
      };
    };
    expect(unchanged.baseResourceV3ActivationAnchor).toBeUndefined();
    expect(unchanged).toMatchObject({
      directAutomation: {
        baseResourceV3: {
          proposedPermit: {
            proposalId,
          },
        },
      },
    });
    Object.defineProperty(Memory.data!, "marketSaleAutomation", {
      configurable: true,
      writable: true,
      value: canonical,
    });
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

  it("active V3 outer reconcile 已耗到 26 CPU 时沿用同一起点并在 claim/deal 前停机", () => {
    activateMarketBaseV3CanaryFixture();
    markDirectLegacyExposureDrainedFixture();
    Memory.runtime = {
      ...Memory.runtime,
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    let cpuReads = 0;
    (Game.cpu.getUsed as jest.Mock).mockImplementation(() => {
      cpuReads += 1;
      return cpuReads === 1 ? 0 : 26;
    });

    const result = runMarketSaleAutomation({ candidates: [] });

    expect(result.rejectedByReason).toHaveProperty(
      "market_base_cpu_ceiling_exceeded",
    );
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getTerminalActionClaims()).toHaveLength(0);
    expect(currentMarketBaseV3StateFixture().ledger?.pending).toBeUndefined();
  });

  it("stable scope 连续三 tick 重签 readiness，ResourceControl ready 且 inner 每 tick 可用", () => {
    const target = activateMarketBaseV3CanaryFixture();
    markDirectLegacyExposureDrainedFixture();
    for (const room of Object.values(Game.rooms)) {
      (
        room as Room & {
          find: jest.Mock<unknown[], []>;
        }
      ).find = jest.fn(() => []);
    }
    const innerSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    const authorizationRevisions: string[] = [];
    try {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        Game.time += 1;
        const preflight = runMarketSalePreflight();
        expect(preflight.rejectedByReason).not.toHaveProperty(
          "market_base_v3_permit_runtime_gate_failed",
        );
        const authorization =
          currentMarketBaseV3StateFixture().readinessAuthorization;
        expect(authorization).toMatchObject({
          schemaVersion: 3,
          validated: true,
          status: "authorized",
          updatedAt: Game.time,
          expiresAt: Game.time + 1,
        });
        authorizationRevisions.push(authorization!.revision);

        runResourceControl();
        expect(
          Memory.runtime?.resourceControl?.rooms?.[target.sellerRoom]
            ?.marketEnergyReadiness,
        ).toMatchObject({
          status: "ready",
          authorized: true,
          observedAt: Game.time,
          expiresAt: Game.time + 1,
          authorizationRevision: authorization!.revision,
        });
        const terminalRead =
          marketBaseResourceAutomationModule.readLiveMarketBaseTerminal(
            target.sellerRoom,
            target.resource,
          );
        expect(terminalRead).toMatchObject({
          owned: true,
          ready: true,
        });

        const callsBefore = innerSpy.mock.calls.length;
        const automation = runMarketSaleAutomation({ candidates: [] });
        expect(innerSpy.mock.calls).toHaveLength(callsBefore + 1);
        expect(automation.rejectedByReason).not.toHaveProperty(
          "market_base_v3_runtime_anchor_missing",
        );
        expect(automation.rejectedByReason).not.toHaveProperty(
          "market_base_v3_permit_runtime_gate_failed",
        );
        expect(
          currentMarketBaseV3StateFixture().readinessAuthorization,
        ).toMatchObject({
          updatedAt: Game.time,
          expiresAt: Game.time + 1,
          revision: authorization!.revision,
        });
      }
    } finally {
      innerSpy.mockRestore();
    }
    expect(new Set(authorizationRevisions).size).toBe(3);
    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it.each(["intact", "preflight_deleted"] as const)(
    "preflight+ResourceControl 后同 tick JSON clone root（%s）只能 transient 零成交，下一 tick 可恢复",
    (variant) => {
      activateMarketBaseV3CanaryFixture();
      markDirectLegacyExposureDrainedFixture();
      for (const room of Object.values(Game.rooms)) {
        (
          room as Room & {
            find: jest.Mock<unknown[], []>;
          }
        ).find = jest.fn(() => []);
      }
      runMarketSalePreflight();
      runResourceControl();

      const cloned = JSON.parse(
        JSON.stringify(Memory.data!.marketSaleAutomation),
      ) as NonNullable<NonNullable<Memory["data"]>["marketSaleAutomation"]>;
      if (variant === "preflight_deleted") {
        delete (
          cloned.directAutomation as unknown as {
            baseResourceV3: { preflightAt?: number };
          }
        ).baseResourceV3.preflightAt;
      }
      Memory.data!.marketSaleAutomation = cloned;
      const innerSpy = jest.spyOn(
        marketBaseResourceAutomationModule,
        "runMarketBaseResourceAutomation",
      );
      let result: ReturnType<typeof runMarketSaleAutomation>;
      try {
        result = runMarketSaleAutomation({ candidates: [] });
      } finally {
        innerSpy.mockRestore();
      }

      expect(innerSpy).not.toHaveBeenCalled();
      expect(result!.rejectedByReason).toMatchObject({
        market_base_v3_same_tick_root_replaced: 1,
      });
      expect(Game.market.deal).not.toHaveBeenCalled();
      expect(getTerminalActionClaims()).toHaveLength(0);
      expect(
        (
          Memory.data!.marketSaleAutomation as unknown as {
            baseResourceV3ActivationBlocker?: unknown;
          }
        ).baseResourceV3ActivationBlocker,
      ).toBeUndefined();

      Game.time += 1;
      const recovered = runMarketSalePreflight();
      expect(recovered.rejectedByReason).not.toHaveProperty(
        "market_base_v3_same_tick_root_replaced",
      );
      expect(
        (
          Memory.data!.marketSaleAutomation as unknown as {
            baseResourceV3ActivationBlocker?: unknown;
          }
        ).baseResourceV3ActivationBlocker,
      ).toBeUndefined();
      expect(Game.market.deal).not.toHaveBeenCalled();
    },
  );

  it("cold Memory 512 receipt 满环的完整 active outer tick 保持单次预算且不重复 full audit", () => {
    for (const [roomName, terminalId] of [
      ["E1N1", "dddddddddddddddddddddddd"],
      ["E2N2", "eeeeeeeeeeeeeeeeeeeeeeee"],
      ["E3N3", "ffffffffffffffffffffffff"],
      ["E4N4", "111111111111111111111111"],
      ["E5N5", "222222222222222222222222"],
      ["E7N7", "333333333333333333333333"],
    ] as const) {
      installOwnedMarketBaseRoom(roomName, terminalId);
    }
    for (const room of Object.values(Game.rooms)) {
      (
        room as Room & {
          find: jest.Mock<unknown[], []>;
        }
      ).find = jest.fn(() => []);
    }
    activateMarketBaseV3Fixture();
    const state = currentMarketBaseV3StateFixture();
    expect(state.scope!.sellerRooms).toHaveLength(8);
    const lane = state.scope!.laneLifecycles.find(
      (candidate) =>
        candidate.sellerRoomName === "W1N1" &&
        candidate.resource === RESOURCE_KEANIUM,
    )!;
    const reviewMocks = installMarketBaseContinuousReviewMocks();
    try {
      qualifyMarketBaseLaneFixture(lane.laneId);
      transitionMarketBaseLaneFixture(lane.laneId, "canary");
      settleMarketBaseCanaryFixture(lane.laneId, "confirmed");
      promoteMarketBaseContinuousFixture(lane.laneId);
    } finally {
      reviewMocks.restore();
    }
    fillMarketBaseReceiptRingFixture(lane.laneId);
    expect(
      currentMarketBaseV3StateFixture().ledger!.receipts.length +
        currentMarketBaseV3StateFixture().ledger!.legacyQuotaReceipts.length,
    ).toBe(512);
    markDirectLegacyExposureDrainedFixture();

    const filledState = currentMarketBaseV3StateFixture();
    const activationAnchor = (
      Memory.data!.marketSaleAutomation as unknown as {
        baseResourceV3ActivationAnchor: {
          ledger: Parameters<
            typeof createMarketBaseResourceLedgerRuntimeContext
          >[0]["anchor"];
        };
      }
    ).baseResourceV3ActivationAnchor;
    const frozenRuntime = createMarketBaseResourceLedgerRuntimeContext({
      state: filledState.ledger!,
      permitChain: filledState.permitChain!,
      anchor: activationAnchor.ledger,
      tick: Game.time,
    });
    if ("reason" in frozenRuntime) {
      throw new Error(`ring_runtime_context_failed:${frozenRuntime.reason}`);
    }
    const cachedFirst =
      marketBaseResourceLedgerModule.validateMarketBaseResourceLedger(
        frozenRuntime.context.state,
        Game.time,
        frozenRuntime.context.permitChain,
      );
    const cachedSecond =
      marketBaseResourceLedgerModule.validateMarketBaseResourceLedger(
        frozenRuntime.context.state,
        Game.time,
        frozenRuntime.context.permitChain,
      );
    expect(cachedSecond).toBe(cachedFirst);
    const clonedLedger = JSON.parse(
      JSON.stringify(frozenRuntime.context.state),
    );
    const clonedPermitChain = JSON.parse(
      JSON.stringify(frozenRuntime.context.permitChain),
    );
    const cloneFirst =
      marketBaseResourceLedgerModule.validateMarketBaseResourceLedger(
        clonedLedger,
        Game.time,
        clonedPermitChain,
      );
    const cloneSecond =
      marketBaseResourceLedgerModule.validateMarketBaseResourceLedger(
        clonedLedger,
        Game.time,
        clonedPermitChain,
      );
    expect(cloneSecond).toEqual(cloneFirst);
    expect(cloneSecond).not.toBe(cloneFirst);

    const coldRoot = JSON.stringify(Memory.data!.marketSaleAutomation);
    const coldRuntime = JSON.stringify(Memory.runtime ?? {});
    const baseTick = Game.time;
    const coldPreflightMs: number[] = [];
    const resourceControlAndTerminalReadMs: number[] = [];
    const hotAutomationMs: number[] = [];
    const totalMs: number[] = [];
    const percentile = (values: readonly number[], ratio: number): number => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
    };
    let permitRuntimeGateCount = 0;
    let ledgerRuntimeGateCount = 0;
    let ledgerFullValidatorCount = 0;
    marketBaseResourcePermitModule.setMarketBaseResourcePermitRuntimeTestProbe(
      () => {
        permitRuntimeGateCount += 1;
      },
    );
    marketBaseResourceLedgerModule.setMarketBaseResourceLedgerRuntimeTestProbe(
      (event) => {
        if (event === "runtime_gate") {
          ledgerRuntimeGateCount += 1;
        } else {
          ledgerFullValidatorCount += 1;
        }
      },
    );
    try {
      for (let sample = 0; sample < 7; sample += 1) {
        // 每个样本都重新 JSON 反序列化，排除 WeakMap/object identity cache；
        // main 顺序先 cold preflight，再同 tick hot automation。
        Memory.data!.marketSaleAutomation = JSON.parse(coldRoot) as NonNullable<
          Memory["data"]
        >["marketSaleAutomation"];
        Memory.runtime = JSON.parse(coldRuntime) as Memory["runtime"];
        Game.time = baseTick + sample + 1;
        Memory.runtime = { ...Memory.runtime };
        let cpuReads = 0;
        (Game.cpu.getUsed as jest.Mock).mockImplementation(() => {
          cpuReads += 1;
          return cpuReads * 0.05;
        });
        permitRuntimeGateCount = 0;
        ledgerRuntimeGateCount = 0;
        ledgerFullValidatorCount = 0;
        const startedAt = globalThis.performance.now();
        runMarketSalePreflight();
        const preflightDoneAt = globalThis.performance.now();
        expect(ledgerFullValidatorCount).toBeLessThanOrEqual(1);
        expect(ledgerRuntimeGateCount).toBeLessThanOrEqual(1);
        expect(permitRuntimeGateCount).toBeLessThanOrEqual(2);

        permitRuntimeGateCount = 0;
        ledgerRuntimeGateCount = 0;
        ledgerFullValidatorCount = 0;
        runResourceControl();
        for (const room of currentMarketBaseV3StateFixture().scope!
          .sellerRooms) {
          marketBaseResourceAutomationModule.readLiveMarketBaseTerminal(
            room.roomName,
            RESOURCE_KEANIUM,
          );
        }
        const resourceControlDoneAt = globalThis.performance.now();
        expect(ledgerFullValidatorCount).toBe(0);
        expect(ledgerRuntimeGateCount).toBe(0);
        expect(permitRuntimeGateCount).toBe(0);

        permitRuntimeGateCount = 0;
        ledgerRuntimeGateCount = 0;
        ledgerFullValidatorCount = 0;
        const result = runMarketSaleAutomation({ candidates: [] });
        const automationDoneAt = globalThis.performance.now();
        expect(ledgerFullValidatorCount).toBe(0);
        expect(ledgerRuntimeGateCount).toBe(0);
        expect(permitRuntimeGateCount).toBe(0);
        coldPreflightMs.push(preflightDoneAt - startedAt);
        resourceControlAndTerminalReadMs.push(
          resourceControlDoneAt - preflightDoneAt,
        );
        hotAutomationMs.push(automationDoneAt - resourceControlDoneAt);
        totalMs.push(automationDoneAt - startedAt);
        expect(result.rejectedByReason).not.toHaveProperty(
          "market_base_cpu_ceiling_exceeded",
        );
        expect(cpuReads * 0.05).toBeLessThanOrEqual(25);
      }
    } finally {
      marketBaseResourcePermitModule.setMarketBaseResourcePermitRuntimeTestProbe(
        undefined,
      );
      marketBaseResourceLedgerModule.setMarketBaseResourceLedgerRuntimeTestProbe(
        undefined,
      );
    }
    const measurements = {
      coldPreflightMedianMs: percentile(coldPreflightMs, 0.5),
      coldPreflightP95Ms: percentile(coldPreflightMs, 0.95),
      resourceControlAndTerminalReadMedianMs: percentile(
        resourceControlAndTerminalReadMs,
        0.5,
      ),
      resourceControlAndTerminalReadP95Ms: percentile(
        resourceControlAndTerminalReadMs,
        0.95,
      ),
      hotAutomationMedianMs: percentile(hotAutomationMs, 0.5),
      hotAutomationP95Ms: percentile(hotAutomationMs, 0.95),
      totalMedianMs: percentile(totalMs, 0.5),
      totalP95Ms: percentile(totalMs, 0.95),
    };
    expect(measurements.coldPreflightP95Ms).toBeLessThan(100);
    expect(measurements.resourceControlAndTerminalReadP95Ms).toBeLessThan(75);
    expect(measurements.hotAutomationP95Ms).toBeLessThan(20);
    expect(measurements.totalP95Ms).toBeLessThan(150);
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getTerminalActionClaims()).toHaveLength(0);
  });

  it.each(["failed", "not_filled", "confirmed"] as const)(
    "同资源 A→B %s 后只恢复被 B 暂停的 A，人工暂停 C 与未提升 B 均保持 suspended",
    (outcomeStatus) => {
      installOwnedMarketBaseRoom("E3N59", "cccccccccccccccccccccccc");
      activateMarketBaseV3Fixture();
      const reviewMocks = installMarketBaseContinuousReviewMocks();
      try {
        const initial = currentMarketBaseV3StateFixture();
        const laneFor = (
          roomName: string,
          resource: ResourceConstant = RESOURCE_KEANIUM,
        ) => {
          const lane = initial.scope!.laneLifecycles.find(
            (candidate) =>
              candidate.sellerRoomName === roomName &&
              candidate.resource === resource,
          );
          expect(lane).toBeDefined();
          return lane!;
        };
        const laneA = laneFor("W1N1");
        const laneB = laneFor("E6N59");
        const laneC = laneFor("E3N59");
        const laneD =
          outcomeStatus === "failed"
            ? laneFor("W1N1", RESOURCE_HYDROGEN)
            : undefined;

        // failed case 同时覆盖 canary 期间插入无关 D operator permit。
        if (laneD) {
          qualifyMarketBaseLaneFixture(laneD.laneId);
          transitionMarketBaseLaneFixture(laneD.laneId, "canary");
          settleMarketBaseCanaryFixture(laneD.laneId, "confirmed");
          promoteMarketBaseContinuousFixture(laneD.laneId);
        }

        // C 先完成独立 canary/continuous，再由 operator 单独暂停。
        qualifyMarketBaseLaneFixture(laneC.laneId);
        transitionMarketBaseLaneFixture(laneC.laneId, "canary");
        settleMarketBaseCanaryFixture(laneC.laneId, "confirmed");
        promoteMarketBaseContinuousFixture(laneC.laneId);
        transitionMarketBaseLaneFixture(laneC.laneId, "suspend");

        // A 随后成为当前唯一同资源 continuous grant。
        qualifyMarketBaseLaneFixture(laneA.laneId);
        transitionMarketBaseLaneFixture(laneA.laneId, "canary");
        settleMarketBaseCanaryFixture(laneA.laneId, "confirmed");
        promoteMarketBaseContinuousFixture(laneA.laneId);
        expect(currentMarketBaseGrantFixture(laneA.laneId)).toMatchObject({
          stage: "continuous",
          newDealGrant: "enabled",
        });
        expect(currentMarketBaseGrantFixture(laneC.laneId)).toMatchObject({
          stage: "continuous",
          newDealGrant: "suspended",
        });

        // B canary 只应临时暂停当时 enabled 的 A；C 的暂停来源独立。
        qualifyMarketBaseLaneFixture(laneB.laneId);
        transitionMarketBaseLaneFixture(laneB.laneId, "canary");
        const bCanaryGrant = currentMarketBaseGrantFixture(laneB.laneId);
        expect(currentMarketBaseGrantFixture(laneA.laneId)).toMatchObject({
          stage: "continuous",
          newDealGrant: "suspended",
        });
        expect(currentMarketBaseGrantFixture(laneC.laneId)).toMatchObject({
          stage: "continuous",
          newDealGrant: "suspended",
        });

        if (outcomeStatus === "failed") {
          const prematureSuspend = proposeMarketBaseResourcePermit({
            laneId: laneB.laneId,
            targetStage: "suspend",
          }) as {
            ok: boolean;
            error?: string;
          };
          expect(prematureSuspend).toMatchObject({
            ok: false,
            error: "market_base_canary_suspension_requires_terminal_attempt",
          });
          expect(currentMarketBaseGrantFixture(laneB.laneId)).toMatchObject({
            stage: "canary",
            newDealGrant: "enabled",
          });
          expect(currentMarketBaseGrantFixture(laneA.laneId)).toMatchObject({
            stage: "continuous",
            newDealGrant: "suspended",
          });
        }

        if (laneD) {
          const blockedInterposedSuspend = proposeMarketBaseResourcePermit({
            laneId: laneD.laneId,
            targetStage: "suspend",
          }) as {
            ok: boolean;
            error?: string;
          };
          expect(blockedInterposedSuspend).toMatchObject({
            ok: false,
            error: "market_base_other_canary_must_resolve_first",
          });
          expect(currentMarketBaseGrantFixture(laneB.laneId)).toMatchObject({
            stage: "canary",
            newDealGrant: "enabled",
          });
        }
        settleMarketBaseCanaryFixture(laneB.laneId, outcomeStatus);
        transitionMarketBaseLaneFixture(laneB.laneId, "suspend");
        const bSuspendedGrant = currentMarketBaseGrantFixture(laneB.laneId);
        expect(bSuspendedGrant).toMatchObject({
          laneId: bCanaryGrant.laneId,
          laneStableFingerprint: bCanaryGrant.laneStableFingerprint,
          stage: "canary",
          status: "active",
          lifecycleEvidenceDigest: bCanaryGrant.lifecycleEvidenceDigest,
          reviewDigest: bCanaryGrant.reviewDigest,
          newDealGrant: "suspended",
        });
        if (laneD) {
          // B 已终态暂停后，插入一个真正 accept 的无关 D successor。
          // A 恢复必须沿 retained suffix 找回真实 B canary predecessor。
          transitionMarketBaseLaneFixture(laneD.laneId, "suspend");
          expect(currentMarketBaseGrantFixture(laneB.laneId)).toEqual(
            bSuspendedGrant,
          );
        }

        // A 的 confirmed proof + 本 tick exact review 允许恢复；C 不在
        // pre-B enabled → B-permit suspended 集合中，必须继续暂停。
        promoteMarketBaseContinuousFixture(laneA.laneId);
        expect(currentMarketBaseGrantFixture(laneA.laneId)).toMatchObject({
          stage: "continuous",
          newDealGrant: "enabled",
        });
        expect(currentMarketBaseGrantFixture(laneC.laneId)).toMatchObject({
          stage: "continuous",
          newDealGrant: "suspended",
        });
        if (laneD) {
          expect(currentMarketBaseGrantFixture(laneD.laneId)).toMatchObject({
            stage: "continuous",
            newDealGrant: "suspended",
          });
        }
        expect(currentMarketBaseGrantFixture(laneB.laneId)).toMatchObject({
          laneId: bCanaryGrant.laneId,
          laneStableFingerprint: bCanaryGrant.laneStableFingerprint,
          stage: "canary",
          lifecycleEvidenceDigest: bCanaryGrant.lifecycleEvidenceDigest,
          reviewDigest: bCanaryGrant.reviewDigest,
          newDealGrant: "suspended",
        });
      } finally {
        reviewMocks.restore();
      }
    },
  );

  it("V3 outer WAL 在 execute/deal 抛错前已原子保存 frozen pending 与双 activation anchor", () => {
    activateMarketBaseV3CanaryFixture();
    markDirectLegacyExposureDrainedFixture();
    const market = Game.market as MutableMarket;
    (market.deal as jest.Mock).mockImplementation(() => {
      throw new Error("injected-deal-throw");
    });
    let expectedPendingHash: string | undefined;
    const runtimeSpy = jest
      .spyOn(
        marketBaseResourceAutomationModule,
        "runMarketBaseResourceAutomation",
      )
      .mockImplementation(
        (source, _input, dependencies): MarketBaseResourceAutomationResult => {
          const preparedState = buildPreparedMarketBaseV3StateFixture(source);
          const pending = preparedState.ledger!.pending!;
          expectedPendingHash = pending.frozenEvidenceHash;
          const preparedAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
            preparedState.ledger!,
            preparedState.permitChain!,
          );
          const preparedCapability =
            createMarketBaseResourceReadinessRuntimeCapability(
              preparedState,
              Game.time,
              preparedAnchor,
            );
          expect(preparedCapability).toBeDefined();
          expect(
            dependencies.commitPreparedState(
              preparedState,
              preparedAnchor,
              preparedCapability,
            ),
          ).toBe(true);
          expect(dependencies.validatePreparedCanonicalRoot()).toBe(true);
          const claim = {
            requestId: pending.evidenceKeyHint,
            roomName: pending.historicalLane.sellerRoom,
            actor: "market-base-resource-v3",
            attemptAt: Game.time,
          };
          expect(dependencies.claimPrepared(claim)).toBe(true);
          expect(dependencies.validatePreparedCanonicalRoot()).toBe(true);
          dependencies.executePrepared({
            ...claim,
            orderId: pending.orderId,
            amount: pending.plannedAmount,
          });
          throw new Error("execute unexpectedly returned");
        },
      );
    try {
      expect(() =>
        runMarketSaleAutomation({
          candidates: [],
        }),
      ).toThrow("injected-deal-throw");
    } finally {
      runtimeSpy.mockRestore();
    }

    const canonical = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor: {
        anchorHash: string;
      };
      baseResourceV3ActivationAnchorMirror: {
        anchorHash: string;
      };
      directAutomation: {
        baseResourceV3: MarketBaseResourceV3RuntimeState;
      };
    };
    expect(
      canonical.directAutomation.baseResourceV3.ledger?.pending
        ?.frozenEvidenceHash,
    ).toBe(expectedPendingHash);
    expect(
      canonical.directAutomation.baseResourceV3.ledger?.pending,
    ).toMatchObject({
      schemaVersion: 3,
      orderId: "outer-wal-buy-order",
      attemptAt: Game.time,
    });
    expect(canonical.baseResourceV3ActivationAnchorMirror.anchorHash).toBe(
      canonical.baseResourceV3ActivationAnchor.anchorHash,
    );
    expect(market.deal).toHaveBeenCalledTimes(1);
  });

  it.each([
    "root_clone",
    "activation_blocker",
    "anchor_mirror",
    "config_rollback",
  ] as const)(
    "V3 prepared claim 后 %s 会使真实 outer CAS 失效、释放 claim 且零 deal",
    (variant) => {
      activateMarketBaseV3CanaryFixture();
      markDirectLegacyExposureDrainedFixture();
      let expectedPendingHash: string | undefined;
      const runtimeSpy = jest
        .spyOn(
          marketBaseResourceAutomationModule,
          "runMarketBaseResourceAutomation",
        )
        .mockImplementation(
          (
            source,
            _input,
            dependencies,
          ): MarketBaseResourceAutomationResult => {
            const preparedState = buildPreparedMarketBaseV3StateFixture(source);
            const pending = preparedState.ledger!.pending!;
            expectedPendingHash = pending.frozenEvidenceHash;
            const preparedAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
              preparedState.ledger!,
              preparedState.permitChain!,
            );
            const preparedCapability =
              createMarketBaseResourceReadinessRuntimeCapability(
                preparedState,
                Game.time,
                preparedAnchor,
              );
            expect(preparedCapability).toBeDefined();
            expect(
              dependencies.commitPreparedState(
                preparedState,
                preparedAnchor,
                preparedCapability,
              ),
            ).toBe(true);
            expect(dependencies.validatePreparedCanonicalRoot()).toBe(true);

            const claim = {
              requestId: pending.evidenceKeyHint,
              roomName: pending.historicalLane.sellerRoom,
              actor: "market-base-resource-v3",
              attemptAt: Game.time,
            };
            expect(dependencies.claimPrepared(claim)).toBe(true);
            const current = Memory.data!.marketSaleAutomation!;
            if (variant === "root_clone") {
              Memory.data!.marketSaleAutomation = JSON.parse(
                JSON.stringify(current),
              ) as NonNullable<
                NonNullable<Memory["data"]>["marketSaleAutomation"]
              >;
            } else if (variant === "activation_blocker") {
              (
                current as unknown as {
                  baseResourceV3ActivationBlocker?: unknown;
                }
              ).baseResourceV3ActivationBlocker = {
                code: "injected_between_claim_and_deal",
              };
            } else if (variant === "anchor_mirror") {
              (
                current as unknown as {
                  baseResourceV3ActivationAnchorMirror: unknown;
                }
              ).baseResourceV3ActivationAnchorMirror = JSON.parse(
                JSON.stringify(
                  (
                    current as unknown as {
                      baseResourceV3ActivationAnchorMirror: unknown;
                    }
                  ).baseResourceV3ActivationAnchorMirror,
                ),
              );
            } else {
              (
                Memory.cfg!.marketSaleAutomation as unknown as {
                  mode: string;
                }
              ).mode = "emergencyStop";
            }
            expect(dependencies.validatePreparedCanonicalRoot()).toBe(false);
            dependencies.releasePrepared(claim.requestId);
            return {
              actions: ["market-base-v3-claim-released-root-cas-failed"],
              rejectedByReason: {
                market_base_v3_prepared_root_cas_failed: 1,
              },
              writes: 0,
              planComplete: false,
              state: source,
            };
          },
        );
      let result: ReturnType<typeof runMarketSaleAutomation> | undefined;
      try {
        result = runMarketSaleAutomation({ candidates: [] });
      } finally {
        runtimeSpy.mockRestore();
      }

      expect(result?.rejectedByReason).toMatchObject({
        market_base_v3_prepared_root_cas_failed: 1,
      });
      expect(Game.market.deal).not.toHaveBeenCalled();
      expect(getTerminalActionClaims()).toHaveLength(0);
      expect(
        (
          Memory.data!.marketSaleAutomation!.directAutomation as unknown as {
            baseResourceV3: MarketBaseResourceV3RuntimeState;
          }
        ).baseResourceV3.ledger?.pending?.frozenEvidenceHash,
      ).toBe(expectedPendingHash);
    },
  );

  it("V3 prepared callback 遇到 canonical CAS 冲突时不 claim、不 deal、也不覆盖并发 root", () => {
    activateMarketBaseV3CanaryFixture();
    markDirectLegacyExposureDrainedFixture();
    const original = Memory.data!.marketSaleAutomation!;
    let concurrent: typeof original | undefined;
    const runtimeSpy = jest
      .spyOn(
        marketBaseResourceAutomationModule,
        "runMarketBaseResourceAutomation",
      )
      .mockImplementation(
        (source, _input, dependencies): MarketBaseResourceAutomationResult => {
          const preparedState = buildPreparedMarketBaseV3StateFixture(source);
          concurrent = {
            ...Memory.data!.marketSaleAutomation!,
            operatorAudit: [
              ...(
                Memory.data!.marketSaleAutomation as unknown as {
                  operatorAudit: unknown[];
                }
              ).operatorAudit,
              {
                tick: Game.time,
                action: "concurrent-root-replacement",
              },
            ],
          } as typeof original;
          Memory.data!.marketSaleAutomation = concurrent;
          expect(
            dependencies.commitPreparedState(
              preparedState,
              buildMarketBaseResourceLedgerRuntimeAnchor(
                preparedState.ledger!,
                preparedState.permitChain!,
              ),
            ),
          ).toBe(false);
          return {
            actions: ["market-base-v3-prepared-commit-failed"],
            rejectedByReason: {
              market_base_v3_prepared_commit_failed: 1,
            },
            writes: 0,
            planComplete: false,
            state: source,
          };
        },
      );
    let result: ReturnType<typeof runMarketSaleAutomation> | undefined;
    try {
      result = runMarketSaleAutomation({
        candidates: [],
      });
    } finally {
      runtimeSpy.mockRestore();
    }

    expect(Memory.data!.marketSaleAutomation).toBe(concurrent);
    expect(
      (
        Memory.data!.marketSaleAutomation!.directAutomation as unknown as {
          baseResourceV3: MarketBaseResourceV3RuntimeState;
        }
      ).baseResourceV3.ledger?.pending,
    ).toBeUndefined();
    expect(result?.rejectedByReason).toMatchObject({
      market_base_v3_prepared_commit_failed: 1,
      market_base_v3_returned_commit_conflict: 1,
    });
    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("Direct 清退不扫描手工 BUY；managed 异常指向 BUY 时闭锁且不撤单", () => {
    installContinuousDirectConfig();
    installExactReviewedLegacyDirectState();
    runMarketSalePreflight();
    (
      Memory.data!.marketSaleAutomation as unknown as {
        managedOrders: Record<string, Record<string, unknown>>;
      }
    ).managedOrders = {
      "corrupt-buy-alias": managedOrderState("corrupt-buy-alias"),
    };
    const market = installMarket({
      orders: {
        "corrupt-buy-alias": order("corrupt-buy-alias", {
          type: ORDER_BUY,
        }),
        "manual-buy": order("manual-buy", {
          type: ORDER_BUY,
        }),
      },
    });

    const result = runMarketSaleAutomation();

    expect(result.rejectedByReason.direct_legacy_buy_order_not_cancelled).toBe(
      1,
    );
    expect(result.rejectedByReason.managed_order_buy_identity_quarantined).toBe(
      1,
    );
    expect(market.cancelOrder).not.toHaveBeenCalled();
    expect(market.deal).not.toHaveBeenCalled();
    expect(result.phase).toMatch(/requested|draining/);
  });

  it("精确 reviewed v1 证据通过编排层确定性迁移为 readyForPermit，且部署本身零写", () => {
    installContinuousDirectConfig();
    installExactReviewedLegacyDirectState();

    const result = runMarketSalePreflight();
    const direct = Memory.data!.marketSaleAutomation!
      .directAutomation as unknown as Record<string, unknown>;

    expect(result.writes).toBe(0);
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(direct).toMatchObject({
      schemaVersion: 2,
      capability: "market-direct-continuous",
      migrationStatus: "readyForPermit",
    });
    expect(direct.migrationBlockedReason).toBeUndefined();
    expect(marketDirectContinuousStatus()).toMatchObject({
      migrationStatus: "readyForPermit",
      lifecycleByEntry: {
        "base-x-e6n59-v1": {
          stage: "review_paused",
          canaryConfirmedCount: 1,
        },
        "base-h-e3n59-v1": { stage: "shadow" },
        "base-z-e7n57-v1": { stage: "shadow" },
      },
    });
  });

  it("Direct capability 缺失 canonical 状态时全程零写并进入 emergencyStop", () => {
    installContinuousDirectConfig();
    Memory.data = {};

    const result = runMarketSalePreflight();

    expect(result.writes).toBe(0);
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(result.rejectedByReason).toHaveProperty("direct_state_missing");
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Game.market.createOrder).not.toHaveBeenCalled();
    expect(Game.market.cancelOrder).not.toHaveBeenCalled();
  });

  it("编排层 permit 入口只在精确迁移后签发 epoch1，并保持 H/Z 为 Shadow", () => {
    installContinuousDirectConfig();
    installExactReviewedLegacyDirectState();
    const terminal = installRoom("E6N59", RESOURCE_CATALYST);
    (
      Game.rooms.E6N59.controller as StructureController & {
        owner?: Owner;
      }
    ).owner = { username: "forst" };
    (terminal as StructureTerminal & { owner?: Owner }).owner = {
      username: "forst",
    };
    (
      Game as unknown as {
        shard: { name: string; type: string; ptr: boolean };
      }
    ).shard = {
      name: "shard1",
      type: "normal",
      ptr: false,
    };
    runMarketSalePreflight();

    const proposal = proposeMarketDirectContinuousPermit({
      operatorAuthorizationFingerprint: "operator:codex:test-reviewed-epoch1",
    }) as {
      ok: boolean;
      permit?: {
        permitId: string;
        entryGrants: Array<{
          entryId: string;
          stage: string;
          newDealGrant: string;
        }>;
      };
      error?: string;
    };

    expect(proposal.ok).toBe(true);
    expect(proposal.permit?.entryGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: "base-x-e6n59-v1",
          stage: "continuous",
          newDealGrant: "enabled",
        }),
        expect.objectContaining({
          entryId: "base-h-e3n59-v1",
          stage: "shadow",
          newDealGrant: "suspended",
        }),
        expect.objectContaining({
          entryId: "base-z-e7n57-v1",
          stage: "shadow",
          newDealGrant: "suspended",
        }),
      ]),
    );

    const accepted = acceptMarketDirectContinuousPermit(
      proposal.permit!.permitId,
    );
    expect(accepted).toMatchObject({
      ok: true,
      permitId: proposal.permit!.permitId,
    });
    expect(marketDirectContinuousStatus()).toMatchObject({
      migrationStatus: "active",
      permit: { epoch: 1 },
      lifecycleByEntry: {
        "base-x-e6n59-v1": { stage: "continuous" },
        "base-h-e3n59-v1": { stage: "shadow" },
        "base-z-e7n57-v1": { stage: "shadow" },
      },
    });
  });

  it("损坏的 market-sale 容器在 Continuous Direct 下保留证据并全局零写", () => {
    installContinuousDirectConfig();
    Memory.data = {
      marketSaleAutomation: null,
    } as unknown as Memory["data"];

    const result = runMarketSalePreflight();
    const direct = Memory.data!.marketSaleAutomation!
      .directAutomation as unknown as {
      migrationBlockedReason?: string;
      quarantinedPendingDirectDeals: Record<string, unknown>;
    };

    expect(result.writes).toBe(0);
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(direct.migrationBlockedReason).toBeDefined();
    expect(
      Object.keys(direct.quarantinedPendingDirectDeals).length,
    ).toBeGreaterThan(0);
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Game.market.createOrder).not.toHaveBeenCalled();
    expect(Game.market.cancelOrder).not.toHaveBeenCalled();
    expect(Game.market.extendOrder).not.toHaveBeenCalled();
    expect(Game.market.changeOrderPrice).not.toHaveBeenCalled();
  });
});
