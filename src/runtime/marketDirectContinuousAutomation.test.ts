import {
  LEGACY_V1_SAFE_FIXTURE_DIGEST,
  LEGACY_X_V1_OUTCOME_DIGEST,
  LEGACY_X_V1_OUTCOME_GOLDEN,
  LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST,
  acceptMarketDirectContinuousPermit,
  defaultMarketDirectContinuousDependencies,
  migrateLegacyDirectToContinuous,
  normalizeContinuousDirectState,
  proposeMarketDirectContinuousPermit,
  runMarketDirectContinuousPlanning,
  runMarketDirectContinuousPreflight,
  type MarketDirectContinuousAutomationInput,
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousDependencies,
  type MarketDirectContinuousRuntimeCandidate,
  type MarketDirectContinuousTerminalEnergyContribution,
  type MarketDirectContinuousTerminalEnergyReadiness,
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
    terminalId: `terminal:${entry.allowedRoomNames[0]}`,
    resourceAmount: 200_000,
    energy: 50_000,
    cooldown: 0,
    nativeMineralType: entry.requireNativeMineral
      ? entry.resourceType
      : RESOURCE_OXYGEN,
  };
}

function canonicalEnergyContributions(
  effectivePostDealEnergyReserve = 25_000,
): MarketDirectContinuousTerminalEnergyContribution[] {
  return [
    {
      id: "ordinary-terminal-target:E6N59",
      amount: 20_000,
      kind: "ordinary_terminal_target",
    },
    ...(effectivePostDealEnergyReserve > 25_000
      ? [
          {
            id: "production-reservation:fixture",
            amount:
              effectivePostDealEnergyReserve - 20_000,
            kind: "terminal_production_commitment",
          } as const,
        ]
      : []),
  ];
}

function terminalEnergyReadiness(
  tick: number,
  overrides: Partial<
    MarketDirectContinuousTerminalEnergyReadiness
  > = {},
): MarketDirectContinuousTerminalEnergyReadiness {
  const status = overrides.status ?? "ready";
  const effectivePostDealEnergyReserve =
    overrides.effectivePostDealEnergyReserve ?? 25_000;
  const contributions =
    overrides.contributions ??
    canonicalEnergyContributions(
      effectivePostDealEnergyReserve,
    );
  const sumKind = (
    kind: MarketDirectContinuousTerminalEnergyContribution["kind"],
  ): number =>
    contributions.reduce(
      (sum, contribution) =>
        contribution.kind === kind
          ? sum + contribution.amount
          : sum,
      0,
    );
  const marketTerminalEnergyTarget =
    overrides.marketTerminalEnergyTarget ??
    effectivePostDealEnergyReserve + 1_000;
  return {
    schemaVersion: 3,
    revision: `market-terminal-energy-v3:${tick}`,
    observedAt: tick,
    expiresAt: tick + 1,
    authorizationRevision: `readiness-auth:${tick}`,
    roomInstanceId: "room:E6N59:1",
    terminalId: "terminal:E6N59",
    authorized: true,
    effectivePostDealEnergyReserve,
    marketTerminalEnergyTarget,
    ordinaryTerminalEnergyTarget: sumKind(
      "ordinary_terminal_target",
    ),
    unresolvedEnergySendAmount: sumKind(
      "pending_energy_send",
    ),
    unresolvedInternalSendFees: sumKind(
      "pending_internal_send_fee",
    ),
    terminalScopedProductionEnergyCommitments: sumKind(
      "terminal_production_commitment",
    ),
    maxTransactionEnergy: 1_000,
    contributionCount: contributions.length,
    contributions,
    desiredTerminalEnergy:
      overrides.desiredTerminalEnergy ??
      Math.max(50_000, marketTerminalEnergyTarget),
    plannedFeedAmount:
      status === "feed_planned" ? 1_000 : 0,
    status,
    ...(status === "blocked"
      ? { blocker: "terminal_headroom" }
      : {}),
    ...overrides,
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
  | "readiness"
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
  missingMarketEnergyReadiness?: boolean;
  marketEnergyReadinessStatus?:
    MarketDirectContinuousTerminalEnergyReadiness["status"];
  effectivePostDealEnergyReserve?: number;
  terminalEnergy?: number;
  terminalCooldown?: number;
  terminalOwned?: boolean;
  canonicalEnergyContributions?:
    MarketDirectContinuousTerminalEnergyContribution[];
  mutateMarketEnergyReadiness?: (
    readiness: MarketDirectContinuousTerminalEnergyReadiness,
  ) => void;
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

function legacyV2ReadinessIdentity(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  terminalId = "terminal:E6N59",
): {
  authorizationRevision: string;
  roomInstanceId: string;
} {
  if (!state.currentPermit) {
    throw new Error("fixture current permit missing");
  }
  const roomInstanceId = canonicalStableHashV1({
    domain:
      "market-base-resource:legacy-v2-readiness-room-v1",
    evidence: {
      accountIdentity:
        state.currentPermit.accountIdentity,
      roomName: "E6N59",
      terminalId,
    },
  });
  const rooms = [
    {
      roomName: "E6N59",
      roomInstanceId,
      terminalId,
      status: "authorized" as const,
    },
  ];
  return {
    roomInstanceId,
    authorizationRevision: canonicalStableHashV1({
      domain:
        "market-base-resource:readiness-authorization-v1",
      evidence: {
        permitHead: state.currentPermit.permitHead,
        permitId: state.currentPermit.permitId,
        rooms,
        sourcePermitVersion: 2,
        tick,
      },
    }),
  };
}

function dependenciesFor(
  harness: RuntimeHarness,
  state?: MarketDirectContinuousAutomationState,
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
      if (resource === RESOURCE_CATALYST) {
        if (harness.terminalEnergy !== undefined) {
          snapshot.energy = harness.terminalEnergy;
        }
        if (harness.terminalCooldown !== undefined) {
          snapshot.cooldown = harness.terminalCooldown;
        }
        if (harness.terminalOwned !== undefined) {
          snapshot.owned = harness.terminalOwned;
        }
        if (!harness.missingMarketEnergyReadiness) {
          const reserve =
            (harness.effectivePostDealEnergyReserve ??
              25_000) +
            (harness.secondReadMutation === "readiness" &&
            terminalReads[key] === 2
              ? 1_000
              : 0);
          const identity = state
            ? legacyV2ReadinessIdentity(
                state,
                harness.tick,
              )
            : undefined;
          const readiness = terminalEnergyReadiness(
            harness.tick,
            {
              status:
                harness.marketEnergyReadinessStatus ??
                "ready",
              effectivePostDealEnergyReserve: reserve,
              marketTerminalEnergyTarget: reserve + 1_000,
              contributions:
                harness.canonicalEnergyContributions ??
                canonicalEnergyContributions(reserve),
              desiredTerminalEnergy: Math.max(
                snapshot.energy,
                reserve + 1_000,
              ),
              ...(identity || {}),
            },
          );
          harness.mutateMarketEnergyReadiness?.(
            readiness,
          );
          snapshot.marketEnergyReadiness = readiness;
        }
      }
      if (
        harness.secondReadMutation === "terminal" &&
        resource === RESOURCE_CATALYST &&
        terminalReads[key] === 2
      ) {
        snapshot.resourceAmount -= 1;
      }
      return snapshot;
    }),
    readCanonicalTerminalEnergyContributions: jest.fn(
      () =>
        clone(
          harness.canonicalEnergyContributions ??
            canonicalEnergyContributions(
              harness.effectivePostDealEnergyReserve ??
                25_000,
            ),
        ),
    ),
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

  it("默认 canonical reader 独立重建 pending send、fee、reservation 与 terminal production carrier", () => {
    const previousCfg = Memory.cfg;
    const previousData = Memory.data;
    const previousRuntime = Memory.runtime;
    const previousCarrierBoard = (
      global as typeof global & {
        __carrierTaskBoard?: unknown;
      }
    ).__carrierTaskBoard;
    const mutableGame = Game as unknown as {
      market?: Game["market"];
    };
    const previousMarket = mutableGame.market;
    Game.time = RUN_TICK;
    Memory.cfg = {
      resourceControl: {
        rooms: {
          E6N59: {
            terminalEnergyReserve: 30_000,
            transferBatchSize: 10_000,
          },
        },
      },
    } as unknown as Memory["cfg"];
    Memory.data = {
      resourceControl: {
        taskSchemaVersion: 2,
        tasks: {
          "energy-task": {
            id: "energy-task",
            resource: RESOURCE_ENERGY,
            fromRoomName: "E6N59",
            toRoomName: "E7N59",
            amount: 1_000,
            remainingAmount: 1_000,
            status: "pending",
            createdAt: RUN_TICK,
            updatedAt: RUN_TICK,
            origin: "manual",
            lastProgressAt: RUN_TICK,
          },
        },
      },
    } as unknown as Memory["data"];
    Memory.runtime = {
      resourceReservations: {
        "E6N59:energy:factory": {
          roomName: "E6N59",
          resource: RESOURCE_ENERGY,
          holderId: "factory",
          amount: 5_000,
          updatedAt: RUN_TICK,
          expiresAt: RUN_TICK + 1,
        },
      },
    } as unknown as Memory["runtime"];
    (
      global as typeof global & {
        __carrierTaskBoard?: unknown;
      }
    ).__carrierTaskBoard = {
      E6N59: {
        "factory-supply": {
          id: "factory-supply",
          producer: "factory:test",
          roomName: "E6N59",
          type: "factory_supply",
          priority: 1,
          createdAt: RUN_TICK,
          updatedAt: RUN_TICK,
          steps: [
            {
              id: "energy-step",
              resource: RESOURCE_ENERGY,
              fromKind: "terminal",
              toKind: "factory",
              fromId: "terminal:E6N59",
              toId: "factory:E6N59",
              amount: 2_000,
            },
          ],
        },
      },
    };
    mutableGame.market = {
      ...(previousMarket || {}),
      calcTransactionCost: jest.fn(() => 500),
    } as Game["market"];

    try {
      expect(
        defaultMarketDirectContinuousDependencies
          .readCanonicalTerminalEnergyContributions(
            "E6N59",
          ),
      ).toEqual([
        {
          id: "ordinary-terminal-target:E6N59",
          amount: 30_000,
          kind: "ordinary_terminal_target",
        },
        {
          id: "production-carrier:factory-supply:energy-step",
          amount: 2_000,
          kind: "terminal_production_commitment",
        },
        {
          id: "production-reservation:factory",
          amount: 5_000,
          kind: "terminal_production_commitment",
        },
        {
          id: "resource-transfer:energy-task:energy",
          amount: 1_000,
          kind: "pending_energy_send",
        },
        {
          id: "resource-transfer:energy-task:fee",
          amount: 500,
          kind: "pending_internal_send_fee",
        },
      ]);
    } finally {
      Memory.cfg = previousCfg;
      Memory.data = previousData;
      Memory.runtime = previousRuntime;
      (
        global as typeof global & {
          __carrierTaskBoard?: unknown;
        }
      ).__carrierTaskBoard = previousCarrierBoard;
      mutableGame.market = previousMarket;
    }
  });

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
    const dependencies = dependenciesFor(harness, state);

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
});
