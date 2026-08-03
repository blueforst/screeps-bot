/**
 * Pure, fail-closed market-sale protection ledger.
 *
 * Orchestration owns the adapters that translate live Game/Memory state into
 * source snapshots. This module deliberately distinguishes an observed empty
 * source (`complete: true`, `facts: []`) from an unknown source (missing or
 * incomplete), so a missing producer view can never silently become sellable
 * inventory.
 */

export const MARKET_PROTECTION_SOURCE_KINDS = [
  "stock",
  "floor",
  "forecast",
  "resourceReservations",
  "blockedOutgoing",
  "carrierInFlight",
  "factoryTargets",
  "factoryComponents",
  "factoryTasks",
  "synthesisActive",
  "synthesisPaused",
  "hub",
  "boost",
  "war",
  "managedExposure",
] as const;

export type MarketProtectionSourceKind = (typeof MARKET_PROTECTION_SOURCE_KINDS)[number];

export type MarketProtectionBucket =
  | "hardReserve"
  | "forecastBuffer"
  | "absoluteTarget"
  | "consumptiveDemand"
  | "productionDemand"
  | "protectedOutgoing"
  | "carrierOrInFlight"
  | "boostWar"
  | "hubCommitments"
  | "managedExposure";

export type MarketProtectionFactStatus =
  | "pending"
  | "active"
  | "paused"
  | "blocked"
  | "done"
  | "cancelled"
  | "failed";

export interface MarketProtectionObservation {
  revision: number;
  observedAt: number;
  expiresAt: number;
}

export interface MarketProtectionFact {
  roomName: string;
  resource: ResourceConstant;
  amount: number;
  /**
   * Globally stable identity for one logical commitment.
   *
   * Examples: reservation holder/key, transfer task ID, carrier task/step ID
   * or managed order ID. Repeated views with the same key are counted once at
   * the greatest observed amount. Facts without a key remain independent.
   */
  stableKey?: string;
  /** Required for precise self-order exposure exclusion when available. */
  managedOrderId?: string;
  /** Only meaningful for the stock source. */
  terminalStock?: number;
  /** Optional fact-specific freshness, in addition to source freshness. */
  revision?: number;
  observedAt?: number;
  expiresAt?: number;
  status?: MarketProtectionFactStatus;
  blockedReason?: string;
  /**
   * A pending outgoing commitment is releasable only when both flags are true.
   * Unknown/legacy records remain protected.
   */
  disposable?: boolean;
  contractExpired?: boolean;
  /**
   * Overrides the source's legacy default bucket. Producer adapters use this
   * to keep absolute inventory targets separate from consumptive commitments.
   */
  bucket?: MarketProtectionBucket;
  /**
   * A fully scoped uncertainty (for example an unbound synthesis donor) blocks
   * only the matching room/resource lane without making unrelated lanes stale.
   */
  blocksSale?: boolean;
}

export interface MarketProtectionSourceSnapshot extends MarketProtectionObservation {
  /**
   * `true` means this source was fully inspected, including the valid case of
   * an empty facts array. `false` is an unknown/partial view and fails closed.
   */
  complete: boolean;
  facts: readonly MarketProtectionFact[];
}

export interface MarketProtectionCandidate {
  roomName: string;
  resource: ResourceConstant;
}

export interface BuildMarketSaleProtectionLedgerInput extends MarketProtectionObservation {
  currentTick: number;
  candidates: readonly MarketProtectionCandidate[];
  sources: Partial<Record<MarketProtectionSourceKind, MarketProtectionSourceSnapshot>>;
}

export type MarketProtectionIssueCode =
  | "protection_stale"
  | "protection_invalid_fact"
  | "protection_ambiguous_contribution"
  | "stock_missing"
  | "stock_ambiguous"
  | "terminal_stock_missing"
  | "floor_missing"
  | "forecast_missing"
  | "protection_donor_unbound";

export interface MarketProtectionIssue {
  code: MarketProtectionIssueCode;
  sourceKind?: MarketProtectionSourceKind;
  stableKey?: string;
  detail?: string;
}

export interface MarketProtectionContribution {
  dedupeKey: string;
  stableKey?: string;
  anonymous: boolean;
  bucket: MarketProtectionBucket;
  amount: number;
  sourceKinds: MarketProtectionSourceKind[];
  managedOrderId?: string;
  observedAt: number;
  expiresAt: number;
}

export interface MarketProtectionEntry extends MarketProtectionObservation {
  roomName: string;
  resource: ResourceConstant;
  totalStock: number;
  terminalStock: number;
  hardReserve: number;
  /** max(hardReserve, forecastBuffer); populated by the current collector. */
  localReserve?: number;
  /** Absolute target for this resource itself; combined with localReserve by max. */
  absoluteTarget?: number;
  /** Additional demand that consumes this resource to make another resource. */
  consumptiveDemand?: number;
  /** Dedicated Boost/War commitment total. */
  boostWar?: number;
  /** Dedicated Hub route/dispatch commitment total. */
  hubCommitments?: number;
  productionDemand: number;
  forecastBuffer: number;
  protectedOutgoing: number;
  carrierOrInFlight: number;
  protectedAmount: number;
  grossSurplus: number;
  managedExposure: number;
  /** Surplus after exposure, before requiring terminal backing. */
  newExposureCapacity: number;
  /** New exposure that is both protection-safe and currently in terminal. */
  sellableAmount: number;
  fresh: boolean;
  blocked: boolean;
  blockedReasons: MarketProtectionIssueCode[];
  issues: MarketProtectionIssue[];
  sourceContributions: MarketProtectionContribution[];
}

export interface MarketSaleProtectionLedger extends MarketProtectionObservation {
  currentTick: number;
  fresh: boolean;
  entries: Record<string, MarketProtectionEntry>;
  blockedEntryCount: number;
  /** True when source coverage is not complete enough to scope the failure. */
  globalBlocked?: boolean;
  /** Global coverage failures for the account-wide Direct gate. */
  globalIssues?: MarketProtectionIssue[];
}

const SOURCE_BUCKETS: Record<
  Exclude<MarketProtectionSourceKind, "stock">,
  MarketProtectionBucket
> = {
  floor: "hardReserve",
  forecast: "forecastBuffer",
  resourceReservations: "protectedOutgoing",
  blockedOutgoing: "protectedOutgoing",
  carrierInFlight: "carrierOrInFlight",
  factoryTargets: "absoluteTarget",
  factoryComponents: "consumptiveDemand",
  factoryTasks: "consumptiveDemand",
  synthesisActive: "consumptiveDemand",
  synthesisPaused: "consumptiveDemand",
  hub: "hubCommitments",
  boost: "boostWar",
  war: "boostWar",
  managedExposure: "managedExposure",
};

const TERMINAL_FACT_STATUSES = new Set<MarketProtectionFactStatus>([
  "done",
  "cancelled",
]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeProtectionAmount(value: number): number {
  return Math.ceil(value);
}

function normalizeStockAmount(value: number): number {
  return Math.floor(value);
}

function observationIsFresh(
  observation: MarketProtectionObservation,
  currentTick: number,
): boolean {
  return (
    Number.isFinite(observation.revision) &&
    observation.revision === currentTick &&
    Number.isFinite(observation.observedAt) &&
    observation.observedAt <= currentTick &&
    Number.isFinite(observation.expiresAt) &&
    observation.expiresAt >= currentTick &&
    observation.expiresAt >= observation.observedAt
  );
}

function factObservationIsFresh(
  fact: MarketProtectionFact,
  snapshot: MarketProtectionSourceSnapshot,
  currentTick: number,
): boolean {
  return observationIsFresh(
    {
      revision: fact.revision ?? snapshot.revision,
      observedAt: fact.observedAt ?? snapshot.observedAt,
      expiresAt: fact.expiresAt ?? snapshot.expiresAt,
    },
    currentTick,
  );
}

function factMatches(
  fact: MarketProtectionFact,
  candidate: MarketProtectionCandidate,
): boolean {
  return fact.roomName === candidate.roomName && fact.resource === candidate.resource;
}

function shouldReleaseFact(
  sourceKind: MarketProtectionSourceKind,
  fact: MarketProtectionFact,
): boolean {
  if (TERMINAL_FACT_STATUSES.has(fact.status as MarketProtectionFactStatus)) {
    return true;
  }

  return (
    sourceKind === "blockedOutgoing" &&
    fact.disposable === true &&
    fact.contractExpired === true
  );
}

function stableKeyOf(fact: MarketProtectionFact): string | undefined {
  const value = fact.stableKey?.trim();
  return value ? value : undefined;
}

function addIssue(
  issues: MarketProtectionIssue[],
  issue: MarketProtectionIssue,
): void {
  const normalized: MarketProtectionIssue = {
    code: issue.code,
    ...(issue.sourceKind !== undefined
      ? { sourceKind: issue.sourceKind }
      : {}),
    ...(issue.stableKey !== undefined
      ? { stableKey: issue.stableKey }
      : {}),
    ...(issue.detail !== undefined ? { detail: issue.detail } : {}),
  };
  const identity = `${normalized.code}|${normalized.sourceKind ?? ""}|${normalized.stableKey ?? ""}|${normalized.detail ?? ""}`;
  const alreadyPresent = issues.some(
    (existing) =>
      `${existing.code}|${existing.sourceKind ?? ""}|${existing.stableKey ?? ""}|${existing.detail ?? ""}` ===
      identity,
  );
  if (!alreadyPresent) {
    issues.push(normalized);
  }
}

function addStaleIssue(
  issues: MarketProtectionIssue[],
  detail: string,
  sourceKind?: MarketProtectionSourceKind,
): void {
  addIssue(issues, { code: "protection_stale", sourceKind, detail });
}

function sourceObservationBounds(
  input: BuildMarketSaleProtectionLedgerInput,
  candidate: MarketProtectionCandidate,
): { observedAt: number; expiresAt: number } {
  let observedAt = input.observedAt;
  let expiresAt = input.expiresAt;

  for (const sourceKind of MARKET_PROTECTION_SOURCE_KINDS) {
    const snapshot = input.sources[sourceKind];
    if (!snapshot) continue;
    observedAt = Math.min(observedAt, snapshot.observedAt);
    expiresAt = Math.min(expiresAt, snapshot.expiresAt);
    if (!Array.isArray(snapshot.facts)) continue;
    for (const fact of snapshot.facts) {
      if (!factMatches(fact, candidate)) continue;
      observedAt = Math.min(observedAt, fact.observedAt ?? snapshot.observedAt);
      expiresAt = Math.min(expiresAt, fact.expiresAt ?? snapshot.expiresAt);
    }
  }

  return { observedAt, expiresAt };
}

function collectStock(
  candidate: MarketProtectionCandidate,
  snapshot: MarketProtectionSourceSnapshot | undefined,
  currentTick: number,
  issues: MarketProtectionIssue[],
): { totalStock: number; terminalStock: number } {
  if (!snapshot || !Array.isArray(snapshot.facts)) {
    addIssue(issues, { code: "stock_missing", sourceKind: "stock" });
    addIssue(issues, { code: "terminal_stock_missing", sourceKind: "stock" });
    return { totalStock: 0, terminalStock: 0 };
  }

  const matching = snapshot.facts.filter((fact) => factMatches(fact, candidate));
  if (matching.length === 0) {
    addIssue(issues, { code: "stock_missing", sourceKind: "stock" });
    addIssue(issues, { code: "terminal_stock_missing", sourceKind: "stock" });
    return { totalStock: 0, terminalStock: 0 };
  }

  const totals: number[] = [];
  const terminalTotals: number[] = [];
  for (const fact of matching) {
    if (
      !factObservationIsFresh(fact, snapshot, currentTick) ||
      !finiteNonNegative(fact.amount)
    ) {
      addIssue(issues, {
        code: "protection_invalid_fact",
        sourceKind: "stock",
        stableKey: stableKeyOf(fact),
      });
      continue;
    }

    totals.push(normalizeStockAmount(fact.amount));
    if (fact.terminalStock === undefined || !finiteNonNegative(fact.terminalStock)) {
      addIssue(issues, {
        code: "terminal_stock_missing",
        sourceKind: "stock",
        stableKey: stableKeyOf(fact),
      });
      continue;
    }
    terminalTotals.push(normalizeStockAmount(fact.terminalStock));
  }

  if (totals.length === 0) {
    addIssue(issues, { code: "stock_missing", sourceKind: "stock" });
    return { totalStock: 0, terminalStock: 0 };
  }

  const totalStock = Math.min(...totals);
  if (new Set(totals).size > 1) {
    addIssue(issues, {
      code: "stock_ambiguous",
      sourceKind: "stock",
      detail: "conflicting total stock observations",
    });
  }

  if (terminalTotals.length === 0) {
    addIssue(issues, { code: "terminal_stock_missing", sourceKind: "stock" });
    return { totalStock, terminalStock: 0 };
  }

  const terminalStock = Math.min(...terminalTotals);
  if (new Set(terminalTotals).size > 1 || terminalStock > totalStock) {
    addIssue(issues, {
      code: "stock_ambiguous",
      sourceKind: "stock",
      detail: "conflicting terminal stock observations",
    });
  }

  return {
    totalStock,
    terminalStock: Math.min(totalStock, terminalStock),
  };
}

function collectContributions(
  input: BuildMarketSaleProtectionLedgerInput,
  candidate: MarketProtectionCandidate,
  issues: MarketProtectionIssue[],
): MarketProtectionContribution[] {
  const deduped = new Map<string, MarketProtectionContribution>();
  let anonymousSequence = 0;

  for (const sourceKind of MARKET_PROTECTION_SOURCE_KINDS) {
    if (sourceKind === "stock") continue;
    const snapshot = input.sources[sourceKind];
    if (!snapshot || !Array.isArray(snapshot.facts)) continue;
    const defaultBucket = SOURCE_BUCKETS[sourceKind];

    for (const fact of snapshot.facts) {
      if (!factMatches(fact, candidate) || shouldReleaseFact(sourceKind, fact)) {
        continue;
      }

      const stableKey = stableKeyOf(fact);
      if (fact.blocksSale === true) {
        addIssue(issues, {
          code: "protection_donor_unbound",
          sourceKind,
          stableKey,
          detail: fact.blockedReason,
        });
      }
      if (
        !factObservationIsFresh(fact, snapshot, input.currentTick) ||
        !finiteNonNegative(fact.amount)
      ) {
        addIssue(issues, {
          code: "protection_invalid_fact",
          sourceKind,
          stableKey,
        });
        continue;
      }

      const amount = normalizeProtectionAmount(fact.amount);
      const bucket = fact.bucket ?? defaultBucket;
      const anonymous = !stableKey;
      const dedupeKey = stableKey
        ? `stable:${stableKey}`
        : `anonymous:${sourceKind}:${anonymousSequence++}`;
      const managedOrderId =
        sourceKind === "managedExposure"
          ? fact.managedOrderId?.trim() || stableKey
          : undefined;
      const factObservedAt = fact.observedAt ?? snapshot.observedAt;
      const factExpiresAt = fact.expiresAt ?? snapshot.expiresAt;
      const existing = deduped.get(dedupeKey);

      if (!existing) {
        deduped.set(dedupeKey, {
          dedupeKey,
          ...(stableKey !== undefined ? { stableKey } : {}),
          anonymous,
          bucket,
          amount,
          sourceKinds: [sourceKind],
          ...(managedOrderId !== undefined ? { managedOrderId } : {}),
          observedAt: factObservedAt,
          expiresAt: factExpiresAt,
        });
        continue;
      }

      if (existing.bucket !== bucket) {
        addIssue(issues, {
          code: "protection_ambiguous_contribution",
          sourceKind,
          stableKey,
          detail: `${existing.bucket} vs ${bucket}`,
        });
      }
      if (
        existing.managedOrderId &&
        managedOrderId &&
        existing.managedOrderId !== managedOrderId
      ) {
        addIssue(issues, {
          code: "protection_ambiguous_contribution",
          sourceKind,
          stableKey,
          detail: "stable key maps to multiple managed orders",
        });
      }

      existing.amount = Math.max(existing.amount, amount);
      existing.observedAt = Math.min(existing.observedAt, factObservedAt);
      existing.expiresAt = Math.min(existing.expiresAt, factExpiresAt);
      if (!existing.sourceKinds.includes(sourceKind)) {
        existing.sourceKinds.push(sourceKind);
      }
      if (!existing.managedOrderId && managedOrderId !== undefined) {
        existing.managedOrderId = managedOrderId;
      }
    }
  }

  return [...deduped.values()].sort((left, right) =>
    left.dedupeKey.localeCompare(right.dedupeKey),
  );
}

function sumBucket(
  contributions: readonly MarketProtectionContribution[],
  bucket: MarketProtectionBucket,
): number {
  return contributions
    .filter((contribution) => contribution.bucket === bucket)
    .reduce((sum, contribution) => sum + contribution.amount, 0);
}

function maxBucket(
  contributions: readonly MarketProtectionContribution[],
  bucket: MarketProtectionBucket,
): number {
  return contributions
    .filter((contribution) => contribution.bucket === bucket)
    .reduce((maximum, contribution) => Math.max(maximum, contribution.amount), 0);
}

export function getMarketProtectionEntryKey(
  roomName: string,
  resource: ResourceConstant,
): string {
  return `${roomName}:${resource}`;
}

export function isMarketProtectionEntryFresh(
  entry: MarketProtectionEntry,
  currentTick: number,
): boolean {
  return (
    entry.fresh &&
    !entry.blocked &&
    observationIsFresh(entry, currentTick)
  );
}

export interface MarketProtectionSellableOptions {
  excludeManagedOrderId?: string;
  /**
   * Defaults to true. Set false only for planning total exposure capacity;
   * execution still has to use terminal-backed capacity.
   */
  requireTerminalBacking?: boolean;
}

export function getMarketProtectionSellableAmount(
  entry: MarketProtectionEntry,
  currentTick: number,
  options: MarketProtectionSellableOptions = {},
): number {
  if (!isMarketProtectionEntryFresh(entry, currentTick)) {
    return 0;
  }

  const excludedOrderId = options.excludeManagedOrderId?.trim();
  const otherExposure = entry.sourceContributions
    .filter((contribution) => contribution.bucket === "managedExposure")
    .filter(
      (contribution) =>
        !excludedOrderId || contribution.managedOrderId !== excludedOrderId,
    )
    .reduce((sum, contribution) => sum + contribution.amount, 0);
  const exposureCapacity = Math.max(0, entry.grossSurplus - otherExposure);

  if (options.requireTerminalBacking === false) {
    return exposureCapacity;
  }

  return Math.max(
    0,
    Math.min(exposureCapacity, entry.terminalStock - otherExposure),
  );
}

function buildEntry(
  input: BuildMarketSaleProtectionLedgerInput,
  candidate: MarketProtectionCandidate,
): MarketProtectionEntry {
  const issues: MarketProtectionIssue[] = [];
  if (!observationIsFresh(input, input.currentTick)) {
    addStaleIssue(issues, "ledger envelope is not current");
  }

  for (const sourceKind of MARKET_PROTECTION_SOURCE_KINDS) {
    const snapshot = input.sources[sourceKind];
    if (!snapshot) {
      addStaleIssue(issues, "source missing", sourceKind);
      continue;
    }
    if (snapshot.complete !== true || !Array.isArray(snapshot.facts)) {
      addStaleIssue(issues, "source incomplete", sourceKind);
      continue;
    }
    if (!observationIsFresh(snapshot, input.currentTick)) {
      addStaleIssue(issues, "source observation stale", sourceKind);
    }
    for (const fact of snapshot.facts) {
      if (
        factMatches(fact, candidate) &&
        !factObservationIsFresh(fact, snapshot, input.currentTick)
      ) {
        addStaleIssue(issues, "matching fact stale", sourceKind);
      }
    }
  }

  const stock = collectStock(
    candidate,
    input.sources.stock,
    input.currentTick,
    issues,
  );
  const contributions = collectContributions(input, candidate, issues);

  if (
    !contributions.some(
      (contribution) => contribution.bucket === "hardReserve",
    )
  ) {
    addIssue(issues, { code: "floor_missing", sourceKind: "floor" });
  }
  if (
    !contributions.some(
      (contribution) => contribution.bucket === "forecastBuffer",
    )
  ) {
    addIssue(issues, { code: "forecast_missing", sourceKind: "forecast" });
  }

  const hardReserve = maxBucket(contributions, "hardReserve");
  const forecastBuffer = maxBucket(contributions, "forecastBuffer");
  const localReserve = Math.max(hardReserve, forecastBuffer);
  const absoluteTarget = maxBucket(contributions, "absoluteTarget");
  const consumptiveDemand =
    sumBucket(contributions, "consumptiveDemand") +
    sumBucket(contributions, "productionDemand");
  const boostWar = sumBucket(contributions, "boostWar");
  const hubCommitments = sumBucket(contributions, "hubCommitments");
  // Keep the historical aggregate for telemetry/call-site compatibility while
  // using the layered fields below for the actual protection formula.
  const productionDemand =
    absoluteTarget + consumptiveDemand + boostWar + hubCommitments;
  const protectedOutgoing = sumBucket(contributions, "protectedOutgoing");
  const carrierOrInFlight = sumBucket(contributions, "carrierOrInFlight");
  const managedExposure = sumBucket(contributions, "managedExposure");
  const protectionBeforeMarketExposure =
    Math.max(localReserve, absoluteTarget) +
    consumptiveDemand +
    protectedOutgoing +
    carrierOrInFlight +
    boostWar +
    hubCommitments;
  const protectedAmount =
    protectionBeforeMarketExposure + managedExposure;
  const grossSurplus = Math.max(
    0,
    stock.totalStock - protectionBeforeMarketExposure,
  );
  const newExposureCapacity = Math.max(0, grossSurplus - managedExposure);
  const { observedAt, expiresAt } = sourceObservationBounds(input, candidate);
  const blocked = issues.length > 0;
  const fresh =
    !issues.some((issue) => issue.code === "protection_stale") &&
    observationIsFresh(
      { revision: input.revision, observedAt, expiresAt },
      input.currentTick,
    );
  const provisional: MarketProtectionEntry = {
    roomName: candidate.roomName,
    resource: candidate.resource,
    revision: input.revision,
    observedAt,
    expiresAt,
    totalStock: stock.totalStock,
    terminalStock: stock.terminalStock,
    hardReserve,
    localReserve,
    absoluteTarget,
    consumptiveDemand,
    boostWar,
    hubCommitments,
    productionDemand,
    forecastBuffer,
    protectedOutgoing,
    carrierOrInFlight,
    protectedAmount,
    grossSurplus,
    managedExposure,
    newExposureCapacity,
    sellableAmount: 0,
    fresh,
    blocked,
    blockedReasons: [...new Set(issues.map((issue) => issue.code))],
    issues,
    sourceContributions: contributions,
  };
  provisional.sellableAmount = getMarketProtectionSellableAmount(
    provisional,
    input.currentTick,
  );
  return provisional;
}

export function buildMarketSaleProtectionLedger(
  input: BuildMarketSaleProtectionLedgerInput,
): MarketSaleProtectionLedger {
  const entries: Record<string, MarketProtectionEntry> = {};
  const seenCandidates = new Set<string>();

  for (const candidate of input.candidates) {
    const key = getMarketProtectionEntryKey(
      candidate.roomName,
      candidate.resource,
    );
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    entries[key] = buildEntry(input, candidate);
  }

  const bounds = Object.values(entries);
  const observedAt = bounds.reduce(
    (oldest, entry) => Math.min(oldest, entry.observedAt),
    input.observedAt,
  );
  const expiresAt = bounds.reduce(
    (earliest, entry) => Math.min(earliest, entry.expiresAt),
    input.expiresAt,
  );
  const blockedEntryCount = bounds.filter((entry) => entry.blocked).length;
  const globalIssues: MarketProtectionIssue[] = [];
  if (!observationIsFresh(input, input.currentTick)) {
    addStaleIssue(globalIssues, "ledger envelope is not current");
  }
  for (const sourceKind of MARKET_PROTECTION_SOURCE_KINDS) {
    const snapshot = input.sources[sourceKind];
    if (!snapshot) {
      addStaleIssue(globalIssues, "source missing", sourceKind);
    } else if (
      snapshot.complete !== true ||
      !Array.isArray(snapshot.facts)
    ) {
      addStaleIssue(globalIssues, "source incomplete", sourceKind);
    } else if (!observationIsFresh(snapshot, input.currentTick)) {
      addStaleIssue(globalIssues, "source observation stale", sourceKind);
    }
  }
  const globalBlocked = globalIssues.length > 0;

  return {
    currentTick: input.currentTick,
    revision: input.revision,
    observedAt,
    expiresAt,
    fresh:
      !globalBlocked &&
      observationIsFresh(
        { revision: input.revision, observedAt, expiresAt },
        input.currentTick,
      ),
    entries,
    blockedEntryCount,
    globalBlocked,
    globalIssues,
  };
}

/** Alias chosen for orchestration call sites that frame the operation as collection. */
export const collectMarketSaleProtectionLedger =
  buildMarketSaleProtectionLedger;

export type MarketSaleCanaryRejectionReason =
  | "protection_stale"
  | "hub_room"
  | "capacity_unknown"
  | "capacity_emergency"
  | "terminal_unknown"
  | "terminal_missing"
  | "terminal_cooldown_unknown"
  | "terminal_cooldown"
  | "terminal_energy_unknown"
  | "terminal_energy_reserve"
  | "terminal_capacity_unknown"
  | "terminal_capacity"
  | "resource_not_allowed"
  | "critical_conflict_unknown"
  | "critical_conflict"
  | "price_untrusted"
  | "depth_untrusted"
  | "managed_exposure_present"
  | "no_sellable_amount";

export interface MarketSaleCanaryPrerequisiteInput {
  currentTick: number;
  isHubRoom?: boolean;
  capacityState?: "normal" | "pressure" | "emergency";
  terminalExists?: boolean;
  terminalCooldown?: number;
  terminalEnergy?: number;
  terminalEnergyReserve?: number;
  terminalFreeCapacity?: number;
  minimumTerminalFreeCapacity?: number;
  resourceAllowed?: boolean;
  hasCriticalConflict?: boolean;
  trustedPrice?: boolean;
  trustedDepth?: boolean;
  requireNoManagedExposure?: boolean;
  /** Excludes only the exact order being maintained; new exposure omits it. */
  excludeManagedOrderId?: string;
  minimumSellableAmount?: number;
}

export interface MarketSaleCanaryPrerequisiteResult {
  eligible: boolean;
  sellableAmount: number;
  reasons: MarketSaleCanaryRejectionReason[];
}

function addCanaryReason(
  reasons: MarketSaleCanaryRejectionReason[],
  reason: MarketSaleCanaryRejectionReason,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

/**
 * Shared conservative precondition helper for dynamic canary selection.
 *
 * It does not lock a canary or mutate state; orchestration owns that lifecycle.
 */
export function evaluateMarketSaleCanaryPrerequisites(
  entry: MarketProtectionEntry,
  input: MarketSaleCanaryPrerequisiteInput,
): MarketSaleCanaryPrerequisiteResult {
  const reasons: MarketSaleCanaryRejectionReason[] = [];
  if (!isMarketProtectionEntryFresh(entry, input.currentTick)) {
    addCanaryReason(reasons, "protection_stale");
  }

  if (input.isHubRoom === undefined) {
    addCanaryReason(reasons, "hub_room");
  } else if (input.isHubRoom) {
    addCanaryReason(reasons, "hub_room");
  }

  if (
    input.capacityState !== "normal" &&
    input.capacityState !== "pressure" &&
    input.capacityState !== "emergency"
  ) {
    addCanaryReason(reasons, "capacity_unknown");
  } else if (input.capacityState === "emergency") {
    addCanaryReason(reasons, "capacity_emergency");
  }

  if (input.terminalExists === undefined) {
    addCanaryReason(reasons, "terminal_unknown");
  } else if (!input.terminalExists) {
    addCanaryReason(reasons, "terminal_missing");
  }

  if (!Number.isFinite(input.terminalCooldown)) {
    addCanaryReason(reasons, "terminal_cooldown_unknown");
  } else if (input.terminalCooldown! !== 0) {
    addCanaryReason(reasons, "terminal_cooldown");
  }

  if (
    !finiteNonNegative(input.terminalEnergy) ||
    !finiteNonNegative(input.terminalEnergyReserve)
  ) {
    addCanaryReason(reasons, "terminal_energy_unknown");
  } else if (input.terminalEnergy! < input.terminalEnergyReserve!) {
    addCanaryReason(reasons, "terminal_energy_reserve");
  }

  if (
    !finiteNonNegative(input.terminalFreeCapacity) ||
    !finiteNonNegative(input.minimumTerminalFreeCapacity)
  ) {
    addCanaryReason(reasons, "terminal_capacity_unknown");
  } else if (
    input.terminalFreeCapacity! < input.minimumTerminalFreeCapacity!
  ) {
    addCanaryReason(reasons, "terminal_capacity");
  }

  if (input.resourceAllowed !== true) {
    addCanaryReason(reasons, "resource_not_allowed");
  }
  if (input.hasCriticalConflict === undefined) {
    addCanaryReason(reasons, "critical_conflict_unknown");
  } else if (input.hasCriticalConflict) {
    addCanaryReason(reasons, "critical_conflict");
  }
  if (input.trustedPrice !== true) {
    addCanaryReason(reasons, "price_untrusted");
  }
  if (input.trustedDepth !== true) {
    addCanaryReason(reasons, "depth_untrusted");
  }

  if (
    (input.requireNoManagedExposure ?? true) &&
    entry.managedExposure > 0
  ) {
    addCanaryReason(reasons, "managed_exposure_present");
  }

  const sellableAmount = getMarketProtectionSellableAmount(
    entry,
    input.currentTick,
    {
      excludeManagedOrderId: input.excludeManagedOrderId,
    },
  );
  const minimumSellableAmount =
    input.minimumSellableAmount === undefined
      ? 1
      : finiteNonNegative(input.minimumSellableAmount)
        ? Math.max(1, Math.ceil(input.minimumSellableAmount))
        : Number.POSITIVE_INFINITY;
  if (sellableAmount < minimumSellableAmount) {
    addCanaryReason(reasons, "no_sellable_amount");
  }

  return {
    eligible: reasons.length === 0,
    sellableAmount,
    reasons,
  };
}
